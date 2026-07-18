import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import type {
  PendingCall,
  PendingCallJournal,
  PendingCallKind,
  PendingCallState,
} from './session-registry';

/**
 * Facade-owned pending-call journal: one JSON document per session, living
 * inside the session directory so it rides the same journal-bearing
 * filesystem (PVC) as the runtime journal. Writes are synchronous and
 * surface failures to the caller (registration is fail-closed: a call the
 * journal cannot hold is never tracked, so no request is emitted for it).
 * Reads throw on a corrupt journal instead of silently skipping it, so
 * recovery fails deterministically. Settlement deletes tolerate failures at
 * the caller: a lingering record is recovered as `unknown` / auto-skipped.
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
}

/**
 * Persists one pending call, replacing any record with the same id. Throws
 * when the journal cannot be written (the fail-closed signal).
 */
export function writePendingCall(sessionDir: string, call: PendingCallWrite): void {
  const calls = readPendingCalls(sessionDir).filter((stored) => stored.id !== call.id);
  calls.push({ id: call.id, kind: call.kind, state: call.state ?? 'pending' });
  writeJournal(sessionDir, calls);
}

/** Removes one settled call; a missing journal is already empty. */
export function removePendingCall(sessionDir: string, callId: string): void {
  const calls = readPendingCalls(sessionDir);
  if (calls.length === 0) return;
  writeJournal(
    sessionDir,
    calls.filter((call) => call.id !== callId),
  );
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
    settle: (sessionId, callId) => {
      removePendingCall(dirFor(sessionId), callId);
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
    return {
      id: call.id,
      kind: call.kind,
      state: call.state === 'unknown' ? 'unknown' : 'pending',
    };
  });
}

function isPendingCallKind(kind: unknown): kind is PendingCallKind {
  return kind === 'approval' || kind === 'question' || kind === 'external_tool';
}
