import type { Db } from '../db/sqlite.js';
import { OrchestratorError, type ErrorPayload } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';
import type { ApprovalStore } from './approvals.js';
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
    const deps = new Set(step.dependsOn ?? []);
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
  events: EventLog;
  logger: Logger;
  defaultRunner: RunnerName;
}

export class WorkflowEngine {
  private readonly advancing = new Set<string>();

  constructor(private readonly deps: WorkflowEngineDeps) {
    // Every job state change may unblock a step, so re-evaluate live runs.
    this.deps.scheduler.onChange(() => this.advanceAll());
  }

  define(spec: WorkflowSpec, ownerId = ''): WorkflowRecord {
    validateWorkflow(spec);

    const now = new Date().toISOString();
    // A name is only unique within one owner (idx would reject otherwise),
    // so redefining an existing name must look within that same owner too —
    // never overwrite (or fail on) a different owner's workflow of that name.
    const existing = this.deps.db
      .prepare('SELECT id FROM workflows WHERE name = ? AND owner_id = ?')
      .get(spec.name, ownerId) as { id: string } | undefined;

    const id = existing?.id ?? newId('workflow');

    this.deps.db
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
  getWorkflowOrThrow(workflowId: string): WorkflowRecord {
    const row = this.deps.db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId) as
      WorkflowRow | undefined;
    if (row === undefined) {
      throw new OrchestratorError('NOT_FOUND', `No workflow with id ${workflowId}.`, 'Call workflow_list.');
    }
    return this.toWorkflowRecord(row);
  }

  /** The tool-facing fetch: NOT_FOUND for a workflow belonging to someone else, existence undisclosed. */
  getVisibleWorkflow(workflowId: string, principal: { ownerId: string; isAdmin: boolean }): WorkflowRecord {
    const workflow = this.getWorkflowOrThrow(workflowId);
    if (principal.isAdmin || workflow.ownerId === principal.ownerId) return workflow;
    throw new OrchestratorError('NOT_FOUND', `No workflow with id ${workflowId}.`, 'Call workflow_list.');
  }

  listWorkflows(limit = 20, ownerId?: string): WorkflowRecord[] {
    const where = ownerId === undefined ? '' : 'WHERE owner_id = ?';
    const params = ownerId === undefined ? [] : [ownerId];

    const rows = this.deps.db
      .prepare(`SELECT * FROM workflows ${where} ORDER BY name ASC LIMIT ?`)
      .all(...params, Math.min(Math.max(limit, 1), 100)) as WorkflowRow[];

    return rows.map(row => this.toWorkflowRecord(row));
  }

