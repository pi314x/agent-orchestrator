import type { McpServer } from '@modelcontextprotocol/server';
import type { Config, ToolProfile } from '../config.js';
import type { Db } from '../db/sqlite.js';
import type { Logger } from '../logger.js';

export interface ToolDeps {
  config: Config;
  db: Db;
  logger: Logger;
  version: string;
  /** Process start, as `performance.now()`-independent epoch ms. */
  startedAt: number;
  /** Protocol era this serving unit was constructed for. */
  era: 'legacy' | 'modern';
}

export interface ToolRegistration {
  readonly name: string;
  readonly profile: ToolProfile;
  register(server: McpServer, deps: ToolDeps): void;
}
