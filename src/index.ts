import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { startA2AServer, type A2AHttpHandle } from './a2a/http.js';
import { loadConfig } from './config.js';
import { loadAgentFiles } from './core/agent-files.js';
import { migrate } from './db/migrate.js';
import { assertSearchSupport, openDatabase } from './db/open.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { parseCorsPolicy } from './cors.js';
import { keyFingerprint, pqcGetPublicKey } from './core/pqc.js';
import { pruneOldData } from './core/maintenance.js';
import { applyDeclarativeConfig, loadDeclarativeConfigFile } from './config-file.js';
import { createServerFactory } from './server.js';
import { createServices } from './services.js';
import { SERVER_NAME, VERSION } from './version.js';

const startedAt = Date.now();
const config = loadConfig();
const logger = createLogger(config);

const db = openDatabase({
  url: config.dbUrl,
  ...(config.dbMaxConnections !== undefined && { maxConnections: config.dbMaxConnections }),
  onError: error => logger.error({ err: error }, 'database connection dropped while idle')
});
await assertSearchSupport(db);
const migration = await migrate(db);
if (migration.applied.length > 0) {
  logger.info({ ...migration }, 'applied migrations');
}

const services = createServices({ config, db, logger });

// CORS posture, logged once: allow-all (the default) means any website the
// operator's browser visits can call these surfaces, so it belongs on
// loopback, behind OAuth, or narrowed to named origins — never assumed safe.
const cors = parseCorsPolicy(config.corsAllowedOrigins);
if (cors.allowAll) {
  logger.warn(
    'CORS allows all origins (ORCH_CORS_ALLOWED_ORIGINS unset): any website can call the HTTP surfaces. Narrow it when exposing beyond localhost.'
  );
} else {
  logger.info({ origins: cors.origins }, 'CORS restricted to named origins');
}

// Post-quantum posture, logged once so an operator can confirm what the
// status tool reports: fingerprints name keys, never secrets.
if (services.pqc.dataKey !== undefined) {
  logger.info('PQC at-rest encryption enabled (X25519+ML-KEM-768) for artifacts and memory values');
}
if (services.pqc.cardSigner !== undefined) {
  const { kid, secretKey } = services.pqc.cardSigner;
  logger.info(
    { kid, fingerprint: keyFingerprint(pqcGetPublicKey(secretKey)) },
    'PQC card signing enabled (ML-DSA-65)'
  );
}

// Repo files are the source of truth for the agents they define: edits land on
// restart and deletions withdraw the agent.
const agentFiles = loadAgentFiles(config.agentsDir);
if (agentFiles.length > 0) {
  const sync = await services.agents.syncFromFiles(agentFiles);
  logger.info({ ...sync, dir: config.agentsDir }, 'synced agents from files');
}

// Declarative operator config lands once at boot, after the agent files:
// templates, toolservers, presets, schedules and budgets, all upserted, so
// re-applying an unchanged file is a no-op and anything changed through the
// tools afterwards stays changed until the next restart.
const declarative = await loadDeclarativeConfigFile(config.configFile);
if (declarative.path !== undefined) {
  const applied = await applyDeclarativeConfig(services, declarative.config);
  logger.info({ ...applied, path: declarative.path }, 'applied declarative config');
}

// Jobs left running by a process that died are reclaimed once their lease
// expires — which is also what stops us stealing work from a sibling instance
// that is alive and busy. `start` runs a lease pass immediately and then on a
// timer, and pumps: a reclaimed or merely-queued job has nothing else to
// trigger it, since pump otherwise only runs off submit, retry or a finished
// run, none of which just happened.
services.scheduler.start();
// A run whose last job settled without advance observing it (a crash between
// the row write and the notification) heals on the next unrelated job event
// at the earliest — on an idle deployment, never. One explicit pass at boot
// settles those; anything it cannot settle was already broken loudly.
services.workflows.resumeAll().catch(error => logger.error({ err: error }, 'workflow resume at startup failed'));
// Due schedules fire from here, on the same process lifetime. The claim is
// atomic, so sibling instances sharing the database never double-fire.
services.scheduleRunner.start();

// Retention as policy, not just a tool: with ORCH_RETENTION_DAYS set,
// finished history older than the cutoff goes at boot. Unset keeps
// everything — pruning must always be an explicit choice, never a default.
if (config.retentionDays !== undefined) {
  const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000).toISOString();
  const pruned = await pruneOldData(db, cutoff);
  logger.info({ cutoff, ...pruned }, 'pruned finished history at startup');
}

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
      ...(config.a2aAgentCardUrl !== undefined && { publicUrl: config.a2aAgentCardUrl }),
      ...(services.pqc.cardSigner !== undefined && { pqcSigner: services.pqc.cardSigner })
    },
    host: config.httpHost,
    port: config.a2aHttpPort,
    logger,
    corsAllowedOrigins: config.corsAllowedOrigins
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
    services.scheduleRunner.stop();
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
  const http = await startHttpServer({
    factory,
    config,
    logger,
    dashboard: { services, version: VERSION, startedAt }
  });
  logger.info({ url: http.url, profile: config.toolProfile, version: VERSION }, 'MCP Streamable HTTP ready');
  shutdown(() => http.close());
} else {
  const handle = serveStdio(factory);
  logger.info({ profile: config.toolProfile, version: VERSION }, 'MCP stdio ready');
  shutdown(async () => {
    await handle.close();
  });
}
