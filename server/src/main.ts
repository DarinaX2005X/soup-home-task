import { config } from './config.ts';
import { createPool, migrate } from './db.ts';
import { buildApp } from './app.ts';

async function connectWithRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 30) throw error;
      console.error(`${what} not ready (${(error as Error).message}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

const applied = await connectWithRetry('database', () =>
  migrate(config.migrateUrl, config.appDbPassword),
);
const db = createPool(config.databaseUrl, config.poolMax);
const { app, hub } = await buildApp(db, config);
if (applied.length > 0) app.log.info({ applied }, 'migrations applied');
await hub.start();
await app.listen({ host: config.host, port: config.port });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  // Streams are told to go first. Their clients reconnect from their cursor.
  await hub.stop();
  await app.close();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
