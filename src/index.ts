import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { loadAgentFiles } from './core/agent-files.js';
import { migrate } from './db/migrate.js';
import { assertFts5, openDatabase } from './db/sqlite.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { createServerFactory } from './server.js';
import { createServices } from './services.js';
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

const services = createServices({ config, db, logger });

// Repo files are the source of truth for the agents they define: edits land on
// restart and deletions withdraw the agent.
const agentFiles = loadAgentFiles(config.agentsDir);
if (agentFiles.length > 0) {
  const sync = services.agents.syncFromFiles(agentFiles);
  logger.info({ ...sync, dir: config.agentsDir }, 'synced agents from files');
}

// A previous process may have died mid-run; those rows own no scheduler.
const interrupted = services.jobs.recoverInterrupted();
if (interrupted.length > 0) {
  logger.warn({ jobIds: interrupted }, 'failed jobs interrupted by a previous shutdown');
}

const factory = createServerFactory({ services, startedAt });

const shutdown = (close: () => Promise<void>) => {
  let closing = false;
  const handle = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    void Promise.all([close(), services.scheduler.shutdown()])
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
