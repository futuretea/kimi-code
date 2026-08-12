import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';

import type { HarnessFactory, HarnessSessionFactory } from '../src/harness';

import {
  createFakeHarness,
  RPC_SESSION_NOT_FOUND,
  rpcError,
  runtimeEvent,
  type FakeHarness,
} from './fake-harness';
import {
  bootTestServer,
  collectNdjson,
  expectErrorEnvelope,
  nextNdjsonFrame,
  asFrame,
  postJson,
  postStream,
  type TestServerHandle,
} from './http-helper';

/** Harness factory whose create call rejects for `failingId` with a raw error. */
function failingCreateHarness(
  failingId: string,
  rawMessage: string,
): { factory: HarnessFactory; fake: FakeHarness } {
  const { fake, createHarness } = createFakeHarness();
  const factory: HarnessFactory = (options) => {
    const inner: HarnessSessionFactory = createHarness(options);
    return {
      createSession: (createOptions) =>
        createOptions.id === failingId
          ? Promise.reject(new Error(rawMessage))
          : inner.createSession(createOptions),
      resumeSession: (input) => inner.resumeSession(input),
      withInteractiveAgent: (agentId, fn) => inner.withInteractiveAgent(agentId, fn),
    };
  };
  return { factory, fake };
}

describe('session routes', () => {
  let handle: TestServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  function base(): string {
    if (handle === undefined) throw new Error('test server not booted');
    return handle.baseUrl;
  }

  function fake(): FakeHarness {
    if (handle === undefined) throw new Error('test server not booted');
    return handle.fake;
  }

  function workDir(): string {
    if (handle === undefined) throw new Error('test server not booted');
    return handle.homeDir;
  }

  async function createSession(sessionId = 'ses_1'): Promise<void> {
    const res = await postJson(base(), '/sessions', { session_id: sessionId, work_dir: workDir() });
    expect(res.status).toBe(201);
  }

  describe('POST /sessions', () => {
    it('creates a session (201) with the contract response shape', async () => {
      handle = await bootTestServer();
      const res = await postJson(base(), '/sessions', {
        session_id: 'ses_1',
        work_dir: workDir(),
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ session_id: 'ses_1', status: 'active' });
    });

    it('rejects a missing session_id or work_dir (400 invalid_request)', async () => {
      handle = await bootTestServer();
      const missingWorkDir = await postJson(base(), '/sessions', { session_id: 'ses_1' });
      expect(missingWorkDir.status).toBe(400);
      expectErrorEnvelope(missingWorkDir.body, 'invalid_request');
      const missingId = await postJson(base(), '/sessions', { work_dir: workDir() });
      expect(missingId.status).toBe(400);
      expectErrorEnvelope(missingId.body, 'invalid_request');
      const badPolicy = await postJson(base(), '/sessions', {
        session_id: 'ses_1',
        work_dir: workDir(),
        permission_policy: 'sometimes',
      });
      expect(badPolicy.status).toBe(400);
      expectErrorEnvelope(badPolicy.body, 'invalid_request');
    });

    it('binds the create configuration and applies it to the runtime session', async () => {
      handle = await bootTestServer();
      const downloadURL = 'https://storage.example.test/file_1';
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input) === downloadURL) {
          return Promise.resolve(new Response('attached\n', {
            status: 200,
            headers: { 'content-length': '9' },
          }));
        }
        return realFetch(input, init);
      }) as typeof fetch;
      fake().setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
      ]);
      let res: Awaited<ReturnType<typeof postJson>>;
      try {
        res = await postJson(base(), '/sessions', {
          session_id: 'ses_1',
          work_dir: workDir(),
          system: 'You are a coding agent.',
          model: 'model-x',
          thinking: 'high',
          context_window: 262144,
          plan_mode: true,
          metadata: { tenant: 't-1' },
          tools: [
            {
              type: 'agent_toolset_20260401',
              enabled_tools: ['Read', 'Glob'],
              configs: [{ name: 'Read', permission_policy: { type: 'always_allow' } }],
            },
            { type: 'custom', name: 'query_billing', description: 'Query billing', input_schema: { type: 'object' } },
          ],
          mcp_servers: [{ type: 'url', name: 'docs', url: 'https://example.invalid/mcp' }],
			resources: [{ id: 'res_1', type: 'file', file_id: 'file_1', mount_path: 'attached.txt', pvc_path: 'attached.txt', download_url: downloadURL, size: 9 }],
          skills: [{
            id: 'skill_1',
            name: 'review',
            version: 2,
            files: [{
              path: 'SKILL.md',
              content_base64: Buffer.from('---\nname: review\ndescription: Review code\n---\n').toString('base64'),
            }],
          }],
        });
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(res.status).toBe(201);
      await expect(readFile(join(workDir(), 'attached.txt'), 'utf-8')).resolves.toBe('attached\n');

      expect(fake().created[0]).toMatchObject({
        id: 'ses_1',
        workDir: workDir(),
        model: 'model-x',
        thinking: 'high',
        contextWindow: 262144,
        permission: 'manual',
        planMode: true,
        metadata: { tenant: 't-1' },
      });
      const session = fake().sessions.get('ses_1');
      expect(session?.activeToolsCalls).toEqual([['Read', 'Glob']]);
      expect(session?.registeredTools).toEqual([
        { name: 'query_billing', description: 'Query billing', parameters: { type: 'object' } },
      ]);

      // First prompt carries the create-time context blocks, user content last.
      const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'hello' });
      expect(stream.response.status).toBe(200);
      await collectNdjson(stream.reader);
      const firstPrompt = session?.prompts[0];
      expect(Array.isArray(firstPrompt)).toBe(true);
      const texts = (firstPrompt as Array<{ type: string; text: string }>).map((part) => part.text);
      expect(texts[0]).toBe('You are a coding agent.');
      expect(texts.some((text) => text.includes('res_1'))).toBe(true);
      expect(texts.some((text) => text.includes(downloadURL))).toBe(false);
      expect(texts.some((text) => text.includes('skill_1'))).toBe(false);
      await expect(readFile(join(workDir(), '.agents/skills/review/SKILL.md'), 'utf8')).resolves.toContain('name: review');
      expect(texts.at(-1)).toBe('hello');
    });

    it('passes an immutable agent profile registry to the runtime session', async () => {
      handle = await bootTestServer();

      const res = await postJson(base(), '/sessions', {
        session_id: 'ses_profiles',
        work_dir: workDir(),
        agent_profiles: {
          main_profile: 'coordinator',
          profiles: [
            {
              name: 'coordinator',
              system_prompt_template: 'Coordinate the task.',
              tools: ['Agent', 'Read'],
              subagents: { reviewer: { description: 'Review focused changes.' } },
            },
            {
              name: 'reviewer',
              description: 'Review focused changes.',
              system_prompt_template: 'Review the task.',
              tools: ['Read'],
              model_alias: 'reviewer-model',
              thinking_effort: 'low',
              context_window: 64000,
            },
          ],
        },
      });

      expect(res.status).toBe(201);
      expect(fake().created[0]?.agentProfiles).toEqual({
        mainProfile: 'coordinator',
        maxAgents: 25,
        profiles: [
          {
            name: 'coordinator',
            systemPromptTemplate: 'Coordinate the task.',
            tools: ['Agent', 'Read'],
            subagents: { reviewer: { description: 'Review focused changes.' } },
          },
          {
            name: 'reviewer',
            description: 'Review focused changes.',
            systemPromptTemplate: 'Review the task.',
            tools: ['Read'],
            modelAlias: 'reviewer-model',
            thinkingEffort: 'low',
            contextWindow: 64000,
          },
        ],
      });
    });

    it('rejects an invalid agent profile graph before allocating the Session ID', async () => {
      handle = await bootTestServer();
      const invalidRegistries = [
        {
          main_profile: 'missing',
          profiles: [{ name: 'coordinator' }],
        },
        {
          main_profile: 'coordinator',
          profiles: [{ name: 'coordinator' }, { name: 'coordinator' }],
        },
        {
          main_profile: 'coordinator',
          profiles: [{ name: 'coordinator', subagents: { missing: {} } }],
        },
      ];

      for (const agentProfiles of invalidRegistries) {
        const res = await postJson(base(), '/sessions', {
          session_id: 'ses_invalid_profiles',
          work_dir: workDir(),
          agent_profiles: agentProfiles,
        });
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, 'invalid_request');
      }

      const usable = await postJson(base(), '/sessions', {
        session_id: 'ses_invalid_profiles',
        work_dir: workDir(),
      });
      expect(usable.status).toBe(201);
      expect(fake().created).toHaveLength(1);
    });

    it('rejects unsupported profile source and template fields', async () => {
      handle = await bootTestServer();
      const unsupportedFields = [
        { extends: 'base' },
        { system_prompt_path: './mutable.md' },
        { prompt_vars: { tenant: 'untrusted' } },
      ];

      for (const profile of unsupportedFields) {
        const res = await postJson(base(), '/sessions', {
          session_id: `ses_unsupported_${Object.keys(profile)[0]}`,
          work_dir: workDir(),
          agent_profiles: {
            main_profile: 'coordinator',
            profiles: [{ name: 'coordinator', ...profile }],
          },
        });
        expect(res.status).toBe(400);
        expectErrorEnvelope(res.body, 'invalid_request');
      }
      expect(fake().created).toHaveLength(0);
    });

    it('materializes a File attached after session creation before the next prompt', async () => {
      handle = await bootTestServer();
      await createSession();
      const downloadURL = 'https://storage.example.test/file_2';
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input) === downloadURL) {
          return Promise.resolve(new Response('dynamic\n', {
            status: 200,
            headers: { 'content-length': '8' },
          }));
        }
        return realFetch(input, init);
      }) as typeof fetch;
      try {
        const res = await postJson(base(), '/sessions/ses_1/resources', {
          resources: [{
            id: 'res_2',
            type: 'file',
            file_id: 'file_2',
            mount_path: 'dynamic.txt',
            pvc_path: 'dynamic.txt',
            download_url: downloadURL,
            size: 8,
          }],
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ accepted: true });
      } finally {
        globalThis.fetch = realFetch;
      }
      await expect(readFile(join(workDir(), 'dynamic.txt'), 'utf-8')).resolves.toBe('dynamic\n');

      fake().setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
      ]);
      const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'inspect the new file' });
      expect(stream.response.status).toBe(200);
      await collectNdjson(stream.reader);
      const prompt = fake().sessions.get('ses_1')?.prompts[0] as Array<{ type: string; text: string }>;
      const texts = prompt.map((part) => part.text);
      expect(texts.some((text) => text.includes('res_2'))).toBe(true);
      expect(texts.some((text) => text.includes(downloadURL))).toBe(false);
      expect(texts.at(-1)).toBe('inspect the new file');
    });

    it.each(['closed', 'failed'] as const)(
      'rejects re-creating the same id on a %s session (409 session_state_conflict)',
      async (state) => {
        if (state === 'failed') {
          const { factory } = failingCreateHarness('ses_1', 'spawn failed: /internal/core binary');
          handle = await bootTestServer({ harnessFactory: factory });
          const boom = await postJson(base(), '/sessions', {
            session_id: 'ses_1',
            work_dir: workDir(),
          });
          expect(boom.status).toBe(500);
        } else {
          handle = await bootTestServer();
          await createSession();
          const cancelled = await postJson(base(), '/sessions/ses_1/cancel', {});
          expect(cancelled.status).toBe(202);
        }
        const res = await postJson(base(), '/sessions', { session_id: 'ses_1', work_dir: workDir() });
        expect(res.status).toBe(409);
        expectErrorEnvelope(res.body, 'session_state_conflict');
      },
    );
  });

  describe('POST /sessions/{id}/agents/{agent_id}/archive', () => {
    it('removes the internal runtime child without exposing it through the public API', async () => {
      handle = await bootTestServer();
      await createSession();

      const res = await postJson(base(), '/sessions/ses_1/agents/agent-0/archive', {});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: true });
      expect(fake().sessions.get('ses_1')?.removedAgentIDs).toEqual(['agent-0']);
    });

    it('reports an active runtime child as a neutral state conflict', async () => {
      handle = await bootTestServer();
      await createSession();
      const session = fake().sessions.get('ses_1');
      if (session === undefined) throw new Error('expected fake runtime session');
      session.removeAgentError = new KimiError(ErrorCodes.SESSION_STATE_INVALID, 'child turn is still active');

      const res = await postJson(base(), '/sessions/ses_1/agents/agent-0/archive', {});

      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
      expect(session.removedAgentIDs).toEqual([]);
    });
  });

  describe('POST /sessions/{id}/agents/{agent_id}/interrupt', () => {
    it('cancels only the requested runtime agent context', async () => {
      handle = await bootTestServer();
      await createSession();

      const res = await postJson(base(), '/sessions/ses_1/agents/agent-0/interrupt', {});

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: true });
      expect(fake().interactiveAgentIDs).toEqual(['agent-0']);
      expect(fake().sessions.get('ses_1')?.cancelCalls).toBe(1);
    });
  });

  describe('Memory Store synchronization', () => {
    it('exposes changed files and accepts the persisted baseline', async () => {
      handle = await bootTestServer();
      const awareness = join(workDir(), 'awareness');
      const priorAwareness = process.env['OCA_AWARENESS_ROOT'];
      process.env['OCA_AWARENESS_ROOT'] = awareness;
      try {
        const create = await postJson(base(), '/sessions', {
          session_id: 'ses_1',
          work_dir: workDir(),
          resources: [{
            id: 'res_memory_1',
            type: 'memory_store',
            memory_store_id: 'memstore_1',
            memory_entries: [{ id: 'mem_1', path: 'notes.md', content: 'before', content_sha256: 'hash-before' }],
          }],
        });
        expect(create.status).toBe(201);
        await writeFile(join(awareness, 'notes.md'), 'after', 'utf8');

        const snapshot = await fetch(`${base()}/sessions/ses_1/memory-snapshot`);
        expect(snapshot.status).toBe(200);
        expect(await snapshot.json()).toEqual({
          resources: [{
            resource_id: 'res_memory_1', memory_store_id: 'memstore_1',
            entries: [{ id: 'mem_1', path: 'notes.md', content_sha256: 'hash-before', deleted: false, content: 'after' }],
          }],
        });

        const acknowledge = await postJson(base(), '/sessions/ses_1/memory-acknowledgement', {
          resources: [{
            resource_id: 'res_memory_1', memory_store_id: 'memstore_1',
            entries: [{ id: 'mem_1', path: 'notes.md', content: 'after', content_sha256: 'hash-after' }],
          }],
        });
        expect(acknowledge.status).toBe(200);

        const synchronized = await fetch(`${base()}/sessions/ses_1/memory-snapshot`);
        expect(await synchronized.json()).toMatchObject({
          resources: [{ entries: [{ content_sha256: 'hash-after', content: 'after' }] }],
        });

			const invalid = await postJson(base(), '/sessions/ses_1/memory-acknowledgement', { resources: [] });
			expect(invalid.status).toBe(400);
			expectErrorEnvelope(invalid.body, 'invalid_request');
      } finally {
        if (priorAwareness === undefined) delete process.env['OCA_AWARENESS_ROOT'];
        else process.env['OCA_AWARENESS_ROOT'] = priorAwareness;
      }
    });
  });

  describe('POST /sessions/{id}/resume', () => {
    it('resumes an active session idempotently (200, no pending calls)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/resume', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ session_id: 'ses_1', status: 'active', pending_calls: [] });
    });

    it('reports an in-flight approval in pending_calls with the wire field names', async () => {
      handle = await bootTestServer();
      fake().setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        {
          kind: 'approval',
          request: {
            toolCallId: 'call_7f3',
            toolName: 'run_tests',
            action: 'execute',
            display: { kind: 'command', command: 'pnpm test' },
          },
        },
        { kind: 'event', event: runtimeEvent({ type: 'turn.ended', reason: 'completed' }) },
      ]);
      await createSession();
      const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'go' });
      expect(stream.response.status).toBe(200);
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('session.status_running');
      // The turn now blocks on the approval, so the call is registered pending.
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('approval_request');

      const res = await postJson(base(), '/sessions/ses_1/resume', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        session_id: 'ses_1',
        status: 'active',
        pending_calls: [{ tool_call_id: 'call_7f3', kind: 'approval', state: 'pending' }],
      });

      // Settle the pending call so the turn drains cleanly.
      const approved = await postJson(base(), '/sessions/ses_1/approvals', {
        tool_call_id: 'call_7f3',
        decision: 'approved',
      });
      expect(approved.status).toBe(202);
      await collectNdjson(stream.reader);
    });

    it('rejects an unknown session id (404 session_not_found)', async () => {
      handle = await bootTestServer();
      // The runtime journal is the existence authority: an unknown id misses
      // there (RPC session.not_found at the harness boundary), which the hook
      // maps to the 404 contract code.
      fake().resumeErrors.set('nope', rpcError(RPC_SESSION_NOT_FOUND, 'session nope not found'));
      const res = await postJson(base(), '/sessions/nope/resume', {});
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'session_not_found');
    });

    it('rejects resuming a closed session (409 session_state_conflict)', async () => {
      handle = await bootTestServer();
      await createSession();
      await postJson(base(), '/sessions/ses_1/cancel', {});
      const res = await postJson(base(), '/sessions/ses_1/resume', {});
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
    });

    it('recovers a failed session from the journal (200 active)', async () => {
      const { factory, fake: localFake } = failingCreateHarness(
        'ses_1',
        'spawn failed: /internal/core binary',
      );
      handle = await bootTestServer({ harnessFactory: factory });
      const boom = await postJson(base(), '/sessions', { session_id: 'ses_1', work_dir: workDir() });
      expect(boom.status).toBe(500);

      const res = await postJson(base(), '/sessions/ses_1/resume', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ session_id: 'ses_1', status: 'active', pending_calls: [] });
      expect(localFake.resumed).toEqual([{ id: 'ses_1' }]);
    });
  });

  describe('POST /sessions/{id}/config', () => {
    it('replaces the live tool configuration', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/config', {
        tools: [{
          type: 'agent_toolset_20260401',
          enabled_tools: ['Read'],
          configs: [{ name: 'Read', permission_policy: { type: 'always_allow' } }],
        }],
        mcp_servers: [],
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accepted: true });
      expect(fake().sessions.get('ses_1')?.activeToolsCalls).toEqual([['Read']]);
    });

    it('uses an ephemeral credential snapshot for a live MCP replacement', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/config', {
        tools: [],
        mcp_servers: [{ type: 'url', name: 'docs', url: 'https://mcp.example.test' }],
        mcp_credentials: { 'https://mcp.example.test': 'test-live-token' },
      });
      expect(res.status).toBe(200);

      const config = JSON.parse(await readFile(join(workDir(), '.kimi-code/mcp.json'), 'utf-8')) as {
        mcpServers: { docs: { bearerTokenEnvVar?: string } };
      };
      const envVar = config.mcpServers.docs.bearerTokenEnvVar;
      expect(envVar).toMatch(/^OCA_MCP_BEARER_/);
      expect(process.env[envVar ?? '']).toBe('test-live-token');
      expect(JSON.stringify(config)).not.toContain('test-live-token');
      if (envVar !== undefined) delete process.env[envVar];
    });

    it('accepts a Vault environment-only replacement without null configuration fields', async () => {
      handle = await bootTestServer();
      await createSession();
      const priorServiceKey = process.env['SERVICE_KEY'];
      try {
        const res = await postJson(base(), '/sessions/ses_1/config', {
          vault_environment_variables: { SERVICE_KEY: 'vault-live-value' },
        });
        expect(res.status).toBe(200);
        expect(process.env['SERVICE_KEY']).toBe('vault-live-value');
      } finally {
        if (priorServiceKey === undefined) delete process.env['SERVICE_KEY'];
        else process.env['SERVICE_KEY'] = priorServiceKey;
      }
    });

    it('restores the MCP replacement and reports a retryable conflict while a turn is active', async () => {
      handle = await bootTestServer();
      await createSession();
      fake().sessions.get('ses_1')!.reloadSessionError = new KimiError(ErrorCodes.TURN_AGENT_BUSY, 'turn is active');

      const res = await postJson(base(), '/sessions/ses_1/config', {
        mcp_servers: [{ type: 'url', name: 'docs', url: 'https://mcp.example.test' }],
      });

      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
      expect(fake().sessions.get('ses_1')?.reloadSessionCalls).toBe(1);
      await expect(readFile(join(workDir(), '.kimi-code/mcp.json'), 'utf-8')).rejects.toThrow();
    });

    it('rejects invalid tool union members', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/config', {
        tools: [{ type: 'custom', name: 'lookup', description: 'Lookup', input_schema: { type: 'object' }, enabled_tools: ['Read'] }],
      });
      expect(res.status).toBe(400);
      expectErrorEnvelope(res.body, 'invalid_request');
    });
  });

  describe('POST /sessions/{id}/cancel', () => {
    it('cancels an active session (202) and is idempotent on closed (202)', async () => {
      handle = await bootTestServer();
      await createSession();
      const first = await postJson(base(), '/sessions/ses_1/cancel', {});
      expect(first.status).toBe(202);
      expect(first.body).toEqual({ accepted: true });
      const second = await postJson(base(), '/sessions/ses_1/cancel', {});
      expect(second.status).toBe(202);
      expect(second.body).toEqual({ accepted: true });
    });

    it('cancels a failed session (202, terminal cleanup)', async () => {
      const { factory } = failingCreateHarness('ses_1', 'spawn failed: /internal/core binary');
      handle = await bootTestServer({ harnessFactory: factory });
      await postJson(base(), '/sessions', { session_id: 'ses_1', work_dir: workDir() });
      const res = await postJson(base(), '/sessions/ses_1/cancel', {});
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: true });
    });

    it('rejects an unknown session id (404 session_not_found)', async () => {
      handle = await bootTestServer();
      const res = await postJson(base(), '/sessions/nope/cancel', {});
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'session_not_found');
    });
  });

  describe('POST /sessions/{id}/interrupt', () => {
    it('interrupts an in-flight turn (202); cancel ends the open stream', async () => {
      handle = await bootTestServer();
      fake().setScript('ses_1', [
        { kind: 'event', event: runtimeEvent({ type: 'turn.started' }) },
        { kind: 'event', event: runtimeEvent({ type: 'assistant.delta', delta: 'working' }) },
        // No turn.ended: the turn stays in flight until interrupted/cancelled.
      ]);
      await createSession();
      const stream = await postStream(base(), '/sessions/ses_1/prompt', { content: 'go' });
      expect(stream.response.status).toBe(200);
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('session.status_running');
      expect(asFrame(await nextNdjsonFrame(stream.reader)).type).toBe('agent.message');

      const interrupted = await postJson(base(), '/sessions/ses_1/interrupt', {});
      expect(interrupted.status).toBe(202);
      expect(interrupted.body).toEqual({ accepted: true });
      expect(fake().sessions.get('ses_1')?.cancelCalls).toBe(1);

      const cancelled = await postJson(base(), '/sessions/ses_1/cancel', {});
      expect(cancelled.status).toBe(202);
      const rest = await collectNdjson(stream.reader);
      expect(rest).toEqual([{ type: 'prompt_done', stop_reason: 'cancelled' }]);
    });

    it('rejects interrupt without an in-flight turn (409 session_state_conflict)', async () => {
      handle = await bootTestServer();
      await createSession();
      const res = await postJson(base(), '/sessions/ses_1/interrupt', {});
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
    });

    it('rejects interrupt on a closed session (409 session_state_conflict)', async () => {
      handle = await bootTestServer();
      await createSession();
      await postJson(base(), '/sessions/ses_1/cancel', {});
      const res = await postJson(base(), '/sessions/ses_1/interrupt', {});
      expect(res.status).toBe(409);
      expectErrorEnvelope(res.body, 'session_state_conflict');
    });

    it('rejects an unknown session id (404 session_not_found)', async () => {
      handle = await bootTestServer();
      const res = await postJson(base(), '/sessions/nope/interrupt', {});
      expect(res.status).toBe(404);
      expectErrorEnvelope(res.body, 'session_not_found');
    });
  });
});
