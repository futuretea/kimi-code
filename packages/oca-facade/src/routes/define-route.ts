import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { z } from 'zod';

import { FacadeError } from '../errors';

/**
 * `defineRoute` — single-source route declaration. One object declares the
 * path plus the runtime Zod validators; the helper returns a Fastify-ready
 * `{ path, options, handler }` triple. Path params use the OpenAPI `{param}`
 * syntax and are converted to Fastify `:param` segments.
 *
 * Validation failures reject as `invalid_request` through the shared error
 * handler, so every route speaks the contract error envelope.
 */

type Infer<T extends z.ZodTypeAny | undefined> = T extends z.ZodTypeAny ? z.infer<T> : unknown;

export interface RouteSpec<
  TBody extends z.ZodTypeAny | undefined,
  TParams extends z.ZodTypeAny | undefined,
> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: TBody;
  readonly params?: TParams;
}

export interface RouteDefinition<
  TBody extends z.ZodTypeAny | undefined,
  TParams extends z.ZodTypeAny | undefined,
> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly options: { preHandler: preHandlerHookHandler[] };
  readonly handler: (
    req: FastifyRequest & { body: Infer<TBody>; params: Infer<TParams> },
    reply: FastifyReply,
  ) => Promise<unknown>;
}

/** Converts OpenAPI `{param}` segments to Fastify `:param` segments. */
function toFastifyPath(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

function validate(target: 'body' | 'params', schema: z.ZodTypeAny): preHandlerHookHandler {
  return (req, _reply, done) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      done(new FacadeError('invalid_request'));
      return;
    }
    req[target] = result.data;
    done();
  };
}

export function defineRoute<
  TBody extends z.ZodTypeAny | undefined = undefined,
  TParams extends z.ZodTypeAny | undefined = undefined,
>(
  spec: RouteSpec<TBody, TParams>,
  handler: RouteDefinition<TBody, TParams>['handler'],
): RouteDefinition<TBody, TParams> {
  const preHandler: preHandlerHookHandler[] = [];
  if (spec.params !== undefined) preHandler.push(validate('params', spec.params));
  if (spec.body !== undefined) preHandler.push(validate('body', spec.body));
  return { method: spec.method, path: toFastifyPath(spec.path), options: { preHandler }, handler };
}
