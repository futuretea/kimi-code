import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createKimiCodeUserAgent,
  createKimiCodeHostIdentity,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getUpstreamVersion,
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

  it('reads the packaged upstream release identity separately from the local package version', () => {
    expect(getUpstreamVersion()).toBe('0.38.0');
    expect(createKimiCodeHostIdentity()).toMatchObject({ version: '0.38.0' });
    expect(createKimiCodeUserAgent()).toBe('kimi-code-cli/0.38.0');
  });

  it('uses the packaged upstream release for every ad-hoc fetch user-agent', () => {
    expect(createKimiCodeUserAgent()).toBe('kimi-code-cli/0.38.0');
  });
});
