import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';
import type { AgentSnapshot } from './jobs.js';
import { getTemplate, type RunnerName } from './templates.js';

export type AgentKind = 'local' | 'remote';
export type AgentStatus = 'active' | 'deleted';

export type AgentLimits = {
  maxSteps?: number;
  timeoutSec?: number;
  maxCostUsd?: number;
};

export type AgentRecord = {
  id: string;
  kind: AgentKind;
  name: string;
  role?: string;
  instructions: string;
  runner?: RunnerName;
  model?: string;
  toolGrants: string[];
  limits: AgentLimits;
  status: AgentStatus;
  ephemeral: boolean;
  createdAt: string;
  updatedAt: string;
};

export interface CreateAgentInput {
  kind?: AgentKind;
  name: string;
  role?: string;
  instructions: string;
  runner?: RunnerName;
  model?: string;
  toolGrants?: readonly string[];
  limits?: AgentLimits;
  ephemeral?: boolean;
}

export interface AgentListFilter {
  kind?: AgentKind;
  cursor?: string;
  limit?: number;
  includeEphemeral?: boolean;
}

type AgentRow = {
  id: string;
  kind: string;
  name: string;
  role: string | null;
  instructions: string;
  runner: string | null;
  model: string | null;
  tool_grants: string;
  limits: string;
  status: string;
  ephemeral: number;
  created_at: string;
  updated_at: string;
};

function toRecord(row: AgentRow): AgentRecord {
  const record: AgentRecord = {
    id: row.id,
    kind: row.kind as AgentKind,
    name: row.name,
    instructions: row.instructions,
    toolGrants: JSON.parse(row.tool_grants) as string[],
    limits: JSON.parse(row.limits) as AgentLimits,
    status: row.status as AgentStatus,
    ephemeral: row.ephemeral === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (row.role !== null) record.role = row.role;
  if (row.runner !== null) record.runner = row.runner as RunnerName;
  if (row.model !== null) record.model = row.model;
  return record;
}

export function toSnapshot(agent: AgentRecord): AgentSnapshot {
  return {
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    instructions: agent.instructions,
    ...(agent.role !== undefined && { role: agent.role }),
    ...(agent.runner !== undefined && { runner: agent.runner }),
    ...(agent.model !== undefined && { model: agent.model })
  };
}

export interface AgentTarget {
  agentId?: string;
  template?: string;
  skillQuery?: string;
}

export interface TargetDefaults {
  runner: RunnerName;
  model?: string;
}

/**
 * Resolve what a caller asked for into a concrete agent. `skillQuery` will also
 * match registered remote A2A cards in M4, which is why callers never need to
 * know which backend they landed on.
 */
export function resolveAgentTarget(
  registry: AgentRegistry,
  target: AgentTarget,
  defaults: TargetDefaults
): AgentRecord {
  if (target.agentId !== undefined) return registry.getOrThrow(target.agentId);

  if (target.template !== undefined) {
    return registry.createFromTemplate(target.template, {
      runner: defaults.runner,
      ...(defaults.model !== undefined && { model: defaults.model })
    });
  }

  if (target.skillQuery !== undefined) {
    const found = registry.findBySkill(target.skillQuery);
    if (found === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No agent matches the skill query "${target.skillQuery}".`,
        'Create one with agent_create, or pass a template name instead.'
      );
    }
    return found;
  }

  throw new OrchestratorError(
    'INVALID_INPUT',
    'Specify exactly one of agentId, template or skillQuery.',
    'Call agent_template_list for the built-in templates.'
  );
}

export class AgentRegistry {
  constructor(private readonly db: Db) {}

  create(input: CreateAgentInput): AgentRecord {
    const ephemeral = input.ephemeral ?? false;

    if (!ephemeral && this.findByName(input.name) !== undefined) {
      throw new OrchestratorError(
        'CONFLICT',
        `An agent named "${input.name}" already exists.`,
        'Pick a different name, or use agent_get to inspect the existing one.'
      );
    }

    const now = new Date().toISOString();
    const id = newId('agent');

    this.db
      .prepare(
        `INSERT INTO agents (
           id, kind, name, role, instructions, runner, model, tool_grants, limits, status, ephemeral, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        id,
        input.kind ?? 'local',
        input.name,
        input.role ?? null,
        input.instructions,
        input.runner ?? null,
        input.model ?? null,
        JSON.stringify([...(input.toolGrants ?? [])]),
        JSON.stringify(input.limits ?? {}),
        ephemeral ? 1 : 0,
        now,
        now
      );

    return this.getOrThrow(id);
  }

  /** Materialize a built-in template as a throwaway agent for a one-shot job. */
  createFromTemplate(templateName: string, overrides: Partial<CreateAgentInput> = {}): AgentRecord {
    const template = getTemplate(templateName);
    if (template === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No template named "${templateName}".`,
        'Call agent_template_list to see the available templates.'
      );
    }

    return this.create({
      name: `${template.name}-${Date.now()}`,
      role: template.role,
      instructions: template.instructions,
      runner: template.runner,
      ephemeral: true,
      ...overrides
    });
  }

  get(id: string): AgentRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ? AND status = 'active'`).get(id) as
      AgentRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  getOrThrow(id: string): AgentRecord {
    const agent = this.get(id);
    if (agent === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No agent with id ${id}.`,
        'Call agent_list to see known agents.'
      );
    }
    return agent;
  }

  findByName(name: string): AgentRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE name = ? AND status = 'active' AND ephemeral = 0`)
      .get(name) as AgentRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** Match a free-text skill query against local agent role, name and instructions. */
  findBySkill(query: string): AgentRecord | undefined {
    const needle = `%${query.toLowerCase()}%`;
    const row = this.db
      .prepare(
        `SELECT * FROM agents
         WHERE status = 'active' AND ephemeral = 0
           AND (lower(role) LIKE ? OR lower(name) LIKE ? OR lower(instructions) LIKE ?)
         ORDER BY id ASC LIMIT 1`
      )
      .get(needle, needle, needle) as AgentRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  list(filter: AgentListFilter = {}): { agents: AgentRecord[]; nextCursor?: string } {
    const where = [`status = 'active'`];
    const params: unknown[] = [];

    if (filter.includeEphemeral !== true) where.push('ephemeral = 0');
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.cursor !== undefined) {
      where.push('id < ?');
      params.push(filter.cursor);
    }

    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);

    const rows = this.db
      .prepare(`SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1) as AgentRow[];

    const page = rows.slice(0, limit).map(toRecord);
    const last = page.at(-1);

    return rows.length > limit && last !== undefined
      ? { agents: page, nextCursor: last.id }
      : { agents: page };
  }
}
