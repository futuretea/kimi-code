import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LiveHarnessFactory, type FacadeEvent, type HarnessEventSink } from '../src/harness';
import { SessionRegistry, type StopReason } from '../src/session-registry';

import { createFakeHarness, runtimeEvent, type FakeHarness } from './fake-harness';

interface RecordedSink extends HarnessEventSink {
  events: Array<{ sessionId: string; event: FacadeEvent }>;
  turnEnds: Array<{ sessionId: string; stopReason: StopReason }>;
}

function makeSink(): RecordedSink {
  const events: RecordedSink['events'] = [];
  const turnEnds: RecordedSink['turnEnds'] = [];
  return {
    events,
    turnEnds,
    emit(sessionId, event) {
      events.push({ sessionId, event });
    },
    turnEnded(sessionId, stopReason) {
      turnEnds.push({ sessionId, stopReason });
    },
  };
}

interface Setup {
  registry: SessionRegistry;
  sink: RecordedSink;
  fake: FakeHarness;
  harness: LiveHarnessFactory;
}

/** Yields until the pending call appears (replay continues on microtasks). */
async function waitForPendingCall(
  registry: SessionRegistry,
  sessionId: string,
  id: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (registry.listPendingCalls(sessionId).some((call) => call.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`pending call ${id} did not appear`);
}

const tempDirs: string[] = [];

async function setup(): Promise<Setup> {
  const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-bridge-'));
  tempDirs.push(workDir);
  const registry = new SessionRegistry();
  registry.createSession('ses_1');
  const sink = makeSink();
  const { fake, createHarness } = createFakeHarness();
  const harness = new LiveHarnessFactory({ registry, sink, createHarness });
  await harness.createSession({ sessionId: 'ses_1', workDir });
  return { registry, sink, fake, harness };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('event bridge: public-aligned events', () => {
  it('maps runtime stream events to facade events in order', async () => {
    const { sink, fake, harness } = await setup();
		await harness.updateSessionConfig('ses_1', {
			tools: [{
				type: 'agent_toolset_20260401',
				configs: [{ name: 'Bash', permissionPolicy: { type: 'always_allow' } }],
			}],
		});
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }) },
      { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', turnId: 1, delta: 'Hello' }) },
      { kind: 'event', event: runtimeEvent({ type: 'thinking.delta', turnId: 1, delta: 'hmm' }) },
      { kind: 'event', event: runtimeEvent({ type: 'compaction.completed', turnId: 1, result: { contextSummary: 'private summary', tokenCount: 99 } }) },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_1', name: 'Bash', args: { command: 'ls' } }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.result', turnId: 1, toolCallId: 'call_1', output: { code: 1 }, isError: false }),
      },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }) },
    ]);
    await harness.prompt('ses_1', 'hi');
    expect(sink.events.map(({ event }) => event)).toEqual([
      { type: 'session.status_running' },
      { type: 'agent.message', content: 'Hello' },
      { type: 'agent.thinking', content: 'hmm' },
      { type: 'agent.thread_context_compacted' },
      { type: 'agent.tool_use', id: 'call_1', name: 'Bash', arguments: { command: 'ls' }, evaluated_permission: 'allow' },
      { type: 'agent.tool_result', id: 'call_1', content: [{ type: 'text', text: '{"code":1}' }], is_error: false },
      { type: 'session.status_idle' },
    ]);
    expect(sink.turnEnds).toEqual([{ sessionId: 'ses_1', stopReason: 'completed' }]);
  });

  it('does not publish built-in tool events for a custom tool callback', async () => {
    const { fake, harness, sink } = await setup();
    await harness.updateSessionConfig('ses_1', {
      tools: [{
        type: 'custom',
        name: 'lookup_order',
        description: 'Look up an order',
        inputSchema: { type: 'object' },
      }],
    });
    fake.setScript('ses_1', [
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'tool.call.started', turnId: 1, toolCallId: 'call_custom', name: 'lookup_order', args: { order_id: 'o_1' },
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.result', turnId: 1, toolCallId: 'call_custom', output: 'shipped' }),
      },
    ]);

    await harness.prompt('ses_1', 'look up order');

    expect(sink.events).toEqual([]);
  });

  it('maps qualified server tool calls to the dedicated facade events', async () => {
    const { sink, fake, harness } = await setup();
		await harness.updateSessionConfig('ses_1', {
			tools: [{
				type: 'mcp_toolset',
				mcpServerName: 'billing',
				configs: [{ name: 'query_invoices', permissionPolicy: { type: 'always_allow' } }],
			}],
		});
    fake.setScript('ses_1', [
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'tool.call.started',
          turnId: 1,
          toolCallId: 'call_9',
          name: 'mcp__billing__query_invoices',
          args: { month: '2026-07' },
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.result', turnId: 1, toolCallId: 'call_9', output: 'bad auth', isError: true }),
      },
    ]);
    await harness.prompt('ses_1', 'hi');
    expect(sink.events.map(({ event }) => event)).toEqual([
      {
        type: 'agent.mcp_tool_use',
        id: 'call_9',
        server_name: 'billing',
        tool_name: 'query_invoices',
        arguments: { month: '2026-07' },
			evaluated_permission: 'allow',
      },
      { type: 'agent.mcp_tool_result', id: 'call_9', content: [{ type: 'text', text: 'bad auth' }], is_error: true },
    ]);
  });

  it('routes child thinking and tool events to its lifecycle identity without leaking reasoning', async () => {
    const { sink, fake, harness } = await setup();
		await harness.updateSessionConfig('ses_1', {
			tools: [
				{ type: 'agent_toolset_20260401', configs: [{ name: 'Read', permissionPolicy: { type: 'always_allow' } }] },
				{ type: 'mcp_toolset', mcpServerName: 'billing', configs: [{ name: 'get_invoice', permissionPolicy: { type: 'always_allow' } }] },
			],
		});
    fake.setScript('ses_1', [
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'subagent.spawned',
          subagentId: 'runtime_child_1',
          subagentName: 'roster_1',
          parentToolCallId: 'call_parent',
          runInBackground: false,
        }),
      },
      { kind: 'event', event: runtimeEvent({ type: 'subagent.started', subagentId: 'runtime_child_1' }) },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'thinking.delta', agentId: 'runtime_child_1', turnId: 2, delta: 'private child reasoning' }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'thinking.delta', agentId: 'runtime_child_1', turnId: 2, delta: 'still private' }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'compaction.completed', agentId: 'runtime_child_1', result: { contextSummary: 'private child summary', tokenCount: 99 },
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'assistant.delta',
          agentId: 'runtime_child_1',
          turnId: 2,
          delta: 'private child output',
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'tool.call.started',
          agentId: 'runtime_child_1',
          turnId: 2,
          toolCallId: 'child_call_1',
          name: 'Read',
          args: { path: 'README.md' },
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'tool.result',
          agentId: 'runtime_child_1',
          turnId: 2,
          toolCallId: 'child_call_1',
          output: { size: 42 },
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'tool.call.started',
          agentId: 'runtime_child_1',
          turnId: 2,
          toolCallId: 'child_call_2',
          name: 'mcp__billing__get_invoice',
          args: { invoice: 'inv_1' },
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'tool.result',
          agentId: 'runtime_child_1',
          turnId: 2,
          toolCallId: 'child_call_2',
          output: 'not found',
          isError: true,
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'turn.ended',
          agentId: 'runtime_child_1',
          turnId: 2,
          reason: 'completed',
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'subagent.failed',
          subagentId: 'runtime_child_1',
          error: 'private child failure',
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'subagent.suspended',
          subagentId: 'runtime_child_1',
          reason: 'private child suspension',
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'subagent.completed',
          subagentId: 'runtime_child_1',
          resultSummary: 'private child conclusion',
        }),
      },
      { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', turnId: 1, delta: 'parent output' }) },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }) },
    ]);

    await harness.prompt('ses_1', 'hi');

    expect(sink.events.map(({ event }) => event)).toEqual([
      { type: 'subagent.spawned', runtime_agent_id: 'runtime_child_1', profile_name: 'roster_1' },
      { type: 'subagent.started', runtime_agent_id: 'runtime_child_1' },
      { type: 'subagent.thinking', runtime_agent_id: 'runtime_child_1' },
      { type: 'subagent.thread_context_compacted', runtime_agent_id: 'runtime_child_1' },
      { type: 'subagent.message', runtime_agent_id: 'runtime_child_1', content: 'private child output' },
      {
        type: 'subagent.tool_use',
        runtime_agent_id: 'runtime_child_1',
        id: 'child_call_1',
        name: 'Read',
        arguments: { path: 'README.md' },
        evaluated_permission: 'allow',
      },
      {
        type: 'subagent.tool_result',
        runtime_agent_id: 'runtime_child_1',
        id: 'child_call_1',
        content: [{ type: 'text', text: '{"size":42}' }],
        is_error: false,
      },
      {
        type: 'subagent.mcp_tool_use',
        runtime_agent_id: 'runtime_child_1',
        id: 'child_call_2',
        server_name: 'billing',
        tool_name: 'get_invoice',
        arguments: { invoice: 'inv_1' },
        evaluated_permission: 'allow',
      },
      {
        type: 'subagent.mcp_tool_result',
        runtime_agent_id: 'runtime_child_1',
        id: 'child_call_2',
        content: [{ type: 'text', text: 'not found' }],
        is_error: true,
      },
      { type: 'subagent.failed', runtime_agent_id: 'runtime_child_1' },
      { type: 'subagent.suspended', runtime_agent_id: 'runtime_child_1' },
      { type: 'subagent.completed', runtime_agent_id: 'runtime_child_1' },
      { type: 'agent.message', content: 'parent output' },
      { type: 'session.status_idle' },
    ]);
    expect(sink.turnEnds).toEqual([{ sessionId: 'ses_1', stopReason: 'completed' }]);
    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain('private child failure');
    expect(serialized).not.toContain('private child conclusion');
    expect(serialized).not.toContain('private child reasoning');
		expect(serialized).not.toContain('private child summary');
    expect(serialized).not.toContain('still private');
  });

  it('keeps colliding child tool call IDs scoped to their runtime identities', async () => {
    const { sink, fake, harness } = await setup();
		await harness.updateSessionConfig('ses_1', {
			tools: [
				{ type: 'agent_toolset_20260401', configs: [{ name: 'Read', permissionPolicy: { type: 'always_allow' } }] },
				{ type: 'mcp_toolset', mcpServerName: 'billing', configs: [{ name: 'get_invoice', permissionPolicy: { type: 'always_allow' } }] },
			],
		});
    fake.setScript('ses_1', [
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'subagent.spawned', subagentId: 'runtime_child_1', subagentName: 'roster_1', parentToolCallId: 'parent_1', runInBackground: false,
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'subagent.spawned', subagentId: 'runtime_child_2', subagentName: 'roster_2', parentToolCallId: 'parent_2', runInBackground: false,
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.call.started', agentId: 'runtime_child_1', turnId: 2, toolCallId: 'shared_call', name: 'Read', args: {} }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.call.started', agentId: 'runtime_child_2', turnId: 3, toolCallId: 'shared_call', name: 'mcp__billing__get_invoice', args: {} }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.result', agentId: 'runtime_child_1', turnId: 2, toolCallId: 'shared_call', output: 'file body' }),
      },
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.result', agentId: 'runtime_child_2', turnId: 3, toolCallId: 'shared_call', output: 'invoice body' }),
      },
    ]);

    await harness.prompt('ses_1', 'hi');

    expect(sink.events.map(({ event }) => event)).toEqual([
      { type: 'subagent.spawned', runtime_agent_id: 'runtime_child_1', profile_name: 'roster_1' },
      { type: 'subagent.spawned', runtime_agent_id: 'runtime_child_2', profile_name: 'roster_2' },
      { type: 'subagent.tool_use', runtime_agent_id: 'runtime_child_1', id: 'shared_call', name: 'Read', arguments: {}, evaluated_permission: 'allow' },
      {
        type: 'subagent.mcp_tool_use', runtime_agent_id: 'runtime_child_2', id: 'shared_call', server_name: 'billing', tool_name: 'get_invoice', arguments: {}, evaluated_permission: 'allow',
      },
      { type: 'subagent.tool_result', runtime_agent_id: 'runtime_child_1', id: 'shared_call', content: [{ type: 'text', text: 'file body' }], is_error: false },
      { type: 'subagent.mcp_tool_result', runtime_agent_id: 'runtime_child_2', id: 'shared_call', content: [{ type: 'text', text: 'invoice body' }], is_error: false },
    ]);
  });

  it.each(['completed', 'cancelled', 'failed', 'blocked'] as const)(
    'forwards turn end reason %s as the stop reason',
    async (reason) => {
      const { sink, fake, harness } = await setup();
      fake.setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', turnId: 1, reason }) },
      ]);
      await harness.prompt('ses_1', 'hi');
      expect(sink.turnEnds).toEqual([{ sessionId: 'ses_1', stopReason: reason }]);
      expect(sink.events.map(({ event }) => event)).toEqual([{ type: 'session.status_idle' }]);
    },
  );

  it('sanitizes runtime error events into neutral session errors', async () => {
    const { sink, fake, harness } = await setup();
    fake.setScript('ses_1', [
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'error',
          code: 'provider.api_error',
          message: 'raw detail: /home/user/.private/config.toml unreachable',
          retryable: false,
        }),
      },
    ]);
    await harness.prompt('ses_1', 'hi');
    expect(sink.events).toHaveLength(1);
    const event = sink.events[0]?.event as { type: string; message: string; code: string };
    expect(event.type).toBe('session.error');
    expect(event.code).toBe('internal_error');
    expect(event.message).not.toContain('/home/user');
  });

  it('ignores runtime events without a facade mapping', async () => {
    const { sink, fake, harness } = await setup();
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'turn.step.started', turnId: 1, step: 1 }) },
      { kind: 'event', event: runtimeEvent({ type: 'tool.progress', turnId: 1, toolCallId: 'c', update: { kind: 'stdout', text: 'x' } }) },
      { kind: 'event', event: runtimeEvent({ type: 'agent.status.updated', contextTokens: 10 }) },
    ]);
    await harness.prompt('ses_1', 'hi');
    expect(sink.events).toEqual([]);
  });
});

