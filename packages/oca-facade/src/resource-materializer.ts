import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

import type { FacadeMemorySnapshotEntry, FacadeMemorySnapshotResource, FacadeResource } from './facade-types';

const alternateWorkspaceRoot = '/mnt/session';
const githubCredentialRoot = '/tmp/oca-github';
const memoryAwarenessPVCPath = '.qoder/awareness';
const agentSkillsPVCPath = '.agents/skills';
const execFile = promisify(execFileCallback);
function awarenessRoot(): string {
	return process.env['OCA_AWARENESS_ROOT'] ?? '/data/.qoder/awareness';
}

interface FileMaterializationPlan {
  destination: string;
  url: URL;
  expectedSize: number;
  canonicalPVCPath: string;
}

interface GitHubRepositoryMaterializationPlan {
	destination: string;
	pvcPath: string;
	repositoryURL: URL;
	resourceID: string;
	authorizationToken: string;
	checkoutName?: string;
}

interface GitHubCredentialHelper {
	helperPath: string;
	tokenPath: string;
}

/**
 * Materialize File resources before kimi-code starts. Download URLs originate
 * from the owner-scoped object store adapter; the facade accepts only HTTP(S)
 * URLs and writes only inside PVC-backed workspace roots.
 */
export async function materializeFileResources(
  resources: readonly FacadeResource[],
  workDir: string,
): Promise<void> {
  const occupiedPVCPaths = new Set<string>();
  const plans: FileMaterializationPlan[] = [];
  for (const resource of resources) {
    if (resource.type !== 'file') continue;
    const plan = await planFileMaterialization(resource, workDir);
		if (hasWorkspacePVCPathConflict(occupiedPVCPaths, plan.canonicalPVCPath)) {
      throw new Error('file resources share a PVC target');
    }
    occupiedPVCPaths.add(plan.canonicalPVCPath);
    plans.push(plan);
  }
  for (const plan of plans) {
    await materializeFileResource(plan, workDir);
  }
}

/**
 * Materialize all supported Session resources. Memory Store entries are real
 * sandbox files, never first-prompt text. The shared awareness root is
 * intentionally outside the workspace so ordinary File attachments cannot
 * collide with persistent Agent memory.
 */
export async function materializeSessionResources(
	resources: readonly FacadeResource[],
	workDir: string,
): Promise<void> {
	validateDistinctWorkspacePVCPaths(resources);
	await materializeFileResources(resources, workDir);
	await materializeGitHubRepositoryResources(resources, workDir);
	if (resources.some((resource) => resource.type === 'memory_store')) {
		await materializeMemoryStoreResources(resources);
	}
}

/**
 * Clone GitHub repository resources with a short-lived credential helper.
 * The helper and token remain on the pod's tmpfs, while the clone's remote
 * URL stays credential-free on the workspace PVC.
 */
export async function materializeGitHubRepositoryResources(
	resources: readonly FacadeResource[],
	workDir: string,
): Promise<void> {
	const occupiedPVCPaths = new Set<string>();
	const plans: GitHubRepositoryMaterializationPlan[] = [];
	for (const resource of resources) {
		if (resource.type !== 'github_repository') continue;
		const plan = await planGitHubRepositoryMaterialization(resource, workDir);
		if (hasWorkspacePVCPathConflict(occupiedPVCPaths, plan.pvcPath)) {
			throw new Error('github repository resources share a PVC target');
		}
		occupiedPVCPaths.add(plan.pvcPath);
		plans.push(plan);
	}
	for (const plan of plans) await materializeGitHubRepository(plan);
}

export async function materializeReadOnlyMemoryStoreResources(resources: readonly FacadeResource[]): Promise<void> {
	const readOnlyResources = resources.filter((resource) => resource.access === 'read_only');
	if (readOnlyResources.length > 0) {
		await materializeMemoryStoreResources(readOnlyResources);
	}
}

