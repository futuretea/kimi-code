import { randomUUID } from 'node:crypto';

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';
import type {
  ApprovalHandler,
  CreateSessionOptions,
  Event,
  KimiHarnessOptions,
  PermissionMode,
  PromptInput,
  QuestionHandler,
  RegisterToolInput,
  ResumeSessionInput,
  TextPromptPart,
  ToolCallHandler,
  Unsubscribe,
} from '@moonshot-ai/kimi-code-sdk';

import { FacadeError, toFacadeError } from './errors';
import type {
  ExternalToolDefinition,
  FacadeCreateConfig,
  FacadeToolEntry,
  HarnessEventSink,
  PermissionPolicy,
} from './facade-types';
import { isExternalToolDefinition } from './facade-types';
import { writeSessionMcpConfig } from './mcp-config';
import type { SessionRegistry } from './session-registry';

// The facade vocabulary lives in `./facade-types`; re-exported so this module
// stays the single import surface for the harness layer.
export * from './facade-types';

/**
 * Live harness layer: builds and wires runtime sessions from facade create
 * config, bridges runtime events and reverse-RPC interactions (approval /
 * question / external tool) onto the neutral facade vocabulary, and hands
 * facade events to the sink (the registry event pump consumes them).
 */

// ---------------------------------------------------------------------------
// Permission mapping.
// ---------------------------------------------------------------------------

/**
 * Neutral mapping from the facade permission policy to the runtime permission
 * mode (`types.ts`: 'yolo' | 'manual' | 'auto'):
 * - always_allow -> yolo: run approval-worthy actions without asking.
 * - always_ask   -> manual: every approval-worthy action is bridged to the
 *   facade approval flow.
 * - always_deny  -> manual: the runtime has no deny-all mode; the approval
 *   handler short-circuits to `rejected` without an ask round trip (see
 *   installApprovalHandler), which matches the previous runtime's behavior of
 *   erroring every policy-checked call. Residual gap: read-only tools that
 *   never require approval still run; no caller sends a session-level
 *   always_deny today (denied toolsets are dropped upstream instead).
 */
export const PERMISSION_MODE_BY_POLICY = {
  always_allow: 'yolo',
  always_ask: 'manual',
  always_deny: 'manual',
} as const satisfies Record<PermissionPolicy, PermissionMode>;

export function permissionModeForPolicy(policy: PermissionPolicy): PermissionMode {
  return PERMISSION_MODE_BY_POLICY[policy];
}

// ---------------------------------------------------------------------------
// Harness abstraction (the single extension point; tests inject a fake).
// ---------------------------------------------------------------------------

/** Subset of the runtime session surface the facade drives. */
export interface HarnessSession {
  readonly id: string;
  onEvent(listener: (event: Event) => void): Unsubscribe;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  setQuestionHandler(handler: QuestionHandler | undefined): void;
  setToolCallHandler(handler: ToolCallHandler | undefined): void;
  prompt(input: string | PromptInput): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  registerTool(tool: RegisterToolInput): Promise<void>;
  setActiveTools(names: readonly string[]): Promise<void>;
}

export interface HarnessSessionFactory {
  createSession(options: CreateSessionOptions): Promise<HarnessSession>;
  resumeSession(input: ResumeSessionInput): Promise<HarnessSession>;
}

export type HarnessFactory = (options: KimiHarnessOptions) => HarnessSessionFactory;

/** Session operations the routes layer drives through the harness. */
export interface FacadeHarness {
  createSession(config: FacadeCreateConfig): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, content: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  /** Readiness probe: rejects when the runtime is not available. */
  probe?(): Promise<void>;
}

export interface LiveHarnessFactoryOptions {
  readonly registry: SessionRegistry;
  readonly sink: HarnessEventSink;
  /** Defaults to the sdk live factory; tests inject a fake harness. */
  readonly createHarness?: HarnessFactory;
  /** Passed through to the harness factory on first use (lazy construction). */
  readonly harnessOptions?: KimiHarnessOptions;
  /** Directory holding per-server credential files; defaults to the mounted credentials dir. */
  readonly credentialsDir?: string;
}

interface TrackedToolCall {
  readonly name: string;
  readonly mcp?: { readonly serverName: string; readonly toolName: string };
}

interface LiveSessionState {
  readonly session: HarnessSession;
  readonly permissionPolicy: PermissionPolicy | undefined;
  readonly contextBlocks: readonly TextPromptPart[];
  firstPromptSent: boolean;
  readonly toolCalls: Map<string, TrackedToolCall>;
  tornDown: boolean;
  readonly teardown: Promise<undefined>;
  readonly settleTeardown: () => void;
  readonly unsubscribe: Unsubscribe;
}

