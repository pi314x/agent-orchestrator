import type { Db } from '../db/sqlite.js';
import { OrchestratorError, toErrorPayload, type ErrorPayload } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';
import type { ApprovalStore } from './approvals.js';
import type { ArtifactStore } from './artifacts.js';
import type { GrantStore } from './grants.js';
import { notifyOwner, type WebhookStore } from './webhooks.js';
import type { EventLog } from './events.js';
import { isTerminal, type JobStore } from './jobs.js';
import { resolveAgentTarget, toSnapshot, type AgentRegistry } from './registry.js';
import type { JobScheduler } from './scheduler.js';
import type { RunnerName } from './templates.js';
import { assertResolvable, renderTemplate, templateVariables } from './templating.js';

export type WorkflowStep = {
  id: string;
  instruction: string;
  agentId?: string;
  template?: string;
  skillQuery?: string;
  dependsOn?: string[];
  when?: string;
  retries?: number;
  approval?: boolean;
  outputSchema?: Record<string, unknown>;
  /** Files this step creates or modifies. Unordered steps claiming the same file are rejected. */
  files?: string[];
};

export type WorkflowSpec = {
  name: string;
  inputsSchema?: Record<string, unknown>;
  steps: WorkflowStep[];
};

export const STEP_STATES = [
  'pending',
  'awaiting_approval',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled'
] as const;
export type StepState = (typeof STEP_STATES)[number];

export const RUN_STATES = ['running', 'paused', 'succeeded', 'failed', 'cancelled'] as const;
export type RunState = (typeof RUN_STATES)[number];

export type WorkflowRecord = {
  workflowId: string;
  /** Who defined it; '' in a single-owner deployment. */
  ownerId: string;
  name: string;
  spec: WorkflowSpec;
  createdAt: string;
  updatedAt: string;
};

export type StepRunRecord = {
  stepId: string;
  state: StepState;
  jobId?: string;
  output?: unknown;
  error?: ErrorPayload;
  attempt: number;
  updatedAt: string;
};

export type WorkflowRunRecord = {
  runId: string;
  /** Who started the run; its spawned jobs inherit this, same as spawn_job. */
  ownerId: string;
  workflowId?: string;
  name: string;
  state: RunState;
  inputs: Record<string, unknown>;
  steps: StepRunRecord[];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

/**
 * A dependency that can never produce an output. A step skipped by its `when`
 * condition is deliberately NOT dead — that is a branch the author chose, and
 * the steps after it are meant to run.
 */
function isDeadDependency(dep: StepRunRecord): boolean {
  if (dep.state === 'failed' || dep.state === 'cancelled') return true;
  return dep.state === 'skipped' && dep.error?.code === 'DEPENDENCY_FAILED';
}

const STEP_TERMINAL: ReadonlySet<StepState> = new Set<StepState>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled'
]);

/** Render a step output for the export bundle: prose verbatim, values as JSON. */
function renderExportValue(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
}

/**
 * Structural validation before anything runs: unknown step references and
 * cycles are configuration errors, and finding them at define time is far
 * cheaper than halfway through a run.
 */
export function validateWorkflow(spec: WorkflowSpec): void {
  if (spec.steps.length === 0) {
    throw new OrchestratorError('INVALID_INPUT', 'A workflow needs at least one step.');
  }

  const ids = new Set<string>();
  for (const step of spec.steps) {
    if (ids.has(step.id)) {
      throw new OrchestratorError('INVALID_INPUT', `Duplicate step id "${step.id}".`);
    }
    ids.add(step.id);

    if (step.agentId === undefined && step.template === undefined && step.skillQuery === undefined) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Step "${step.id}" has no target.`,
        'Give it an agentId, a template or a skillQuery.'
      );
    }
  }

  for (const step of spec.steps) {
    if (step.instruction.trim() === '') {
      throw new OrchestratorError('INVALID_INPUT', `Step "${step.id}" has an empty instruction.`);
    }
    if (
      step.retries !== undefined &&
      (!Number.isInteger(step.retries) || step.retries < 0 || step.retries > 5)
    ) {
      throw new OrchestratorError('INVALID_INPUT', `Step "${step.id}" retries must be an integer 0-5.`);
    }
    const deps = new Set(step.dependsOn ?? []);
    if (deps.has(step.id)) {
      throw new OrchestratorError('INVALID_INPUT', `Step "${step.id}" cannot depend on itself.`);
    }
    for (const dep of deps) {
      if (!ids.has(dep)) {
        throw new OrchestratorError('INVALID_INPUT', `Step "${step.id}" depends on unknown step "${dep}".`);
      }
    }
    assertResolvable(step.instruction, ['inputs', 'steps']);
    if (step.when !== undefined) assertResolvable(step.when, ['inputs', 'steps']);

    // templateVars builds `steps` from every step in the run, not just this
    // one's declared dependencies, so {{steps.X...}} resolves whether or not
    // X is actually a dependency — but only a dependency is guaranteed to
    // have already run when this step starts. Reference an independent
    // step's output without depending on it and the render race is silent:
    // when the scheduler happens to start this step first, {{steps.X.output}}
    // is still null, stringifying to an empty substitution with no error
    // anywhere — the same "quietly wrong instead of failing loudly" shape as
    // every other silent-empty-output bug already fixed in this codebase.
    const templates = [step.instruction, ...(step.when !== undefined ? [step.when] : [])];
    for (const path of templates.flatMap(templateVariables)) {
      const [root, referencedStepId] = path.split('.');
      if (root !== 'steps' || referencedStepId === undefined) continue;
      if (!deps.has(referencedStepId)) {
        throw new OrchestratorError(
          'INVALID_INPUT',
          `Step "${step.id}" references {{steps.${referencedStepId}...}} but does not depend on "${referencedStepId}".`,
          `Add "${referencedStepId}" to step "${step.id}"'s dependsOn, or remove the reference — otherwise it is not guaranteed to have run yet.`
        );
      }
    }
  }

  assertAcyclic(spec.steps);
  assertFileOwnership(spec.steps);
}

