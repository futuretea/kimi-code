import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FacadeError, type FacadeErrorCode } from '../src/errors';
import {
  readPendingCalls,
  removePendingCall,
  writePendingCall,
} from '../src/pending-journal';
import {
  SessionRegistry,
  type PendingCall,
  type PendingCallJournal,
} from '../src/session-registry';

/**
 * Recovery slice (T2): the facade-owned pending-call journal.
 *
 * File primitives (`src/pending-journal.ts`, keyed by sessionDir — the file
 * name/JSON format is an internal detail, only the behavior is pinned here):
 * - writePendingCall: synchronous, throws on failure (the fail-closed signal)
 * - removePendingCall: deletes one entry
 * - readPendingCalls: lists entries; throws on a corrupted journal
 *
 * Registry integration (`PendingCallJournal`, keyed by sessionId): register
 * persists first and is fail-closed (`internal_error`, no call tracked, so no
 * request event can follow), settle removes (tolerated failures), and
 * recovery rebuilds pending calls from the journal with approvals/questions
 * auto-skipped and external tools kept `unknown`.
 */

function expectFacadeError(fn: () => unknown, code: FacadeErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FacadeError);
    expect((error as FacadeError).code).toBe(code);
    return;
  }
  throw new Error(`expected FacadeError ${code}, but no error was thrown`);
}

async function expectAsyncFacadeError(
  fn: () => Promise<unknown>,
  code: FacadeErrorCode,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FacadeError);
    expect((error as FacadeError).code).toBe(code);
    return;
  }
  throw new Error(`expected FacadeError ${code}, but no error was thrown`);
}

const tempDirs: string[] = [];

async function makeSessionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oca-facade-journal-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/** Locates the journal file the module wrote inside sessionDir. */
async function journalFiles(sessionDir: string): Promise<string[]> {
  const entries = await readdir(sessionDir);
  const journal = entries.filter((name) => name.includes('pending'));
  return journal.length > 0 ? journal : entries.filter((name) => !name.endsWith('.tmp'));
}

describe('pending-call journal file primitives', () => {
  it('persists a registered call and reads it back', async () => {
    const dir = await makeSessionDir();
    writePendingCall(dir, { id: 'call_1', kind: 'external_tool' });
    const calls = readPendingCalls(dir);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'call_1', kind: 'external_tool' });
    // The write is durably on disk inside the session directory.
    expect(await journalFiles(dir)).not.toHaveLength(0);
  });

  it('reads an empty list when the journal does not exist', async () => {
    const dir = await makeSessionDir();
    expect(readPendingCalls(dir)).toEqual([]);
  });

  it('fails the write when the session directory is not writable (fail-closed signal)', async () => {
    const dir = await makeSessionDir();
    const notADir = join(dir, 'session-file');
    await writeFile(notADir, 'occupied');
    expect(() => writePendingCall(notADir, { id: 'call_1', kind: 'approval' })).toThrow();
  });

  it('removes only the settled call', async () => {
    const dir = await makeSessionDir();
    writePendingCall(dir, { id: 'call_1', kind: 'approval' });
    writePendingCall(dir, { id: 'call_2', kind: 'external_tool' });
    removePendingCall(dir, 'call_1');
    expect(readPendingCalls(dir)).toEqual([
      expect.objectContaining({ id: 'call_2', kind: 'external_tool' }),
    ]);
  });

  it('throws on a corrupted journal instead of silently skipping it', async () => {
    const dir = await makeSessionDir();
    writePendingCall(dir, { id: 'call_1', kind: 'external_tool' });
    const files = await journalFiles(dir);
    expect(files).not.toHaveLength(0);
    await writeFile(join(dir, files[0] as string), 'not-json{corrupted');
    expect(() => readPendingCalls(dir)).toThrow();
  });
});

/** In-memory PendingCallJournal double with failure switches. */
class SpyPendingJournal implements PendingCallJournal {
  readonly registered: Array<{ sessionId: string; call: PendingCall }> = [];
  readonly settled: Array<{ sessionId: string; callId: string }> = [];
  private readonly store = new Map<string, PendingCall[]>();
  failRegister = false;
  failSettle = false;
  failRead = false;

  seed(sessionId: string, calls: PendingCall[]): void {
    this.store.set(sessionId, calls.map((call) => ({ ...call })));
  }

