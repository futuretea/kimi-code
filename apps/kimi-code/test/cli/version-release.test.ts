import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const FIXTURES = join(import.meta.dirname, '../fixtures/version-release');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function prepareFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'tea-code-version-release-'));
  tempRoots.push(root);
  cpSync(join(FIXTURES, name), root, { recursive: true });
  return root;
}

function prepareDefaultInvocationFixture(): string {
  const root = prepareFixture('default-invocation');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(REPO_ROOT, 'package.json'), join(root, 'package.json'));
  cpSync(join(REPO_ROOT, 'scripts/version-release.mjs'), join(root, 'scripts/version-release.mjs'));
  return root;
}

function runRelease(root: string): { readonly status: number; readonly stderr: string } {
  try {
    execFileSync(process.execPath, [join(REPO_ROOT, 'scripts/version-release.mjs'), '--root', root], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [join(REPO_ROOT, 'node_modules/.bin'), process.env['PATH']]
          .filter(Boolean)
          .join(delimiter),
      },
      stdio: 'pipe',
    });
    return { status: 0, stderr: '' };
  } catch (error) {
    const failure = error as { readonly status?: number; readonly stderr?: string | Buffer };
    return { status: failure.status ?? 1, stderr: String(failure.stderr ?? '') };
  }
}

function runDefaultRelease(root: string): { readonly status: number; readonly stderr: string } {
  try {
    execFileSync('pnpm', ['run', 'version:release'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [join(REPO_ROOT, 'node_modules/.bin'), process.env['PATH']]
          .filter(Boolean)
          .join(delimiter),
      },
      stdio: 'pipe',
    });
    return { status: 0, stderr: '' };
  } catch (error) {
    const failure = error as { readonly status?: number; readonly stderr?: string | Buffer };
    return { status: failure.status ?? 1, stderr: String(failure.stderr ?? '') };
  }
}

function appVersion(root: string): string {
  return JSON.parse(readFileSync(join(root, 'apps/kimi-code/package.json'), 'utf8')).version as string;
}

function fixtureSnapshot(root: string, changeset: string): Record<string, string> {
  return {
    appManifest: readFileSync(join(root, 'apps/kimi-code/package.json'), 'utf8'),
    changeset: readFileSync(join(root, '.changeset', changeset), 'utf8'),
    upstream: readFileSync(join(root, 'UPSTREAM_VERSION'), 'utf8'),
  };
}

describe('version:release Tea package version', () => {
  it('runs the default release command with the app-local upstream version', () => {
    const root = prepareDefaultInvocationFixture();

    expect(runDefaultRelease(root)).toEqual({ status: 0, stderr: '' });
    expect(appVersion(root)).toBe('0.1.0');
    expect(existsSync(join(root, '.changeset', 'tea-code-minor.md'))).toBe(false);
  });

  it('creates the first Tea release from the unpublished baseline', () => {
    const root = prepareFixture('first-release');

    expect(runRelease(root)).toEqual({ status: 0, stderr: '' });
    expect(appVersion(root)).toBe('0.1.0');
    expect(existsSync(join(root, '.changeset', 'tea-code-minor.md'))).toBe(false);
  });

  it('uses the Changesets version while a subsequent changeset raises it', () => {
    const root = prepareFixture('subsequent-release');

    expect(runRelease(root)).toEqual({ status: 0, stderr: '' });
    expect(appVersion(root)).toBe('0.2.0');
    expect(existsSync(join(root, '.changeset', 'tea-code-minor.md'))).toBe(false);
  });

  it('preserves Changesets patch semantics', () => {
    const root = prepareFixture('patch-release');

    expect(runRelease(root)).toEqual({ status: 0, stderr: '' });
    expect(appVersion(root)).toBe('0.1.1');
    expect(existsSync(join(root, '.changeset', 'tea-code-patch.md'))).toBe(false);
  });

  it('preserves an approved Changesets major release', () => {
    const root = prepareFixture('approved-major-release');

    expect(runRelease(root)).toEqual({ status: 0, stderr: '' });
    expect(appVersion(root)).toBe('1.0.0');
    expect(existsSync(join(root, '.changeset', 'tea-code-major.md'))).toBe(false);
  });

  it('rejects an upstream package selector without writing a version', () => {
    const root = prepareFixture('old-selector');
    const before = fixtureSnapshot(root, 'old-selector.md');

    const result = runRelease(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('Cannot find module');
    expect(result.stderr).toMatch(/selector|futuretea|tea-code/i);
    expect(fixtureSnapshot(root, 'old-selector.md')).toEqual(before);
  });

  it('rejects an invalid upstream version before mutating normal release artifacts', () => {
    const root = prepareFixture('base-not-incremented');
    const before = fixtureSnapshot(root, 'tea-code-patch.md');

    const result = runRelease(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('Cannot find module');
    expect(result.stderr).toMatch(/upstream|semver|version/i);
    expect(fixtureSnapshot(root, 'tea-code-patch.md')).toEqual(before);
  });

  it('documents the wrapper as the only manual version command', () => {
    const readme = readFileSync(join(REPO_ROOT, '.changeset/README.md'), 'utf8');
    const manualSectionStart = readme.indexOf('## Manual Publishing');
    const manualSectionEnd = readme.indexOf('## Notes', manualSectionStart);
    const manualSection = readme.slice(manualSectionStart, manualSectionEnd);

    expect(manualSection).toContain('pnpm run version:release');
    expect(manualSection).not.toContain('\npnpm run version\n');
    expect(manualSection).not.toContain('\npnpm changeset version\n');
  });

  it('keeps the CI release guide aligned with the release workflow', () => {
    const readme = readFileSync(join(REPO_ROOT, '.changeset/README.md'), 'utf8');
    const ciSectionStart = readme.indexOf('### 4. CI generates the release PR');
    const ciSectionEnd = readme.indexOf('### 5. Merge the release PR', ciSectionStart);
    const ciSection = readme.slice(ciSectionStart, ciSectionEnd);
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');

    expect(ciSection).toContain('`pnpm run version:release`');
    expect(ciSection).not.toContain('`pnpm changeset version`');
    expect(ciSection).toContain('`ci: release packages`');
    expect(workflow).toContain('version: pnpm run version:release');
    expect(workflow).toContain('title: "ci: release packages"');
  });
});
