import { pino } from 'pino';
import type { ClientProvider } from '../src/a2a/client.js';
import type { Config, ToolProfile } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { openDatabase, type Db } from '../src/db/sqlite.js';
import type { Logger } from '../src/logger.js';
import { MockRunner, type MockScriptFn } from '../src/runners/mock.js';
import { createServices, type Services } from '../src/services.js';

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    dataDir: '/tmp/agent-orchestrator-test',
    toolProfile: 'standard',
    transport: 'http',
    httpHost: '127.0.0.1',
    httpPort: 0,
    dbUrl: ':memory:',
    maxDepth: 2,
    maxConcurrency: 4,
    logLevel: 'silent',
    // CI never reaches a real model.
    defaultRunner: 'mock',
    agentsDir: 'agents',
    cliWorkspaceDirs: [],
    cliAllowNetwork: false,
    oauthRequiredScopes: [],
    a2aEnabled: false,
    a2aHttpPort: 0,
    // Tests use unsigned fixture cards, so signature checks would block them.
    a2aTrustMode: 'allow-unverified',
    a2aWebhookAllowedHosts: [],
    ...overrides
  };
}

export async function migratedDb(): Promise<Db> {
  const db = openDatabase({ url: ':memory:' });
  await migrate(db);
  return db;
}

export interface TestServicesOptions {
  profile?: ToolProfile;
  config?: Partial<Config>;
  /** Script the mock runner so tests control completion without timers. */
  mockScript?: MockScriptFn;
  /** Point the A2A gateway at an in-repo fixture agent instead of the network. */
  a2aClientProvider?: ClientProvider;
}

export async function testServices(options: TestServicesOptions = {}): Promise<Services> {
  const db = await migratedDb();
  const config = testConfig({
    ...(options.profile !== undefined && { toolProfile: options.profile }),
    ...options.config
  });

  const services = createServices({
    config,
    db,
    logger: silentLogger(),
    ...(options.a2aClientProvider !== undefined && { a2aClientProvider: options.a2aClientProvider })
  });

  if (options.mockScript !== undefined) {
    services.runners.register(new MockRunner(options.mockScript));
  }

  return services;
}

/**
 * Unwind in-flight runs before closing the database — an aborted run still
 * writes its outcome, and a closed connection turns that into a crash.
 */
export async function closeServices(services: Services): Promise<void> {
  await services.scheduler.shutdown();
  await services.proxy.close();
  await services.db.close();
}

/** A promise plus the handle to settle it, for gating a scripted mock run. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
