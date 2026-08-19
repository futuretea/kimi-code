import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorCodes, createKimiHarness, isKimiError, resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
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
  ToolCallResponse,
  Unsubscribe,
} from '@moonshot-ai/kimi-code-sdk';

import { FacadeError, toFacadeError } from './errors';
import type {
	FacadeAgentProfiles,
  FacadeCreateConfig,
  FacadeMcpServer,
  FacadeResource,
	FacadeSessionConfig,
	FacadeMemorySnapshotResource,
  FacadeMemorySyncResource,
  FacadeToolEntry,
  HarnessEventSink,
  EvaluatedPermission,
  PermissionPolicyType,
} from './facade-types';
import { hydrateSessionMcpCredentials, restoreSessionMcpConfig, snapshotSessionMcpConfig, writeSessionMcpConfig } from './mcp-config';
import { configureGitHubTokenEnvironment, materializeReadOnlyMemoryStoreResources, materializeSessionResources, snapshotMemoryStoreResources, validateDistinctWorkspacePVCPaths, validateMemorySnapshotEntry } from './resource-materializer';
import type { PendingCallRegistration, SessionRegistry, StagedToolResult } from './session-registry';
import { materializeSessionSkills, removeMaterializedSessionSkills } from './skill-materializer';
import { readProfilePolicyState, writeProfilePolicyState, type ProfilePolicyState } from './profile-policy-state';

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
 * The runtime stays in manual mode so the facade can apply Qoder's per-tool
 * policy in one approval handler. It immediately approves always_allow,
 * bridges always_ask, and rejects always_deny.
 */
export const QODER_PERMISSION_MODE: PermissionMode = 'manual';
const QODER_MAX_SESSION_THREADS = 25;
const VAULT_ENVIRONMENT_NAMES_MARKER = 'OCA_FACADE_VAULT_ENV_NAMES';
const SESSION_ENVIRONMENT_NAMES_MARKER = 'OCA_FACADE_SESSION_ENV_NAMES';

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
  reloadSession(): Promise<unknown>;
  prompt(input: string | PromptInput, options?: { systemMessage?: string }): Promise<void>;
  appendSystemMessage(content: string): Promise<void>;
  cancel(): Promise<void>;
  removeAgent(agentId: string): Promise<void>;
  close(): Promise<void>;
  registerTool(tool: RegisterToolInput): Promise<void>;
  unregisterTool(name: string): Promise<void>;
  setActiveTools(names: readonly string[]): Promise<void>;
}

export interface HarnessSessionFactory {
  createSession(options: CreateSessionOptions): Promise<HarnessSession>;
  resumeSession(input: ResumeSessionInput): Promise<HarnessSession>;
  withInteractiveAgent<T>(agentId: string, fn: () => T): T;
}

export type HarnessFactory = (options: KimiHarnessOptions) => HarnessSessionFactory;

/** Session operations the routes layer drives through the harness. */
export interface FacadeHarness {
	createSession(config: FacadeCreateConfig): Promise<void>;
	updateSessionConfig(sessionId: string, config: FacadeSessionConfig): Promise<void>;
	materializeSessionResources(sessionId: string, resources: readonly FacadeResource[]): Promise<void>;
	snapshotSessionMemory(sessionId: string): Promise<readonly FacadeMemorySnapshotResource[]>;
	acknowledgeSessionMemory(sessionId: string, resources: readonly FacadeMemorySyncResource[]): Promise<void>;
	resumeSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, content: string, systemMessage?: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  interruptAgent(sessionId: string, agentId: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  removeAgent(sessionId: string, agentId: string): Promise<void>;
  /**
   * Readiness probe: rejects when the runtime is not available — harness
   * construction or the home (journal) directory check.
   */
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
  /** Workspace used by journal recovery; production defaults to /workspace. */
  readonly resumeWorkDir?: string;
}

interface TrackedToolCall {
  readonly name: string;
  readonly mcp?: { readonly serverName: string; readonly toolName: string };
  readonly custom?: true;
	readonly arguments?: unknown;
}

interface LiveSessionState {
  readonly session: HarnessSession;
  readonly workDir: string;
	contextBlocks: TextPromptPart[];
	resourceContextBlocks: TextPromptPart[];
	resources: readonly FacadeResource[];
  memoryResources: readonly FacadeResource[];
  toolPolicies: ReadonlyMap<string, PermissionPolicyType>;
	readonly mainProfileName: string;
	readonly profileToolPolicies: Map<string, ReadonlyMap<string, PermissionPolicyType>>;
	readonly childProfileNames: Map<string, string>;
  customToolNames: ReadonlySet<string>;
	mcpServers: readonly FacadeMcpServer[];
	tools: readonly FacadeToolEntry[];
	sessionEnvironmentVariables: Map<string, string>;
	vaultEnvironmentNames: Set<string>;
  firstPromptSent: boolean;
  readonly toolCalls: Map<string, TrackedToolCall>;
  readonly childToolCalls: Map<string, TrackedToolCall>;
  readonly childThinkingTurnIDs: Map<string, number>;
  readonly modelRequestStartIDs: Map<string, string>;
  readonly childAgentIds: Set<string>;
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
  private readonly resumeWorkDir: string;
  private readonly sessions = new Map<string, LiveSessionState>();
  private runtimeHarness: HarnessSessionFactory | undefined;

