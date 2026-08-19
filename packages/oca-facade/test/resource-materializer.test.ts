import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { configureGitHubTokenEnvironment, materializeFileResources, materializeGitHubRepositoryResources, materializeSessionResources, snapshotMemoryStoreResources, validateDistinctWorkspacePVCPaths } from '../src/resource-materializer';
import { materializeSessionSkills } from '../src/skill-materializer';

import { writeSkillArchive } from './skill-archive-fixture';

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
      const requestURL = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (requestURL === url) {
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
    const archive = await writeSkillArchive(workDir, {
      name: 'review',
      files: {
        'SKILL.md': '---\nname: review\ndescription: Review code\n---\n',
        'references/checklist.md': 'check\n',
      },
    });
    await materializeSessionSkills([{
      id: archive.descriptor.id,
      name: archive.descriptor.name,
      version: archive.descriptor.version,
		origin: archive.descriptor.origin,
      contentSize: archive.descriptor.content_size,
      contentSHA256: archive.descriptor.content_sha256,
    }], [{ path: archive.path }], workDir);

    await expect(readFile(join(workDir, '.agents/skills/review/SKILL.md'), 'utf8')).resolves.toContain('name: review');
    await expect(readFile(join(workDir, '.agents/skills/review/references/checklist.md'), 'utf8')).resolves.toBe('check\n');
  });

  it('rejects an archive whose root does not match its descriptor', async () => {
    const workDir = await workspace();
    const archive = await writeSkillArchive(workDir, { name: 'review' });
    await expect(materializeSessionSkills([{
      id: archive.descriptor.id,
      name: 'different',
      version: archive.descriptor.version,
		origin: archive.descriptor.origin,
      contentSize: archive.descriptor.content_size,
      contentSHA256: archive.descriptor.content_sha256,
    }], [{ path: archive.path }], workDir)).rejects.toThrow('root does not match descriptor');
  });

  it('materializes a canonical archive with a quoted YAML manifest name', async () => {
    const workDir = await workspace();
    const archive = await writeSkillArchive(workDir, {
      name: 'review',
      files: {
        'SKILL.md': '---\nname: "review"\ndescription: Review code\n---\n',
      },
    });
    await materializeSessionSkills([{
      id: archive.descriptor.id,
      name: archive.descriptor.name,
      version: archive.descriptor.version,
		origin: archive.descriptor.origin,
      contentSize: archive.descriptor.content_size,
      contentSHA256: archive.descriptor.content_sha256,
    }], [{ path: archive.path }], workDir);

    await expect(readFile(join(workDir, '.agents/skills/review/SKILL.md'), 'utf8')).resolves.toContain('name: "review"');
  });

	it('allows more than 256 Managed Skill entries while retaining the Forward limit', async () => {
		const workDir = await workspace();
		const files: Record<string, string> = {
			'SKILL.md': '---\nname: review\ndescription: Review code\n---\n',
		};
		for (let index = 1; index <= 256; index += 1) {
			files[`references/${index}.md`] = 'reference\n';
		}
		const archive = await writeSkillArchive(workDir, { name: 'review', files });
		const managed = {
			id: archive.descriptor.id,
			name: archive.descriptor.name,
			version: archive.descriptor.version,
			origin: 'managed' as const,
			contentSize: archive.descriptor.content_size,
			contentSHA256: archive.descriptor.content_sha256,
		};
		await materializeSessionSkills([managed], [{ path: archive.path }], workDir);
		await expect(readFile(join(workDir, '.agents/skills/review/references/256.md'), 'utf8')).resolves.toBe('reference\n');

		await expect(materializeSessionSkills([{ ...managed, origin: 'forward' as const }], [{ path: archive.path }], workDir)).rejects.toThrow('file count is invalid');
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

  it('lets later read-only Forward mounts shadow a writable path without writing it back', async () => {
    const workDir = await workspace();
    const awareness = join(workDir, 'awareness');
    const priorAwareness = process.env['OCA_AWARENESS_ROOT'];
    process.env['OCA_AWARENESS_ROOT'] = awareness;
    try {
      const resources = [
        { id: 'default', type: 'memory_store' as const, memoryStoreId: 'default', access: 'read_write' as const, memoryEntries: [
          { id: 'default_same', path: 'same.md', content: 'default', contentSha256: 'default-hash' },
          { id: 'default_writable', path: 'writable.md', content: 'before', contentSha256: 'writable-hash' },
        ] },
        { id: 'first', type: 'memory_store' as const, memoryStoreId: 'first', access: 'read_only' as const, memoryEntries: [
          { id: 'first_same', path: 'same.md', content: 'first shadow', contentSha256: 'first-hash' },
        ] },
        { id: 'second', type: 'memory_store' as const, memoryStoreId: 'second', access: 'read_only' as const, memoryEntries: [
          { id: 'second_same', path: 'same.md', content: 'second shadow', contentSha256: 'second-hash' },
        ] },
      ];
      await materializeSessionResources(resources, workDir);
      await expect(readFile(join(awareness, 'same.md'), 'utf8')).resolves.toBe('second shadow');
      expect((await stat(join(awareness, 'same.md'))).mode & 0o222).toBe(0);
      await writeFile(join(awareness, 'writable.md'), 'after', 'utf8');

      await expect(snapshotMemoryStoreResources(resources)).resolves.toEqual([{
        resourceId: 'default', memoryStoreId: 'default',
        entries: [{ id: 'default_writable', path: 'writable.md', contentSha256: 'writable-hash', deleted: false, content: 'after' }],
      }]);
    } finally {
      if (priorAwareness === undefined) delete process.env['OCA_AWARENESS_ROOT'];
      else process.env['OCA_AWARENESS_ROOT'] = priorAwareness;
    }
  });

  it('uses the Forward Memory path and content contract for materialization and snapshots', async () => {
    const workDir = await workspace();
    const awareness = join(workDir, 'awareness');
    const priorAwareness = process.env['OCA_AWARENESS_ROOT'];
    process.env['OCA_AWARENESS_ROOT'] = awareness;
    try {
      await materializeSessionResources([{
        id: 'res_memory', type: 'memory_store', memoryStoreId: 'memstore_1',
        memoryEntries: [{ id: 'mem_1', path: 'releases/v1..v2.md', content: 'release\u0080notes', contentSha256: 'hash' }],
      }], workDir);
      await expect(readFile(join(awareness, 'releases/v1..v2.md'), 'utf8')).resolves.toBe('release\u0080notes');
      await expect(materializeSessionResources([{
        id: 'res_blank', type: 'memory_store', memoryStoreId: 'memstore_blank',
        memoryEntries: [{ id: 'mem_blank', path: 'blank.md', content: ' \t\n', contentSha256: 'hash' }],
      }], workDir)).resolves.toBeUndefined();
      await expect(readFile(join(awareness, 'blank.md'), 'utf8')).resolves.toBe(' \t\n');
      await expect(materializeSessionResources([{
        id: 'res_empty', type: 'memory_store', memoryStoreId: 'memstore_empty',
        memoryEntries: [{ id: 'mem_empty', path: 'empty.md', content: '', contentSha256: 'hash' }],
      }], workDir)).resolves.toBeUndefined();
      await expect(readFile(join(awareness, 'empty.md'), 'utf8')).resolves.toBe('');
      await expect(materializeSessionResources([{
        id: 'res_u0085', type: 'memory_store', memoryStoreId: 'memstore_u0085',
        memoryEntries: [{ id: 'mem_u0085', path: '\u0085forbidden.md', content: 'content', contentSha256: 'hash' }],
      }], workDir)).rejects.toThrow('memory path is invalid');
      await expect(materializeSessionResources([{
        id: 'res_ufeff', type: 'memory_store', memoryStoreId: 'memstore_ufeff',
        memoryEntries: [{ id: 'mem_ufeff', path: '\uFEFFallowed.md', content: 'content', contentSha256: 'hash' }],
      }], workDir)).resolves.toBeUndefined();
      await expect(readFile(join(awareness, '\uFEFFallowed.md'), 'utf8')).resolves.toBe('content');
      const boundaryContent = 'a'.repeat(100 * 1024);
      await expect(materializeSessionResources([{
        id: 'res_boundary', type: 'memory_store', memoryStoreId: 'memstore_boundary',
        memoryEntries: [{ id: 'mem_boundary', path: 'boundary.md', content: boundaryContent, contentSha256: 'hash' }],
      }], workDir)).resolves.toBeUndefined();
      await expect(readFile(join(awareness, 'boundary.md'), 'utf8')).resolves.toBe(boundaryContent);
      await expect(materializeSessionResources([{
        id: 'res_carriage_return', type: 'memory_store', memoryStoreId: 'memstore_carriage_return',
        memoryEntries: [{ id: 'mem_carriage_return', path: 'carriage-return.md', content: 'first\rsecond', contentSha256: 'hash' }],
      }], workDir)).resolves.toBeUndefined();
      await expect(readFile(join(awareness, 'carriage-return.md'), 'utf8')).resolves.toBe('first\rsecond');
      await writeFile(join(awareness, 'bad\\name.md'), 'valid', 'utf8');
      await expect(snapshotMemoryStoreResources([{ id: 'res_memory', type: 'memory_store', memoryStoreId: 'memstore_1', memoryEntries: [] }])).rejects.toThrow('memory path is invalid');
      await rm(join(awareness, 'bad\\name.md'));
      await writeFile(join(awareness, 'control.md'), 'invalid\u0001content', 'utf8');
      await expect(snapshotMemoryStoreResources([{ id: 'res_memory', type: 'memory_store', memoryStoreId: 'memstore_1', memoryEntries: [] }])).rejects.toThrow('memory content violates the Memory Store contract');
      await rm(join(awareness, 'control.md'));
      await writeFile(join(awareness, 'del-control.md'), 'invalid\u007Fcontent', 'utf8');
      await expect(snapshotMemoryStoreResources([{ id: 'res_memory', type: 'memory_store', memoryStoreId: 'memstore_1', memoryEntries: [] }])).rejects.toThrow('memory content violates the Memory Store contract');
      await rm(join(awareness, 'del-control.md'));
      await writeFile(join(awareness, '\u0085forbidden.md'), 'valid', 'utf8');
      await expect(snapshotMemoryStoreResources([{ id: 'res_memory', type: 'memory_store', memoryStoreId: 'memstore_1', memoryEntries: [] }])).rejects.toThrow('memory path is invalid');
      await rm(join(awareness, '\u0085forbidden.md'));
      await writeFile(join(awareness, '\uFEFFallowed.md'), 'valid', 'utf8');
      const snapshot = await snapshotMemoryStoreResources([{ id: 'res_memory', type: 'memory_store', memoryStoreId: 'memstore_1', memoryEntries: [] }]);
      expect(snapshot[0]?.entries).toContainEqual({
        id: '', path: '\uFEFFallowed.md', contentSha256: '', deleted: false, content: 'valid',
      });
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
