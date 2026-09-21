import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { GrantStore } from './grants.js';
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
  /** Kill switch: a disabled agent stays visible but runs nothing new. */
  enabled: boolean;
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
  /** Defaults to enabled — except agents synced from repo files, which start disabled. */
  enabled?: boolean;
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
  enabled: number;
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
    enabled: row.enabled === 1,
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
    ...(agent.endpointUrl !== undefined && { endpointUrl: agent.endpointUrl }),
    // Caps ride the snapshot so the scheduler enforces what the agent
    // promised at submit time. Empty stays absent, keeping old-shaped rows
    // identical — and limits were previously accepted, stored and echoed but
    // never read by anything that runs a job.
    ...((agent.limits.maxSteps !== undefined ||
      agent.limits.timeoutSec !== undefined ||
      agent.limits.maxCostUsd !== undefined) && {
      limits: {
        ...(agent.limits.maxSteps !== undefined && { maxSteps: agent.limits.maxSteps }),
        ...(agent.limits.timeoutSec !== undefined && { timeoutSec: agent.limits.timeoutSec }),
        ...(agent.limits.maxCostUsd !== undefined && { maxCostUsd: agent.limits.maxCostUsd })
      }
    })
  };
}

export interface AgentTarget {
  agentId?: string;
  template?: string;
  skillQuery?: string;
}

/** Minimal shape resolveAgentTarget needs; avoids importing Principal's home module twice. */
export type TargetPrincipal = { ownerId: string; isAdmin: boolean };

/**
 * Fail fast on a template name that can never run — unknown or disabled —
 * before the caller spends anything materializing jobs for it. Used where a
 * template is needed without materializing an agent yet (consensus judge,
 * fan_out reduce); resolveAgentTarget/createFromTemplate check the same
 * thing at materialize time for the single-step paths.
 */
export async function assertTemplateUsable(registry: AgentRegistry, template: string): Promise<void> {
  if (registry.isTemplateDisabled(template)) {
    throw new OrchestratorError(
      'POLICY_DENIED',
      `Template "${template}" is disabled by configuration.`,
      'Use ORCH_DISABLED_TEMPLATES to re-enable it, or pick another template.'
    );
  }
  if ((await registry.resolveTemplate(template)) === undefined) {
    throw new OrchestratorError(
      'NOT_FOUND',
      `Template "${template}" does not exist.`,
      'Call agent_template_list to see the available templates.'
    );
  }
}

export interface TargetDefaults {
  runner: RunnerName;
  model?: string;
}

/**
 * A resolved agent must also be switched on. Visibility and usability are
 * deliberately separate checks: a disabled agent stays listed and readable
 * (otherwise nobody could find it to enable it), but running anything on it
 * is refused here — the one choke point every submit path funnels through.
 */
export function assertUsable(agent: AgentRecord): void {
  if (!agent.enabled) {
    throw new OrchestratorError(
      'POLICY_DENIED',
      `Agent ${agent.name} is disabled.`,
      'Enable it with agent_update first — a disabled agent runs nothing new, though jobs already submitted keep going.'
    );
  }
}

/**
 * Resolve what a caller asked for into a concrete agent. `skillQuery` will also
 * match registered remote A2A cards in M4, which is why callers never need to
 * know which backend they landed on.
 */
