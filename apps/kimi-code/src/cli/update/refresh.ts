import { writeUpdateCache } from './cache';
import { valid } from 'semver';
import { NPM_PACKAGE_NAME } from './types';
import { type UpdateCache } from './types';

export interface RefreshUpdateCacheDeps {
  /** Resolves with the latest version + rollout manifest. **Throws** on any
   * failure — callers (including the default background invocation in
   * preflight) must catch. Errors intentionally skip `writeCache` so a
   * transient CDN blip does not overwrite a previously known `latest` with
   * `null`. */
  readonly fetchLatest: () => Promise<{ readonly latest: string; readonly manifest: null }>;
  readonly writeCache: (cache: UpdateCache) => Promise<void>;
  readonly now: () => Date;
}

export async function refreshUpdateCache(
  overrides: Partial<RefreshUpdateCacheDeps> = {},
): Promise<UpdateCache> {
  const resolved: RefreshUpdateCacheDeps = {
    fetchLatest: overrides.fetchLatest ?? fetchLatestFromNpmRegistry,
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

async function fetchLatestFromNpmRegistry(): Promise<{ readonly latest: string; readonly manifest: null }> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE_NAME)}/latest`);
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const body = await response.json() as { version?: unknown };
  if (typeof body.version !== 'string' || valid(body.version) === null) throw new Error('npm registry returned invalid semver');
  return { latest: body.version, manifest: null };
}
