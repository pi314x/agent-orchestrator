import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import { TaskState, type AgentCard, type Task } from '@a2a-js/sdk';
import { waitForDecision, type ApprovalStore } from '../core/approvals.js';
import type { JobRecord } from '../core/jobs.js';
import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';
import type { RunnerEvent } from '../runners/types.js';
import type { CardStore } from './card.js';
import {
  isTerminalTaskState,
  normalizeTaskResult,
  taskErrorPayload,
  textFromMessage,
  userMessage
} from './mapping.js';
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
  /**
   * Human-approval plumbing for input-required tasks. Optional so unit tests
   * can drive the gateway without it — without it an input-required task
   * keeps the old fail-fast behaviour.
   */
  approvals?: ApprovalStore;
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
    const { card, cardId } = await this.cardFor(job);

    // Trust is checked on every call, not just at registration, so a card that
    // was re-fetched and lost its signature stops working immediately.
    try {
      const cached = await this.deps.cards.getOrThrow(cardId);
      assertTrusted(cached.trustLevel, this.deps.trustMode, job.agentSnapshot.name);
    } catch (error) {
      if (
        error instanceof OrchestratorError &&
        error.code === 'REMOTE_UNVERIFIED' &&
        this.deps.approvals !== undefined
      ) {
        await this.noteTrustRefusal(job, cardId);
      }
      throw error;
    }

    if (this.deps.clientProvider !== undefined) {
      return this.deps.clientProvider(card, job.agentSnapshot.credentialsRef);
    }

    return new ClientFactory().createFromAgentCard(card);
  }

  private async cardFor(job: JobRecord): Promise<{ card: AgentCard; cardId: string }> {
    const cardId = job.agentSnapshot.cardId;
    if (cardId === undefined) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Remote agent ${job.agentSnapshot.name} has no cached Agent Card.`,
        'Re-register it with agent_register.'
      );
    }
    const cached = await this.deps.cards.getOrThrow(cardId);
    return { card: cached.card, cardId };
  }

  async *run({ job }: { job: JobRecord }, signal: AbortSignal): AsyncIterable<RunnerEvent> {
    const client = await this.clientFor(job);

    const text =
      job.context === undefined
        ? job.instruction
        : `${job.instruction}\n\n<context>\n${JSON.stringify(job.context, null, 2)}\n</context>`;

    let task: Task;
    try {
      const result = await withAbort(
        client.sendMessage({
          tenant: '',
          message: userMessage(newId('message'), text, job.context),
          configuration: undefined,
          metadata: undefined
        }),
        signal,
        'Remote task creation'
      );

      if (!isTask(result)) {
        // A direct message reply means the agent answered without a task.
        for (const event of directReplyEvents(job.agentSnapshot.name, result)) yield event;
        return;
      }

      task = result;
    } catch (error) {
      throw asRemoteError(error, job.agentSnapshot.name);
    }

    await this.recordRemoteIds(job.id, task);
    yield { type: 'progress', message: `Remote task ${task.id} created.` };

    // A job's own timeoutSec bounds this when it has one; this deadline is what
    // bounds it when it does not.
    let deadline = Date.now() + this.maxPollMs;

    while (!isTerminalTaskState(task.status?.state ?? TaskState.TASK_STATE_WORKING)) {
      signal.throwIfAborted();

      const state = task.status?.state;
      if (state === TaskState.TASK_STATE_INPUT_REQUIRED) {
        const resumed = await this.answerInputRequired(client, job, task, signal);
        // The caller drives this generator, so progress events are the only
        // channel back for the approval id the human must resolve.
        yield {
          type: 'progress',
          message: `Remote task ${task.id} is waiting for input — resolve approval ${resumed.approvalId} (approve with editedInput.message, or reject).`
        };
        if (resumed.kind === 'replied') {
          for (const event of resumed.done) yield event;
          return;
        }
        task = resumed.task;
        // A human answering is not remote slowness: the poll budget covers
        // the agent being slow, not the reviewer being slow.
        deadline += resumed.waitedMs;
        continue;
      }
      if (state === TaskState.TASK_STATE_AUTH_REQUIRED) {
        // Credentials are per-registration and never minted mid-run, so no
        // human answer can unstick this state — fail fast and say so instead
        // of polling until maxPollMs reports a plain TIMEOUT.
        throw new OrchestratorError(
          'RUNNER_FAILED',
          `Remote task ${task.id} on ${job.agentSnapshot.name} is waiting for authentication, which cannot be provided mid-run.`,
          'Cancel it with job_cancel and re-register the agent with working credentials.'
        );
      }

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
        task = await withAbort(client.getTask({ tenant: '', id: task.id }), signal, 'Remote task poll');
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
    // File/data parts from the remote task's own artifacts become artifacts
    // here too, the same way a local job's artifact_put would — otherwise
    // normalizeTaskResult's whole artifacts field is computed and discarded.
    for (const artifact of normalized.artifacts) {
      yield { type: 'artifact', name: artifact.name, content: artifact.content, mimeType: artifact.mimeType };
    }
    yield { type: 'usage', usage: {} };
  }

  /**
   * Answer a remote task waiting for input. Files a `job`-scoped approval the
   * job owner resolves with approval_resolve — approve carrying
   * editedInput { "message": "..." } to answer, reject to stop the job —
   * waits for the decision, then continues the same remote task with it.
   * Without approval plumbing there is nobody to ask, so it keeps the old
   * fail-fast behaviour instead of hanging a concurrency slot forever.
   */
  private async answerInputRequired(
    client: Client,
    job: JobRecord,
    task: Task,
    signal: AbortSignal
  ): Promise<
    | { kind: 'continued'; approvalId: string; waitedMs: number; task: Task }
    | { kind: 'replied'; approvalId: string; waitedMs: number; done: RunnerEvent[] }
  > {
    if (this.deps.approvals === undefined) {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `Remote task ${task.id} on ${job.agentSnapshot.name} is waiting for more input, which this orchestrator cannot provide.`,
        'Cancel it with job_cancel; resuming an input-required A2A task is not supported yet.'
      );
    }

    const question = textFromMessage(task.status?.message) || 'more input';
    const approval = await this.deps.approvals.create({
      scope: 'job',
      summary:
        `Remote task ${task.id} on ${job.agentSnapshot.name} is waiting for input: ${question.slice(0, 300)}. ` +
        'Approve with editedInput { "message": "..." } to answer it, or reject to stop the job.',
      jobId: job.id,
      payload: { taskId: task.id, question: question.slice(0, 1000) }
    });

    const waitStarted = Date.now();
    let decision;
    try {
      decision = await waitForDecision(this.deps.approvals, approval.approvalId, signal, this.pollIntervalMs);
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      throw new OrchestratorError(
        'INTERRUPTED',
        `Remote task ${task.id} input wait ended: the job was cancelled or timed out.`
      );
    }
    const waitedMs = Date.now() - waitStarted;

    if (decision.status === 'rejected') {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Remote task ${task.id} input was rejected by a reviewer: ${decision.comment ?? 'no reason given.'}`
      );
    }

    const raw = decision.editedInput?.['message'];
    const answer = typeof raw === 'string' ? raw.trim() : '';
    if (answer === '') {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `Remote task ${task.id} was approved without a reply message.`,
        'Reject it instead, or approve again with editedInput { "message": "..." } to answer the remote agent.'
      );
    }

    let followUp;
    try {
      // Continuing a task is a sendMessage naming it, not a new task: the
      // same call shape as the first message, with taskId/contextId set.
      followUp = await withAbort(
        client.sendMessage({
          tenant: '',
          message: { ...userMessage(newId('message'), answer), taskId: task.id, contextId: task.contextId },
          configuration: undefined,
          metadata: undefined
        }),
        signal,
        'Remote task answer'
      );
    } catch (error) {
      throw asRemoteError(error, job.agentSnapshot.name);
    }

    if (!isTask(followUp)) {
      return {
        kind: 'replied',
        approvalId: approval.approvalId,
        waitedMs,
        done: directReplyEvents(job.agentSnapshot.name, followUp)
      };
    }

    await this.recordRemoteIds(job.id, followUp);
    return { kind: 'continued', approvalId: approval.approvalId, waitedMs, task: followUp };
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

  /**
   * A trust refusal also files an `unverified_card`-scoped approval — the
   * same queue a human already watches — so the block is visible without
   * digging through failed jobs. One notice per card, not per job, and
   * resolving one only acknowledges it: trust itself still changes
   * exclusively through re-registration or A2A_TRUST_MODE.
   */
  private async noteTrustRefusal(job: JobRecord, cardId: string): Promise<void> {
    if (this.deps.approvals === undefined) return;
    await this.deps.approvals.createIfNoPending({
      scope: 'unverified_card',
      summary: `Trust gate stopped job ${job.id}: remote agent ${job.agentSnapshot.name} has an unverified card.`,
      jobId: job.id,
      dedupeKey: `card:${cardId}`,
      payload: { cardId, agentName: job.agentSnapshot.name }
    });
  }

  private async recordRemoteIds(jobId: string, task: Task): Promise<void> {
    await this.deps.db
      .prepare('UPDATE jobs SET remote_task_id = ?, remote_context_id = ? WHERE id = ?')
      .run(task.id, task.contextId, jobId);
  }
}

