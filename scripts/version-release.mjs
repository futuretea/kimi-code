import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import getChangesets from '@changesets/read';

const rootFlag = process.argv.indexOf('--root');
const root = resolve(rootFlag === -1 ? '.' : process.argv[rootFlag + 1] ?? '.');
const appManifestPath = join(root, 'apps/kimi-code/package.json');
const changesetDir = join(root, '.changeset');
const upstreamVersionPath = join(
  root,
  ...(rootFlag === -1 ? ['apps', 'kimi-code', 'UPSTREAM_VERSION'] : ['UPSTREAM_VERSION']),
);
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function baseVersion(version) {
  return version.split('+', 1)[0];
}

function readUpstreamVersion() {
  const upstream = readFileSync(upstreamVersionPath, 'utf8').trim();
  if (!semver.test(upstream)) {
    throw new Error('UPSTREAM_VERSION must be a valid semver version');
  }
  return upstream;
}

async function readTeaChangesets() {
  const teaChangesets = [];
  for (const changeset of await getChangesets(root)) {
    for (const release of changeset.releases) {
      if (release.name !== '@futuretea/tea-code') {
        throw new Error('changeset selector must use @futuretea/tea-code');
      }
      if (release.type !== 'none') {
        teaChangesets.push({ id: changeset.id, bump: release.type });
      }
    }
  }
  return teaChangesets;
}

function assertMajorReleaseApproved(changesets) {
  if (!changesets.some((changeset) => changeset.bump === 'major')) return;
  const approval = join(root, 'APPROVED_MAJOR_RELEASE');
  if (!existsSync(approval) || readFileSync(approval, 'utf8').trim() !== 'approved') {
    throw new Error('major Tea release requires explicit approval');
  }
}

const initialManifest = readJson(appManifestPath);
if (initialManifest.name !== '@futuretea/tea-code') {
  throw new Error('expected @futuretea/tea-code manifest');
}

// Validate every non-mutating precondition before Changesets edits package
// manifests, changelogs, or pending change files.
readUpstreamVersion();
const teaChangesets = await readTeaChangesets();
if (teaChangesets.length === 0) {
  throw new Error('expected a pending @futuretea/tea-code changeset');
}
assertMajorReleaseApproved(teaChangesets);

execFileSync('changeset', ['version'], { cwd: root, stdio: 'inherit' });

for (const changeset of teaChangesets) {
  if (existsSync(join(changesetDir, `${changeset.id}.md`))) {
    throw new Error(`Changesets did not consume ${changeset.id}.md`);
  }
}

const nextManifest = readJson(appManifestPath);
const nextBaseVersion = baseVersion(nextManifest.version);
if (!semver.test(nextBaseVersion) || nextBaseVersion === baseVersion(initialManifest.version)) {
  throw new Error('Changesets did not increment the Tea release base version');
}

nextManifest.version = nextBaseVersion;
writeFileSync(appManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
