import type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResponse,
  CreateSessionOptions,
  Event,
  KimiHarnessOptions,
  PromptInput,
  QuestionHandler,
  QuestionRequest,
  QuestionResult,
  RegisterToolInput,
  ResumeSessionInput,
  ToolCallHandler,
  ToolCallRequest,
  ToolCallResponse,
  Unsubscribe,
} from '@moonshot-ai/kimi-code-sdk';

import type { HarnessFactory, HarnessSession, HarnessSessionFactory } from '../src/harness';

/**
 * Deterministic in-test stand-in for the runtime session/harness. It replays a
 * scripted sequence of runtime events and reverse-RPC calls, and records every
 * call it receives so tests can assert on them.
 */

export type FakeScriptStep =
  | { readonly kind: 'event'; readonly event: Event }
  | { readonly kind: 'approval'; readonly request: ApprovalRequest }
  | { readonly kind: 'question'; readonly request: QuestionRequest }
  | { readonly kind: 'tool_call'; readonly request: ToolCallRequest };

/** Builds a runtime event with the envelope fields the SDK would attach. */
export function runtimeEvent(event: { type: string } & Record<string, unknown>): Event {
  return { sessionId: 'ses_1', agentId: 'main', ...event } as Event;
}

export class FakeSession implements HarnessSession {
  readonly id: string;
  private readonly scripts: Map<string, readonly FakeScriptStep[]>;

  get script(): readonly FakeScriptStep[] {
    return this.scripts.get(this.id) ?? [];
  }

  readonly prompts: Array<string | PromptInput> = [];
  readonly registeredTools: RegisterToolInput[] = [];
  readonly activeToolsCalls: Array<readonly string[]> = [];
  readonly approvalRequests: ApprovalRequest[] = [];
  readonly approvalResponses: ApprovalResponse[] = [];
  readonly questionRequests: QuestionRequest[] = [];
  readonly questionResults: QuestionResult[] = [];
  readonly toolCallRequests: ToolCallRequest[] = [];
  readonly toolCallResponses: ToolCallResponse[] = [];
  cancelCalls = 0;
  closeCalls = 0;

  approvalHandler: ApprovalHandler | undefined;
  questionHandler: QuestionHandler | undefined;
  toolCallHandler: ToolCallHandler | undefined;

  private readonly listeners = new Set<(event: Event) => void>();

  constructor(id: string, scripts: Map<string, readonly FakeScriptStep[]>) {
    this.id = id;
    this.scripts = scripts;
  }

  onEvent(listener: (event: Event) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  setQuestionHandler(handler: QuestionHandler | undefined): void {
    this.questionHandler = handler;
  }

  setToolCallHandler(handler: ToolCallHandler | undefined): void {
    this.toolCallHandler = handler;
  }

  /** Records the prompt, then replays the script in order, awaiting handlers. */
  async prompt(input: string | PromptInput): Promise<void> {
    this.prompts.push(input);
    for (const step of this.script) {
      switch (step.kind) {
        case 'event':
          for (const listener of [...this.listeners]) {
            listener(step.event);
          }
          break;
        case 'approval': {
          this.approvalRequests.push(step.request);
          const handler = this.requireHandler(this.approvalHandler, 'approval');
          this.approvalResponses.push(await handler(step.request));
          break;
        }
        case 'question': {
          this.questionRequests.push(step.request);
          const handler = this.requireHandler(this.questionHandler, 'question');
          this.questionResults.push(await handler(step.request));
          break;
        }
        case 'tool_call': {
          this.toolCallRequests.push(step.request);
          const handler = this.requireHandler(this.toolCallHandler, 'tool call');
          this.toolCallResponses.push(await handler(step.request));
          break;
        }
      }
    }
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async registerTool(tool: RegisterToolInput): Promise<void> {
    this.registeredTools.push(tool);
  }

  async setActiveTools(names: readonly string[]): Promise<void> {
    this.activeToolsCalls.push(names);
  }

  private requireHandler<T>(handler: T | undefined, label: string): T {
    if (handler === undefined) {
      throw new Error(`fake session received a ${label} request but no handler is installed`);
    }
    return handler;
  }
}

/**
 * Mirrors the klient `RPCError` shape (numeric envelope code) so tests can
 * script the runtime failures the recovery hook discriminates on:
 * `session.not_found` (envelope code 40401) vs. any other read failure.
 */
export class FakeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RPCError';
  }
}

/** Envelope code for `session.not_found` on the runtime RPC boundary. */
export const RPC_SESSION_NOT_FOUND = 40401;

export function rpcError(code: number, message: string): FakeRpcError {
  return new FakeRpcError(code, message);
}

export class FakeHarness implements HarnessSessionFactory {
  harnessOptions: KimiHarnessOptions | undefined;
  readonly created: CreateSessionOptions[] = [];
  readonly resumed: ResumeSessionInput[] = [];
  readonly sessions = new Map<string, FakeSession>();
  /** Scripted per-id resume failures (journal miss / unreadable journal). */
  readonly resumeErrors = new Map<string, Error>();
  private readonly scripts = new Map<string, readonly FakeScriptStep[]>();

  setScript(sessionId: string, steps: readonly FakeScriptStep[]): void {
    this.scripts.set(sessionId, steps);
  }

  createSession(options: CreateSessionOptions): Promise<FakeSession> {
    this.created.push(options);
    const id = options.id ?? 'session-unknown';
    const session = new FakeSession(id, this.scripts);
    this.sessions.set(id, session);
    return Promise.resolve(session);
  }

  resumeSession(input: ResumeSessionInput): Promise<FakeSession> {
    this.resumed.push(input);
    const failure = this.resumeErrors.get(input.id);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    const existing = this.sessions.get(input.id);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    const session = new FakeSession(input.id, this.scripts);
    this.sessions.set(input.id, session);
    return Promise.resolve(session);
  }
}

export interface FakeHarnessHandle {
  readonly fake: FakeHarness;
  readonly createHarness: HarnessFactory;
}

export function createFakeHarness(): FakeHarnessHandle {
  const fake = new FakeHarness();
  const createHarness: HarnessFactory = (options) => {
    fake.harnessOptions = options;
    return fake;
  };
  return { fake, createHarness };
}