function isTask(result: unknown): result is Task {
  return typeof result === 'object' && result !== null && 'status' in result && 'id' in result;
}

/**
 * Race an SDK call against the job's abort: without this a cancel or timeout
 * during a slow remote send does nothing until the network returns, because
 * the SDK call itself takes no signal. The loser still settles later, so it
 * is absorbed here rather than surfacing as an unhandled rejection.
 */
async function withAbort<T>(work: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  if (signal.aborted) {
    throw new OrchestratorError('INTERRUPTED', `${what} stopped: the job was cancelled or timed out.`);
  }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new OrchestratorError('INTERRUPTED', `${what} stopped: the job was cancelled or timed out.`));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  void work.catch(() => undefined);
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A direct message reply means the agent answered without (or after) a task. */
function directReplyEvents(agentName: string, reply: unknown): RunnerEvent[] {
  const normalized = normalizeTaskResult({
    id: '',
    contextId: '',
    status: { state: TaskState.TASK_STATE_COMPLETED, message: reply, timestamp: undefined },
    artifacts: [],
    history: [],
    metadata: undefined
  } as Task);

  return [
    { type: 'text', text: wrapUntrusted(agentName, normalized.text) },
    { type: 'usage', usage: {} }
  ];
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
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OrchestratorError('INTERRUPTED', 'Cancelled while waiting on a remote task.'));
    };
    // { once: true } only removes the listener once it actually FIRES — on
    // the far more common path (the timer just elapses normally), nothing
    // ever removes it. The remote-task poll loop calls this every interval
    // against the same job-lifetime signal, so an hours-long poll leaves
    // thousands of stale 'abort' listeners on one AbortSignal.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
