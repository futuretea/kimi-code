import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startServer, type RunningFacadeServer } from '../src/start';

import { createFakeHarness } from './fake-harness';
import { bootTestServer, expectErrorEnvelope, getJson, type TestServerHandle } from './http-helper';

/**
 * Journal probe on `/ready`: the facade self-certifies that its home directory
 * (the journal-bearing filesystem, resolved from OCA_HOME_DIR / KIMI_CODE_HOME
 * or the explicit server option) exists and is readable and writable. Any
 * failure fails closed as a neutral `runtime_unavailable` (HTTP 500) without
 * leaking path details.
 */
describe('GET /ready journal probe', () => {
  let handle: TestServerHandle | undefined;
  let server: RunningFacadeServer | undefined;
  const ownedDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await handle?.close();
    handle = undefined;
    await server?.close();
    server = undefined;
    for (const dir of ownedDirs.splice(0)) {
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  /** Boots a server whose home directory is the given path, with a fake harness. */
  async function bootWithHomeDir(homeDir: string): Promise<string> {
    const { createHarness } = createFakeHarness();
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir,
      logger: false,
      harnessFactory: createHarness,
      deltaFlushIntervalMs: 50,
    });
    return `http://127.0.0.1:${server.port}`;
  }

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'oca-facade-probe-'));
    ownedDirs.push(dir);
    return dir;
  }

  function missingHomeDir(): string {
    // Not created on disk: the probe must fail closed on a missing home.
    return join(tmpdir(), `oca-facade-probe-missing-${process.pid}-${Date.now()}`);
  }

  function expectNeutralRuntimeUnavailable(body: unknown, leakedPath: string): void {
    const envelope = expectErrorEnvelope(body, 'runtime_unavailable');
    expect(envelope.error.message).toBe('The runtime is unavailable.');
    expect(JSON.stringify(body)).not.toContain(leakedPath);
  }

  const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;

  it('returns 200 when the home directory is readable and writable', async () => {
    handle = await bootTestServer();
    const res = await getJson(handle.baseUrl, '/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns runtime_unavailable when the home directory is missing', async () => {
    const homeDir = missingHomeDir();
    const baseUrl = await bootWithHomeDir(homeDir);
    const res = await getJson(baseUrl, '/ready');
    expect(res.status).toBe(500);
    expectNeutralRuntimeUnavailable(res.body, homeDir);
  });

  it('returns runtime_unavailable when OCA_HOME_DIR resolves to a missing directory', async () => {
    const homeDir = missingHomeDir();
    vi.stubEnv('OCA_HOME_DIR', homeDir);
    const { createHarness } = createFakeHarness();
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      logger: false,
      harnessFactory: createHarness,
      deltaFlushIntervalMs: 50,
    });
    const res = await getJson(`http://127.0.0.1:${server.port}`, '/ready');
    expect(res.status).toBe(500);
    expectNeutralRuntimeUnavailable(res.body, homeDir);
  });

  it.skipIf(isRoot)('returns runtime_unavailable when the home directory is not readable', async () => {
    const homeDir = await makeTempDir();
    await chmod(homeDir, 0o000);
    const baseUrl = await bootWithHomeDir(homeDir);
    const res = await getJson(baseUrl, '/ready');
    expect(res.status).toBe(500);
    expectNeutralRuntimeUnavailable(res.body, homeDir);
  });

  it.skipIf(isRoot)('returns runtime_unavailable when the home directory is not writable', async () => {
    const homeDir = await makeTempDir();
    await chmod(homeDir, 0o555);
    const baseUrl = await bootWithHomeDir(homeDir);
    const res = await getJson(baseUrl, '/ready');
    expect(res.status).toBe(500);
    expectNeutralRuntimeUnavailable(res.body, homeDir);
  });
});
