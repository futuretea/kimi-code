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

export type PermissionPolicy = 'always_allow' | 'always_ask' | 'always_deny';

/** Built-in toolset entry, mirroring the OCA agent toolset shape. */
export interface FacadeToolset {
  readonly type: string;
  readonly enabledTools?: readonly string[];
  readonly permissionPolicy?: string;
}

/**
 * Host-registered (external) tool definition: the runtime exposes it to the
 * agent like any other tool and reverse-calls the facade when it is invoked.
 */
export interface ExternalToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export type FacadeToolEntry = FacadeToolset | ExternalToolDefinition;

/** Toolsets carry `type`; external definitions carry `name` + `parameters`. */
export function isExternalToolDefinition(entry: FacadeToolEntry): entry is ExternalToolDefinition {
  return 'name' in entry && 'parameters' in entry;
}

/** External tool server reference, mirroring the OCA MCP server shape. */
export interface FacadeMcpServer {
  readonly type: string;
  readonly name: string;
  readonly url: string;
}

/** Session resource reference, mirroring the OCA session resource shape. */
export interface FacadeResource {
  readonly id: string;
  readonly type: string;
  readonly fileId?: string;
  readonly path?: string;
  readonly url?: string;
  readonly mountPath?: string;
}

export interface FacadeMemoryEntry {
  readonly path: string;
  readonly content: string;
}

export interface FacadeSkillRef {
  readonly id: string;
  readonly name?: string;
  readonly version?: number;
}

export interface FacadeCreateConfig {
  readonly sessionId: string;
  readonly workDir: string;
  readonly system?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly permissionPolicy?: PermissionPolicy;
  readonly planMode?: boolean;
  readonly metadata?: JsonObject;
  readonly tools?: readonly FacadeToolEntry[];
  readonly mcpServers?: readonly FacadeMcpServer[];
  readonly resources?: readonly FacadeResource[];
  readonly memoryStoreEntries?: readonly FacadeMemoryEntry[];
  readonly skills?: readonly FacadeSkillRef[];
  readonly additionalDirs?: readonly string[];
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

export type FacadeEvent =
  | { readonly type: 'agent.message'; readonly content: string }
  | { readonly type: 'agent.thinking'; readonly content: string }
  | {
      readonly type: 'agent.tool_use';
      readonly id: string;
      readonly name: string;
      readonly arguments?: unknown;
    }
  | {
      readonly type: 'agent.tool_result';
      readonly id: string;
      readonly output?: unknown;
      readonly is_error?: boolean;
    }
  | {
      readonly type: 'agent.mcp_tool_use';
      readonly id: string;
      readonly server_name: string;
      readonly tool_name: string;
      readonly arguments?: unknown;
    }
  | {
      readonly type: 'agent.mcp_tool_result';
      readonly id: string;
      readonly output?: unknown;
      readonly is_error?: boolean;
    }
  | { readonly type: 'session.status_running' }
  | { readonly type: 'session.status_idle' }
  | { readonly type: 'session.error'; readonly message: string; readonly code: string }
  | {
      readonly type: 'approval_request';
      readonly tool_call_id: string;
      readonly tool_name: string;
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
    };

/** Consumer of bridged facade events; the registry event pump implements it. */
export interface HarnessEventSink {
  emit(sessionId: string, event: FacadeEvent): void;
  /** The runtime ended the current turn; the reason is already facade-aligned. */
  turnEnded(sessionId: string, stopReason: StopReason): void;
}
