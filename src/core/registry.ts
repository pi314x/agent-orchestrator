import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';
import type { AgentFileDefinition } from './agent-files.js';
import type { AgentSnapshot } from './jobs.js';
import { SINGLE_OWNER } from './principal.js';
import { getTemplate, type AgentTemplate, type RunnerName } from './templates.js';

type AgentTemplateLike = AgentTemplate;

export type AgentKind = 'local' | 'remote';
export type AgentStatus = 'active' | 'deleted';

export type AgentLimits = {
  maxSteps?: number;
  timeoutSec?: number;
  maxCostUsd?: number;
};

export type AgentRecord = {
  id: string;
  /** Who the agent belongs to; '' in a single-owner deployment. */
  ownerId: string;
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
  /** Remote agents only. Each registration owns its own credential. */
  cardId?: string;
  credentialsRef?: string;
  trustLevel?: string;
  endpointUrl?: string;
  /** 'file' when defined by a Markdown file in the repo, 'api' otherwise. */
  source: 'api' | 'file';
  sourcePath?: string;
  createdAt: string;
  updatedAt: string;
};

export interface CreateAgentInput {
  /** Owner of the new agent. Omitted means the single-owner deployment. */
  ownerId?: string;
  kind?: AgentKind;
  name: string;
  role?: string;
  instructions: string;
  runner?: RunnerName;
  model?: string;
  toolGrants?: readonly string[];
  limits?: AgentLimits;
  ephemeral?: boolean;
  cardId?: string;
  credentialsRef?: string;
  trustLevel?: string;
  endpointUrl?: string;
  source?: 'api' | 'file';
  sourcePath?: string;
}

export interface AgentListFilter {
  /** Restrict to one owner; omitted means every owner. */
  ownerId?: string;
  kind?: AgentKind;
  cursor?: string;
  limit?: number;
  includeEphemeral?: boolean;
}

type AgentRow = {
  id: string;
  owner_id: string;
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
  card_id: string | null;
  credentials_ref: string | null;
  trust_level: string | null;
  endpoint_url: string | null;
  source: string;
  source_path: string | null;
  created_at: string;
  updated_at: string;
};

