import { FacadeError, type FacadeErrorCode } from './errors';

/**
 * Facade session lifecycle: `active` (created/resumed, interactive),
 * `closed` (terminal after cancel), `failed` (terminal runtime failure).
 * Turn-level idle/running is expressed through events, not this enum.
 */
export type SessionStatus = 'active' | 'closed' | 'failed';

export type PendingCallKind = 'approval' | 'question' | 'external_tool';

/** `unknown` marks calls left unconfirmed by a crash; they are never replayed. */
export type PendingCallState = 'pending' | 'unknown';

export type StopReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export interface PendingCall {
  id: string;
  kind: PendingCallKind;
  state: PendingCallState;
}

export interface PromptDoneFrame {
  type: 'prompt_done';
  stop_reason: StopReason;
}

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
}

export interface ResumeResult extends SessionInfo {
  pendingCalls: PendingCall[];
}

export interface AcceptedResult {
  accepted: true;
}

export interface StartPromptInput {
  content: string;
  idempotencyKey?: string;
}

export type StartPromptResult =
  | { status: 'started' }
  | { status: 'replayed'; frame: PromptDoneFrame };

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalInput {
  toolCallId: string;
  decision: ApprovalDecision;
  feedback?: string;
}

export interface QuestionAnswerInput {
  questionId: string;
  answers: Record<string, string | true>;
}

export type ToolResolution = 'completed' | 'failed' | 'skipped';

export interface ToolResultInput {
  toolCallId: string;
  resolution: ToolResolution;
  output?: string;
}

export type CallResolution =
  | { kind: 'approval'; decision: ApprovalDecision; feedback?: string }
  | { kind: 'question'; answers: Record<string, string | true> }
  | { kind: 'external_tool'; resolution: ToolResolution; output?: string };

export interface PendingCallRegistration {
  call: PendingCall;
  /** Resolves once the matching response is accepted by the registry. */
  resolution: Promise<CallResolution>;
}

/** Journal-recovered state of a session (recovery hook result). */
export interface RecoveredSession {
  pendingCalls: PendingCall[];
}

export type JournalRecovery = (sessionId: string) => Promise<RecoveredSession>;

/**
 * Facade-owned durable record of pending calls, keyed by session id. The
 * journal is the recovery authority: registration persists first and is
 * fail-closed (a call the journal cannot hold is never tracked, so no
 * request is emitted for it), settlement removes the record, and recovery
 * rebuilds the pending table from whatever the journal still holds.
 */
export interface PendingCallJournal {
  register(sessionId: string, call: PendingCall): void;
  settle(sessionId: string, callId: string): void;
  read(sessionId: string): PendingCall[];
}

interface TurnState {
  content: string;
  idempotencyKey?: string;
}

type IdempotencyRecord =
  | { state: 'in_flight'; content: string }
  | { state: 'done'; content: string; frame: PromptDoneFrame };

interface PendingCallEntry extends PendingCall {
  settle?: (resolution: CallResolution) => void;
}

interface SessionEntry {
  id: string;
  status: SessionStatus;
  currentTurn?: TurnState;
  /** Scoped by session: idempotency key -> first prompt outcome. */
  idempotency: Map<string, IdempotencyRecord>;
  pendingCalls: Map<string, PendingCallEntry>;
}

