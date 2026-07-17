import type { FastifyInstance } from 'fastify';

import type { RouteContext } from './context';

/**
 * Probe routes: `/health` is a plain liveness signal; `/ready` additionally
 * requires the harness (runtime) to be available and the home (journal)
 * directory to be readable and writable, failing closed as
 * `runtime_unavailable`.
 */
export function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async () => {
    await ctx.harness.probe?.();
    return { status: 'ok' };
  });
}
