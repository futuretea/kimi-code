import { describe, expect, it } from 'vitest';

import { FacadeError, type FacadeErrorCode } from '../src/errors';
import {
  SessionRegistry,
  type RecoveredSession,
} from '../src/session-registry';

function expectFacadeError(fn: () => unknown, code: FacadeErrorCode): FacadeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FacadeError);
    expect((error as FacadeError).code).toBe(code);
    return error as FacadeError;
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

describe('create session', () => {
  it('creates an active session', () => {
    const registry = new SessionRegistry();
    expect(registry.createSession('ses_1')).toEqual({
      sessionId: 'ses_1',
      status: 'active',
    });
    expect(registry.getSession('ses_1')?.status).toBe('active');
  });

  it.each(['active', 'closed', 'failed'] as const)(
    'rejects create with the same id on a %s session',
    (state) => {
      const registry = new SessionRegistry();
      registry.createSession('ses_1');
      if (state === 'closed') registry.cancelSession('ses_1');
      if (state === 'failed') registry.markFailed('ses_1');
      expectFacadeError(() => registry.createSession('ses_1'), 'session_state_conflict');
    },
  );
});

describe('resume session', () => {
  it('rejects an unknown session id', async () => {
    const registry = new SessionRegistry();
    await expectAsyncFacadeError(() => registry.resumeSession('nope'), 'session_not_found');
  });

  it('is idempotent on an active session and reports pending calls', async () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'approval' });
    const first = await registry.resumeSession('ses_1');
    expect(first).toEqual({
      sessionId: 'ses_1',
      status: 'active',
      pendingCalls: [{ id: 'call_1', kind: 'approval', state: 'pending' }],
    });
    const second = await registry.resumeSession('ses_1');
    expect(second).toEqual(first);
  });

  it('rejects resume on a closed session', async () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.cancelSession('ses_1');
    await expectAsyncFacadeError(
      () => registry.resumeSession('ses_1'),
      'session_state_conflict',
    );
  });

  it('fails resume on a failed session without a journal recovery hook', async () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.markFailed('ses_1');
    await expectAsyncFacadeError(
      () => registry.resumeSession('ses_1'),
      'session_resume_failed',
    );
    expect(registry.getSession('ses_1')?.status).toBe('failed');
  });

  it('recovers a failed session from the journal with its pending calls', async () => {
    const recovered: RecoveredSession = {
      pendingCalls: [
        { id: 'call_old', kind: 'external_tool', state: 'unknown' },
        { id: 'call_new', kind: 'approval', state: 'pending' },
      ],
    };
    const registry = new SessionRegistry({ recoverFromJournal: async () => recovered });
    registry.createSession('ses_1');
    registry.registerPendingCall('ses_1', { id: 'call_stale', kind: 'question' });
    registry.markFailed('ses_1');

    const result = await registry.resumeSession('ses_1');
    expect(result).toEqual({
      sessionId: 'ses_1',
      status: 'active',
      pendingCalls: recovered.pendingCalls,
    });
    expect(registry.getSession('ses_1')?.status).toBe('active');
  });

  it('sanitizes journal recovery failures into session_resume_failed', async () => {
    const registry = new SessionRegistry({
      recoverFromJournal: async () => {
        throw new Error('kimi journal corrupt at /secret/path');
      },
    });
    registry.createSession('ses_1');
    registry.markFailed('ses_1');
    try {
      await registry.resumeSession('ses_1');
      throw new Error('expected resume to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(FacadeError);
      expect((error as FacadeError).code).toBe('session_resume_failed');
      expect((error as FacadeError).message).not.toContain('/secret/path');
    }
    expect(registry.getSession('ses_1')?.status).toBe('failed');
  });
});

describe('prompt state matrix', () => {
  it('rejects prompt on an unknown session', () => {
    const registry = new SessionRegistry();
    expectFacadeError(
      () => registry.startPrompt('nope', { content: 'hi' }),
      'session_not_found',
    );
  });

  it.each(['closed', 'failed'] as const)('rejects prompt on a %s session', (state) => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    if (state === 'closed') registry.cancelSession('ses_1');
    if (state === 'failed') registry.markFailed('ses_1');
    expectFacadeError(
      () => registry.startPrompt('ses_1', { content: 'hi' }),
      'prompt_rejected',
    );
  });

  it('accepts a prompt on an active session', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    expect(registry.startPrompt('ses_1', { content: 'hi' })).toEqual({ status: 'started' });
  });
});

