import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolProfile } from '../config.js';
import type { Services } from '../services.js';

export interface ToolDeps {
  services: Services;
  version: string;
  /** Process start as epoch ms. */
  startedAt: number;
  /** Protocol era this serving unit was constructed for. */
  era: 'legacy' | 'modern';
}

export interface ToolRegistration {
  readonly name: string;
  readonly profile: ToolProfile;
  register(server: McpServer, deps: ToolDeps): void;
}
