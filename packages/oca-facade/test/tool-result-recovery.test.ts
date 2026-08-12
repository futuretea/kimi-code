import { describe, expect, it } from 'vitest';

import {
  LiveHarnessFactory,
  type FacadeEvent,
  type HarnessEventSink,
} from '../src/harness';
import {
  SessionRegistry,
  type PendingCall,
  type PendingCallJournal,
  type StagedToolResult,
  type ToolResultDeliveryState,
} from '../src/session-registry';

import { createFakeHarness } from './fake-harness';

class MemoryPendingJournal implements PendingCallJournal {
  private calls: PendingCall[];
  failSettle = false;

  constructor(calls: PendingCall[]) {
    this.calls = calls.map(copyCall);
  }

  register(_sessionId: string, call: PendingCall): void {
    this.calls = [...this.calls.filter((stored) => stored.id !== call.id), copyCall(call)];
  }

  stageToolResult(_sessionId: string, callId: string, result: StagedToolResult): void {
    this.update(callId, (call) => ({
      ...call,
      stagedToolResult: result,
      toolResultDeliveryState: 'staged',
    }));
  }

  setToolResultDeliveryState(
    _sessionId: string,
    callId: string,
    state: ToolResultDeliveryState,
  ): void {
    this.update(callId, (call) => ({ ...call, toolResultDeliveryState: state }));
  }

  settleUnknownToolCall(_sessionId: string, callId: string): void {
    this.update(callId, (call) => ({ ...call, state: 'settled' }));
  }

  settle(_sessionId: string, callId: string): void {
    if (this.failSettle) throw new Error('journal cleanup failed');
    this.calls = this.calls.filter((call) => call.id !== callId);
  }

  read(_sessionId: string): PendingCall[] {
    return this.calls.map(copyCall);
  }

  private update(callId: string, update: (call: PendingCall) => PendingCall): void {
    const existing = this.calls.find((call) => call.id === callId);
    if (existing === undefined) throw new Error('missing pending call');
    this.calls = this.calls.map((call) => (call.id === callId ? update(call) : call));
  }
}

function copyCall(call: PendingCall): PendingCall {
  return {
    ...call,
    ...(call.stagedToolResult !== undefined ? { stagedToolResult: { ...call.stagedToolResult } } : {}),
  };
}

