import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '../..');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('fork postinstall leaves external kimi and kimi_cli shims byte-for-byte unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'tea-code-postinstall-'));
  tempRoots.push(root);
  cpSync(join(APP_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  cpSync(join(APP_ROOT, 'package.json'), join(root, 'package.json'));

  const legacyBin = join(root, 'legacy-bin');
  const forkBin = join(root, 'bin');
  mkdirSync(legacyBin, { recursive: true });
  mkdirSync(forkBin, { recursive: true });
  const kimiPath = join(legacyBin, 'kimi');
  const kimiCliPath = join(legacyBin, 'kimi_cli');
  writeFileSync(kimiPath, '#!/bin/sh\n# kimi_cli external shim\n', { mode: 0o755 });
  writeFileSync(kimiCliPath, '#!/bin/sh\n# kimi_cli external command\n', { mode: 0o755 });
  writeFileSync(join(forkBin, 'kimi'), '#!/bin/sh\n# fork-owned fixture\n', { mode: 0o755 });
  chmodSync(kimiPath, 0o755);
  chmodSync(kimiCliPath, 0o755);
  chmodSync(join(forkBin, 'kimi'), 0o755);

  const before = new Map([
    [kimiPath, readFileSync(kimiPath)],
    [kimiCliPath, readFileSync(kimiCliPath)],
  ]);

  execFileSync(process.execPath, [join(root, 'scripts/postinstall.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PATH: [legacyBin, forkBin, process.env['PATH']].filter(Boolean).join(delimiter),
      SHELL: '/bin/false',
      npm_config_global: 'true',
    },
    stdio: 'pipe',
  });

  for (const [path, bytes] of before) {
    expect(readFileSync(path)).toEqual(bytes);
  }
});