describe('pending call bridge: approval', () => {
  it('auto-approves a custom tool so its client callback has no confirmation round trip', async () => {
    const { registry, sink, fake, harness } = await setup();
    await harness.updateSessionConfig('ses_1', {
      tools: [{
        type: 'custom',
        name: 'lookup_order',
        description: 'Look up an order',
        inputSchema: { type: 'object' },
      }],
    });
    const handler = fake.sessions.get('ses_1')?.approvalHandler;
    expect(handler).toBeDefined();

    const approval = handler!({
      toolCallId: 'call_custom',
      toolName: 'lookup_order',
      action: 'execute',
      display: { kind: 'generic', summary: 'look up order' },
    });
    let timedOut = false;
    try {
      const result = await Promise.race([
        approval,
        new Promise<{ timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ timedOut: true }), 25);
        }),
      ]);
      timedOut = 'timedOut' in result;
      expect(result).toEqual({ decision: 'approved' });
      expect(sink.events).toEqual([]);
      expect(registry.listPendingCalls('ses_1')).toEqual([]);
    } finally {
      if (timedOut) {
        registry.resolveApproval('ses_1', { toolCallId: 'call_custom', decision: 'approved' });
        await approval;
      }
    }
  });

  it('emits approval_request and resolves the runtime handler from the registry', async () => {
    const { registry, sink, fake, harness } = await setup();
    fake.setScript('ses_1', [
      {
        kind: 'approval',
        request: { toolCallId: 'call_7', toolName: 'run_tests', action: 'execute', display: { kind: 'command', command: 'pnpm test' } },
      },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }) },
    ]);
    const promptDone = harness.prompt('ses_1', 'run the tests');

    // The request is emitted synchronously up to the point the handler awaits.
    expect(sink.events.map(({ event }) => event)).toEqual([
      {
        type: 'approval_request',
        tool_call_id: 'call_7',
        tool_name: 'run_tests',
        action: 'execute',
        display: { kind: 'command', command: 'pnpm test' },
      },
    ]);
    expect(registry.listPendingCalls('ses_1')).toEqual([
      { id: 'call_7', kind: 'approval', state: 'pending' },
    ]);

    registry.resolveApproval('ses_1', { toolCallId: 'call_7', decision: 'approved' });
    await promptDone;
    expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([{ decision: 'approved' }]);
    expect(registry.listPendingCalls('ses_1')).toEqual([]);
  });

  it('forwards rejection feedback to the runtime', async () => {
    const { registry, fake, harness } = await setup();
    fake.setScript('ses_1', [
      { kind: 'approval', request: { toolCallId: 'call_8', toolName: 'deploy', action: 'execute', display: { kind: 'generic', summary: 'run tool' } } },
    ]);
    const promptDone = harness.prompt('ses_1', 'deploy');
    registry.resolveApproval('ses_1', {
      toolCallId: 'call_8',
      decision: 'rejected',
      feedback: 'not on a Friday',
    });
    await promptDone;
    expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([
      { decision: 'rejected', feedback: 'not on a Friday' },
    ]);
  });

  it('approves approval-worthy actions without a round trip under always_allow', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-bridge-'));
    tempDirs.push(workDir);
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    const sink = makeSink();
    const { fake, createHarness } = createFakeHarness();
    const harness = new LiveHarnessFactory({ registry, sink, createHarness });
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [{ name: 'Bash', permissionPolicy: { type: 'always_allow' } }],
      }],
    });
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_1', name: 'Bash', args: {} }) },
      { kind: 'approval', request: { toolCallId: 'call_1', toolName: 'Bash', action: 'execute', display: { kind: 'generic', summary: 'run tool' } } },
    ]);

    await harness.prompt('ses_1', 'hi');

    expect(sink.events.map(({ event }) => event)).toEqual([
      { type: 'agent.tool_use', id: 'call_1', name: 'Bash', arguments: {}, evaluated_permission: 'allow' },
    ]);
    expect(registry.listPendingCalls('ses_1')).toEqual([]);
    expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([{ decision: 'approved' }]);
  });

  it('requests confirmation under explicit always_ask', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-bridge-'));
    tempDirs.push(workDir);
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    const sink = makeSink();
    const { fake, createHarness } = createFakeHarness();
    const harness = new LiveHarnessFactory({ registry, sink, createHarness });
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [{ name: 'Bash', permissionPolicy: { type: 'always_ask' } }],
      }],
    });
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_1', name: 'Bash', args: {} }) },
      { kind: 'approval', request: { toolCallId: 'call_1', toolName: 'Bash', action: 'execute', display: { kind: 'generic', summary: 'run tool' } } },
    ]);

    const promptDone = harness.prompt('ses_1', 'hi');
    expect(sink.events.map(({ event }) => event)).toEqual([
      {
        type: 'approval_request',
        tool_call_id: 'call_1',
        tool_name: 'Bash',
        arguments: {},
        action: 'execute',
        display: { kind: 'generic', summary: 'run tool' },
      },
    ]);
    registry.resolveApproval('ses_1', { toolCallId: 'call_1', decision: 'approved' });
    await promptDone;
    expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([{ decision: 'approved' }]);
  });

	it('routes a child approval as one thread-scoped event with its arguments', async () => {
		const { registry, sink, fake, harness } = await setup();
		fake.setScript('ses_1', [
			{
				kind: 'event',
				event: runtimeEvent({
					type: 'subagent.spawned', subagentId: 'runtime_child_1', subagentName: 'roster_1', parentToolCallId: 'parent_1', runInBackground: false,
				}),
			},
			{
				kind: 'event',
				event: runtimeEvent({
					type: 'tool.call.started', agentId: 'runtime_child_1', turnId: 2, toolCallId: 'child_call_1', name: 'Read', args: { path: 'README.md' },
				}),
			},
			{
				kind: 'approval',
				request: {
					toolCallId: 'child_call_1', toolName: 'Read', agentId: 'runtime_child_1', action: 'execute', display: { kind: 'generic', summary: 'read a file' },
				},
			},
		]);

		const promptDone = harness.prompt('ses_1', 'hi');
		expect(sink.events.map(({ event }) => event)).toEqual([
			{ type: 'subagent.spawned', runtime_agent_id: 'runtime_child_1', profile_name: 'roster_1' },
			{
				type: 'approval_request',
				tool_call_id: 'child_call_1',
				runtime_agent_id: 'runtime_child_1',
				tool_name: 'Read',
				arguments: { path: 'README.md' },
				action: 'execute',
				display: { kind: 'generic', summary: 'read a file' },
			},
		]);
		expect(registry.listPendingCalls('ses_1')).toEqual([{ id: 'child_call_1', kind: 'approval', state: 'pending' }]);
		registry.resolveApproval('ses_1', { toolCallId: 'child_call_1', runtimeAgentId: 'runtime_child_1', decision: 'approved' });
		await promptDone;
		expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([{ decision: 'approved' }]);
	});

	it('keeps a child profile permission policy after facade recovery', async () => {
		const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-child-policy-'));
		tempDirs.push(workDir);
		const createRegistry = new SessionRegistry();
		createRegistry.createSession('ses_1');
		const initial = createFakeHarness();
		const creatingHarness = new LiveHarnessFactory({ registry: createRegistry, sink: makeSink(), createHarness: initial.createHarness });
		await creatingHarness.createSession({
			sessionId: 'ses_1',
			workDir,
			tools: [{
				type: 'agent_toolset_20260401',
				configs: [
					{ name: 'Bash', permissionPolicy: { type: 'always_allow' } },
					{ name: 'Read', permissionPolicy: { type: 'always_allow' } },
				],
			}],
			agentProfiles: {
				mainProfile: 'coordinator',
				profiles: [
					{ name: 'coordinator', tools: ['Agent'] },
					{ name: 'roster_1', tools: ['Bash', 'Read'], permissionPolicies: { Bash: 'always_deny' } },
				],
			},
		});

		const resumeRegistry = new SessionRegistry();
		resumeRegistry.createSession('ses_1');
		const sink = makeSink();
		const resumed = createFakeHarness();
		const resumedHarness = new LiveHarnessFactory({ registry: resumeRegistry, sink, createHarness: resumed.createHarness, resumeWorkDir: workDir });
		await resumedHarness.resumeSession('ses_1');
		resumed.fake.setScript('ses_1', [
			{ kind: 'event', event: runtimeEvent({ type: 'subagent.spawned', subagentId: 'runtime_child_1', subagentName: 'roster_1', parentToolCallId: 'parent_1', runInBackground: false }) },
			{ kind: 'event', event: runtimeEvent({ type: 'tool.call.started', agentId: 'runtime_child_1', turnId: 2, toolCallId: 'child_call_1', name: 'Bash', args: { command: 'id' } }) },
			{ kind: 'approval', request: { toolCallId: 'child_call_1', toolName: 'Bash', agentId: 'runtime_child_1', action: 'execute', display: { kind: 'generic', summary: 'run Bash' } } },
			{ kind: 'event', event: runtimeEvent({ type: 'tool.call.started', agentId: 'runtime_child_1', turnId: 2, toolCallId: 'child_call_2', name: 'Read', args: { path: 'README.md' } }) },
			{ kind: 'approval', request: { toolCallId: 'child_call_2', toolName: 'Read', agentId: 'runtime_child_1', action: 'execute', display: { kind: 'generic', summary: 'read README' } } },
		]);
		await resumedHarness.prompt('ses_1', 'delegate this');

		expect(sink.events.map(({ event }) => event)).toEqual([
			{ type: 'subagent.spawned', runtime_agent_id: 'runtime_child_1', profile_name: 'roster_1' },
			{ type: 'subagent.tool_use', runtime_agent_id: 'runtime_child_1', id: 'child_call_1', name: 'Bash', arguments: { command: 'id' }, evaluated_permission: 'deny' },
			{ type: 'subagent.tool_use', runtime_agent_id: 'runtime_child_1', id: 'child_call_2', name: 'Read', arguments: { path: 'README.md' }, evaluated_permission: 'allow' },
		]);
		expect(resumed.fake.sessions.get('ses_1')?.approvalResponses).toEqual([
			{ decision: 'rejected', feedback: 'Denied by the session permission policy.' },
			{ decision: 'approved' },
		]);
	});

	it('keeps colliding child approval IDs independently confirmable', async () => {
		const { registry, sink, fake, harness } = await setup();
		fake.setScript('ses_1', [
			{ kind: 'event', event: runtimeEvent({ type: 'subagent.spawned', subagentId: 'runtime_child_1', subagentName: 'roster_1', parentToolCallId: 'parent_1', runInBackground: false }) },
			{ kind: 'event', event: runtimeEvent({ type: 'tool.call.started', agentId: 'runtime_child_1', turnId: 2, toolCallId: 'shared_call', name: 'Read', args: { path: 'one.md' } }) },
			{ kind: 'event', event: runtimeEvent({ type: 'subagent.spawned', subagentId: 'runtime_child_2', subagentName: 'roster_2', parentToolCallId: 'parent_2', runInBackground: false }) },
			{ kind: 'event', event: runtimeEvent({ type: 'tool.call.started', agentId: 'runtime_child_2', turnId: 3, toolCallId: 'shared_call', name: 'Read', args: { path: 'two.md' } }) },
		]);
		await harness.prompt('ses_1', 'hi');

		const handler = fake.sessions.get('ses_1')?.approvalHandler;
		const first = handler!({ toolCallId: 'shared_call', toolName: 'Read', agentId: 'runtime_child_1', action: 'execute', display: { kind: 'generic', summary: 'read one' } });
		const second = handler!({ toolCallId: 'shared_call', toolName: 'Read', agentId: 'runtime_child_2', action: 'execute', display: { kind: 'generic', summary: 'read two' } });

		expect(sink.events.map(({ event }) => event).slice(-2)).toEqual([
			{ type: 'approval_request', tool_call_id: 'shared_call', runtime_agent_id: 'runtime_child_1', tool_name: 'Read', arguments: { path: 'one.md' }, action: 'execute', display: { kind: 'generic', summary: 'read one' } },
			{ type: 'approval_request', tool_call_id: 'shared_call', runtime_agent_id: 'runtime_child_2', tool_name: 'Read', arguments: { path: 'two.md' }, action: 'execute', display: { kind: 'generic', summary: 'read two' } },
		]);
		registry.resolveApproval('ses_1', { toolCallId: 'shared_call', runtimeAgentId: 'runtime_child_2', decision: 'rejected' });
		registry.resolveApproval('ses_1', { toolCallId: 'shared_call', runtimeAgentId: 'runtime_child_1', decision: 'approved' });
		await expect(first).resolves.toEqual({ decision: 'approved' });
		await expect(second).resolves.toEqual({ decision: 'rejected' });
	});

	it('projects an MCP confirmation request as one correlated MCP tool event', async () => {
		const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-bridge-'));
		tempDirs.push(workDir);
		const registry = new SessionRegistry();
		registry.createSession('ses_1');
		const sink = makeSink();
		const { fake, createHarness } = createFakeHarness();
		const harness = new LiveHarnessFactory({ registry, sink, createHarness });
		await harness.createSession({
			sessionId: 'ses_1',
			workDir,
			tools: [{
				type: 'mcp_toolset',
				mcpServerName: 'billing',
				configs: [{ name: 'query', permissionPolicy: { type: 'always_ask' } }],
			}],
		});
		fake.setScript('ses_1', [
			{ kind: 'event', event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_mcp_1', name: 'mcp__billing__query', args: { month: '2026-07' } }) },
			{ kind: 'approval', request: { toolCallId: 'call_mcp_1', toolName: 'mcp__billing__query', action: 'execute', display: { kind: 'generic', summary: 'query billing' } } },
		]);

		const promptDone = harness.prompt('ses_1', 'hi');
		expect(sink.events.map(({ event }) => event)).toEqual([
			{
				type: 'approval_request',
				tool_call_id: 'call_mcp_1',
				tool_name: 'query',
				server_name: 'billing',
				arguments: { month: '2026-07' },
				action: 'execute',
				display: { kind: 'generic', summary: 'query billing' },
			},
		]);
		registry.resolveApproval('ses_1', { toolCallId: 'call_mcp_1', decision: 'approved' });
		await promptDone;
		expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([{ decision: 'approved' }]);
	});

  it('denies approval-worthy actions without a round trip under always_deny', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-bridge-'));
    tempDirs.push(workDir);
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    const sink = makeSink();
    const { fake, createHarness } = createFakeHarness();
    const harness = new LiveHarnessFactory({ registry, sink, createHarness });
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [{ name: 'Bash', permissionPolicy: { type: 'always_deny' } }],
      }],
    });
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_1', name: 'Bash', args: {} }) },
      { kind: 'approval', request: { toolCallId: 'call_1', toolName: 'Bash', action: 'execute', display: { kind: 'generic', summary: 'run tool' } } },
    ]);
    await harness.prompt('ses_1', 'hi');
    expect(sink.events.map(({ event }) => event)).toEqual([
      { type: 'agent.tool_use', id: 'call_1', name: 'Bash', arguments: {}, evaluated_permission: 'deny' },
    ]);
    expect(registry.listPendingCalls('ses_1')).toEqual([]);
    expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([
      { decision: 'rejected', feedback: 'Denied by the session permission policy.' },
    ]);
  });
});

