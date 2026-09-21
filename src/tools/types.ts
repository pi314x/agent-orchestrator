import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolProfile } from '../config.js';
import type { Principal } from '../core/principal.js';
import type { Services } from '../services.js';

export interface ToolDeps {
  services: Services;
  /** Who this request acts as. Stores filter and stamp rows from it. */
  principal: Principal;
  version: string;
  /** Process start as epoch ms. */
  startedAt: number;
  /** Protocol era this serving unit was constructed for. */
  era: 'legacy' | 'modern';
}

export interface ToolRegistration {
  readonly name: string;
  readonly profile: ToolProfile;
  /**
   * Interop-only tools. They disappear from tools/list entirely when
   * A2A_ENABLED is false, so a purely local deployment never sees them.
   */
  readonly requiresA2A?: boolean;
  register(server: McpServer, deps: ToolDeps): void;
}
