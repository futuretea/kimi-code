import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type { FacadeSkillFile, FacadeSkillRef } from './facade-types';

const SKILL_ROOT_SEGMENTS = ['.agents', 'skills'] as const;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

// materializeSessionSkills writes validated Agent Skill files to the
// project-level root scanned by kimi-code for this Session.
export async function materializeSessionSkills(skills: readonly FacadeSkillRef[], workDir: string): Promise<void> {
  if (skills.length === 0) return;

  const root = await ensureSkillRoot(workDir);
  const names = new Set<string>();
  const staged: Array<{ readonly temporary: string; readonly target: string }> = [];
  try {
    for (const skill of skills) {
      validateSkillIdentity(skill, names);
      const target = resolve(root, skill.name);
      if (!isWithin(root, target)) throw new Error('skill name escapes the Session skill root');
      const temporary = join(root, `.oca-skill-${skill.name}-${randomUUID()}`);
      await mkdir(temporary, { recursive: false });
      await writeSkillFiles(temporary, skill.files);
      staged.push({ temporary, target });
    }

    for (const entry of staged) {
      await removeExistingSkillTarget(entry.target);
      await rename(entry.temporary, entry.target);
    }
  } finally {
    await Promise.all(staged.map(async (entry) => rm(entry.temporary, { recursive: true, force: true })));
  }
}

async function ensureSkillRoot(workDir: string): Promise<string> {
  const workspace = resolve(workDir);
  const agentsRoot = join(workspace, SKILL_ROOT_SEGMENTS[0]);
  const skillRoot = join(agentsRoot, SKILL_ROOT_SEGMENTS[1]);
  await mkdir(skillRoot, { recursive: true });
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

function validateSkillIdentity(skill: FacadeSkillRef, names: Set<string>): void {
  if (skill.id.trim().length === 0 || !/^[a-z0-9_-]{1,64}$/.test(skill.name) || skill.version < 1) {
    throw new Error('skill materialization metadata is invalid');
  }
  if (names.has(skill.name)) throw new Error(`Session skills share runtime name ${JSON.stringify(skill.name)}`);
  names.add(skill.name);
}

async function writeSkillFiles(root: string, files: readonly FacadeSkillFile[]): Promise<void> {
  if (files.length === 0 || files.length > MAX_SKILL_FILES) {
    throw new Error('skill archive file count is invalid');
  }

  const paths = new Set<string>();
  let total = 0;
  let hasSkillMarkdown = false;
  for (const file of files) {
    const target = resolveSkillFileTarget(root, file.path);
    if (paths.has(file.path)) throw new Error(`skill archive contains duplicate path ${JSON.stringify(file.path)}`);
    const content = decodeBase64(file.contentBase64);
    total += content.byteLength;
    if (total > MAX_SKILL_UNCOMPRESSED_BYTES) throw new Error('skill archive uncompressed size exceeds the runtime limit');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
    paths.add(file.path);
    hasSkillMarkdown ||= file.path === 'SKILL.md';
  }
  if (!hasSkillMarkdown) throw new Error('skill archive is missing SKILL.md');
}

function resolveSkillFileTarget(root: string, filePath: string): string {
	if (
		filePath.length === 0 ||
		filePath.includes('\\') ||
		filePath.startsWith('/') ||
		filePath.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
	) {
		throw new Error('skill archive path is invalid');
	}
	const target = resolve(root, filePath);
  if (!isWithin(root, target) || target === root) throw new Error('skill archive path escapes the skill root');
  return target;
}

function decodeBase64(value: string): Buffer {
  if (value.length === 0) return Buffer.alloc(0);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('skill archive file content is not base64');
  }
  const content = Buffer.from(value, 'base64');
  if (content.toString('base64') !== value) throw new Error('skill archive file content is not canonical base64');
  return content;
}

async function removeExistingSkillTarget(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Session skill target is not a regular directory');
    }
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
