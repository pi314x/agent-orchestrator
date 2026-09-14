import { OrchestratorError, toErrorPayload } from '../errors.js';
import { newId } from '../ids.js';
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

/** A reaction to a job state change. May be async; `drain` waits for it. */
export type ChangeListener = () => void | Promise<void>;

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
  /**
   * How often this instance renews its lease on the jobs it is running, and
   * how long a lease may go unrenewed before another instance may take the
   * job back. Defaults below; tests shorten them.
   */
  lease?: { heartbeatMs?: number; expiresAfterMs?: number };
}

/**
 * A lease is renewed every 15 seconds and expires after 60, so an instance has
 * to miss four heartbeats in a row before its work is considered abandoned.
 * The gap is deliberate: reclaiming a job that is merely slow would run it
 * twice, which is the exact failure the atomic claim exists to prevent.
 */
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_LEASE_MS = 60_000;

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
  private readonly listeners = new Set<ChangeListener>();
  /**
   * Reactions to a state change that are still running. A listener used to be
   * synchronous, so by the time `notify` returned every reaction had already
   * finished and `drain` could treat "nothing active, nothing queued" as
   * "everything settled". An async listener (the workflow engine's `advance`)
   * is still in flight at that point, so `drain` has to wait for these too or
   * it reports a run finished while its next step has not even been submitted.
   */
  private readonly reactions = new Set<Promise<void>>();
  private stopped = false;
  /**
   * `pump` used to run start to finish synchronously, so two calls could never
   * interleave. Now that every store read is awaited they can, and two passes
   * reading the same `nextQueued` batch would each fill the concurrency
   * ceiling — overshooting it together. One pass at a time, with a re-run
   * flag for whatever arrived while it was busy, restores that guarantee.
   */
  private pumping = false;
  private pumpAgain = false;
  /**
   * Identifies this process in `jobs.claimed_by`. Random per process on
   * purpose: it must never collide with a sibling's, and a restarted instance
   * is a different owner from the one that died — its abandoned jobs are
   * reclaimed by their expired lease, not by recognising the name.
   */
  private readonly instanceId = newId('instance');
  private leaseTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: SchedulerDeps) {}

  private get heartbeatMs(): number {
    return this.deps.lease?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  private get leaseMs(): number {
    return this.deps.lease?.expiresAfterMs ?? DEFAULT_LEASE_MS;
  }

  async submit(input: CreateJobInput): Promise<JobRecord> {
    assertDepthWithinLimit(input.depth ?? 0, this.deps.maxDepth);

    if (input.idempotencyKey !== undefined) {
      const existing = await this.deps.jobs.findByIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined) return existing;
    }

    const job = await this.deps.jobs.create(input);
    await this.deps.events.append({
      type: 'job.submitted',
      jobId: job.id,
      agentId: job.agentId,
      payload: { instruction: job.instruction, backend: job.backend }
    });

    this.notify();
    this.track(this.pump(), 'scheduler pump failed');
    return job;
  }

  async cancel(jobId: string, reason?: string): Promise<JobRecord> {
    const job = await this.deps.jobs.getOrThrow(jobId);
    if (isTerminal(job.state)) return job;

    const controller = this.active.get(jobId);
    if (controller !== undefined) {
      this.abortReasons.set(jobId, 'cancelled');
      controller.abort();
      return this.deps.jobs.getOrThrow(jobId);
    }

    // Running, but not by us: the AbortController that would stop it lives in
    // another process. Writing `cancelled` onto the row here would not stop
    // anything — the agent would keep working, keep spending, and overwrite
    // the row with its own result. Record the request and let its owner act on
    // it; it picks this up on its next lease tick.
    if (job.state === 'running') {
      await this.deps.jobs.requestCancel(jobId);
      return this.deps.jobs.getOrThrow(jobId);
    }

    const cancelled = await this.deps.jobs.transition(jobId, 'cancelled', {
      error: { code: 'POLICY_DENIED', message: reason ?? 'Cancelled by request.' }
    });
    await this.deps.events.append({ type: 'job.cancelled', jobId, payload: { reason: reason ?? null } });
    this.notify();
    return cancelled;
  }

  async retry(jobId: string): Promise<JobRecord> {
    const job = await this.deps.jobs.transition(jobId, 'queued');
    await this.deps.events.append({ type: 'job.retried', jobId, payload: { attempt: job.attempt } });
    this.notify();
    this.track(this.pump(), 'scheduler pump failed');
    return job;
  }

  /**
   * Kick the queue once, for whatever is already sitting there with nothing
   * to trigger it — recovered jobs after a restart, most notably. `submit`/
   * `retry`/a finished run's `finally` all call the private `pump` on their
   * own; this is the one public entry for "nothing changed, but check anyway".
   */
  start(): void {
    this.startLeaseTimer();
    // One pass immediately, so a restart picks up work whose lease has already
    // expired — and whose owner is therefore definitely gone — without waiting
    // out a first heartbeat interval. It pumps for us when it reclaims
    // anything; pump anyway for whatever was merely left queued.
    this.track(this.renewAndReclaim(), 'scheduler lease tick failed');
    this.track(this.pump(), 'scheduler pump failed');
  }

  /**
   * Renew our own leases, then reclaim whatever nobody is renewing. Both on
   * one timer, so a lone instance still recovers its predecessor's work and a
   * crashed instance's jobs are picked up by a live sibling rather than
   * waiting for that instance to come back — which, behind a load balancer, it
   * may never do.
   */
  private startLeaseTimer(): void {
    if (this.leaseTimer !== undefined) return;

    this.leaseTimer = setInterval(() => {
      this.track(this.renewAndReclaim(), 'scheduler lease tick failed');
    }, this.heartbeatMs);

    // Never hold the process open for a heartbeat.
    this.leaseTimer.unref?.();
  }

  /** One lease tick. Public so a caller can force one without waiting. */
  async renewAndReclaim(): Promise<void> {
    if (this.stopped) return;

    await this.deps.jobs.heartbeat(this.instanceId);

    // Cancellations asked for elsewhere. Only this process holds the
    // AbortController for a job it is running, so this is the one place a
    // remote job_cancel can actually take effect.
    for (const jobId of await this.deps.jobs.cancelRequested(this.instanceId)) {
      const controller = this.active.get(jobId);
      if (controller === undefined) continue;
      this.abortReasons.set(jobId, 'cancelled');
      controller.abort();
    }

    const staleBefore = new Date(Date.now() - this.leaseMs).toISOString();
    const reclaimed = await this.deps.jobs.recoverExpired(staleBefore);

    if (reclaimed.length > 0) {
      this.deps.logger.warn({ jobIds: reclaimed }, 'reclaimed jobs whose owner stopped responding');
      await this.pump();
    }
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolves as soon as the requested jobs settle, or when the deadline passes
   * — whichever comes first. Driven by state-change notifications, never by
   * polling, so tests need no real sleeps.
   */
  async wait(jobIds: readonly string[], mode: WaitMode, timeoutMs: number): Promise<JobRecord[]> {
    const snapshot = (): Promise<JobRecord[]> =>
      Promise.all(jobIds.map(id => this.deps.jobs.getOrThrow(id)));

    const settled = async (): Promise<JobRecord[] | undefined> => {
      const records = await snapshot();
      const done =
        mode === 'all' ? records.every(j => isTerminal(j.state)) : records.some(j => isTerminal(j.state));
      return done ? records : undefined;
    };

    const immediate = await settled();
    if (immediate !== undefined) return immediate;

    return new Promise<JobRecord[]>((resolve, reject) => {
      const cleanups: (() => void)[] = [];
      let finished = false;

      const finish = (records: JobRecord[]): void => {
        // A notification and the deadline can land in the same tick now that
        // the settled() check is async; only the first one counts.
        if (finished) return;
        finished = true;
        for (const cleanup of cleanups) cleanup();
        resolve(records);
      };

      cleanups.push(
        this.onChange(() => {
          void settled().then(
            records => {
              if (records !== undefined) finish(records);
            },
            error => {
              if (finished) return;
              finished = true;
              for (const cleanup of cleanups) cleanup();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          );
        })
      );

      const timer = setTimeout(() => {
        void snapshot().then(finish, () => finish([]));
      }, timeoutMs);
      cleanups.push(() => clearTimeout(timer));
    });
  }

  /**
   * Resolves once nothing is running, nothing is waiting to run, and every
   * reaction to the last state change has settled — the workflow engine's
   * `advance` among them, which is what submits the next step.
   */
  async drain(): Promise<void> {
    for (;;) {
      // Let every in-flight reaction finish first: one of them may be about
      // to submit the next job, which would make "nothing queued" a lie.
      while (this.reactions.size > 0) await Promise.all([...this.reactions]);

      if (this.active.size === 0 && (await this.deps.jobs.countByState('queued')) === 0) {
        if (this.reactions.size === 0) return;
        continue;
      }

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
    if (this.leaseTimer !== undefined) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = undefined;
    }
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
    for (const listener of [...this.listeners]) {
      let result: void | Promise<void>;
      try {
        result = listener();
      } catch (error) {
        this.deps.logger.error({ err: error }, 'scheduler change listener failed');
        continue;
      }
      if (result !== undefined) this.track(result, 'scheduler change listener failed');
    }
  }

  /**
   * Register background work `drain` must wait for. A failure here is the
   * work's own business, not the scheduler's, so it is logged and dropped —
   * but the promise still has to settle or `drain` would hang on it.
   */
  private track(work: Promise<void>, message: string): void {
    const settled = work
      .catch((error: unknown) => {
        this.deps.logger.error({ err: error }, message);
      })
      .finally(() => this.reactions.delete(settled));
    this.reactions.add(settled);
  }

  /** One pass at a time; see the `pumping` field for why. */
  private async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }

    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.pumpOnce();
      } while (this.pumpAgain && !this.stopped);
    } catch (error) {
      this.deps.logger.error({ err: error }, 'scheduler pump failed');
    } finally {
      this.pumping = false;
    }
  }

  private async pumpOnce(): Promise<void> {
    if (this.stopped) return;

    const { unblockable } = await this.deps.jobs.releaseBlocked();
    for (const stuck of unblockable) {
      // Once per job: `pump` runs on every state change, and a job stays
      // unblockable until someone acts on it.
      if (this.reportedUnblockable.has(stuck.job.id)) continue;
      this.reportedUnblockable.add(stuck.job.id);

      const message = `Dependency ${stuck.dependencyId} ${stuck.dependencyState}, so this job cannot start.`;
      this.deps.logger.warn({ jobId: stuck.job.id, dependencyId: stuck.dependencyId }, message);
      await this.deps.events.append({
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

    const globalCap = await this.deps.budgets.maxConcurrentFor('global');
    const ceiling =
      globalCap === undefined ? this.deps.maxConcurrency : Math.min(globalCap, this.deps.maxConcurrency);

    while (this.active.size < ceiling) {
      // Look past the jobs we cannot start: one agent sitting at its own cap
      // must not starve every other agent's queue behind it.
      const queued = await this.deps.jobs.nextQueued(Math.max(this.deps.maxConcurrency * 2, 20));
      const candidates: JobRecord[] = [];
      for (const job of queued) {
        if (this.active.has(job.id)) continue;
        if (await this.hasAgentCapacity(job.agentId)) candidates.push(job);
      }

      // Taking the job is a separate, atomic step: another instance sharing
      // this database may have claimed it between our read and now, and the
      // loser of that race must simply move on to the next candidate.
      let claimed: JobRecord | undefined;
      for (const candidate of candidates) {
        claimed = await this.deps.jobs.claim(candidate.id, this.instanceId);
        if (claimed !== undefined) break;
      }

      if (claimed === undefined) break;

      // `execute` registers the job in `active` before its first await, so the
      // next iteration of this loop never picks the same job twice.
      void this.execute(claimed);
    }
  }

  /** Per-agent `maxConcurrent`, which is a budget rather than a config limit. */
  private async hasAgentCapacity(agentId: string): Promise<boolean> {
    const cap = await this.deps.budgets.maxConcurrentFor('agent', agentId);
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
      await this.deps.events.append({ type: 'job.started', jobId: job.id, agentId: job.agentId });
      this.notify();

      if (job.timeoutSec !== undefined) {
        timer = setTimeout(() => {
          this.abortReasons.set(job.id, 'timed_out');
          controller.abort();
        }, job.timeoutSec * 1000);
      }

      // Caps are checked here, immediately before work starts, so a long
      // fan-out cannot overshoot between its first and last job.
      await this.deps.budgets.assertWithinBudget('global');
      await this.deps.budgets.assertWithinBudget('agent', job.agentId);
      await this.deps.budgets.assertWithinBudget('job', job.id);

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
                isAgentVisible: async agentId => {
                  try {
                    await this.deps.agents.getVisible(agentId, { ownerId: job.ownerId, isAdmin: false });
                    return true;
                  } catch {
                    return false;
                  }
                },
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
            await this.deps.events.append({
              type: 'job.progress',
              jobId: job.id,
              payload: { message: event.message }
            });
            this.notify();
            break;
          case 'artifact':
            // The only channel a runner with no toolkit (the A2A gateway) has
            // to store one — a local agent's own artifact_put writes to the
            // store directly and never goes through a RunnerEvent at all.
            await this.deps.artifacts.put({
              ownerId: job.ownerId,
              name: event.name,
              content: event.content,
              jobId: job.id,
              ...(event.mimeType !== undefined && { mimeType: event.mimeType })
            });
            break;
        }
      }

      await this.deps.jobs.transition(job.id, 'succeeded', {
        resultText: text,
        ...(structured !== undefined && { resultStructured: structured }),
        usage: { ...usage, durationMs: Date.now() - startedAtMs }
      });
      await this.deps.events.append({ type: 'job.succeeded', jobId: job.id, agentId: job.agentId });
    } catch (error) {
      await this.finishFailed(job.id, error, Date.now() - startedAtMs);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.active.delete(job.id);
      const remaining = (this.activeByAgent.get(job.agentId) ?? 1) - 1;
      if (remaining > 0) this.activeByAgent.set(job.agentId, remaining);
      else this.activeByAgent.delete(job.agentId);
      this.abortReasons.delete(job.id);
      this.notify();
      this.track(this.pump(), 'scheduler pump failed');
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

      const server = await pool.get(serverName);
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
  private async spawnChild(parent: JobRecord, input: SpawnJobInput): Promise<{ jobId: string }> {
    // Never admin here: a sub-agent must only ever reach what its own parent's
    // owner could reach — its own agents, or shared ones — never another
    // owner's private agent, no matter which agent is doing the spawning.
    const agent = await resolveAgentTarget(
      this.deps.agents,
      {
        ...(input.agentId !== undefined && { agentId: input.agentId }),
        ...(input.template !== undefined && { template: input.template })
      },
      { runner: this.deps.defaultRunner },
      { ownerId: parent.ownerId, isAdmin: false }
    );

    const child = await this.submit({
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

  private async finishFailed(jobId: string, error: unknown, durationMs: number): Promise<void> {
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
      await this.deps.jobs.transition(jobId, state, { error: payload, usage: { durationMs } });
      await this.deps.events.append({
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
