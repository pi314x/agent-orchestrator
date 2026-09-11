import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import type { Db } from './db/sqlite.js';
import type { Logger } from './logger.js';
import { registerTools } from './tools/profiles.js';
import { SERVER_NAME, VERSION } from './version.js';

export interface ServerDeps {
  config: Config;
  db: Db;
  logger: Logger;
  startedAt: number;
}

/**
 * One factory serves every transport and both protocol eras. Instances are
 * per-serving-unit and hold no cross-request state — all state is in the DB,
 * addressed by explicit IDs in tool arguments.
 */
export function createServerFactory(deps: ServerDeps): McpServerFactory {
  return ctx => {
    const server = new McpServer({ name: SERVER_NAME, version: VERSION });

    registerTools(server, {
      config: deps.config,
      db: deps.db,
      logger: deps.logger,
      version: VERSION,
      startedAt: deps.startedAt,
      era: ctx.era
    });

    return server;
  };
}
