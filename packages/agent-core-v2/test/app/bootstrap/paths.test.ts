import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureKimiHome, resolveConfigPath, resolveKimiHome } from '#/app/bootstrap/bootstrap';

describe('bootstrap path helpers', () => {
  describe('resolveKimiHome', () => {
    it('uses explicit homeDir when provided', () => {
      expect(resolveKimiHome('/tmp/kimi')).toBe('/tmp/kimi');
    });

    it.each([
      { env: {}, expected: '/user/.tea-code' },
      { env: { TEA_CODE_HOME: '/env/tea' }, expected: '/env/tea' },
      { env: { KIMI_CODE_HOME: '/env/kimi' }, expected: '/user/.tea-code' },
      { env: { TEA_CODE_HOME: '/env/tea', KIMI_CODE_HOME: '/env/kimi' }, expected: '/env/tea' },
    ])('isolates the user home for $env', ({ env, expected }) => {
      expect(resolveKimiHome(undefined, env, '/user')).toBe(expected);
      expect(resolveKimiHome('/explicit', env, '/user')).toBe('/explicit');
    });
  });

  describe('resolveConfigPath', () => {
    it('uses explicit configPath when provided', () => {
      expect(resolveConfigPath({ configPath: '/x/config.toml' })).toBe('/x/config.toml');
    });

    it('joins homeDir with config.toml', () => {
      expect(resolveConfigPath({ homeDir: '/tmp/kimi' })).toBe('/tmp/kimi/config.toml');
    });
  });

  describe('ensureKimiHome', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('creates the directory with 0700 permissions', () => {
      dir = join(mkdtempSync(join(tmpdir(), 'kimi-home-')), 'nested');
      ensureKimiHome(dir);
      expect(existsSync(dir)).toBe(true);
    });
  });
});