  register(sessionId: string, call: PendingCall): void {
    if (this.failRegister) throw new Error('disk full');
    this.registered.push({ sessionId, call: { ...call } });
    const calls = this.store.get(sessionId) ?? [];
    calls.push({ ...call });
    this.store.set(sessionId, calls);
  }

  settle(sessionId: string, callId: string): void {
    if (this.failSettle) throw new Error('disk busy');
    this.settled.push({ sessionId, callId });
    const calls = (this.store.get(sessionId) ?? []).filter((call) => call.id !== callId);
    this.store.set(sessionId, calls);
  }

  read(sessionId: string): PendingCall[] {
    if (this.failRead) throw new Error('journal corrupted');
    return (this.store.get(sessionId) ?? []).map((call) => ({ ...call }));
  }
}

describe('registry pending-call journal integration', () => {
  it('persists the call to the journal when registering it', () => {
    const journal = new SpyPendingJournal();
    const registry = new SessionRegistry({ pendingJournal: journal });
    registry.createSession('ses_1');
    registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'approval' });
    expect(journal.registered).toEqual([
      { sessionId: 'ses_1', call: { id: 'call_1', kind: 'approval', state: 'pending' } },
    ]);
  });

  it('fails closed (internal_error) when the journal write fails and does not track the call', () => {
    const journal = new SpyPendingJournal();
    journal.failRegister = true;
    const registry = new SessionRegistry({ pendingJournal: journal });
    registry.createSession('ses_1');
    expectFacadeError(
      () => registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'approval' }),
      'internal_error',
    );
    // No untracked pending call may survive: it would hang without a record.
    expect(registry.listPendingCalls('ses_1')).toEqual([]);
  });

  it('removes the journal entry when the call settles', () => {
    const journal = new SpyPendingJournal();
    const registry = new SessionRegistry({ pendingJournal: journal });
    registry.createSession('ses_1');
    registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'approval' });
    expect(
      registry.resolveApproval('ses_1', { toolCallId: 'call_1', decision: 'approved' }),
    ).toEqual({ accepted: true });
    expect(journal.settled).toEqual([{ sessionId: 'ses_1', callId: 'call_1' }]);
    expect(journal.read('ses_1')).toEqual([]);
  });

  it('tolerates a journal delete failure on settle (the crash window closes at recovery)', () => {
    const journal = new SpyPendingJournal();
    const registry = new SessionRegistry({ pendingJournal: journal });
    registry.createSession('ses_1');
    registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'external_tool' });
    journal.failSettle = true;
    expect(
      registry.resolveToolResult('ses_1', { toolCallId: 'call_1', resolution: 'skipped' }),
    ).toEqual({ accepted: true });
    expect(registry.listPendingCalls('ses_1')).toEqual([]);
  });

  it('rebuilds pending calls from the journal on recovery: approvals/questions auto-skipped, external unknown', async () => {
    const journal = new SpyPendingJournal();
    journal.seed('ses_1', [
      { id: 'call_appr', kind: 'approval', state: 'pending' },
      { id: 'q_1', kind: 'question', state: 'pending' },
      { id: 'call_ext', kind: 'external_tool', state: 'pending' },
    ]);
    const registry = new SessionRegistry({
      pendingJournal: journal,
      recoverFromJournal: async () => ({ pendingCalls: [] }),
    });
    // Journal-only session: the registry itself never saw it (process restart).
    const result = await registry.resumeSession('ses_1');
    expect(result.status).toBe('active');
    // Approvals and questions are auto-skipped (dead-turn no-op), so they are
    // NOT reported; the external tool call stays unknown for the user to skip.
    expect(result.pendingCalls).toEqual([{ id: 'call_ext', kind: 'external_tool', state: 'unknown' }]);
  });

  it('surfaces a corrupted journal as session_resume_failed on recovery', async () => {
    const journal = new SpyPendingJournal();
    journal.failRead = true;
    const registry = new SessionRegistry({
      pendingJournal: journal,
      recoverFromJournal: async () => ({ pendingCalls: [] }),
    });
    await expectAsyncFacadeError(() => registry.resumeSession('ses_1'), 'session_resume_failed');
    expect(registry.getSession('ses_1')).toBeUndefined();
  });
});
