import type { JsonObject } from '@moonshot-ai/kimi-code-sdk';

import type { StopReason } from './session-registry';

/**
 * Neutral facade vocabulary shared by the harness, the routes layer, and
 * tests: the create-session config bound at `POST /sessions`, and the facade
 * event schema (public-aligned events plus control events that never reach
 * the public flow). Field names on events follow the wire schema.
 */

// ---------------------------------------------------------------------------
// Create config (bound at session create; mirrors the facade create schema).
// ---------------------------------------------------------------------------

export type PermissionPolicyType = 'always_allow' | 'always_ask' | 'always_deny';

export interface ToolPermissionPolicy {
  readonly type: PermissionPolicyType;
}

export interface FacadeToolConfig {
  readonly name: string;
  readonly enabled?: boolean;
  readonly permissionPolicy?: ToolPermissionPolicy;
}

/** Built-in toolset entry, mirroring the OCA agent toolset shape. */
export interface FacadeToolset {
  readonly type: string;
  readonly enabledTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly configs?: readonly FacadeToolConfig[];
  readonly mcpServerName?: string;
  readonly name?: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export type FacadeToolEntry = FacadeToolset;

/** External tool server reference, mirroring the OCA MCP server shape. */
export interface FacadeMcpServer {
  readonly type: string;
  readonly name: string;
  readonly url: string;
  readonly enabledTools?: readonly string[];
  readonly disabledTools?: readonly string[];
}

/** Session resource reference, mirroring the OCA session resource shape. */
export interface FacadeResource {
  readonly id: string;
	readonly type: string;
	readonly fileId?: string;
	/** Repository source URL for a GitHub resource. */
	readonly url?: string;
  readonly mountPath?: string;
  /** Canonical target within the shared workspace PVC. */
  readonly pvcPath?: string;
  /** Short-lived internal URL used only to materialize a File before startup. */
  readonly downloadUrl?: string;
	/** Exact object size used to detect incomplete or substituted downloads. */
	readonly size?: number;
	/** Write-only GitHub token used by the repository materializer. */
	readonly authorizationToken?: string;
	/** Optional Git checkout target preserved from the public resource union. */
	readonly checkout?: FacadeGitHubCheckout;
	/** Memory Store identity used only by the facade materializer. */
	readonly memoryStoreId?: string;
	/** Omitted access uses the runtime's read-write default. */
	readonly access?: 'read_only' | 'read_write';
	/** Session-local instruction text associated with a Memory Store resource. */
	readonly instructions?: string;
	readonly memoryEntries?: readonly FacadeMemoryEntry[];
}

export interface FacadeGitHubCheckout {
	readonly type: 'branch';
	readonly name: string;
}

export interface FacadeMemoryEntry {
	readonly id: string;
	readonly path: string;
	readonly content: string;
	/** Hash of the entry content when it was loaded from the Memory Store. */
	readonly contentSha256: string;
}

/** Current sandbox state compared with the Memory Store version mounted for a turn. */
export interface FacadeMemorySnapshotEntry {
	readonly id: string;
	readonly path: string;
	readonly contentSha256: string;
	readonly deleted: boolean;
	readonly content?: string;
}

export interface FacadeMemorySnapshotResource {
	readonly resourceId: string;
	readonly memoryStoreId: string;
	readonly entries: readonly FacadeMemorySnapshotEntry[];
}

/** Persisted Memory Store state acknowledged by the orchestrator after write-back. */
export interface FacadeMemorySyncResource {
	readonly resourceId: string;
	readonly memoryStoreId: string;
	readonly entries: readonly FacadeMemoryEntry[];
}

export type FacadeSkillOrigin = 'managed' | 'forward';

export interface FacadeSkillRef {
  readonly id: string;
  readonly name: string;
  /** Canonical decimal Skill Version string. */
  readonly version: string;
	/** Internal control-plane surface that determines the accepted package bounds. */
	readonly origin: FacadeSkillOrigin;
  /** Exact ZIP byte size as persisted by the control plane. */
  readonly contentSize: number;
  /** Lower-case SHA-256 of the exact ZIP bytes. */
  readonly contentSHA256: string;
}

/** Process-local staged archive paired by index with `FacadeCreateConfig.skills`. */
export interface FacadeSkillArchive {
  readonly path: string;
}

/**
 * OCA's constrained input for a persisted kimi-code agent profile. The
 * facade deliberately does not expose file-backed prompts, inheritance, or
 * arbitrary template variables: its caller compiles immutable Agent
 * snapshots into complete prompt text before creating the runtime Session.
 */
export interface FacadeAgentProfile {
  readonly name: string;
  readonly description?: string;
  readonly systemPromptTemplate?: string;
  readonly tools?: readonly string[];
	/** Per-tool policy selected by this immutable profile. */
	readonly permissionPolicies?: Readonly<Record<string, PermissionPolicyType>>;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly contextWindow?: number;
  readonly whenToUse?: string;
  readonly subagents?: Readonly<Record<string, { readonly description?: string }>>;
}

/** Immutable session-local registry used for managed coordinator profiles. */
export interface FacadeAgentProfiles {
  readonly mainProfile: string;
  readonly profiles: readonly FacadeAgentProfile[];
  /** Maximum runtime agents, including the coordinator. */
  readonly maxAgents?: number;
}

export interface FacadeCreateConfig {
  readonly sessionId: string;
  readonly workDir: string;
  readonly system?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly contextWindow?: number;
  readonly planMode?: boolean;
  readonly metadata?: JsonObject;
  readonly tools?: readonly FacadeToolEntry[];
  readonly mcpServers?: readonly FacadeMcpServer[];
  readonly resources?: readonly FacadeResource[];
  readonly skills?: readonly FacadeSkillRef[];
  /** Never serialized into the runtime journal or public response. */
  readonly skillArchives?: readonly FacadeSkillArchive[];
  readonly additionalDirs?: readonly string[];
  readonly agentProfiles?: FacadeAgentProfiles;
	/** Exact public Session-owned process environment snapshot. */
	readonly sessionEnvironmentVariables?: Readonly<Record<string, string>>;
	/** Trusted Vault environment snapshot, held only in the facade process. */
	readonly vaultEnvironmentVariables?: Readonly<Record<string, string>>;
}

/** Mutable runtime configuration with replacement semantics per present field. */
export interface FacadeSessionConfig {
  readonly tools?: readonly FacadeToolEntry[];
  readonly mcpServers?: readonly FacadeMcpServer[];
  /** Ephemeral server URL to token map supplied only by the trusted orchestrator. */
  readonly mcpCredentials?: Readonly<Record<string, string>>;
	/** Exact replacement of public Session-owned process environment variables. */
	readonly sessionEnvironmentVariables?: Readonly<Record<string, string>>;
	/** Exact replacement of Vault-owned process environment variables. */
	readonly vaultEnvironmentVariables?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Facade events (wire vocabulary; control events never reach the public flow).
// ---------------------------------------------------------------------------

export interface FacadeQuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface FacadeQuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly options: readonly FacadeQuestionOption[];
  readonly multi_select?: boolean;
}

export type EvaluatedPermission = 'allow' | 'ask' | 'deny';

/** The only Tool Result content form backed by the current runtime adapter. */
type FacadeToolResultTextBlock = { readonly type: 'text'; readonly text: string };

type FacadeEventPayload =
  | { readonly type: 'agent.message'; readonly content: string }
  | { readonly type: 'agent.thinking'; readonly content: string }
  // Minimal user-approved projection of Kimi compaction.completed. The
  // runtime result is private until Qoder documents type-specific fields.
  | { readonly type: 'agent.thread_context_compacted' }
  | {
      readonly type: 'agent.tool_use';
      readonly id: string;
      readonly name: string;
      readonly arguments?: unknown;
      readonly evaluated_permission: EvaluatedPermission;
    }
  | {
      readonly type: 'agent.tool_result';
      readonly id: string;
      readonly content: readonly FacadeToolResultTextBlock[];
      readonly is_error: boolean;
    }
  | {
      readonly type: 'agent.mcp_tool_use';
      readonly id: string;
      readonly server_name: string;
      readonly tool_name: string;
      readonly arguments?: unknown;
      readonly evaluated_permission: EvaluatedPermission;
    }
  | {
      readonly type: 'agent.mcp_tool_result';
      readonly id: string;
      readonly content: readonly FacadeToolResultTextBlock[];
      readonly is_error: boolean;
    }
  // No current fork protocol event maps to this type. The public field names
  // are documented, but their per-field JSON types and a runtime producer are
  // not; preserve values without narrowing them until both are available.
  | {
      readonly type: 'agent.artifact_delivered';
      readonly file_id?: unknown;
      readonly original_filename?: unknown;
      readonly size?: unknown;
      readonly content_type?: unknown;
    }
  // public_id is carried only until the orchestrator assigns it to the
  // persisted public Event; it never remains inside the public payload.
  | { readonly type: 'span.model_request_start'; readonly public_id: string }
  | {
      readonly type: 'span.model_request_end';
      readonly model_request_start_id: string;
      readonly is_error: boolean;
    }
  | { readonly type: 'session.status_running' }
  | { readonly type: 'session.status_idle' }
  | { readonly type: 'session.error'; readonly message: string; readonly code: string }
  | {
      readonly type: 'approval_request';
      readonly tool_call_id: string;
      readonly tool_name: string;
			/** Internal routing identity for a child Agent; never public output. */
			readonly runtime_agent_id?: string;
			readonly server_name?: string;
			readonly arguments?: unknown;
      readonly action: string;
      readonly display: unknown;
    }
  | {
      readonly type: 'question_request';
      readonly question_id: string;
      readonly questions: readonly FacadeQuestionItem[];
    }
  | {
      readonly type: 'external_tool_request';
      readonly tool_call_id: string;
      readonly name: string;
      readonly arguments?: unknown;
    }
  // Subagent frames are internal facade protocol messages. The orchestrator
  // resolves runtime_agent_id to a persistent Session Thread. Thinking carries
  // only a marker; raw reasoning and child errors remain local.
  | {
      readonly type: 'subagent.spawned';
      readonly runtime_agent_id: string;
      readonly profile_name: string;
    }
  | { readonly type: 'subagent.started'; readonly runtime_agent_id: string }
  | { readonly type: 'subagent.message'; readonly runtime_agent_id: string; readonly content: string }
  | { readonly type: 'subagent.thinking'; readonly runtime_agent_id: string }
  | { readonly type: 'subagent.thread_context_compacted'; readonly runtime_agent_id: string }
  | {
      readonly type: 'subagent.tool_use';
      readonly runtime_agent_id: string;
      readonly id: string;
      readonly name: string;
      readonly arguments?: unknown;
      readonly evaluated_permission: EvaluatedPermission;
    }
  | {
      readonly type: 'subagent.tool_result';
      readonly runtime_agent_id: string;
      readonly id: string;
      readonly content: readonly FacadeToolResultTextBlock[];
      readonly is_error: boolean;
    }
  | {
      readonly type: 'subagent.mcp_tool_use';
      readonly runtime_agent_id: string;
      readonly id: string;
      readonly server_name: string;
      readonly tool_name: string;
      readonly arguments?: unknown;
      readonly evaluated_permission: EvaluatedPermission;
    }
  | {
      readonly type: 'subagent.mcp_tool_result';
      readonly runtime_agent_id: string;
      readonly id: string;
      readonly content: readonly FacadeToolResultTextBlock[];
      readonly is_error: boolean;
    }
  | {
      readonly type: 'subagent.model_request_start';
      readonly runtime_agent_id: string;
      readonly public_id: string;
    }
  | {
      readonly type: 'subagent.model_request_end';
      readonly runtime_agent_id: string;
      readonly model_request_start_id: string;
      readonly is_error: boolean;
    }
  | { readonly type: 'subagent.completed'; readonly runtime_agent_id: string }
  | { readonly type: 'subagent.failed'; readonly runtime_agent_id: string }
  | { readonly type: 'subagent.suspended'; readonly runtime_agent_id: string };

// frame_id is assigned by the EventPump immediately before one runtime event
// is emitted to both the live SSE and inline prompt streams. It is internal to
// the facade protocol and lets the orchestrator distinguish a duplicate
// delivery from two adjacent, textually identical deltas.
export type FacadeEvent = FacadeEventPayload & { readonly frame_id?: string };

/** Consumer of bridged facade events; the registry event pump implements it. */
export interface HarnessEventSink {
  emit(sessionId: string, event: FacadeEvent): void;
  /** The runtime ended the current turn; the reason is already facade-aligned. */
  turnEnded(sessionId: string, stopReason: StopReason): void;
}