  constructor(options: LiveHarnessFactoryOptions) {
    this.registry = options.registry;
    this.sink = options.sink;
    this.createHarness = options.createHarness ?? createKimiHarness;
    this.harnessOptions = options.harnessOptions ?? {};
    this.credentialsDir = options.credentialsDir ?? process.env['OCA_CREDENTIALS_DIR'];
    this.resumeWorkDir = options.resumeWorkDir ?? process.env['OCA_FACADE_WORK_DIR'] ?? '/workspace';
  }

  async createSession(config: FacadeCreateConfig): Promise<void> {
    let skillsMaterialized = false;
    try {
      if (this.sessions.has(config.sessionId)) {
        throw new FacadeError('session_state_conflict');
      }
		const profilePolicyState = profilePolicyStateForCreate(config);
		await writeProfilePolicyState(config.workDir, profilePolicyState);
		await materializeSessionResources(config.resources ?? [], config.workDir);
		await materializeSessionSkills(config.skills ?? [], config.skillArchives ?? [], config.workDir);
		skillsMaterialized = (config.skills?.length ?? 0) > 0;
		configureGitHubTokenEnvironment(config.resources ?? []);
      if (config.mcpServers !== undefined && config.mcpServers.length > 0) {
        await writeSessionMcpConfig({
          workDir: config.workDir,
          servers: withMcpToolFilters(config.mcpServers, config.tools),
          credentialsDir: this.credentialsDir,
        });
      }
      const session = await this.runtime().createSession(this.createOptions(config));
      const state = this.wireSession(config.sessionId, session, {
        workDir: config.workDir,
        mcpServers: config.mcpServers ?? [],
        tools: config.tools ?? [],
		profilePolicyState,
		contextBlocks: buildStaticContextBlocks(config),
		resources: config.resources ?? [],
      });
		this.replaceSessionEnvironmentVariables(state, config.sessionEnvironmentVariables ?? {});
		this.replaceVaultEnvironmentVariables(state, config.vaultEnvironmentVariables ?? {});
      if (config.tools !== undefined) {
        await this.applyTools(state, config.tools);
      }
    } catch (error) {
      if (skillsMaterialized) await removeMaterializedSessionSkills(config.skills ?? [], config.workDir);
      throw toFacadeError(error, 'internal_error');
    }
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      // The runtime harness itself reuses an active session on resume.
      return;
    }
    try {
		const workDir = this.resumeWorkDir;
		let profilePolicyState: ProfilePolicyState;
		try {
			profilePolicyState = await readProfilePolicyState(workDir);
			await hydrateSessionMcpCredentials(workDir, this.credentialsDir);
		} catch (policyStateError) {
			await this.runtime().resumeSession({ id: sessionId });
			throw policyStateError;
		}
      const session = await this.runtime().resumeSession({ id: sessionId });
		const state = this.wireSession(sessionId, session, {
		workDir,
        mcpServers: [],
        tools: [],
		profilePolicyState,
		contextBlocks: [],
		resources: [],
      });
		state.vaultEnvironmentNames = vaultEnvironmentNamesFromProcess();
		state.sessionEnvironmentVariables = sessionEnvironmentVariablesFromProcess();
    } catch (error) {
      // A session the runtime journal does not hold keeps the 404 contract
      // code; anything else is sanitized into a neutral resume failure.
      throw isSessionNotFoundError(error)
        ? new FacadeError('session_not_found')
        : toFacadeError(error, 'session_resume_failed');
    }
  }

  async updateSessionConfig(sessionId: string, config: FacadeSessionConfig): Promise<void> {
    const state = this.requireSession(sessionId);
    try {
      const nextMCPServers = config.mcpServers ?? state.mcpServers;
      const nextTools = config.tools ?? state.tools;
      const reloadMCP = config.mcpServers !== undefined || config.mcpCredentials !== undefined;
		const needsConfigWrite = config.mcpServers !== undefined || config.tools !== undefined || config.mcpCredentials !== undefined;
      if (reloadMCP) {
		const snapshot = await snapshotSessionMcpConfig(state.workDir, nextMCPServers);
		try {
			await this.writeSessionMcpConfig(state.workDir, nextMCPServers, nextTools, config.mcpCredentials);
			// Kimi initializes MCP clients from the session config. Reloading the
			// same journal-backed Session closes prior connections before it reads
			// the replacement config, so rotation/removal never leaves an old
			// bearer credential live in the runtime.
			await state.session.reloadSession();
		} catch (error) {
			await restoreSessionMcpConfig(snapshot);
			if (isKimiError(error) && error.code === ErrorCodes.TURN_AGENT_BUSY) {
				throw new FacadeError('session_state_conflict');
			}
			throw error;
		}
		state.customToolNames = new Set();
	} else if (needsConfigWrite) {
		await this.writeSessionMcpConfig(state.workDir, nextMCPServers, nextTools, config.mcpCredentials);
	}
		if (config.sessionEnvironmentVariables !== undefined) {
			this.replaceSessionEnvironmentVariables(state, config.sessionEnvironmentVariables);
		}
		if (config.vaultEnvironmentVariables !== undefined) {
			this.replaceVaultEnvironmentVariables(state, config.vaultEnvironmentVariables);
		}
      state.mcpServers = nextMCPServers;
      state.tools = nextTools;
		if (reloadMCP || config.tools !== undefined) {
			await this.applyTools(state, nextTools);
			state.profileToolPolicies.set(state.mainProfileName, state.toolPolicies);
			await writeProfilePolicyState(state.workDir, profilePolicyStateFromLiveState(state));
		}
    } catch (error) {
      throw toFacadeError(error, 'internal_error');
    }
  }