describe('pending call bridge: question', () => {
  it('emits question_request with a facade-generated id and resolves with answers', async () => {
    const { registry, sink, fake, harness } = await setup();
    fake.setScript('ses_1', [
      {
        kind: 'question',
        request: {
          questions: [
            {
              question: 'Which environment?',
              header: 'Deploy target',
              options: [{ label: 'staging' }, { label: 'prod', description: 'live traffic' }],
              multiSelect: false,
            },
          ],
        },
      },
    ]);
    const promptDone = harness.prompt('ses_1', 'deploy');

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0]?.event as {
      type: string;
      question_id: string;
      questions: unknown[];
    };
    expect(event.type).toBe('question_request');
    expect(event.question_id).toMatch(/^q_[0-9a-f-]{36}$/);
    expect(event.questions).toEqual([
      {
        question: 'Which environment?',
        header: 'Deploy target',
        options: [{ label: 'staging' }, { label: 'prod', description: 'live traffic' }],
      },
    ]);
    const pending = registry.listPendingCalls('ses_1');
    expect(pending).toEqual([{ id: event.question_id, kind: 'question', state: 'pending' }]);

    registry.answerQuestion('ses_1', {
      questionId: event.question_id,
      answers: { 'Which environment?': 'staging' },
    });
    await promptDone;
    expect(fake.sessions.get('ses_1')?.questionResults).toEqual([
      { 'Which environment?': 'staging' },
    ]);
  });
});

