import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configureGitHubTokenEnvironment, materializeFileResources, materializeGitHubRepositoryResources, materializeSessionResources, snapshotMemoryStoreResources, validateDistinctWorkspacePVCPaths } from '../src/resource-materializer';
import { materializeSessionSkills } from '../src/skill-materializer';

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oca-resource-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe('file resource materialization', () => {
  it('writes an owner-provided download into the requested workspace path', async () => {
    const workDir = await workspace();
    const payload = 'resource contents\n';
    const url = 'https://storage.example.test/file_1';
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input) === url) {
        return Promise.resolve(new Response(payload, {
          status: 200,
          headers: { 'content-length': String(Buffer.byteLength(payload)) },
        }));
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await materializeFileResources([{
        id: 'res_1',
        type: 'file',
        fileId: 'file_1',
        mountPath: 'inputs/spec.txt',
        pvcPath: 'inputs/spec.txt',
        downloadUrl: url,
        size: Buffer.byteLength(payload),
      }], workDir);
    } finally {
      globalThis.fetch = realFetch;
    }
    await expect(readFile(join(workDir, 'inputs/spec.txt'), 'utf-8')).resolves.toBe(payload);
  });

  it('rejects destinations outside PVC-backed workspace roots', async () => {
    const workDir = await workspace();
    await expect(materializeFileResources([{
      id: 'res_1',
      type: 'file',
      mountPath: '/etc/host-overwrite',
      pvcPath: 'host-overwrite',
      downloadUrl: 'https://storage.example.test/file_1',
      size: 0,
    }], workDir)).rejects.toThrow('outside the workspace');
  });

  it('rejects colliding PVC targets before downloading either resource', async () => {
    const workDir = await workspace();
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error('download should not start'));
    }) as typeof fetch;
    try {
      await expect(materializeFileResources([
        {
          id: 'res_1',
          type: 'file',
          fileId: 'file_1',
          mountPath: 'input.txt',
          pvcPath: 'input.txt',
          downloadUrl: 'https://storage.example.test/file_1',
          size: 0,
        },
        {
          id: 'res_2',
          type: 'file',
          fileId: 'file_2',
          mountPath: 'input.txt',
          pvcPath: 'input.txt',
          downloadUrl: 'https://storage.example.test/file_2',
          size: 0,
        },
      ], workDir)).rejects.toThrow('share a PVC target');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchCalls).toBe(0);
  });
});

describe('Skill materialization', () => {
  it('writes validated files to the kimi-code project skill root', async () => {
    const workDir = await workspace();
    await materializeSessionSkills([{
      id: 'skill_1',
      name: 'review',
      version: 2,
      files: [
        { path: 'SKILL.md', contentBase64: Buffer.from('---\nname: review\ndescription: Review code\n---\n').toString('base64') },
        { path: 'references/checklist.md', contentBase64: Buffer.from('check\n').toString('base64') },
      ],
    }], workDir);

    await expect(readFile(join(workDir, '.agents/skills/review/SKILL.md'), 'utf8')).resolves.toContain('name: review');
    await expect(readFile(join(workDir, '.agents/skills/review/references/checklist.md'), 'utf8')).resolves.toBe('check\n');
  });

  it('rejects non-canonical archive paths', async () => {
    const workDir = await workspace();
    for (const path of ['../outside.txt', 'references/../duplicate.md']) {
      await expect(materializeSessionSkills([{
        id: 'skill_1',
        name: 'review',
        version: 1,
        files: [
          { path: 'SKILL.md', contentBase64: Buffer.from('skill').toString('base64') },
          { path, contentBase64: Buffer.from('no').toString('base64') },
        ],
      }], workDir)).rejects.toThrow('path is invalid');
    }
  });
});

