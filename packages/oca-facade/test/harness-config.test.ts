import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { FacadeError } from '../src/errors';
import {
  LiveHarnessFactory,
  permissionModeForPolicy,
  type FacadeCreateConfig,
  type FacadeEvent,
  type HarnessEventSink,
  type HarnessFactory,
} from '../src/harness';
import { SessionRegistry, type StopReason } from '../src/session-registry';

import { createFakeHarness, type FakeHarness } from './fake-harness';

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
  it('maps every facade policy to a runtime permission mode', () => {
    expect(permissionModeForPolicy('always_allow')).toBe('yolo');
    expect(permissionModeForPolicy('always_ask')).toBe('manual');
    expect(permissionModeForPolicy('always_deny')).toBe('manual');
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
      permissionPolicy: 'always_ask',
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
      permission: 'manual',
      planMode: true,
      metadata: { tenant: 't-1' },
      additionalDirs: ['/extra'],
    });
  });

  it('omits unset optional fields from create options', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir });
    expect(fake.created[0]).toEqual({ id: 'ses_1', workDir });
  });

  it.each([
    ['always_allow', 'yolo'],
    ['always_ask', 'manual'],
    ['always_deny', 'manual'],
  ] as const)('maps permission_policy %s to %s at create', async (policy, mode) => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir, permissionPolicy: policy });
    expect(fake.created[0]?.permission).toBe(mode);
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
          name: 'query_billing',
          description: 'Query the billing system',
          parameters: { type: 'object', properties: { month: { type: 'string' } } },
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
});

describe('live harness factory: session config for external servers', () => {
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

  it('references mounted credentials by environment variable, never on disk', async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'oca-facade-creds-'));
    tempDirs.push(credentialsDir);
    const url = 'https://billing.example.com/mcp';
    const fileName = Buffer.from(url).toString('base64url');
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

  it('writes no config file when no servers are configured', async () => {
    const { harness, workDir } = await setup();
    await harness.createSession({ sessionId: 'ses_1', workDir });
    await expect(readFile(join(workDir, '.kimi-code', 'mcp.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('live harness factory: first-prompt context blocks', () => {
  it('injects system, resource, memory, and skill blocks ahead of the first prompt', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      system: 'You are a documentation assistant.',
      resources: [
        { id: 'res_1', type: 'file', path: '/workspace/spec.md', mountPath: '/workspace/spec.md' },
      ],
      memoryStoreEntries: [
        { path: 'preferences/style', content: 'Use terse prose.' },
        { path: 'preferences/empty', content: '   ' },
      ],
      skills: [{ id: 'skill_1', name: 'reviewer', version: 3 }],
    });
    await harness.prompt('ses_1', 'Summarize the spec.');
    const session = fake.sessions.get('ses_1');
    expect(session?.prompts).toHaveLength(1);
    expect(session?.prompts[0]).toEqual([
      { type: 'text', text: 'You are a documentation assistant.' },
      {
        type: 'text',
        text: '[resource: /workspace/spec.md]\n{"id":"res_1","type":"file","path":"/workspace/spec.md","mountPath":"/workspace/spec.md"}\n[/resource]',
      },
      { type: 'text', text: '[memory: preferences/style]\nUse terse prose.\n[/memory]' },
      { type: 'text', text: '[skill: reviewer]\n{"id":"skill_1","name":"reviewer","version":3}\n[/skill]' },
      { type: 'text', text: 'Summarize the spec.' },
    ]);
  });

  it('sends only the user content from the second prompt onwards', async () => {
    const { fake, harness, workDir } = await setup();
    await harness.createSession({
      sessionId: 'ses_1',
      workDir,
      system: 'You are a documentation assistant.',
      memoryStoreEntries: [{ path: 'a', content: 'b' }],
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

  it('rejects prompts for unknown sessions', async () => {
    const { harness } = await setup();
    await expect(harness.prompt('nope', 'hi')).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });
});
