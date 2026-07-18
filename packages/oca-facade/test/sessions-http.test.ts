import { afterEach, describe, expect, it } from 'vitest';

import type { HarnessFactory, HarnessSessionFactory } from '../src/harness';

import {
  createFakeHarness,
  RPC_SESSION_NOT_FOUND,
  rpcError,
  runtimeEvent,
  type FakeHarness,
} from './fake-harness';
import {
  bootTestServer,
  collectNdjson,
  expectErrorEnvelope,
  nextNdjsonFrame,
  asFrame,
  postJson,
  postStream,
  type TestServerHandle,
} from './http-helper';

/** Harness factory whose create call rejects for `failingId` with a raw error. */
function failingCreateHarness(
  failingId: string,
  rawMessage: string,
): { factory: HarnessFactory; fake: FakeHarness } {
  const { fake, createHarness } = createFakeHarness();
  const factory: HarnessFactory = (options) => {
    const inner: HarnessSessionFactory = createHarness(options);
    return {
      createSession: (createOptions) =>
        createOptions.id === failingId
          ? Promise.reject(new Error(rawMessage))
          : inner.createSession(createOptions),
      resumeSession: (input) => inner.resumeSession(input),
    };
  };
  return { factory, fake };
}

describe('session routes', () => {
  let handle: TestServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  function base(): string {
    if (handle === undefined) throw new Error('test server not booted');
    return handle.baseUrl;
  }

  function fake(): FakeHarness {
    if (handle === undefined) throw new Error('test server not booted');
    return handle.fake;
  }

  function workDir(): string {
    if (handle === undefined) throw new Error('test server not booted');
    return handle.homeDir;
  }

  async function createSession(sessionId = 'ses_1'): Promise<void> {
    const res = await postJson(base(), '/sessions', { session_id: sessionId, work_dir: workDir() });
    expect(res.status).toBe(201);
  }

  describe('POST /sessions', () => {
    it('creates a session (201) with the contract response shape', async () => {
      handle = await bootTestServer();
      const res = await postJson(base(), '/sessions', {
        session_id: 'ses_1',
        work_dir: workDir(),
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ session_id: 'ses_1', status: 'active' });
    });

    it('rejects a missing session_id or work_dir (400 invalid_request)', async () => {
      handle = await bootTestServer();
      const missingWorkDir = await postJson(base(), '/sessions', { session_id: 'ses_1' });
      expect(missingWorkDir.status).toBe(400);
      expectErrorEnvelope(missingWorkDir.body, 'invalid_request');
      const missingId = await postJson(base(), '/sessions', { work_dir: workDir() });
      expect(missingId.status).toBe(400);
      expectErrorEnvelope(missingId.body, 'invalid_request');
      const badPolicy = await postJson(base(), '/sessions', {
        session_id: 'ses_1',
        work_dir: workDir(),
        permission_policy: 'sometimes',
      });
      expect(badPolicy.status).toBe(400);
      expectErrorEnvelope(badPolicy.body, 'invalid_request');
    });

    it('binds the create configuration and applies it to the runtime session', async () => {
      handle = await bootTestServer();
      fake().setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
      ]);
      const res = await postJson(base(), '/sessions', {
        session_id: 'ses_1',
        work_dir: workDir(),
        system: 'You are a coding agent.',
        model: 'model-x',
        thinking: 'high',
        permission_policy: 'always_ask',
        plan_mode: true,
        metadata: { tenant: 't-1' },
        tools: [
          { type: 'builtin', enabled_tools: ['Read', 'Glob'], permission_policy: 'always_allow' },
          { name: 'query_billing', description: 'Query billing', parameters: { type: 'object' } },
        ],
        mcp_servers: [{ type: 'http', name: 'docs', url: 'https://example.invalid/mcp' }],
        resources: [{ id: 'res_1', type: 'file', file_id: 'file_1', mount_path: '/mnt/a' }],
        memory_store_entries: [{ path: '/memory/a.md', content: 'remember this' }],
        skills: [{ id: 'skill_1', name: 'review', version: 2 }],
      });
      expect(res.status).toBe(201);

      expect(fake().created[0]).toMatchObject({
        id: 'ses_1',
        workDir: workDir(),
        model: 'model-x',
        thinking: 'high',
        permission: 'manual',
        planMode: true,
        metadata: { tenant: 't-1' },
      });
      const session = fake().sessions.get('ses_1');
      expect(session?.activeToolsCalls).toEqual([['Read', 'Glob']]);
      expect(session?.registeredTools).toEqual([
        { name: 'query_billing', description: 'Query billing', parameters: { type: 'object' } },
      ]);

      // First prompt carries the create-time context blocks, user content last.
      const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'hello' });
      expect(stream.response.status).toBe(200);
      await collectNdjson(stream.reader);
      const firstPrompt = session?.prompts[0];
      expect(Array.isArray(firstPrompt)).toBe(true);
      const texts = (firstPrompt as Array<{ type: string; text: string }>).map((part) => part.text);
      expect(texts[0]).toBe('You are a coding agent.');
      expect(texts.some((text) => text.includes('remember this'))).toBe(true);
      expect(texts.some((text) => text.includes('res_1'))).toBe(true);
      expect(texts.some((text) => text.includes('skill_1'))).toBe(true);
      expect(texts.at(-1)).toBe('hello');
    });

    it.each(['closed', 'failed'] as const)(
      'rejects re-creating the same id on a %s session (409 session_state_conflict)',
      async (state) => {
        if (state === 'failed') {
          const { factory } = failingCreateHarness('ses_1', 'spawn failed: /internal/core binary');
          handle = await bootTestServer({ harnessFactory: factory });
          const boom = await postJson(base(), '/sessions', {
            session_id: 'ses_1',
            work_dir: workDir(),
          });
          expect(boom.status).toBe(500);
        } else {
          handle = await bootTestServer();
          await createSession();
          const cancelled = await postJson(base(), '/sessions/ses_1/cancel', {});
          expect(cancelled.status).toBe(202);
        }
        const res = await postJson(base(), '/sessions', { session_id: 'ses_1', work_dir: workDir() });
        expect(res.status).toBe(409);
        expectErrorEnvelope(res.body, 'session_state_conflict');
      },
    );
  });

  describe('POST /sessions/{id}/resume', () => {
    it('resumes an active session idempotently (200, no pending calls)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/resume', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ session_id: 'ses_1', status: 'active', pending_calls: [] });
    });

    it('reports an in-flight approval in pending_calls with the wire field names', async () => {
      handle = await bootTestServer();
      fake().setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        {
          kind: 'approval',
          request: {
            toolCallId: 'call_7f3',
            toolName: 'run_tests',
            action: 'execute',
            display: { kind: 'command', command: 'pnpm test' },
          },
        },
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
      ]);
      await createSession();
      const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'go' });
      expect(stream.response.status).toBe(200);
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('session.status_running');
      // The turn now blocks on the approval, so the call is registered pending.
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('approval_request');

      const res = await postJson(base(), '/sessions/ses_1/resume', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        session_id: 'ses_1',
        status: 'active',
        pending_calls: [{ tool_call_id: 'call_7f3', kind: 'approval', state: 'pending' }],
      });

      // Settle the pending call so the turn drains cleanly.
      const approved = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_7f3',
        decision: 'approved',
      });
      expect(approved.status).toBe(202);
      await collectNdjson(stream.reader);
    });

    it('rejects an unknown session id (404 session_not_found)', async () => {
      handle = await bootTestServer();
      // The runtime journal is the existence authority: an unknown id misses
      // there (RPC session.not_found at the harness boundary), which the hook
      // maps to the 404 contract code.
      fake().resumeErrors.set('nope', rpcError(RPC_SESSION_NOT_FOUND, 'session nope not found'));
      const res = await postJson(base(), '/sessions/nope/resume', {});
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'session_not_found');
    });

    it('rejects resuming a closed session (409 session_state_conflict)', async () => {
      handle = await bootTestServer();
      await createSession();
      await postJson(base(), '/sessions/ses_1/cancel', {});
      const res = await postJson(base(), '/sessions/ses_1/resume', {});
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
    });

    it('recovers a failed session from the journal (200 active)', async () => {
      const { factory, fake: localFake } = failingCreateHarness(
        'ses_1',
        'spawn failed: /internal/core binary',
      );
      handle = await bootTestServer({ harnessFactory: factory });
      const boom = await postJson(base(), '/sessions', { session_id: 'ses_1', work_dir: workDir() });
      expect(boom.status).toBe(500);

      const res = await postJson(base(), '/sessions/ses_1/resume', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ session_id: 'ses_1', status: 'active', pending_calls: [] });
      expect(localFake.resumed).toEqual([{ id: 'ses_1' }]);
    });
  });

  describe('POST /sessions/{id}/cancel', () => {
    it('cancels an active session (202) and is idempotent on closed (202)', async () => {
      handle = await bootTestServer();
      await createSession();
      const first = await postJson(base(), '/sessions/ses_1/cancel', {});
      expect(first.status).toBe(202);
      expect(first.body).toEqual({ accepted: true });
      const second = await postJson(base(), '/sessions/ses_1/cancel', {});
      expect(second.status).toBe(202);
      expect(second.body).toEqual({ accepted: true });
    });

    it('cancels a failed session (202, terminal cleanup)', async () => {
      const { factory } = failingCreateHarness('ses_1', 'spawn failed: /internal/core binary');
      handle = await bootTestServer({ harnessFactory: factory });
      await postJson(base(), '/sessions', { session_id: 'ses_1', work_dir: workDir() });
      const res = await postJson(base(), '/sessions/ses_1/cancel', {});
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: true });
    });

    it('rejects an unknown session id (404 session_not_found)', async () => {
      handle = await bootTestServer();
      const res = await postJson(base(), '/sessions/nope/cancel', {});
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'session_not_found');
    });
  });

  describe('POST /sessions/{id}/interrupt', () => {
    it('interrupts an in-flight turn (202); cancel ends the open stream', async () => {
      handle = await bootTestServer();
      fake().setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', delta: 'working' }) },
        // No turn.ended: the turn stays in flight until interrupted/cancelled.
      ]);
      await createSession();
      const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'go' });
      expect(stream.response.status).toBe(200);
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('session.status_running');
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('agent.message');

      const interrupted = await postJson(base(), '/sessions/ses_1/interrupt', {});
      expect(interrupted.status).toBe(202);
      expect(interrupted.body).toEqual({ accepted: true });
      expect(fake().sessions.get('ses_1')?.cancelCalls).toBe(1);

      const cancelled = await postJson(base(), '/sessions/ses_1/cancel', {});
      expect(cancelled.status).toBe(202);
      const rest = await collectNdjson(stream.reader);
      expect(rest).toEqual([{ type: 'prompt_done', stop_reason: 'cancelled' }]);
    });

    it('rejects interrupt without an in-flight turn (409 session_state_conflict)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/interrupt', {});
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
    });

    it('rejects interrupt on a closed session (409 session_state_conflict)', async () => {
      handle = await bootTestServer();
      await createSession();
      await postJson(base(), '/sessions/ses_1/cancel', {});
      const res = await postJson(base(), '/sessions/ses_1/interrupt', {});
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
    });

    it('rejects an unknown session id (404 session_not_found)', async () => {
      handle = await bootTestServer();
      const res = await postJson(base(), '/sessions/nope/interrupt', {});
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'session_not_found');
    });
  });
});
