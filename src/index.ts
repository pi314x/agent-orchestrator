import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { startA2AServer, type A2AHttpHandle } from './a2a/http.js';
import { loadConfig } from './config.js';
import { loadAgentFiles } from './core/agent-files.js';
import { migrate } from './db/migrate.js';
import { assertFts5, openDatabase } from './db/sqlite.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { createServerFactory } from './server.js';
import { createServices } from './services.js';
import { SERVER_NAME, VERSION } from './version.js';

const startedAt = Date.now();
const config = loadConfig();
const logger = createLogger(config);

const db = openDatabase({ url: config.dbUrl });
await assertFts5(db);
const migration = await migrate(db);
if (migration.applied.length > 0) {
  logger.info({ ...migration }, 'applied migrations');
}

const services = createServices({ config, db, logger });

// Repo files are the source of truth for the agents they define: edits land on
// restart and deletions withdraw the agent.
const agentFiles = loadAgentFiles(config.agentsDir);
if (agentFiles.length > 0) {
  const sync = await services.agents.syncFromFiles(agentFiles);
  logger.info({ ...sync, dir: config.agentsDir }, 'synced agents from files');
}

// A previous process may have died mid-run; those rows own no scheduler.
const interrupted = await services.jobs.recoverInterrupted();
if (interrupted.length > 0) {
  logger.warn({ jobIds: interrupted }, 'jobs interrupted by a previous shutdown');
}
// Anything recoverInterrupted just re-queued (an idempotent job) has nothing
// else to trigger it — pump only ever runs off submit/retry/a finished run,
// none of which just happened. Without this it would sit queued until some
// unrelated job submission happened to wake the scheduler.
services.scheduler.start();

// The inbound half of A2A, on its own port and only when asked for. Off by
// default: a local-only deployment should never open a second listener.
let a2a: A2AHttpHandle | undefined;
if (config.a2aEnabled) {
  a2a = await startA2AServer({
    deps: {
      skills: services.publishedSkills,
      scheduler: services.scheduler,
      agents: services.agents,
      logger,
      defaultRunner: config.defaultRunner,
      serverName: SERVER_NAME,
      serverVersion: VERSION,
      ...(config.a2aAgentCardUrl !== undefined && { publicUrl: config.a2aAgentCardUrl })
    },
    host: config.httpHost,
    port: config.a2aHttpPort,
    logger
  });

  services.a2aServing = true;
  logger.info(
    { url: a2a.url, cardUrl: a2a.cardUrl, skills: (await services.publishedSkills.listExposed()).length },
    'A2A inbound server ready'
  );
}

const factory = createServerFactory({ services, startedAt });

const shutdown = (close: () => Promise<void>) => {
  let closing = false;
  const handle = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    void Promise.all([close(), a2a?.close() ?? Promise.resolve(), services.scheduler.shutdown()])
      .catch(error => logger.error({ err: error }, 'shutdown failed'))
      .finally(() => {
        void db.close().finally(() => process.exit(0));
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
