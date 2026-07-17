import { afterEach, describe, expect, it } from 'vitest';

import { runtimeEvent } from './fake-harness';
import {
  asFrame,
  bootTestServer,
  collectNdjson,
  expectErrorEnvelope,
  nextNdjsonFrame,
  nextSseFrame,
  openEventStream,
  postJson,
  postStream,
  type TestServerHandle,
} from './http-helper';

/**
 * The serial full loop from the contract test plan: create -> events/stream ->
 * prompt -> approval_request -> approvals -> external_tool_request ->
 * tool-results -> question_request -> questions -> interrupt -> cancel.
 */
describe('facade full loop', () => {
  let handle: TestServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('drives a session end to end over the wire', async () => {
    handle = await bootTestServer();
    const { fake, baseUrl } = handle;
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
      { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', delta: 'Let me check.' }) },
      {
        kind: 'approval',
        request: { toolCallId: 'call_7f3', toolName: 'run_tests', action: 'execute', display: { kind: 'command', command: 'pnpm test' } },
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'tool.call.started',
          toolCallId: 'call_9a2',
          name: 'query_billing',
          args: { month: '2026-07' },
        }),
      },
      { kind: 'tool_call', request: { toolCallId: 'call_9a2', args: { month: '2026-07' } } },
      {
        kind: 'question',
        request: {
          questions: [
            {
              question: 'Proceed with the refactor?',
              header: 'Confirm',
              options: [{ label: 'Yes' }, { label: 'No' }],
              multiSelect: false,
            },
          ],
        },
      },
      { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', delta: 'All done.' }) },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
    ]);

    // 1. create
    const created = await postJson(baseUrl, '/sessions', {
      session_id: 'ses_1',
      work_dir: handle.homeDir,
      permission_policy: 'always_ask',
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ session_id: 'ses_1', status: 'active' });

    // 2. open the live event stream
    const sse = await openEventStream(baseUrl, 'ses_1');
    expect(sse.response.status).toBe(200);

    // 3. prompt: the NDJSON stream stays open for the whole turn
    const prompt = await postStream(baseUrl, '/sessions/ses_1/prompt', {
      content: 'analyze this repo and propose a refactor',
      idempotency_key: 'k-loop',
    });
    expect(prompt.response.status).toBe(200);

    expect(asFrame(await nextNdjsonFrame(prompt.reader)).type).toBe('session.status_running');
    expect(asFrame(await nextNdjsonFrame(prompt.reader))).toMatchObject({
      type: 'agent.message',
      content: 'Let me check.',
    });

    // 4. approval round trip
    const approvalRequest = asFrame(await nextNdjsonFrame(prompt.reader));
    expect(approvalRequest).toMatchObject({
      type: 'approval_request',
      tool_call_id: 'call_7f3',
      tool_name: 'run_tests',
      action: 'execute',
    });
    const approved = await postJson(baseUrl, '/sessions/ses_1/approvals', {
      tool_call_id: 'call_7f3',
      decision: 'approved',
    });
    expect(approved.status).toBe(202);

    // 5. external tool round trip
    expect(asFrame(await nextNdjsonFrame(prompt.reader))).toMatchObject({
      type: 'agent.tool_use',
      id: 'call_9a2',
      name: 'query_billing',
    });
    const toolRequest = asFrame(await nextNdjsonFrame(prompt.reader));
    expect(toolRequest).toMatchObject({
      type: 'external_tool_request',
      tool_call_id: 'call_9a2',
      name: 'query_billing',
      arguments: { month: '2026-07' },
    });
    const toolResult = await postJson(baseUrl, '/sessions/ses_1/tool-results', {
      tool_call_id: 'call_9a2',
      resolution: 'completed',
      output: '{"rows":3}',
    });
    expect(toolResult.status).toBe(202);

    // 6. question round trip
    const questionRequest = asFrame(await nextNdjsonFrame(prompt.reader));
    expect(questionRequest.type).toBe('question_request');
    const questionId = questionRequest['question_id'];
    expect(typeof questionId).toBe('string');
    const answered = await postJson(baseUrl, '/sessions/ses_1/questions', {
      question_id: questionId,
      answers: { 'Proceed with the refactor?': 'Yes' },
    });
    expect(answered.status).toBe(202);

    // 7. the turn completes; the terminal frame carries the stop reason
    expect(asFrame(await nextNdjsonFrame(prompt.reader))).toMatchObject({
      type: 'agent.message',
      content: 'All done.',
    });
    expect(asFrame(await nextNdjsonFrame(prompt.reader)).type).toBe('session.status_idle');
    const terminal = asFrame(await nextNdjsonFrame(prompt.reader));
    expect(terminal).toEqual({ type: 'prompt_done', stop_reason: 'completed' });

    // The interaction loop reached the runtime with the wire-supplied values.
    expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([{ decision: 'approved' }]);
    expect(fake.sessions.get('ses_1')?.toolCallResponses).toEqual([
      { output: '{"rows":3}', isError: false },
    ]);
    expect(fake.sessions.get('ses_1')?.questionResults).toEqual([
      { 'Proceed with the refactor?': 'Yes' },
    ]);

    // 8. dual channel: the SSE stream saw the same facade events, numbered in order
    const sseTypes: string[] = [];
    const sseIds: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const frame = await nextSseFrame(sse.reader);
      sseTypes.push(frame.event ?? '');
      sseIds.push(Number(frame.id));
    }
    expect(sseTypes).toEqual([
      'session.status_running',
      'agent.message',
      'approval_request',
      'agent.tool_use',
      'external_tool_request',
      'question_request',
      'agent.message',
      'session.status_idle',
    ]);
    expect(sseIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // 9. interrupt after the turn: nothing in flight
    const interruptIdle = await postJson(baseUrl, '/sessions/ses_1/interrupt', {});
    expect(interruptIdle.status).toBe(409);
    expectErrorEnvelope(interruptIdle.body, 'session_state_conflict');

    // 10. cancel (twice: idempotent) and the session is terminal afterwards
    const cancelled = await postJson(baseUrl, '/sessions/ses_1/cancel', {});
    expect(cancelled.status).toBe(202);
    expect(cancelled.body).toEqual({ accepted: true });
    const cancelledAgain = await postJson(baseUrl, '/sessions/ses_1/cancel', {});
    expect(cancelledAgain.status).toBe(202);

    const promptOnClosed = await postJson(baseUrl, '/sessions/ses_1/prompt', { content: 'hi' });
    expect(promptOnClosed.status).toBe(409);
    expectErrorEnvelope(promptOnClosed.body, 'prompt_rejected');

    sse.reader.close();
  });
});
