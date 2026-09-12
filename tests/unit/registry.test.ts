import { describe, expect, it } from 'vitest';
import { AgentRegistry, resolveAgentTarget } from '../../src/core/registry.js';
import { BUILTIN_TEMPLATES } from '../../src/core/templates.js';
import { toAgentView } from '../../src/schemas/common.js';
import { migratedDb } from '../helpers.js';

function registry() {
  const db = migratedDb();
  return { db, agents: new AgentRegistry(db) };
}

describe('AgentRegistry', () => {
  it('rejects a duplicate persistent name', () => {
    const { agents, db } = registry();
    agents.create({ name: 'coder', instructions: 'code' });

    expect(() => agents.create({ name: 'coder', instructions: 'code' })).toThrow(/already exists/);
    db.close();
  });

  it('allows many ephemeral agents to share a name shape', () => {
    const { agents, db } = registry();
    const a = agents.createFromTemplate('planner');
    const b = agents.createFromTemplate('planner');

    expect(a.id).not.toBe(b.id);
    expect(a.ephemeral).toBe(true);
    db.close();
  });

  it('hides ephemeral agents from the default listing', () => {
    const { agents, db } = registry();
    agents.create({ name: 'keeper', instructions: 'stay' });
    agents.createFromTemplate('planner');

    expect(agents.list().agents.map(a => a.name)).toEqual(['keeper']);
    expect(agents.list({ includeEphemeral: true }).agents).toHaveLength(2);
    db.close();
  });

  it('carries the template instructions onto the agent', () => {
    const { agents, db } = registry();
    const planner = BUILTIN_TEMPLATES.find(t => t.name === 'planner');

    expect(agents.createFromTemplate('planner').instructions).toBe(planner?.instructions);
    db.close();
  });

  it('rejects an unknown template by name', () => {
    const { agents, db } = registry();
    expect(() => agents.createFromTemplate('nonexistent')).toThrow(/No template named/);
    db.close();
  });
});

describe('resolveAgentTarget', () => {
  const defaults = { runner: 'mock' as const };
  const admin = { ownerId: '', isAdmin: true };

  it('returns the named agent', () => {
    const { agents, db } = registry();
    const created = agents.create({ name: 'coder', instructions: 'code' });

    expect(resolveAgentTarget(agents, { agentId: created.id }, defaults, admin).id).toBe(created.id);
    db.close();
  });

  it('materializes a template with the configured runner', () => {
    const { agents, db } = registry();
    const resolved = resolveAgentTarget(agents, { template: 'reviewer' }, defaults, admin);

    expect(resolved.ephemeral).toBe(true);
    expect(resolved.runner).toBe('mock');
    db.close();
  });

  it('matches a skill query against an agent role', () => {
    const { agents, db } = registry();
    agents.create({ name: 'rust-expert', role: 'reviewer', instructions: 'review rust' });

    expect(resolveAgentTarget(agents, { skillQuery: 'reviewer' }, defaults, admin).name).toBe('rust-expert');
    db.close();
  });

  it('reports a skill query that matches nothing', () => {
    const { agents, db } = registry();
    expect(() => resolveAgentTarget(agents, { skillQuery: 'astrophysics' }, defaults, admin)).toThrow(
      /No agent matches/
    );
    db.close();
  });

  it('requires a target', () => {
    const { agents, db } = registry();
    expect(() => resolveAgentTarget(agents, {}, defaults, admin)).toThrow(/exactly one of/);
    db.close();
  });
});

describe('agent limits round-trip', () => {
  // Regression: agent_create/agent_update accepted limits, but AgentViewSchema
  // never carried the field back out, so an agent's own limits were invisible
  // to its owner through agent_get/agent_list.
  it('returns the limits a caller set, via toAgentView', () => {
    const { db, agents } = registry();

    const agent = agents.create({
      name: 'limited',
      instructions: 'x',
      limits: { maxSteps: 5, timeoutSec: 30, maxCostUsd: 1.5 }
    });

    expect(toAgentView(agent).limits).toEqual({ maxSteps: 5, timeoutSec: 30, maxCostUsd: 1.5 });
    db.close();
  });
});