function toRecord(row: AgentRow): AgentRecord {
  const record: AgentRecord = {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind as AgentKind,
    name: row.name,
    instructions: row.instructions,
    toolGrants: JSON.parse(row.tool_grants) as string[],
    limits: JSON.parse(row.limits) as AgentLimits,
    status: row.status as AgentStatus,
    ephemeral: row.ephemeral === 1,
    source: (row.source === 'file' ? 'file' : 'api') as 'api' | 'file',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (row.role !== null) record.role = row.role;
  if (row.runner !== null) record.runner = row.runner as RunnerName;
  if (row.model !== null) record.model = row.model;
  if (row.card_id !== null) record.cardId = row.card_id;
  if (row.credentials_ref !== null) record.credentialsRef = row.credentials_ref;
  if (row.trust_level !== null) record.trustLevel = row.trust_level;
  if (row.endpoint_url !== null) record.endpointUrl = row.endpoint_url;
  if (row.source_path !== null) record.sourcePath = row.source_path;
  return record;
}

export function toSnapshot(agent: AgentRecord): AgentSnapshot {
  return {
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    instructions: agent.instructions,
    ...(agent.role !== undefined && { role: agent.role }),
    ...(agent.toolGrants.length > 0 && { toolGrants: agent.toolGrants }),
    ...(agent.runner !== undefined && { runner: agent.runner }),
    ...(agent.model !== undefined && { model: agent.model }),
    ...(agent.cardId !== undefined && { cardId: agent.cardId }),
    ...(agent.credentialsRef !== undefined && { credentialsRef: agent.credentialsRef }),
    ...(agent.trustLevel !== undefined && { trustLevel: agent.trustLevel }),
    ...(agent.endpointUrl !== undefined && { endpointUrl: agent.endpointUrl })
  };
}

export interface AgentTarget {
  agentId?: string;
  template?: string;
  skillQuery?: string;
}

/** Minimal shape resolveAgentTarget needs; avoids importing Principal's home module twice. */
export type TargetPrincipal = { ownerId: string; isAdmin: boolean };

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
  defaults: TargetDefaults,
  principal: TargetPrincipal
): AgentRecord {
  // Every path a caller can use to name an EXISTING agent must check
  // visibility. Only createFromTemplate (below) makes a fresh one, which
  // needs no check because nothing pre-existing is being reached into.
  if (target.agentId !== undefined) return registry.getVisible(target.agentId, principal);

  if (target.template !== undefined) {
    return registry.createFromTemplate(target.template, {
      runner: defaults.runner,
      ...(defaults.model !== undefined && { model: defaults.model })
    });
  }

  if (target.skillQuery !== undefined) {
    const found = registry.findBySkill(target.skillQuery, principal);
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
  /** Resolves custom templates first, then built-ins. Set by createServices. */
  resolveTemplate: (name: string) => AgentTemplateLike | undefined = getTemplate;

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
           id, owner_id, kind, name, role, instructions, runner, model, tool_grants, limits, status, ephemeral, created_at, updated_at
           , card_id, credentials_ref, trust_level, endpoint_url, source, source_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.ownerId ?? '',
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
        now,
        input.cardId ?? null,
        input.credentialsRef ?? null,
        input.trustLevel ?? null,
        input.endpointUrl ?? null,
        input.source ?? 'api',
        input.sourcePath ?? null
      );

    return this.getOrThrow(id);
  }

  /**
   * Reconcile agents defined by repo files against the database: the files are
   * the source of truth, so edits land and removals disappear. Agents created
   * through the API are never touched.
   */
  syncFromFiles(definitions: readonly AgentFileDefinition[]): {
    created: string[];
    updated: string[];
    removed: string[];
  } {
    const now = new Date().toISOString();
    const created: string[] = [];
    const updated: string[] = [];

    const existing = new Map(
      (
        this.db
          .prepare(`SELECT * FROM agents WHERE source = 'file' AND status = 'active'`)
          .all() as AgentRow[]
      ).map(row => [row.name, toRecord(row)])
    );

    for (const definition of definitions) {
      const current = existing.get(definition.name);

      if (current === undefined) {
        this.create({
          name: definition.name,
          instructions: definition.instructions,
          toolGrants: definition.toolGrants,
          source: 'file',
          sourcePath: definition.sourcePath,
          ...(definition.role !== undefined && { role: definition.role }),
          ...(definition.runner !== undefined && { runner: definition.runner }),
          ...(definition.model !== undefined && { model: definition.model })
        });
        created.push(definition.name);
        continue;
      }

      this.db
        .prepare(
          `UPDATE agents SET role = ?, instructions = ?, runner = ?, model = ?, tool_grants = ?,
             source_path = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          definition.role ?? null,
          definition.instructions,
          definition.runner ?? null,
          definition.model ?? null,
          JSON.stringify(definition.toolGrants),
          definition.sourcePath,
          now,
          current.id
        );

      updated.push(definition.name);
      existing.delete(definition.name);
    }

    // Whatever is left had its file deleted. Soft-delete so job history keeps resolving.
    const removed = [...existing.keys()];
    for (const record of existing.values()) {
      this.db
        .prepare(`UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ?`)
        .run(now, record.id);
    }

    return { created, updated, removed };
  }

  /** Patch a local agent. Running jobs keep their submit-time snapshot. */
  update(
    agentId: string,
    patch: {
      role?: string;
      instructions?: string;
      runner?: RunnerName;
      model?: string;
      toolGrants?: readonly string[];
    }
  ): AgentRecord {
    const agent = this.getOrThrow(agentId);

    if (agent.kind === 'remote') {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'A remote agent is defined by its Agent Card, not by local config.',
        'Re-register it with agent_register to pick up card changes.'
      );
    }

    this.db
      .prepare(
        `UPDATE agents SET role = ?, instructions = ?, runner = ?, model = ?, tool_grants = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.role ?? agent.role ?? null,
        patch.instructions ?? agent.instructions,
        patch.runner ?? agent.runner ?? null,
        patch.model ?? agent.model ?? null,
        JSON.stringify(patch.toolGrants === undefined ? agent.toolGrants : [...patch.toolGrants]),
        new Date().toISOString(),
        agentId
      );

    return this.getOrThrow(agentId);
  }

  /** Soft-delete, so job history keeps resolving the agent it ran on. */
  delete(agentId: string): boolean {
    return (
      this.db
        .prepare(`UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'active'`)
        .run(new Date().toISOString(), agentId).changes > 0
    );
  }

  /** Materialize a built-in template as a throwaway agent for a one-shot job. */
  createFromTemplate(templateName: string, overrides: Partial<CreateAgentInput> = {}): AgentRecord {
    const template = this.resolveTemplate(templateName);
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

  /**
   * Fetch an agent the caller may read or use. `ownerId === SINGLE_OWNER`
   * ('') is the shared-agent sentinel: an admin-created agent with that owner
   * is deliberately visible to everyone, the same way everything is in a
   * single-owner deployment. Not-found rather than denied for a private
   * agent belonging to someone else — existence is information.
   */
  getVisible(agentId: string, principal: { ownerId: string; isAdmin: boolean }): AgentRecord {
    const agent = this.getOrThrow(agentId);
    if (principal.isAdmin || agent.ownerId === principal.ownerId || agent.ownerId === SINGLE_OWNER) {
      return agent;
    }

    throw new OrchestratorError('NOT_FOUND', `No agent with id ${agentId}.`);
  }

  /**
   * Fetch an agent the caller may modify or delete. Stricter than
   * `getVisible`: a shared agent is readable by everyone but writable only by
   * an admin, so there is no owner-match fallback for it here. Refusing with
   * POLICY_DENIED rather than NOT_FOUND for a shared agent is deliberate —
   * the caller can already see it exists via agent_get/agent_list, so
   * pretending otherwise would just be a worse answer.
   */
  getManaged(agentId: string, principal: { ownerId: string; isAdmin: boolean }): AgentRecord {
    const agent = this.getOrThrow(agentId);
    if (principal.isAdmin || agent.ownerId === principal.ownerId) return agent;

    if (agent.ownerId === SINGLE_OWNER) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Agent ${agentId} is a shared agent; only an admin may modify or delete it.`,
        'Ask an operator with the orch:admin scope, or create your own agent instead.'
      );
    }
    throw new OrchestratorError('NOT_FOUND', `No agent with id ${agentId}.`);
  }

  findByName(name: string): AgentRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE name = ? AND status = 'active' AND ephemeral = 0`)
      .get(name) as AgentRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** Match a free-text skill query against local agent role, name and instructions. */
  /** Owner-filtered the same way `list` is: own agents plus shared ones, or everything for an admin. */
  findBySkill(query: string, principal: { ownerId: string; isAdmin: boolean }): AgentRecord | undefined {
    const needle = `%${query.toLowerCase()}%`;
    const where = [
      `status = 'active'`,
      `ephemeral = 0`,
      `(lower(role) LIKE ? OR lower(name) LIKE ? OR lower(instructions) LIKE ?)`
    ];
    const params: unknown[] = [needle, needle, needle];

    if (!principal.isAdmin) {
      where.push('(owner_id = ? OR owner_id = ?)');
      params.push(principal.ownerId, SINGLE_OWNER);
    }

    const row = this.db
      .prepare(`SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT 1`)
      .get(...params) as AgentRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  list(filter: AgentListFilter = {}): { agents: AgentRecord[]; nextCursor?: string } {
    const where = [`status = 'active'`];
    const params: unknown[] = [];

    if (filter.includeEphemeral !== true) where.push('ephemeral = 0');
    // A caller's own agents plus shared ones — never another owner's private
    // agents. An admin passes no ownerId at all (see ownerFilter) and gets
    // everything, so this branch never runs for them.
    if (filter.ownerId !== undefined) {
      where.push('(owner_id = ? OR owner_id = ?)');
      params.push(filter.ownerId, SINGLE_OWNER);
    }
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
