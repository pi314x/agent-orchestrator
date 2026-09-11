import { pino } from 'pino';
import type { Config, ToolProfile } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { openDatabase, type Db } from '../src/db/sqlite.js';
import type { Logger } from '../src/logger.js';

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
    a2aEnabled: false,
    ...overrides
  };
}

export function migratedDb(): Db {
  const db = openDatabase({ url: ':memory:' });
  migrate(db);
  return db;
}

export function testDeps(profile: ToolProfile = 'standard') {
  const db = migratedDb();
  return {
    db,
    config: testConfig({ toolProfile: profile }),
    logger: silentLogger(),
    startedAt: Date.now()
  };
}
