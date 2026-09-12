import { OrchestratorError, toErrorPayload } from '../errors.js';
import type { Logger } from '../logger.js';
import { createAgentToolkit, type DownstreamGrant, type SpawnJobInput } from '../runners/toolkit.js';
import type { McpProxyPool } from '../proxy/pool.js';
import type { RunnerEvent, RunnerRegistry } from '../runners/types.js';
import type { ArtifactStore } from './artifacts.js';
import type { BudgetTracker } from './budget.js';
import type { MessageBus } from './bus.js';
import type { EventLog } from './events.js';
import type { MemoryStore } from './memory.js';
import { resolveAgentTarget, toSnapshot, type AgentRegistry } from './registry.js';
import type { RunnerName } from './templates.js';
import {
  isTerminal,
  type CreateJobInput,
  type JobRecord,
  type JobState,
  type JobUsage,
  type JobStore
} from './jobs.js';
import { assertDepthWithinLimit } from './policy.js';

export type WaitMode = 'any' | 'all';

/** How a run ended when it ended by abort rather than by finishing. */
type AbortReason = 'cancelled' | 'timed_out';

export interface SchedulerDeps {
  jobs: JobStore;
  events: EventLog;
  runners: RunnerRegistry;
  agents: AgentRegistry;
  memory: MemoryStore;
  artifacts: ArtifactStore;
  bus: MessageBus;
  budgets: BudgetTracker;
  logger: Logger;
  maxConcurrency: number;
  maxDepth: number;
  defaultRunner: RunnerName;
  /** Drives jobs whose backend is a2a_remote; absent until M4 is wired. */
  a2aGateway?: RemoteExecutor;
  /** Grants downstream MCP tools to local agents only. */
  proxy?: McpProxyPool;
}

/**
 * The A2A gateway is not a runner (PLAN §9) but exposes the same shape, so the
 * scheduler drives local and remote work through one path.
 */
export interface RemoteExecutor {
  run(input: { job: JobRecord }, signal: AbortSignal): AsyncIterable<RunnerEvent>;
}

export class JobScheduler {
  private readonly active = new Map<string, AbortController>();
  /** Running jobs per agent, for the per-agent `maxConcurrent` budget. */
  private readonly activeByAgent = new Map<string, number>();
  /** Jobs already reported as unblockable, so `pump` warns once, not per tick. */
  private readonly reportedUnblockable = new Set<string>();
  private readonly abortReasons = new Map<string, AbortReason>();
  private readonly listeners = new Set<() => void>();
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  submit(input: CreateJobInput): JobRecord {
    assertDepthWithinLimit(input.depth ?? 0, this.deps.maxDepth);

    if (input.idempotencyKey !== undefined) {
      const existing = this.deps.jobs.findByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) return existing;
    }

    const job = this.deps.jobs.create(input);
    this.deps.events.append({
      type: 'job.submitted',
      jobId: job.id,
      agentId: job.agentId,
      payload: { instruction: job.instruction, backend: job.backend }
    });

