import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LiveHarnessFactory, type FacadeEvent, type HarnessEventSink } from '../src/harness';
import { SessionRegistry, type StopReason } from '../src/session-registry';

import { createFakeHarness, runtimeEvent } from './fake-harness';

interface RecordedSink extends HarnessEventSink {
  events: FacadeEvent[];
}

const tempDirs: string[] = [];

function makeSink(): RecordedSink {
  const events: FacadeEvent[] = [];
  return {
    events,
    emit(_sessionID, event) {
      events.push(event);
    },
    turnEnded(_sessionID, _stopReason: StopReason) {},
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe('model request span bridge', () => {
  it('assigns opaque public IDs and keeps parent and child spans correlated', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-model-span-'));
    tempDirs.push(workDir);
    const registry = new SessionRegistry();
    registry.createSession('ses_1');
    const sink = makeSink();
    const { fake, createHarness } = createFakeHarness();
    const harness = new LiveHarnessFactory({ registry, sink, createHarness });
    await harness.createSession({ sessionId: 'ses_1', workDir });
    fake.setScript('ses_1', [
      { kind: 'event', event: runtimeEvent({ type: 'model.request.started', requestId: 'parent-request' }) },
      { kind: 'event', event: runtimeEvent({ type: 'model.request.ended', requestId: 'parent-request', isError: false }) },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'subagent.spawned',
          subagentId: 'runtime_child_1',
          subagentName: 'roster_1',
          parentToolCallId: 'parent_tool_1',
          runInBackground: false,
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'model.request.started',
          agentId: 'runtime_child_1',
          requestId: 'child-request',
        }),
      },
      {
        kind: 'event',
        event: runtimeEvent({
          type: 'model.request.ended',
          agentId: 'runtime_child_1',
          requestId: 'child-request',
          isError: true,
        }),
      },
    ]);

    await harness.prompt('ses_1', 'run');

    const parentStart = sink.events.find((event) => event.type === 'span.model_request_start');
    const parentEnd = sink.events.find((event) => event.type === 'span.model_request_end');
    const childStart = sink.events.find((event) => event.type === 'subagent.model_request_start');
    const childEnd = sink.events.find((event) => event.type === 'subagent.model_request_end');
    if (parentStart?.type !== 'span.model_request_start' || parentEnd?.type !== 'span.model_request_end') {
      throw new Error('parent model request span was not emitted');
    }
    if (childStart?.type !== 'subagent.model_request_start' || childEnd?.type !== 'subagent.model_request_end') {
      throw new Error('child model request span was not emitted');
    }
    expect(parentStart.public_id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(parentEnd).toEqual({
      type: 'span.model_request_end',
      model_request_start_id: parentStart.public_id,
      is_error: false,
    });
    expect(childStart).toMatchObject({
      runtime_agent_id: 'runtime_child_1',
      public_id: expect.stringMatching(/^evt_[0-9a-f]{32}$/),
    });
    expect(childEnd).toEqual({
      type: 'subagent.model_request_end',
      runtime_agent_id: 'runtime_child_1',
      model_request_start_id: childStart.public_id,
      is_error: true,
    });
  });
});
