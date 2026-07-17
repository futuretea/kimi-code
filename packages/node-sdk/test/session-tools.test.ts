import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoreAPI, RPCMethods, ToolCallRequest } from '@moonshot-ai/agent-core';

import { createKimiHarness, Session, type Event, type KimiError } from '#/index';
import { ClientAPI, SDKRpcClientBase } from '#/rpc';
import { makeTempDir, removeTempDirs, waitForAgentWireEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session tool registration', () => {
  it('forwards registerTool to the core with session and agent scope', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_register', workDir: '/tmp', rpc });
    const parameters = {
      type: 'object',
      properties: { city: { type: 'string' } },
    };

    await session.registerTool({
      name: 'weather',
      description: 'Get the weather for a city',
      parameters,
    });

    expect(rpc.core.registerTool).toHaveBeenCalledWith({
      sessionId: session.id,
      agentId: 'main',
      name: 'weather',
      description: 'Get the weather for a city',
      parameters,
    });
  });

  it('forwards unregisterTool to the core with session and agent scope', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_unregister', workDir: '/tmp', rpc });

    await session.unregisterTool('weather');

    expect(rpc.core.unregisterTool).toHaveBeenCalledWith({
      sessionId: session.id,
      agentId: 'main',
      name: 'weather',
    });
  });

  it('forwards setActiveTools to the core with session and agent scope', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_active', workDir: '/tmp', rpc });

    await session.setActiveTools(['weather', 'calculator']);

    expect(rpc.core.setActiveTools).toHaveBeenCalledWith({
      sessionId: session.id,
      agentId: 'main',
      names: ['weather', 'calculator'],
    });
  });

  it('rejects an empty tool name', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_empty_name', workDir: '/tmp', rpc });

    await expect(
      session.registerTool({ name: '  ', description: 'No name', parameters: {} }),
    ).rejects.toMatchObject({
      name: 'KimiError',
      code: 'request.invalid',
    } satisfies Partial<KimiError>);
    await expect(session.unregisterTool('')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'request.invalid',
    } satisfies Partial<KimiError>);
    expect(rpc.core.registerTool).not.toHaveBeenCalled();
    expect(rpc.core.unregisterTool).not.toHaveBeenCalled();
  });

  it('rejects registration after the session is closed', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_closed', workDir: '/tmp', rpc });
    await session.close();

    await expect(
      session.registerTool({ name: 'weather', description: 'd', parameters: {} }),
    ).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.closed',
    } satisfies Partial<KimiError>);
  });
});

describe('Session tool registration (core integration)', () => {
  it('registers, activates and unregisters a user tool in the core', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-tools-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-tools-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_tools_integration', workDir });

      await session.registerTool({
        name: 'oci_echo',
        description: 'Echo the input text',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      });
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'tools.register_user_tool',
          (event) => event['name'] === 'oci_echo',
        ),
      ).resolves.toMatchObject({
        type: 'tools.register_user_tool',
        name: 'oci_echo',
        description: 'Echo the input text',
      });

      await session.setActiveTools(['oci_echo']);
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'tools.set_active_tools',
          (event) => Array.isArray(event['names']) && event['names'].includes('oci_echo'),
        ),
      ).resolves.toMatchObject({ type: 'tools.set_active_tools', names: ['oci_echo'] });

      await session.unregisterTool('oci_echo');
      await expect(
        waitForAgentWireEvent(
          homeDir,
          session.id,
          'tools.unregister_user_tool',
          (event) => event['name'] === 'oci_echo',
        ),
      ).resolves.toMatchObject({ type: 'tools.unregister_user_tool', name: 'oci_echo' });
    } finally {
      await harness.close();
    }
  });
});

