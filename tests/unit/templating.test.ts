import { describe, expect, it } from 'vitest';
import { assertResolvable, renderTemplate, templateVariables } from '../../src/core/templating.js';

describe('renderTemplate', () => {
  it('substitutes a simple variable', () => {
    expect(renderTemplate('Review {{item}}', { item: 'auth.ts' })).toBe('Review auth.ts');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('Review {{ item }}', { item: 'x' })).toBe('Review x');
  });

  it('resolves a dotted path', () => {
    expect(renderTemplate('Use {{steps.plan.output}}', { steps: { plan: { output: 'the plan' } } })).toBe(
      'Use the plan'
    );
  });

  it('serializes non-string values as JSON', () => {
    expect(renderTemplate('{{item}}', { item: { a: 1 } })).toBe('{"a":1}');
  });

  it('renders a missing variable as empty rather than leaving the placeholder', () => {
    expect(renderTemplate('x{{nope}}y', {})).toBe('xy');
  });

  it('leaves text with no placeholders untouched', () => {
    expect(renderTemplate('plain text', { item: 'x' })).toBe('plain text');
  });
});

describe('templateVariables', () => {
  it('lists every referenced name', () => {
    expect(templateVariables('{{a}} and {{b.c}}')).toEqual(['a', 'b.c']);
  });
});

describe('assertResolvable', () => {
  it('accepts a template whose roots are all available', () => {
    expect(() => assertResolvable('{{inputs.topic}}', ['inputs'])).not.toThrow();
  });

  it('rejects a template referencing an unknown root', () => {
    expect(() => assertResolvable('{{steps.missing}}', ['inputs'])).toThrow(/unknown variable/);
  });
});
