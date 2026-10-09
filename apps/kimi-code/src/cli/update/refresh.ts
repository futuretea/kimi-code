import { writeUpdateCache } from './cache';
import { fetchLatestFromNpmRegistry, type FetchLatestResult } from './cdn';
import { type UpdateCache } from './types';

export interface RefreshUpdateCacheDeps {
  /** Resolves with the latest version + rollout manifest. **Throws** on any
   * failure — callers (including the default background invocation in
   * preflight) must catch. Errors intentionally skip `writeCache` so a
   * transient registry blip does not overwrite a previously known `latest` with
   * `null`. */
  readonly fetchLatest: () => Promise<FetchLatestResult>;
  readonly writeCache: (cache: UpdateCache) => Promise<void>;
  readonly now: () => Date;
  readonly timeoutMs?: number;
}

export async function refreshUpdateCache(
  overrides: Partial<RefreshUpdateCacheDeps> = {},
): Promise<UpdateCache> {
  const resolved: RefreshUpdateCacheDeps = {
    fetchLatest:
      overrides.fetchLatest ?? (() => fetchLatestFromNpmRegistry(undefined, overrides.timeoutMs)),
    writeCache: overrides.writeCache ?? writeUpdateCache,
    now: overrides.now ?? (() => new Date()),
  };

  const { latest, manifest } = await resolved.fetchLatest();
  const cache: UpdateCache = {
    source: 'npm-registry',
    checkedAt: resolved.now().toISOString(),
    latest,
    manifest,
  };
  await resolved.writeCache(cache);
  return cache;
}
