import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { assertFts5, openDatabase } from './db/sqlite.js';
import { migrate } from './db/migrate.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { createServerFactory } from './server.js';
import { VERSION } from './version.js';

const startedAt = Date.now();
const config = loadConfig();
const logger = createLogger(config);

const db = openDatabase({ url: config.dbUrl });
assertFts5(db);
const migration = migrate(db);
if (migration.applied.length > 0) {
  logger.info({ ...migration }, 'applied migrations');
}

const factory = createServerFactory({ config, db, logger, startedAt });

const shutdown = (close: () => Promise<void>) => {
  let closing = false;
  const handle = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    void close()
      .catch(error => logger.error({ err: error }, 'shutdown failed'))
      .finally(() => {
        db.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
};

if (config.transport === 'http') {
  const http = await startHttpServer({ factory, config, logger });
  logger.info({ url: http.url, profile: config.toolProfile, version: VERSION }, 'MCP Streamable HTTP ready');
  shutdown(() => http.close());
} else {
  const handle = serveStdio(factory);
  logger.info({ profile: config.toolProfile, version: VERSION }, 'MCP stdio ready');
  shutdown(async () => {
    await handle.close();
  });
}
