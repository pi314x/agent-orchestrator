import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, toolsForProfile } from '../../src/tools/profiles.js';

describe('tool profiles', () => {
  it('registers each tool name once', async () => {
    const names = TOOL_REGISTRY.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is cumulative: core ⊆ standard ⊆ full', async () => {
    const withA2A = { a2aEnabled: true };
    const core = toolsForProfile('core', withA2A).map(t => t.name);
    const standard = toolsForProfile('standard', withA2A).map(t => t.name);
    const full = toolsForProfile('full', withA2A).map(t => t.name);

    expect(standard).toEqual(expect.arrayContaining(core));
    expect(full).toEqual(expect.arrayContaining(standard));
    expect(full.length).toBe(TOOL_REGISTRY.length);
  });

  it('preserves registry order so tools/list stays deterministic', async () => {
    const order = TOOL_REGISTRY.map(t => t.name);
    const filtered = toolsForProfile('full', { a2aEnabled: true }).map(t => t.name);

    expect(filtered).toEqual(order);
  });

  it('exposes orchestrator_status in every profile', async () => {
    for (const profile of ['core', 'standard', 'full'] as const) {
      expect(toolsForProfile(profile).map(t => t.name)).toContain('orchestrator_status');
    }
  });
});

describe('A2A gating', () => {
  it('hides every interop tool when A2A is disabled', async () => {
    const names = toolsForProfile('full', { a2aEnabled: false }).map(t => t.name);

    expect(names.filter(n => n.startsWith('a2a_'))).toEqual([]);
    expect(names).not.toContain('agent_register');
    expect(names).not.toContain('agent_publish');
  });

  it('exposes the interop tools when A2A is enabled', async () => {
    const names = toolsForProfile('full', { a2aEnabled: true }).map(t => t.name);

    expect(names).toContain('agent_register');
    expect(names).toContain('a2a_card_get');
    expect(names).toContain('agent_publish');
  });

  it('defaults to disabled, so a local deployment stays local', async () => {
    expect(toolsForProfile('full').map(t => t.name)).not.toContain('agent_register');
  });

  it('leaves the local tools untouched either way', async () => {
    const off = toolsForProfile('standard', { a2aEnabled: false }).map(t => t.name);
    const on = toolsForProfile('standard', { a2aEnabled: true }).map(t => t.name);

    for (const name of ['delegate', 'fan_out', 'job_submit', 'workflow_start', 'memory_write']) {
      expect(off).toContain(name);
      expect(on).toContain(name);
    }
  });
});
