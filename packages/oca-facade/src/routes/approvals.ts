import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';

import type { RouteContext } from './context';
import { defineRoute } from './define-route';

/**
 * Approval route: resolves a pending approval by `tool_call_id`. Unknown,
 * duplicate, late, or kind-mismatched ids reject as `request_not_pending`.
 */

const approvalBodySchema = z.object({
  tool_call_id: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  feedback: z.string().optional(),
});

const sessionParamsSchema = z.object({ id: z.string().min(1) });

export function registerApprovalRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const route = defineRoute(
    { method: 'POST', path: '/sessions/{id}/approvals', params: sessionParamsSchema, body: approvalBodySchema },
    async (req, reply) => {
      ctx.registry.resolveApproval(req.params.id, {
        toolCallId: req.body.tool_call_id,
        decision: req.body.decision,
        ...(req.body.feedback !== undefined ? { feedback: req.body.feedback } : {}),
      });
      return reply.code(202).send({ accepted: true });
    },
  );
  app.post(route.path, route.options, route.handler as RouteHandlerMethod);
}