  deleteWorkflow(workflowId: string, principal: { ownerId: string; isAdmin: boolean }): boolean {
    // Visibility first: deleting something you cannot even see must read as
    // "there was nothing to delete", not silently succeed on someone else's row.
    this.getVisibleWorkflow(workflowId, principal);
    // Runs stay in history; only the definition goes.
    return this.deps.db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId).changes > 0;
  }

  start(input: {
    /** Owner of the new run and everything it spawns. Omitted means '' (single-owner). */
    ownerId?: string;
    /** Whether the starting caller is an admin — governs visibility of an existing workflowId. */
    isAdmin?: boolean;
    workflowId?: string;
    spec?: WorkflowSpec;
    inputs?: Record<string, unknown>;
    idempotencyKey?: string;
  }): WorkflowRunRecord {
    const principal = { ownerId: input.ownerId ?? '', isAdmin: input.isAdmin ?? false };

    if (input.idempotencyKey !== undefined) {
      // Scoped to the same owner, matching the (owner_id, idempotency_key)
      // index — two different owners choosing the same key string must never
      // hand one of them back the other's run.
      const existing = this.deps.db
        .prepare('SELECT id FROM workflow_runs WHERE idempotency_key = ? AND owner_id = ?')
        .get(input.idempotencyKey, principal.ownerId) as { id: string } | undefined;
      if (existing !== undefined) return this.getRun(existing.id);
    }

    // Visibility-checked: naming an existing workflowId must not reach one
    // that belongs to someone else, the same class of gap resolveAgentTarget
    // had for agentId.
    const workflow =
      input.workflowId === undefined ? undefined : this.getVisibleWorkflow(input.workflowId, principal);
    const spec = workflow?.spec ?? input.spec;

    if (spec === undefined) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'Provide either workflowId or an inline spec.',
        'Define one first with workflow_define.'
      );
    }
    validateWorkflow(spec);

    const runId = newId('workflowRun');
    const now = new Date().toISOString();

    const create = this.deps.db.transaction(() => {
      this.deps.db
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

      const insertStep = this.deps.db.prepare(
        `INSERT INTO step_runs (id, run_id, step_id, state, attempt, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`
      );
      for (const step of spec.steps) {
        insertStep.run(newId('workflowRun'), runId, step.id, now, now);
      }
    });

    create();

    this.deps.events.append({ type: 'workflow.started', runId, payload: { name: spec.name } });
    this.advance(runId);
    return this.getRun(runId);
  }

  /** Unchecked — for internal use only (advanceOnce, spawning, the idempotency shortcut). */
  getRun(runId: string): WorkflowRunRecord {
    const row = this.deps.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as
      RunRow | undefined;
    if (row === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No workflow run with id ${runId}.`,
        'Call workflow_run_list.'
      );
    }

    const spec = JSON.parse(row.spec) as WorkflowSpec;
    const stepRows = this.deps.db.prepare('SELECT * FROM step_runs WHERE run_id = ?').all(runId) as StepRow[];

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
  getVisibleRun(runId: string, principal: { ownerId: string; isAdmin: boolean }): WorkflowRunRecord {
    const run = this.getRun(runId);
    if (principal.isAdmin || run.ownerId === principal.ownerId) return run;
    throw new OrchestratorError('NOT_FOUND', `No workflow run with id ${runId}.`, 'Call workflow_run_list.');
  }

  listRuns(
    filter: { workflowId?: string; state?: RunState; limit?: number; ownerId?: string } = {}
  ): WorkflowRunRecord[] {
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
    const rows = this.deps.db
      .prepare(`SELECT id FROM workflow_runs ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params, Math.min(Math.max(filter.limit ?? 20, 1), 100)) as { id: string }[];

    return rows.map(row => this.getRun(row.id));
  }

  /**
   * `principal` is optional and checked only when given: the tool call site
   * passes it, but the internal nudge after an approval resolves must not —
   * approvals are a shared queue by design (README's Ownership section),
   * so a reviewer resuming a run they do not own is the entire point of a
   * gate, not a bypass of one.
   */
  control(
    runId: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry_step',
    stepId?: string,
    principal?: { ownerId: string; isAdmin: boolean }
  ): WorkflowRunRecord {
    const run = principal === undefined ? this.getRun(runId) : this.getVisibleRun(runId, principal);

    switch (action) {
      case 'pause':
        this.setRunState(runId, 'paused');
        break;

      case 'resume':
        if (run.state === 'paused') this.setRunState(runId, 'running');
        this.advance(runId);
        break;

      case 'cancel': {
        for (const step of run.steps) {
          if (step.jobId !== undefined && !STEP_TERMINAL.has(step.state)) {
            this.deps.scheduler.cancel(step.jobId, 'Workflow run cancelled.');
          }
          if (!STEP_TERMINAL.has(step.state)) this.setStepState(runId, step.stepId, 'cancelled');
        }
        this.finishRun(runId, 'cancelled');
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
          this.deps.scheduler.cancel(target.jobId, 'Retried by workflow_run_control.');
        }
        this.deps.db
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
        this.deps.approvals.deleteForStep(runId, stepId);
        this.setRunState(runId, 'running');
        this.advance(runId);
        break;
      }
    }

    return this.getRun(runId);
  }

  private advanceAll(): void {
    const rows = this.deps.db
      .prepare(`SELECT id FROM workflow_runs WHERE state IN ('running', 'paused')`)
      .all() as { id: string }[];
    for (const row of rows) this.advance(row.id);
  }

  /**
   * One pass of the run's state machine. Re-entrant calls are dropped because
   * submitting a job notifies the scheduler, which calls back into here.
   */
  private advance(runId: string): void {
    if (this.advancing.has(runId)) return;
    this.advancing.add(runId);

    try {
      this.advanceOnce(runId);
    } catch (error) {
      this.deps.logger.error({ err: error, runId }, 'workflow advance failed');
    } finally {
      this.advancing.delete(runId);
    }
  }

  private advanceOnce(runId: string): void {
    const run = this.getRun(runId);
    if (run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled') return;

    const spec = this.specFor(runId);
    const stepById = new Map(run.steps.map(step => [step.stepId, step]));

    // 1. Settle anything that was running.
    for (const step of run.steps) {
      if (step.state !== 'running' || step.jobId === undefined) continue;

      const job = this.deps.jobs.get(step.jobId);
      if (job === undefined || !isTerminal(job.state)) continue;

      const definition = spec.steps.find(s => s.id === step.stepId);

      if (job.state === 'succeeded') {
        this.setStepState(runId, step.stepId, 'succeeded', {
          output: job.resultStructured ?? job.resultText ?? null
        });
      } else if (step.attempt <= (definition?.retries ?? 0)) {
        // Another attempt is allowed; put the step back in the queue.
        this.setStepState(runId, step.stepId, 'pending');
      } else {
        this.setStepState(runId, step.stepId, 'failed', {
          error: job.error ?? { code: 'RUNNER_FAILED', message: `Step job ended ${job.state}.` }
        });
      }
    }

    // 2. Resolve approval gates.
    for (const step of this.getRun(runId).steps) {
      if (step.state !== 'awaiting_approval') continue;

      const approval = this.deps.approvals.findPendingForStep(runId, step.stepId);
      if (approval !== undefined) continue;

      // Not list({ limit: 100 }).find(...): that scans the 100 OLDEST
      // approvals system-wide, so once the deployment has ever accumulated
      // more than 100 approval rows, a just-resolved decision for this run
      // falls outside the window and the step hangs in awaiting_approval
      // forever. findForStep is scoped to this exact (runId, stepId).
      const resolved = this.deps.approvals.findForStep(runId, step.stepId);

      if (resolved?.status === 'approved') {
        this.setStepState(runId, step.stepId, 'pending');
        this.setRunState(runId, 'running');
      } else if (resolved?.status === 'rejected') {
        this.setStepState(runId, step.stepId, 'failed', {
          error: { code: 'POLICY_DENIED', message: resolved.comment ?? 'Rejected by a human reviewer.' }
        });
        this.setRunState(runId, 'running');
      }
    }

    // 3. Start whatever is now ready.
    const current = this.getRun(runId);
    if (current.state === 'paused') return;

    for (const definition of spec.steps) {
      const step = stepById.get(definition.id);
      const state = this.getRun(runId).steps.find(s => s.stepId === definition.id)?.state ?? step?.state;
      if (state !== 'pending') continue;

      const deps = definition.dependsOn ?? [];
      const depRuns = deps.map(id => this.getRun(runId).steps.find(s => s.stepId === id));

      // A dependency that died takes this step with it, transitively. Marking
      // the skip with DEPENDENCY_FAILED is what carries the failure down the
      // chain: without it a step two hops below a failure ran anyway, on the
      // empty string its template rendered to.
      const dead = depRuns.find(dep => dep !== undefined && isDeadDependency(dep));

      if (dead !== undefined) {
        this.setStepState(runId, definition.id, 'skipped', {
          error: {
            code: 'DEPENDENCY_FAILED',
            message: `Step "${dead.stepId}" ${dead.state === 'skipped' ? 'was skipped after its own dependency failed' : dead.state}, so this step cannot run.`
          }
        });
        continue;
      }

      if (!depRuns.every(dep => dep?.state === 'succeeded' || dep?.state === 'skipped')) continue;

      const vars = this.templateVars(runId);

      if (definition.when !== undefined && !isTruthy(renderTemplate(definition.when, vars))) {
        this.setStepState(runId, definition.id, 'skipped');
        continue;
      }

      if (definition.approval === true) {
        // A decision already made must not re-gate the step when the run
        // resumes, or approving would simply open a fresh approval.
        const decision = this.deps.approvals.findForStep(runId, definition.id);

        if (decision === undefined) {
          this.deps.approvals.create({
            scope: 'workflow_step',
            runId,
            stepId: definition.id,
            summary: `Approve step "${definition.id}" of ${spec.name}?`,
            payload: { instruction: renderTemplate(definition.instruction, vars) }
          });
          this.setStepState(runId, definition.id, 'awaiting_approval');
          this.setRunState(runId, 'paused');
          continue;
        }

        if (decision.status === 'pending') {
          this.setStepState(runId, definition.id, 'awaiting_approval');
          this.setRunState(runId, 'paused');
          continue;
        }

        if (decision.status === 'rejected') {
          this.setStepState(runId, definition.id, 'failed', {
            error: { code: 'POLICY_DENIED', message: decision.comment ?? 'Rejected by a human reviewer.' }
          });
          continue;
        }
      }

      this.startStep(runId, definition, vars, run.ownerId);
    }

    // 4. Close the run out when nothing is left to do.
    const settled = this.getRun(runId);
    const allTerminal = settled.steps.every(step => STEP_TERMINAL.has(step.state));
    if (!allTerminal) return;

    const failed = settled.steps.some(step => step.state === 'failed');
    this.finishRun(runId, failed ? 'failed' : 'succeeded');
  }

  private startStep(
    runId: string,
    definition: WorkflowStep,
    vars: Record<string, unknown>,
    ownerId: string
  ): void {
    // Never admin: a step naming an agentId/skillQuery reaches only what the
    // run's own starter could reach — their own agents, or shared ones.
    const agent = resolveAgentTarget(
      this.deps.agents,
      {
        ...(definition.agentId !== undefined && { agentId: definition.agentId }),
        ...(definition.template !== undefined && { template: definition.template }),
        ...(definition.skillQuery !== undefined && { skillQuery: definition.skillQuery })
      },
      { runner: this.deps.defaultRunner },
      { ownerId, isAdmin: false }
    );

    const job = this.deps.scheduler.submit({
      ownerId,
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: renderTemplate(definition.instruction, vars),
      context: vars,
      ...(definition.outputSchema !== undefined && { outputSchema: definition.outputSchema })
    });

    const row = this.deps.db
      .prepare('SELECT attempt FROM step_runs WHERE run_id = ? AND step_id = ?')
      .get(runId, definition.id) as { attempt: number };

    this.deps.db
      .prepare(
        `UPDATE step_runs SET state = 'running', job_id = ?, attempt = ?, updated_at = ?
         WHERE run_id = ? AND step_id = ?`
      )
      .run(job.id, row.attempt + 1, new Date().toISOString(), runId, definition.id);
  }

  private templateVars(runId: string): Record<string, unknown> {
    const run = this.getRun(runId);
    const steps: Record<string, unknown> = {};
    for (const step of run.steps) {
      steps[step.stepId] = { output: step.output ?? null, state: step.state };
    }
    return { inputs: run.inputs, steps };
  }

  private specFor(runId: string): WorkflowSpec {
    const row = this.deps.db.prepare('SELECT spec FROM workflow_runs WHERE id = ?').get(runId) as {
      spec: string;
    };
    return JSON.parse(row.spec) as WorkflowSpec;
  }

  private setStepState(
    runId: string,
    stepId: string,
    state: StepState,
    patch: { output?: unknown; error?: ErrorPayload } = {}
  ): void {
    this.deps.db
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

  private setRunState(runId: string, state: RunState): void {
    this.deps.db
      .prepare('UPDATE workflow_runs SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), runId);
  }

  private finishRun(runId: string, state: RunState): void {
    const now = new Date().toISOString();
    this.deps.db
      .prepare('UPDATE workflow_runs SET state = ?, updated_at = ?, finished_at = ? WHERE id = ?')
      .run(state, now, now, runId);

    this.deps.events.append({
      type: state === 'succeeded' ? 'workflow.succeeded' : 'workflow.failed',
      runId,
      payload: { state }
    });
  }
}
