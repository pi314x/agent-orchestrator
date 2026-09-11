import { destination, pino, type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

/**
 * Logs always go to stderr: in stdio mode stdout carries protocol frames only,
 * and MCP logging notifications are deprecated in 2026-07-28.
 */
export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino({ level: config.logLevel, base: undefined }, destination(2));
}