describe('toolCall handler', () => {
  it('routes a reverse tool call to the session handler and returns its response', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_call', workDir: '/tmp', rpc });
    const handler = vi.fn(async (request: ToolCallRequest) => ({
      output: `echo:${JSON.stringify(request.args)}`,
    }));
    session.setToolCallHandler(handler);

    // Dispatch exactly what the core sends when the agent executes a user tool.
    const clientApi = new ClientAPI(rpc);
    const response = await clientApi.toolCall({
      turnId: 1,
      toolCallId: 'call_1',
      args: { text: 'hello' },
      sessionId: session.id,
      agentId: 'main',
    });

    expect(response).toEqual({ output: 'echo:{"text":"hello"}' });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call_1',
        args: { text: 'hello' },
        sessionId: session.id,
        agentId: 'main',
      }),
    );
  });

  it('supports synchronous handlers', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_sync', workDir: '/tmp', rpc });
    session.setToolCallHandler(() => ({ output: 'ok', isError: false }));

    await expect(
      rpc.toolCall({ toolCallId: 'call_sync', args: {}, sessionId: session.id, agentId: 'main' }),
    ).resolves.toEqual({ output: 'ok', isError: false });
  });

  it('returns an explicit error when no handler is registered', async () => {
    const rpc = new TestSDKRpcClient();

    await expect(
      rpc.toolCall({ toolCallId: 'call_2', args: {}, sessionId: 'ses_no_handler', agentId: 'main' }),
    ).resolves.toEqual({
      output: 'No tool call handler registered.',
      isError: true,
    });
  });

  it('does not route calls to a handler registered for another session', async () => {
    const rpc = new TestSDKRpcClient();
    const sessionA = new Session({ id: 'ses_tools_a', workDir: '/tmp', rpc });
    const sessionB = new Session({ id: 'ses_tools_b', workDir: '/tmp', rpc });
    const handlerA = vi.fn(async () => ({ output: 'from-a' }));
    sessionA.setToolCallHandler(handlerA);

    await expect(
      rpc.toolCall({ toolCallId: 'call_3', args: {}, sessionId: sessionB.id, agentId: 'main' }),
    ).resolves.toEqual({
      output: 'No tool call handler registered.',
      isError: true,
    });
    expect(handlerA).not.toHaveBeenCalled();
  });

  it('returns an error result and emits an error event when the handler throws', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_throw', workDir: '/tmp', rpc });
    session.setToolCallHandler(() => {
      throw new Error('boom');
    });
    const events: Event[] = [];
    rpc.onEvent((event) => {
      events.push(event);
    });

    await expect(
      rpc.toolCall({ toolCallId: 'call_4', args: {}, sessionId: session.id, agentId: 'main' }),
    ).resolves.toEqual({
      output: 'Tool call handler failed.',
      isError: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      sessionId: session.id,
      agentId: 'main',
      message: 'boom',
    });
  });

  it('clears the handler when set to undefined', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_clear', workDir: '/tmp', rpc });
    session.setToolCallHandler(async () => ({ output: 'ok' }));
    session.setToolCallHandler(undefined);

    await expect(
      rpc.toolCall({ toolCallId: 'call_5', args: {}, sessionId: session.id, agentId: 'main' }),
    ).resolves.toEqual({
      output: 'No tool call handler registered.',
      isError: true,
    });
  });

  it('clears the handler when the session closes', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_close', workDir: '/tmp', rpc });
    session.setToolCallHandler(async () => ({ output: 'ok' }));
    await session.close();

    await expect(
      rpc.toolCall({ toolCallId: 'call_6', args: {}, sessionId: session.id, agentId: 'main' }),
    ).resolves.toEqual({
      output: 'No tool call handler registered.',
      isError: true,
    });
  });

  it('rejects setToolCallHandler after the session is closed', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({ id: 'ses_tools_handler_closed', workDir: '/tmp', rpc });
    await session.close();

    expect(() => {
      session.setToolCallHandler(async () => ({ output: 'ok' }));
    }).toThrowError(
      expect.objectContaining({
        name: 'KimiError',
        code: 'session.closed',
      }) as Error,
    );
  });
});

class TestSDKRpcClient extends SDKRpcClientBase {
  readonly core = {
    registerTool: vi.fn(async (_input: unknown): Promise<void> => {}),
    unregisterTool: vi.fn(async (_input: unknown): Promise<void> => {}),
    setActiveTools: vi.fn(async (_input: unknown): Promise<void> => {}),
    closeSession: vi.fn(async (_input: unknown): Promise<void> => {}),
  };

  protected getRpc(): Promise<RPCMethods<CoreAPI>> {
    return Promise.resolve(this.core as unknown as RPCMethods<CoreAPI>);
  }
}
