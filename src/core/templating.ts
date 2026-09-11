import { OrchestratorError } from '../errors.js';

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

function lookup(vars: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[segment];
  }, vars);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * `{{name}}` / `{{steps.plan.output}}` substitution for instruction templates.
 * Deliberately not a general expression language — templates are data, and a
 * richer syntax would be one more place for untrusted output to do something
 * surprising.
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, path: string) => stringify(lookup(vars, path)));
}

/** Names referenced by a template, for validating a workflow before it runs. */
export function templateVariables(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map(match => match[1] as string);
}

export function assertResolvable(template: string, available: readonly string[]): void {
  const missing = templateVariables(template)
    .map(name => name.split('.')[0] as string)
    .filter(root => !available.includes(root));

  if (missing.length > 0) {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `Template references unknown variable(s): ${[...new Set(missing)].join(', ')}.`,
      `Available: ${available.join(', ') || 'none'}.`
    );
  }
}