export class LiveHarnessFactory implements FacadeHarness {
  private readonly registry: SessionRegistry;
  private readonly sink: HarnessEventSink;
  private readonly createHarness: HarnessFactory;
  private readonly harnessOptions: KimiHarnessOptions;
  private readonly credentialsDir: string | undefined;
  private readonly sessions = new Map<string, LiveSessionState>();
  private runtimeHarness: HarnessSessionFactory | undefined;

  constructor(options: LiveHarnessFactoryOptions) {
    this.registry = options.registry;
    this.sink = options.sink;
    this.createHarness = options.createHarness ?? createKimiHarness;
    this.harnessOptions = options.harnessOptions ?? {};
    this.credentialsDir = options.credentialsDir ?? process.env['OCA_CREDENTIALS_DIR'];
  }

  async createSession(config: FacadeCreateConfig): Promise<void> {
    try {
      if (this.sessions.has(config.sessionId)) {
        throw new FacadeError('session_state_conflict');
      }
      if (config.mcpServers !== undefined && config.mcpServers.length > 0) {
        await writeSessionMcpConfig({
          workDir: config.workDir,
          servers: config.mcpServers,
          credentialsDir: this.credentialsDir,
        });
      }
      const session = await this.runtime().createSession(this.createOptions(config));
      const state = this.wireSession(config.sessionId, session, {
        permissionPolicy: config.permissionPolicy,
        contextBlocks: buildContextBlocks(config),
      });
      if (config.tools !== undefined) {
        await this.applyTools(state, config.tools);
      }
    } catch (error) {
      throw toFacadeError(error, 'internal_error');
    }
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      // The runtime harness itself reuses an active session on resume.
      return;
    }
    try {
      const session = await this.runtime().resumeSession({ id: sessionId });
      this.wireSession(sessionId, session, {
        permissionPolicy: undefined,
        contextBlocks: [],
      });
    } catch (error) {
      throw toFacadeError(error, 'session_resume_failed');
    }
  }

  /**
   * Readiness probe: the runtime harness must be constructible. Construction
   * is lazy and cached, so only the first probe pays for it; a failure is
   * reported as a neutral `runtime_unavailable`.
   */
  async probe(): Promise<void> {
    try {
      this.runtime();
    } catch (error) {
      throw toFacadeError(error, 'runtime_unavailable');
    }
  }

  async prompt(sessionId: string, content: string): Promise<void> {
    const state = this.requireSession(sessionId);
    const parts: TextPromptPart[] = state.firstPromptSent
      ? [textPart(content)]
      : [...state.contextBlocks, textPart(content)];
    state.firstPromptSent = true;
    await state.session.prompt(parts);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.requireSession(sessionId).session.cancel();
  }

  async cancelSession(sessionId: string): Promise<void> {
    const state = this.requireSession(sessionId);
    // Idempotent (mirrors the registry's cancel semantics): a repeated cancel
    // on an already closed session is a no-op.
    if (state.tornDown) return;
    state.tornDown = true;
    // Settle in-flight reverse-RPC handlers with neutral fallbacks so the
    // runtime never awaits a response that can no longer arrive.
    state.settleTeardown();
    state.unsubscribe();
    await state.session.close();
  }

  // --- session wiring ------------------------------------------------------

  private createOptions(config: FacadeCreateConfig): CreateSessionOptions {
    return {
      id: config.sessionId,
      workDir: config.workDir,
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
      ...(config.permissionPolicy !== undefined
        ? { permission: permissionModeForPolicy(config.permissionPolicy) }
        : {}),
      ...(config.planMode !== undefined ? { planMode: config.planMode } : {}),
      ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
      ...(config.additionalDirs !== undefined ? { additionalDirs: config.additionalDirs } : {}),
    };
  }

  private wireSession(
    sessionId: string,
    session: HarnessSession,
    options: {
      permissionPolicy: PermissionPolicy | undefined;
      contextBlocks: readonly TextPromptPart[];
    },
  ): LiveSessionState {
    let settleTeardown!: () => void;
    const teardown = new Promise<undefined>((resolve) => {
      settleTeardown = () => resolve(undefined);
    });
    const state: LiveSessionState = {
      session,
      permissionPolicy: options.permissionPolicy,
      contextBlocks: options.contextBlocks,
      firstPromptSent: false,
      toolCalls: new Map(),
      tornDown: false,
      teardown,
      settleTeardown,
      unsubscribe: session.onEvent((event) => {
        this.bridgeEvent(sessionId, state, event);
      }),
    };
    this.sessions.set(sessionId, state);
    this.installApprovalHandler(sessionId, state);
    this.installQuestionHandler(sessionId, state);
    this.installToolCallHandler(sessionId, state);
    return state;
  }

  private installApprovalHandler(sessionId: string, state: LiveSessionState): void {
    const handler: ApprovalHandler = async (request) => {
      if (state.permissionPolicy === 'always_deny') {
        // No ask round trip: the policy denies every approval-worthy action.
        return { decision: 'rejected', feedback: 'Denied by the session permission policy.' };
      }
      let registration;
      try {
        registration = this.registry.registerPendingCall(sessionId, {
          id: request.toolCallId,
          kind: 'approval',
        });
      } catch {
        // Session no longer active (or a duplicate id): settle neutrally.
        return { decision: 'cancelled' };
      }
      this.sink.emit(sessionId, {
        type: 'approval_request',
        tool_call_id: request.toolCallId,
        tool_name: request.toolName,
        action: request.action,
        display: request.display,
      });
      const resolution = await raceTeardown(state, registration.resolution);
      if (resolution === undefined || resolution.kind !== 'approval') {
        return { decision: 'cancelled' };
      }
      return resolution.feedback !== undefined
        ? { decision: resolution.decision, feedback: resolution.feedback }
        : { decision: resolution.decision };
    };
    state.session.setApprovalHandler(handler);
  }

  private installQuestionHandler(sessionId: string, state: LiveSessionState): void {
    const handler: QuestionHandler = async (request) => {
      // The runtime request carries no stable id, so the facade generates the
      // correlation id for the question round trip.
      const questionId = `q_${randomUUID()}`;
      let registration;
      try {
        registration = this.registry.registerPendingCall(sessionId, {
          id: questionId,
          kind: 'question',
        });
      } catch {
        return null;
      }
      this.sink.emit(sessionId, {
        type: 'question_request',
        question_id: questionId,
        questions: request.questions.map((item) => ({
          question: item.question,
          ...(item.header !== undefined ? { header: item.header } : {}),
          options: item.options.map((option) => ({
            label: option.label,
            ...(option.description !== undefined ? { description: option.description } : {}),
          })),
          ...(item.multiSelect === true ? { multi_select: true } : {}),
        })),
      });
      const resolution = await raceTeardown(state, registration.resolution);
      if (resolution === undefined || resolution.kind !== 'question') {
        return null;
      }
      return resolution.answers;
    };
    state.session.setQuestionHandler(handler);
  }

  private installToolCallHandler(sessionId: string, state: LiveSessionState): void {
    const handler: ToolCallHandler = async (request) => {
      // The reverse-RPC request carries no tool name; the runtime always
      // emits `tool.call.started` (with the name) before execution, so the
      // tracked name is present. Falling back to the id keeps the event
      // correlated even if that ordering ever breaks.
      const name = state.toolCalls.get(request.toolCallId)?.name ?? request.toolCallId;
      let registration;
      try {
        registration = this.registry.registerPendingCall(sessionId, {
          id: request.toolCallId,
          kind: 'external_tool',
        });
      } catch {
        return { output: 'The session no longer accepts tool results.', isError: true };
      }
      this.sink.emit(sessionId, {
        type: 'external_tool_request',
        tool_call_id: request.toolCallId,
        name,
        arguments: request.args,
      });
      const resolution = await raceTeardown(state, registration.resolution);
      if (resolution === undefined || resolution.kind !== 'external_tool') {
        return { output: 'The session ended before the tool result arrived.', isError: true };
      }
      switch (resolution.resolution) {
        case 'completed':
          // The registry rejects a completed resolution without output.
          return { output: resolution.output ?? '', isError: false };
        case 'failed':
          return { output: resolution.output ?? 'The external tool call failed.', isError: true };
        case 'skipped':
          return { output: resolution.output ?? 'The external tool call was skipped.', isError: false };
      }
    };
    state.session.setToolCallHandler(handler);
  }

  // --- event bridge --------------------------------------------------------

  private bridgeEvent(sessionId: string, state: LiveSessionState, event: Event): void {
    switch (event.type) {
      case 'turn.started':
        state.toolCalls.clear();
        this.sink.emit(sessionId, { type: 'session.status_running' });
        return;
      case 'turn.ended':
        this.sink.emit(sessionId, { type: 'session.status_idle' });
        this.sink.turnEnded(sessionId, event.reason);
        return;
      case 'assistant.delta':
        this.sink.emit(sessionId, { type: 'agent.message', content: event.delta });
        return;
      case 'thinking.delta':
        this.sink.emit(sessionId, { type: 'agent.thinking', content: event.delta });
        return;
      case 'tool.call.started': {
        const mcp = parseQualifiedServerToolName(event.name);
        this.sink.emit(
          sessionId,
          mcp === undefined
            ? {
                type: 'agent.tool_use',
                id: event.toolCallId,
                name: event.name,
                arguments: event.args,
              }
            : {
                type: 'agent.mcp_tool_use',
                id: event.toolCallId,
                server_name: mcp.serverName,
                tool_name: mcp.toolName,
                arguments: event.args,
              },
        );
        state.toolCalls.set(event.toolCallId, { name: event.name, ...(mcp ? { mcp } : {}) });
        return;
      }
      case 'tool.result': {
        const tracked = state.toolCalls.get(event.toolCallId);
        state.toolCalls.delete(event.toolCallId);
        const base = {
          id: event.toolCallId,
          ...(event.output !== undefined ? { output: event.output } : {}),
          ...(event.isError === true ? { is_error: true } : {}),
        };
        this.sink.emit(
          sessionId,
          tracked?.mcp === undefined
            ? { type: 'agent.tool_result', ...base }
            : { type: 'agent.mcp_tool_result', ...base },
        );
        return;
      }
      case 'error': {
        // Raw runtime error text never crosses the facade boundary.
        const neutral = toFacadeError(event, 'internal_error');
        this.sink.emit(sessionId, {
          type: 'session.error',
          code: neutral.code,
          message: neutral.message,
        });
        return;
      }
      default:
        return;
    }
  }

  // --- create-time config application --------------------------------------

  private async applyTools(state: LiveSessionState, tools: readonly FacadeToolEntry[]): Promise<void> {
    const enabledNames: string[] = [];
    const externals: ExternalToolDefinition[] = [];
    for (const entry of tools) {
      if (isExternalToolDefinition(entry)) {
        externals.push(entry);
      } else {
        enabledNames.push(...(entry.enabledTools ?? []));
      }
    }
    // Replace the enabled set first: registering an external tool also
    // enables it, so registration must come after setActiveTools.
    await state.session.setActiveTools(enabledNames);
    for (const tool of externals) {
      await state.session.registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
  }

  // --- shared helpers ------------------------------------------------------

  private runtime(): HarnessSessionFactory {
    this.runtimeHarness ??= this.createHarness(this.harnessOptions);
    return this.runtimeHarness;
  }

  private requireSession(sessionId: string): LiveSessionState {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      throw new FacadeError('session_not_found');
    }
    return state;
  }
}

