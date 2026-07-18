import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FacadeError, type FacadeErrorCode } from '../src/errors';
import { SessionRegistry } from '../src/session-registry';

import { RPC_SESSION_NOT_FOUND, rpcError, runtimeEvent } from './fake-harness';
import {
  asFrame,
  bootTestServer,
  expectErrorEnvelope,
  nextNdjsonFrame,
  postJson,
  postStream,
} from './http-helper';

/**
 * Recovery slice (T1): `POST /sessions/{id}/resume` lazily falls back to the
 * journal when the id is missing from the in-memory registry (facade process
 * restarted; the PVC-backed journal survives). Three outcomes:
 * - journal hit  -> 200 active with pending_calls rebuilt from the journal
 * - journal miss -> 404 session_not_found (RPC session.not_found at the hook)
 * - read failure -> 500 session_resume_failed (neutral message)
 */

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

describe('resume fallback to the journal (registry miss)', () => {
  it('recovers a journal-only session through the recovery hook with reconstructed pending calls', async () => {
    const registry = new SessionRegistry({
      recoverFromJournal: async (sessionId) => {
        expect(sessionId).toBe('ses_journal');
        return {
          pendingCalls: [{ id: 'call_ext', kind: 'external_tool', state: 'unknown' }],
        };
      },
    });
    // ses_journal is NOT in the in-memory registry (the process restarted).
    const result = await registry.resumeSession('ses_journal');
    expect(result).toEqual({
      sessionId: 'ses_journal',
      status: 'active',
      pendingCalls: [{ id: 'call_ext', kind: 'external_tool', state: 'unknown' }],
    });
    expect(registry.getSession('ses_journal')?.status).toBe('active');
  });

  it('keeps session_not_found when the journal has no such session', async () => {
    const registry = new SessionRegistry({
      recoverFromJournal: async () => {
        // The hook layer maps the fork session-store miss (RPC
        // session.not_found) to this facade code; the registry must surface
        // it unchanged instead of sanitizing it into a resume failure.
        throw new FacadeError('session_not_found');
      },
    });
    await expectAsyncFacadeError(() => registry.resumeSession('ses_ghost'), 'session_not_found');
    expect(registry.getSession('ses_ghost')).toBeUndefined();
  });

  it('maps a journal read failure to session_resume_failed with a neutral message', async () => {
    const registry = new SessionRegistry({
      recoverFromJournal: async () => {
        throw new Error('wire journal corrupt at /secret/path');
      },
    });
    try {
      await registry.resumeSession('ses_broken');
      throw new Error('expected resume to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FacadeError);
      expect((error as FacadeError).code).toBe('session_resume_failed');
      // Raw journal errors stay in internal logs; the caller sees neutral copy.
      expect((error as FacadeError).message).not.toContain('/secret/path');
    }
    // A failed fallback leaves no half-constructed entry behind.
    expect(registry.getSession('ses_broken')).toBeUndefined();
  });

  it('accepts a same-key prompt as a new execution after the fallback (D6)', async () => {
    const registry = new SessionRegistry({
      recoverFromJournal: async () => ({ pendingCalls: [] }),
    });
    await registry.resumeSession('ses_journal');
    // The crashed process died mid-turn holding key-1; the recovered session
    // must not replay a first terminal frame for it (no extended idempotency
    // window), so the same key starts a fresh execution.
    expect(registry.startPrompt('ses_journal', { content: 'redo', idempotencyKey: 'key-1' })).toEqual({
      status: 'started',
    });
  });
});

describe('POST /sessions/{id}/resume journal fallback', () => {
  it('recovers a journal-only session (200 active) with external calls reported unknown', async () => {
    // Process A: run a turn that blocks on an external tool call so the
    // pending-call journal holds the call, then "crash" (server stops; the
    // in-memory registry is lost, the journal on the shared home survives).
    const homeDir = await mkdtemp(join(tmpdir(), 'oca-facade-recovery-'));
    const a = await bootTestServer({ homeDir });
    a.fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.call.started', toolCallId: 'call_ext', name: 'query_billing', args: {} }),
      },
      { kind: 'tool_call', request: { toolCallId: 'call_ext', args: {} } },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
    ]);
    const created = await postJson(a.baseUrl, '/sessions', { session_id: 'ses_1', work_dir: homeDir });
    expect(created.status).toBe(201);
    const stream = await postStream(a.baseUrl, '/sessions/ses_1/prompt', { content: 'go' });
    for (;;) {
      const frame = asFrame(await nextNdjsonFrame(stream.reader));
      // Registration (and the journal write) precede the request event.
      if (frame.type === 'external_tool_request') break;
    }
    stream.reader.close();
    await a.server.close();

    // Process B: a fresh registry on the same home (the PVC remounted).
    const b = await bootTestServer({ homeDir });
    try {
      const res = await postJson(b.baseUrl, '/sessions/ses_1/resume', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        session_id: 'ses_1',
        status: 'active',
        pending_calls: [{ tool_call_id: 'call_ext', kind: 'external_tool', state: 'unknown' }],
      });
      // The runtime session is re-attached through the harness resume path.
      expect(b.fake.resumed).toEqual([{ id: 'ses_1' }]);
    } finally {
      await b.close();
    }
  });

  it('returns 404 session_not_found when neither the registry nor the journal has the session', async () => {
    const handle = await bootTestServer();
    try {
      // The fork session-store miss surfaces from the harness as an RPC
      // session.not_found; the hook maps it to the 404 contract code.
      handle.fake.resumeErrors.set('ses_ghost', rpcError(RPC_SESSION_NOT_FOUND, 'session ses_ghost not found'));
      const res = await postJson(handle.baseUrl, '/sessions/ses_ghost/resume', {});
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'session_not_found');
    } finally {
      await handle.close();
    }
  });

  it('returns 500 session_resume_failed with a neutral message when the journal cannot be read', async () => {
    const handle = await bootTestServer();
    try {
      handle.fake.resumeErrors.set('ses_broken', new Error('wire journal corrupt at /secret/path'));
      const res = await postJson(handle.baseUrl, '/sessions/ses_broken/resume', {});
      expect(res.status).toBe(500);
      const envelope = expectErrorEnvelope(res.body, 'session_resume_failed');
      expect(envelope.error.message).not.toContain('/secret/path');
    } finally {
      await handle.close();
    }
  });
});