// snapshotMemoryStoreResources returns only writable resource state. The
// resource-entry baseline is retained by the facade, so the orchestrator can
// use it as the optimistic-concurrency precondition for every write-back.
export async function snapshotMemoryStoreResources(resources: readonly FacadeResource[]): Promise<FacadeMemorySnapshotResource[]> {
	const writableResources = resources.filter((resource) => resource.type === 'memory_store' && resource.access !== 'read_only');
	if (writableResources.length === 0) return [];

	const baselineByPath = new Map<string, { resource: FacadeResource; entry: NonNullable<FacadeResource['memoryEntries']>[number] }>();
	const readOnlyPaths = new Set<string>();
	for (const resource of resources) {
		if (resource.type !== 'memory_store') continue;
		if (resource.memoryStoreId === undefined) throw new Error('memory store resource id is missing');
		for (const entry of resource.memoryEntries ?? []) {
			if (resource.access === 'read_only') {
				readOnlyPaths.add(entry.path);
				continue;
			}
			if (baselineByPath.has(entry.path)) throw new Error('memory store resources share a memory path');
			baselineByPath.set(entry.path, { resource, entry });
		}
	}

	const files = await readAwarenessFiles();
	const entriesByResource = new Map<string, FacadeMemorySnapshotEntry[]>();
	for (const resource of writableResources) entriesByResource.set(resource.id, []);

	for (const [path, baseline] of baselineByPath) {
		const content = files.get(path);
		if (content !== undefined) validateMemorySnapshotEntry(path, content);
		entriesByResource.get(baseline.resource.id)?.push({
			id: baseline.entry.id,
			path,
			contentSha256: baseline.entry.contentSha256,
			deleted: content === undefined,
			...(content === undefined ? {} : { content }),
		});
		files.delete(path);
	}
	for (const path of readOnlyPaths) files.delete(path);

	if (files.size > 0 && writableResources.length !== 1) {
		throw new Error('new awareness files require exactly one writable memory store');
	}
	const defaultResource = writableResources[0];
	if (defaultResource === undefined) throw new Error('writable memory store resource is missing');
	for (const [path, content] of files) {
		validateMemorySnapshotEntry(path, content);
		entriesByResource.get(defaultResource.id)?.push({
			id: '',
			path,
			contentSha256: '',
			deleted: false,
			content,
		});
	}

	return writableResources.map((resource) => ({
		resourceId: resource.id,
		memoryStoreId: resource.memoryStoreId ?? '',
		entries: entriesByResource.get(resource.id) ?? [],
	}));
}

async function materializeMemoryStoreResources(resources: readonly FacadeResource[]): Promise<void> {
	const root = await ensureMemoryRoot();
	const occupiedPaths = new Set<string>();
	for (const resource of resources) {
		if (resource.type !== 'memory_store') continue;
		if (resource.memoryStoreId === undefined || resource.memoryStoreId.length === 0) {
			throw new Error('memory store resource id is missing');
		}
		if (resource.access !== undefined && resource.access !== 'read_only' && resource.access !== 'read_write') {
			throw new Error('memory store resource access is invalid');
		}
		for (const entry of resource.memoryEntries ?? []) {
			const destination = resolveMemoryDestination(root, entry.path);
			if (occupiedPaths.has(destination)) {
				throw new Error('memory store resources share a memory path');
			}
			occupiedPaths.add(destination);
			await materializeMemoryEntry(root, destination, entry.content, resource.access === 'read_only');
		}
	}
}

async function planGitHubRepositoryMaterialization(resource: FacadeResource, workDir: string): Promise<GitHubRepositoryMaterializationPlan> {
	if (resource.mountPath === undefined || resource.pvcPath === undefined || resource.authorizationToken === undefined) {
		throw new Error('github repository materialization metadata is missing');
	}
	if (resource.authorizationToken.length === 0) throw new Error('github repository authorization token is missing');
	if (resource.url === undefined) throw new Error('github repository URL is missing');
	const repositoryURL = new URL(resource.url);
	if (repositoryURL.protocol !== 'https:' || repositoryURL.username !== '' || repositoryURL.password !== '' || repositoryURL.search !== '' || repositoryURL.hash !== '') {
		throw new Error('github repository URL must use credential-free HTTPS');
	}
	const workspace = await realpath(workDir);
	const pvcPath = canonicalWorkspacePVCPath(resource.pvcPath);
	const destination = resolve(workspace, pvcPath);
	if (!isWithin(workspace, destination) || destination === workspace) {
		throw new Error('github repository destination is outside the workspace');
	}
	const checkoutName = checkoutTargetName(resource.checkout);
	return {
		destination,
		pvcPath,
		repositoryURL,
		resourceID: resource.id,
		authorizationToken: resource.authorizationToken,
		...(checkoutName !== undefined ? { checkoutName } : {}),
	};
}