/**
 * Two steps that may run at the same time must not claim the same file —
 * that is a write/write race neither ordering nor retries can fix. Steps
 * with an ordering edge between them (in either direction) are sequential,
 * so a shared file there is a handoff, not a race.
 */
function assertFileOwnership(steps: readonly WorkflowStep[]): void {
  const filesByStep = new Map<string, Set<string>>();
  for (const step of steps) {
    const files = new Set<string>();
    for (const file of step.files ?? []) {
      const name = file.trim();
      if (name === '') {
        throw new OrchestratorError('INVALID_INPUT', `Step "${step.id}" lists an empty file.`);
      }
      files.add(name);
    }
    filesByStep.set(step.id, files);
  }

  const dependsOn = new Map(steps.map(step => [step.id, step.dependsOn ?? []]));
  // True when `later` transitively depends on `earlier`, i.e. they never run
  // at the same time. BFS with a visited set, so it terminates on any input.
  const orderedBefore = (earlier: string, later: string): boolean => {
    const seen = new Set<string>([later]);
    const stack = [...(dependsOn.get(later) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === earlier) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(dependsOn.get(id) ?? []));
    }
    return false;
  };

  for (let i = 0; i < steps.length; i++) {
    const a = steps[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < steps.length; j++) {
      const b = steps[j];
      if (b === undefined) continue;
      if (orderedBefore(a.id, b.id) || orderedBefore(b.id, a.id)) continue;
      const bFiles = filesByStep.get(b.id) ?? new Set<string>();
      for (const file of filesByStep.get(a.id) ?? []) {
        if (bFiles.has(file)) {
          throw new OrchestratorError(
            'INVALID_INPUT',
            `Steps "${a.id}" and "${b.id}" both claim file "${file}" with no ordering between them.`,
            `Add one to the other's dependsOn, or give them different files.`
          );
        }
      }
    }
  }
}

