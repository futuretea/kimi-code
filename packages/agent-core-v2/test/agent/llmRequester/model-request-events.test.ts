import { APIConnectionError } from '#/app/llmProtocol/errors';
import { afterEach, describe, expect, it } from 'vitest';

import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import {
  createTestAgent,
  llmGenerateServices,
  type TestAgentContext,
} from '../../harness';

type RPCEvent = Extract<
  TestAgentContext['allEvents'][number],
  { readonly type: '[rpc]' }
>;

function modelRequestEvents(ctx: TestAgentContext, name: string): readonly RPCEvent[] {
  return ctx.allEvents.filter(
    (event): event is RPCEvent => event.type === '[rpc]' && event.event === name,
  );
}

describe('model request lifecycle events', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('emits one correlated successful pair for an actual provider request', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'request completed' });

    await ctx.get(IAgentLLMRequesterService).request();

    const started = modelRequestEvents(ctx, 'model.request.started');
    const ended = modelRequestEvents(ctx, 'model.request.ended');
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(started[0]?.args).toMatchObject({ requestId: expect.any(String) });
    expect(ended[0]?.args).toEqual({
      requestId: (started[0]?.args as { requestId: string }).requestId,
      isError: false,
    });
  });

  it('closes the pair as an error when the provider request fails', async () => {
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        throw new APIConnectionError('provider unavailable');
      }),
    );

    await expect(ctx.get(IAgentLLMRequesterService).request()).rejects.toMatchObject({
      name: 'APIConnectionError',
    });

    const started = modelRequestEvents(ctx, 'model.request.started');
    const ended = modelRequestEvents(ctx, 'model.request.ended');
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.args).toEqual({
      requestId: (started[0]?.args as { requestId: string }).requestId,
      isError: true,
    });
  });
});
