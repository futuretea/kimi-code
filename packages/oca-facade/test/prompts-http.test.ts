import { afterEach, describe, expect, it } from 'vitest';

import { runtimeEvent, type FakeHarness } from './fake-harness';
import {
  asFrame,
  bootTestServer,
  collectNdjson,
  expectErrorEnvelope,
  frameTypes,
  nextNdjsonFrame,
  postJson,
  postStream,
  type TestServerHandle,
} from './http-helper';

describe('prompt route', () => {
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

  function setCompletingScript(sessionId = 'ses_1'): void {
    fake().setScript(sessionId, [
      { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
      { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', delta: 'done' }) },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
    ]);
  }

  it('streams the turn events as NDJSON and ends with the terminal frame', async () => {
    handle = await bootTestServer();
    fake().setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
      { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', delta: 'Let me check.' }) },
      { kind: 'event', event: runtimeEvent({ type: 'thinking.delta', delta: 'hmm' }) },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.call.started', toolCallId: 'call_1', name: 'Read', args: { path: 'a.ts' } }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.result', toolCallId: 'call_1', output: 'file text' }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'tool.call.started',
          toolCallId: 'call_2',
          name: 'mcp__docs__search',
          args: { q: 'x' },
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.result', toolCallId: 'call_2', output: 'oops', isError: true }),
      },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
    ]);
    await createSession();
    const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'hi' });
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('application/x-ndjson');

    const frames = await collectNdjson(stream.reader);
    expect(frameTypes(frames)).toEqual([
      'session.status_running',
      'agent.message',
      'agent.thinking',
      'agent.tool_use',
      'agent.tool_result',
      'agent.mcp_tool_use',
      'agent.mcp_tool_result',
      'session.status_idle',
      'prompt_done',
    ]);
    expect(frames[1]).toMatchObject({ type: 'agent.message', content: 'Let me check.' });
    expect(frames[3]).toMatchObject({
      type: 'agent.tool_use',
      id: 'call_1',
      name: 'Read',
      arguments: { path: 'a.ts' },
    });
    expect(frames[5]).toMatchObject({
      type: 'agent.mcp_tool_use',
      id: 'call_2',
      server_name: 'docs',
      tool_name: 'search',
    });
    expect(frames[6]).toMatchObject({ type: 'agent.mcp_tool_result', id: 'call_2', is_error: true });
    expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
  });

  it('rejects a prompt without content (400 invalid_request)', async () => {
    handle = await bootTestServer();
    await createSession();
    const res = await postJson(base(), '/sessions/ses_1/prompt', {});
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'invalid_request');
  });

  it('rejects a prompt on an unknown session (404 session_not_found)', async () => {
    handle = await bootTestServer();
    const res = await postJson(base(), '/sessions/nope/prompt', { content: 'hi' });
    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'session_not_found');
  });

  it('rejects a prompt on a closed session (409 prompt_rejected)', async () => {
    handle = await bootTestServer();
    await createSession();
    await postJson(base(), '/sessions/ses_1/cancel', {});
    const res = await postJson(base(), '/sessions/ses_1/prompt', { content: 'hi' });
    expect(res.status).toBe(409);
    expectErrorEnvelope(res.body, 'prompt_rejected');
  });

  describe('idempotency', () => {
    it('rejects a concurrent prompt while a turn is in flight (409 prompt_rejected)', async () => {
      handle = await bootTestServer();
      fake().setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        {
          kind: 'approval',
          request: { toolCallId: 'call_1', toolName: 'run_tests', action: 'execute', display: { kind: 'command', command: 'pnpm test' } },
        },
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
      ]);
      await createSession();
      const stream = await postStream(base(), '/sessions/ses_1/prompt', {
        content: 'go',
        idempotency_key: 'k-1',
      });
      expect(stream.response.status).toBe(200);
      // Wait until the turn is actually blocked on the approval.
      const approvalRequest = asFrame(await nextNdjsonFrame(stream.reader));
      expect(approvalRequest.type).toBe('session.status_running');
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('approval_request');

      // Same key while in flight: busy, not a replay.
      const sameKey = await postJson(base(), '/sessions/ses_1/prompt', {
        content: 'go',
        idempotency_key: 'k-1',
      });
      expect(sameKey.status).toBe(409);
      expectErrorEnvelope(sameKey.body, 'prompt_rejected');

      // A different key is equally rejected: one turn per session.
      const otherKey = await postJson(base(), '/sessions/ses_1/prompt', { content: 'go' });
      expect(otherKey.status).toBe(409);
      expectErrorEnvelope(otherKey.body, 'prompt_rejected');

      // Unblock the turn so the first stream terminates.
      const resolved = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_1',
        decision: 'approved',
      });
      expect(resolved.status).toBe(202);
      const frames = await collectNdjson(stream.reader);
      expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
    });

    it('replays the terminal frame for a finished key with the same content (200, no re-execution)', async () => {
      handle = await bootTestServer();
      setCompletingScript();
      await createSession();

      const first = await postStream(base(), '/sessions/ses_1/prompt', {
        content: 'go',
        idempotency_key: 'k-1',
      });
      expect(first.response.status).toBe(200);
      const firstFrames = await collectNdjson(first.reader);
      expect(firstFrames.at(-1)).toEqual({
        type: 'prompt_done',
        stop_reason: 'completed',
      });
      expect(fake().sessions.get('ses_1')?.prompts).toHaveLength(1);

      // Same key + same content: the first terminal frame, no event replay.
      const replay = await postStream(base(), '/sessions/ses_1/prompt', {
        content: 'go',
        idempotency_key: 'k-1',
      });
      expect(replay.response.status).toBe(200);
      expect(replay.response.headers.get('content-type')).toContain('application/x-ndjson');
      const replayFrames = await collectNdjson(replay.reader);
      expect(replayFrames).toEqual([{ type: 'prompt_done', stop_reason: 'completed' }]);
      expect(fake().sessions.get('ses_1')?.prompts).toHaveLength(1);
    });

    it('rejects a finished key with different content (409 session_state_conflict)', async () => {
      handle = await bootTestServer();
      setCompletingScript();
      await createSession();
      const first = await postStream(base(), '/sessions/ses_1/prompt', {
        content: 'go',
        idempotency_key: 'k-1',
      });
      await collectNdjson(first.reader);

      const conflict = await postJson(base(), '/sessions/ses_1/prompt', {
        content: 'different',
        idempotency_key: 'k-1',
      });
      expect(conflict.status).toBe(409);
      expectErrorEnvelope(conflict.body, 'session_state_conflict');
    });

    it('accepts a new key after the previous turn finished', async () => {
      handle = await bootTestServer();
      setCompletingScript();
      await createSession();
      const first = await postStream(base(), '/sessions/ses_1/prompt', {
        content: 'go',
        idempotency_key: 'k-1',
      });
      await collectNdjson(first.reader);
      const second = await postStream(base(), '/sessions/ses_1/prompt', {
        content: 'again',
        idempotency_key: 'k-2',
      });
      expect(second.response.status).toBe(200);
      const frames = await collectNdjson(second.reader);
      expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
      expect(fake().sessions.get('ses_1')?.prompts).toHaveLength(2);
    });
  });
});
