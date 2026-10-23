import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshUpdateCache } from '#/cli/update/refresh';
import type { UpdateManifest } from '#/cli/update/types';

const MANIFEST: UpdateManifest = {
  version: '0.5.0',
  publishedAt: '2026-05-20T12:00:00.000Z',
  rollout: [
    { percent: 30, delaySeconds: 0 },
    { percent: 30, delaySeconds: 43_200 },
    { percent: 40, delaySeconds: 86_400 },
  ],
};

describe('refreshUpdateCache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checks only the Tea npm package and caches its actual response', async () => {
    const fetchMock = vi.fn(async () => Response.json({ version: '2.1.1' }));
    vi.stubGlobal('fetch', fetchMock);
    const writeCache = vi.fn(async () => {});
    const result = await refreshUpdateCache({ writeCache });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40futuretea%2Ftea-code/latest',
      { signal: expect.any(AbortSignal) },
    );
    expect(result).toMatchObject({ source: 'npm-registry', latest: '2.1.1', manifest: null });
    expect(writeCache).toHaveBeenCalledWith(result);
  });

  it.each([
    ['HTTP failure', () => new Response('', { status: 404 })],
    ['invalid version', () => Response.json({ version: 'not-semver' })],
    ['missing version', () => Response.json({ name: '@futuretea/tea-code' })],
  ])('preserves the cache without a CDN fallback on %s', async (_label, response) => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetchMock);
    const writeCache = vi.fn(async () => {});

    await expect(refreshUpdateCache({ writeCache })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('writes a fresh cache carrying the manifest on successful fetch', async () => {
    const writeCache = vi.fn(async () => {});
    const result = await refreshUpdateCache({
      fetchLatest: async () => ({ latest: '0.5.0', manifest: MANIFEST }),
      writeCache,
      now: () => new Date('2026-05-20T12:34:56.000Z'),
    });

    expect(result).toEqual({
      source: 'npm-registry',
      checkedAt: '2026-05-20T12:34:56.000Z',
      latest: '0.5.0',
      manifest: MANIFEST,
    });
    expect(writeCache).toHaveBeenCalledWith(result);
  });

  it('writes a null manifest when the registry fetch has no rollout manifest', async () => {
    const writeCache = vi.fn(async () => {});
    const result = await refreshUpdateCache({
      fetchLatest: async () => ({ latest: '0.5.0', manifest: null }),
      writeCache,
      now: () => new Date('2026-05-20T12:34:56.000Z'),
    });

    expect(result).toEqual({
      source: 'npm-registry',
      checkedAt: '2026-05-20T12:34:56.000Z',
      latest: '0.5.0',
      manifest: null,
    });
    expect(writeCache).toHaveBeenCalledWith(result);
  });

  it('propagates fetch errors and skips writeCache so the cache is preserved', async () => {
    const writeCache = vi.fn(async () => {});
    await expect(
      refreshUpdateCache({
        fetchLatest: async () => {
          throw new Error('network down');
        },
        writeCache,
        now: () => new Date(),
      }),
    ).rejects.toThrow(/network down/);

    expect(writeCache).not.toHaveBeenCalled();
  });

  it('threads timeoutMs into the default npm registry fetch', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        });
      }),
    );
    try {
      const result = refreshUpdateCache({
        timeoutMs: 10_000,
        writeCache: async () => {},
      });
      let rejected = false;
      void result.catch(() => {
        rejected = true;
      });
      const expectation = expect(result).rejects.toThrow(/aborted/);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(14_000);

      await expectation;
      expect(rejected).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