describe('recovered external-tool result delivery', () => {
  it('does not re-emit external_tool_request when a resumed runtime consumes a staged result', async () => {
    const journal = new MemoryPendingJournal([
      {
        id: 'call_1',
        kind: 'external_tool',
        state: 'pending',
        stagedToolResult: {
          resolution: 'completed',
          output: '{"rows":3}',
          systemMessage: 'Use the billing result as evidence.',
        },
        toolResultDeliveryState: 'staged',
      },
    ]);
    const registry = new SessionRegistry({
      pendingJournal: journal,
      recoverFromJournal: async () => ({ pendingCalls: [] }),
    });
    await registry.resumeSession('ses_1');

    const events: FacadeEvent[] = [];
    const sink: HarnessEventSink = {
      emit: (_sessionId, event) => events.push(event),
      turnEnded: () => {},
    };
    const { fake, createHarness } = createFakeHarness();
    const harness = new LiveHarnessFactory({ registry, sink, createHarness });
    await harness.resumeSession('ses_1');

    const session = fake.sessions.get('ses_1');
    const response = await session?.toolCallHandler?.({ toolCallId: 'call_1', args: { month: '2026-07' } });

    expect(response).toEqual({ output: '{"rows":3}', isError: false });
    expect(events).toEqual([]);
    expect(session?.systemMessages).toEqual(['Use the billing result as evidence.']);
    expect(journal.read('ses_1')).toEqual([]);
  });

  it('does not redeliver a runtime-accepted result after journal cleanup fails', async () => {
    const journal = new MemoryPendingJournal([]);
    journal.failSettle = true;
    const registry = new SessionRegistry({ pendingJournal: journal });
    registry.createSession('ses_1');
    const firstEvents: FacadeEvent[] = [];
    const firstSink: HarnessEventSink = {
      emit: (_sessionId, event) => firstEvents.push(event),
      turnEnded: () => {},
    };
    const firstRuntime = createFakeHarness();
    const firstHarness = new LiveHarnessFactory({
      registry,
      sink: firstSink,
      createHarness: firstRuntime.createHarness,
    });
    await firstHarness.createSession({ sessionId: 'ses_1', workDir: '/tmp' });

    const firstSession = firstRuntime.fake.sessions.get('ses_1');
    if (firstSession?.toolCallHandler === undefined) throw new Error('missing tool-call handler');
    const runtimeResponse = firstSession.toolCallHandler({ toolCallId: 'call_1', args: {} });
    const accepted = registry.resolveToolResult('ses_1', {
      toolCallId: 'call_1',
      resolution: 'completed',
      output: '{"rows":3}',
      systemMessage: 'Use the billing result as evidence.',
    });

    await expect(runtimeResponse).resolves.toEqual({ output: '{"rows":3}', isError: false });
    await expect(accepted).resolves.toEqual({ accepted: true });
    expect(firstSession.systemMessages).toEqual(['Use the billing result as evidence.']);
    expect(journal.read('ses_1')).toEqual([
      expect.objectContaining({ id: 'call_1', toolResultDeliveryState: 'delivered' }),
    ]);

    const restarted = new SessionRegistry({
      pendingJournal: journal,
      recoverFromJournal: async () => ({ pendingCalls: [] }),
    });
    await expect(restarted.resumeSession('ses_1')).resolves.toMatchObject({
      pendingCalls: [{ id: 'call_1', kind: 'external_tool', state: 'unknown' }],
    });
    const restartEvents: FacadeEvent[] = [];
    const restartRuntime = createFakeHarness();
    const restartHarness = new LiveHarnessFactory({
      registry: restarted,
      sink: {
        emit: (_sessionId, event) => restartEvents.push(event),
        turnEnded: () => {},
      },
      createHarness: restartRuntime.createHarness,
    });
    await restartHarness.resumeSession('ses_1');

    journal.failSettle = false;
    await expect(
      restarted.resolveToolResult('ses_1', { toolCallId: 'call_1', resolution: 'skipped' }),
    ).resolves.toEqual({ accepted: true });
    const restartSession = restartRuntime.fake.sessions.get('ses_1');
    if (restartSession?.toolCallHandler === undefined) throw new Error('missing tool-call handler');
    await expect(restartSession.toolCallHandler({ toolCallId: 'call_1', args: {} })).resolves.toEqual({
      output: 'The session no longer accepts tool results.',
      isError: true,
    });
    expect(restartEvents).toEqual([]);
    expect(restartSession.systemMessages).toEqual([]);
    expect(journal.read('ses_1')).toEqual([
      expect.objectContaining({ id: 'call_1', state: 'settled' }),
    ]);

    const settledRestart = new SessionRegistry({
      pendingJournal: journal,
      recoverFromJournal: async () => ({ pendingCalls: [] }),
    });
    await expect(settledRestart.resumeSession('ses_1')).resolves.toMatchObject({
      pendingCalls: [],
    });
    const settledRestartEvents: FacadeEvent[] = [];
    const settledRestartRuntime = createFakeHarness();
    const settledRestartHarness = new LiveHarnessFactory({
      registry: settledRestart,
      sink: {
        emit: (_sessionId, event) => settledRestartEvents.push(event),
        turnEnded: () => {},
      },
      createHarness: settledRestartRuntime.createHarness,
    });
    await settledRestartHarness.resumeSession('ses_1');

    const settledRestartSession = settledRestartRuntime.fake.sessions.get('ses_1');
    if (settledRestartSession?.toolCallHandler === undefined) {
      throw new Error('missing tool-call handler');
    }
    await expect(
      settledRestartSession.toolCallHandler({ toolCallId: 'call_1', args: {} }),
    ).resolves.toEqual({
      output: 'The session no longer accepts tool results.',
      isError: true,
    });
    expect(settledRestartEvents).toEqual([]);
    expect(settledRestartSession.systemMessages).toEqual([]);
  });
});
