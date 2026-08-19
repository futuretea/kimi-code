import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type Entry, type ZipFile, open as openZip } from 'yauzl';

import type { FacadeSkillArchive, FacadeSkillOrigin, FacadeSkillRef } from './facade-types';
import { MANAGED_SKILL_ARCHIVE_BYTES, MAX_SKILL_ARCHIVE_BYTES, MAX_SESSION_SKILLS } from './session-create-multipart';

const SKILL_ROOT_SEGMENTS = ['.agents', 'skills'] as const;
const MAX_FORWARD_SKILL_ENTRIES = 256;

interface SkillMaterializationLimits {
	readonly maxArchiveBytes: number;
	readonly maxEntries?: number;
}

interface StagedSkill {
  readonly temporary: string;
  readonly target: string;
  readonly backup: string;
}

// materializeSessionSkills validates staged ZIP archives and installs them at
// the project-level root scanned by kimi-code for this Session. All archives
// are verified before any existing target is exchanged.
export async function materializeSessionSkills(
  skills: readonly FacadeSkillRef[],
  archives: readonly FacadeSkillArchive[],
  workDir: string,
): Promise<void> {
  if (skills.length === 0 && archives.length === 0) return;
  if (skills.length === 0 || skills.length !== archives.length || skills.length > MAX_SESSION_SKILLS) {
    throw new Error('skill archive descriptors are invalid');
  }

  const root = await ensureSkillRoot(workDir);
  const names = new Set<string>();
  const staged: StagedSkill[] = [];
  try {
    for (const [index, skill] of skills.entries()) {
		const limits = validateSkillIdentity(skill, names);
      const target = resolve(root, skill.name);
      if (!isWithin(root, target) || target === root) throw new Error('skill name escapes the Session skill root');
      const temporary = join(root, `.oca-skill-${skill.name}-${randomUUID()}`);
      const backup = join(root, `.oca-skill-backup-${skill.name}-${randomUUID()}`);
      await mkdir(temporary, { recursive: false, mode: 0o700 });
      const stagedSkill = { temporary, target, backup };
      staged.push(stagedSkill);
		await extractSkillArchive(archives[index]!.path, skill, temporary, limits);
    }
    await publishStagedSkills(staged);
  } finally {
    await Promise.all(staged.map(async ({ temporary, backup }) => {
      await rm(temporary, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
    }));
  }
}

/** Removes only the runtime skill targets named in one failed Session creation. */
export async function removeMaterializedSessionSkills(
  skills: readonly FacadeSkillRef[],
  workDir: string,
): Promise<void> {
  if (skills.length === 0) return;
  const root = await ensureSkillRoot(workDir);
  for (const skill of skills) {
    if (!/^[a-z0-9_-]{1,64}$/.test(skill.name)) continue;
    const target = resolve(root, skill.name);
    if (!isWithin(root, target) || target === root) continue;
    await removeExistingSkillTarget(target);
  }
}

async function ensureSkillRoot(workDir: string): Promise<string> {
  const workspace = resolve(workDir);
  const agentsRoot = join(workspace, SKILL_ROOT_SEGMENTS[0]);
  const skillRoot = join(agentsRoot, SKILL_ROOT_SEGMENTS[1]);
  await mkdir(skillRoot, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(agentsRoot);
  await assertOwnedDirectory(skillRoot);
  return skillRoot;
}

async function assertOwnedDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Session skill root is not a regular directory');
  }
}

function materializationLimits(origin: FacadeSkillOrigin): SkillMaterializationLimits {
	if (origin === 'managed') return { maxArchiveBytes: MANAGED_SKILL_ARCHIVE_BYTES };
	return { maxArchiveBytes: MAX_SKILL_ARCHIVE_BYTES, maxEntries: MAX_FORWARD_SKILL_ENTRIES };
}

function validateSkillIdentity(skill: FacadeSkillRef, names: Set<string>): SkillMaterializationLimits {
	const limits = materializationLimits(skill.origin);
	if (
    skill.id.trim().length === 0 ||
    !/^[a-z0-9_-]{1,64}$/.test(skill.name) ||
    !/^[1-9][0-9]*$/.test(skill.version) ||
    !Number.isSafeInteger(skill.contentSize) ||
    skill.contentSize < 0 ||
		skill.contentSize > limits.maxArchiveBytes ||
    !/^[a-f0-9]{64}$/.test(skill.contentSHA256)
  ) {
    throw new Error('skill materialization metadata is invalid');
  }
	if (names.has(skill.name)) throw new Error(`Session skills share runtime name ${JSON.stringify(skill.name)}`);
	names.add(skill.name);
	return limits;
}

