import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { pendingCallKey } from './session-registry';

import type {
  PendingCall,
  PendingCallJournal,
  PendingCallKind,
  PendingCallState,
  StagedToolResult,
  ToolResultDeliveryState,
} from './session-registry';

/**
 * Facade-owned pending-call journal: one JSON document per session, living
 * inside the session directory so it rides the same journal-bearing
 * filesystem (PVC) as the runtime journal. Writes are synchronous and
 * surface failures to the caller (registration is fail-closed: a call the
 * journal cannot hold is never tracked, so no request is emitted for it).
 * Reads throw on a corrupt journal instead of silently skipping it, so
 * recovery fails deterministically. A delivered tombstone survives a failed
 * cleanup and recovery never replays it.
 *
 * The file name and document shape are facade-internal details; only the
 * behavior is contract.
 */

const JOURNAL_FILE_NAME = 'facade-pending-calls.json';

/** Input accepted by `writePendingCall`; the state defaults to `pending`. */
export interface PendingCallWrite {
  readonly id: string;
  readonly kind: PendingCallKind;
  readonly state?: PendingCallState;
	readonly runtimeAgentId?: string;
}

/**
 * Persists one pending call, replacing any record with the same id. Throws
 * when the journal cannot be written (the fail-closed signal).
 */
export function writePendingCall(sessionDir: string, call: PendingCallWrite): void {
  const calls = readPendingCalls(sessionDir).filter(
		(stored) => pendingCallKey(stored.id, stored.runtimeAgentId) !== pendingCallKey(call.id, call.runtimeAgentId),
	);
  calls.push({ id: call.id, kind: call.kind, state: call.state ?? 'pending', ...(call.runtimeAgentId !== undefined ? { runtimeAgentId: call.runtimeAgentId } : {}) });
  writeJournal(sessionDir, calls);
}

/** Removes one settled call; a missing journal is already empty. */
export function removePendingCall(sessionDir: string, callId: string, runtimeAgentId?: string): void {
  const calls = readPendingCalls(sessionDir);
  if (calls.length === 0) return;
  writeJournal(
    sessionDir,
		calls.filter((call) => pendingCallKey(call.id, call.runtimeAgentId) !== pendingCallKey(callId, runtimeAgentId)),
  );
}

/** Retains an external call's terminal correlation without exposing it as pending. */
export function settleUnknownPendingToolCall(sessionDir: string, callId: string): void {
  const calls = readPendingCalls(sessionDir);
  const index = calls.findIndex((call) => call.id === callId && call.kind === 'external_tool');
  if (index < 0) {
    throw new TypeError('pending external tool call is missing');
  }
  const call = calls[index];
  if (call === undefined) {
    throw new TypeError('pending external tool call is missing');
  }
  calls[index] = { ...call, state: 'settled' };
  writeJournal(sessionDir, calls);
}

/** Records a validated external-tool result without removing its pending call. */
export function stagePendingToolResult(
  sessionDir: string,
  callId: string,
  result: StagedToolResult,
): void {
  const calls = readPendingCalls(sessionDir);
  const index = calls.findIndex((call) => call.id === callId && call.kind === 'external_tool');
  if (index < 0) {
    throw new TypeError('pending external tool call is missing');
  }
  const call = calls[index];
  if (call === undefined) {
    throw new TypeError('pending external tool call is missing');
  }
  calls[index] = {
    ...call,
    stagedToolResult: result,
    toolResultDeliveryState: 'staged',
  };
  writeJournal(sessionDir, calls);
}

/** Persists progress through the runtime side-effect boundary for one result. */
export function setPendingToolResultDeliveryState(
  sessionDir: string,
  callId: string,
  state: ToolResultDeliveryState,
): void {
  const calls = readPendingCalls(sessionDir);
  const index = calls.findIndex((call) => call.id === callId && call.kind === 'external_tool');
  if (index < 0 || calls[index]?.stagedToolResult === undefined) {
    throw new TypeError('staged external tool call is missing');
  }
  calls[index] = { ...calls[index], toolResultDeliveryState: state };
  writeJournal(sessionDir, calls);
}

