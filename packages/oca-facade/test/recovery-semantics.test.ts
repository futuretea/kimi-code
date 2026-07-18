import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FacadeError, type FacadeErrorCode } from '../src/errors';
import { SessionRegistry, type PendingCallJournal } from '../src/session-registry';

import { runtimeEvent, type FakeScriptStep } from './fake-harness';
import {
  asFrame,
  bootTestServer,
  collectNdjson,
  expectErrorEnvelope,
  frameTypes,
  nextNdjsonFrame,
  postJson,
  postStream,
} from './http-helper';

/**
 * Recovery slice (T3 + invariants): `unknown` call semantics after recovery.
 * - `resolution=skipped` on an `unknown` external call -> accepted, terminal
 * - any other resolution on an `unknown` call -> request_not_pending
 * - late/duplicate/cross-session results -> request_not_pending, never match
 * - no auto-replay: the crashed turn is not relaunched, nothing is re-emitted
 * - D6: a same idempotency-key prompt after recovery is a new execution
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

const APPROVAL_STEP: FakeScriptStep = {
  kind: 'approval',
  request: {
    toolCallId: 'call_appr',
    toolName: 'run_tests',
    action: 'execute',
    display: { kind: 'command', command: 'pnpm test' },
  },
};

const TOOL_CALL_STEPS: readonly FakeScriptStep[] = [
  {
    kind: 'event',
    event: runtimeEvent({ type: 'tool.call.started', toolCallId: 'call_ext', name: 'query_billing', args: {} }),
  },
  { kind: 'tool_call', request: { toolCallId: 'call_ext', args: {} } },
];

/** A registry whose session crashed with one unconfirmed external call. */
async function registryWithRecoveredUnknownCall(): Promise<SessionRegistry> {
  const registry = new SessionRegistry({
    recoverFromJournal: async () => ({
      pendingCalls: [{ id: 'call_ext', kind: 'external_tool', state: 'unknown' }],
    }),
  });
  registry.createSession('ses_1');
  registry.registerPendingCall('ses_1', { id: 'call_ext', kind: 'external_tool' });
  registry.markFailed('ses_1');
  await registry.resumeSession('ses_1');
  return registry;
}

describe('unknown external call settlement (skip semantics)', () => {
  it('accepts resolution=skipped on an unknown call and terminates it', async () => {
    const registry = await registryWithRecoveredUnknownCall();
    expect(
      registry.resolveToolResult('ses_1', { toolCallId: 'call_ext', resolution: 'skipped' }),
    ).toEqual({ accepted: true });
    // Terminal: removed from the pending table, nothing left to correlate.
    expect(registry.listPendingCalls('ses_1')).toEqual([]);
  });

  it('rejects resolution=completed on an unknown call (request_not_pending)', async () => {
    const registry = await registryWithRecoveredUnknownCall();
    expectFacadeError(
      () =>
        registry.resolveToolResult('ses_1', {
          toolCallId: 'call_ext',
          resolution: 'completed',
          output: '{"rows":3}',
        }),
      'request_not_pending',
    );
    // The rejection does not consume the call: it is still reported unknown.
    expect(registry.listPendingCalls('ses_1')).toEqual([
      { id: 'call_ext', kind: 'external_tool', state: 'unknown' },
    ]);
  });

  it('rejects resolution=failed on an unknown call (request_not_pending)', async () => {
    const registry = await registryWithRecoveredUnknownCall();
    expectFacadeError(
      () => registry.resolveToolResult('ses_1', { toolCallId: 'call_ext', resolution: 'failed' }),
      'request_not_pending',
    );
    expect(registry.listPendingCalls('ses_1')).toEqual([
      { id: 'call_ext', kind: 'external_tool', state: 'unknown' },
    ]);
  });

  it('rejects a duplicate skip and a late original result after the skip', async () => {
    const registry = await registryWithRecoveredUnknownCall();
    expect(
      registry.resolveToolResult('ses_1', { toolCallId: 'call_ext', resolution: 'skipped' }),
    ).toEqual({ accepted: true });

    expectFacadeError(
      () => registry.resolveToolResult('ses_1', { toolCallId: 'call_ext', resolution: 'skipped' }),
      'request_not_pending',
    );
    expectFacadeError(
      () =>
        registry.resolveToolResult('ses_1', {
          toolCallId: 'call_ext',
          resolution: 'completed',
          output: '{}',
        }),
      'request_not_pending',
    );
  });

  it('rejects a skip addressed to another session (cross-session correlation)', async () => {
    const registry = await registryWithRecoveredUnknownCall();
    registry.createSession('ses_2');
    expectFacadeError(
      () => registry.resolveToolResult('ses_2', { toolCallId: 'call_ext', resolution: 'skipped' }),
      'request_not_pending',
    );
    // The unknown call in ses_1 is untouched.
    expect(registry.listPendingCalls('ses_1')).toEqual([
      { id: 'call_ext', kind: 'external_tool', state: 'unknown' },
    ]);
  });

  it('never matches a late result against a new pending call with a different id', async () => {
    const registry = await registryWithRecoveredUnknownCall();
    // The user asks the agent to redo the work: a functional retry is a NEW
    // call with a NEW id; the old unknown id must not latch onto it.
    registry.registerPendingCall('ses_1', { id: 'call_new', kind: 'external_tool' });
    expectFacadeError(
      () =>
        registry.resolveToolResult('ses_1', {
          toolCallId: 'call_ext',
          resolution: 'completed',
          output: '{}',
        }),
      'request_not_pending',
    );
    expect(
      registry.resolveToolResult('ses_1', { toolCallId: 'call_new', resolution: 'skipped' }),
    ).toEqual({ accepted: true });
  });
});

