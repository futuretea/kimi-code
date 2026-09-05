import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createKimiCodeHostIdentity,
  createKimiCodeUserAgent,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getVersion,
} from '#/cli/version';

describe('cli version helpers', () => {
  it('resolves the host package manifest near apps/kimi-code and reads its version', () => {
    const pkgPath = getHostPackageJsonPath();
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(pkgPath.endsWith(join('apps', 'kimi-code', 'package.json'))).toBe(true);
    expect(getHostPackageRoot()).toBe(dirname(pkgPath));
    expect(getVersion()).toBe(pkg.version);
  });

  it('builds the product user-agent for ad-hoc fetches', () => {
    expect(createKimiCodeUserAgent()).toBe('kimi-code-cli/0.41.0');
  });
});


describe('v2 host telemetry identity', () => {
  it('sends the upstream identity through the real v2 appender', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tea-v2-identity-'));
    const payloads: Array<{ events: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      payloads.push(JSON.parse(init?.body as string));
      return new Response(null, { status: 200 });
    }));
    const { bootstrap } = await import('@moonshot-ai/agent-core-v2');
    const { createCloudAppender } = await import('@moonshot-ai/agent-core-v2/app/telemetry/cloudAppender');
    const { app } = bootstrap({ homeDir, clientIdentity: createKimiCodeHostIdentity() });
    try {
      const appender = createCloudAppender(app.accessor, {
        deviceId: 'device-123',
        appName: 'kimi-code-cli',
        uiMode: 'shell',
        getAccessToken: async () => 'test-token',
      });
      appender.track({ event: 'rebrand_identity', context: {}, properties: {} });
      await appender.flush();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.events[0]).toMatchObject({
        context_version: '0.41.0',
        context_client_version: '0.41.0',
      });
    } finally {
      app.dispose();
      vi.unstubAllGlobals();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
