import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCodes, KimiError, createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { FacadeError } from '../src/errors';
import { writeProfilePolicyState } from '../src/profile-policy-state';
import {
  LiveHarnessFactory,
  QODER_PERMISSION_MODE,
  type FacadeCreateConfig,
  type FacadeEvent,
  type HarnessEventSink,
  type HarnessFactory,
} from '../src/harness';
import { SessionRegistry, type StopReason } from '../src/session-registry';

import { createFakeHarness, type FakeHarness } from './fake-harness';
import { writeSkillArchive } from './skill-archive-fixture';

interface RecordedSink extends HarnessEventSink {
  events: Array<{ sessionId: string; event: FacadeEvent }>;
  turnEnds: Array<{ sessionId: string; stopReason: StopReason }>;
}

function makeSink(): RecordedSink {
  const events: RecordedSink['events'] = [];
  const turnEnds: RecordedSink['turnEnds'] = [];
  return {
    events,
    turnEnds,
    emit(sessionId, event) {
      events.push({ sessionId, event });
    },
    turnEnded(sessionId, stopReason) {
      turnEnds.push({ sessionId, stopReason });
    },
  };
}

interface Setup {
  registry: SessionRegistry;
  sink: ReturnType<typeof makeSink>;
  fake: FakeHarness;
  harness: LiveHarnessFactory;
  workDir: string;
}

const tempDirs: string[] = [];

async function setup(options?: { credentialsDir?: string }): Promise<Setup> {
  const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-harness-'));
  tempDirs.push(workDir);
  await writeProfilePolicyState(workDir, { mainProfile: 'main', policies: new Map([['main', new Map()]]) });
  const registry = new SessionRegistry();
  const sink = makeSink();
  const { fake, createHarness } = createFakeHarness();
  const harness = new LiveHarnessFactory({
    registry,
    sink,
    createHarness,
    ...(options?.credentialsDir !== undefined
      ? { credentialsDir: options.credentialsDir }
      : {}),
    resumeWorkDir: workDir,
  });
  return { registry, sink, fake, harness, workDir };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('permission policy mapping', () => {
  it('keeps the runtime in manual mode for per-tool policy dispatch', () => {
    expect(QODER_PERMISSION_MODE).toBe('manual');
  });
});

describe('live harness factory: create options', () => {
  it('aligns with the sdk harness factory shape', () => {
    // Compile-time alignment: the sdk factory must satisfy the injectable
    // harness factory shape used by the live factory.
    const factory: HarnessFactory = createKimiHarness;
    expect(factory).toBe(createKimiHarness);
  });

  it('assembles create options from the create config', async () => {
    const { fake, harness, workDir } = await setup();
    const config: FacadeCreateConfig = {
      sessionId: 'ses_1',
      workDir,
      model: 'model-x',
      thinking: 'high',
      contextWindow: 262144,
      planMode: true,
      metadata: { tenant: 't-1' },
      additionalDirs: ['/extra'],
    };
    await harness.createSession(config);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toEqual({
      id: 'ses_1',
      workDir,
      model: 'model-x',
      thinking: 'high',
      contextWindow: 262144,
      permission: 'manual',
      planMode: true,
      metadata: { tenant: 't-1' },
      additionalDirs: ['/extra'],
    });
  });

  it('omits unset optional fields from create options', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir });
    expect(fake.created[0]).toEqual({ id: 'ses_1', workDir, permission: 'manual' });
  });

  it('uses manual runtime mode when no per-tool policy is configured', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir });
    expect(fake.created[0]?.permission).toBe('manual');
  });

  it('rejects creating two sessions with the same id', async () => {
    const { harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir });
    await expect(harness.createSession({ sessionId: 'ses_1', workDir })).rejects.toMatchObject({
      code: 'session_state_conflict',
    });
  });
});

