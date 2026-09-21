import { describe, expect, it } from 'vitest';
import { AgentRegistry, resolveAgentTarget } from '../../src/core/registry.js';
import { BUILTIN_TEMPLATES } from '../../src/core/templates.js';
import { toAgentView } from '../../src/schemas/common.js';
import { migratedDb } from '../helpers.js';

async function registry() {
  const db = await migratedDb();
  return { db, agents: new AgentRegistry(db) };
}

describe('AgentRegistry', () => {
  it('rejects a duplicate persistent name', async () => {
    const { agents, db } = await registry();
    await agents.create({ name: 'coder', instructions: 'code' });

    await expect(agents.create({ name: 'coder', instructions: 'code' })).rejects.toThrow(/already exists/);
    await db.close();
  });

  it('allows many ephemeral agents to share a name shape', async () => {
    const { agents, db } = await registry();
    const a = await agents.createFromTemplate('planner');
    const b = await agents.createFromTemplate('planner');

    expect(a.id).not.toBe(b.id);
    expect(a.ephemeral).toBe(true);
    await db.close();
  });

  it('hides ephemeral agents from the default listing', async () => {
    const { agents, db } = await registry();
    await agents.create({ name: 'keeper', instructions: 'stay' });
    await agents.createFromTemplate('planner');

    expect((await agents.list()).agents.map(a => a.name)).toEqual(['keeper']);
    expect((await agents.list({ includeEphemeral: true })).agents).toHaveLength(2);
    await db.close();
  });

  it('carries the template instructions onto the agent', async () => {
    const { agents, db } = await registry();
    const planner = BUILTIN_TEMPLATES.find(t => t.name === 'planner');

    expect((await agents.createFromTemplate('planner')).instructions).toBe(planner?.instructions);
    await db.close();
  });

  it('patches limits, replacing the previous caps)', async () => {
    const { agents, db } = await registry();
    const created = await agents.create({ name: 'capped', instructions: 'x', limits: { maxSteps: 5 } });

    const updated = await agents.update(created.id, { limits: { timeoutSec: 60 } });
    expect(updated.limits).toEqual({ timeoutSec: 60 });
    expect(updated.instructions).toBe('x');
    await db.close();
  });

  it('rejects an unknown template by name', async () => {
    const { agents, db } = await registry();
    await expect(agents.createFromTemplate('nonexistent')).rejects.toThrow(/No template named/);
    await db.close();
  });

  it('refuses a disabled template', async () => {
    const { agents, db } = await registry();
    agents.setDisabledTemplates(['debugger']);
    await expect(agents.createFromTemplate('debugger')).rejects.toThrow(/disabled by configuration/);
    await db.close();
  });
});

describe('resolveAgentTarget', () => {
  const defaults = { runner: 'mock' as const };
  const admin = { ownerId: '', isAdmin: true };

  it('returns the named agent', async () => {
    const { agents, db } = await registry();
    const created = await agents.create({ name: 'coder', instructions: 'code' });

    expect((await resolveAgentTarget(agents, { agentId: created.id }, defaults, admin)).id).toBe(created.id);
    await db.close();
  });

  it('materializes a template with the configured runner', async () => {
    const { agents, db } = await registry();
    const resolved = await resolveAgentTarget(agents, { template: 'reviewer' }, defaults, admin);

    expect(resolved.ephemeral).toBe(true);
    expect(resolved.runner).toBe('mock');
    await db.close();
  });

  it('matches a skill query against an agent role', async () => {
    const { agents, db } = await registry();
    await agents.create({ name: 'rust-expert', role: 'reviewer', instructions: 'review rust' });

    expect((await resolveAgentTarget(agents, { skillQuery: 'reviewer' }, defaults, admin)).name).toBe(
      'rust-expert'
    );
    await db.close();
  });

  it('reports a skill query that matches nothing', async () => {
    const { agents, db } = await registry();
    await expect(resolveAgentTarget(agents, { skillQuery: 'astrophysics' }, defaults, admin)).rejects.toThrow(
      /No agent matches/
    );
    await db.close();
  });

  it('requires a target', async () => {
    const { agents, db } = await registry();
    await expect(resolveAgentTarget(agents, {}, defaults, admin)).rejects.toThrow(/exactly one of/);
    await db.close();
  });
});

describe('agent enabled flag', () => {
  const user = { ownerId: 'user_amy', isAdmin: false };

  it('creates agents enabled unless asked otherwise', async () => {
    const { agents, db } = await registry();

    expect((await agents.create({ name: 'on', instructions: 'x' })).enabled).toBe(true);
    expect((await agents.create({ name: 'off', instructions: 'x', enabled: false })).enabled).toBe(false);
    await db.close();
  });

  it('toggles enabled through update without touching config', async () => {
    const { agents, db } = await registry();
    const created = await agents.create({ name: 'switch', instructions: 'x' });

    expect((await agents.update(created.id, { enabled: false })).enabled).toBe(false);
    const back = await agents.update(created.id, { enabled: true });
    expect(back.enabled).toBe(true);
    expect(back.instructions).toBe('x');
    await db.close();
  });

  it('refuses to resolve a disabled agent, by id or by skill', async () => {
    const { agents, db } = await registry();
    const created = await agents.create({ name: 'sleeping', instructions: 'review code', enabled: false });
    const defaults = { runner: 'mock' as const };

    await expect(resolveAgentTarget(agents, { agentId: created.id }, defaults, user)).rejects.toThrow(
      /disabled/
    );
    await expect(resolveAgentTarget(agents, { skillQuery: 'review code' }, defaults, user)).rejects.toThrow(
      /disabled/
    );
    await db.close();
  });

  it('still lists and reads disabled agents — visibility is separate from usability', async () => {
    const { agents, db } = await registry();
    const created = await agents.create({ name: 'visible-off', instructions: 'x', enabled: false });

    expect((await agents.list()).agents.map(a => a.name)).toContain('visible-off');
    expect((await agents.getVisible(created.id, user)).enabled).toBe(false);
    expect(toAgentView(created).enabled).toBe(false);
    await db.close();
  });

  it('lands pre-existing rows enabled — the migration default keeps what worked', async () => {
    const db = await migratedDb();
    const agents = new AgentRegistry(db);
    // A row written before migration 19 has no enabled value of its own.
    await db
      .prepare(
        `INSERT INTO agents (id, kind, name, instructions, created_at, updated_at)
         VALUES (?, 'local', 'legacy', 'x', ?, ?)`
      )
      .run('agt_legacy', new Date().toISOString(), new Date().toISOString());

    expect((await agents.getOrThrow('agt_legacy')).enabled).toBe(true);
    await db.close();
  });
});

describe('agent limits round-trip', () => {
  // Regression: agent_create/agent_update accepted limits, but AgentViewSchema
  // never carried the field back out, so an agent's own limits were invisible
  // to its owner through agent_get/agent_list.
  it('returns the limits a caller set, via toAgentView', async () => {
    const { db, agents } = await registry();

    const agent = await agents.create({
      name: 'limited',
      instructions: 'x',
      limits: { maxSteps: 5, timeoutSec: 30, maxCostUsd: 1.5 }
    });

    expect(toAgentView(agent).limits).toEqual({ maxSteps: 5, timeoutSec: 30, maxCostUsd: 1.5 });
    await db.close();
  });
});
