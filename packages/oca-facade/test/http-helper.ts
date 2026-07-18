import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from 'vitest';

import type { HarnessFactory } from '../src/harness';
import type { PendingCallJournal } from '../src/session-registry';
import { startServer, type RunningFacadeServer } from '../src/start';

import { createFakeHarness, type FakeHarness } from './fake-harness';

/**
 * Shared in-process HTTP test rig: boots the facade server on an ephemeral
 * port with the fake harness wired in, plus small JSON / NDJSON / SSE client
 * helpers. Note: when `harnessFactory` is overridden, `handle.fake` is not the
 * factory's session store (the override owns its own fake).
 */
export interface TestServerHandle {
  readonly baseUrl: string;
  readonly server: RunningFacadeServer;
  readonly fake: FakeHarness;
  readonly homeDir: string;
  close(): Promise<void>;
}

export async function bootTestServer(options?: {
  readonly harnessFactory?: HarnessFactory;
  readonly deltaFlushIntervalMs?: number;
  /** Reuse an existing home (crash simulation: the journal survives the process). */
  readonly homeDir?: string;
  /**
   * Journal injection for the recovery slice (the implementer wires it into
   * the registry via a new `startServer` option). A failing journal drives
   * the fail-closed registration path.
   */
  readonly pendingJournal?: PendingCallJournal;
}): Promise<TestServerHandle> {
  const homeDir = options?.homeDir ?? (await mkdtemp(join(tmpdir(), 'oca-facade-http-')));
  const { fake, createHarness } = createFakeHarness();
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    homeDir,
    logger: false,
    harnessFactory: options?.harnessFactory ?? createHarness,
    deltaFlushIntervalMs: options?.deltaFlushIntervalMs ?? 50,
    ...(options?.pendingJournal !== undefined ? { pendingJournal: options.pendingJournal } : {}),
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    server,
    fake,
    homeDir,
    close: async () => {
      await server.close();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
}

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

export async function postJson(baseUrl: string, path: string, body?: unknown): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

export async function getJson(baseUrl: string, path: string): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

export interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string };
}

/** Asserts the contract error envelope `{"error":{"code","message"}}`. */
export function expectErrorEnvelope(body: unknown, code: string): ErrorEnvelope {
  expect(typeof body).toBe('object');
  expect(body).not.toBeNull();
  const envelope = body as ErrorEnvelope;
  expect(Object.keys(envelope)).toEqual(['error']);
  expect(envelope.error.code).toBe(code);
  expect(typeof envelope.error.message).toBe('string');
  expect(envelope.error.message.length).toBeGreaterThan(0);
  return envelope;
}

export class StreamEofError extends Error {
  constructor() {
    super('stream ended before the expected data arrived');
    this.name = 'StreamEofError';
  }
}

export interface OpenStream {
  readonly response: Response;
  readonly reader: StreamReader;
}

/** Incremental line reader over a fetch response body (NDJSON / SSE tests). */
export class StreamReader {
  private readonly decoder = new TextDecoder();
  private buffered = '';
  private readonly lines: string[] = [];
  private waiter: (() => void) | undefined;
  private eof = false;
  private failure: Error | undefined;

  private constructor(
    readonly response: Response,
    private readonly controller: AbortController,
  ) {
    void this.pump();
  }

  static async open(url: string, init?: RequestInit): Promise<OpenStream> {
    const controller = new AbortController();
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, reader: new StreamReader(response, controller) };
  }

  async nextLine(timeoutMs = 5000): Promise<string> {
    for (;;) {
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.failure !== undefined) throw this.failure;
      if (this.eof) throw new StreamEofError();
      await this.waitForData(timeoutMs);
    }
  }

  close(): void {
    this.controller.abort();
  }

  private waitForData(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a stream line`));
      }, timeoutMs);
      this.waiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async pump(): Promise<void> {
    try {
      const body = this.response.body;
      if (body === null) {
        this.eof = true;
        this.wake();
        return;
      }
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffered += this.decoder.decode(value, { stream: true });
        this.drainLines();
      }
      this.buffered += this.decoder.decode();
      this.drainLines();
      if (this.buffered.length > 0) {
        this.lines.push(this.buffered);
        this.buffered = '';
      }
      this.eof = true;
      this.wake();
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.eof = true;
      this.wake();
    }
  }

  private drainLines(): void {
    for (;;) {
      const index = this.buffered.indexOf('\n');
      if (index < 0) break;
      this.lines.push(this.buffered.slice(0, index));
      this.buffered = this.buffered.slice(index + 1);
    }
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }
}

export async function postStream(baseUrl: string, path: string, body: unknown): Promise<OpenStream> {
  return StreamReader.open(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function openEventStream(baseUrl: string, sessionId: string): Promise<OpenStream> {
  return StreamReader.open(`${baseUrl}/sessions/${sessionId}/events/stream`, {
    headers: { Accept: 'text/event-stream' },
  });
}

/** Reads one NDJSON frame (one line = one JSON value). */
export async function nextNdjsonFrame(reader: StreamReader, timeoutMs?: number): Promise<unknown> {
  const line = await reader.nextLine(timeoutMs);
  return JSON.parse(line) as unknown;
}

/** Reads the stream to EOF and returns every NDJSON frame. */
export async function collectNdjson(reader: StreamReader, timeoutMs?: number): Promise<unknown[]> {
  const frames: unknown[] = [];
  for (;;) {
    try {
      frames.push(await nextNdjsonFrame(reader, timeoutMs));
    } catch (error) {
      if (error instanceof StreamEofError) return frames;
      throw error;
    }
  }
}

export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

/** Reads one SSE frame (`id:` / `event:` / `data:` lines, blank-line framed). */
export async function nextSseFrame(reader: StreamReader, timeoutMs?: number): Promise<SseFrame> {
  const lines: string[] = [];
  for (;;) {
    const line = await reader.nextLine(timeoutMs);
    if (line === '') {
      // Skip stray blank lines (comments / keep-alives carry no fields).
      if (lines.length > 0) break;
      continue;
    }
    lines.push(line);
  }
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('id: ')) id = line.slice('id: '.length);
    else if (line.startsWith('event: ')) event = line.slice('event: '.length);
    else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
  }
  return {
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
    data: dataLines.join('\n'),
  };
}

/** Frame shape used across HTTP tests (facade events and terminal frames). */
export interface FacadeFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

export function asFrame(value: unknown): FacadeFrame {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as FacadeFrame;
}

export function frameTypes(frames: unknown[]): string[] {
  return frames.map((frame) => asFrame(frame).type);
}
