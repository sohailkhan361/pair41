// Starts the Pair41 server and shuts it down gracefully on SIGTERM and SIGINT.
import { createDb } from '../store/db.ts';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { shutdownTelemetry } from './telemetry.ts';

export async function startServer() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl, config.databaseSsl);
  const { app, markNotReady } = buildApp(config, db);

  let stopping = false;
  async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    markNotReady(); // /ready fails first, so the platform stops sending traffic
    await app.close(); // stop accepting connections and let in-flight requests finish
    await shutdownTelemetry(); // flush traces
    await db.destroy();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}
