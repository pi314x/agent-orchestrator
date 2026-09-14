import type { Db } from '../db/sqlite.js';

export const RUNNER_NAMES = ['anthropic', 'openai-compatible', 'cli', 'mock'] as const;
export type RunnerName = (typeof RUNNER_NAMES)[number];

/**
 * The runner an agent gets when nothing names one — every built-in template,
 * every custom template that omits `runner`, and `ORCH_DEFAULT_RUNNER`'s own
 * default. One constant, so the three can never drift apart.
 */
export const DEFAULT_RUNNER: RunnerName = 'openai-compatible';

export type AgentTemplate = {
  name: string;
  role: string;
  description: string;
  instructions: string;
  runner: RunnerName;
};

const template = (name: string, role: string, description: string, instructions: string): AgentTemplate => ({
  name,
  role,
  description,
  instructions,
  runner: DEFAULT_RUNNER
});

export const BUILTIN_TEMPLATES: readonly AgentTemplate[] = [
  template(
    'planner',
    'planner',
    'Breaks a goal into an ordered set of concrete steps.',
    'You are a planner. Break the goal into the smallest set of concrete, independently checkable steps. State assumptions explicitly. Do not carry out the steps yourself.'
  ),
  template(
    'researcher',
    'researcher',
    'Gathers and synthesizes information on a question.',
    'You are a researcher. Gather what is known about the question, separate established fact from inference, and cite the basis for each claim. Say plainly when something is unknown.'
  ),
  template(
    'coder',
    'coder',
    'Writes and modifies code to a specification.',
    'You are a software engineer. Implement exactly what is specified, matching the surrounding conventions. Prefer the smallest correct change. Do not invent requirements.'
  ),
  template(
    'reviewer',
    'reviewer',
    'Reviews work for correctness and risk.',
    'You are a reviewer. Look for correctness bugs, unhandled cases and security risk, most severe first. Report only issues you can justify from the material in front of you.'
  ),
  template(
    'tester',
    'tester',
    'Designs and evaluates tests.',
    'You are a test engineer. Identify the behaviours that must hold, including edge cases and failure modes, and write tests that would actually fail if the behaviour regressed.'
  ),
  template(
    'writer',
    'writer',
    'Produces clear prose for a stated audience.',
    'You are a writer. Write plainly for the stated audience. Lead with what matters, cut anything that does not earn its place, and never pad.'
  ),
  template(
    'critic',
    'critic',
    'Argues against a proposal to surface weaknesses.',
    'You are a critic. Argue against the proposal in good faith: name its weakest assumptions and the conditions under which it fails. Be specific, never merely negative.'
  ),
  template(
    'summarizer',
    'summarizer',
    'Condenses material without losing load-bearing detail.',
    'You are a summarizer. Condense the material, preserving every load-bearing detail, number and caveat. Do not add interpretation of your own.'
  )
] as const;

export function getTemplate(name: string): AgentTemplate | undefined {
  return BUILTIN_TEMPLATES.find(t => t.name === name);
}

export type CustomTemplateSpec = {
  role: string;
  description: string;
  instructions: string;
  runner?: RunnerName;
  model?: string;
};

type TemplateRow = { name: string; spec: string; created_at: string; updated_at: string };

/** Custom templates live in the DB and shadow a built-in of the same name. */
export class TemplateStore {
  constructor(private readonly db: Db) {}

  async save(name: string, spec: CustomTemplateSpec): Promise<AgentTemplate> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO agent_templates (name, spec, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`
      )
      .run(name, JSON.stringify(spec), now, now);

    return { name, runner: DEFAULT_RUNNER, ...spec };
  }

  async get(name: string): Promise<AgentTemplate | undefined> {
    const row = (await this.db.prepare('SELECT * FROM agent_templates WHERE name = ?').get(name)) as
      TemplateRow | undefined;
    if (row === undefined) return undefined;
    const spec = JSON.parse(row.spec) as CustomTemplateSpec;
    return { name: row.name, runner: DEFAULT_RUNNER, ...spec };
  }

  async list(): Promise<AgentTemplate[]> {
    const rows = (await this.db.prepare('SELECT * FROM agent_templates ORDER BY name').all()) as TemplateRow[];
    return rows.map(row => {
      const spec = JSON.parse(row.spec) as CustomTemplateSpec;
      return { name: row.name, runner: DEFAULT_RUNNER, ...spec };
    });
  }

  /** Custom first, so a saved template can replace a built-in by name. */
  async resolve(name: string): Promise<AgentTemplate | undefined> {
    return (await this.get(name)) ?? getTemplate(name);
  }

  async all(): Promise<AgentTemplate[]> {
    const custom = await this.list();
    const names = new Set(custom.map(t => t.name));
    return [...custom, ...BUILTIN_TEMPLATES.filter(t => !names.has(t.name))];
  }
}
