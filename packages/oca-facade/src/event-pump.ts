import { clearTimeout, setTimeout as scheduleTimeout } from 'node:timers';

import { toFacadeError } from './errors';
import type { FacadeEvent, HarnessEventSink } from './facade-types';
import type { PromptDoneFrame, SessionRegistry, StopReason } from './session-registry';

/**
 * Event throttle bounds: the public `delta_flush_interval_ms` window is
 * 50–5000ms with a default of 100ms; injected values are clamped into range.
 */
export const DEFAULT_DELTA_FLUSH_INTERVAL_MS = 100;
export const MIN_DELTA_FLUSH_INTERVAL_MS = 50;
export const MAX_DELTA_FLUSH_INTERVAL_MS = 5000;

export function clampDeltaFlushIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DELTA_FLUSH_INTERVAL_MS;
  return Math.min(
    MAX_DELTA_FLUSH_INTERVAL_MS,
    Math.max(MIN_DELTA_FLUSH_INTERVAL_MS, Math.round(value)),
  );
}

/** One NDJSON inline stream attached to the in-flight turn of a session. */
export interface TurnStream {
  write(frame: FacadeEvent | PromptDoneFrame): void;
  end(): void;
}

/** One live SSE subscription of a session's event stream. */
export interface EventSubscriber {
  publish(seq: number, event: FacadeEvent): void;
}

interface SessionPumpState {
  /** Per-session event sequence, incremented on every delivered event. */
  seq: number;
  buffer: FacadeEvent[];
  lastFlushAt: number;
  flushTimer: NodeJS.Timeout | undefined;
  turn: TurnStream | undefined;
  readonly subscribers: Set<EventSubscriber>;
}

/**
 * Per-session event pump. It throttles facade event delivery at
 * `delta_flush_interval_ms` (an immediate leading flush when the window has
 * elapsed, a trailing flush that coalesces bursts), numbers events with a
 * per-session sequence, and delivers every event to both channels: the
 * in-flight turn's NDJSON inline stream and all live SSE subscribers.
 *
 * Terminal turn frames (`prompt_done`) are written to the inline channel
 * only; they are not facade events and never appear on the SSE stream.
 */
export class EventPump implements HarnessEventSink {
  private readonly registry: SessionRegistry;
  private readonly intervalMs: number;
  private readonly sessions = new Map<string, SessionPumpState>();

  constructor(options: { registry: SessionRegistry; deltaFlushIntervalMs?: number | undefined }) {
    this.registry = options.registry;
    this.intervalMs = clampDeltaFlushIntervalMs(
      options.deltaFlushIntervalMs ?? DEFAULT_DELTA_FLUSH_INTERVAL_MS,
    );
  }

  get deltaFlushIntervalMs(): number {
    return this.intervalMs;
  }

  /** Attaches the inline NDJSON channel of a freshly started turn. */
  attachTurn(sessionId: string, stream: TurnStream): void {
    this.stateFor(sessionId).turn = stream;
  }

  /**
   * Detaches the inline channel (client disconnect). The turn itself keeps
   * running to its terminal state; events still flow on the SSE channel.
   */
  detachTurn(sessionId: string, stream: TurnStream): void {
    const state = this.sessions.get(sessionId);
    if (state?.turn === stream) state.turn = undefined;
  }

  /**
   * Ends the in-flight turn stream outside a runtime turn end (the cancel
   * path): buffered events are flushed first, then the terminal frame.
   */
  endTurn(sessionId: string, frame: PromptDoneFrame): void {
    this.flush(sessionId);
    this.closeTurn(sessionId, frame);
  }

  emit(sessionId: string, event: FacadeEvent): void {
    const state = this.stateFor(sessionId);
    state.buffer.push(event);
    this.scheduleFlush(sessionId, state);
  }

  turnEnded(sessionId: string, stopReason: StopReason): void {
    this.flush(sessionId);
    let frame: PromptDoneFrame | undefined;
    try {
      frame = this.registry.finishPrompt(sessionId, stopReason);
    } catch {
      // The turn was already finalized (e.g. cancel raced the runtime's turn
      // end): nothing left to report on the inline channel.
    }
    this.closeTurn(sessionId, frame);
  }

  /**
   * Reports a prompt dispatch failure as a neutral `session.error` event (raw
   * runtime text never crosses the boundary) followed by a failed turn end.
   */
  failTurn(sessionId: string, error: unknown): void {
    const neutral = toFacadeError(error);
    this.emit(sessionId, {
      type: 'session.error',
      code: neutral.code,
      message: neutral.message,
    });
    this.turnEnded(sessionId, 'failed');
  }

  subscribe(sessionId: string, subscriber: EventSubscriber): () => void {
    const state = this.stateFor(sessionId);
    state.subscribers.add(subscriber);
    return () => {
      state.subscribers.delete(subscriber);
    };
  }

  /** Drops all pump state for a session (terminal cancel cleanup). */
  dropSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    if (state.flushTimer !== undefined) clearTimeout(state.flushTimer);
    this.sessions.delete(sessionId);
  }

  /** Clears every pending flush timer; called on server shutdown. */
  dispose(): void {
    for (const state of this.sessions.values()) {
      if (state.flushTimer !== undefined) clearTimeout(state.flushTimer);
    }
    this.sessions.clear();
  }

  private closeTurn(sessionId: string, frame: PromptDoneFrame | undefined): void {
    const state = this.sessions.get(sessionId);
    const turn = state?.turn;
    if (state === undefined || turn === undefined) return;
    state.turn = undefined;
    if (frame !== undefined) turn.write(frame);
    turn.end();
  }

  private stateFor(sessionId: string): SessionPumpState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        seq: 0,
        buffer: [],
        lastFlushAt: 0,
        flushTimer: undefined,
        turn: undefined,
        subscribers: new Set(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private scheduleFlush(sessionId: string, state: SessionPumpState): void {
    if (state.flushTimer !== undefined) return;
    const elapsed = Date.now() - state.lastFlushAt;
    const delay = Math.max(0, this.intervalMs - elapsed);
    if (delay === 0) {
      this.flush(sessionId);
      return;
    }
    state.flushTimer = scheduleTimeout(() => {
      state.flushTimer = undefined;
      this.flush(sessionId);
    }, delay);
    state.flushTimer.unref();
  }

  private flush(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    if (state.flushTimer !== undefined) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
    if (state.buffer.length === 0) return;
    const events = state.buffer;
    state.buffer = [];
    state.lastFlushAt = Date.now();
    for (const event of events) {
      state.seq += 1;
      state.turn?.write(event);
      for (const subscriber of state.subscribers) {
        subscriber.publish(state.seq, event);
      }
    }
  }
}
