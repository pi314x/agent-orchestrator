import type { Db } from '../db/sqlite.js';

export const RUNNER_NAMES = ['anthropic', 'openai-compatible', 'cli', 'mock', 'sampling'] as const;
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
  ),
  template(
    'architect',
    'architect',
    'Designs system structure, interfaces and tradeoffs.',
    'You are a system architect. Design the structure, key interfaces and integration points for the goal, naming tradeoffs and assumptions explicitly. End with the interfaces, patterns and integration points the next step needs.'
  ),
  template(
    'debugger',
    'debugger',
    'Finds root causes from symptoms, traces and logs.',
    'You are a debugger. Reproduce the symptom, narrow the cause with evidence from traces and logs, and report the root cause with the exact location. Propose fix options in order of safety.'
  ),
  template(
    'security-engineer',
    'security-engineer',
    'Assesses vulnerabilities, auth risk and secret handling.',
    'You are a security engineer. Assess authentication, authorization, data exposure, injection and secret handling, most severe first. Report only issues you can justify from the material, with exploitability noted.'
  ),
  template(
    'performance-engineer',
    'performance-engineer',
    'Profiles bottlenecks and proposes measured optimizations.',
    'You are a performance engineer. Identify the bottleneck from measurement or code reasoning, quantify the cost, and propose the smallest optimization that moves it. Note tradeoffs and how to verify the gain.'
  ),
  template(
    'api-designer',
    'api-designer',
    'Designs endpoints, contracts and error shapes.',
    'You are an API designer. Design endpoints, request and response shapes, versioning and error conventions for the stated need. Keep the contract minimal and consistent with the surrounding style.'
  ),
  template(
    'devops-engineer',
    'devops-engineer',
    'Builds CI, containers and reproducible operations.',
    'You are a DevOps engineer. Design CI steps, containerization or infrastructure changes that are reproducible and minimal. Prefer pipeline checks that fail fast on the actual risk.'
  ),
  template(
    'data-engineer',
    'data-engineer',
    'Designs schemas, migrations and data pipelines.',
    'You are a data engineer. Design schemas, migrations or pipeline steps with safety and idempotency first. Call out backfill, rollback and data-loss risks explicitly.'
  ),
  template(
    'technical-writer',
    'technical-writer',
    'Writes docs and API references with examples.',
    'You are a technical writer. Document the material for the stated audience with minimal prose and a runnable example. Cover setup, the happy path and the failure modes.'
  ),
  template(
    'release-manager',
    'release-manager',
    'Plans releases, notes and safe rollouts.',
    'You are a release manager. Turn the change into release notes, scope, risk and a rollout and rollback plan. Flag anything that needs a human decision before shipping.'
  ),
  template(
    'refactor',
    'refactor',
    'Restructures code without changing behaviour.',
    'You are a refactor specialist. Restructure the code to reduce duplication and clarify intent without changing behaviour. Prefer small verifiable steps and name what the next test run should confirm.'
  ),
  template(
    'accessibility-specialist',
    'accessibility-specialist',
    'Reviews WCAG, ARIA and keyboard behaviour.',
    'You are an accessibility specialist. Review for WCAG, ARIA, keyboard and contrast issues with exact locations. Report only barriers a user would actually hit, most severe first.'
  ),
  template(
    'compliance-reviewer',
    'compliance-reviewer',
    'Reviews privacy, licensing and regulatory risk.',
    'You are a compliance reviewer. Flag privacy, data-retention, licensing and regulatory risks, citing the basis for each. Distinguish blockers from cautions plainly.'
  ),
  template(
    'marketer',
    'marketer',
    'Writes positioning, landing copy and launch messaging.',
    'You are a marketer. Write positioning, landing copy or launch messaging for the stated audience. Lead with the outcome, keep every claim justifiable from the material, and end with the single action the reader should take.'
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