/** Lists journaled calls: `[]` when no journal exists, throws on a corrupt one. */
export function readPendingCalls(sessionDir: string): PendingCall[] {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, JOURNAL_FILE_NAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseJournal(raw);
}

/**
 * Session-id-keyed journal over the per-session files, rooted under the
 * resolved home directory (the journal-bearing filesystem). The id is
 * base64url-encoded into the path so an arbitrary session id can never
 * escape the journal root.
 */
export function createFilePendingCallJournal(homeDir?: string): PendingCallJournal {
  const root = join(resolveKimiHome(homeDir), 'facade-pending-calls');
  const dirFor = (sessionId: string): string =>
    join(root, Buffer.from(sessionId, 'utf8').toString('base64url'));
  return {
    register: (sessionId, call) => {
      writePendingCall(dirFor(sessionId), call);
    },
    stageToolResult: (sessionId, callId, result) => {
      stagePendingToolResult(dirFor(sessionId), callId, result);
    },
    setToolResultDeliveryState: (sessionId, callId, state) => {
      setPendingToolResultDeliveryState(dirFor(sessionId), callId, state);
    },
    settleUnknownToolCall: (sessionId, callId) => {
      settleUnknownPendingToolCall(dirFor(sessionId), callId);
    },
    settle: (sessionId, callId, runtimeAgentId) => {
      removePendingCall(dirFor(sessionId), callId, runtimeAgentId);
    },
    read: (sessionId) => readPendingCalls(dirFor(sessionId)),
  };
}

function writeJournal(sessionDir: string, calls: PendingCall[]): void {
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, JOURNAL_FILE_NAME);
  // Write-then-rename: a crash mid-write never leaves a torn journal behind.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(calls)}\n`, 'utf8');
  renameSync(tmp, file);
}

function parseJournal(raw: string): PendingCall[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new TypeError('pending-call journal is not a JSON array');
  }
  return parsed.map((entry) => {
    const call = entry as Partial<PendingCall> | null;
    if (typeof call?.id !== 'string' || !isPendingCallKind(call.kind)) {
      throw new TypeError('pending-call journal entry is malformed');
    }
    const stagedToolResult = parseStagedToolResult(call.stagedToolResult);
    const toolResultDeliveryState = parseToolResultDeliveryState(call.toolResultDeliveryState);
    if (toolResultDeliveryState !== undefined && stagedToolResult === undefined) {
      throw new TypeError('pending-call journal delivery state has no tool result');
    }
    return {
      id: call.id,
      kind: call.kind,
      state: call.state === 'unknown' || call.state === 'settled' ? call.state : 'pending',
			...(typeof call.runtimeAgentId === 'string' ? { runtimeAgentId: call.runtimeAgentId } : {}),
      ...(stagedToolResult !== undefined ? { stagedToolResult } : {}),
      ...(stagedToolResult !== undefined
        ? { toolResultDeliveryState: toolResultDeliveryState ?? 'staged' }
        : {}),
    };
  });
}

function parseStagedToolResult(value: unknown): StagedToolResult | undefined {
  if (value === undefined) return undefined;
  const result = value as Partial<StagedToolResult> | null;
  if (
    result === null ||
    !isToolResolution(result.resolution) ||
    (result.output !== undefined && typeof result.output !== 'string') ||
    (result.systemMessage !== undefined && typeof result.systemMessage !== 'string')
  ) {
    throw new TypeError('pending-call journal tool result is malformed');
  }
  return {
    resolution: result.resolution,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
  };
}

function isPendingCallKind(kind: unknown): kind is PendingCallKind {
  return kind === 'approval' || kind === 'question' || kind === 'external_tool';
}

function isToolResolution(value: unknown): value is StagedToolResult['resolution'] {
  return value === 'completed' || value === 'failed' || value === 'skipped';
}

function parseToolResultDeliveryState(value: unknown): ToolResultDeliveryState | undefined {
  if (value === undefined) return undefined;
  if (value === 'staged' || value === 'delivering' || value === 'delivered') return value;
  throw new TypeError('pending-call journal delivery state is malformed');
}
