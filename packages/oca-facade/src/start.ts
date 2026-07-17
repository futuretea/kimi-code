import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { EventPump } from './event-pump';
import { FacadeError, isFacadeError, toErrorBody } from './errors';
import { LiveHarnessFactory, type FacadeHarness, type HarnessFactory } from './harness';
import { registerApprovalRoutes } from './routes/approvals';
import type { RouteContext } from './routes/context';
import { registerEventRoutes } from './routes/events';
import { registerHealthRoutes } from './routes/health';
import { registerPromptRoutes } from './routes/prompts';
import { registerQuestionRoutes } from './routes/questions';
import { registerSessionRoutes } from './routes/sessions';
import { registerToolResultRoutes } from './routes/tool-results';
import { SessionRegistry, type RecoveredSession } from './session-registry';

/**
 * Composition root: builds the facade server (Fastify + pino on stdout),
 * wiring the session registry, the throttled event pump, and the harness
 * layer into the route modules. The single extension point is
 * `harnessFactory`; tests inject a fake harness through it.
 */

export interface StartServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly harnessFactory?: HarnessFactory;
  readonly deltaFlushIntervalMs?: number;
  readonly logger?: FastifyServerOptions['logger'];
}

export interface RunningFacadeServer {
  readonly server: FastifyInstance;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8080;

function readIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningFacadeServer> {
  const host = options.host ?? process.env['OCA_FACADE_HOST'] ?? DEFAULT_HOST;
  const port = options.port ?? readIntegerEnv('OCA_FACADE_PORT') ?? DEFAULT_PORT;
  const homeDir = options.homeDir ?? process.env['OCA_HOME_DIR'];
  const deltaFlushIntervalMs =
    options.deltaFlushIntervalMs ?? readIntegerEnv('OCA_DELTA_FLUSH_INTERVAL_MS');

  // The registry/harness pair is circular by design: journal recovery of a
  // failed session re-attaches the runtime session through the harness, and
  // the harness correlates its reverse-RPC calls through the registry.
  let harness: FacadeHarness;
  const registry: SessionRegistry = new SessionRegistry({
    recoverFromJournal: async (sessionId): Promise<RecoveredSession> => {
      await harness.resumeSession(sessionId);
      return { pendingCalls: registry.listPendingCalls(sessionId) };
    },
  });
  const pump = new EventPump({
    registry,
    ...(deltaFlushIntervalMs !== undefined ? { deltaFlushIntervalMs } : {}),
  });
  harness = new LiveHarnessFactory({
    registry,
    sink: pump,
    ...(options.harnessFactory !== undefined ? { createHarness: options.harnessFactory } : {}),
    harnessOptions: homeDir !== undefined ? { homeDir } : {},
  });

  const app = Fastify({
    logger: options.logger ?? true,
    // Hijacked NDJSON/SSE connections stay open by design; close must not hang
    // on them, so shutdown forces all connections closed.
    forceCloseConnections: true,
  });

  app.setErrorHandler((error, _req, reply) => {
    if (!isFacadeError(error)) {
      // Unexpected faults carry runtime internals: they belong in the
      // internal log only, never in the response body.
      app.log.error({ err: error }, 'unhandled facade error');
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    const facadeError = isFacadeError(error)
      ? error
      : new FacadeError(statusCode === 400 || statusCode === 415 ? 'invalid_request' : 'internal_error');
    void reply.code(facadeError.httpStatus).send(toErrorBody(facadeError));
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send(toErrorBody(new FacadeError('session_not_found')));
  });

  const ctx: RouteContext = { registry, harness, pump };
  registerSessionRoutes(app, ctx);
  registerPromptRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerQuestionRoutes(app, ctx);
  registerToolResultRoutes(app, ctx);
  registerHealthRoutes(app, ctx);

  await app.listen({ host, port });
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  const close = async (): Promise<void> => {
    pump.dispose();
    await app.close();
  };
  return { server: app, host, port: boundPort, close };
}