function assertAcyclic(steps: readonly WorkflowStep[]): void {
  const byId = new Map(steps.map(step => [step.id, step]));
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (id: string, path: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Workflow has a dependency cycle: ${[...path, id].join(' → ')}.`
      );
    }

    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...path, id]);
    visiting.delete(id);
    done.add(id);
  };

  for (const step of steps) visit(step.id, []);
}

/** `when` is falsy for an empty string, "false" or "0" — anything else runs. */
function isTruthy(rendered: string): boolean {
  const value = rendered.trim().toLowerCase();
  return value !== '' && value !== 'false' && value !== '0' && value !== 'null' && value !== 'undefined';
}

type WorkflowRow = {
  id: string;
  owner_id: string;
  name: string;
  spec: string;
  created_at: string;
  updated_at: string;
};
type RunRow = {
  id: string;
  owner_id: string;
  workflow_id: string | null;
  spec: string;
  inputs: string;
  state: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};
type StepRow = {
  step_id: string;
  state: string;
  job_id: string | null;
  output: string | null;
  error: string | null;
  attempt: number;
  updated_at: string;
};

export interface WorkflowEngineDeps {
  db: Db;
  jobs: JobStore;
  scheduler: JobScheduler;
  agents: AgentRegistry;
  approvals: ApprovalStore;
  artifacts: ArtifactStore;
  grants: GrantStore;
  webhooks: WebhookStore;
  webhookAllowedHosts?: readonly string[];
  webhookFetch?: typeof fetch;
  events: EventLog;
  logger: Logger;
  defaultRunner: RunnerName;
}

export class WorkflowEngine {
  private readonly advancing = new Set<string>();
  /** Runs notified while their own pass was mid-flight; see `advance`. */
  private readonly advanceAgain = new Set<string>();

  constructor(private readonly deps: WorkflowEngineDeps) {
    // Every job state change may unblock a step, so re-evaluate live runs.
    // The promise is handed back rather than voided: the scheduler tracks it
    // so `drain` waits for the pass that submits the next step, which used to
    // be guaranteed for free by this listener running synchronously.
    this.deps.scheduler.onChange(() => this.advanceAll());
  }

  /**
   * Fail fast on template names that can never run: unknown names and names
   * disabled by ORCH_DISABLED_TEMPLATES. Both would otherwise surface mid-run
   * from createFromTemplate, after earlier steps already ran and spent budget.
   * agentId targets are deliberately not checked here — confirming another
   * owner's agent id exists would turn define into an existence oracle, and
   * visibility is still enforced at step-start time via resolveAgentTarget.
   */
  /**
   * Check a planner-produced draft against the same rules `define` enforces,
   * before a human reviews it: a draft with a broken dep edge, an unknown
   * template or a file conflict should be caught here, not after
   * workflow_define rejects it. Anything that is not a spec object at all
   * fails closed with its own message rather than a structural crash.
   */
  async validateDraft(draft: unknown): Promise<{ ok: boolean; error?: ErrorPayload }> {
    if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'The planner did not return a workflow spec object.',
          hint: 'Ask for a spec with a name and steps, or draft one by hand for workflow_define.'
        }
      };
    }
    try {
      validateWorkflow(draft as WorkflowSpec);
      await this.assertTargetsResolvable(draft as WorkflowSpec);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: toErrorPayload(error) };
    }
  }

  private async assertTargetsResolvable(spec: WorkflowSpec): Promise<void> {
    for (const step of spec.steps) {
      if (step.template === undefined) continue;
      if (this.deps.agents.isTemplateDisabled(step.template)) {
        throw new OrchestratorError(
          'POLICY_DENIED',
          `Step "${step.id}" uses disabled template "${step.template}".`,
          'Use ORCH_DISABLED_TEMPLATES to re-enable it, or pick another template.'
        );
      }
      if ((await this.deps.agents.resolveTemplate(step.template)) === undefined) {
        throw new OrchestratorError(
          'NOT_FOUND',
          `Step "${step.id}" uses unknown template "${step.template}".`,
          'Call agent_template_list to see the available templates.'
        );
      }
    }
  }

  async define(spec: WorkflowSpec, ownerId = ''): Promise<WorkflowRecord> {
    validateWorkflow(spec);
    await this.assertTargetsResolvable(spec);

    const now = new Date().toISOString();
    // A name is only unique within one owner (idx would reject otherwise),
    // so redefining an existing name must look within that same owner too —
    // never overwrite (or fail on) a different owner's workflow of that name.
    const existing = (await this.deps.db
      .prepare('SELECT id FROM workflows WHERE name = ? AND owner_id = ?')
      .get(spec.name, ownerId)) as { id: string } | undefined;

    const id = existing?.id ?? newId('workflow');

    await this.deps.db
      .prepare(
        `INSERT INTO workflows (id, owner_id, name, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, name) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`
      )
      .run(id, ownerId, spec.name, JSON.stringify(spec), now, now);

    return this.getWorkflowOrThrow(id);
  }

  private toWorkflowRecord(row: WorkflowRow): WorkflowRecord {
    return {
      workflowId: row.id,
      ownerId: row.owner_id,
      name: row.name,
      spec: JSON.parse(row.spec) as WorkflowSpec,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /** Unchecked — for internal use only where the caller already has authority (e.g. a run's own spec). */
  async getWorkflowOrThrow(workflowId: string): Promise<WorkflowRecord> {
    const row = (await this.deps.db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)) as
      WorkflowRow | undefined;
    if (row === undefined) {
      throw new OrchestratorError('NOT_FOUND', `No workflow with id ${workflowId}.`, 'Call workflow_list.');
    }
    return this.toWorkflowRecord(row);
  }

  /**
   * The tool-facing fetch: NOT_FOUND for a workflow belonging to someone
   * else, existence undisclosed — unless its owner shared the definition
   * with the caller via `workflow_share`, which grants read and start
   * access to exactly that grantee. Runs stay private regardless: sharing
   * the spec never shares anyone's history.
   */
  async getVisibleWorkflow(
    workflowId: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<WorkflowRecord> {
    const workflow = await this.getWorkflowOrThrow(workflowId);
    if (
      principal.isAdmin ||
      workflow.ownerId === principal.ownerId ||
      (await this.deps.grants.hasGrant('workflow', workflowId, workflow.ownerId, principal.ownerId))
    ) {
      return workflow;
    }
    throw new OrchestratorError('NOT_FOUND', `No workflow with id ${workflowId}.`, 'Call workflow_list.');
  }

  /**
   * The tool-facing mutation gate: stricter than `getVisibleWorkflow`. A
   * shared definition is readable and startable but writable only by its
   * owner (or an admin) — same shape as AgentRegistry.getManaged, including
   * POLICY_DENIED (not NOT_FOUND) for a grantee, whose ability to see the
   * definition already discloses that it exists.
   */
  async getManagedWorkflow(
    workflowId: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<WorkflowRecord> {
    const workflow = await this.getWorkflowOrThrow(workflowId);
    if (principal.isAdmin || workflow.ownerId === principal.ownerId) return workflow;
    if (await this.deps.grants.hasGrant('workflow', workflowId, workflow.ownerId, principal.ownerId)) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Workflow ${workflowId} was shared with you for use, not for modifying or deleting; only its owner or an admin may do that.`,
        'Ask the owner, or define your own workflow instead.'
      );
    }
    throw new OrchestratorError('NOT_FOUND', `No workflow with id ${workflowId}.`, 'Call workflow_list.');
  }

  /**
   * Share a workflow definition with one named user. Starts pending — the
   * grantee must accept before they can read or start it. Caller must already
   * manage it (owner or admin).
   */
  async share(
    workflowId: string,
    principal: { ownerId: string; isAdmin: boolean },
    granteeId: string
  ): Promise<void> {
    const workflow = await this.getManagedWorkflow(workflowId, principal);
    await this.deps.grants.grant('workflow', workflowId, workflow.ownerId, granteeId);
  }

  /** Revoke a peer share, pending or accepted. Caller must already manage the definition (owner or admin). */
  async unshare(
    workflowId: string,
    principal: { ownerId: string; isAdmin: boolean },
    granteeId: string
  ): Promise<boolean> {
    const workflow = await this.getManagedWorkflow(workflowId, principal);
    return this.deps.grants.revoke('workflow', workflowId, workflow.ownerId, granteeId);
  }

  /** Who a definition has been shared with, with per-grantee status. Caller must already manage it (owner or admin). */
  async listShares(
    workflowId: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<Array<{ granteeId: string; status: 'pending' | 'accepted'; createdAt: string }>> {
    const workflow = await this.getManagedWorkflow(workflowId, principal);
    const grants = await this.deps.grants.listGrantees('workflow', workflowId, workflow.ownerId);
    return grants.map(grant => ({ granteeId: grant.granteeId, status: grant.status, createdAt: grant.createdAt }));
  }

  /** Pending workflow shares addressed to the caller. */
  async listIncoming(principal: { ownerId: string }): Promise<
    Array<{ workflowId: string; ownerId: string; status: 'pending'; createdAt: string }>
  > {
    const grants = await this.deps.grants.listIncoming('workflow', principal.ownerId);
    return grants.map(g => ({ workflowId: g.resourceId, ownerId: g.ownerId, status: 'pending', createdAt: g.createdAt }));
  }

  /** Accept a pending workflow share. Only the named grantee may call this. */
  async acceptShare(workflowId: string, principal: { ownerId: string }): Promise<void> {
    const workflow = await this.getWorkflowOrThrow(workflowId);
    await this.deps.grants.accept('workflow', workflowId, workflow.ownerId, principal.ownerId);
  }

  /** Decline a pending workflow share. Only the named grantee may call this. */
  async rejectShare(workflowId: string, principal: { ownerId: string }): Promise<boolean> {
    const workflow = await this.getWorkflowOrThrow(workflowId);
    return this.deps.grants.reject('workflow', workflowId, workflow.ownerId, principal.ownerId);
  }

  async listWorkflows(limit = 20, ownerId?: string): Promise<WorkflowRecord[]> {
    // A caller's own definitions plus ones a peer explicitly shared — never
    // another owner's private definition otherwise. An admin passes no
    // ownerId at all and gets everything, so this branch never runs for them.
    const where: string[] = [];
    const params: unknown[] = [];
    if (ownerId !== undefined) {
      const granted = await this.deps.grants.listGrantedResourceIds('workflow', ownerId);
      const placeholders = granted.map(() => '?').join(', ');
      where.push(`(owner_id = ?${granted.length > 0 ? ` OR id IN (${placeholders})` : ''})`);
      params.push(ownerId, ...granted);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.deps.db
      .prepare(`SELECT * FROM workflows ${clause} ORDER BY name ASC LIMIT ?`)
      .all(...params, Math.min(Math.max(limit, 1), 100))) as WorkflowRow[];

    return rows.map(row => this.toWorkflowRecord(row));
  }

  async deleteWorkflow(workflowId: string, principal: { ownerId: string; isAdmin: boolean }): Promise<boolean> {
    // Manage-gate, not just visibility: a peer-shared definition is readable
    // by its grantee, but only its owner (or an admin) may delete it.
    // Deleting something you cannot even see must still read as "there was
    // nothing to delete", not silently succeed on someone else's row.
    await this.getManagedWorkflow(workflowId, principal);
    // Runs stay in history; only the definition goes.
    const result = await this.deps.db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);
    return result.changes > 0;
  }

  async start(input: {
    /** Owner of the new run and everything it spawns. Omitted means '' (single-owner). */
    ownerId?: string;
    /** Whether the starting caller is an admin — governs visibility of an existing workflowId. */
    isAdmin?: boolean;
    workflowId?: string;
    spec?: WorkflowSpec;
    inputs?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<WorkflowRunRecord> {
    const principal = { ownerId: input.ownerId ?? '', isAdmin: input.isAdmin ?? false };

    if (input.idempotencyKey !== undefined) {
      // Scoped to the same owner, matching the (owner_id, idempotency_key)
      // index — two different owners choosing the same key string must never
      // hand one of them back the other's run.
      const existing = (await this.deps.db
        .prepare('SELECT id FROM workflow_runs WHERE idempotency_key = ? AND owner_id = ?')
        .get(input.idempotencyKey, principal.ownerId)) as { id: string } | undefined;
      if (existing !== undefined) return this.getRun(existing.id);
    }

    // Visibility-checked: naming an existing workflowId must not reach one
    // that belongs to someone else, the same class of gap resolveAgentTarget
    // had for agentId.
    const workflow =
      input.workflowId === undefined ? undefined : await this.getVisibleWorkflow(input.workflowId, principal);
    const spec = workflow?.spec ?? input.spec;

    if (spec === undefined) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'Provide either workflowId or an inline spec.',
        'Define one first with workflow_define.'
      );
    }
    validateWorkflow(spec);
    await this.assertTargetsResolvable(spec);

    const runId = newId('workflowRun');
    const now = new Date().toISOString();

    await this.deps.db.transaction(async tx => {
      await tx
        .prepare(
          `INSERT INTO workflow_runs (id, owner_id, workflow_id, spec, inputs, state, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`
        )
        .run(
          runId,
          input.ownerId ?? '',
          workflow?.workflowId ?? null,
          JSON.stringify(spec),
          JSON.stringify(input.inputs ?? {}),
          input.idempotencyKey ?? null,
          now,
          now
        );

      const insertStep = tx.prepare(
        `INSERT INTO step_runs (id, run_id, step_id, state, attempt, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`
      );
      for (const step of spec.steps) {
        await insertStep.run(newId('workflowRun'), runId, step.id, now, now);
      }
    });

    await this.deps.events.append({ type: 'workflow.started', runId, payload: { name: spec.name } });
    await this.advance(runId);
    return this.getRun(runId);
  }

  /** Unchecked — for internal use only (advanceOnce, spawning, the idempotency shortcut). */
  async getRun(runId: string): Promise<WorkflowRunRecord> {
    const row = (await this.deps.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId)) as
      RunRow | undefined;
    if (row === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No workflow run with id ${runId}.`,
        'Call workflow_run_list.'
      );
    }

    const spec = JSON.parse(row.spec) as WorkflowSpec;
    const stepRows = (await this.deps.db
      .prepare('SELECT * FROM step_runs WHERE run_id = ?')
      .all(runId)) as StepRow[];

    const byId = new Map(stepRows.map(step => [step.step_id, step]));

    return {
      runId: row.id,
      ownerId: row.owner_id,
      name: spec.name,
      state: row.state as RunState,
      inputs: JSON.parse(row.inputs) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.workflow_id !== null && { workflowId: row.workflow_id }),
      ...(row.finished_at !== null && { finishedAt: row.finished_at }),
      // Spec order, so the caller reads the DAG the way they wrote it.
      steps: spec.steps.map(step => {
        const found = byId.get(step.id);
        return {
          stepId: step.id,
          state: (found?.state ?? 'pending') as StepState,
          attempt: found?.attempt ?? 0,
          updatedAt: found?.updated_at ?? row.updated_at,
          ...(found?.job_id != null && { jobId: found.job_id }),
          ...(found?.output != null && { output: JSON.parse(found.output) }),
          ...(found?.error != null && { error: JSON.parse(found.error) as ErrorPayload })
        };
      })
    };
  }

  /** The tool-facing fetch: NOT_FOUND for a run belonging to someone else, existence undisclosed. */
  async getVisibleRun(
    runId: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<WorkflowRunRecord> {
    const run = await this.getRun(runId);
    if (principal.isAdmin || run.ownerId === principal.ownerId) return run;
    throw new OrchestratorError('NOT_FOUND', `No workflow run with id ${runId}.`, 'Call workflow_run_list.');
  }

  async listRuns(
    filter: { workflowId?: string; state?: RunState; limit?: number; ownerId?: string } = {}
  ): Promise<WorkflowRunRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.ownerId !== undefined) {
      where.push('owner_id = ?');
      params.push(filter.ownerId);
    }
    if (filter.workflowId !== undefined) {
      where.push('workflow_id = ?');
      params.push(filter.workflowId);
    }
    if (filter.state !== undefined) {
      where.push('state = ?');
      params.push(filter.state);
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.deps.db
      .prepare(`SELECT id FROM workflow_runs ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, Math.min(Math.max(filter.limit ?? 20, 1), 100))) as { id: string }[];

    return Promise.all(rows.map(row => this.getRun(row.id)));
  }

  /**
   * `principal` is optional and checked only when given: the tool call site
   * passes it, but the internal nudge after an approval resolves must not —
   * approvals are a shared queue by design (README's Ownership section),
   * so a reviewer resuming a run they do not own is the entire point of a
   * gate, not a bypass of one.
   */
  async control(
    runId: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry_step',
    stepId?: string,
    principal?: { ownerId: string; isAdmin: boolean }
  ): Promise<WorkflowRunRecord> {
    const run = principal === undefined ? await this.getRun(runId) : await this.getVisibleRun(runId, principal);

    switch (action) {
      case 'pause':
        await this.setRunState(runId, 'paused');
        break;

      case 'resume':
        if (run.state === 'paused') await this.setRunState(runId, 'running');
        await this.advance(runId);
        break;

      case 'cancel': {
        for (const step of run.steps) {
          if (step.jobId !== undefined && !STEP_TERMINAL.has(step.state)) {
            await this.deps.scheduler.cancel(step.jobId, 'Workflow run cancelled.');
          }
          if (!STEP_TERMINAL.has(step.state)) await this.setStepState(runId, step.stepId, 'cancelled');
        }
        await this.finishRun(runId, 'cancelled');
        break;
      }

      case 'retry_step': {
        if (stepId === undefined) {
          throw new OrchestratorError('INVALID_INPUT', 'retry_step needs a stepId.');
        }
        const target = run.steps.find(step => step.stepId === stepId);
        if (target === undefined) {
          throw new OrchestratorError('INVALID_INPUT', `Step "${stepId}" is not part of this run.`);
        }
        // A step retried while its job is still running would otherwise
        // orphan that job — it keeps running, still holding a concurrency
        // slot and spending budget, while advance()'s next pass starts a
        // brand new job for the same step right behind it (the row now
        // reads 'pending' with dependencies already satisfied), the
        // original's eventual result silently discarded because job_id no
        // longer points at it. Cancel any live job first, exactly like the
        // 'cancel' action already does for every non-terminal step.
        if (target.jobId !== undefined && !STEP_TERMINAL.has(target.state)) {
          await this.deps.scheduler.cancel(target.jobId, 'Retried by workflow_run_control.');
        }
        await this.deps.db
          .prepare(
            `UPDATE step_runs SET state = 'pending', job_id = NULL, error = NULL, output = NULL, updated_at = ?
             WHERE run_id = ? AND step_id = ?`
          )
          .run(new Date().toISOString(), runId, stepId);
        // Otherwise an approval-gated step that was rejected retries into an
        // instant re-failure: findForStep would keep returning that same old
        // rejected decision forever, since nothing else ever creates a new
        // one once a decision exists. Clearing it here is what lets the step
        // be gated fresh, exactly like a step running for the first time.
        await this.deps.approvals.deleteForStep(runId, stepId);
        await this.setRunState(runId, 'running');
        await this.advance(runId);
        break;
      }
    }

    return this.getRun(runId);
  }

  /**
   * Re-run steps that reported success with nothing to show for it: blank
   * result text and no structured output. A step can land there when its
   * agent called `finish` with no text or the model answered with whitespace
   * — the scheduler flags it with a `job.progress` event, and this is the
   * action that does something about it. Steps with real outputs, failed or
   * running steps are left alone; use retry_step for those. Unlike control(),
   * the principal is always required — nothing legitimately reconciles a run
   * it cannot see.
   */
  async reconcile(
    runId: string,
    stepId: string | undefined,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<{ run: WorkflowRunRecord; reconciled: string[] }> {
    const run = await this.getVisibleRun(runId, principal);

    if (stepId !== undefined && run.steps.every(step => step.stepId !== stepId)) {
      throw new OrchestratorError('INVALID_INPUT', `Step "${stepId}" is not part of this run.`);
    }

    const reconciled: string[] = [];
    for (const target of run.steps) {
      if (stepId !== undefined && target.stepId !== stepId) continue;
      if (!(await this.succeededButEmpty(target))) continue;

      // Same reset as retry_step: the old job is terminal, so there is no
      // live run to cancel — just clear the row so the next advance starts
      // the step fresh, including a fresh approval gate if it has one.
      await this.deps.db
        .prepare(
          `UPDATE step_runs SET state = 'pending', job_id = NULL, error = NULL, output = NULL, updated_at = ?
           WHERE run_id = ? AND step_id = ?`
        )
        .run(new Date().toISOString(), runId, target.stepId);
      await this.deps.approvals.deleteForStep(runId, target.stepId);
      reconciled.push(target.stepId);
    }

    if (reconciled.length > 0) {
      await this.setRunState(runId, 'running');
      await this.advance(runId);
    }

    return { run: await this.getRun(runId), reconciled };
  }

  /**
   * True when the step claims success but its job carries no usable result.
   * A missing job row is not provable either way, so it is left alone —
   * resetting what cannot be inspected would be guessing, not reconciling.
   */
  private async succeededButEmpty(step: StepRunRecord): Promise<boolean> {
    if (step.state !== 'succeeded' || step.jobId === undefined) return false;
    const job = await this.deps.jobs.get(step.jobId);
    if (job === undefined) return false;
    return (job.resultText ?? '').trim() === '' && job.resultStructured === undefined;
  }

  /**
   * Render a run — spec, inputs, per-step states, outputs, errors and
   * durations — into a markdown artifact for archiving or sharing. Large
   * content belongs in the artifact store, never inline in a tool result, so
   * this returns the artifact id rather than the bundle itself. For span
   * timings and the raw event history, trace_get and events_query on the same
   * runId remain the deeper tools.
   */
  async exportRun(
    runId: string,
    principal: { ownerId: string; isAdmin: boolean }
  ): Promise<{ artifactId: string; runId: string; steps: number; sizeBytes: number }> {
    const run = await this.getVisibleRun(runId, principal);
    const spec = await this.specFor(runId);

    const lines = [
      `# Workflow export: ${spec.name}`,
      '',
      `- Run: ${run.runId}`,
      `- State: ${run.state}`,
      ...(run.workflowId !== undefined ? [`- Workflow: ${run.workflowId}`] : []),
      `- Created: ${run.createdAt}`,
      `- Updated: ${run.updatedAt}`,
      ...(run.finishedAt !== undefined ? [`- Finished: ${run.finishedAt}`] : []),
      '',
      '## Inputs',
      '',
      '```json',
      JSON.stringify(run.inputs, null, 2),
      '```',
      '',
      '## Steps',
      ''
    ];

    let index = 0;
    for (const step of run.steps) {
      index += 1;
      let durationLine = '';
      if (step.jobId !== undefined) {
        const durationMs = (await this.deps.jobs.get(step.jobId))?.usage?.durationMs;
        if (durationMs !== undefined) durationLine = `, ${durationMs}ms`;
      }
      lines.push(`### ${index}. ${step.stepId} — ${step.state}`);
      lines.push('');
      lines.push(
        `- Attempt: ${step.attempt}${step.jobId !== undefined ? `, job: ${step.jobId}` : ''}${durationLine}`
      );
      if (step.output !== undefined) {
        lines.push('', '- Output:', '', '```', renderExportValue(step.output), '```');
      }
      if (step.error !== undefined) {
        lines.push('', `- Error: ${step.error.code} — ${step.error.message}`);
      }
      lines.push('');
    }

    lines.push(
      '---',
      '',
      `Exported ${new Date().toISOString()}. Span timings: trace_get { runId: "${run.runId}" }. Raw history: events_query { runId: "${run.runId}" }.`
    );

    const record = await this.deps.artifacts.put({
      ownerId: run.ownerId,
      name: `workflow-${spec.name}-${run.runId}.md`,
      content: lines.join('\n'),
      mimeType: 'text/markdown',
      workflowRunId: runId,
      tags: ['workflow-export']
    });

    return { artifactId: record.artifactId, runId, steps: run.steps.length, sizeBytes: record.sizeBytes };
  }

  private async advanceAll(): Promise<void> {
    const rows = (await this.deps.db
      .prepare(`SELECT id FROM workflow_runs WHERE state IN ('running', 'paused')`)
      .all()) as { id: string }[];
    for (const row of rows) await this.advance(row.id);
  }

  /**
   * Re-evaluate every live run once. For boot: a run whose last job settled
   * without advance ever observing it (a crash in the millisecond window
   * between the job row write and the notification fan-out) otherwise waits
   * for the next unrelated job event to heal it — on an idle deployment,
   * that is never. Idempotent by construction: settling and starting are
   * both guarded (state machine, atomic step claim), so re-running a pass
   * over an already-advancing run changes nothing.
   */
  async resumeAll(): Promise<void> {
    await this.advanceAll();
  }

  /**
   * One pass of the run's state machine. A re-entrant call is not dropped but
   * folded into the pass already running: submitting a job notifies the
   * scheduler, which calls straight back into here, and while `advanceOnce`
   * was synchronous that nested call could safely be ignored because the
   * outer pass had not yet read the state it would have seen. Now that the
   * pass awaits, a dropped notification is a genuinely missed state change —
   * the job that just finished would sit settled with nothing scheduling the
   * step after it. Same shape as the scheduler's own `pump` guard.
   */
  private async advance(runId: string): Promise<void> {
    if (this.advancing.has(runId)) {
      this.advanceAgain.add(runId);
      return;
    }
    this.advancing.add(runId);

    try {
      do {
        this.advanceAgain.delete(runId);
        await this.advanceOnce(runId);
      } while (this.advanceAgain.has(runId));
    } catch (error) {
      this.deps.logger.error({ err: error, runId }, 'workflow advance failed');
    } finally {
      this.advanceAgain.delete(runId);
      this.advancing.delete(runId);
    }
  }

  private async advanceOnce(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled') return;

    const spec = await this.specFor(runId);
    const stepById = new Map(run.steps.map(step => [step.stepId, step]));

    // 1. Settle anything that was running.
    for (const step of run.steps) {
      if (step.state !== 'running' || step.jobId === undefined) continue;

      const definition = spec.steps.find(s => s.id === step.stepId);
      const job = await this.deps.jobs.get(step.jobId);
      if (job === undefined) {
        // The row is gone — pruned after finishing, or deleted out from under
        // a run that never observed the settle. Skipping here wedges the step
        // (and the run) forever: no future event will ever settle it, since
        // the job it waits on no longer exists to change state. Fail loudly
        // instead, through the same retry accounting as any other failure, so
        // a step with attempts left re-runs fresh rather than hanging.
        if (step.attempt <= (definition?.retries ?? 0)) {
          await this.setStepState(runId, step.stepId, 'pending');
        } else {
          await this.setStepState(runId, step.stepId, 'failed', {
            error: {
              code: 'INTERRUPTED',
              message: `Step job ${step.jobId} no longer exists; it may have been pruned before this step settled.`
            }
          });
        }
        continue;
      }
      if (!isTerminal(job.state)) continue;

      if (job.state === 'succeeded') {
        await this.setStepState(runId, step.stepId, 'succeeded', {
          output: job.resultStructured ?? job.resultText ?? null
        });
      } else if (step.attempt <= (definition?.retries ?? 0)) {
        // Another attempt is allowed; put the step back in the queue.
        await this.setStepState(runId, step.stepId, 'pending');
      } else {
        await this.setStepState(runId, step.stepId, 'failed', {
          error: job.error ?? { code: 'RUNNER_FAILED', message: `Step job ended ${job.state}.` }
        });
      }
    }

    // 2. Resolve approval gates.
    for (const step of (await this.getRun(runId)).steps) {
      if (step.state !== 'awaiting_approval') continue;

      const approval = await this.deps.approvals.findPendingForStep(runId, step.stepId);
      if (approval !== undefined) continue;

      // Not list({ limit: 100 }).find(...): that scans the 100 OLDEST
      // approvals system-wide, so once the deployment has ever accumulated
      // more than 100 approval rows, a just-resolved decision for this run
      // falls outside the window and the step hangs in awaiting_approval
      // forever. findForStep is scoped to this exact (runId, stepId).
      const resolved = await this.deps.approvals.findForStep(runId, step.stepId);

      if (resolved?.status === 'approved') {
        await this.setStepState(runId, step.stepId, 'pending');
        await this.setRunState(runId, 'running');
      } else if (resolved?.status === 'rejected') {
        await this.setStepState(runId, step.stepId, 'failed', {
          error: { code: 'POLICY_DENIED', message: resolved.comment ?? 'Rejected by a human reviewer.' }
        });
        await this.setRunState(runId, 'running');
      }
    }

    // 3. Start whatever is now ready.
    const current = await this.getRun(runId);
    if (current.state === 'paused') return;

    for (const definition of spec.steps) {
      const step = stepById.get(definition.id);
      const state = (await this.getRun(runId)).steps.find(s => s.stepId === definition.id)?.state ?? step?.state;
      if (state !== 'pending') continue;

      const deps = definition.dependsOn ?? [];
      const runNow = await this.getRun(runId);
      const depRuns = deps.map(id => runNow.steps.find(s => s.stepId === id));

      // A dependency that died takes this step with it, transitively. Marking
      // the skip with DEPENDENCY_FAILED is what carries the failure down the
      // chain: without it a step two hops below a failure ran anyway, on the
      // empty string its template rendered to.
      const dead = depRuns.find(dep => dep !== undefined && isDeadDependency(dep));

      if (dead !== undefined) {
        await this.setStepState(runId, definition.id, 'skipped', {
          error: {
            code: 'DEPENDENCY_FAILED',
            message: `Step "${dead.stepId}" ${dead.state === 'skipped' ? 'was skipped after its own dependency failed' : dead.state}, so this step cannot run.`
          }
        });
        continue;
      }

      if (!depRuns.every(dep => dep?.state === 'succeeded' || dep?.state === 'skipped')) continue;

      const vars = await this.templateVars(runId);

      if (definition.when !== undefined && !isTruthy(renderTemplate(definition.when, vars))) {
        await this.setStepState(runId, definition.id, 'skipped');
        continue;
      }

      if (definition.approval === true) {
        // A decision already made must not re-gate the step when the run
        // resumes, or approving would simply open a fresh approval.
        const decision = await this.deps.approvals.findForStep(runId, definition.id);

        if (decision === undefined) {
          await this.deps.approvals.create({
            scope: 'workflow_step',
            runId,
            stepId: definition.id,
            summary: `Approve step "${definition.id}" of ${spec.name}?`,
            payload: { instruction: renderTemplate(definition.instruction, vars) }
          });
          await this.setStepState(runId, definition.id, 'awaiting_approval');
          await this.setRunState(runId, 'paused');
          continue;
        }

        if (decision.status === 'pending') {
          await this.setStepState(runId, definition.id, 'awaiting_approval');
          await this.setRunState(runId, 'paused');
          continue;
        }

        if (decision.status === 'rejected') {
          await this.setStepState(runId, definition.id, 'failed', {
            error: { code: 'POLICY_DENIED', message: decision.comment ?? 'Rejected by a human reviewer.' }
          });
          continue;
        }
      }

      await this.startStep(runId, definition, vars, run.ownerId);
    }

    // 4. Close the run out when nothing is left to do.
    const settled = await this.getRun(runId);
    const allTerminal = settled.steps.every(step => STEP_TERMINAL.has(step.state));
    if (!allTerminal) return;

    const failed = settled.steps.some(step => step.state === 'failed');
    await this.finishRun(runId, failed ? 'failed' : 'succeeded');
  }

  private async startStep(
    runId: string,
    definition: WorkflowStep,
    vars: Record<string, unknown>,
    ownerId: string
  ): Promise<void> {
    // Never admin: a step naming an agentId/skillQuery reaches only what the
    // run's own starter could reach — their own agents, or shared ones.
    const agent = await resolveAgentTarget(
      this.deps.agents,
      {
        ...(definition.agentId !== undefined && { agentId: definition.agentId }),
        ...(definition.template !== undefined && { template: definition.template }),
        ...(definition.skillQuery !== undefined && { skillQuery: definition.skillQuery })
      },
      { runner: this.deps.defaultRunner },
      { ownerId, isAdmin: false }
    );

    // Take the step before creating anything, in one guarded statement — the
    // same shape as jobs.claim, and for the same reason. `advanceAll` scans
    // every running workflow on every instance, so two instances routinely
    // reach a pending step together; submitting first and marking the row
    // afterwards let both submit, so the step ran twice (two agent
    // invocations, twice the spend) and step_runs.job_id recorded only the
    // later one, silently discarding the other's result. With two instances
    // that reproduced on every attempt, not occasionally.
    const claimed = (await this.deps.db
      .prepare(
        `UPDATE step_runs
            SET state = 'running', attempt = attempt + 1, updated_at = ?
          WHERE run_id = ? AND step_id = ? AND state = 'pending'
        RETURNING attempt`
      )
      .all(new Date().toISOString(), runId, definition.id)) as { attempt: number }[];

    // Someone else got there first. Their pass owns the step from here.
    if (claimed.length === 0) return;

    // The row now reads `running` with no job_id yet. Nothing settles a step
    // in that state — `advanceOnce` skips any running step whose jobId is
    // undefined — so the gap is safe to cross.
    let job;
    try {
      job = await this.deps.scheduler.submit({
        ownerId,
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction: renderTemplate(definition.instruction, vars),
        context: vars,
        ...(definition.outputSchema !== undefined && { outputSchema: definition.outputSchema })
      });
    } catch (error) {
      // Put the step back exactly as it was, or a failed submit would strand
      // it `running` forever with no job to settle it.
      await this.deps.db
        .prepare(
          `UPDATE step_runs SET state = 'pending', attempt = attempt - 1, updated_at = ?
            WHERE run_id = ? AND step_id = ? AND state = 'running' AND job_id IS NULL`
        )
        .run(new Date().toISOString(), runId, definition.id);
      throw error;
    }

    await this.deps.db
      .prepare(`UPDATE step_runs SET job_id = ?, updated_at = ? WHERE run_id = ? AND step_id = ?`)
      .run(job.id, new Date().toISOString(), runId, definition.id);
  }

  private async templateVars(runId: string): Promise<Record<string, unknown>> {
    const run = await this.getRun(runId);
    const steps: Record<string, unknown> = {};
    for (const step of run.steps) {
      steps[step.stepId] = { output: step.output ?? null, state: step.state };
    }
    return { inputs: run.inputs, steps };
  }

  private async specFor(runId: string): Promise<WorkflowSpec> {
    const row = (await this.deps.db.prepare('SELECT spec FROM workflow_runs WHERE id = ?').get(runId)) as {
      spec: string;
    };
    return JSON.parse(row.spec) as WorkflowSpec;
  }

  private async setStepState(
    runId: string,
    stepId: string,
    state: StepState,
    patch: { output?: unknown; error?: ErrorPayload } = {}
  ): Promise<void> {
    await this.deps.db
      .prepare(
        `UPDATE step_runs SET state = ?, output = COALESCE(?, output), error = COALESCE(?, error), updated_at = ?
         WHERE run_id = ? AND step_id = ?`
      )
      .run(
        state,
        patch.output === undefined ? null : JSON.stringify(patch.output),
        patch.error === undefined ? null : JSON.stringify(patch.error),
        new Date().toISOString(),
        runId,
        stepId
      );
  }

  private async setRunState(runId: string, state: RunState): Promise<void> {
    await this.deps.db
      .prepare('UPDATE workflow_runs SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), runId);
  }

  private async finishRun(runId: string, state: RunState): Promise<void> {
    const now = new Date().toISOString();
    await this.deps.db
      .prepare('UPDATE workflow_runs SET state = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(state, now, now, runId);

    const eventType = state === 'succeeded' ? 'workflow.succeeded' : 'workflow.failed';
    await this.deps.events.append({ type: eventType, runId, payload: { state } });

    // Best-effort like the job path: settlement is recorded, delivery must
    // never fail it. Runs carry their owner, so the owner's hooks — and only
    // those — hear about it.
    const run = await this.getRun(runId);
    await notifyOwner(
      {
        webhooks: this.deps.webhooks,
        fetchImpl: this.deps.webhookFetch,
        allowedHosts: this.deps.webhookAllowedHosts,
        logger: this.deps.logger
      },
      run.ownerId,
      eventType,
      { runId }
    );
  }
}
