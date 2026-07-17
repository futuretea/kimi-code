import { afterEach, describe, expect, it } from 'vitest';

import type { HarnessFactory, HarnessSessionFactory } from '../src/harness';

import { createFakeHarness, runtimeEvent } from './fake-harness';
import {
  asFrame,
  bootTestServer,
  collectNdjson,
  expectErrorEnvelope,
  frameTypes,
  getJson,
  postJson,
  postStream,
  type TestServerHandle,
} from './http-helper';

describe('server bootstrap, health, and error handling', () => {
  let handle: TestServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  function base(): string {
    if (handle === undefined) throw new Error('test server not booted');
    return handle.baseUrl;
  }

  it('answers GET /health with 200', async () => {
    handle = await bootTestServer();
    const res = await getJson(base(), '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('answers GET /ready with 200 when the harness is available', async () => {
    handle = await bootTestServer();
    const res = await getJson(base(), '/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('answers GET /ready with 500 runtime_unavailable when the harness cannot start', async () => {
    const rawMessage = 'runtime binary missing at /internal/core path';
    const factory: HarnessFactory = () => {
      throw new Error(rawMessage);
    };
    handle = await bootTestServer({ harnessFactory: factory });
    const res = await getJson(base(), '/ready');
    expect(res.status).toBe(500);
    const envelope = expectErrorEnvelope(res.body, 'runtime_unavailable');
    expect(JSON.stringify(res.body)).not.toContain('/internal/core');
    expect(envelope.error.message).toBe('The runtime is unavailable.');
  });

  it('sanitizes raw harness errors on session create (500 internal_error)', async () => {
    const rawMessage = 'spawn failed: /internal/core binary --secret-flag';
    const { createHarness } = createFakeHarness();
    const factory: HarnessFactory = (options) => {
      const inner: HarnessSessionFactory = createHarness(options);
      return {
        createSession: () => Promise.reject(new Error(rawMessage)),
        resumeSession: (input) => inner.resumeSession(input),
      };
    };
    handle = await bootTestServer({ harnessFactory: factory });
    const res = await postJson(base(), '/sessions', {
      session_id: 'ses_1',
      work_dir: handle.homeDir,
    });
    expect(res.status).toBe(500);
    const envelope = expectErrorEnvelope(res.body, 'internal_error');
    expect(envelope.error.message).toBe('An internal error occurred.');
    expect(JSON.stringify(res.body)).not.toContain('secret-flag');
  });

  it('reports a mid-turn harness failure as a neutral error frame plus prompt_done', async () => {
    const rawMessage = 'raw runtime detail: /internal/core exploded';
    const { createHarness } = createFakeHarness();
    const factory: HarnessFactory = (options) => {
      const inner: HarnessSessionFactory = createHarness(options);
      return {
        createSession: async (createOptions) => {
          const session = await inner.createSession(createOptions);
          session.prompt = () => Promise.reject(new Error(rawMessage));
          return session;
        },
        resumeSession: (input) => inner.resumeSession(input),
      };
    };
    handle = await bootTestServer({ harnessFactory: factory });
    await postJson(base(), '/sessions', { session_id: 'ses_1', work_dir: handle.homeDir });

    const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'go' });
    expect(stream.response.status).toBe(200);
    const frames = await collectNdjson(stream.reader);
    expect(frameTypes(frames)).toEqual(['session.error', 'prompt_done']);
    expect(frames[0]).toEqual({
      type: 'session.error',
      code: 'internal_error',
      message: 'An internal error occurred.',
    });
    expect(frames[1]).toEqual({ type: 'prompt_done', stop_reason: 'failed' });
    expect(JSON.stringify(frames)).not.toContain('/internal/core');
  });

  it('rejects a malformed JSON body (400 invalid_request)', async () => {
    handle = await bootTestServer();
    const response = await fetch(`${base()}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expectErrorEnvelope(await response.json(), 'invalid_request');
  });

  it('answers unknown routes with 404 session_not_found', async () => {
    handle = await bootTestServer();
    const res = await getJson(base(), '/nope');
    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'session_not_found');
  });

  it('emits a neutral session.error event for runtime error events', async () => {
    handle = await bootTestServer();
    handle.fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'error', message: 'raw boom at /internal/core', code: 'boom' }),
      },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'failed' }) },
    ]);
    await postJson(base(), '/sessions', { session_id: 'ses_1', work_dir: handle.homeDir });
    const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'go' });
    const frames = await collectNdjson(stream.reader);
    const errorFrame = frames.map(asFrame).find((frame) => frame.type === 'session.error');
    expect(errorFrame).toBeDefined();
    expect(errorFrame?.['code']).toBe('internal_error');
    expect(String(errorFrame?.['message'])).not.toContain('/internal/core');
  });
});