describe('GitHub repository resource materialization', () => {
	it('clones with a tmpfs credential helper and keeps the token out of git arguments', async () => {
		const workDir = await workspace();
		const binDir = join(workDir, 'bin');
		const logPath = join(workDir, 'git.log');
		await mkdir(binDir);
		const gitPath = join(binDir, 'git');
		await writeFile(gitPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$OCA_GIT_LOG"\nfor last do :; done\ncase " $* " in\n  *' config oca.github.token_file '*) exit 1 ;;\n  *' rev-parse '*) [ -d "$2/.git" ] && { printf 'true\\n'; exit 0; }; exit 1 ;;\n  *' clone '*) mkdir -p "$last/.git" ;;\nesac\nexit 0\n`);
		await chmod(gitPath, 0o755);
		const priorPath = process.env['PATH'];
		const priorLog = process.env['OCA_GIT_LOG'];
		const credentialDirectory = join('/tmp/oca-github', Buffer.from('sesr_github_1').toString('base64url'));
		process.env['PATH'] = `${binDir}:${priorPath ?? ''}`;
		process.env['OCA_GIT_LOG'] = logPath;
		try {
			await materializeGitHubRepositoryResources([{
				id: 'sesr_github_1',
				type: 'github_repository',
				url: 'https://github.example.test/org/repository',
				mountPath: '/data/workspace/repository',
				pvcPath: 'workspace/repository',
				authorizationToken: 'token-must-not-appear-in-arguments',
				checkout: { type: 'branch', name: 'main' },
			}], workDir);
			const calls = await readFile(logPath, 'utf8');
			expect(calls).toContain('clone -- https://github.example.test/org/repository');
			expect(calls).toContain('config oca.github.token-file');
			expect(calls).toContain('checkout --quiet main');
			expect(calls).not.toContain('token-must-not-appear-in-arguments');
			const wrapper = await readFile(join('/tmp/oca-github', 'bin', 'gh'), 'utf8');
			expect(wrapper).toContain('oca.github.token-file');
			expect(wrapper).not.toContain('oca.github.token_file');
			const configuredTokenPath = (await readFile(join(credentialDirectory, 'token'), 'utf8')).trim();
			expect(configuredTokenPath).toBe('token-must-not-appear-in-arguments');
			expect(process.env['GH_TOKEN']).not.toBe('token-must-not-appear-in-arguments');
		} finally {
			if (priorPath === undefined) delete process.env['PATH'];
			else process.env['PATH'] = priorPath;
			if (priorLog === undefined) delete process.env['OCA_GIT_LOG'];
			else process.env['OCA_GIT_LOG'] = priorLog;
			await rm(credentialDirectory, { recursive: true, force: true });
		}
	});

	it('uses GH_TOKEN for one repository and clears it for distinct multi-repository tokens', () => {
		const priorToken = process.env['GH_TOKEN'];
		const priorEnterpriseToken = process.env['GH_ENTERPRISE_TOKEN'];
		try {
			configureGitHubTokenEnvironment([{ id: 'github_1', type: 'github_repository', authorizationToken: 'one' }]);
			expect(process.env['GH_TOKEN']).toBe('one');
			expect(process.env['GH_ENTERPRISE_TOKEN']).toBe('one');
			configureGitHubTokenEnvironment([
				{ id: 'github_1', type: 'github_repository', authorizationToken: 'one' },
				{ id: 'github_2', type: 'github_repository', authorizationToken: 'two' },
			]);
			expect(process.env['GH_TOKEN']).toBeUndefined();
			expect(process.env['GH_ENTERPRISE_TOKEN']).toBeUndefined();
		} finally {
			if (priorToken === undefined) delete process.env['GH_TOKEN'];
			else process.env['GH_TOKEN'] = priorToken;
			if (priorEnterpriseToken === undefined) delete process.env['GH_ENTERPRISE_TOKEN'];
			else process.env['GH_ENTERPRISE_TOKEN'] = priorEnterpriseToken;
		}
	});

	it('rejects File and GitHub resources that share a PVC target', () => {
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'file_1', type: 'file', pvcPath: 'repository' },
			{ id: 'github_1', type: 'github_repository', pvcPath: 'repository' },
		])).toThrow('Session resources share a PVC target');
	});

	it('rejects parent and child PVC targets across File and GitHub resources', () => {
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'github_1', type: 'github_repository', pvcPath: 'repository' },
			{ id: 'file_1', type: 'file', pvcPath: 'repository/config.json' },
		])).toThrow('Session resources share a PVC target');
	});

	it('rejects File and GitHub resources targeting the Memory Store directory', () => {
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'file_1', type: 'file', pvcPath: '.qoder/awareness/notes.md' },
		])).toThrow('reserved system directory');
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'github_1', type: 'github_repository', pvcPath: '.qoder/awareness' },
		])).toThrow('reserved system directory');
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'file_2', type: 'file', pvcPath: '.qoder' },
		])).toThrow('reserved system directory');
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'github_2', type: 'github_repository', pvcPath: '.qoder' },
		])).toThrow('reserved system directory');
	});

	it('rejects File and GitHub resources targeting the Agent Skill directory', () => {
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'file_1', type: 'file', pvcPath: '.agents/skills/review/SKILL.md' },
		])).toThrow('reserved system directory');
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'github_1', type: 'github_repository', pvcPath: '.agents' },
		])).toThrow('reserved system directory');
	});

	it('rejects a PVC target at the workspace root', () => {
		expect(() => validateDistinctWorkspacePVCPaths([
			{ id: 'github_1', type: 'github_repository', pvcPath: '.' },
		])).toThrow('workspace PVC path is invalid');
	});

	it('rejects non-canonical PVC paths before materialization', async () => {
		for (const pvcPath of ['.agents//skills/review', '.agents/./skills', '.agents/skills/../review', 'workspace\\review']) {
			expect(() => validateDistinctWorkspacePVCPaths([
				{ id: 'github_1', type: 'github_repository', pvcPath },
			])).toThrow('workspace PVC path is invalid');
		}

		const workDir = await workspace();
		await expect(materializeGitHubRepositoryResources([{
			id: 'github_1', type: 'github_repository', url: 'https://github.example.test/org/repository',
			mountPath: '/workspace/repository', pvcPath: '.agents//skills/review', authorizationToken: 'token',
		}], workDir)).rejects.toThrow('workspace PVC path is invalid');
	});

	it('rejects a GitHub URL with a query or fragment before cloning', async () => {
		const workDir = await workspace();
		for (const url of [
			'https://github.example.test/org/repository?access_token=must-not-use',
			'https://github.example.test/org/repository#must-not-use',
		]) {
			await expect(materializeGitHubRepositoryResources([{
				id: 'github_1', type: 'github_repository', url,
				mountPath: '/workspace/repository', pvcPath: 'repository', authorizationToken: 'token',
			}], workDir)).rejects.toThrow('credential-free HTTPS');
		}
	});
});

