import { FacadeError, type FacadeErrorCode } from './errors';

/**
 * Facade session lifecycle: `active` (created/resumed, interactive),
 * `closed` (terminal after cancel), `failed` (terminal runtime failure).
 * Turn-level idle/running is expressed through events, not this enum.
 */
export type SessionStatus = 'active' | 'closed' | 'failed';

export type PendingCallKind = 'approval' | 'question' | 'external_tool';

/** `unknown` is public; `settled` is a journal-private terminal tombstone. */
export type PendingCallState = 'pending' | 'unknown' | 'settled';

export type ToolResolution = 'completed' | 'failed' | 'skipped';

/** Durable progress of an external-tool result through runtime delivery. */
export type ToolResultDeliveryState = 'staged' | 'delivering' | 'delivered';

/** A validated tool result staged durably before runtime delivery. */
export interface StagedToolResult {
  readonly resolution: ToolResolution;
  readonly output?: string;
  readonly systemMessage?: string;
}

export type StopReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export interface PendingCall {
  id: string;
  kind: PendingCallKind;
  state: PendingCallState;
  /** Journal-private external-tool delivery state; omitted from API projections. */
  stagedToolResult?: StagedToolResult;
  /** Journal-private handoff progress; omitted from API projections. */
  toolResultDeliveryState?: ToolResultDeliveryState;
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
  systemMessage?: string;
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

export interface ToolResultInput {
  toolCallId: string;
  resolution: ToolResolution;
  output?: string;
  systemMessage?: string;
}

export type CallResolution =
  | { kind: 'approval'; decision: ApprovalDecision; feedback?: string }
  | { kind: 'question'; answers: Record<string, string | true> }
  | ({ kind: 'external_tool' } & StagedToolResult);

export interface PendingCallRegistration {
  call: PendingCall;
  /** Approval and question handlers await their matching response here. */
  resolution: Promise<CallResolution>;
  /** A resumed handler consumes a staged result without a second request event. */
  replayed?: boolean;
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
 * request is emitted for it). A tool result is staged before it is handed to
 * the runtime; only a successful handoff removes the record. Recovery rebuilds
 * the pending table from whatever the journal still holds.
 */
export interface PendingCallJournal {
  register(sessionId: string, call: PendingCall): void;
  stageToolResult(sessionId: string, callId: string, result: StagedToolResult): void;
  setToolResultDeliveryState(
    sessionId: string,
    callId: string,
    state: ToolResultDeliveryState,
  ): void;
  settleUnknownToolCall(sessionId: string, callId: string): void;
  settle(sessionId: string, callId: string): void;
  read(sessionId: string): PendingCall[];
}

interface TurnState {
  content: string;
  systemMessage?: string;
  idempotencyKey?: string;
}

type IdempotencyRecord =
  | { state: 'in_flight'; content: string; systemMessage?: string }
  | { state: 'done'; content: string; systemMessage?: string; frame: PromptDoneFrame };

interface PendingCallEntry extends PendingCall {
  settle?: (resolution: CallResolution) => void;
  handlerRegistered?: boolean;
  delivery?: ToolResultDelivery;
  deliveryWaiter?: (delivery: ToolResultDelivery) => void;
  requiresRetry?: boolean;
}

interface ToolResultDelivery {
  readonly result: StagedToolResult;
  readonly completion: Promise<void>;
  readonly settle: () => void;
  readonly fail: (error: FacadeError) => void;
  claimed: boolean;
}

interface SessionEntry {
  id: string;
  status: SessionStatus;
  currentTurn?: TurnState;
  /** Scoped by session: idempotency key -> first prompt outcome. */
  idempotency: Map<string, IdempotencyRecord>;
  pendingCalls: Map<string, PendingCallEntry>;
  settledToolCallIDs: Set<string>;
}

interface RecoveredPendingCalls {
  pendingCalls: PendingCall[];
  settledToolCallIDs: Set<string>;
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
      settledToolCallIDs: new Set(),
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
    const recoveredCalls = this.recoveredPendingCalls(sessionId, recovered);
    entry.pendingCalls.clear();
    for (const call of recoveredCalls.pendingCalls) {
      entry.pendingCalls.set(call.id, this.pendingCallEntry(call));
    }
    entry.settledToolCallIDs = recoveredCalls.settledToolCallIDs;
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
    const recoveredCalls = this.recoveredPendingCalls(sessionId, recovered);
    const entry: SessionEntry = {
      id: sessionId,
      status: 'active',
      idempotency: new Map(),
      pendingCalls: new Map(recoveredCalls.pendingCalls.map((call) => [call.id, this.pendingCallEntry(call)])),
      settledToolCallIDs: recoveredCalls.settledToolCallIDs,
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
   * auto-skipped (their turn died with the process, so they are dropped).
   * An unconfirmed external call is reported `unknown`; only a result that
   * never started runtime delivery remains pending for an explicit replay.
   * Without a journal the hook's own list is used as-is.
   */
  private recoveredPendingCalls(
    sessionId: string,
    recovered: RecoveredSession,
  ): RecoveredPendingCalls {
    if (!this.pendingJournal) {
      return { pendingCalls: recovered.pendingCalls, settledToolCallIDs: new Set() };
    }
    let journaled: PendingCall[];
    try {
      journaled = this.pendingJournal.read(sessionId);
    } catch {
      // A corrupt journal is a deterministic recovery failure, never skipped.
      throw new FacadeError('session_resume_failed');
    }
    const settledToolCallIDs = new Set<string>();
    const pendingCalls = journaled.flatMap<PendingCall>((call): PendingCall[] => {
      if (call.kind !== 'external_tool') return [];
      if (call.state === 'settled') {
        settledToolCallIDs.add(call.id);
        return [];
      }
      if (call.stagedToolResult === undefined) {
        return [{ id: call.id, kind: call.kind, state: 'unknown' as const }];
      }
      if (call.toolResultDeliveryState === 'staged') {
        return [{
          id: call.id,
          kind: call.kind,
          state: 'pending' as const,
          stagedToolResult: call.stagedToolResult,
          toolResultDeliveryState: 'staged' as const,
        }];
      }
      // `delivering` crossed the runtime side-effect boundary, and `delivered`
      // may have persisted before the reverse-RPC response reached Kimi. Both
      // states remain visible for explicit settlement but are never replayed.
      return [{ id: call.id, kind: call.kind, state: 'unknown' as const }];
    });
    return { pendingCalls, settledToolCallIDs };
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
        if (record.content !== input.content || record.systemMessage !== input.systemMessage) {
          throw new FacadeError('session_state_conflict');
        }
        return { status: 'replayed', frame: record.frame };
      }
      // A lingering `in_flight` record without a current turn is impossible:
      // turn state and in-flight records are always cleared together.
    }
    entry.currentTurn = { content: input.content, systemMessage: input.systemMessage, idempotencyKey: key };
    if (key) {
      entry.idempotency.set(key, { state: 'in_flight', content: input.content, systemMessage: input.systemMessage });
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
        systemMessage: turn.systemMessage,
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
          systemMessage: entry.currentTurn.systemMessage,
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
    if (call.kind === 'external_tool' && entry.settledToolCallIDs.has(call.id)) {
      throw new FacadeError('request_not_pending');
    }
    const existing = entry.pendingCalls.get(call.id);
    if (existing !== undefined) {
      // A resumed runtime may replay exactly one already-staged external tool
      // call. It consumes the journaled result without emitting another
      // external_tool_request.
      if (
        call.kind === 'external_tool' &&
        existing.kind === 'external_tool' &&
        existing.stagedToolResult !== undefined &&
        existing.toolResultDeliveryState === 'staged' &&
        existing.handlerRegistered !== true
      ) {
        existing.handlerRegistered = true;
        return {
          call: this.publicPendingCall(existing),
          resolution: Promise.resolve({ kind: 'external_tool', ...existing.stagedToolResult }),
          replayed: true,
        };
      }
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
    const stored: PendingCallEntry = {
      ...call,
      state: 'pending',
      settle,
      ...(call.kind === 'external_tool' ? { handlerRegistered: true } : {}),
    };
    entry.pendingCalls.set(call.id, stored);
    return { call: this.publicPendingCall(stored), resolution };
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

  async resolveToolResult(sessionId: string, input: ToolResultInput): Promise<AcceptedResult> {
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
    // A recovered unknown call belongs to a dead turn. It can only be
    // explicitly skipped; no live runtime handler remains to receive it.
    if (call.state === 'unknown') {
      this.settleUnknownToolCall(entry, call);
      return { accepted: true };
    }

    const result: StagedToolResult = {
      resolution: input.resolution,
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.systemMessage !== undefined ? { systemMessage: input.systemMessage } : {}),
    };
    if (call.stagedToolResult !== undefined) {
      if (!sameToolResult(call.stagedToolResult, result)) {
        throw new FacadeError('session_state_conflict');
      }
      // A matching delivery is already being handed to the one waiting core
      // call. Do not turn a concurrent duplicate POST into a second accepted
      // response while the original handoff remains in flight.
      if (call.delivery !== undefined) {
        throw new FacadeError('request_not_pending');
      }
    } else {
      // Persist before waking the runtime handler. A process loss from here
      // onward leaves a replayable result instead of an unknown call.
      if (this.pendingJournal) {
        try {
          this.pendingJournal.stageToolResult(entry.id, call.id, result);
        } catch {
          throw new FacadeError('internal_error');
        }
      }
      call.stagedToolResult = result;
      call.toolResultDeliveryState = 'staged';
    }

    call.requiresRetry = false;
    const delivery = this.ensureToolResultDelivery(call);
    this.offerToolResultDelivery(call, delivery);
    await delivery.completion;
    return { accepted: true };
  }

  /** Waits for the next staged result for a live external-tool handler. */
  waitForToolResultDelivery(sessionId: string, toolCallId: string): Promise<ToolResultDelivery> {
    const { call } = this.lookupPendingCall(sessionId, toolCallId, 'external_tool');
    if (call.state !== 'pending') {
      throw new FacadeError('request_not_pending');
    }
    if (call.delivery !== undefined) {
      if (call.delivery.claimed) {
        throw new FacadeError('internal_error');
      }
      call.delivery.claimed = true;
      return Promise.resolve(call.delivery);
    }
    if (call.stagedToolResult !== undefined) {
      if (call.requiresRetry === true) {
        return new Promise<ToolResultDelivery>((resolve) => {
          call.deliveryWaiter = (delivery) => {
            delivery.claimed = true;
            resolve(delivery);
          };
        });
      }
      const delivery = this.ensureToolResultDelivery(call);
      delivery.claimed = true;
      return Promise.resolve(delivery);
    }
    return new Promise<ToolResultDelivery>((resolve) => {
      call.deliveryWaiter = (delivery) => {
        delivery.claimed = true;
        resolve(delivery);
      };
    });
  }

  /** Completes the durable handoff after the runtime accepts the system message. */
  completeToolResultDelivery(sessionId: string, toolCallId: string, delivery: ToolResultDelivery): void {
    const { entry, call } = this.lookupPendingCall(sessionId, toolCallId, 'external_tool');
    if (call.delivery !== delivery || call.toolResultDeliveryState !== 'delivering') {
      throw new FacadeError('internal_error');
    }
    this.setToolResultDeliveryState(entry, call, 'delivered');
    this.settlePendingCall(entry, call);
    delivery.settle();
  }

  /** Persists the point after which replay would duplicate a runtime side effect. */
  beginToolResultDelivery(sessionId: string, toolCallId: string, delivery: ToolResultDelivery): void {
    const { entry, call } = this.lookupPendingCall(sessionId, toolCallId, 'external_tool');
    if (call.delivery !== delivery || call.toolResultDeliveryState !== 'staged') {
      throw new FacadeError('internal_error');
    }
    this.setToolResultDeliveryState(entry, call, 'delivering');
  }

  /** Keeps the staged result durable and waits for an explicit retry. */
  failToolResultDelivery(sessionId: string, toolCallId: string, delivery: ToolResultDelivery): void {
    const { entry, call } = this.lookupPendingCall(sessionId, toolCallId, 'external_tool');
    if (
      call.delivery !== delivery ||
      (call.toolResultDeliveryState !== 'delivering' && call.toolResultDeliveryState !== 'staged')
    ) {
      throw new FacadeError('internal_error');
    }
    if (call.toolResultDeliveryState === 'delivering') {
      this.setToolResultDeliveryState(entry, call, 'staged');
    }
    call.delivery = undefined;
    call.requiresRetry = true;
    delivery.fail(new FacadeError('internal_error'));
  }

  /** Stops a result that may have crossed the runtime side-effect boundary. */
  failUncertainToolResultDelivery(
    sessionId: string,
    toolCallId: string,
    delivery: ToolResultDelivery,
  ): void {
    const { call } = this.lookupPendingCall(sessionId, toolCallId, 'external_tool');
    if (call.delivery !== delivery) {
      throw new FacadeError('internal_error');
    }
    this.markFailed(sessionId);
    delivery.fail(new FacadeError('internal_error'));
  }

  listPendingCalls(sessionId: string): PendingCall[] {
    const entry = this.requireEntry(sessionId);
    return [...entry.pendingCalls.values()].map((call) => this.publicPendingCall(call));
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

  private pendingCallEntry(call: PendingCall): PendingCallEntry {
    return {
      id: call.id,
      kind: call.kind,
      state: call.state,
      ...(call.stagedToolResult !== undefined ? { stagedToolResult: call.stagedToolResult } : {}),
      ...(call.toolResultDeliveryState !== undefined
        ? { toolResultDeliveryState: call.toolResultDeliveryState }
        : {}),
    };
  }

  private publicPendingCall(call: PendingCall): PendingCall {
    return { id: call.id, kind: call.kind, state: call.state };
  }

  private ensureToolResultDelivery(call: PendingCallEntry): ToolResultDelivery {
    if (call.delivery !== undefined) return call.delivery;
    const result = call.stagedToolResult;
    if (result === undefined || call.toolResultDeliveryState !== 'staged') {
      throw new FacadeError('internal_error');
    }
    let settle!: () => void;
    let fail!: (error: FacadeError) => void;
    const completion = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // A recovered staged result may be retried before a route awaits the
    // completion promise. Observe that rejection until a caller joins it.
    void completion.catch(() => undefined);
    const delivery: ToolResultDelivery = { result, completion, settle, fail, claimed: false };
    call.delivery = delivery;
    return delivery;
  }

  private offerToolResultDelivery(call: PendingCallEntry, delivery: ToolResultDelivery): void {
    const waiter = call.deliveryWaiter;
    if (waiter === undefined) return;
    call.deliveryWaiter = undefined;
    waiter(delivery);
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
   * Terminal settlement: once the journal has recorded `delivered`, the call
   * leaves the pending table and its record is removed. A delete failure leaves
   * a durable delivered tombstone, which recovery deliberately never replays.
   */
  private settlePendingCall(entry: SessionEntry, call: PendingCallEntry): void {
    entry.pendingCalls.delete(call.id);
    if (this.pendingJournal) {
      try {
        this.pendingJournal.settle(entry.id, call.id);
      } catch {
        // Tolerated: the durable delivered tombstone prevents replay.
      }
    }
  }

  private settleUnknownToolCall(entry: SessionEntry, call: PendingCallEntry): void {
    if (this.pendingJournal) {
      try {
        this.pendingJournal.settleUnknownToolCall(entry.id, call.id);
      } catch {
        throw new FacadeError('internal_error');
      }
    }
    entry.pendingCalls.delete(call.id);
    entry.settledToolCallIDs.add(call.id);
  }

  private setToolResultDeliveryState(
    entry: SessionEntry,
    call: PendingCallEntry,
    state: ToolResultDeliveryState,
  ): void {
    if (this.pendingJournal) {
      try {
        this.pendingJournal.setToolResultDeliveryState(entry.id, call.id, state);
      } catch {
        throw new FacadeError('internal_error');
      }
    }
    call.toolResultDeliveryState = state;
  }
}

function sameToolResult(left: StagedToolResult, right: StagedToolResult): boolean {
  return (
    left.resolution === right.resolution &&
    left.output === right.output &&
    left.systemMessage === right.systemMessage
  );
}
