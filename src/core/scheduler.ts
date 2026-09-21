import { OrchestratorError, toErrorPayload } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';
import {
  createAgentToolkit,
  type AgentToolkit,
  type DownstreamGrant,
  type SpawnJobInput
} from '../runners/toolkit.js';
import type { McpProxyPool } from '../proxy/pool.js';
import type { RunnerEvent, RunnerRegistry } from '../runners/types.js';
import type { ApprovalStore } from './approvals.js';
import type { ArtifactStore } from './artifacts.js';
import type { BudgetScope, BudgetTracker } from './budget.js';
import { notifyOwner, type WebhookStore } from './webhooks.js';
import type { MessageBus } from './bus.js';
import type { EventLog } from './events.js';
import type { MemoryStore } from './memory.js';
import { resolveAgentTarget, toSnapshot, type AgentRegistry } from './registry.js';
import type { RunnerName } from './templates.js';
import {
  isTerminal,
  type AgentSnapshot,
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
  approvals: ApprovalStore;
  webhooks: WebhookStore;
  /** Hosts a completion callback may target, beyond the SSRF baseline. Empty means any public HTTPS. */
  allowedWebhookHosts: readonly string[];
  /** Swapped in tests; defaults to the global fetch. */
  notifyFetch?: typeof fetch;
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
  lease?: { heartbeatMs?: number; expiresAfterMs?: number; cancelPollMs?: number };
  /**
   * Automatic retries for transient runner failures. Defaults suit every
   * deployment; tests shorten the base delay so a retry test needs no real
   * waiting.
   */
  retry?: { maxRetries?: number; baseDelayMs?: number };
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
 * How often this instance checks for jobs somebody else asked to cancel.
 * Deliberately far shorter than the lease heartbeat: a cancel is a human
 * waiting on an answer, while the heartbeat only guards against dead owners
 * — and the query is a cheap indexed read over the small running set, not a
 * write. A `job_cancel` served by another instance lands here within ~2s
 * instead of within a heartbeat.
 */
const DEFAULT_CANCEL_POLL_MS = 2_000;

/**
 * How often `wait` re-reads the jobs it is waiting on, on top of reacting to
 * this instance's own change notifications.
 *
 * Those notifications only ever fire for work this process ran, so a job that
 * another instance picked up settled without anyone here hearing about it and
 * every wait ran to its full deadline — `job_wait`, and with it `delegate`,
 * `fan_out` and `consensus`, blocked for the whole timeout on work that had
 * finished in milliseconds. The listener is still what makes the local case
 * instant; this is the floor under the remote one.
 */
const WAIT_POLL_MS = 250;

/** First backoff pause before a transient retry; doubles per attempt, capped below. */
const DEFAULT_RETRY_BASE_MS = 1000;
const MAX_RETRY_DELAY_MS = 10_000;

/** Only these failures ever retry automatically: rate limits, 5xx and unreachable backends. */
function isTransientFailure(error: unknown): error is OrchestratorError {
  return (
    error instanceof OrchestratorError && (error.code === 'TRANSIENT' || error.code === 'REMOTE_UNREACHABLE')
  );
}

/** Like the gateway's delay: the listener is removed on every exit, not just abort. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new OrchestratorError('INTERRUPTED', 'Stopped waiting: the job was cancelled or timed out.')
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
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
  private cancelTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: SchedulerDeps) {}

  private get heartbeatMs(): number {
    return this.deps.lease?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  private get leaseMs(): number {
    return this.deps.lease?.expiresAfterMs ?? DEFAULT_LEASE_MS;
  }

  private get cancelPollMs(): number {
    return this.deps.lease?.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS;
  }

  async submit(input: CreateJobInput): Promise<JobRecord> {
    assertDepthWithinLimit(input.depth ?? 0, this.deps.maxDepth);

    if (input.idempotencyKey !== undefined) {
      const existing = await this.deps.jobs.findByIdempotencyKey(input.idempotencyKey, input.ownerId ?? '');
      if (existing !== undefined) return existing;
    }

    // An agent's own timeoutSec is the default, not a second knob: an
    // explicit per-submit value wins, otherwise the job inherits the cap the
    // agent was created with. Without this the limits field was decorative —
    // accepted, stored and echoed, but never read by anything that runs.
    let effective = input;
    if (input.timeoutSec === undefined) {
      const agent = await this.deps.agents.get(input.agentId);
      const limit = agent?.limits.timeoutSec;
      if (limit !== undefined) effective = { ...input, timeoutSec: limit };
    }

    const job = await this.deps.jobs.create(effective);
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

    // Cancellations asked for elsewhere get their own, much faster poll than
    // the lease heartbeat above: the heartbeat guards against dead owners
    // (slow by design — reclaiming early runs work twice), while a cancel is
    // a human waiting. Sharing one timer would force a choice between
    // reclaiming too eagerly and cancelling too slowly.
    if (this.cancelTimer === undefined) {
      this.cancelTimer = setInterval(() => {
        this.track(this.pollCancels(), 'scheduler cancel poll failed');
      }, this.cancelPollMs);
      this.cancelTimer.unref?.();
    }
  }

  /** Cancel requests aimed at jobs this instance is running. Fast poll; see above. */
  private async pollCancels(): Promise<void> {
    if (this.stopped) return;

    for (const jobId of await this.deps.jobs.cancelRequested(this.instanceId)) {
      const controller = this.active.get(jobId);
      if (controller === undefined) continue;
      this.abortReasons.set(jobId, 'cancelled');
      controller.abort();
    }
  }

  /** One lease tick. Public so a caller can force one without waiting. */
  async renewAndReclaim(): Promise<void> {
    if (this.stopped) return;

    await this.deps.jobs.heartbeat(this.instanceId);
    await this.pollCancels();

    const staleBefore = new Date(Date.now() - this.leaseMs).toISOString();
    const reclaimed = await this.deps.jobs.recoverExpired(staleBefore);

    if (reclaimed.length > 0) {
      this.deps.logger.warn({ jobIds: reclaimed }, 'reclaimed jobs whose owner stopped responding');
      // Recovery transitions rows silently — without this, a requeued or
      // interrupted job shows no trace of the handover in events_query,
      // job_get(includeEvents) or the transcript resource.
      for (const jobId of reclaimed) {
        const job = await this.deps.jobs.get(jobId);
        if (job === undefined) continue;
        await this.deps.events.append({
          type: 'job.interrupted',
          jobId,
          payload: { outcome: job.state === 'queued' ? 'requeued' : job.state }
        });
      }
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

      // Polled as well as notified. `checking` keeps a slow read from stacking
      // up behind itself; a missed tick costs nothing, the next one catches it.
      let checking = false;
      const poll = setInterval(() => {
        if (finished || checking) return;
        checking = true;
        void settled().then(
          records => {
            checking = false;
            if (records !== undefined) finish(records);
          },
          () => {
            // A transient read failure is not a reason to fail the wait: the
            // deadline below still bounds it, and the next tick may succeed.
            checking = false;
          }
        );
      }, WAIT_POLL_MS);
      poll.unref?.();
      cleanups.push(() => clearInterval(poll));

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
    if (this.cancelTimer !== undefined) {
      clearInterval(this.cancelTimer);
      this.cancelTimer = undefined;
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

    // Two different limits. `maxConcurrency` is this process's worker pool, so
    // it is counted in memory and applies per instance. A `maxConcurrent`
    // budget is a policy cap on the deployment, so it is counted in the
    // database — in memory it was applied once per instance, which turned a
    // cap of 1 across three instances into three.
    const globalCap = await this.deps.budgets.maxConcurrentFor('global');

    while (this.active.size < this.deps.maxConcurrency) {
      if (globalCap !== undefined && (await this.deps.jobs.countRunning()) >= globalCap) break;
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
      // loser of that race must simply move on to the next candidate. The
      // caps ride along in the same statement — a count checked before the
      // claim is a window two instances can both pass through, overshooting
      // a maxConcurrent budget by one per racer.
      let claimed: JobRecord | undefined;
      for (const candidate of candidates) {
        const agentCap = await this.deps.budgets.maxConcurrentFor('agent', candidate.agentId);
        claimed = await this.deps.jobs.claimWithCapacity(candidate.id, this.instanceId, {
          ...(globalCap !== undefined && { globalCap }),
          ...(agentCap !== undefined && { agentCap, agentId: candidate.agentId })
        });
        if (claimed !== undefined) break;
      }

      if (claimed === undefined) break;

      // `execute` registers the job in `active` before its first await, so the
      // next iteration of this loop never picks the same job twice.
      void this.execute(claimed);
    }
  }

  /**
   * The three deployment caps. A refusal also files a `budget`-scoped
   * approval — the same queue a human already watches for workflow gates —
   * so the cap-hit is visible without digging through failed jobs. One
   * notice per cap, not per job: a capped fan-out would otherwise file a
   * hundred of them. Resolving one only acknowledges it; the cap itself still
   * changes exclusively through budget_set.
   */
  private async assertBudgets(job: JobRecord): Promise<void> {
    const scopes: { scope: BudgetScope; scopeId?: string }[] = [
      { scope: 'global' },
      { scope: 'agent', scopeId: job.agentId },
      { scope: 'job', scopeId: job.id }
    ];
    for (const { scope, scopeId } of scopes) {
      try {
        await this.deps.budgets.assertWithinBudget(scope, scopeId);
      } catch (error) {
        if (error instanceof OrchestratorError && error.code === 'BUDGET_EXCEEDED') {
          await this.noteBudgetRefusal(job, scope, scopeId, error.message);
        }
        throw error;
      }
    }

    // The agent's own maxCostUsd, frozen in the submit-time snapshot like the
    // rest of its limits. Independent of budget_set rows (either ceiling can
    // stop a job); spend is derived from recorded usage either way, so there
    // is no counter to drift between the two checks.
    const ownCap = job.agentSnapshot.limits?.maxCostUsd;
    if (ownCap !== undefined) {
      const spent = await this.deps.budgets.spend('agent', job.agentId);
      if (spent.costUsd >= ownCap) {
        const message = `Agent ${job.agentSnapshot.name}’s own cost limit of $${ownCap} is exhausted ($${spent.costUsd.toFixed(4)} spent).`;
        await this.noteBudgetRefusal(job, 'agent', job.agentId, message, 'limit');
        throw new OrchestratorError(
          'BUDGET_EXCEEDED',
          message,
          'Raise it with agent_update, or set a budget_set cap.'
        );
      }
    }
  }

  private async noteBudgetRefusal(
    job: JobRecord,
    scope: BudgetScope,
    scopeId: string | undefined,
    message: string,
    dedupeSuffix?: string
  ): Promise<void> {
    await this.deps.approvals.createIfNoPending({
      scope: 'budget',
      summary: `Budget cap stopped job ${job.id}: ${message}`,
      jobId: job.id,
      dedupeKey: `budget:${scope}:${scopeId ?? ''}${dedupeSuffix === undefined ? '' : `:${dedupeSuffix}`}`,
      payload: { budgetScope: scope, ...(scopeId !== undefined && { budgetScopeId: scopeId }) }
    });
  }

  /** Per-agent `maxConcurrent`, which is a budget rather than a config limit. */
  private async hasAgentCapacity(agentId: string): Promise<boolean> {
    const cap = await this.deps.budgets.maxConcurrentFor('agent', agentId);
    // Counted across the deployment, not just this process — see `pump`.
    return cap === undefined || (await this.deps.jobs.countRunning(agentId)) < cap;
  }

  /** Takes a job this scheduler has already claimed, so it is `running` here. */
  private async execute(job: JobRecord): Promise<void> {
    const controller = new AbortController();
    // Set before the first await, which is what stops `pump` picking this job
    // twice. Per-agent counting used to live here too; it now comes from the
    // database, because the cap it serves is deployment-wide.
    this.active.set(job.id, controller);

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
      await this.assertBudgets(job);

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

      await this.driveWithRetries(job, executor, controller, startedAtMs);
    } catch (error) {
      await this.finishFailed(job.id, error, Date.now() - startedAtMs);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.active.delete(job.id);
      this.abortReasons.delete(job.id);
      this.notify();
      this.track(this.pump(), 'scheduler pump failed');
    }
  }

  /**
   * Run a job inline within the calling request instead of queueing it for
   * the pump. This is the only path a borrowed model can take: sampling
   * needs the live request's client, which a detached background execution
   * never has. Same records, budgets, toolkit and settle path as execute —
   * only the queue and the executor differ.
   */
  async runInline(options: {
    ownerId: string;
    agentId: string;
    agentSnapshot: AgentSnapshot;
    instruction: string;
    context?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    priority?: number;
    timeoutSec?: number;
    idempotencyKey?: string;
    runner: RemoteExecutor;
    timeoutMs: number;
  }): Promise<JobRecord> {
    assertDepthWithinLimit(0, this.deps.maxDepth);

    if (options.idempotencyKey !== undefined) {
      const existing = await this.deps.jobs.findByIdempotencyKey(options.idempotencyKey, options.ownerId);
      if (existing !== undefined) return existing;
    }

    // Inline runs skip the pump, which is where capacity is normally
    // enforced — so all three caps are checked here instead of silently letting
    // an inline run overshoot them. Failing fast, before any row exists, is
    // the only honest option: there is nothing to retry or reconcile yet.
    if (this.active.size >= this.deps.maxConcurrency) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        'Concurrency cap reached: no free worker for an inline run.',
        'Wait for running jobs to settle, or raise ORCH_MAX_CONCURRENCY.'
      );
    }
    // The pool cap above is per instance; this one is deployment-wide, same
    // as the pump's — without it an inline run spends past a global
    // maxConcurrent budget the queued path would have refused.
    const globalCap = await this.deps.budgets.maxConcurrentFor('global');
    if (globalCap !== undefined && (await this.deps.jobs.countRunning()) >= globalCap) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Global concurrency cap of ${globalCap} reached: no free slot for an inline run.`,
        'Wait for running jobs to settle, or raise the global maxConcurrent budget.'
      );
    }
    const agentCap = await this.deps.budgets.maxConcurrentFor('agent', options.agentId);
    if (agentCap !== undefined && (await this.deps.jobs.countRunning(options.agentId)) >= agentCap) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Agent concurrency cap of ${agentCap} reached: no free slot for an inline run.`,
        'Wait for this agent’s jobs to settle, or raise its maxConcurrent budget.'
      );
    }

    const created = await this.deps.jobs.create({
      ownerId: options.ownerId,
      backend: 'local',
      agentId: options.agentId,
      agentSnapshot: options.agentSnapshot,
      instruction: options.instruction,
      ...(options.context !== undefined && { context: options.context }),
      ...(options.outputSchema !== undefined && { outputSchema: options.outputSchema }),
      ...(options.priority !== undefined && { priority: options.priority }),
      ...(options.timeoutSec !== undefined && { timeoutSec: options.timeoutSec }),
      ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey })
    });
    await this.deps.events.append({
      type: 'job.submitted',
      jobId: created.id,
      agentId: created.agentId,
      payload: { instruction: created.instruction, backend: created.backend }
    });

    // Claimed, not merely created: between the insert above and this line a
    // sibling pump could otherwise take the row and run it a second time
    // while this path runs it inline. The claim re-checks both deployment
    // caps atomically — the pre-checks above already passed, but another
    // instance may have filled the last slot since. Losing either race is
    // near-impossible but handled, not assumed away.
    const job = await this.deps.jobs.claimWithCapacity(created.id, this.instanceId, {
      ...(globalCap !== undefined && { globalCap }),
      ...(agentCap !== undefined && { agentCap, agentId: options.agentId })
    });
    if (job === undefined) {
      // Capped out, or genuinely raced with a background pump: re-read the
      // caps to report which, since only the message (not the outcome) can
      // race here.
      const stillGlobal =
        globalCap !== undefined && (await this.deps.jobs.countRunning()) >= globalCap;
      const stillAgent =
        agentCap !== undefined && (await this.deps.jobs.countRunning(options.agentId)) >= agentCap;
      if (stillGlobal || stillAgent) {
        throw new OrchestratorError(
          'POLICY_DENIED',
          'No free concurrency slot for an inline run.',
          'Wait for running jobs to settle, or raise the cap.'
        );
      }
      throw new OrchestratorError(
        'CONFLICT',
        `Job ${created.id} was picked up for background execution before the inline run started.`,
        'Poll it with job_get instead.'
      );
    }

    const controller = new AbortController();
    this.active.set(job.id, controller);
    const startedAtMs = Date.now();
    const timer = setTimeout(() => {
      this.abortReasons.set(job.id, 'timed_out');
      controller.abort();
    }, options.timeoutMs);

    try {
      await this.deps.events.append({ type: 'job.started', jobId: job.id, agentId: job.agentId });
      this.notify();
      await this.assertBudgets(job);
      await this.driveWithRetries(job, options.runner, controller, startedAtMs);
    } catch (error) {
      await this.finishFailed(job.id, error, Date.now() - startedAtMs);
    } finally {
      clearTimeout(timer);
      this.active.delete(job.id);
      this.abortReasons.delete(job.id);
      this.notify();
      this.track(this.pump(), 'scheduler pump failed');
    }

    return this.deps.jobs.getOrThrow(job.id);
  }

  /**
   * The toolkit a local job's agent loop gets. Extracted so detached and
   * inline execution build it identically — two constructions drifting apart
   * is how one path quietly loses approvals, grants or visibility checks.
   */
  private async buildToolkitFor(job: JobRecord, controller: AbortController): Promise<AgentToolkit | undefined> {
    // Only agents we own get a toolkit; remote A2A agents are opaque and
    // never receive downstream tool grants.
    if (job.backend !== 'local') return undefined;
    const downstream = await this.resolveGrants(job, controller.signal);
    return createAgentToolkit(
      {
        memory: this.deps.memory,
        artifacts: this.deps.artifacts,
        bus: this.deps.bus,
        events: this.deps.events,
        spawnJob: (parent, input) => this.spawnChild(parent, input),
        // A mid-loop approval wait holds this job's concurrency slot
        // (not the pool), and the job's own timeoutSec still bounds
        // it through this same signal.
        approvals: this.deps.approvals,
        signal: controller.signal,
        downstream,
                isAgentVisible: async agentId => {
                  try {
                    await this.deps.agents.getVisible(agentId, { ownerId: job.ownerId, isAdmin: false });
                    return true;
                  } catch {
                    return false;
                  }
                },
                isJobVisible: async jobId => {
                  try {
                    await this.deps.jobs.getVisible(jobId, { ownerId: job.ownerId, isAdmin: false });
                    return true;
                  } catch {
                    return false;
                  }
                },
        ...(this.deps.proxy !== undefined && {
          callDownstream: (server, tool, args, signal) =>
            (this.deps.proxy as McpProxyPool).call(server, tool, args, signal)
        })
      },
      job
    );
  }

  /**
   * Drive one execution to settlement: collect runner events, persist the
   * outcome, and flag empty successes for reconciliation. Shared by detached
   * and inline runs so the two never diverge on what "done" means.
   */
  private async drive(
    job: JobRecord,
    executor: RemoteExecutor,
    toolkit: AgentToolkit | undefined,
    signal: AbortSignal,
    startedAtMs: number,
    maxSteps?: number
  ): Promise<void> {
    let text = '';
    let structured: unknown;
    let usage: JobUsage = {};

    for await (const event of executor.run(
      { job, ...(toolkit !== undefined && { toolkit }), ...(maxSteps !== undefined && { maxSteps }) },
      signal
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
    // Fire-and-forget through track(): settlement is already recorded, and a
    // slow callback must never hold the run or the shutdown draining it —
    // delivery itself is bounded per webhook and never retried.
    this.track(
      notifyOwner(this.notifyDeps(), job.ownerId, 'job.succeeded', { jobId: job.id }),
      'webhook delivery failed'
    );
    // Reconciliation signal: a success with no text, no structured output
    // and no blockers/downstream reads as done but hands the next step an
    // empty string. Surfacing it here keeps it visible in events_query and
    // trace_get instead of silently propagating downstream.
    if (text.trim() === '' && structured === undefined) {
      await this.deps.events.append({
        type: 'job.progress',
        jobId: job.id,
        payload: { message: 'Job succeeded with empty output; verify before chaining it downstream.' }
      });
    }
  }

  /**
   * Drive one execution with bounded automatic retries for transient
   * failures: rate limits, 5xx and unreachable backends. The toolkit is
   * rebuilt per attempt — reusing the previous attempt's would leak its
   * finish payload into the fresh loop and end the job on stale output.
   * Anything else (logic errors, refusals, budget and policy denials,
   * cancellations) throws straight through to finishFailed on the first try,
   * exactly as before. Both execution paths share this, so detached and
   * inline runs retry identically.
   */
  private async driveWithRetries(
    job: JobRecord,
    executor: RemoteExecutor,
    controller: AbortController,
    startedAtMs: number
  ): Promise<void> {
    const maxRetries = this.deps.retry?.maxRetries ?? 2;
    const baseDelayMs = this.deps.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_MS;

    for (let attempt = 0; ; attempt += 1) {
      const toolkit = await this.buildToolkitFor(job, controller);
      try {
        // The agent's own maxSteps travels in the snapshot; without it every
        // runner fell back to its default and the limit never bound anything.
        await this.drive(job, executor, toolkit, controller.signal, startedAtMs, job.agentSnapshot.limits?.maxSteps);
        return;
      } catch (error) {
        // An abort wins over a retryable failure: announcing a retry for a
        // job that was just cancelled or timed out would be a lie, and the
        // INTERRUPTED error below still lands in finishFailed, where the
        // abort reason decides the final state.
        if (!isTransientFailure(error) || attempt >= maxRetries || controller.signal.aborted) throw error;
        // A failed attempt may have stored artifacts (or gateway-normalized
        // remote parts) before dying; the fresh attempt redoes the whole run,
        // so the partial ones go rather than duplicating alongside the retry.
        // Memory writes cannot be taken back — documented, not fixable.
        await this.deps.artifacts.deleteForJob(job.id);
        // A server-named wait wins over the computed backoff (still capped):
        // ignoring Retry-After is exactly how a polite client gets banned.
        const waitMs = Math.min(
          Math.max(baseDelayMs * 2 ** attempt + Math.random() * 500, error.retryAfterMs ?? 0),
          MAX_RETRY_DELAY_MS
        );
        await this.deps.events.append({
          type: 'job.progress',
          jobId: job.id,
          payload: {
            message: `Transient failure (${error.code}), retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 2} of ${maxRetries + 1}).`
          }
        });
        this.notify();
        await abortableDelay(waitMs, controller.signal);
      }
    }
  }

  /**
   * Expand an agent's `toolGrants` into concrete downstream tools. A grant is
   * either a whole server (`files`) or one tool on it (`files/read_file`); an
   * unreachable server is logged and skipped rather than failing the job.
   */
  private async resolveGrants(job: JobRecord, signal: AbortSignal): Promise<DownstreamGrant[]> {
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
        for (const tool of await pool.tools(serverName, signal)) {
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
      const eventType =
        state === 'timed_out' ? 'job.timed_out' : state === 'cancelled' ? 'job.cancelled' : 'job.failed';
      await this.deps.events.append({ type: eventType, jobId, payload: { ...payload } });
      const job = await this.deps.jobs.get(jobId);
      if (job !== undefined) {
        this.track(
          notifyOwner(this.notifyDeps(), job.ownerId, eventType, { jobId }),
          'webhook delivery failed'
        );
      }
    } catch (transitionError) {
      this.deps.logger.error({ err: transitionError, jobId }, 'failed to record job outcome');
    }
  }

  /** The notifier bundle both settle paths share. */
  private notifyDeps() {
    return {
      webhooks: this.deps.webhooks,
      fetchImpl: this.deps.notifyFetch,
      allowedHosts: this.deps.allowedWebhookHosts,
      logger: this.deps.logger
    };
  }
}