    this.notify();
    this.pump();
    return job;
  }

  cancel(jobId: string, reason?: string): JobRecord {
    const job = this.deps.jobs.getOrThrow(jobId);
    if (isTerminal(job.state)) return job;

    const controller = this.active.get(jobId);
    if (controller !== undefined) {
      this.abortReasons.set(jobId, 'cancelled');
      controller.abort();
      return this.deps.jobs.getOrThrow(jobId);
    }

    const cancelled = this.deps.jobs.transition(jobId, 'cancelled', {
      error: { code: 'POLICY_DENIED', message: reason ?? 'Cancelled by request.' }
    });
    this.deps.events.append({ type: 'job.cancelled', jobId, payload: { reason: reason ?? null } });
    this.notify();
    return cancelled;
  }

  retry(jobId: string): JobRecord {
    const job = this.deps.jobs.transition(jobId, 'queued');
    this.deps.events.append({ type: 'job.retried', jobId, payload: { attempt: job.attempt } });
    this.notify();
    this.pump();
    return job;
  }

  /**
   * Kick the queue once, for whatever is already sitting there with nothing
   * to trigger it — recovered jobs after a restart, most notably. `submit`/
   * `retry`/a finished run's `finally` all call the private `pump` on their
   * own; this is the one public entry for "nothing changed, but check anyway".
   */
  start(): void {
    this.pump();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolves as soon as the requested jobs settle, or when the deadline passes
   * — whichever comes first. Driven by state-change notifications, never by
   * polling, so tests need no real sleeps.
   */
  async wait(jobIds: readonly string[], mode: WaitMode, timeoutMs: number): Promise<JobRecord[]> {
    const snapshot = (): JobRecord[] => jobIds.map(id => this.deps.jobs.getOrThrow(id));

    const settled = (): JobRecord[] | undefined => {
      const records = snapshot();
      const done =
        mode === 'all' ? records.every(j => isTerminal(j.state)) : records.some(j => isTerminal(j.state));
      return done ? records : undefined;
    };

    const immediate = settled();
    if (immediate !== undefined) return immediate;

    return new Promise<JobRecord[]>(resolve => {
      const cleanups: (() => void)[] = [];

      const finish = (records: JobRecord[]): void => {
        for (const cleanup of cleanups) cleanup();
        resolve(records);
      };

      cleanups.push(
        this.onChange(() => {
          const records = settled();
          if (records !== undefined) finish(records);
        })
      );

      const timer = setTimeout(() => finish(snapshot()), timeoutMs);
      cleanups.push(() => clearTimeout(timer));
    });
  }

  /** Resolves once nothing is running and nothing is waiting to run. */
  async drain(): Promise<void> {
    while (this.active.size > 0 || this.deps.jobs.countByState('queued') > 0) {
      await new Promise<void>(resolve => {
        const unsubscribe = this.onChange(() => {
          unsubscribe();
          resolve();
        });
      });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const [jobId, controller] of this.active) {
      this.abortReasons.set(jobId, 'cancelled');
      controller.abort();
    }
  }

  /**
   * Stop accepting work and wait for in-flight runs to unwind. Callers must
   * await this before closing the database: an aborted run still writes its
   * outcome on the way out.
   */
  async shutdown(): Promise<void> {
    this.stop();

    while (this.active.size > 0) {
      await new Promise<void>(resolve => {
        const unsubscribe = this.onChange(() => {
          unsubscribe();
          resolve();
        });
      });
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private pump(): void {
    if (this.stopped) return;

    const { unblockable } = this.deps.jobs.releaseBlocked();
    for (const stuck of unblockable) {
      // Once per job: `pump` runs on every state change, and a job stays
      // unblockable until someone acts on it.
      if (this.reportedUnblockable.has(stuck.job.id)) continue;
      this.reportedUnblockable.add(stuck.job.id);

      const message = `Dependency ${stuck.dependencyId} ${stuck.dependencyState}, so this job cannot start.`;
      this.deps.logger.warn({ jobId: stuck.job.id, dependencyId: stuck.dependencyId }, message);
      this.deps.events.append({
        type: 'job.blocked',
        jobId: stuck.job.id,
        agentId: stuck.job.agentId,
        payload: {
          code: 'DEPENDENCY_FAILED',
          message,
          hint: `Retry ${stuck.dependencyId} with job_retry and this job releases on its own, or cancel this one.`
        }
      });
    }
    if (unblockable.length > 0) this.notify();

    const globalCap = this.deps.budgets.maxConcurrentFor('global');
    const ceiling =
      globalCap === undefined ? this.deps.maxConcurrency : Math.min(globalCap, this.deps.maxConcurrency);

    while (this.active.size < ceiling) {
      // Look past the jobs we cannot start: one agent sitting at its own cap
      // must not starve every other agent's queue behind it.
      const candidates = this.deps.jobs
        .nextQueued(Math.max(this.deps.maxConcurrency * 2, 20))
        .filter(job => !this.active.has(job.id) && this.hasAgentCapacity(job.agentId));

      // Taking the job is a separate, atomic step: another instance sharing
      // this database may have claimed it between our read and now, and the
      // loser of that race must simply move on to the next candidate.
      let claimed: JobRecord | undefined;
      for (const candidate of candidates) {
        claimed = this.deps.jobs.claim(candidate.id);
        if (claimed !== undefined) break;
      }

      if (claimed === undefined) break;

      // Runs until its first await, which is past the claim — so the next
      // iteration never picks the same job twice.
      void this.execute(claimed);
    }
  }

  /** Per-agent `maxConcurrent`, which is a budget rather than a config limit. */
  private hasAgentCapacity(agentId: string): boolean {
    const cap = this.deps.budgets.maxConcurrentFor('agent', agentId);
    return cap === undefined || (this.activeByAgent.get(agentId) ?? 0) < cap;
  }

  /** Takes a job this scheduler has already claimed, so it is `running` here. */
  private async execute(job: JobRecord): Promise<void> {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    // Counted here rather than in `pump`, alongside `active`, so the increment
    // and its decrement in `finally` stay in one place. Both run before the
    // first await, which is what stops `pump` picking this job twice.
    this.activeByAgent.set(job.agentId, (this.activeByAgent.get(job.agentId) ?? 0) + 1);

    const startedAtMs = Date.now();
    let timer: NodeJS.Timeout | undefined;

    try {
      this.deps.events.append({ type: 'job.started', jobId: job.id, agentId: job.agentId });
      this.notify();

      if (job.timeoutSec !== undefined) {
        timer = setTimeout(() => {
          this.abortReasons.set(job.id, 'timed_out');
          controller.abort();
        }, job.timeoutSec * 1000);
      }

      // Caps are checked here, immediately before work starts, so a long
      // fan-out cannot overshoot between its first and last job.
      this.deps.budgets.assertWithinBudget('global');
      this.deps.budgets.assertWithinBudget('agent', job.agentId);
      this.deps.budgets.assertWithinBudget('job', job.id);

      const runnerName = job.agentSnapshot.runner ?? this.deps.defaultRunner;
      const runner = job.backend === 'a2a_remote' ? undefined : this.deps.runners.get(runnerName);

      // Ask the runner whether it can work before handing it a job. It already
      // knows why not — "OPENAI_API_KEY is not set" — and that is far more
      // use than whatever a credential-less call to a vendor returns.
      if (runner !== undefined) {
        const health = runner.health();
        if (!health.available) {
          throw new OrchestratorError(
            'RUNNER_FAILED',
            `The ${runnerName} runner is not configured: ${health.reason ?? 'unavailable'}`,
            'Call runner_list to see what each runner needs, or submit against a runner that is ready.'
          );
        }
      }

      // One path, two backends: the gateway and a local runner expose the same
      // `run` shape, so nothing below here knows which one it is talking to.
      const executor: RemoteExecutor | undefined =
        job.backend === 'a2a_remote' ? this.deps.a2aGateway : runner;

      if (executor === undefined) {
        throw new OrchestratorError(
          'RUNNER_FAILED',
          job.backend === 'a2a_remote'
            ? 'The A2A gateway is not enabled.'
            : `No runner named "${runnerName}" is registered.`,
          job.backend === 'a2a_remote'
            ? 'Set A2A_ENABLED=true to delegate to remote agents.'
            : 'Call runner_list to see which runners are available.'
        );
      }

      // Only agents we own get a toolkit; remote A2A agents are opaque and
      // never receive downstream tool grants.
      const downstream = job.backend === 'local' ? await this.resolveGrants(job) : [];

      const toolkit =
        job.backend === 'local'
          ? createAgentToolkit(
              {
                memory: this.deps.memory,
                artifacts: this.deps.artifacts,
                bus: this.deps.bus,
                events: this.deps.events,
                spawnJob: (parent, input) => this.spawnChild(parent, input),
                downstream,
                ...(this.deps.proxy !== undefined && {
                  callDownstream: (server, tool, args) =>
                    (this.deps.proxy as McpProxyPool).call(server, tool, args)
                })
              },
              job
            )
          : undefined;

      let text = '';
      let structured: unknown;
      let usage: JobUsage = {};

      for await (const event of executor.run(
        { job, ...(toolkit !== undefined && { toolkit }) },
        controller.signal
      )) {
        switch (event.type) {
          case 'text':
            text += event.text;
            break;
          case 'structured':
            structured = event.value;
            break;
          case 'usage':
            usage = event.usage;
            break;
          case 'progress':
            this.deps.events.append({
              type: 'job.progress',
              jobId: job.id,
              payload: { message: event.message }
            });
            this.notify();
            break;
        }
      }

      this.deps.jobs.transition(job.id, 'succeeded', {
        resultText: text,
        ...(structured !== undefined && { resultStructured: structured }),
        usage: { ...usage, durationMs: Date.now() - startedAtMs }
      });
      this.deps.events.append({ type: 'job.succeeded', jobId: job.id, agentId: job.agentId });
    } catch (error) {
      this.finishFailed(job.id, error, Date.now() - startedAtMs);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.active.delete(job.id);
      const remaining = (this.activeByAgent.get(job.agentId) ?? 1) - 1;
      if (remaining > 0) this.activeByAgent.set(job.agentId, remaining);
      else this.activeByAgent.delete(job.agentId);
      this.abortReasons.delete(job.id);
      this.notify();
      this.pump();
    }
  }

  /**
   * Expand an agent's `toolGrants` into concrete downstream tools. A grant is
   * either a whole server (`files`) or one tool on it (`files/read_file`); an
   * unreachable server is logged and skipped rather than failing the job.
   */
  private async resolveGrants(job: JobRecord): Promise<DownstreamGrant[]> {
    const grants = job.agentSnapshot.toolGrants ?? [];
    if (grants.length === 0 || this.deps.proxy === undefined) return [];

    const pool = this.deps.proxy;
    const resolved: DownstreamGrant[] = [];

    for (const grant of grants) {
      const [serverName, toolName] = grant.split('/', 2);
      if (serverName === undefined || serverName === '') continue;

      const server = pool.get(serverName);
      if (server === undefined) {
        this.deps.logger.warn({ grant, jobId: job.id }, 'tool grant names an unknown server');
        continue;
      }

      try {
        for (const tool of await pool.tools(serverName)) {
          if (toolName !== undefined && tool.name !== toolName) continue;
          resolved.push({
            server: serverName,
            tool,
            requiresApproval: server.requireApprovalFor.includes(tool.name)
          });
        }
      } catch (error) {
        this.deps.logger.warn({ err: error, grant }, 'could not list tools for a granted server');
      }
    }

    return resolved;
  }

  /** Backs the toolkit's `spawn_job`; depth and budget rules apply as normal. */
  private spawnChild(parent: JobRecord, input: SpawnJobInput): { jobId: string } {
    // Never admin here: a sub-agent must only ever reach what its own parent's
    // owner could reach — its own agents, or shared ones — never another
    // owner's private agent, no matter which agent is doing the spawning.
    const agent = resolveAgentTarget(
      this.deps.agents,
      {
        ...(input.agentId !== undefined && { agentId: input.agentId }),
        ...(input.template !== undefined && { template: input.template })
      },
      { runner: this.deps.defaultRunner },
      { ownerId: parent.ownerId, isAdmin: false }
    );

    const child = this.submit({
      // A child belongs to whoever owns the parent, not to nobody.
      ownerId: parent.ownerId,
      backend: 'local',
      agentId: agent.id,
      agentSnapshot: toSnapshot(agent),
      instruction: input.instruction,
      parentJobId: parent.id,
      depth: parent.depth + 1
    });

    return { jobId: child.id };
  }

  private finishFailed(jobId: string, error: unknown, durationMs: number): void {
    const reason = this.abortReasons.get(jobId);
    const state: JobState =
      reason === 'timed_out' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'failed';

    const payload =
      state === 'timed_out'
        ? { code: 'TIMEOUT' as const, message: 'The job exceeded its timeout.' }
        : state === 'cancelled'
          ? { code: 'POLICY_DENIED' as const, message: 'Cancelled by request.' }
          : toErrorPayload(error);

    try {
      this.deps.jobs.transition(jobId, state, { error: payload, usage: { durationMs } });
      this.deps.events.append({
        type:
          state === 'timed_out' ? 'job.timed_out' : state === 'cancelled' ? 'job.cancelled' : 'job.failed',
        jobId,
        payload: { ...payload }
      });
    } catch (transitionError) {
      this.deps.logger.error({ err: transitionError, jobId }, 'failed to record job outcome');
    }
  }
}