describe('pending call bridge: external tool', () => {
  it('emits external_tool_request and maps the completed resolution', async () => {
    const { registry, sink, fake, harness } = await setup();
		await harness.updateSessionConfig('ses_1', {
			tools: [{
				type: 'custom',
				name: 'query_billing',
				description: 'Query billing',
				inputSchema: { type: 'object' },
			}],
		});
    fake.setScript('ses_1', [
      {
        kind: 'event',
        event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_9a2', name: 'query_billing', args: { month: '2026-07' } }),
      },
      { kind: 'tool_call', request: { toolCallId: 'call_9a2', args: { month: '2026-07' } } },
      { kind: 'event', event: runtimeEvent({ type: 'turn.ended', turnId: 1, reason: 'completed' }) },
    ]);
    const promptDone = harness.prompt('ses_1', 'how many rows?');

    expect(sink.events.map(({ event }) => event)).toEqual([
      { type: 'external_tool_request', tool_call_id: 'call_9a2', name: 'query_billing', arguments: { month: '2026-07' } },
    ]);
    expect(registry.listPendingCalls('ses_1')).toEqual([
      { id: 'call_9a2', kind: 'external_tool', state: 'pending' },
    ]);

    await registry.resolveToolResult('ses_1', {
      toolCallId: 'call_9a2',
      resolution: 'completed',
      output: '{"rows":3}',
    });
    await promptDone;
    expect(fake.sessions.get('ses_1')?.toolCallResponses).toEqual([
      { output: '{"rows":3}', isError: false },
    ]);
  });

  it('maps failed and skipped resolutions to runtime tool responses', async () => {
    const { registry, fake, harness } = await setup();
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_f', name: 'query_billing', args: {} }) },
      { kind: 'tool_call', request: { toolCallId: 'call_f', args: {} } },
      { kind: 'event', event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_s', name: 'query_billing', args: {} }) },
      { kind: 'tool_call', request: { toolCallId: 'call_s', args: {} } },
    ]);
    const promptDone = harness.prompt('ses_1', 'hi');
    await registry.resolveToolResult('ses_1', { toolCallId: 'call_f', resolution: 'failed', output: 'boom' });
    await waitForPendingCall(registry, 'ses_1', 'call_s');
    await registry.resolveToolResult('ses_1', { toolCallId: 'call_s', resolution: 'skipped' });
    await promptDone;
    expect(fake.sessions.get('ses_1')?.toolCallResponses).toEqual([
      { output: 'boom', isError: true },
      { output: 'The external tool call was skipped.', isError: false },
    ]);
  });

  it('never correlates a late or unknown result with a pending call', async () => {
    const { registry, fake, harness } = await setup();
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_a', name: 'query_billing', args: {} }) },
      { kind: 'tool_call', request: { toolCallId: 'call_a', args: {} } },
    ]);
    const promptDone = harness.prompt('ses_1', 'hi');
    await expect(
      registry.resolveToolResult('ses_1', { toolCallId: 'call_zzz', resolution: 'skipped' }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'request_not_pending' }) as Error);
    expect(registry.listPendingCalls('ses_1')).toEqual([
      { id: 'call_a', kind: 'external_tool', state: 'pending' },
    ]);
    await registry.resolveToolResult('ses_1', { toolCallId: 'call_a', resolution: 'skipped' });
    await promptDone;
    // A duplicate result for the settled call is still rejected.
    await expect(
      registry.resolveToolResult('ses_1', { toolCallId: 'call_a', resolution: 'skipped' }),
    ).rejects.toThrowError(expect.objectContaining({ code: 'request_not_pending' }) as Error);
  });
});