	private async writeSessionMcpConfig(
		workDir: string,
		mcpServers: readonly FacadeMcpServer[],
		tools: readonly FacadeToolEntry[],
		credentials: Readonly<Record<string, string>> | undefined,
	): Promise<void> {
		await writeSessionMcpConfig({
			workDir,
			servers: withMcpToolFilters(mcpServers, tools),
			credentialsDir: this.credentialsDir,
			...(credentials !== undefined ? { credentials } : {}),
			replace: true,
		});
	}

	private replaceSessionEnvironmentVariables(state: LiveSessionState, values: Readonly<Record<string, string>>): void {
		const next = new Map(Object.entries(values));
		for (const name of state.sessionEnvironmentVariables.keys()) {
			if (!next.has(name) && !state.vaultEnvironmentNames.has(name)) delete process.env[name];
		}
		for (const [name, value] of next) {
			if (!state.vaultEnvironmentNames.has(name)) process.env[name] = value;
		}
		state.sessionEnvironmentVariables = next;
	}

	private replaceVaultEnvironmentVariables(state: LiveSessionState, values: Readonly<Record<string, string>>): void {
		const names = new Set(Object.keys(values));
		for (const name of state.vaultEnvironmentNames) {
			if (!names.has(name)) {
				const sessionValue = state.sessionEnvironmentVariables.get(name);
				if (sessionValue === undefined) delete process.env[name];
				else process.env[name] = sessionValue;
			}
		}
		for (const [name, value] of Object.entries(values)) process.env[name] = value;
		state.vaultEnvironmentNames = names;
	}

	async materializeSessionResources(sessionId: string, resources: readonly FacadeResource[]): Promise<void> {
    const state = this.requireSession(sessionId);
    try {
		if (resources.some((resource) => resource.type !== 'file' && resource.type !== 'github_repository' && resource.type !== 'memory_store')) {
			throw new FacadeError('invalid_request');
		}
		const updatedResources = mergeResourcesByID(state.resources, resources);
		validateDistinctWorkspacePVCPaths(updatedResources);
		await materializeSessionResources(resources, state.workDir);
		state.resources = updatedResources;
		configureGitHubTokenEnvironment(state.resources);
		state.memoryResources = state.resources.filter((resource) => resource.type === 'memory_store');
      if (!state.firstPromptSent) {
			state.resourceContextBlocks = buildResourceContextBlocks(state.resources);
			state.resourceContextBlocks.push(...buildMemoryInstructionBlocks(state.resources));
      }
    } catch (error) {
      throw toFacadeError(error, 'internal_error');
    }
  }

	async snapshotSessionMemory(sessionId: string): Promise<readonly FacadeMemorySnapshotResource[]> {
		try {
			return await snapshotMemoryStoreResources(this.requireSession(sessionId).memoryResources);
		} catch (error) {
			throw toFacadeError(error, 'internal_error');
		}
	}

	async acknowledgeSessionMemory(sessionId: string, resources: readonly FacadeMemorySyncResource[]): Promise<void> {
		const state = this.requireSession(sessionId);
		const writable = state.memoryResources.filter((resource) => resource.access !== 'read_only');
		if (resources.length !== writable.length) throw new FacadeError('invalid_request');
		const synchronized = new Map(resources.map((resource) => [resource.resourceId, resource]));
		if (synchronized.size !== resources.length) throw new FacadeError('invalid_request');
		for (const resource of writable) {
			const acknowledged = synchronized.get(resource.id);
			if (acknowledged === undefined || acknowledged.memoryStoreId !== resource.memoryStoreId) {
				throw new FacadeError('invalid_request');
			}
		}
		try {
			for (const resource of resources) {
				for (const entry of resource.entries) validateMemorySnapshotEntry(entry.path, entry.content);
			}
		} catch {
			throw new FacadeError('invalid_request');
		}
		const applyAcknowledgedEntries = (resource: FacadeResource): FacadeResource => {
			const acknowledged = synchronized.get(resource.id);
			if (acknowledged === undefined || resource.memoryStoreId !== acknowledged.memoryStoreId) return resource;
			return { ...resource, memoryEntries: acknowledged.entries };
		};
		state.memoryResources = state.memoryResources.map(applyAcknowledgedEntries);
		state.resources = state.resources.map(applyAcknowledgedEntries);
	}

  /**
   * Readiness probe: the runtime harness must be constructible, and the home
   * directory (the journal-bearing filesystem, resolved exactly as the
   * runtime resolves it) must exist and be readable and writable. Harness
   * construction is lazy and cached, so only the first probe pays for it; the
   * home-dir check stays cheap and runs on every probe. Any failure is
   * reported as a neutral `runtime_unavailable`.
   */
  async probe(): Promise<void> {
    try {
      this.runtime();
      probeHomeDir(resolveKimiHome(this.harnessOptions.homeDir));
    } catch (error) {
      throw toFacadeError(error, 'runtime_unavailable');
    }
  }

