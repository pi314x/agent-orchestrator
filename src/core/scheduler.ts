import { OrchestratorError, toErrorPayload } from '../errors.js';
import type { Logger } from '../logger.js';
import { createAgentToolkit, type SpawnJobInput } from '../runners/toolkit.js';
import type { RunnerRegistry } from '../runners/types.js';
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
}

export class JobScheduler {
  private readonly active = new Map<string, AbortController>();
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

    this.deps.jobs.releaseBlocked();

    while (this.active.size < this.deps.maxConcurrency) {
      const candidates = this.deps.jobs.nextQueued(this.deps.maxConcurrency - this.active.size);
      const next = candidates.find(job => !this.active.has(job.id));
      if (next === undefined) break;

      // Runs until its first await, which is past the transition out of
      // `queued` — so the next iteration never picks the same job twice.
      void this.execute(next);
    }
  }

  private async execute(queued: JobRecord): Promise<void> {
    const controller = new AbortController();
    this.active.set(queued.id, controller);

    const startedAtMs = Date.now();
    let timer: NodeJS.Timeout | undefined;

    try {
      const job = this.deps.jobs.transition(queued.id, 'running');
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
      const runner = this.deps.runners.get(runnerName);
      if (runner === undefined) {
        throw new OrchestratorError(
          'RUNNER_FAILED',
          `No runner named "${runnerName}" is registered.`,
          'Call runner_list to see which runners are available.'
        );
      }

      // Only agents we own get a toolkit; remote A2A agents are opaque.
      const toolkit =
        job.backend === 'local'
          ? createAgentToolkit(
              {
                memory: this.deps.memory,
                artifacts: this.deps.artifacts,
                bus: this.deps.bus,
                events: this.deps.events,
                spawnJob: (parent, input) => this.spawnChild(parent, input)
              },
              job
            )
          : undefined;

      let text = '';
      let structured: unknown;
      let usage: JobUsage = {};

      for await (const event of runner.run(
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
      this.finishFailed(queued.id, error, Date.now() - startedAtMs);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.active.delete(queued.id);
      this.abortReasons.delete(queued.id);
      this.notify();
      this.pump();
    }
  }

  /** Backs the toolkit's `spawn_job`; depth and budget rules apply as normal. */
  private spawnChild(parent: JobRecord, input: SpawnJobInput): { jobId: string } {
    const agent = resolveAgentTarget(
      this.deps.agents,
      {
        ...(input.agentId !== undefined && { agentId: input.agentId }),
        ...(input.template !== undefined && { template: input.template })
      },
      { runner: this.deps.defaultRunner }
    );

    const child = this.submit({
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