describe('live harness factory: resume', () => {
  it('resumes through the runtime with the session id only', async () => {
    const { fake, harness } = await setup();
    await harness.resumeSession('ses_9');
    expect(fake.resumed).toEqual([{ id: 'ses_9' }]);
  });

  it('does not resume the runtime twice for the same session', async () => {
    const { fake, harness } = await setup();
    await harness.resumeSession('ses_9');
    await harness.resumeSession('ses_9');
    expect(fake.resumed).toHaveLength(1);
  });

  it('fails closed when the persisted profile policy state is missing', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'oca-facade-missing-policy-'));
    tempDirs.push(workDir);
    const registry = new SessionRegistry();
    const { fake, createHarness } = createFakeHarness();
    const harness = new LiveHarnessFactory({
      registry,
      sink: makeSink(),
      createHarness,
      resumeWorkDir: workDir,
    });

    await expect(harness.resumeSession('ses_9')).rejects.toMatchObject({ code: 'session_resume_failed' });
    expect(fake.resumed).toEqual([{ id: 'ses_9' }]);
  });

  it('uses the trusted Vault ownership marker to clear a revoked value after resume', async () => {
    const { harness } = await setup();
    const priorMarker = process.env['OCA_FACADE_VAULT_ENV_NAMES'];
    const priorServiceKey = process.env['SERVICE_KEY'];
    try {
      process.env['OCA_FACADE_VAULT_ENV_NAMES'] = 'SERVICE_KEY';
      process.env['SERVICE_KEY'] = 'stale-value';
      await harness.resumeSession('ses_9');
      await harness.updateSessionConfig('ses_9', { vaultEnvironmentVariables: {} });
      expect(process.env['SERVICE_KEY']).toBeUndefined();
    } finally {
      if (priorMarker === undefined) delete process.env['OCA_FACADE_VAULT_ENV_NAMES'];
      else process.env['OCA_FACADE_VAULT_ENV_NAMES'] = priorMarker;
      if (priorServiceKey === undefined) delete process.env['SERVICE_KEY'];
      else process.env['SERVICE_KEY'] = priorServiceKey;
    }
  });

  it('uses the trusted Session ownership marker to replace and clear public values after resume', async () => {
    const { harness } = await setup();
    const names = ['OCA_FACADE_SESSION_ENV_NAMES', 'SESSION_PUBLIC_OLD', 'SESSION_PUBLIC_NEW'] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env['OCA_FACADE_SESSION_ENV_NAMES'] = 'SESSION_PUBLIC_OLD';
      process.env['SESSION_PUBLIC_OLD'] = 'stale value';

      await harness.resumeSession('ses_9');
      await harness.updateSessionConfig('ses_9', {
        sessionEnvironmentVariables: { SESSION_PUBLIC_NEW: 'current value' },
      });
      expect(process.env['SESSION_PUBLIC_OLD']).toBeUndefined();
      expect(process.env['SESSION_PUBLIC_NEW']).toBe('current value');

      await harness.updateSessionConfig('ses_9', { sessionEnvironmentVariables: {} });
      expect(process.env['SESSION_PUBLIC_NEW']).toBeUndefined();
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('sanitizes runtime resume failures into session_resume_failed', async () => {
    const registry = new SessionRegistry();
    const sink = makeSink();
    const harness = new LiveHarnessFactory({
      registry,
      sink,
      createHarness: () => ({
        createSession: () => Promise.reject(new Error('unused')),
        resumeSession: () =>
          Promise.reject(new Error('raw runtime detail: /home/user/.private/sessions/ses_9')),
        withInteractiveAgent: (_agentId, fn) => fn(),
      }),
    });
    const failure = await harness.resumeSession('ses_9').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FacadeError);
    expect((failure as FacadeError).code).toBe('session_resume_failed');
    expect((failure as FacadeError).message).not.toContain('/home/user');
  });
});

