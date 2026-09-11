import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../src/core/templating.js';
import { closeServices, testServices } from '../helpers.js';
import { toSnapshot } from '../../src/core/registry.js';

describe('memory search hardening', () => {
  const nasty = ['"', '*', 'a OR b', 'NEAR(a b)', 'a AND', '^foo', 'a-b', 'col:val', '()', '""""', 'a*'];

  it.each(nasty)('survives a query of %j', async q => {
    const services = testServices();
    services.memory.write({ namespace: 'n', key: 'k', value: 'hello world' });
    expect(() => services.memory.search({ query: q })).not.toThrow();
    await closeServices(services);
  });
});

describe('template substitution', () => {
  // Regression: lookup walked the prototype chain and stringify returned
  // JSON.stringify's `undefined` for a function, so `{{inputs.toString}}` —
  // which passes validation, since `inputs` is a legitimate root — put the
  // literal text "undefined" into the model's prompt.
  it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'resolves inherited property %s to empty, not to "undefined"',
    name => {
      expect(renderTemplate(`{{inputs.${name}}}`, { inputs: {} })).toBe('');
    }
  );

  it('does not reach JavaScript internals through a bare placeholder', () => {
    expect(renderTemplate('{{__proto__.constructor.name}}', {})).toBe('');
    expect(renderTemplate('{{constructor.name}}', {})).toBe('');
  });

  it('still substitutes a real value that shares a name with a builtin', () => {
    expect(renderTemplate('{{inputs.constructor}}', { inputs: { constructor: 'mine' } })).toBe('mine');
  });

  it('renders an unserialisable value as empty rather than throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(renderTemplate('{{v}}', { v: cyclic })).toBe('');
    expect(renderTemplate('{{v}}', { v: 10n })).toBe('');
  });

  it('does not re-render a placeholder that appeared inside substituted output', () => {
    const rendered = renderTemplate('{{steps.a.output}}', {
      steps: { a: { output: '{{secret}}' } },
      secret: 'leaked'
    });
    expect(rendered).toBe('{{secret}}');
  });

  it('does not let dollar-patterns in substituted output corrupt the result', () => {
    expect(renderTemplate('[{{v}}]', { v: "$'$`$&" })).toBe("[$'$`$&]");
  });
});

describe('artifact storage', () => {
  it('round-trips content with a NUL byte and astral unicode', async () => {
    const services = testServices();
    const content = 'a' + String.fromCharCode(0) + 'b\u{1F600}\r\n<script>';
    const put = services.artifacts.put({ jobId: 'j', name: 'x', content });
    expect(services.artifacts.read(put.artifactId).content).toBe(content);
    await closeServices(services);
  });
});

describe('agent registry', () => {
  it('refuses a duplicate agent name', async () => {
    const services = testServices();
    services.agents.create({ name: 'dup', instructions: 'x' });
    expect(() => services.agents.create({ name: 'dup', instructions: 'y' })).toThrow(/already exists/);
    await closeServices(services);
  });

  it('does not let a skill query with SQL metacharacters break listing', async () => {
    const services = testServices();
    services.agents.create({ name: 'rev', role: 'reviewer', instructions: 'x' });
    for (const q of ["' OR 1=1 --", '%', '_', '\\', '"']) {
      expect(() => services.agents.list({ skillQuery: q } as never)).not.toThrow();
    }
    await closeServices(services);
  });
});

describe('depth limit', () => {
  it('refuses to submit past the configured depth', async () => {
    const services = testServices({ config: { maxDepth: 1 } });
    const agent = services.agents.create({ name: 'a', instructions: 'x', runner: 'mock' });
    expect(() =>
      services.scheduler.submit({
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: 'deep',
        depth: 5
      })
    ).toThrow(/depth/i);
    await closeServices(services);
  });
});
