import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';

import type { TurnStream } from '../event-pump';

import type { RouteContext } from './context';
import { defineRoute } from './define-route';

/**
 * Prompt route: `POST /sessions/{id}/prompt` answers with an NDJSON stream of
 * this turn's facade events (the inline channel) plus a terminal
 * `prompt_done` frame. Idempotency is scoped by (session, idempotency_key):
 * an in-flight key rejects as busy, a finished key with identical content
 * replays only the first terminal frame, and a finished key with different
 * content conflicts.
 */

const promptBodySchema = z.object({
  content: z.string().min(1),
  idempotency_key: z.string().min(1).optional(),
});

const sessionParamsSchema = z.object({ id: z.string().min(1) });

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson',
  'Cache-Control': 'no-cache',
};

export function registerPromptRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const promptRoute = defineRoute(
    { method: 'POST', path: '/sessions/{id}/prompt', params: sessionParamsSchema, body: promptBodySchema },
    async (req, reply) => {
      const sessionId = req.params.id;
      const content = req.body.content;
      const decision = ctx.registry.startPrompt(sessionId, {
        content,
        ...(req.body.idempotency_key !== undefined
          ? { idempotencyKey: req.body.idempotency_key }
          : {}),
      });

      if (decision.status === 'replayed') {
        // Finished key + identical content: the first terminal frame only —
        // no event replay, no re-execution.
        return reply
          .code(200)
          .type('application/x-ndjson')
          .send(`${JSON.stringify(decision.frame)}\n`);
      }

      reply.hijack();
      reply.raw.writeHead(200, NDJSON_HEADERS);
      // Push headers out now so the client can start reading before the first
      // event lands (Node would otherwise wait for the first body write).
      reply.raw.flushHeaders();
      const stream: TurnStream = {
        write: (frame) => {
          reply.raw.write(`${JSON.stringify(frame)}\n`);
        },
        end: () => {
          reply.raw.end();
        },
      };
      ctx.pump.attachTurn(sessionId, stream);
      // A client disconnect only detaches the inline channel; the turn keeps
      // running to its terminal state (events still flow on the SSE channel).
      reply.raw.on('close', () => {
        ctx.pump.detachTurn(sessionId, stream);
      });
      try {
        await ctx.harness.prompt(sessionId, content);
      } catch (error) {
        ctx.pump.failTurn(sessionId, error);
      }
      return undefined;
    },
  );
  app.post(promptRoute.path, promptRoute.options, promptRoute.handler as RouteHandlerMethod);
}
