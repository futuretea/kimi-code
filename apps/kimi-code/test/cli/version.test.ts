import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildKimiDefaultHeaders,
  createKimiCodeHostIdentity,
  createKimiCodeUserAgent,
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

  it('uses the upstream version for the Kimi host identity and outbound headers', () => {
    expect(getUpstreamVersion()).toBe('0.30.0');
    expect(createKimiCodeHostIdentity()).toEqual({
      userAgentProduct: 'kimi-code-cli',
      version: '0.30.0',
    });

    expect(buildKimiDefaultHeaders()['User-Agent']).toBe('kimi-code-cli/0.30.0');
    expect(createKimiCodeUserAgent()).toBe('kimi-code-cli/0.30.0');
  });
});
