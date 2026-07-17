import { afterEach, describe, expect, it } from 'vitest';

import { runtimeEvent, type FakeHarness } from './fake-harness';
import {
  asFrame,
  bootTestServer,
  collectNdjson,
  expectErrorEnvelope,
  getJson,
  nextSseFrame,
  openEventStream,
  postJson,
  postStream,
  type TestServerHandle,
} from './http-helper';

function script(content: string): Parameters<FakeHarness['setScript']>[1] {
  return [
    { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
    { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', delta: content }) },
    { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
  ];
}

describe('events stream route', () => {
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

  it('delivers live events as SSE frames with id/event/data and per-session sequence', async () => {
    handle = await bootTestServer();
    fake().setScript('ses_1', script('turn one'));
    await createSession();

    const sse = await openEventStream(base(), 'ses_1');
    expect(sse.response.status).toBe(200);
    expect(sse.response.headers.get('content-type')).toContain('text/event-stream');

    const prompt = await postStream(base(), '/sessions/ses_1/prompt', { content: 'go' });
    expect(prompt.response.status).toBe(200);

    const first = await nextSseFrame(sse.reader);
    expect(first.id).toBe('1');
    expect(first.event).toBe('session.status_running');
    expect(asFrame(JSON.parse(first.data))).toMatchObject({ type: 'session.status_running' });

    const second = await nextSseFrame(sse.reader);
    expect(second.id).toBe('2');
    expect(second.event).toBe('agent.message');
    expect(asFrame(JSON.parse(second.data))).toMatchObject({
      type: 'agent.message',
      content: 'turn one',
    });

    const third = await nextSseFrame(sse.reader);
    expect(third.id).toBe('3');
    expect(third.event).toBe('session.status_idle');

    // The NDJSON terminal frame is not an SSE event.
    const frames = await collectNdjson(prompt.reader);
    expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
    sse.reader.close();
  });

  it('is live-only: events from before the subscription are not replayed', async () => {
    handle = await bootTestServer();
    fake().setScript('ses_1', script('again'));
    await createSession();

    // Turn one runs with no subscriber (3 events consume seq 1..3).
    const first = await postStream(base(), '/sessions/ses_1/prompt', { content: 'one' });
    await collectNdjson(first.reader);

    const sse = await openEventStream(base(), 'ses_1');
    expect(sse.response.status).toBe(200);

    const second = await postStream(base(), '/sessions/ses_1/prompt', { content: 'two' });
    expect(second.response.status).toBe(200);

    // The stream starts at seq 4: nothing from turn one is replayed.
    const frame = await nextSseFrame(sse.reader);
    expect(frame.id).toBe('4');
    expect(frame.event).toBe('session.status_running');
    expect((await nextSseFrame(sse.reader)).id).toBe('5');
    expect((await nextSseFrame(sse.reader)).id).toBe('6');
    await collectNdjson(second.reader);

    // And nothing more arrives after the turn.
    await expect(nextSseFrame(sse.reader, 200)).rejects.toThrow();
    sse.reader.close();
  });

  it('serves concurrent subscribers with the same frames', async () => {
    handle = await bootTestServer();
    fake().setScript('ses_1', script('broadcast'));
    await createSession();

    const sseA = await openEventStream(base(), 'ses_1');
    const sseB = await openEventStream(base(), 'ses_1');
    const prompt = await postStream(base(), '/sessions/ses_1/prompt', { content: 'go' });

    const [a1, b1] = [await nextSseFrame(sseA.reader), await nextSseFrame(sseB.reader)];
    expect(a1.event).toBe('session.status_running');
    expect(b1.event).toBe('session.status_running');
    expect(a1.data).toBe(b1.data);
    expect(a1.id).toBe(b1.id);

    await collectNdjson(prompt.reader);
    sseA.reader.close();
    sseB.reader.close();
  });

  it('rejects streaming a closed session (409 session_state_conflict)', async () => {
    handle = await bootTestServer();
    await createSession();
    await postJson(base(), '/sessions/ses_1/cancel', {});
    const res = await getJson(base(), '/sessions/ses_1/events/stream');
    expect(res.status).toBe(409);
    expectErrorEnvelope(res.body, 'session_state_conflict');
  });

  it('rejects streaming an unknown session (404 session_not_found)', async () => {
    handle = await bootTestServer();
    const res = await getJson(base(), '/sessions/nope/events/stream');
    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'session_not_found');
  });
});