async function extractSkillArchive(archivePath: string, skill: FacadeSkillRef, destination: string, limits: SkillMaterializationLimits): Promise<void> {
	const archiveInfo = await stat(archivePath);
	if (!archiveInfo.isFile() || archiveInfo.size !== skill.contentSize || archiveInfo.size > limits.maxArchiveBytes) {
    throw new Error('skill archive size is invalid');
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    openZip(archivePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (openError, zip) => {
      if (openError !== null || zip === undefined) {
        rejectPromise(new Error('skill archive cannot be opened'));
        return;
      }
      let settled = false;
      let entries = 0;
      let total = 0;
      let hasManifest = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        zip.close();
        if (error === undefined) resolvePromise();
        else rejectPromise(error);
      };
      const next = (): void => {
        if (!settled) zip.readEntry();
      };
		zip.on('entry', (entry: Entry) => {
			void extractEntry(entry, zip, skill.name, destination, {
          increment: () => {
            entries += 1;
			if (limits.maxEntries !== undefined && entries > limits.maxEntries) throw new Error('skill archive file count is invalid');
          },
          addBytes: (count) => {
            total += count;
			if (total > limits.maxArchiveBytes) throw new Error('skill archive uncompressed size exceeds the runtime limit');
          },
          markManifest: () => { hasManifest = true; },
			}, limits).then(next).catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error('skill archive is invalid'));
        });
      });
      zip.on('end', () => {
        if (!hasManifest) finish(new Error('skill archive is missing SKILL.md'));
        else finish();
      });
      zip.on('error', () => finish(new Error('skill archive is invalid')));
      next();
    });
  });
}

interface ExtractionState {
  increment(): void;
  addBytes(count: number): void;
  markManifest(): void;
}

async function extractEntry(
  entry: Entry,
  zip: ZipFile,
  skillName: string,
  destination: string,
  state: ExtractionState,
	limits: SkillMaterializationLimits,
): Promise<void> {
  state.increment();
  if (entry.isEncrypted() || isSymlink(entry)) throw new Error('skill archive entry type is invalid');
  const relativePath = archiveRelativePath(entry.fileName, skillName);
  if (relativePath === '') return;
  const target = resolve(destination, relativePath);
  if (!isWithin(destination, target) || target === destination) throw new Error('skill archive path escapes the skill root');
  if (entry.fileName.endsWith('/')) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    return;
  }
	if (entry.uncompressedSize > limits.maxArchiveBytes) throw new Error('skill archive entry is too large');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const stream = await openEntryStream(zip, entry);
  const inspect = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        state.addBytes(chunk.byteLength);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  await pipeline(stream, inspect, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  if (relativePath === 'SKILL.md') {
    state.markManifest();
  }
}

function archiveRelativePath(fileName: string, skillName: string): string {
  const isDirectory = fileName.endsWith('/');
  const segments = fileName.split('/');
  if (isDirectory) segments.pop();
  if (
    fileName.includes('\\') ||
    fileName.startsWith('/') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('skill archive path is invalid');
  }
  if (fileName === `${skillName}/`) return '';
  const prefix = `${skillName}/`;
  if (!fileName.startsWith(prefix)) throw new Error('skill archive root does not match descriptor');
  const relativePath = fileName.slice(prefix.length);
  if (relativePath.length === 0 || relativePath.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('skill archive path is invalid');
  }
  return relativePath;
}

function isSymlink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, rejectPromise) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null || stream === undefined) rejectPromise(new Error('skill archive entry cannot be read'));
      else resolvePromise(stream);
    });
  });
}

async function publishStagedSkills(staged: readonly StagedSkill[]): Promise<void> {
  const published: StagedSkill[] = [];
  const displaced: StagedSkill[] = [];
  try {
    for (const entry of staged) {
      if (await moveExistingSkillTargetToBackup(entry.target, entry.backup)) displaced.push(entry);
      await rename(entry.temporary, entry.target);
      published.push(entry);
    }
    await Promise.all(published.map(({ backup }) => rm(backup, { recursive: true, force: true })));
  } catch (error) {
    for (const entry of [...published].reverse()) {
      await rm(entry.target, { recursive: true, force: true });
    }
    for (const entry of [...displaced].reverse()) {
      try {
        await rename(entry.backup, entry.target);
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') throw restoreError;
      }
    }
    throw error;
  }
}

async function moveExistingSkillTargetToBackup(target: string, backup: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Session skill target is not a regular directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await rename(target, backup);
  return true;
}

async function removeExistingSkillTarget(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Session skill target is not a regular directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(target, { recursive: true, force: false });
}

function isWithin(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === '' || (!relation.startsWith('..') && !relation.startsWith('/'));
}