/** Boots process A, blocks a turn on the scripted interaction, then "crashes". */
async function crashWithPendingInteraction(
  steps: readonly FakeScriptStep[],
  requestType: string,
  promptBody: Record<string, unknown> = { content: 'go' },
): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'oca-facade-recovery-'));
  const a = await bootTestServer({ homeDir });
  a.fake.setScript('ses_1', [
    { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
    ...steps,
    { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
  ]);
  const created = await postJson(a.baseUrl, '/sessions', { session_id: 'ses_1', work_dir: homeDir });
  expect(created.status).toBe(201);
  const stream = await postStream(a.baseUrl, '/sessions/ses_1/prompt', promptBody);
  for (;;) {
    const frame = asFrame(await nextNdjsonFrame(stream.reader));
    // Registration (and the journal write) precede the request event.
    if (frame.type === requestType) break;
  }
  stream.reader.close();
  await a.server.close();
  return homeDir;
}

describe('recovery invariants over the journal fallback', () => {
  it('auto-skips approvals on recovery and never auto-replays the crashed turn', async () => {
    const homeDir = await crashWithPendingInteraction([APPROVAL_STEP], 'approval_request');
    const b = await bootTestServer({ homeDir });
    try {
      const res = await postJson(b.baseUrl, '/sessions/ses_1/resume', {});
      expect(res.status).toBe(200);
      // The crashed turn never completes, so the approval is auto-skipped
      // (dead-turn no-op) and does not show up in pending_calls.
      expect(res.body).toEqual({ session_id: 'ses_1', status: 'active', pending_calls: [] });

      // No auto-replay: the crashed turn is not relaunched and no approval /
      // question / tool request is re-emitted to the runtime or the client.
      const session = b.fake.sessions.get('ses_1');
      expect(session).toBeDefined();
      expect(session?.prompts).toEqual([]);
      expect(session?.approvalRequests).toEqual([]);
      expect(session?.questionRequests).toEqual([]);
      expect(session?.toolCallRequests).toEqual([]);
    } finally {
      await b.close();
    }
  });

  it('accepts resolution=skipped for a recovered unknown external call and terminates it', async () => {
    const homeDir = await crashWithPendingInteraction(TOOL_CALL_STEPS, 'external_tool_request');
    const b = await bootTestServer({ homeDir });
    try {
      const resumed = await postJson(b.baseUrl, '/sessions/ses_1/resume', {});
      expect(resumed.status).toBe(200);
      expect(resumed.body).toEqual({
        session_id: 'ses_1',
        status: 'active',
        pending_calls: [{ tool_call_id: 'call_ext', kind: 'external_tool', state: 'unknown' }],
      });

      const skipped = await postJson(b.baseUrl, '/sessions/ses_1/tool-results', {
        tool_call_id: 'call_ext',
        resolution: 'skipped',
      });
      expect(skipped.status).toBe(202);
      expect(skipped.body).toEqual({ accepted: true });

      // Terminal: the call no longer shows up on a subsequent resume.
      const again = await postJson(b.baseUrl, '/sessions/ses_1/resume', {});
      expect(again.body).toEqual({ session_id: 'ses_1', status: 'active', pending_calls: [] });

      // A late original result arriving after the skip is rejected.
      const late = await postJson(b.baseUrl, '/sessions/ses_1/tool-results', {
        tool_call_id: 'call_ext',
        resolution: 'completed',
        output: '{"rows":3}',
      });
      expect(late.status).toBe(409);
      expectErrorEnvelope(late.body, 'request_not_pending');
    } finally {
      await b.close();
    }
  });

  it('accepts a same idempotency-key prompt as a new execution after recovery (D6)', async () => {
    // Process A died mid-turn holding idempotency key key-1.
    const homeDir = await crashWithPendingInteraction([APPROVAL_STEP], 'approval_request', {
      content: 'go',
      idempotency_key: 'key-1',
    });
    const b = await bootTestServer({ homeDir });
    try {
      b.fake.setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', delta: 'again' }) },
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
      ]);
      const resumed = await postJson(b.baseUrl, '/sessions/ses_1/resume', {});
      expect(resumed.status).toBe(200);

      const stream = await postStream(b.baseUrl, '/sessions/ses_1/prompt', {
        content: 'go',
        idempotency_key: 'key-1',
      });
      expect(stream.response.status).toBe(200);
      const frames = await collectNdjson(stream.reader);
      // A new execution streams the turn's events; a replay of the first
      // terminal frame would be a lone prompt_done line with no prompt call.
      expect(asFrame(frames[0]).type).toBe('session.status_running');
      expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
      expect(b.fake.sessions.get('ses_1')?.prompts).toHaveLength(1);
    } finally {
      await b.close();
    }
  });
});