describe('prompt idempotency', () => {
  it('rejects a concurrent prompt while a turn is in flight (busy)', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.startPrompt('ses_1', { content: 'first', idempotencyKey: 'key-1' });
    expectFacadeError(
      () => registry.startPrompt('ses_1', { content: 'first', idempotencyKey: 'key-1' }),
      'prompt_rejected',
    );
    expectFacadeError(
      () => registry.startPrompt('ses_1', { content: 'other', idempotencyKey: 'key-2' }),
      'prompt_rejected',
    );
    expectFacadeError(() => registry.startPrompt('ses_1', { content: 'other' }), 'prompt_rejected');
  });

  it('replays the first terminal frame for the same key and same content', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.startPrompt('ses_1', { content: 'first', idempotencyKey: 'key-1' });
    const frame = registry.finishPrompt('ses_1', 'completed');
    expect(frame).toEqual({ type: 'prompt_done', stop_reason: 'completed' });

    const replay = registry.startPrompt('ses_1', { content: 'first', idempotencyKey: 'key-1' });
    expect(replay).toEqual({ status: 'replayed', frame });

    // A replay must not start a new turn: a fresh prompt is accepted afterwards.
    expect(registry.startPrompt('ses_1', { content: 'next' })).toEqual({ status: 'started' });
  });

  it('rejects the same key with different content as session_state_conflict', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.startPrompt('ses_1', { content: 'first', idempotencyKey: 'key-1' });
    registry.finishPrompt('ses_1', 'completed');
    expectFacadeError(
      () => registry.startPrompt('ses_1', { content: 'changed', idempotencyKey: 'key-1' }),
      'session_state_conflict',
    );
  });

  it('scopes idempotency keys per session', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.createSession('ses_2');
    registry.startPrompt('ses_1', { content: 'first', idempotencyKey: 'key-1' });
    registry.finishPrompt('ses_1', 'completed');
    expect(registry.startPrompt('ses_2', { content: 'changed', idempotencyKey: 'key-1' })).toEqual({
      status: 'started',
    });
  });

  it('does not deduplicate prompts without an idempotency key', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.startPrompt('ses_1', { content: 'first' });
    registry.finishPrompt('ses_1', 'completed');
    expect(registry.startPrompt('ses_1', { content: 'first' })).toEqual({ status: 'started' });
  });

  it('rejects finishPrompt without an in-flight turn', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    expectFacadeError(() => registry.finishPrompt('ses_1', 'completed'), 'internal_error');
  });
});

describe('interrupt', () => {
  it('rejects interrupt on an unknown session', () => {
    const registry = new SessionRegistry();
    expectFacadeError(() => registry.interrupt('nope'), 'session_not_found');
  });

  it('rejects interrupt without an in-flight turn', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    expectFacadeError(() => registry.interrupt('ses_1'), 'session_state_conflict');
  });

  it('accepts interrupt with an in-flight turn', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.startPrompt('ses_1', { content: 'hi' });
    expect(registry.interrupt('ses_1')).toEqual({ accepted: true });
  });

  it.each(['closed', 'failed'] as const)('rejects interrupt on a %s session', (state) => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.startPrompt('ses_1', { content: 'hi' });
    if (state === 'closed') registry.cancelSession('ses_1');
    if (state === 'failed') registry.markFailed('ses_1');
    expectFacadeError(() => registry.interrupt('ses_1'), 'session_state_conflict');
  });
});

describe('cancel', () => {
  it('rejects cancel on an unknown session', () => {
    const registry = new SessionRegistry();
    expectFacadeError(() => registry.cancelSession('nope'), 'session_not_found');
  });

  it('terminates an active session and is idempotent afterwards', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    expect(registry.cancelSession('ses_1')).toEqual({ accepted: true });
    expect(registry.getSession('ses_1')?.status).toBe('closed');
    expect(registry.cancelSession('ses_1')).toEqual({ accepted: true });
  });

  it('is idempotent on a failed session and cleans it up to closed', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.markFailed('ses_1');
    expect(registry.cancelSession('ses_1')).toEqual({ accepted: true });
    expect(registry.getSession('ses_1')?.status).toBe('closed');
    expect(registry.cancelSession('ses_1')).toEqual({ accepted: true });
  });
});