/**
 * Single decision point for facade session state: the operation x state
 * matrix, the (session_id, idempotency_key) idempotency table, and the
 * pending call table (approval / question / external_tool correlation).
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly recoverFromJournal?: JournalRecovery;
  private readonly pendingJournal?: PendingCallJournal;

  constructor(options?: {
    recoverFromJournal?: JournalRecovery;
    pendingJournal?: PendingCallJournal;
  }) {
    this.recoverFromJournal = options?.recoverFromJournal;
    this.pendingJournal = options?.pendingJournal;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    return entry && { sessionId: entry.id, status: entry.status };
  }

  createSession(sessionId: string): SessionInfo {
    if (this.sessions.has(sessionId)) {
      throw new FacadeError('session_state_conflict');
    }
    const entry: SessionEntry = {
      id: sessionId,
      status: 'active',
      idempotency: new Map(),
      pendingCalls: new Map(),
    };
    this.sessions.set(sessionId, entry);
    return { sessionId, status: entry.status };
  }

  async resumeSession(sessionId: string): Promise<ResumeResult> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      return this.recoverMissingEntry(sessionId);
    }
    if (entry.status === 'closed') {
      throw new FacadeError('session_state_conflict');
    }
    if (entry.status === 'active') {
      return this.resumeResult(entry);
    }
    // failed: only the journal can bring the session back.
    const recovered = await this.runRecoveryHook(sessionId, 'session_resume_failed');
    const pendingCalls = this.recoveredPendingCalls(sessionId, recovered);
    entry.pendingCalls.clear();
    for (const call of pendingCalls) {
      entry.pendingCalls.set(call.id, { ...call });
    }
    entry.status = 'active';
    return this.resumeResult(entry);
  }

  /**
   * Registry-miss fallback: the facade process restarted, so only durable
   * state can vouch for the session. The runtime journal is consulted through
   * the recovery hook, and a successful hook is the existence authority (its
   * own session_not_found keeps the 404 contract code). The facade
   * pending-call journal then only rebuilds the pending table; it holds
   * UNSETTLED calls, so an empty journal is the common case (idle crash), not
   * evidence the session is unknown. A failed recovery leaves no entry behind.
   */
  private async recoverMissingEntry(sessionId: string): Promise<ResumeResult> {
    const recovered = await this.runRecoveryHook(sessionId, 'session_not_found');
    const pendingCalls = this.recoveredPendingCalls(sessionId, recovered);
    const entry: SessionEntry = {
      id: sessionId,
      status: 'active',
      idempotency: new Map(),
      pendingCalls: new Map(pendingCalls.map((call) => [call.id, { ...call }])),
    };
    this.sessions.set(sessionId, entry);
    return this.resumeResult(entry);
  }

  private async runRecoveryHook(
    sessionId: string,
    missingHookCode: FacadeErrorCode,
  ): Promise<RecoveredSession> {
    const hook = this.recoverFromJournal;
    if (!hook) {
      throw new FacadeError(missingHookCode);
    }
    try {
      return await hook(sessionId);
    } catch (error) {
      // A journal miss at the hook keeps the 404 contract code; anything else
      // is a resume failure with the raw detail confined to internal logs.
      if (error instanceof FacadeError && error.code === 'session_not_found') {
        throw error;
      }
      throw new FacadeError('session_resume_failed');
    }
  }

  /**
   * Rebuilds the pending table for a recovered session. With a journal
   * configured the journal is the authority: approvals and questions are
   * auto-skipped (their turn died with the process, so they are dropped) and
   * external tool calls are reported `unknown` until the user settles them.
   * The journal holds only unsettled calls, so an empty journal carries no
   * information about whether the session exists. Without a journal the
   * hook's own list is used as-is.
   */
  private recoveredPendingCalls(
    sessionId: string,
    recovered: RecoveredSession,
  ): PendingCall[] {
    if (!this.pendingJournal) {
      return recovered.pendingCalls;
    }
    let journaled: PendingCall[];
    try {
      journaled = this.pendingJournal.read(sessionId);
    } catch {
      // A corrupt journal is a deterministic recovery failure, never skipped.
      throw new FacadeError('session_resume_failed');
    }
    return journaled
      .filter((call) => call.kind === 'external_tool')
      .map((call) => ({ id: call.id, kind: call.kind, state: 'unknown' as const }));
  }

  startPrompt(sessionId: string, input: StartPromptInput): StartPromptResult {
    const entry = this.requireEntry(sessionId);
    if (entry.status !== 'active') {
      throw new FacadeError('prompt_rejected');
    }
    // One turn per session: any concurrent prompt is rejected as busy,
    // including a retry of the in-flight idempotency key.
    if (entry.currentTurn) {
      throw new FacadeError('prompt_rejected');
    }
    const key = input.idempotencyKey;
    if (key) {
      const record = entry.idempotency.get(key);
      if (record?.state === 'done') {
        if (record.content !== input.content) {
          throw new FacadeError('session_state_conflict');
        }
        return { status: 'replayed', frame: record.frame };
      }
      // A lingering `in_flight` record without a current turn is impossible:
      // turn state and in-flight records are always cleared together.
    }
    entry.currentTurn = { content: input.content, idempotencyKey: key };
    if (key) {
      entry.idempotency.set(key, { state: 'in_flight', content: input.content });
    }
    return { status: 'started' };
  }

  finishPrompt(sessionId: string, stopReason: StopReason): PromptDoneFrame {
    const entry = this.requireEntry(sessionId);
    const turn = entry.currentTurn;
    if (!turn) {
      throw new FacadeError('internal_error');
    }
    const frame: PromptDoneFrame = { type: 'prompt_done', stop_reason: stopReason };
    if (turn.idempotencyKey) {
      entry.idempotency.set(turn.idempotencyKey, {
        state: 'done',
        content: turn.content,
        frame,
      });
    }
    entry.currentTurn = undefined;
    return frame;
  }

  interrupt(sessionId: string): AcceptedResult {
    const entry = this.requireEntry(sessionId);
    if (entry.status !== 'active' || !entry.currentTurn) {
      throw new FacadeError('session_state_conflict');
    }
    return { accepted: true };
  }

  cancelSession(sessionId: string): AcceptedResult {
    const entry = this.requireEntry(sessionId);
    if (entry.status !== 'closed') {
      if (entry.currentTurn?.idempotencyKey) {
        entry.idempotency.set(entry.currentTurn.idempotencyKey, {
          state: 'done',
          content: entry.currentTurn.content,
          frame: { type: 'prompt_done', stop_reason: 'cancelled' },
        });
      }
      entry.currentTurn = undefined;
      entry.status = 'closed';
    }
    return { accepted: true };
  }

  /** Marks an active session as failed; unconfirmed calls become `unknown`. */
  markFailed(sessionId: string): void {
    const entry = this.requireEntry(sessionId);
    if (entry.status !== 'active') return;
    entry.status = 'failed';
    entry.currentTurn = undefined;
    // In-flight idempotency records have no terminal frame to replay; the key
    // may be reused after recovery (explicit retry, never automatic replay).
    for (const [key, record] of entry.idempotency) {
      if (record.state === 'in_flight') entry.idempotency.delete(key);
    }
    for (const call of entry.pendingCalls.values()) {
      if (call.state === 'pending') call.state = 'unknown';
    }
  }

  registerPendingCall(
    sessionId: string,
    call: { id: string; kind: PendingCallKind },
  ): PendingCallRegistration {
    const entry = this.requireEntry(sessionId);
    if (entry.status !== 'active') {
      throw new FacadeError('session_state_conflict');
    }
    if (entry.pendingCalls.has(call.id)) {
      throw new FacadeError('internal_error');
    }
    // Fail-closed: the call is journaled before it is tracked, so a call the
    // journal cannot hold is never tracked and no request is emitted for it.
    if (this.pendingJournal) {
      try {
        this.pendingJournal.register(sessionId, { id: call.id, kind: call.kind, state: 'pending' });
      } catch {
        throw new FacadeError('internal_error');
      }
    }
    let settle!: (resolution: CallResolution) => void;
    const resolution = new Promise<CallResolution>((resolve) => {
      settle = resolve;
    });
    const stored: PendingCallEntry = { ...call, state: 'pending', settle };
    entry.pendingCalls.set(call.id, stored);
    return { call: { id: stored.id, kind: stored.kind, state: stored.state }, resolution };
  }

  resolveApproval(sessionId: string, input: ApprovalInput): AcceptedResult {
    const { entry, call } = this.lookupPendingCall(sessionId, input.toolCallId, 'approval');
    this.settlePendingCall(entry, call);
    call.settle?.({ kind: 'approval', decision: input.decision, feedback: input.feedback });
    return { accepted: true };
  }

  answerQuestion(sessionId: string, input: QuestionAnswerInput): AcceptedResult {
    const { entry, call } = this.lookupPendingCall(sessionId, input.questionId, 'question');
    this.settlePendingCall(entry, call);
    call.settle?.({ kind: 'question', answers: input.answers });
    return { accepted: true };
  }

  resolveToolResult(sessionId: string, input: ToolResultInput): AcceptedResult {
    const { entry, call } = this.lookupPendingCall(
      sessionId,
      input.toolCallId,
      'external_tool',
      input.resolution,
    );
    if (input.resolution === 'completed' && input.output === undefined) {
      // Invalid resolutions leave the call pending so a corrected retry is accepted.
      throw new FacadeError('invalid_request');
    }
    this.settlePendingCall(entry, call);
    call.settle?.({ kind: 'external_tool', resolution: input.resolution, output: input.output });
    return { accepted: true };
  }

  listPendingCalls(sessionId: string): PendingCall[] {
    const entry = this.requireEntry(sessionId);
    return [...entry.pendingCalls.values()].map(({ id, kind, state }) => ({ id, kind, state }));
  }

  assertEventStreamAllowed(sessionId: string): void {
    const entry = this.requireEntry(sessionId);
    if (entry.status !== 'active') {
      throw new FacadeError('session_state_conflict');
    }
  }

  private requireEntry(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new FacadeError('session_not_found');
    }
    return entry;
  }

  private resumeResult(entry: SessionEntry): ResumeResult {
    return {
      sessionId: entry.id,
      status: entry.status,
      pendingCalls: this.listPendingCalls(entry.id),
    };
  }

  /**
   * Correlation guard: a response is accepted only when a call with the same
   * id exists and is still `pending` — with one exception: an `unknown`
   * external tool call (left unconfirmed by a crash) accepts an explicit
   * `skipped` resolution as its terminal settlement. Duplicate, late, or
   * kind-mismatched ids and any other resolution on an `unknown` call are
   * rejected and never match a new call.
   */
  private lookupPendingCall(
    sessionId: string,
    id: string,
    kind: PendingCallKind,
    resolution?: ToolResolution,
  ): { entry: SessionEntry; call: PendingCallEntry } {
    const entry = this.requireEntry(sessionId);
    if (entry.status !== 'active') {
      throw new FacadeError('session_state_conflict');
    }
    const call = entry.pendingCalls.get(id);
    if (!call || call.kind !== kind) {
      throw new FacadeError('request_not_pending');
    }
    if (call.state === 'unknown') {
      if (kind === 'external_tool' && resolution === 'skipped') {
        return { entry, call };
      }
      throw new FacadeError('request_not_pending');
    }
    return { entry, call };
  }

  /**
   * Terminal settlement: the call leaves the pending table and its journal
   * record is removed. A journal delete failure is tolerated — the lingering
   * record is recovered as `unknown` / auto-skipped later, which is the same
   * crash window the journal already covers.
   */
  private settlePendingCall(entry: SessionEntry, call: PendingCallEntry): void {
    entry.pendingCalls.delete(call.id);
    if (this.pendingJournal) {
      try {
        this.pendingJournal.settle(entry.id, call.id);
      } catch {
        // Tolerated: recovery closes the window.
      }
    }
  }
}
