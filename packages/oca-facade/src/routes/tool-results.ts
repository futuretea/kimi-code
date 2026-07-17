import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';

import type { RouteContext } from './context';
import { defineRoute } from './define-route';

/**
 * Tool result route: returns an external tool outcome by `tool_call_id`. A
 * `completed` resolution requires `output` (`invalid_request` otherwise, and
 * the call stays pending so a corrected retry is accepted).
 */

const toolResultBodySchema = z.object({
  tool_call_id: z.string().min(1),
  resolution: z.enum(['completed', 'failed', 'skipped']),
  output: z.string().optional(),
});

const sessionParamsSchema = z.object({ id: z.string().min(1) });

export function registerToolResultRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const route = defineRoute(
    { method: 'POST', path: '/sessions/{id}/tool-results', params: sessionParamsSchema, body: toolResultBodySchema },
    async (req, reply) => {
      ctx.registry.resolveToolResult(req.params.id, {
        toolCallId: req.body.tool_call_id,
        resolution: req.body.resolution,
        ...(req.body.output !== undefined ? { output: req.body.output } : {}),
      });
      return reply.code(202).send({ accepted: true });
    },
  );
  app.post(route.path, route.options, route.handler as RouteHandlerMethod);
}