  async prompt(sessionId: string, content: string, systemMessage?: string): Promise<void> {
    const state = this.requireSession(sessionId);
		if (state.memoryResources.some((resource) => resource.access === 'read_only')) {
			await materializeReadOnlyMemoryStoreResources(state.memoryResources);
		}
    const parts: TextPromptPart[] = state.firstPromptSent
      ? [textPart(content)]
      : [...state.contextBlocks, ...state.resourceContextBlocks, textPart(content)];
    state.firstPromptSent = true;
    await state.session.prompt(parts, systemMessage === undefined ? undefined : { systemMessage });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.requireSession(sessionId).session.cancel();
  }

  async interruptAgent(sessionId: string, agentId: string): Promise<void> {
    const session = this.requireSession(sessionId).session;
    await this.runtime().withInteractiveAgent(agentId, () => session.cancel());
  }

  async removeAgent(sessionId: string, agentId: string): Promise<void> {
    try {
      await this.requireSession(sessionId).session.removeAgent(agentId);
    } catch (error) {
      // Removing an active child is an expected control-plane conflict. Keep
      // the runtime's detailed state out of the facade contract while making
      // the ordered command retry behavior explicit to the orchestrator.
      if (isKimiError(error) && error.code === ErrorCodes.SESSION_STATE_INVALID) {
        throw new FacadeError('session_state_conflict');
      }
      throw error;
    }
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
      ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
      permission: QODER_PERMISSION_MODE,
      ...(config.planMode !== undefined ? { planMode: config.planMode } : {}),
      ...(config.metadata !== undefined ? { metadata: config.metadata } : {}),
      ...(config.additionalDirs !== undefined ? { additionalDirs: config.additionalDirs } : {}),
      ...(config.agentProfiles !== undefined ? { agentProfiles: toRuntimeAgentProfiles(config.agentProfiles) } : {}),
    };
  }

  private wireSession(
    sessionId: string,
    session: HarnessSession,
    options: {
      workDir: string;
      mcpServers: readonly FacadeMcpServer[];
      tools: readonly FacadeToolEntry[];
		profilePolicyState: ProfilePolicyState;
      contextBlocks: readonly TextPromptPart[];
		resources: readonly FacadeResource[];
    },
  ): LiveSessionState {
    let settleTeardown!: () => void;
    const teardown = new Promise<undefined>((resolve) => {
      settleTeardown = () => resolve(undefined);
    });
    const state: LiveSessionState = {
      session,
      workDir: options.workDir,
      contextBlocks: [...options.contextBlocks],
      resourceContextBlocks: [
        ...buildResourceContextBlocks(options.resources),
        ...buildMemoryInstructionBlocks(options.resources),
      ],
		resources: options.resources,
		memoryResources: options.resources.filter((resource) => resource.type === 'memory_store'),
		toolPolicies: options.profilePolicyState.policies.get(options.profilePolicyState.mainProfile) ?? new Map(),
		mainProfileName: options.profilePolicyState.mainProfile,
		profileToolPolicies: new Map(options.profilePolicyState.policies),
		childProfileNames: new Map(),
      customToolNames: new Set(),
		mcpServers: options.mcpServers,
		tools: options.tools,
		sessionEnvironmentVariables: new Map(),
		vaultEnvironmentNames: new Set(),
      firstPromptSent: false,
      toolCalls: new Map(),
      childToolCalls: new Map(),
      childThinkingTurnIDs: new Map(),
      modelRequestStartIDs: new Map(),
      childAgentIds: new Set(),
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
		const runtimeAgentID = request.agentId !== undefined && state.childAgentIds.has(request.agentId)
			? request.agentId
			: undefined;
      // A custom tool is never executed by the runtime. Its call is bridged
      // directly to `agent.custom_tool_use`, which the client settles with
      // `user.custom_tool_result`; do not introduce a separate confirmation.
      const policy = runtimeAgentID === undefined && state.customToolNames.has(request.toolName)
        ? 'always_allow'
		: permissionPolicyForRuntimeAgent(state, request.toolName, runtimeAgentID);
      if (policy === 'always_allow') {
        return { decision: 'approved' };
      }
      if (policy === 'always_deny') {
        // No ask round trip: the policy denies every approval-worthy action.
        return { decision: 'rejected', feedback: 'Denied by the session permission policy.' };
      }
		const tracked = runtimeAgentID === undefined
			? state.toolCalls.get(request.toolCallId)
			: state.childToolCalls.get(childToolCallKey(runtimeAgentID, request.toolCallId));
		const mcp = tracked?.mcp ?? parseQualifiedServerToolName(request.toolName);
      let registration: PendingCallRegistration;
      try {
        registration = this.registry.registerPendingCall(sessionId, {
          id: request.toolCallId,
          kind: 'approval',
			...(runtimeAgentID !== undefined ? { runtimeAgentId: runtimeAgentID } : {}),
        });
      } catch {
        // Session no longer active, a duplicate id, or the journal refused
        // the record (fail-closed): settle neutrally so the runtime never
        // awaits a response that can no longer arrive.
        return { decision: 'cancelled' };
      }
      this.sink.emit(sessionId, {
        type: 'approval_request',
        tool_call_id: request.toolCallId,
			...(runtimeAgentID !== undefined ? { runtime_agent_id: runtimeAgentID } : {}),
			tool_name: mcp?.toolName ?? tracked?.name ?? request.toolName,
			...(mcp !== undefined ? { server_name: mcp.serverName } : {}),
			...(tracked?.arguments !== undefined ? { arguments: tracked.arguments } : {}),
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
      let registration: PendingCallRegistration;
      try {
        registration = this.registry.registerPendingCall(sessionId, {
          id: request.toolCallId,
          kind: 'external_tool',
        });
      } catch {
        return { output: 'The session no longer accepts tool results.', isError: true };
      }
      if (registration.replayed !== true) {
        this.sink.emit(sessionId, {
          type: 'external_tool_request',
          tool_call_id: request.toolCallId,
          name,
          arguments: request.args,
        });
      }
      for (;;) {
        const delivery = await raceTeardown(
          state,
          this.registry.waitForToolResultDelivery(sessionId, request.toolCallId),
        );
        if (delivery === undefined) {
          return { output: 'The session ended before the tool result arrived.', isError: true };
        }
        try {
          this.registry.beginToolResultDelivery(sessionId, request.toolCallId, delivery);
        } catch {
          this.registry.failToolResultDelivery(sessionId, request.toolCallId, delivery);
          continue;
        }
        try {
          if (delivery.result.systemMessage !== undefined) {
            await state.session.appendSystemMessage(delivery.result.systemMessage);
          }
        } catch {
          // A rejected RPC does not prove that the runtime skipped the write.
          // Keep the durable `delivering` state and never replay it.
          this.registry.failUncertainToolResultDelivery(sessionId, request.toolCallId, delivery);
          return { output: 'The external tool result could not be finalized.', isError: true };
        }
        const response = toolCallResponse(delivery.result);
        try {
          // `delivered` is durable before the response crosses the process
          // boundary, so a cleanup error can never cause a replay.
          this.registry.completeToolResultDelivery(sessionId, request.toolCallId, delivery);
          return response;
        } catch {
          // Completion may fail after the runtime accepted the system message.
          // That uncertain state is fail-closed, never replayed.
          this.registry.failUncertainToolResultDelivery(sessionId, request.toolCallId, delivery);
          return { output: 'The external tool result could not be finalized.', isError: true };
        }
      }
    };
    state.session.setToolCallHandler(handler);
  }

  // --- event bridge --------------------------------------------------------

  private bridgeEvent(sessionId: string, state: LiveSessionState, event: Event): void {
    if (this.bridgeSubagentLifecycle(sessionId, state, event)) return;

    if (this.bridgeSubagentRuntimeEvent(sessionId, state, event)) return;

    switch (event.type) {
      case 'model.request.started': {
        const publicID = newFacadePublicEventID();
        state.modelRequestStartIDs.set(modelRequestKey(event.agentId, event.requestId), publicID);
        this.sink.emit(sessionId, { type: 'span.model_request_start', public_id: publicID });
        return;
      }
      case 'model.request.ended': {
        const key = modelRequestKey(event.agentId, event.requestId);
        const startID = state.modelRequestStartIDs.get(key);
        state.modelRequestStartIDs.delete(key);
        if (startID !== undefined) {
          this.sink.emit(sessionId, {
            type: 'span.model_request_end',
            model_request_start_id: startID,
            is_error: event.isError,
          });
        }
        return;
      }
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
      case 'compaction.completed':
        this.sink.emit(sessionId, { type: 'agent.thread_context_compacted' });
        return;
      case 'tool.call.started': {
        const mcp = parseQualifiedServerToolName(event.name);
        const custom = state.customToolNames.has(event.name);
			const permission = evaluatedPermission(state, event.name);
			if (!custom && permission !== 'ask') {
          this.sink.emit(
            sessionId,
            mcp === undefined
              ? {
                  type: 'agent.tool_use',
                  id: event.toolCallId,
                  name: event.name,
                  arguments: event.args,
									evaluated_permission: permission,
                }
              : {
                  type: 'agent.mcp_tool_use',
                  id: event.toolCallId,
                  server_name: mcp.serverName,
                  tool_name: mcp.toolName,
                  arguments: event.args,
									evaluated_permission: permission,
                },
          );
        }
        state.toolCalls.set(event.toolCallId, {
          name: event.name,
          ...(mcp ? { mcp } : {}),
          ...(custom ? { custom: true } : {}),
				...(event.args !== undefined ? { arguments: event.args } : {}),
        });
        return;
      }
      case 'tool.result': {
        const tracked = state.toolCalls.get(event.toolCallId);
        state.toolCalls.delete(event.toolCallId);
        // The client-supplied user.custom_tool_result is already the public
        // result for a custom tool. Kimi's internal completion must not be
        // reclassified as the built-in agent.tool_result event.
        if (tracked?.custom === true) return;
        const base = {
          id: event.toolCallId,
          content: toolResultContent(event.output),
          is_error: event.isError === true,
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

  // The Kimi SDK subscription is session-scoped. Child runtime events carry a
  // private identity only so the orchestrator can route their public projection
  // to a durable Session Thread. Raw thought text, lifecycle error detail, and
  // child turn boundaries never enter the parent Session event stream.
  private bridgeSubagentRuntimeEvent(sessionId: string, state: LiveSessionState, event: Event): boolean {
    if (!state.childAgentIds.has(event.agentId)) return false;
    switch (event.type) {
      case 'model.request.started': {
        const publicID = newFacadePublicEventID();
        state.modelRequestStartIDs.set(modelRequestKey(event.agentId, event.requestId), publicID);
        this.sink.emit(sessionId, {
          type: 'subagent.model_request_start',
          runtime_agent_id: event.agentId,
          public_id: publicID,
        });
        return true;
      }
      case 'model.request.ended': {
        const key = modelRequestKey(event.agentId, event.requestId);
        const startID = state.modelRequestStartIDs.get(key);
        state.modelRequestStartIDs.delete(key);
        if (startID !== undefined) {
          this.sink.emit(sessionId, {
            type: 'subagent.model_request_end',
            runtime_agent_id: event.agentId,
            model_request_start_id: startID,
            is_error: event.isError,
          });
        }
        return true;
      }
      case 'assistant.delta':
        this.sink.emit(sessionId, {
          type: 'subagent.message',
          runtime_agent_id: event.agentId,
          content: event.delta,
        });
        return true;
      case 'thinking.delta':
        if (state.childThinkingTurnIDs.get(event.agentId) !== event.turnId) {
          state.childThinkingTurnIDs.set(event.agentId, event.turnId);
          this.sink.emit(sessionId, { type: 'subagent.thinking', runtime_agent_id: event.agentId });
        }
        return true;
      case 'compaction.completed':
        this.sink.emit(sessionId, {
          type: 'subagent.thread_context_compacted',
          runtime_agent_id: event.agentId,
        });
        return true;
      case 'tool.call.started': {
        const mcp = parseQualifiedServerToolName(event.name);
		const permission = evaluatedPermission(state, event.name, event.agentId);
		if (permission !== 'ask') {
			this.sink.emit(
				sessionId,
				mcp === undefined
					? {
						type: 'subagent.tool_use',
						runtime_agent_id: event.agentId,
						id: event.toolCallId,
						name: event.name,
						arguments: event.args,
						evaluated_permission: permission,
					}
					: {
						type: 'subagent.mcp_tool_use',
						runtime_agent_id: event.agentId,
						id: event.toolCallId,
						server_name: mcp.serverName,
						tool_name: mcp.toolName,
						arguments: event.args,
						evaluated_permission: permission,
					},
			);
		}
		state.childToolCalls.set(childToolCallKey(event.agentId, event.toolCallId), {
			name: event.name,
			...(mcp ? { mcp } : {}),
			...(event.args !== undefined ? { arguments: event.args } : {}),
		});
        return true;
      }
      case 'tool.result': {
        const key = childToolCallKey(event.agentId, event.toolCallId);
        const tracked = state.childToolCalls.get(key);
        state.childToolCalls.delete(key);
        const base = {
          runtime_agent_id: event.agentId,
          id: event.toolCallId,
          content: toolResultContent(event.output),
          is_error: event.isError === true,
        };
        this.sink.emit(
          sessionId,
          tracked?.mcp === undefined
            ? { type: 'subagent.tool_result', ...base }
            : { type: 'subagent.mcp_tool_result', ...base },
        );
        return true;
      }
      default:
        return true;
    }
  }

  private bridgeSubagentLifecycle(sessionId: string, state: LiveSessionState, event: Event): boolean {
    switch (event.type) {
      case 'subagent.spawned':
        state.childAgentIds.add(event.subagentId);
		state.childProfileNames.set(event.subagentId, event.subagentName);
        this.sink.emit(sessionId, {
          type: 'subagent.spawned',
          runtime_agent_id: event.subagentId,
          profile_name: event.subagentName,
        });
        return true;
      case 'subagent.started':
        this.sink.emit(sessionId, { type: 'subagent.started', runtime_agent_id: event.subagentId });
        return true;
      case 'subagent.completed':
        this.sink.emit(sessionId, { type: 'subagent.completed', runtime_agent_id: event.subagentId });
        return true;
      case 'subagent.failed':
        this.sink.emit(sessionId, { type: 'subagent.failed', runtime_agent_id: event.subagentId });
        return true;
      case 'subagent.suspended':
        this.sink.emit(sessionId, { type: 'subagent.suspended', runtime_agent_id: event.subagentId });
        return true;
      default:
        return false;
    }
  }

  // --- create-time config application --------------------------------------

  private async applyTools(state: LiveSessionState, tools: readonly FacadeToolEntry[]): Promise<void> {
    const resolved = resolveTools(tools);
    await state.session.setActiveTools(resolved.enabledNames);
    for (const name of state.customToolNames) {
      await state.session.unregisterTool(name);
    }
    for (const tool of resolved.customTools) {
      await state.session.registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      });
    }
    state.toolPolicies = resolved.policies;
    state.customToolNames = new Set(resolved.customTools.map((tool) => tool.name));
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

function vaultEnvironmentNamesFromProcess(): Set<string> {
	return new Set(
		(process.env[VAULT_ENVIRONMENT_NAMES_MARKER] ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name !== ''),
	);
}

function sessionEnvironmentVariablesFromProcess(): Map<string, string> {
	const values = new Map<string, string>();
	for (const name of environmentNamesFromMarker(SESSION_ENVIRONMENT_NAMES_MARKER)) {
		values.set(name, process.env[name] ?? '');
	}
	return values;
}

function environmentNamesFromMarker(marker: string): Set<string> {
	return new Set(
		(process.env[marker] ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name !== ''),
	);
}

function toolCallResponse(result: StagedToolResult): ToolCallResponse {
  switch (result.resolution) {
    case 'completed':
      return { output: result.output ?? '', isError: false };
    case 'failed':
      return { output: result.output ?? 'The external tool call failed.', isError: true };
    case 'skipped':
      return { output: result.output ?? 'The external tool call was skipped.', isError: false };
  }
}

function toRuntimeAgentProfiles(
  profiles: NonNullable<FacadeCreateConfig['agentProfiles']>,
): NonNullable<CreateSessionOptions['agentProfiles']> {
  return {
    mainProfile: profiles.mainProfile,
    maxAgents: profiles.maxAgents ?? QODER_MAX_SESSION_THREADS,
    profiles: profiles.profiles.map((profile) => ({
      name: profile.name,
      ...(profile.description !== undefined ? { description: profile.description } : {}),
      ...(profile.systemPromptTemplate !== undefined
        ? { systemPromptTemplate: profile.systemPromptTemplate }
        : {}),
      ...(profile.tools !== undefined ? { tools: [...profile.tools] } : {}),
      ...(profile.modelAlias !== undefined ? { modelAlias: profile.modelAlias } : {}),
      ...(profile.thinkingEffort !== undefined ? { thinkingEffort: profile.thinkingEffort } : {}),
      ...(profile.contextWindow !== undefined ? { contextWindow: profile.contextWindow } : {}),
      ...(profile.whenToUse !== undefined ? { whenToUse: profile.whenToUse } : {}),
      ...(profile.subagents !== undefined
        ? {
            subagents: Object.fromEntries(
              Object.entries(profile.subagents).map(([name, subagent]) => [
                name,
                subagent.description !== undefined ? { description: subagent.description } : {},
              ]),
            ),
          }
        : {}),
    })),
  };
}

const QODER_BUILTIN_TOOLS = [
  'Bash',
  'DeliverArtifacts',
  'Edit',
  'Glob',
  'Grep',
  'ImageGen',
  'ImageSearch',
  'Read',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

interface ResolvedTools {
  readonly enabledNames: readonly string[];
  readonly policies: ReadonlyMap<string, PermissionPolicyType>;
  readonly customTools: readonly Required<Pick<FacadeToolEntry, 'name' | 'description' | 'inputSchema'>>[];
}

function evaluatedPermission(state: LiveSessionState, toolName: string, runtimeAgentID?: string): EvaluatedPermission {
	switch (permissionPolicyForRuntimeAgent(state, toolName, runtimeAgentID)) {
    case 'always_allow':
      return 'allow';
    case 'always_deny':
      return 'deny';
    default:
      return 'ask';
  }
}

function permissionPolicyForRuntimeAgent(
	state: LiveSessionState,
	toolName: string,
	runtimeAgentID?: string,
): PermissionPolicyType {
	if (runtimeAgentID !== undefined) {
		const profile = state.childProfileNames.get(runtimeAgentID);
		return state.profileToolPolicies.get(profile ?? '')?.get(toolName)
			?? state.toolPolicies.get(toolName)
			?? 'always_ask';
	}
	return state.toolPolicies.get(toolName) ?? 'always_ask';
}

function profilePolicyStateForCreate(config: FacadeCreateConfig): ProfilePolicyState {
	const mainProfile = config.agentProfiles?.mainProfile ?? 'main';
	const policies = profilePoliciesFromAgentProfiles(config.agentProfiles);
	policies.set(mainProfile, new Map(resolveTools(config.tools ?? []).policies));
	return { mainProfile, policies };
}

function profilePoliciesFromAgentProfiles(profiles: FacadeAgentProfiles | undefined): Map<string, ReadonlyMap<string, PermissionPolicyType>> {
	const policies = new Map<string, ReadonlyMap<string, PermissionPolicyType>>();
	for (const profile of profiles?.profiles ?? []) {
		policies.set(profile.name, new Map(Object.entries(profile.permissionPolicies ?? {})));
	}
	return policies;
}

function profilePolicyStateFromLiveState(state: LiveSessionState): ProfilePolicyState {
	return { mainProfile: state.mainProfileName, policies: new Map(state.profileToolPolicies) };
}

function resolveTools(tools: readonly FacadeToolEntry[]): ResolvedTools {
  const enabledBuiltins = new Set<string>();
  const mcpPatterns = new Set<string>();
  const policies = new Map<string, PermissionPolicyType>();
  const customTools: Array<Required<Pick<FacadeToolEntry, 'name' | 'description' | 'inputSchema'>>> = [];

  for (const entry of tools) {
    switch (entry.type) {
      case 'agent_toolset_20260401': {
        const initial = entry.enabledTools === undefined || entry.enabledTools.length === 0
          ? QODER_BUILTIN_TOOLS
          : entry.enabledTools;
        for (const name of initial) enabledBuiltins.add(name);
        for (const name of entry.disallowedTools ?? []) enabledBuiltins.delete(name);
        for (const config of entry.configs ?? []) {
          if (config.enabled === false) enabledBuiltins.delete(config.name);
          if (config.enabled === true) enabledBuiltins.add(config.name);
          if (config.permissionPolicy !== undefined) {
            policies.set(config.name, config.permissionPolicy.type);
          }
        }
        break;
      }
      case 'mcp_toolset':
        if (entry.mcpServerName === undefined) break;
        mcpPatterns.add(`mcp__${entry.mcpServerName}__*`);
        for (const config of entry.configs ?? []) {
          if (config.permissionPolicy !== undefined) {
            policies.set(`mcp__${entry.mcpServerName}__${config.name}`, config.permissionPolicy.type);
          }
        }
        break;
      case 'custom':
        if (entry.name !== undefined && entry.description !== undefined && entry.inputSchema !== undefined) {
          customTools.push({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema });
        }
        break;
      default:
        break;
    }
  }
  return {
    enabledNames: [...enabledBuiltins, ...mcpPatterns],
    policies,
    customTools,
  };
}

function withMcpToolFilters(
  servers: readonly FacadeMcpServer[],
  tools: readonly FacadeToolEntry[] | undefined,
): readonly FacadeMcpServer[] {
  const filters = new Map<string, { disabled: string[] }>();
  for (const tool of tools ?? []) {
    if (tool.type !== 'mcp_toolset' || tool.mcpServerName === undefined) continue;
    const current = filters.get(tool.mcpServerName) ?? { disabled: [] };
    for (const config of tool.configs ?? []) {
      if (config.enabled === false) current.disabled.push(config.name);
    }
    filters.set(tool.mcpServerName, current);
  }
  return servers.map((server) => {
    const filter = filters.get(server.name);
    if (filter === undefined) return server;
    return {
      ...server,
      ...(filter.disabled.length > 0 ? { disabledTools: filter.disabled } : {}),
    };
  });
}

/**
 * Runtime "no such session" discrimination. Two error shapes cross this
 * boundary: the klient `RPCError` (numeric envelope code 40401, protocol
 * `ErrorCode.SESSION_NOT_FOUND`) on the daemon path, and the core domain
 * error (`code: 'session.not_found'`) on the in-process path. The code is
 * the stable branch key across the wire, not `instanceof`.
 */
const RPC_SESSION_NOT_FOUND_CODE = 40401;
const SESSION_NOT_FOUND_DOMAIN_CODE = 'session.not_found';

function isSessionNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === RPC_SESSION_NOT_FOUND_CODE || code === SESSION_NOT_FOUND_DOMAIN_CODE;
}

function textPart(text: string): TextPromptPart {
  return { type: 'text', text };
}

// Kimi exposes tool output as an opaque runtime value. The public adapter only
// has evidence for text blocks, so it preserves strings and renders every
// serializable non-string value as compact JSON inside that one text block.
function toolResultContent(output: unknown): readonly { readonly type: 'text'; readonly text: string }[] {
  if (typeof output === 'string') return [{ type: 'text', text: output }];
  try {
    return [{ type: 'text', text: JSON.stringify(output) ?? '' }];
  } catch {
    return [{ type: 'text', text: '' }];
  }
}

/**
 * Home-dir journal probe: the directory must exist, be readable, and accept a
 * create+delete round trip (write probe). Runs synchronously per call; any
 * throw is sanitized by the caller into `runtime_unavailable`.
 */
function probeHomeDir(homeDir: string): void {
  if (!statSync(homeDir).isDirectory()) {
    throw new Error('home path is not a directory');
  }
  accessSync(homeDir, constants.R_OK);
  const probeFile = join(homeDir, `.oca-ready-probe-${randomUUID()}`);
  writeFileSync(probeFile, '');
  unlinkSync(probeFile);
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

function childToolCallKey(runtimeAgentID: string, toolCallID: string): string {
  return `${runtimeAgentID}\u0000${toolCallID}`;
}

function modelRequestKey(runtimeAgentID: string, requestID: string): string {
  return `${runtimeAgentID}\u0000${requestID}`;
}

function newFacadePublicEventID(): string {
  return `evt_${randomUUID().replaceAll('-', '')}`;
}

/**
 * First-prompt context blocks contain only the system prompt. Resources and
 * Memory instructions are added separately; Skills are discovered by
 * kimi-code from the materialized project root.
 */
function buildStaticContextBlocks(config: FacadeCreateConfig): TextPromptPart[] {
  const blocks: TextPromptPart[] = [];
  if (config.system !== undefined && config.system.trim().length > 0) {
    blocks.push(textPart(config.system));
  }
  return blocks;
}

function mergeResourcesByID(existing: readonly FacadeResource[], incoming: readonly FacadeResource[]): FacadeResource[] {
	const incomingIDs = new Set<string>();
	for (const resource of incoming) {
		if (incomingIDs.has(resource.id)) throw new FacadeError('invalid_request');
		incomingIDs.add(resource.id);
	}
	const merged = new Map(existing.map((resource) => [resource.id, resource]));
	for (const resource of incoming) merged.set(resource.id, resource);
	return [...merged.values()];
}

function buildMemoryInstructionBlocks(resources: readonly FacadeResource[]): TextPromptPart[] {
	return resources.flatMap((resource) => {
		if (resource.type !== 'memory_store' || resource.instructions === undefined || resource.instructions.trim().length === 0) {
			return [];
		}
		return [textPart(resource.instructions)];
	});
}

function buildResourceContextBlocks(resources: readonly FacadeResource[]): TextPromptPart[] {
  return resources.filter((resource) => resource.type !== 'memory_store').map((resource) => {
    const visibleResource = {
      id: resource.id,
      type: resource.type,
      ...(resource.fileId !== undefined ? { fileId: resource.fileId } : {}),
      ...(resource.mountPath !== undefined ? { mountPath: resource.mountPath } : {}),
    };
    const label = visibleResource.mountPath ?? visibleResource.fileId ?? visibleResource.id;
    return textPart(`[resource: ${label}]\n${JSON.stringify(visibleResource)}\n[/resource]`);
  });
}
