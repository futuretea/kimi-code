import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';

import type { RouteContext } from './context';
import { defineRoute } from './define-route';

/**
 * Event stream route: `GET /sessions/{id}/events/stream` serves live-only SSE
 * — events are delivered from subscription time onward, with no offset or
 * replay. Frames carry `id:` (per-session sequence), `event:` (facade event
 * type), and `data:` (the event JSON).
 */

const sessionParamsSchema = z.object({ id: z.string().min(1) });

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

export function registerEventRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const streamRoute = defineRoute(
    { method: 'GET', path: '/sessions/{id}/events/stream', params: sessionParamsSchema },
    async (req, reply) => {
      const sessionId = req.params.id;
      ctx.registry.assertEventStreamAllowed(sessionId);

      reply.hijack();
      reply.raw.writeHead(200, SSE_HEADERS);
      // Node defers headers until the first body write; a live-only stream may
      // stay silent for a while, so push the headers out immediately.
      reply.raw.flushHeaders();
      const unsubscribe = ctx.pump.subscribe(sessionId, {
        publish: (seq, event) => {
          reply.raw.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        },
      });
      reply.raw.on('close', unsubscribe);
      return undefined;
    },
  );
  app.get(streamRoute.path, streamRoute.options, streamRoute.handler as RouteHandlerMethod);
}