async function materializeGitHubRepository(plan: GitHubRepositoryMaterializationPlan): Promise<void> {
	await mkdir(dirname(plan.destination), { recursive: true });
	const credential = await writeGitHubCredentialHelper(plan.resourceID, plan.authorizationToken);
	const credentialConfig = `!${credential.helperPath}`;
	if (await isGitRepository(plan.destination)) {
		await configureGitHubRepositoryCredential(plan.destination, credentialConfig, credential.tokenPath);
		return;
	}
	try {
		await lstat(plan.destination);
		throw new Error('github repository destination already exists')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	await execFile('git', [
		'-c', `credential.helper=${credentialConfig}`,
		'-c', 'credential.useHttpPath=true',
		'clone', '--', plan.repositoryURL.toString(), plan.destination,
	], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
	await configureGitHubRepositoryCredential(plan.destination, credentialConfig, credential.tokenPath);
	if (plan.checkoutName !== undefined) {
		await execFile('git', ['-C', plan.destination, 'checkout', '--quiet', plan.checkoutName]);
	}
}

async function isGitRepository(destination: string): Promise<boolean> {
	try {
		const result = await execFile('git', ['-C', destination, 'rev-parse', '--is-inside-work-tree']);
		return result.stdout.trim() === 'true';
	} catch {
		return false;
	}
}

async function configureGitHubRepositoryCredential(destination: string, credentialConfig: string, tokenPath: string): Promise<void> {
	await execFile('git', ['-C', destination, 'config', 'credential.helper', credentialConfig]);
	await execFile('git', ['-C', destination, 'config', 'credential.useHttpPath', 'true']);
	await execFile('git', ['-C', destination, 'config', 'oca.github.token-file', tokenPath]);
}

async function writeGitHubCredentialHelper(resourceID: string, authorizationToken: string): Promise<GitHubCredentialHelper> {
	const encodedID = Buffer.from(resourceID).toString('base64url');
	const directory = join(githubCredentialRoot, encodedID);
	const tokenPath = join(directory, 'token');
	const helperPath = join(directory, 'credential-helper');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	await writeFile(tokenPath, authorizationToken, { mode: 0o600 });
	await chmod(tokenPath, 0o600);
	await writeFile(helperPath, `#!/bin/sh\nif [ "$1" = get ]; then\n  printf 'username=x-access-token\\n'\n  printf 'password='\n  cat ${tokenPath}\n  printf '\\n'\nfi\n`, { mode: 0o700 });
	await chmod(helperPath, 0o700);
	await ensureGitHubCLIWrapper();
	return { helperPath, tokenPath };
}

// Git supports a credential helper per repository, while gh otherwise accepts
// only one process-wide token. This wrapper resolves the repository-local
// token at invocation time so Sessions with several repositories do not let
// the last materialized token overwrite the others.
async function ensureGitHubCLIWrapper(): Promise<void> {
	const binDirectory = join(githubCredentialRoot, 'bin');
	const wrapperPath = join(binDirectory, 'gh');
	await mkdir(binDirectory, { recursive: true, mode: 0o700 });
	await chmod(binDirectory, 0o700);
	await writeFile(wrapperPath, `#!/bin/sh\ntoken_file="$(git config --get oca.github.token-file 2>/dev/null || true)"\nif [ -n "$token_file" ] && [ -r "$token_file" ]; then\n  GH_TOKEN="$(cat "$token_file")"\n  export GH_TOKEN\n  GH_ENTERPRISE_TOKEN="$GH_TOKEN"\n  export GH_ENTERPRISE_TOKEN\nfi\nexec /usr/bin/gh "$@"\n`, { mode: 0o700 });
	await chmod(wrapperPath, 0o700);
	const path = process.env['PATH'] ?? '';
	if (!path.split(':').includes(binDirectory)) {
		process.env['PATH'] = `${binDirectory}:${path}`;
	}
}

// validateDistinctWorkspacePVCPaths is reusable by the facade state layer
// before it accepts an incremental resource update. File and GitHub resource
// mount roots are aliases of the same PVC, so a type-local check is unsafe.
export function validateDistinctWorkspacePVCPaths(resources: readonly FacadeResource[]): void {
	const paths = new Set<string>();
	for (const resource of resources) {
		if (resource.type !== 'file' && resource.type !== 'github_repository') continue;
		if (resource.pvcPath === undefined) continue;
		const pvcPath = canonicalWorkspacePVCPath(resource.pvcPath);
		if (workspacePVCPathsOverlap(memoryAwarenessPVCPath, pvcPath) || workspacePVCPathsOverlap(agentSkillsPVCPath, pvcPath)) {
			throw new Error('Session resource targets a reserved system directory');
		}
		if (hasWorkspacePVCPathConflict(paths, pvcPath)) {
			throw new Error('Session resources share a PVC target');
		}
		paths.add(pvcPath);
	}
}

function canonicalWorkspacePVCPath(value: string): string {
	if (value.startsWith('/') || value.includes('\\') || value.length === 0) {
		throw new Error('workspace PVC path is invalid');
	}
	const segments = value.split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new Error('workspace PVC path is invalid');
	}
	return value;
}

function hasWorkspacePVCPathConflict(existingPaths: ReadonlySet<string>, candidate: string): boolean {
	for (const path of existingPaths) {
		if (workspacePVCPathsOverlap(path, candidate)) return true;
	}
	return false;
}

function workspacePVCPathsOverlap(left: string, right: string): boolean {
	return left === '.' || right === '.' || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

// configureGitHubTokenEnvironment preserves Qoder's single-repository
// GH_TOKEN behavior. Multi-repository Sessions use the gh wrapper instead:
// one process environment cannot safely represent different repository
// tokens, while the wrapper resolves the current repository's token.
export function configureGitHubTokenEnvironment(resources: readonly FacadeResource[]): void {
	const repositories = resources.filter((resource) => resource.type === 'github_repository');
	if (repositories.length === 0) return;
	if (repositories.length === 1 && repositories[0]?.authorizationToken !== undefined) {
		process.env['GH_TOKEN'] = repositories[0].authorizationToken;
		process.env['GH_ENTERPRISE_TOKEN'] = repositories[0].authorizationToken;
		return;
	}
	delete process.env['GH_TOKEN'];
	delete process.env['GH_ENTERPRISE_TOKEN'];
}

function checkoutTargetName(checkout: FacadeResource['checkout']): string | undefined {
	if (checkout === undefined) return undefined;
	const name = checkout['name'];
	if (typeof name !== 'string' || name.trim().length === 0 || name.startsWith('-')) {
		throw new Error('github repository checkout name is invalid');
	}
	return name;
}

async function planFileMaterialization(resource: FacadeResource, workDir: string): Promise<FileMaterializationPlan> {
  const mountPath = resource.mountPath;
  const downloadUrl = resource.downloadUrl;
  const pvcPath = resource.pvcPath;
  const expectedSize = resource.size;
  if (mountPath === undefined || downloadUrl === undefined || pvcPath === undefined || expectedSize === undefined) {
    throw new Error('file resource materialization metadata is missing');
  }
  if (mountPath.split('/').includes('..')) {
    throw new Error('file resource mount path contains invalid path traversal');
  }
  const { destination, canonicalPVCPath } = await resolveDestination(workDir, mountPath);
  if (canonicalWorkspacePVCPath(pvcPath) !== canonicalPVCPath) {
    throw new Error('file resource PVC path does not match mount path');
  }
  const url = new URL(downloadUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('file resource download URL must use HTTP(S)');
  }
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error('file resource size is invalid');
  }

  return { destination, url, expectedSize, canonicalPVCPath };
}

async function materializeFileResource(plan: FileMaterializationPlan, workDir: string): Promise<void> {
  const { destination, url, expectedSize } = plan;

  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok || response.body === null) {
    throw new Error('file resource download failed');
  }
  const advertisedSize = response.headers.get('content-length');
  if (advertisedSize !== null && Number(advertisedSize) !== expectedSize) {
    throw new Error('file resource download size does not match metadata');
  }

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  await verifyMaterializationParent(workDir, parent);
  await rejectSymlinkDestination(destination);

  const temporary = `${destination}.oca-${randomUUID()}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    let received = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        received += chunk.length;
        if (received > expectedSize) {
          throw new Error('file resource download exceeds metadata size');
        }
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    if (received !== expectedSize) {
      throw new Error('file resource download size does not match metadata');
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function ensureMemoryRoot(): Promise<string> {
	const root = awarenessRoot();
	await mkdir(root, { recursive: true });
	return realpath(root);
}

async function readAwarenessFiles(): Promise<Map<string, string>> {
	const root = awarenessRoot();
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('memory awareness root is invalid');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
		throw error;
	}
	const files = new Map<string, string>();
	await collectAwarenessFiles(root, root, files);
	return files;
}

async function collectAwarenessFiles(root: string, directory: string, files: Map<string, string>): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error('memory awareness path is a symlink');
		if (entry.isDirectory()) {
			await collectAwarenessFiles(root, path, files);
			continue;
		}
		if (!entry.isFile()) throw new Error('memory awareness path is not a regular file');
		const relativePath = relative(root, path).split(sep).join('/');
		files.set(relativePath, await readFile(path, 'utf8'));
	}
}

function resolveMemoryDestination(root: string, path: string): string {
	if (path.length === 0 || [...path].length > 1024 || path.startsWith('/') || path.includes('..')) {
		throw new Error('memory path is invalid');
	}
	const destination = resolve(root, path);
	if (!isWithin(root, destination) || destination === root) {
		throw new Error('memory path is outside awareness root');
	}
	return destination;
}

function validateMemorySnapshotEntry(path: string, content: string): void {
	if (path.length === 0 || [...path].length > 1024 || path.startsWith('/') || path.includes('..')) {
		throw new Error('memory path is invalid');
	}
	if (Buffer.byteLength(content, 'utf8') > 100 * 1024 || content.trim().length === 0) {
		throw new Error('memory content violates the Memory Store contract');
	}
}

async function materializeMemoryEntry(root: string, destination: string, content: string, readOnly: boolean): Promise<void> {
	const parent = dirname(destination);
	await mkdir(parent, { recursive: true });
	const resolvedParent = await realpath(parent);
	if (!isWithin(root, resolvedParent)) {
		throw new Error('memory parent escapes awareness root');
	}
	await rejectSymlinkDestination(destination);
	const temporary = `${destination}.oca-${randomUUID()}`;
	try {
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(content, 'utf8');
		} finally {
			await handle.close();
		}
		await rename(temporary, destination);
		await chmod(destination, readOnly ? 0o444 : 0o600);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

async function resolveDestination(workDir: string, mountPath: string): Promise<{ destination: string; canonicalPVCPath: string }> {
  const workspace = await realpath(workDir);
  const destination = resolve(mountPath.startsWith('/') ? mountPath : workspace, mountPath);
  if (isWithin(workspace, destination)) {
    return { destination, canonicalPVCPath: relative(workspace, destination) };
  }
  if (isWithin(alternateWorkspaceRoot, destination)) {
    return { destination, canonicalPVCPath: relative(alternateWorkspaceRoot, destination) };
  }
  throw new Error('file resource mount path is outside the workspace');
}

async function verifyMaterializationParent(workDir: string, parent: string): Promise<void> {
  const workspace = await realpath(workDir);
  const resolvedParent = await realpath(parent);
  if (!isWithin(workspace, resolvedParent) && !isWithin(alternateWorkspaceRoot, resolvedParent)) {
    throw new Error('file resource mount parent escapes the workspace');
  }
}

async function rejectSymlinkDestination(destination: string): Promise<void> {
  try {
    const stat = await lstat(destination);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      throw new Error('file resource destination is not a regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.includes('/../'));
}
