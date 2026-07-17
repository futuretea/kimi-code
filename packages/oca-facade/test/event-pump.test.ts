import { describe, expect, it } from 'vitest';

import {
  clampDeltaFlushIntervalMs,
  DEFAULT_DELTA_FLUSH_INTERVAL_MS,
  EventPump,
  MAX_DELTA_FLUSH_INTERVAL_MS,
  MIN_DELTA_FLUSH_INTERVAL_MS,
  type EventSubscriber,
  type TurnStream,
} from '../src/event-pump';
import type { FacadeEvent } from '../src/facade-types';
import { SessionRegistry } from '../src/session-registry';

function collector(): {
  stream: TurnStream;
  frames: Array<FacadeEvent | { type: 'prompt_done' }>;
  ended: () => boolean;
} {
  const frames: Array<FacadeEvent | { type: 'prompt_done' }> = [];
  let isEnded = false;
  return {
    stream: {
      write: (frame) => {
        frames.push(frame);
      },
      end: () => {
        isEnded = true;
      },
    },
    frames,
    ended: () => isEnded,
  };
}

function subscriber(): { sub: EventSubscriber; seen: Array<{ seq: number; event: FacadeEvent }> } {
  const seen: Array<{ seq: number; event: FacadeEvent }> = [];
  return {
    sub: {
      publish: (seq, event) => {
        seen.push({ seq, event });
      },
    },
    seen,
  };
}

function pumpWithActiveTurn(intervalMs?: number): {
  pump: EventPump;
  registry: SessionRegistry;
} {
  const registry = new SessionRegistry();
  registry.createSession('ses_1');
  registry.startPrompt('ses_1', { content: 'go' });
  const pump = new EventPump({
    registry,
    ...(intervalMs !== undefined ? { deltaFlushIntervalMs: intervalMs } : {}),
  });
  return { pump, registry };
}

const MESSAGE: FacadeEvent = { type: 'agent.message', content: 'hi' };
const THINKING: FacadeEvent = { type: 'agent.thinking', content: 'hmm' };
// Contract-schema event with no current runtime source: the wire schema
// accepts the frame and the pump delivers it unchanged.
const ARTIFACT: FacadeEvent = {
  type: 'agent.artifact_delivered',
  file_id: 'file_1',
  file_name: 'report.md',
};

describe('clampDeltaFlushIntervalMs', () => {
  it('clamps into the 50–5000 window and defaults at 100', () => {
    expect(clampDeltaFlushIntervalMs(10)).toBe(MIN_DELTA_FLUSH_INTERVAL_MS);
    expect(clampDeltaFlushIntervalMs(100)).toBe(100);
    expect(clampDeltaFlushIntervalMs(60_000)).toBe(MAX_DELTA_FLUSH_INTERVAL_MS);
    expect(clampDeltaFlushIntervalMs(Number.NaN)).toBe(DEFAULT_DELTA_FLUSH_INTERVAL_MS);
    expect(new EventPump({ registry: new SessionRegistry() }).deltaFlushIntervalMs).toBe(
      DEFAULT_DELTA_FLUSH_INTERVAL_MS,
    );
    expect(
      new EventPump({ registry: new SessionRegistry(), deltaFlushIntervalMs: 10 })
        .deltaFlushIntervalMs,
    ).toBe(MIN_DELTA_FLUSH_INTERVAL_MS);
  });
});

describe('EventPump', () => {
  it('delivers a first event immediately and coalesces a burst into a trailing flush', async () => {
    const { pump } = pumpWithActiveTurn(50);
    const { sub, seen } = subscriber();
    pump.subscribe('ses_1', sub);

    pump.emit('ses_1', MESSAGE);
    // Leading edge: the first event after an idle window flushes immediately.
    expect(seen.map((entry) => entry.seq)).toEqual([1]);

    pump.emit('ses_1', THINKING);
    // Trailing edge: the burst event waits for the throttle window.
    expect(seen).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(seen.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('flushes buffered events on turn end, then writes the terminal frame inline only', () => {
    const { pump } = pumpWithActiveTurn(5000);
    const turn = collector();
    const { sub, seen } = subscriber();
    pump.attachTurn('ses_1', turn.stream);
    pump.subscribe('ses_1', sub);

    pump.emit('ses_1', MESSAGE);
    pump.emit('ses_1', THINKING);
    // Long window: the second event is still buffered when the turn ends.
    pump.turnEnded('ses_1', 'completed');

    expect(turn.frames).toEqual([
      MESSAGE,
      THINKING,
      { type: 'prompt_done', stop_reason: 'completed' },
    ]);
    expect(turn.ended()).toBe(true);
    // The terminal frame never reaches the SSE channel.
    expect(seen.map((entry) => entry.event)).toEqual([MESSAGE, THINKING]);
  });

  it('passes an agent.artifact_delivered frame through to both channels unchanged', () => {
    const { pump } = pumpWithActiveTurn(5000);
    const turn = collector();
    const { sub, seen } = subscriber();
    pump.attachTurn('ses_1', turn.stream);
    pump.subscribe('ses_1', sub);

    pump.emit('ses_1', ARTIFACT);
    pump.turnEnded('ses_1', 'completed');

    expect(turn.frames).toEqual([ARTIFACT, { type: 'prompt_done', stop_reason: 'completed' }]);
    expect(seen.map((entry) => entry.event)).toEqual([ARTIFACT]);
  });

  it('ends an open turn stream from the cancel path with the given terminal frame', () => {
    const { pump } = pumpWithActiveTurn();
    const turn = collector();
    pump.attachTurn('ses_1', turn.stream);

    pump.endTurn('ses_1', { type: 'prompt_done', stop_reason: 'cancelled' });
    expect(turn.frames).toEqual([{ type: 'prompt_done', stop_reason: 'cancelled' }]);
    expect(turn.ended()).toBe(true);

    // A late runtime turn end is a no-op: nothing is written twice.
    pump.turnEnded('ses_1', 'cancelled');
    expect(turn.frames).toHaveLength(1);
  });

  it('reports a dispatch failure as a neutral error event plus a failed turn end', () => {
    const { pump } = pumpWithActiveTurn();
    const turn = collector();
    pump.attachTurn('ses_1', turn.stream);

    pump.failTurn('ses_1', new Error('raw runtime text /internal/path'));
    expect(turn.frames).toEqual([
      { type: 'session.error', code: 'internal_error', message: 'An internal error occurred.' },
      { type: 'prompt_done', stop_reason: 'failed' },
    ]);
    expect(JSON.stringify(turn.frames)).not.toContain('/internal/path');
  });

  it('keeps delivering to subscribers after the inline channel detaches', async () => {
    const { pump } = pumpWithActiveTurn(50);
    const turn = collector();
    const { sub, seen } = subscriber();
    pump.attachTurn('ses_1', turn.stream);
    pump.subscribe('ses_1', sub);
    pump.detachTurn('ses_1', turn.stream);

    pump.emit('ses_1', MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(turn.frames).toHaveLength(0);
    expect(seen.map((entry) => entry.event)).toEqual([MESSAGE]);
  });
});
