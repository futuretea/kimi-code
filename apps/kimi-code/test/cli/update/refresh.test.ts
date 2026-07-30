import { describe, expect, it, vi } from 'vitest';

import { refreshUpdateCache } from '#/cli/update/refresh';
describe('refreshUpdateCache', () => {
  it('writes a fresh npm registry cache without a rollout manifest', async () => {
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
});