describe('Memory Store resource materialization', () => {
  it('maps writable entries into awareness files and snapshots their changes', async () => {
    const workDir = await workspace();
    const awareness = join(workDir, 'awareness');
    const priorAwareness = process.env['OCA_AWARENESS_ROOT'];
    process.env['OCA_AWARENESS_ROOT'] = awareness;
    try {
      await materializeSessionResources([{
        id: 'res_memory_1',
        type: 'memory_store',
        memoryStoreId: 'memstore_1',
        memoryEntries: [{
          id: 'mem_1',
          path: 'notes/plan.md',
          content: 'before',
          contentSha256: 'mounted-hash',
        }],
      }], workDir);

      await expect(readFile(join(awareness, 'notes/plan.md'), 'utf8')).resolves.toBe('before');
      await writeFile(join(awareness, 'notes/plan.md'), 'after', 'utf8');
      await writeFile(join(awareness, 'new.md'), 'new file', 'utf8');

      await expect(snapshotMemoryStoreResources([{
        id: 'res_memory_1',
        type: 'memory_store',
        memoryStoreId: 'memstore_1',
        memoryEntries: [{
          id: 'mem_1', path: 'notes/plan.md', content: 'before', contentSha256: 'mounted-hash',
        }],
      }])).resolves.toEqual([{
        resourceId: 'res_memory_1',
        memoryStoreId: 'memstore_1',
        entries: [
          { id: 'mem_1', path: 'notes/plan.md', contentSha256: 'mounted-hash', deleted: false, content: 'after' },
          { id: '', path: 'new.md', contentSha256: '', deleted: false, content: 'new file' },
        ],
      }]);
    } finally {
      if (priorAwareness === undefined) delete process.env['OCA_AWARENESS_ROOT'];
      else process.env['OCA_AWARENESS_ROOT'] = priorAwareness;
    }
  });

  it('makes read-only Store entries read-only and excludes them from writable snapshots', async () => {
    const workDir = await workspace();
    const awareness = join(workDir, 'awareness');
    const priorAwareness = process.env['OCA_AWARENESS_ROOT'];
    process.env['OCA_AWARENESS_ROOT'] = awareness;
    try {
      const resources = [
        {
          id: 'res_read_only', type: 'memory_store' as const, memoryStoreId: 'memstore_read_only', access: 'read_only' as const,
          memoryEntries: [{ id: 'mem_ro', path: 'readonly.md', content: 'protected', contentSha256: 'hash-ro' }],
        },
        {
          id: 'res_writable', type: 'memory_store' as const, memoryStoreId: 'memstore_writable',
          memoryEntries: [{ id: 'mem_rw', path: 'writable.md', content: 'editable', contentSha256: 'hash-rw' }],
        },
      ];
      await materializeSessionResources(resources, workDir);
      expect((await stat(join(awareness, 'readonly.md'))).mode & 0o222).toBe(0);

      await expect(snapshotMemoryStoreResources(resources)).resolves.toEqual([
        {
          resourceId: 'res_writable', memoryStoreId: 'memstore_writable',
          entries: [{ id: 'mem_rw', path: 'writable.md', contentSha256: 'hash-rw', deleted: false, content: 'editable' }],
        },
      ]);
    } finally {
      if (priorAwareness === undefined) delete process.env['OCA_AWARENESS_ROOT'];
      else process.env['OCA_AWARENESS_ROOT'] = priorAwareness;
    }
  });

  it('refuses to assign a new awareness file to an arbitrary Store', async () => {
    const workDir = await workspace();
    const awareness = join(workDir, 'awareness');
    const priorAwareness = process.env['OCA_AWARENESS_ROOT'];
    process.env['OCA_AWARENESS_ROOT'] = awareness;
    try {
      const resources = [
        { id: 'res_1', type: 'memory_store' as const, memoryStoreId: 'memstore_1', memoryEntries: [] },
        { id: 'res_2', type: 'memory_store' as const, memoryStoreId: 'memstore_2', memoryEntries: [] },
      ];
      await materializeSessionResources(resources, workDir);
      await writeFile(join(awareness, 'new.md'), 'new file', 'utf8');
      await expect(snapshotMemoryStoreResources(resources)).rejects.toThrow('exactly one writable memory store');
    } finally {
      if (priorAwareness === undefined) delete process.env['OCA_AWARENESS_ROOT'];
      else process.env['OCA_AWARENESS_ROOT'] = priorAwareness;
    }
  });
});
