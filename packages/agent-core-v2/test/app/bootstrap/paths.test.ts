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

    it('falls back to TEA_CODE_HOME env and ignores the old environment variable', () => {
      const prevTea = process.env['TEA_CODE_HOME'];
      const prevKimi = process.env['KIMI_CODE_HOME'];
      process.env['KIMI_CODE_HOME'] = '/env/old-kimi';
      process.env['TEA_CODE_HOME'] = '/env/tea';
      try {
        expect(resolveKimiHome()).toBe('/env/tea');
      } finally {
        if (prevTea === undefined) delete process.env['TEA_CODE_HOME'];
        else process.env['TEA_CODE_HOME'] = prevTea;
        if (prevKimi === undefined) delete process.env['KIMI_CODE_HOME'];
        else process.env['KIMI_CODE_HOME'] = prevKimi;
      }
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
