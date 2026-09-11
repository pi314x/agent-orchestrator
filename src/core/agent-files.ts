import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { OrchestratorError } from '../errors.js';
import { RUNNER_NAMES, type RunnerName } from './templates.js';

export type AgentFileDefinition = {
  name: string;
  role?: string;
  description?: string;
  instructions: string;
  runner?: RunnerName;
  model?: string;
  toolGrants: string[];
  sourcePath: string;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Deliberately a small key/value reader rather than a YAML dependency: agent
 * files are configuration we define, and the richer syntax would only add
 * surface for something to go wrong.
 */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (match === null) return { fields: {}, body: raw.trim() };

  const fields: Record<string, string> = {};

  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');

    if (key !== '') fields[key] = value;
  }

  return { fields, body: raw.slice(match[0].length).trim() };
}

function parseList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(item => item.trim().replace(/^["']|["']$/g, ''))
    .filter(item => item !== '');
}

export function parseAgentFile(contents: string, sourcePath: string): AgentFileDefinition {
  const { fields, body } = parseFrontmatter(contents);
  const name = fields['name'] ?? basename(sourcePath).replace(/\.md$/i, '');

  if (body === '') {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `Agent file ${sourcePath} has no instructions.`,
      'Put the system prompt in the body, below the frontmatter.'
    );
  }

  const runner = fields['runner'];
  if (runner !== undefined && !RUNNER_NAMES.includes(runner as RunnerName)) {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `Agent file ${sourcePath} names an unknown runner "${runner}".`,
      `Use one of: ${RUNNER_NAMES.join(', ')}.`
    );
  }

  return {
    name,
    instructions: body,
    toolGrants: parseList(fields['tools']),
    sourcePath,
    ...(fields['role'] !== undefined && { role: fields['role'] }),
    ...(fields['description'] !== undefined && { description: fields['description'] }),
    ...(runner !== undefined && { runner: runner as RunnerName }),
    ...(fields['model'] !== undefined && { model: fields['model'] })
  };
}

/**
 * Read every `*.md` under `dir` as an agent definition. A missing directory is
 * not an error — most deployments define agents through the API instead.
 */
export function loadAgentFiles(dir: string): AgentFileDefinition[] {
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .filter(entry => entry.toLowerCase().endsWith('.md'))
    .sort()
    .map(entry => {
      const path = join(dir, entry);
      return parseAgentFile(readFileSync(path, 'utf8'), path);
    });
}
