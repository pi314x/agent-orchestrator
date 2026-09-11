import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import type { Services } from './services.js';
import { registerTools } from './tools/profiles.js';
import { SERVER_NAME, VERSION } from './version.js';

export interface ServerDeps {
  services: Services;
  startedAt: number;
}

/**
 * One factory serves every transport and both protocol eras. Instances are
 * per-serving-unit and hold no cross-request state — all state lives in the
 * services below, addressed by explicit IDs in tool arguments.
 */
export function createServerFactory(deps: ServerDeps): McpServerFactory {
  return ctx => {
    const server = new McpServer({ name: SERVER_NAME, version: VERSION });

    registerTools(server, {
      services: deps.services,
      version: VERSION,
      startedAt: deps.startedAt,
      era: ctx.era
    });

    registerResources(server, deps.services, VERSION);
    registerPrompts(server, deps.services);

    return server;
  };
}
