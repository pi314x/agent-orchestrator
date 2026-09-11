import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import { TaskState, type AgentCard, type Task } from '@a2a-js/sdk';
import type { JobRecord } from '../core/jobs.js';
import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';
import type { RunnerEvent } from '../runners/types.js';
import type { CardStore } from './card.js';
import { isTerminalTaskState, normalizeTaskResult, taskErrorPayload, userMessage } from './mapping.js';
import { assertTrusted, validateWebhookUrl, wrapUntrusted, type TrustMode } from './trust.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
/**
 * Ceiling on how long we will poll a remote task that never reaches a terminal
 * state. The scheduler's per-job timer only exists when the job carries a
 * `timeoutSec`, and job_submit leaves that optional — so without this the loop
 * hammers a third party forever and holds a concurrency slot for good.
 */
const DEFAULT_MAX_POLL_MS = 15 * 60_000;

export type ClientProvider = (card: AgentCard, credentialsRef?: string) => Promise<Client>;

export interface A2AGatewayDeps {
  db: Db;
  cards: CardStore;
  logger: Logger;
  trustMode: TrustMode;
  allowedWebhookHosts?: readonly string[];
  pollIntervalMs?: number;
  /** Ceiling on polling a remote task; defaults to 15 minutes. */
  maxPollMs?: number;
  /** Injectable so tests can point the gateway at an in-repo fixture agent. */
  clientProvider?: ClientProvider;
}

/**
 * The outward half of A2A. Deliberately not a runner (PLAN §9) — it never runs
 * a model itself — but it exposes the same `run` shape so the scheduler drives
 * local and remote work through one path.
 */
export class A2AGateway {
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;

  constructor(private readonly deps: A2AGatewayDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollMs = deps.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  }

  private async clientFor(job: JobRecord): Promise<Client> {
    const { card, cardId } = this.cardFor(job);

    // Trust is checked on every call, not just at registration, so a card that
    // was re-fetched and lost its signature stops working immediately.
    assertTrusted(this.deps.cards.getOrThrow(cardId).trustLevel, this.deps.trustMode, job.agentSnapshot.name);

    if (this.deps.clientProvider !== undefined) {
      return this.deps.clientProvider(card, job.agentSnapshot.credentialsRef);
    }

    return new ClientFactory().createFromAgentCard(card);
  }

  private cardFor(job: JobRecord): { card: AgentCard; cardId: string } {
    const cardId = job.agentSnapshot.cardId;
    if (cardId === undefined) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Remote agent ${job.agentSnapshot.name} has no cached Agent Card.`,
        'Re-register it with agent_register.'
      );
    }
    return { card: this.deps.cards.getOrThrow(cardId).card, cardId };
  }

  async *run({ job }: { job: JobRecord }, signal: AbortSignal): AsyncIterable<RunnerEvent> {
    const client = await this.clientFor(job);

    const text =
      job.context === undefined
        ? job.instruction
        : `${job.instruction}\n\n<context>\n${JSON.stringify(job.context, null, 2)}\n</context>`;

    let task: Task;
    try {
      const result = await client.sendMessage({
        tenant: '',
        message: userMessage(newId('message'), text, job.context),
        configuration: undefined,
        metadata: undefined
      });

      if (!isTask(result)) {
        // A direct message reply means the agent answered without a task.
        const reply = normalizeTaskResult({
          id: '',
          contextId: '',
          status: { state: TaskState.TASK_STATE_COMPLETED, message: result, timestamp: undefined },
          artifacts: [],
          history: [],
          metadata: undefined
        } as Task);

        yield { type: 'text', text: wrapUntrusted(job.agentSnapshot.name, reply.text) };
        yield { type: 'usage', usage: {} };
        return;
      }

      task = result;
    } catch (error) {
      throw asRemoteError(error, job.agentSnapshot.name);
    }

    this.recordRemoteIds(job.id, task);
    yield { type: 'progress', message: `Remote task ${task.id} created.` };

    // A job's own timeoutSec bounds this when it has one; this deadline is what
    // bounds it when it does not.
    const deadline = Date.now() + this.maxPollMs;

    while (!isTerminalTaskState(task.status?.state ?? TaskState.TASK_STATE_WORKING)) {
      signal.throwIfAborted();

      if (Date.now() >= deadline) {
        throw new OrchestratorError(
          'TIMEOUT',
          `Remote task ${task.id} on ${job.agentSnapshot.name} did not finish within ${Math.round(this.maxPollMs / 1000)}s.`,
          'Cancel it with job_cancel, or give the job a longer timeoutSec.'
        );
      }

      await delay(this.pollIntervalMs, signal);
      signal.throwIfAborted();

      try {
        task = await client.getTask({ tenant: '', id: task.id });
      } catch (error) {
        throw asRemoteError(error, job.agentSnapshot.name);
      }
    }

    const failure = taskErrorPayload(task);
    if (failure !== undefined) {
      throw new OrchestratorError(failure.code, failure.message, failure.hint);
    }

    const normalized = normalizeTaskResult(task);

    // Remote output is untrusted data: stored and returned, never executed,
    // and never allowed to change policy, grants or trust.
    yield { type: 'text', text: wrapUntrusted(job.agentSnapshot.name, normalized.text) };
    if (normalized.structured !== undefined) {
      yield { type: 'structured', value: normalized.structured };
    }
    yield { type: 'usage', usage: {} };
  }

  async getRawTask(job: JobRecord): Promise<Task> {
    if (job.remoteTaskId === undefined) {
      throw new OrchestratorError('NOT_FOUND', `Job ${job.id} has no remote task yet.`);
    }
    const client = await this.clientFor(job);
    return client.getTask({ tenant: '', id: job.remoteTaskId });
  }

  async cancelRemoteTask(job: JobRecord): Promise<Task> {
    if (job.remoteTaskId === undefined) {
      throw new OrchestratorError('NOT_FOUND', `Job ${job.id} has no remote task to cancel.`);
    }
    const client = await this.clientFor(job);
    return client.cancelTask({ tenant: '', id: job.remoteTaskId, metadata: undefined });
  }

  async setPushConfig(job: JobRecord, callbackUrl: string): Promise<string> {
    // Validated before it leaves: a callback URL is handed to a third party.
    const url = validateWebhookUrl(callbackUrl, this.deps.allowedWebhookHosts ?? []);

    if (job.remoteTaskId === undefined) {
      throw new OrchestratorError('NOT_FOUND', `Job ${job.id} has no remote task yet.`);
    }

    const client = await this.clientFor(job);
    await client.createTaskPushNotificationConfig({
      tenant: '',
      id: newId('message'),
      taskId: job.remoteTaskId,
      url: url.toString(),
      token: '',
      authentication: undefined
    });

    return url.toString();
  }

  private recordRemoteIds(jobId: string, task: Task): void {
    this.deps.db
      .prepare('UPDATE jobs SET remote_task_id = ?, remote_context_id = ? WHERE id = ?')
      .run(task.id, task.contextId, jobId);
  }
}

function isTask(result: unknown): result is Task {
  return typeof result === 'object' && result !== null && 'status' in result && 'id' in result;
}

function asRemoteError(error: unknown, agentLabel: string): OrchestratorError {
  if (error instanceof OrchestratorError) return error;
  const message = error instanceof Error ? error.message : String(error);

  return new OrchestratorError(
    'REMOTE_UNREACHABLE',
    `${agentLabel} could not be reached: ${message}`,
    'Check the agent endpoint and its credentials.'
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new OrchestratorError('INTERRUPTED', 'Cancelled while waiting on a remote task.'));
      },
      { once: true }
    );
  });
}