describe('pending call correlation', () => {
  it('accepts an approval resolution for a pending approval call', async () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    const registration = registry.registerPendingCall('ses_1', {
      id: 'call_1',
      kind: 'approval',
    });
    expect(
      registry.resolveApproval('ses_1', { toolCallId: 'call_1', decision: 'approved' }),
    ).toEqual({ accepted: true });
    await expect(registration.resolution).resolves.toEqual({
      kind: 'approval',
      decision: 'approved',
      feedback: undefined,
    });
  });

  it('rejects unknown, duplicate, and kind-mismatched approval ids', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    expectFacadeError(
      () => registry.resolveApproval('ses_1', { toolCallId: 'nope', decision: 'approved' }),
      'request_not_pending',
    );

    registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'approval' });
    registry.resolveApproval('ses_1', { toolCallId: 'call_1', decision: 'rejected' });
    // duplicate resolution of an already terminal call
    expectFacadeError(
      () => registry.resolveApproval('ses_1', { toolCallId: 'call_1', decision: 'approved' }),
      'request_not_pending',
    );

    // a question id is not an approval tool_call_id
    registry.registerPendingCall('ses_1', { id: 'q_1', kind: 'question' });
    expectFacadeError(
      () => registry.resolveApproval('ses_1', { toolCallId: 'q_1', decision: 'approved' }),
      'request_not_pending',
    );
  });

  it('accepts question answers for a pending question call', async () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    const registration = registry.registerPendingCall('ses_1', {
      id: 'q_1',
      kind: 'question',
    });
    const answers = { 'Which env?': 'staging', Continue: true } as Record<string, string | true>;
    expect(registry.answerQuestion('ses_1', { questionId: 'q_1', answers })).toEqual({
      accepted: true,
    });
    await expect(registration.resolution).resolves.toEqual({ kind: 'question', answers });
    expectFacadeError(
      () => registry.answerQuestion('ses_1', { questionId: 'q_1', answers }),
      'request_not_pending',
    );
  });

  it('accepts external tool results and requires output for completed resolution', async () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    const registration = registry.registerPendingCall('ses_1', {
      id: 'call_1',
      kind: 'external_tool',
    });
    expectFacadeError(
      () =>
        registry.resolveToolResult('ses_1', { toolCallId: 'call_1', resolution: 'completed' }),
      'invalid_request',
    );
    // failed validation keeps the call pending: a retry is still accepted.
    expect(
      registry.resolveToolResult('ses_1', {
        toolCallId: 'call_1',
        resolution: 'completed',
        output: '{"rows":3}',
      }),
    ).toEqual({ accepted: true });
    await expect(registration.resolution).resolves.toEqual({
      kind: 'external_tool',
      resolution: 'completed',
      output: '{"rows":3}',
    });
  });

  it('accepts a skipped tool result without output', async () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    const registration = registry.registerPendingCall('ses_1', {
      id: 'call_1',
      kind: 'external_tool',
    });
    expect(
      registry.resolveToolResult('ses_1', { toolCallId: 'call_1', resolution: 'skipped' }),
    ).toEqual({ accepted: true });
    await expect(registration.resolution).resolves.toEqual({
      kind: 'external_tool',
      resolution: 'skipped',
      output: undefined,
    });
  });

  it('does not correlate calls across sessions', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.createSession('ses_2');
    registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'approval' });
    expectFacadeError(
      () => registry.resolveApproval('ses_2', { toolCallId: 'call_1', decision: 'approved' }),
      'request_not_pending',
    );
  });

  it('rejects resolutions on closed and failed sessions with session_state_conflict', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'approval' });
    registry.cancelSession('ses_1');
    expectFacadeError(
      () => registry.resolveApproval('ses_1', { toolCallId: 'call_1', decision: 'approved' }),
      'session_state_conflict',
    );

    registry.createSession('ses_2');
    registry.registerPendingCall('ses_2', { id: 'call_2', kind: 'approval' });
    registry.markFailed('ses_2');
    expectFacadeError(
      () => registry.resolveApproval('ses_2', { toolCallId: 'call_2', decision: 'approved' }),
      'session_state_conflict',
    );
  });

  it('rejects resolutions on an unknown session with session_not_found', () => {
    const registry = new SessionRegistry();
    expectFacadeError(
      () => registry.resolveApproval('nope', { toolCallId: 'call_1', decision: 'approved' }),
      'session_not_found',
    );
    expectFacadeError(
      () => registry.answerQuestion('nope', { questionId: 'q_1', answers: {} }),
      'session_not_found',
    );
    expectFacadeError(
      () => registry.resolveToolResult('nope', { toolCallId: 'call_1', resolution: 'skipped' }),
      'session_not_found',
    );
  });

  it('rejects late results for unknown-state calls after recovery, and accepts retries for still-pending calls', async () => {
    const registry = new SessionRegistry({
      recoverFromJournal: async () => ({
        pendingCalls: [
          { id: 'call_late', kind: 'external_tool', state: 'unknown' },
          { id: 'call_open', kind: 'external_tool', state: 'pending' },
        ],
      }),
    });
    registry.createSession('ses_1');
    registry.markFailed('ses_1');
    await registry.resumeSession('ses_1');

    // Late result for a call that was unconfirmed at crash time: never matched.
    expectFacadeError(
      () =>
        registry.resolveToolResult('ses_1', {
          toolCallId: 'call_late',
          resolution: 'completed',
          output: '{}',
        }),
      'request_not_pending',
    );
    // Explicit retry of a still-pending call with the same id is accepted.
    expect(
      registry.resolveToolResult('ses_1', {
        toolCallId: 'call_open',
        resolution: 'completed',
        output: '{}',
      }),
    ).toEqual({ accepted: true });
  });

  it('flips pending calls to unknown when the session fails', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    registry.registerPendingCall('ses_1', { id: 'call_1', kind: 'approval' });
    registry.markFailed('ses_1');
    expect(registry.listPendingCalls('ses_1')).toEqual([
      { id: 'call_1', kind: 'approval', state: 'unknown' },
    ]);
  });
});

describe('event stream gating', () => {
  it('allows streaming on an active session only', () => {
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    expect(() => registry.assertEventStreamAllowed('ses_1')).not.toThrow();
    registry.cancelSession('ses_1');
    expectFacadeError(() => registry.assertEventStreamAllowed('ses_1'), 'session_state_conflict');

    registry.createSession('ses_2');
    registry.markFailed('ses_2');
    expectFacadeError(() => registry.assertEventStreamAllowed('ses_2'), 'session_state_conflict');

    expectFacadeError(() => registry.assertEventStreamAllowed('nope'), 'session_not_found');
  });
});
