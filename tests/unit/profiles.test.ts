import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, toolsForProfile } from '../../src/tools/profiles.js';

describe('tool profiles', () => {
  it('registers each tool name once', () => {
    const names = TOOL_REGISTRY.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is cumulative: core ⊆ standard ⊆ full', () => {
    const core = toolsForProfile('core').map(t => t.name);
    const standard = toolsForProfile('standard').map(t => t.name);
    const full = toolsForProfile('full').map(t => t.name);

    expect(standard).toEqual(expect.arrayContaining(core));
    expect(full).toEqual(expect.arrayContaining(standard));
    expect(full.length).toBe(TOOL_REGISTRY.length);
  });

  it('preserves registry order so tools/list stays deterministic', () => {
    const order = TOOL_REGISTRY.map(t => t.name);
    const filtered = toolsForProfile('full').map(t => t.name);

    expect(filtered).toEqual(order);
  });

  it('exposes orchestrator_status in every profile', () => {
    for (const profile of ['core', 'standard', 'full'] as const) {
      expect(toolsForProfile(profile).map(t => t.name)).toContain('orchestrator_status');
    }
  });
});
