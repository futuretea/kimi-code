import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';

import type { RouteContext } from './context';
import { defineRoute } from './define-route';

/**
 * Question route: answers a pending user question by `question_id` (facade
 * generated). Answers map each question to a string answer or `true`.
 */

const questionBodySchema = z.object({
  question_id: z.string().min(1),
  answers: z.record(z.string(), z.union([z.string(), z.literal(true)])),
});

const sessionParamsSchema = z.object({ id: z.string().min(1) });

export function registerQuestionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const route = defineRoute(
    { method: 'POST', path: '/sessions/{id}/questions', params: sessionParamsSchema, body: questionBodySchema },
    async (req, reply) => {
      ctx.registry.answerQuestion(req.params.id, {
        questionId: req.body.question_id,
        answers: req.body.answers,
      });
      return reply.code(202).send({ accepted: true });
    },
  );
  app.post(route.path, route.options, route.handler as RouteHandlerMethod);
}
