import { startServer } from './start';

/**
 * Container entrypoint: start the facade server with configuration from the
 * environment (see `./start` for the read points) and close it cleanly on the
 * termination signals a pod receives.
 */
const server = await startServer();

let closing = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (closing) return;
  closing = true;
  server.server.log.info({ signal }, 'facade shutdown requested');
  void server
    .close()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      server.server.log.error({ err: error }, 'facade shutdown failed');
      process.exit(1);
    });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
