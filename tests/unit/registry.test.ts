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

  it('rejects an unknown template by name', async () => {
    const { agents, db } = await registry();
    await expect(agents.createFromTemplate('nonexistent')).rejects.toThrow(/No template named/);
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
