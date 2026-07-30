#!/usr/bin/env node

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skillDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(skillDir, '../..');
const tempRoot = await mkdtemp(join(tmpdir(), 'tea-code-run-kimi-code-'));
const homeDir = join(tempRoot, 'home');

try {
  await mkdir(homeDir);
  const output = await runExpect({
    cwd: appRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      TEA_CODE_HOME: join(homeDir, '.tea-code'),
      TERM: 'xterm-256color',
    },
  });

  for (const marker of ['Welcome to Kimi Code', 'No sessions found.', 'Bye!']) {
    if (!output.includes(marker)) {
      throw new Error(`TUI smoke did not render ${JSON.stringify(marker)}.`);
    }
  }

  process.stdout.write('Tea Code TUI smoke passed: opened the session picker and exited cleanly.\n');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function runExpect({ cwd, env }) {
  const script = String.raw`
    set timeout 20
    log_user 1
    spawn -noecho sh -c {stty rows 40 columns 120; exec node dist/main.mjs -S}
    expect {
      -re {No sessions found\.} {}
      timeout { exit 11 }
    }
    send "\033"
    expect {
      eof { exit 0 }
      timeout { exit 12 }
    }
  `;

  return new Promise((resolvePromise, reject) => {
    const child = spawn('expect', ['-c', script], { cwd, env });
    const chunks = [];
    const errors = [];

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => {
      reject(new Error(`Could not start expect: ${error.message}`));
    });
    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf8');
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      const stderr = Buffer.concat(errors).toString('utf8').trim();
      reject(new Error(`TUI smoke failed with expect exit ${String(code)}.${stderr ? ` ${stderr}` : ''}`));
    });
  });
}