export async function resolveAgentTarget(
  registry: AgentRegistry,
  target: AgentTarget,
  defaults: TargetDefaults,
  principal: TargetPrincipal
): Promise<AgentRecord> {
  // Every path a caller can use to name an EXISTING agent must check
  // visibility. Only createFromTemplate (below) makes a fresh one, which
  // needs no check because nothing pre-existing is being reached into.
  if (target.agentId !== undefined) {
    const agent = await registry.getVisible(target.agentId, principal);
    assertUsable(agent);
    return agent;
  }

  if (target.template !== undefined) {
    return registry.createFromTemplate(target.template, {
      runner: defaults.runner,
      ...(defaults.model !== undefined && { model: defaults.model })
    });
  }

  if (target.skillQuery !== undefined) {
    const found = await registry.findBySkill(target.skillQuery, principal);
    if (found === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No agent matches the skill query "${target.skillQuery}".`,
        'Create one with agent_create, or pass a template name instead.'
      );
    }
    assertUsable(found);
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
  resolveTemplate: (name: string) => Promise<AgentTemplateLike | undefined> | AgentTemplateLike | undefined =
    getTemplate;

  constructor(
    private readonly db: Db,
    private readonly grants: GrantStore = new GrantStore(db),
    private disabledTemplates: string[] = []
  ) {}

  /** Exclude templates in sensitive repos; assignment by name is refused. */
  setDisabledTemplates(names: string[]): void {
    this.disabledTemplates = [...names];
  }

  isTemplateDisabled(name: string): boolean {
    return this.disabledTemplates.includes(name);
  }

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    const ephemeral = input.ephemeral ?? false;

    if (!ephemeral && (await this.findByName(input.name, input.ownerId ?? '')) !== undefined) {
      throw new OrchestratorError(
        'CONFLICT',
        `An agent named "${input.name}" already exists.`,
        'Pick a different name, or use agent_get to inspect the existing one.'
      );
    }

    const now = new Date().toISOString();
    const id = newId('agent');

    await this.db
      .prepare(
        `INSERT INTO agents (
           id, owner_id, kind, name, role, instructions, runner, model, tool_grants, limits, status, ephemeral, enabled, created_at, updated_at
           , card_id, credentials_ref, trust_level, endpoint_url, source, source_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        (input.enabled ?? true) ? 1 : 0,
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
  async syncFromFiles(definitions: readonly AgentFileDefinition[]): Promise<{
    created: string[];
    updated: string[];
    removed: string[];
  }> {
    const now = new Date().toISOString();
    const created: string[] = [];
    const updated: string[] = [];

    const rows = (await this.db
      .prepare(`SELECT * FROM agents WHERE source = 'file' AND status = 'active'`)
      .all()) as AgentRow[];
    const existing = new Map(rows.map(row => [row.name, toRecord(row)]));

    for (const definition of definitions) {
      let current = existing.get(definition.name);

      if (current === undefined) {
        try {
          await this.create({
            name: definition.name,
            instructions: definition.instructions,
            toolGrants: definition.toolGrants,
            source: 'file',
            // Shipped defaults start switched off — an operator enables what
            // they actually want to run. Updates below never touch the flag,
            // so an explicit enable survives every restart.
            enabled: false,
            sourcePath: definition.sourcePath,
            ...(definition.role !== undefined && { role: definition.role }),
            ...(definition.runner !== undefined && { runner: definition.runner }),
            ...(definition.model !== undefined && { model: definition.model })
          });
          created.push(definition.name);
          continue;
        } catch (error) {
          // Every instance syncs the agents directory at startup, so two
          // starting together both read "not there yet" and both insert. The
          // loser used to die on the way up — a second instance simply could
          // not be started against a fresh database, which rules out a rolling
          // deploy or a scale-up.
          //
          // Losing this race is not a failure: the agent the sibling wrote is
          // the one this file describes. Re-read it and take the update path,
          // so the definition still lands. Anything that is *not* this race
          // leaves the agent missing, and is re-thrown untouched.
          const raced = await this.findByName(definition.name, '');
          if (raced === undefined) throw error;
          current = raced;
        }
      }

      await this.db
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
      await this.db
        .prepare(`UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ?`)
        .run(now, record.id);
    }

    return { created, updated, removed };
  }

  /**
   * Patch a local agent. Running jobs keep their submit-time snapshot, and
   * flipping `enabled` only gates jobs submitted afterwards — work already
   * running is never pulled out from under itself.
   */
  async update(
    agentId: string,
    patch: {
      role?: string;
      instructions?: string;
      runner?: RunnerName;
      model?: string;
      toolGrants?: readonly string[];
      limits?: AgentLimits;
      enabled?: boolean;
    }
  ): Promise<AgentRecord> {
    const agent = await this.getOrThrow(agentId);

    if (agent.kind === 'remote') {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'A remote agent is defined by its Agent Card, not by local config.',
        'Re-register it with agent_register to pick up card changes.'
      );
    }

    await this.db
      .prepare(
        `UPDATE agents SET role = ?, instructions = ?, runner = ?, model = ?, tool_grants = ?, limits = ?,
           enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.role ?? agent.role ?? null,
        patch.instructions ?? agent.instructions,
        patch.runner ?? agent.runner ?? null,
        patch.model ?? agent.model ?? null,
        JSON.stringify(patch.toolGrants === undefined ? agent.toolGrants : [...patch.toolGrants]),
        JSON.stringify(patch.limits ?? agent.limits),
        (patch.enabled ?? agent.enabled) ? 1 : 0,
        new Date().toISOString(),
        agentId
      );

    return this.getOrThrow(agentId);
  }

  /** Soft-delete, so job history keeps resolving the agent it ran on. */
  async delete(agentId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE agents SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(new Date().toISOString(), agentId);
    return result.changes > 0;
  }

  /** Materialize a built-in template as a throwaway agent for a one-shot job. */
  async createFromTemplate(
    templateName: string,
    overrides: Partial<CreateAgentInput> = {}
  ): Promise<AgentRecord> {
    if (this.disabledTemplates.includes(templateName)) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Template "${templateName}" is disabled by configuration.`,
        'Use ORCH_DISABLED_TEMPLATES to re-enable it, or pick another template.'
      );
    }
    const template = await this.resolveTemplate(templateName);
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

  async get(id: string): Promise<AgentRecord | undefined> {
    const row = (await this.db
      .prepare(`SELECT * FROM agents WHERE id = ? AND status = 'active'`)
      .get(id)) as AgentRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async getOrThrow(id: string): Promise<AgentRecord> {
    const agent = await this.get(id);
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
   * single-owner deployment. A private agent is also visible to a caller its
   * owner explicitly granted access to via `agent_share` — peer-to-peer
   * sharing, distinct from the admin-wide sentinel above: nothing is shared
   * by default, a grant row must exist. Not-found rather than denied for
   * anyone else — existence is information.
   */
  async getVisible(agentId: string, principal: { ownerId: string; isAdmin: boolean }): Promise<AgentRecord> {
    const agent = await this.getOrThrow(agentId);
    if (
      principal.isAdmin ||
      agent.ownerId === principal.ownerId ||
      agent.ownerId === SINGLE_OWNER ||
      (await this.grants.hasGrant('agent', agentId, agent.ownerId, principal.ownerId))
    ) {
      return agent;
    }

    throw new OrchestratorError('NOT_FOUND', `No agent with id ${agentId}.`);
  }

  /**
   * Share a private agent with one named user. The share starts pending and
   * confers nothing until the grantee accepts it — the owner sees it as
   * pending meanwhile. Caller must already manage it (owner or admin).
   */
  async share(
    agentId: string,
    principal: { ownerId: string; isAdmin: boolean },
    granteeId: string
  ): Promise<void> {
    const agent = await this.getManaged(agentId, principal);
    await this.grants.grant('agent', agentId, agent.ownerId, granteeId);
  }

  /** Revoke a peer share, pending or accepted. Caller must already manage the agent (owner or admin). */
  async unshare(
    agentId: string,
    principal: { ownerId: string; isAdmin: boolean },
    granteeId: string
  ): Promise<boolean> {
    const agent = await this.getManaged(agentId, principal);
    return this.grants.revoke('agent', agentId, agent.ownerId, granteeId);
  }

  /**
   * Who a private agent has been shared with, with per-grantee status. The
   * sharer sees `pending` until the grantee accepts. Caller must already
   * manage it (owner or admin).
   */
  async listShares(
    agentId: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<Array<{ granteeId: string; status: 'pending' | 'accepted'; createdAt: string }>> {
    const agent = await this.getManaged(agentId, principal);
    const grants = await this.grants.listGrantees('agent', agentId, agent.ownerId);
    return grants.map(g => ({ granteeId: g.granteeId, status: g.status, createdAt: g.createdAt }));
  }

  /** Pending agent shares addressed to the caller — their inbox to accept or reject. */
  async listIncoming(principal: { ownerId: string }): Promise<
    Array<{ agentId: string; ownerId: string; status: 'pending'; createdAt: string }>
  > {
    const grants = await this.grants.listIncoming('agent', principal.ownerId);
    return grants.map(g => ({ agentId: g.resourceId, ownerId: g.ownerId, status: 'pending', createdAt: g.createdAt }));
  }

  /** Accept a pending agent share. Only the named grantee may call this. */
  async acceptShare(agentId: string, principal: { ownerId: string }): Promise<void> {
    const agent = await this.getOrThrow(agentId);
    await this.grants.accept('agent', agentId, agent.ownerId, principal.ownerId);
  }

  /** Decline a pending agent share. Only the named grantee may call this. */
  async rejectShare(agentId: string, principal: { ownerId: string }): Promise<boolean> {
    const agent = await this.getOrThrow(agentId);
    return this.grants.reject('agent', agentId, agent.ownerId, principal.ownerId);
  }

  /**
   * Fetch an agent the caller may modify or delete. Stricter than
   * `getVisible`: a shared or peer-granted agent is readable but writable
   * only by its owner (or an admin), so there is no owner-match fallback for
   * either here. Refusing with POLICY_DENIED rather than NOT_FOUND in both
   * cases is deliberate — the caller can already see the agent exists via
   * agent_get/agent_list/delegate, so pretending otherwise would just be a
   * worse answer, not a safer one.
   */
  async getManaged(agentId: string, principal: { ownerId: string; isAdmin: boolean }): Promise<AgentRecord> {
    const agent = await this.getOrThrow(agentId);
    if (principal.isAdmin || agent.ownerId === principal.ownerId) return agent;

    if (agent.ownerId === SINGLE_OWNER) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Agent ${agentId} is a shared agent; only an admin may modify or delete it.`,
        'Ask an operator with the orch:admin scope, or create your own agent instead.'
      );
    }
    if (await this.grants.hasGrant('agent', agentId, agent.ownerId, principal.ownerId)) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Agent ${agentId} was shared with you for use, not for modifying or deleting; only its owner or an admin may do that.`,
        'Ask the owner, or create your own agent instead.'
      );
    }
    throw new OrchestratorError('NOT_FOUND', `No agent with id ${agentId}.`);
  }

  /** Matches idx_agents_name: unique per owner, not across the deployment. */
  async findByName(name: string, ownerId: string): Promise<AgentRecord | undefined> {
    const row = (await this.db
      .prepare(`SELECT * FROM agents WHERE name = ? AND owner_id = ? AND status = 'active' AND ephemeral = 0`)
      .get(name, ownerId)) as AgentRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Match a free-text skill query against local agent role, name and
   * instructions. Owner-filtered the same way `list` is: own agents plus
   * shared ones (admin-wide or peer-granted), or everything for an admin.
   */
  async findBySkill(
    query: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<AgentRecord | undefined> {
    const needle = `%${query.toLowerCase()}%`;
    const where = [
      `status = 'active'`,
      `ephemeral = 0`,
      `(lower(role) LIKE ? OR lower(name) LIKE ? OR lower(instructions) LIKE ?)`
    ];
    const params: unknown[] = [needle, needle, needle];

    if (!principal.isAdmin) {
      const granted = await this.grants.listGrantedResourceIds('agent', principal.ownerId);
      const placeholders = granted.map(() => '?').join(', ');
      where.push(`(owner_id = ? OR owner_id = ?${granted.length > 0 ? ` OR id IN (${placeholders})` : ''})`);
      params.push(principal.ownerId, SINGLE_OWNER, ...granted);
    }

    const row = (await this.db
      .prepare(`SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT 1`)
      .get(...params)) as AgentRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async list(filter: AgentListFilter = {}): Promise<{ agents: AgentRecord[]; nextCursor?: string }> {
    const where = [`status = 'active'`];
    const params: unknown[] = [];

    if (filter.includeEphemeral !== true) where.push('ephemeral = 0');
    // A caller's own agents, admin-wide shared ones, and ones a peer
    // explicitly granted — never another owner's private agent otherwise. An
    // admin passes no ownerId at all (see ownerFilter) and gets everything,
    // so this branch never runs for them.
    if (filter.ownerId !== undefined) {
      const granted = await this.grants.listGrantedResourceIds('agent', filter.ownerId);
      const placeholders = granted.map(() => '?').join(', ');
      where.push(`(owner_id = ? OR owner_id = ?${granted.length > 0 ? ` OR id IN (${placeholders})` : ''})`);
      params.push(filter.ownerId, SINGLE_OWNER, ...granted);
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

    const rows = (await this.db
      .prepare(`SELECT * FROM agents WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1)) as AgentRow[];

    const page = rows.slice(0, limit).map(toRecord);
    const last = page.at(-1);

    return rows.length > limit && last !== undefined
      ? { agents: page, nextCursor: last.id }
      : { agents: page };
  }
}