describe('session teardown', () => {
  it('settles a pending approval as cancelled when the session is cancelled', async () => {
    const { fake, harness } = await setup();
    fake.setScript('ses_1', [
      { kind: 'approval', request: { toolCallId: 'call_1', toolName: 'Bash', action: 'execute', display: { kind: 'generic', summary: 'run tool' } } },
    ]);
    const promptDone = harness.prompt('ses_1', 'hi');
    await harness.cancelSession('ses_1');
    await promptDone;
    expect(fake.sessions.get('ses_1')?.approvalResponses).toEqual([{ decision: 'cancelled' }]);
  });

  it('settles a pending question with the no-answer result on cancel', async () => {
    const { fake, harness } = await setup();
    fake.setScript('ses_1', [
      { kind: 'question', request: { questions: [{ question: 'Continue?', options: [] }] } },
    ]);
    const promptDone = harness.prompt('ses_1', 'hi');
    await harness.cancelSession('ses_1');
    await promptDone;
    expect(fake.sessions.get('ses_1')?.questionResults).toEqual([null]);
  });

  it('settles a pending external tool call with an error result on cancel', async () => {
    const { fake, harness } = await setup();
    fake.setScript('ses_1', [
      { kind: 'tool_call', request: { toolCallId: 'call_1', args: {} } },
    ]);
    const promptDone = harness.prompt('ses_1', 'hi');
    await harness.cancelSession('ses_1');
    await promptDone;
    const responses = fake.sessions.get('ses_1')?.toolCallResponses;
    expect(responses).toHaveLength(1);
    expect(responses?.[0]?.isError).toBe(true);
  });

  it('closes the runtime session once and tolerates repeated cancel', async () => {
    const { fake, harness } = await setup();
    await harness.cancelSession('ses_1');
    await harness.cancelSession('ses_1');
    expect(fake.sessions.get('ses_1')?.closeCalls).toBe(1);
  });

  it('cancels the in-flight turn on interrupt', async () => {
    const { fake, harness } = await setup();
    await harness.interrupt('ses_1');
    expect(fake.sessions.get('ses_1')?.cancelCalls).toBe(1);
  });

  it('rejects interrupt and cancel for unknown sessions', async () => {
    const { harness } = await setup();
    await expect(harness.interrupt('nope')).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(harness.cancelSession('nope')).rejects.toMatchObject({ code: 'session_not_found' });
  });
});