function raceTeardown<T>(state: LiveSessionState, resolution: Promise<T>): Promise<T | undefined> {
  return Promise.race([resolution, state.teardown]);
}

function textPart(text: string): TextPromptPart {
  return { type: 'text', text };
}

/**
 * Qualified server-tool names follow the runtime's `mcp__<server>__<tool>`
 * scheme; sanitized parts can never contain `__`, so splitting on the first
 * separator after the prefix is unambiguous. Decoding is best-effort for
 * event display only.
 */
function parseQualifiedServerToolName(
  name: string,
): { serverName: string; toolName: string } | undefined {
  const prefix = 'mcp__';
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  const separator = rest.indexOf('__');
  if (separator <= 0 || separator >= rest.length - 2) return undefined;
  return { serverName: rest.slice(0, separator), toolName: rest.slice(separator + 2) };
}

/**
 * First-prompt context blocks: system prompt first, then resource / memory /
 * skill blocks (the user content is appended last at prompt time). Resource
 * and skill blocks carry structured references — fetching their content from
 * object storage belongs to a later slice, so the blocks make the attachment
 * visible to the agent without the payload.
 */
function buildContextBlocks(config: FacadeCreateConfig): TextPromptPart[] {
  const blocks: TextPromptPart[] = [];
  if (config.system !== undefined && config.system.trim().length > 0) {
    blocks.push(textPart(config.system));
  }
  for (const resource of config.resources ?? []) {
    const label = resource.mountPath ?? resource.path ?? resource.url ?? resource.fileId ?? resource.id;
    blocks.push(textPart(`[resource: ${label}]\n${JSON.stringify(resource)}\n[/resource]`));
  }
  for (const entry of config.memoryStoreEntries ?? []) {
    if (entry.content.trim().length === 0) continue;
    blocks.push(textPart(`[memory: ${entry.path}]\n${entry.content}\n[/memory]`));
  }
  for (const skill of config.skills ?? []) {
    const label = skill.name ?? skill.id;
    blocks.push(textPart(`[skill: ${label}]\n${JSON.stringify(skill)}\n[/skill]`));
  }
  return blocks;
}
