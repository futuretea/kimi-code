import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchLatestFromNpmRegistry, refreshUpdateCache } from '#/cli/update/refresh';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshUpdateCache', () => {
  it('writes an npm-registry cache on successful fetch', async () => {
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

  it('reads the latest Tea Code version from its npm registry record', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: '0.38.1' })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLatestFromNpmRegistry()).resolves.toEqual({ latest: '0.38.1', manifest: null });
    expect(fetchMock).toHaveBeenCalledWith('https://registry.npmjs.org/%40futuretea%2Ftea-code/latest');
  });
});
