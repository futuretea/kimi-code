import { afterEach, describe, expect, it } from 'vitest';

import { runtimeEvent, type FakeHarness, type FakeScriptStep } from './fake-harness';
import {
  asFrame,
  bootTestServer,
  collectNdjson,
  expectErrorEnvelope,
  nextNdjsonFrame,
  postJson,
  postStream,
  type FacadeFrame,
  type OpenStream,
  type TestServerHandle,
} from './http-helper';

const APPROVAL_STEP: FakeScriptStep = {
  kind: 'approval',
  request: { toolCallId: 'call_1', toolName: 'run_tests', action: 'execute', display: { kind: 'command', command: 'pnpm test' } },
};

const TOOL_CALL_STEPS: readonly FakeScriptStep[] = [
  {
    kind: 'event',
    event: runtimeEvent({ type: 'tool.call.started', toolCallId: 'call_1', name: 'query_billing', args: {} }),
  },
  { kind: 'tool_call', request: { toolCallId: 'call_1', args: {} } },
];

const QUESTION_STEP: FakeScriptStep = {
  kind: 'question',
  request: {
    questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  },
};

describe('interaction routes (approvals / questions / tool-results)', () => {
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

  /**
   * Starts a turn that blocks on the given interaction steps and returns once
   * the interaction request frame has arrived on the prompt stream.
   */
  async function startBlockedTurn(
    steps: readonly FakeScriptStep[],
    requestType: string,
    sessionId = 'ses_1',
  ): Promise<{ stream: OpenStream; requestFrame: FacadeFrame }> {
    fake().setScript(sessionId, [
      { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
      ...steps,
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
    ]);
    await createSession(sessionId);
    const stream = await postStream(base(), `/sessions/${sessionId}/prompt`, { content: 'go' });
    expect(stream.response.status).toBe(200);
    for (;;) {
      const frame = asFrame(await nextNdjsonFrame(stream.reader));
      if (frame.type === requestType) return { stream, requestFrame: frame };
    }
  }

  describe('approvals', () => {
    it('accepts a pending approval (202) and rejects a duplicate (409 request_not_pending)', async () => {
      handle = await bootTestServer();
      const { stream } = await startBlockedTurn([APPROVAL_STEP], 'approval_request');

      const accepted = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_1',
        decision: 'approved',
        feedback: 'looks safe',
      });
      expect(accepted.status).toBe(202);
      expect(accepted.body).toEqual({ accepted: true });
      expect(fake().sessions.get('ses_1')?.approvalResponses).toEqual([
        { decision: 'approved', feedback: 'looks safe' },
      ]);

      const duplicate = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_1',
        decision: 'rejected',
      });
      expect(duplicate.status).toBe(409);
      expectErrorEnvelope(duplicate.body, 'request_not_pending');

      const frames = await collectNdjson(stream.reader);
      expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
    });

    it('rejects a late response after the turn ended (409 request_not_pending)', async () => {
      handle = await bootTestServer();
      const { stream } = await startBlockedTurn([APPROVAL_STEP], 'approval_request');
      await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_1',
        decision: 'approved',
      });
      await collectNdjson(stream.reader);

      const late = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_1',
        decision: 'approved',
      });
      expect(late.status).toBe(409);
      expectErrorEnvelope(late.body, 'request_not_pending');
    });

    it('rejects an unknown tool_call_id (409 request_not_pending)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'nope',
        decision: 'approved',
      });
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'request_not_pending');
    });

    it('rejects a response addressed to another session (409 request_not_pending)', async () => {
      handle = await bootTestServer();
      const { stream } = await startBlockedTurn([APPROVAL_STEP], 'approval_request', 'ses_1');
      await createSession('ses_2');

      const crossSession = await postJson(base(), '/sessions/ses_2/approvals', {
        tool_call_id: 'call_1',
        decision: 'approved',
      });
      expect(crossSession.status).toBe(409);
      expectErrorEnvelope(crossSession.body, 'request_not_pending');

      // The pending call in ses_1 is untouched and still resolvable.
      const accepted = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_1',
        decision: 'approved',
      });
      expect(accepted.status).toBe(202);
      await collectNdjson(stream.reader);
    });

    it('rejects an invalid decision (400 invalid_request)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_1',
        decision: 'maybe',
      });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'invalid_request');
    });
  });

  describe('questions', () => {
    it('accepts answers for a pending question (202) and rejects a duplicate (409)', async () => {
      handle = await bootTestServer();
      const { stream, requestFrame } = await startBlockedTurn([QUESTION_STEP], 'question_request');
      expect(requestFrame.type).toBe('question_request');
      const questionId = requestFrame['question_id'];
      expect(typeof questionId).toBe('string');

      const accepted = await postJson(base(), '/sessions/ses_1/questions', {
        question_id: questionId,
        answers: { 'Proceed?': 'Yes' },
      });
      expect(accepted.status).toBe(202);
      expect(accepted.body).toEqual({ accepted: true });
      expect(fake().sessions.get('ses_1')?.questionResults).toEqual([{ 'Proceed?': 'Yes' }]);

      const duplicate = await postJson(base(), '/sessions/ses_1/questions', {
        question_id: questionId,
        answers: { 'Proceed?': 'No' },
      });
      expect(duplicate.status).toBe(409);
      expectErrorEnvelope(duplicate.body, 'request_not_pending');

      const frames = await collectNdjson(stream.reader);
      expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
    });

    it('rejects an unknown question_id (409 request_not_pending)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/questions', {
        question_id: 'q_nope',
        answers: { 'Proceed?': true },
      });
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'request_not_pending');
    });

    it('rejects a missing answers object (400 invalid_request)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/questions', { question_id: 'q_1' });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'invalid_request');
    });
  });

  describe('tool-results', () => {
    it('accepts a completed result (202) and rejects a duplicate (409 request_not_pending)', async () => {
      handle = await bootTestServer();
      const { stream } = await startBlockedTurn(TOOL_CALL_STEPS, 'external_tool_request');

      const accepted = await postJson(base(), '/sessions/ses_1/tool-results', {
        tool_call_id: 'call_1',
        resolution: 'completed',
        output: '{"rows":3}',
      });
      expect(accepted.status).toBe(202);
      expect(accepted.body).toEqual({ accepted: true });
      expect(fake().sessions.get('ses_1')?.toolCallResponses).toEqual([
        { output: '{"rows":3}', isError: false },
      ]);

      const duplicate = await postJson(base(), '/sessions/ses_1/tool-results', {
        tool_call_id: 'call_1',
        resolution: 'completed',
        output: '{}',
      });
      expect(duplicate.status).toBe(409);
      expectErrorEnvelope(duplicate.body, 'request_not_pending');

      const frames = await collectNdjson(stream.reader);
      expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
    });

    it('rejects a completed resolution without output (400) and keeps the call pending', async () => {
      handle = await bootTestServer();
      const { stream } = await startBlockedTurn(TOOL_CALL_STEPS, 'external_tool_request');

      const missing = await postJson(base(), '/sessions/ses_1/tool-results', {
        tool_call_id: 'call_1',
        resolution: 'completed',
      });
      expect(missing.status).toBe(400);
      expectErrorEnvelope(missing.body, 'invalid_request');

      // The call is still pending: a corrected retry is accepted.
      const retry = await postJson(base(), '/sessions/ses_1/tool-results', {
        tool_call_id: 'call_1',
        resolution: 'completed',
        output: 'ok',
      });
      expect(retry.status).toBe(202);
      await collectNdjson(stream.reader);
    });

    it('maps a failed resolution to an error tool response', async () => {
      handle = await bootTestServer();
      const { stream } = await startBlockedTurn(TOOL_CALL_STEPS, 'external_tool_request');
      const failed = await postJson(base(), '/sessions/ses_1/tool-results', {
        tool_call_id: 'call_1',
        resolution: 'failed',
        output: 'billing backend down',
      });
      expect(failed.status).toBe(202);
      expect(fake().sessions.get('ses_1')?.toolCallResponses).toEqual([
        { output: 'billing backend down', isError: true },
      ]);
      await collectNdjson(stream.reader);
    });

    it('rejects an unknown tool_call_id (409 request_not_pending)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/tool-results', {
        tool_call_id: 'nope',
        resolution: 'skipped',
      });
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'request_not_pending');
    });

    it('rejects a kind-mismatched pending id (409 request_not_pending)', async () => {
      handle = await bootTestServer();
      const { stream } = await startBlockedTurn([APPROVAL_STEP], 'approval_request');
      // call_1 is pending as an approval, not as an external tool call.
      const mismatched = await postJson(base(), '/sessions/ses_1/tool-results', {
        tool_call_id: 'call_1',
        resolution: 'completed',
        output: '{}',
      });
      expect(mismatched.status).toBe(409);
      expectErrorEnvelope(mismatched.body, 'request_not_pending');

      // The approval itself is still pending and resolvable.
      const accepted = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_1',
        decision: 'approved',
      });
      expect(accepted.status).toBe(202);
      await collectNdjson(stream.reader);
    });
  });

  describe('non-active sessions', () => {
    it.each([
      ['approvals', { tool_call_id: 'call_1', decision: 'approved' }],
      ['questions', { question_id: 'q_1', answers: { q: 'a' } }],
      ['tool-results', { tool_call_id: 'call_1', resolution: 'skipped' }],
    ] as const)('rejects %s on a closed session (409 session_state_conflict)', async (path, body) => {
      handle = await bootTestServer();
      await createSession();
      await postJson(base(), '/sessions/ses_1/cancel', {});
      const res = await postJson(base(), `/sessions/ses_1/${path}`, body);
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
    });

    it.each([
      ['approvals', { tool_call_id: 'call_1', decision: 'approved' }],
      ['questions', { question_id: 'q_1', answers: { q: 'a' } }],
      ['tool-results', { tool_call_id: 'call_1', resolution: 'skipped' }],
    ] as const)('rejects %s on an unknown session (404 session_not_found)', async (path, body) => {
      handle = await bootTestServer();
      const res = await postJson(base(), `/sessions/nope/${path}`, body);
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'session_not_found');
    });
  });
});