describe('pending-call journal fail-closed registration', () => {
  function failingPendingJournal(): PendingCallJournal {
    return {
      register: () => {
        throw new Error('disk full');
      },
      settle: () => {},
      read: () => [],
    };
  }

  it('emits no request event and settles the runtime neutrally when the journal write fails', async () => {
    const handle = await bootTestServer({ pendingJournal: failingPendingJournal() });
    try {
      handle.fake.setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        APPROVAL_STEP,
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
      ]);
      const created = await postJson(handle.baseUrl, '/sessions', {
        session_id: 'ses_1',
        work_dir: handle.homeDir,
      });
      expect(created.status).toBe(201);

      const stream = await postStream(handle.baseUrl, '/sessions/ses_1/prompt', { content: 'go' });
      expect(stream.response.status).toBe(200);
      const running = asFrame(await nextNdjsonFrame(stream.reader));
      expect(running.type).toBe('session.status_running');
      // Fail-closed: without a journal record the request is never emitted,
      // so no untracked pending call can hang.
      const next = asFrame(await nextNdjsonFrame(stream.reader));
      expect(next.type).not.toBe('approval_request');
      const frames = [running, next, ...(await collectNdjson(stream.reader))];
      expect(frameTypes(frames)).not.toContain('approval_request');
      // The runtime still receives the neutral fallback and the turn ends.
      expect(handle.fake.sessions.get('ses_1')?.approvalResponses).toEqual([{ decision: 'cancelled' }]);
      expect(frames.at(-1)).toEqual({ type: 'prompt_done', stop_reason: 'completed' });
    } finally {
      await handle.close();
    }
  });
});