describe('live harness factory: tools', () => {
  it('enables toolset tools and registers external tool definitions', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      tools: [
        { type: 'agent_toolset_20260401', enabledTools: ['Read', 'Bash'] },
        { type: 'agent_toolset_20260401', enabledTools: ['Grep'] },
        {
          type: 'custom',
          name: 'query_billing',
          description: 'Query the billing system',
          inputSchema: { type: 'object', properties: { month: { type: 'string' } } },
        },
      ],
    });
    const session = fake.sessions.get('ses_1');
    // The enabled set is replaced first; registering an external tool enables
    // it on top (registration implies enablement in the runtime).
    expect(session?.activeToolsCalls).toEqual([['Read', 'Bash', 'Grep']]);
    expect(session?.registeredTools).toEqual([
      {
        name: 'query_billing',
        description: 'Query the billing system',
        parameters: { type: 'object', properties: { month: { type: 'string' } } },
      },
    ]);
  });

  it('leaves the runtime defaults untouched when no tools are configured', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir });
    const session = fake.sessions.get('ses_1');
    expect(session?.activeToolsCalls).toEqual([]);
    expect(session?.registeredTools).toEqual([]);
  });

  it('applies an explicit empty tool list as "no tools enabled"', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir, tools: [] });
    expect(fake.sessions.get('ses_1')?.activeToolsCalls).toEqual([[]]);
  });

  it('replaces tools, custom registrations, and per-tool policies', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      tools: [{
        type: 'custom',
        name: 'old_lookup',
        description: 'Old lookup',
        inputSchema: { type: 'object' },
      }],
    });

    await harness.updateSessionConfig('ses_1', {
      tools: [
        {
          type: 'agent_toolset_20260401',
          enabledTools: ['Read'],
          configs: [{ name: 'Read', permissionPolicy: { type: 'always_allow' } }],
        },
        {
          type: 'custom',
          name: 'new_lookup',
          description: 'New lookup',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
    });

    const session = fake.sessions.get('ses_1');
    expect(session?.activeToolsCalls).toEqual([[], ['Read']]);
    expect(session?.unregisteredTools).toEqual(['old_lookup']);
    expect(session?.registeredTools).toEqual([
      { name: 'old_lookup', description: 'Old lookup', parameters: { type: 'object' } },
      { name: 'new_lookup', description: 'New lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    ]);
  });
});

describe('live harness factory: session config for external servers', () => {
	it('replaces Session-owned variables exactly and restores their value after Vault removal', async () => {
		const { harness, workDir } = await setup();
		const names = ['SESSION_PUBLIC_TEST_VALUE', 'SESSION_PUBLIC_TEST_REMOVE', 'SERVICE_KEY'] as const;
		const previous = new Map(names.map((name) => [name, process.env[name]]));
		try {
			await harness.createSession({
				sessionId: 'ses_1',
				workDir,
				sessionEnvironmentVariables: {
					SESSION_PUBLIC_TEST_VALUE: 'before',
					SESSION_PUBLIC_TEST_REMOVE: 'remove',
					SERVICE_KEY: 'public-value',
				},
				vaultEnvironmentVariables: { SERVICE_KEY: 'vault-value' },
			});
			expect(process.env['SERVICE_KEY']).toBe('vault-value');

			await harness.updateSessionConfig('ses_1', {
				sessionEnvironmentVariables: {
					SESSION_PUBLIC_TEST_VALUE: 'after\nwith newline',
					SERVICE_KEY: 'public-value',
				},
			});
			expect(process.env['SESSION_PUBLIC_TEST_VALUE']).toBe('after\nwith newline');
			expect(process.env['SESSION_PUBLIC_TEST_REMOVE']).toBeUndefined();
			expect(process.env['SERVICE_KEY']).toBe('vault-value');

			await harness.updateSessionConfig('ses_1', { vaultEnvironmentVariables: {} });
			expect(process.env['SERVICE_KEY']).toBe('public-value');
		} finally {
			for (const name of names) {
				const value = previous.get(name);
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it('replaces and removes Vault-owned process environment variables without touching ordinary variables', async () => {
		const { harness, workDir } = await setup();
		const priorSessionFlag = process.env['SESSION_FLAG'];
		const priorServiceKey = process.env['SERVICE_KEY'];
		try {
			process.env['SESSION_FLAG'] = 'ordinary';
			await harness.createSession({
				sessionId: 'ses_1',
				workDir,
				vaultEnvironmentVariables: { SERVICE_KEY: 'vault-token' },
			});
			expect(process.env['SERVICE_KEY']).toBe('vault-token');

			await harness.updateSessionConfig('ses_1', { vaultEnvironmentVariables: {} });
			expect(process.env['SERVICE_KEY']).toBeUndefined();
			expect(process.env['SESSION_FLAG']).toBe('ordinary');
		} finally {
			if (priorSessionFlag === undefined) delete process.env['SESSION_FLAG'];
			else process.env['SESSION_FLAG'] = priorSessionFlag;
			if (priorServiceKey === undefined) delete process.env['SERVICE_KEY'];
			else process.env['SERVICE_KEY'] = priorServiceKey;
		}
	});

  it('writes the session server config in the runtime config-loader shape', async () => {
    const { harness, workDir } = await setup();
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      mcpServers: [
        { type: 'http', name: 'billing', url: 'https://billing.example.com/mcp' },
        { type: 'sse', name: 'legacy', url: 'https://legacy.example.com/sse' },
      ],
    });
    const raw = await readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      mcpServers: {
        billing: { transport: 'http', url: 'https://billing.example.com/mcp' },
        legacy: { transport: 'sse', url: 'https://legacy.example.com/sse' },
      },
    });
  });

  it('merges with an existing session server config file', async () => {
    const { harness, workDir } = await setup();
    const configDir = join(workDir, '.kimi-code');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { local: { transport: 'stdio', command: 'serve' } } }),
    );
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      mcpServers: [{ type: 'http', name: 'billing', url: 'https://billing.example.com/mcp' }],
    });
    const raw = await readFile(join(configDir, 'mcp.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      mcpServers: {
        local: { transport: 'stdio', command: 'serve' },
        billing: { transport: 'http', url: 'https://billing.example.com/mcp' },
      },
    });
  });

  it('replaces managed servers and applies MCP enablement filters on update', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      mcpServers: [{ type: 'url', name: 'legacy', url: 'https://legacy.example.com/mcp' }],
    });
    await harness.updateSessionConfig('ses_1', {
      mcpServers: [{ type: 'url', name: 'docs', url: 'https://docs.example.com/mcp' }],
      tools: [{
        type: 'mcp_toolset',
        mcpServerName: 'docs',
        configs: [
          { name: 'search', enabled: true },
          { name: 'delete', enabled: false },
        ],
      }],
    });
    const raw = await readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      mcpServers: {
        docs: {
          transport: 'http',
          url: 'https://docs.example.com/mcp',
          disabledTools: ['delete'],
        },
      },
    });
    expect(fake.sessions.get('ses_1')?.reloadSessionCalls).toBe(1);
  });

  it('references mounted credentials by environment variable, never on disk', async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'oca-facade-creds-'));
    tempDirs.push(credentialsDir);
    const url = 'https://billing.example.com/mcp';
    const fileName = `mcp-${createHash('sha256').update(url).digest('hex')}`;
    await writeFile(join(credentialsDir, fileName), 'test-token-123');

    const { harness, workDir } = await setup({ credentialsDir });
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      mcpServers: [{ type: 'http', name: 'billing', url }],
    });

    const raw = await readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { bearerTokenEnvVar?: string; headers?: unknown }>;
    };
    const server = parsed.mcpServers['billing'];
    expect(server?.bearerTokenEnvVar).toMatch(/^OCA_MCP_BEARER_[0-9A-F]{16}$/);
    expect(server?.headers).toBeUndefined();
    expect(raw).not.toContain('test-token-123');
    const envVar = server?.bearerTokenEnvVar ?? '';
    expect(process.env[envVar]).toBe('test-token-123');
    delete process.env[envVar];
  });

  it('clears a replaced MCP credential from the facade environment', async () => {
    const { fake, harness, workDir } = await setup();
    const url = 'https://billing.example.com/mcp';
    await harness.createSession({ sessionId: 'ses_1', workDir });
    await harness.updateSessionConfig('ses_1', {
      mcpServers: [{ type: 'http', name: 'billing', url }],
      mcpCredentials: { [url]: 'test-live-token' },
    });

    const first = JSON.parse(await readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { bearerTokenEnvVar?: string }>;
    };
    const envVar = first.mcpServers['billing']?.bearerTokenEnvVar;
    expect(envVar).toMatch(/^OCA_MCP_BEARER_[0-9A-F]{16}$/);
    expect(process.env[envVar ?? '']).toBe('test-live-token');

    await harness.updateSessionConfig('ses_1', { mcpServers: [], mcpCredentials: {} });
    expect(process.env[envVar ?? '']).toBeUndefined();
    const replaced = JSON.parse(await readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(replaced.mcpServers).toEqual({});
    expect(fake.sessions.get('ses_1')?.reloadSessionCalls).toBe(2);
  });

  it('restores the prior MCP file and bearer variables when a turn blocks reload', async () => {
    const { fake, harness, workDir } = await setup();
    const oldURL = 'https://billing.example.com/mcp';
    const nextURL = 'https://docs.example.com/mcp';
    await harness.createSession({ sessionId: 'ses_1', workDir });
    await harness.updateSessionConfig('ses_1', {
      mcpServers: [{ type: 'http', name: 'billing', url: oldURL }],
      mcpCredentials: { [oldURL]: 'old-token' },
    });
    const configFile = join(workDir, '.kimi-code', 'mcp.json');
    const before = await readFile(configFile, 'utf-8');
    const oldEnvVar = JSON.parse(before).mcpServers.billing.bearerTokenEnvVar as string;
    const nextEnvVar = `OCA_MCP_BEARER_${createHash('sha256').update(nextURL).digest('hex').slice(0, 16).toUpperCase()}`;
    fake.sessions.get('ses_1')!.reloadSessionError = new KimiError(ErrorCodes.TURN_AGENT_BUSY, 'turn is active');

    await expect(harness.updateSessionConfig('ses_1', {
      mcpServers: [{ type: 'http', name: 'docs', url: nextURL }],
      mcpCredentials: { [nextURL]: 'next-token' },
    })).rejects.toMatchObject({ code: 'session_state_conflict' });

    expect(await readFile(configFile, 'utf-8')).toBe(before);
    expect(process.env[oldEnvVar]).toBe('old-token');
    expect(process.env[nextEnvVar]).toBeUndefined();
    expect(fake.sessions.get('ses_1')?.reloadSessionCalls).toBe(2);
    delete process.env[oldEnvVar];
  });

  it('hydrates the mounted MCP bearer before resuming the journal session', async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'oca-facade-creds-'));
    tempDirs.push(credentialsDir);
    const url = 'https://billing.example.com/mcp';
    const fileName = `mcp-${createHash('sha256').update(url).digest('hex')}`;
    await writeFile(join(credentialsDir, fileName), 'resume-token');
    const { fake, harness, workDir } = await setup({ credentialsDir });
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      mcpServers: [{ type: 'http', name: 'billing', url }],
    });
    const config = JSON.parse(await readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8')) as {
      mcpServers: { billing: { bearerTokenEnvVar: string } };
    };
    const envVar = config.mcpServers.billing.bearerTokenEnvVar;
    delete process.env[envVar];
    let tokenAtRuntimeResume: string | undefined;
    const resumed = new LiveHarnessFactory({
      registry: new SessionRegistry(),
      sink: makeSink(),
      credentialsDir,
      createHarness: () => ({
        createSession: (options) => fake.createSession(options),
        resumeSession: async (input) => {
          tokenAtRuntimeResume = process.env[envVar];
          return fake.resumeSession(input);
        },
        withInteractiveAgent: (agentId, fn) => fake.withInteractiveAgent(agentId, fn),
      }),
      resumeWorkDir: workDir,
    });
    try {
      await resumed.resumeSession('ses_1');
      expect(tokenAtRuntimeResume).toBe('resume-token');
      expect(await readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8')).not.toContain('resume-token');
    } finally {
      delete process.env[envVar];
    }
  });

  it('writes no config file when no servers are configured', async () => {
    const { harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir });
    await expect(readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('live harness factory: first-prompt context blocks', () => {
	it('injects system and resource blocks while kimi-code discovers materialized Skills', async () => {
    const { fake, harness, workDir } = await setup();
    const archive = await writeSkillArchive(workDir, { name: 'reviewer', version: '3' });
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      system: 'You are a documentation assistant.',
      resources: [
        { id: 'res_1', type: 'reference', mountPath: '/workspace/spec.md' },
      ],
      skills: [{
        id: archive.descriptor.id,
        name: archive.descriptor.name,
        version: archive.descriptor.version,
        origin: archive.descriptor.origin,
        contentSize: archive.descriptor.content_size,
        contentSHA256: archive.descriptor.content_sha256,
      }],
      skillArchives: [{ path: archive.path }],
    });
    await expect(readFile(join(workDir, '.agents/skills/reviewer/SKILL.md'), 'utf8')).resolves.toContain('name: reviewer');
    await harness.prompt('ses_1', 'Summarize the spec.');
    const session = fake.sessions.get('ses_1');
    expect(session?.prompts).toHaveLength(1);
    expect(session?.prompts[0]).toEqual([
      { type: 'text', text: 'You are a documentation assistant.' },
      {
        type: 'text',
        text: '[resource: /workspace/spec.md]\n{"id":"res_1","type":"reference","mountPath":"/workspace/spec.md"}\n[/resource]',
      },
      { type: 'text', text: 'Summarize the spec.' },
    ]);
  });

  it('sends only the user content from the second prompt onwards', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      system: 'You are a documentation assistant.',
    });
    await harness.prompt('ses_1', 'first');
    await harness.prompt('ses_1', 'second');
    const prompts = fake.sessions.get('ses_1')?.prompts;
    expect(prompts?.[1]).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('sends plain content when no context is configured', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir });
    await harness.prompt('ses_1', 'hello');
    expect(fake.sessions.get('ses_1')?.prompts[0]).toEqual([{ type: 'text', text: 'hello' }]);
  });

	it('restores Memory instructions once and keeps the Memory resource idempotent', async () => {
		const { fake, harness, workDir } = await setup();
		const awareness = join(workDir, 'awareness');
		const priorAwareness = process.env['OCA_AWARENESS_ROOT'];
		process.env['OCA_AWARENESS_ROOT'] = awareness;
		try {
			await harness.resumeSession('ses_1');
			const resources = [{
				id: 'res_memory_1',
				type: 'memory_store',
				memoryStoreId: 'memstore_1',
				instructions: 'Use the project notes.',
				memoryEntries: [],
			}] as const;
			await harness.materializeSessionResources('ses_1', resources);
			await harness.materializeSessionResources('ses_1', resources);

			await expect(harness.snapshotSessionMemory('ses_1')).resolves.toEqual([{
				resourceId: 'res_memory_1', memoryStoreId: 'memstore_1', entries: [],
			}]);
			await harness.prompt('ses_1', 'Continue.');
			expect(fake.sessions.get('ses_1')?.prompts[0]).toEqual([
				{ type: 'text', text: 'Use the project notes.' },
				{ type: 'text', text: 'Continue.' },
			]);
		} finally {
			if (priorAwareness === undefined) delete process.env['OCA_AWARENESS_ROOT'];
			else process.env['OCA_AWARENESS_ROOT'] = priorAwareness;
		}
	});

	it('keeps acknowledged Memory hashes after a later File resource attach', async () => {
		const { harness, workDir } = await setup();
		const awareness = join(workDir, 'awareness');
		const priorAwareness = process.env['OCA_AWARENESS_ROOT'];
		const downloadURL = 'https://storage.example.test/file_1';
		const realFetch = globalThis.fetch;
		process.env['OCA_AWARENESS_ROOT'] = awareness;
		globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
			const requestURL = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
			if (requestURL === downloadURL) return Promise.resolve(new Response('file'));
			return realFetch(input);
		}) as typeof fetch;
		try {
			await harness.createSession({
				sessionId: 'ses_1', workDir, resources: [{
					id: 'res_memory_1', type: 'memory_store', memoryStoreId: 'memstore_1',
					memoryEntries: [{ id: 'mem_1', path: 'notes.md', content: 'before', contentSha256: 'before-hash' }],
				}],
			});
			await writeFile(join(awareness, 'notes.md'), 'after', 'utf8');
			await harness.acknowledgeSessionMemory('ses_1', [{
				resourceId: 'res_memory_1', memoryStoreId: 'memstore_1',
				entries: [{ id: 'mem_1', path: 'notes.md', content: 'after', contentSha256: 'after-hash' }],
			}]);
			await harness.materializeSessionResources('ses_1', [{
				id: 'res_file_1', type: 'file', fileId: 'file_1', mountPath: 'inputs/file.txt', pvcPath: 'inputs/file.txt',
				downloadUrl: downloadURL, size: 4,
			}]);
			await expect(harness.snapshotSessionMemory('ses_1')).resolves.toEqual([{
				resourceId: 'res_memory_1', memoryStoreId: 'memstore_1',
				entries: [{ id: 'mem_1', path: 'notes.md', contentSha256: 'after-hash', deleted: false, content: 'after' }],
			}]);
		} finally {
			globalThis.fetch = realFetch;
			if (priorAwareness === undefined) delete process.env['OCA_AWARENESS_ROOT'];
			else process.env['OCA_AWARENESS_ROOT'] = priorAwareness;
		}
	});

  it('rejects prompts for unknown sessions', async () => {
    const { harness } = await setup();
    await expect(harness.prompt('nope', 'hi')).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });
});
