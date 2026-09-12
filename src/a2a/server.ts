import { Role, TaskState, type AgentCard, type AgentSkill } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  UnauthenticatedUser,
  defaultServerCallContextBuilder,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from '@a2a-js/sdk/server';
import type { JobScheduler } from '../core/scheduler.js';
import { resolveAgentTarget, toSnapshot, type AgentRegistry } from '../core/registry.js';
import type { RunnerName } from '../core/templates.js';
import type { Db } from '../db/sqlite.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';
import { textFromMessage, textPart } from './mapping.js';

export type PublishedSkill = {
  skillId: string;
  agentId?: string;
  templateName?: string;
  description: string;
  exposed: boolean;
  createdAt: string;
  updatedAt: string;
};

type SkillRow = {
  skill_id: string;
  agent_id: string | null;
  template_name: string | null;
  description: string;
  exposed: number;
  created_at: string;
  updated_at: string;
};

function toSkill(row: SkillRow): PublishedSkill {
  return {
    skillId: row.skill_id,
    description: row.description,
    exposed: row.exposed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.agent_id !== null && { agentId: row.agent_id }),
    ...(row.template_name !== null && { templateName: row.template_name })
  };
}

/** Publishing is opt-in: nothing is exposed until a skill is marked exposed. */
export class PublishedSkillStore {
  constructor(private readonly db: Db) {}

  upsert(input: {
    skillId: string;
    agentId?: string;
    templateName?: string;
    description: string;
    exposed: boolean;
  }): PublishedSkill {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO published_skills (skill_id, agent_id, template_name, description, exposed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (skill_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           template_name = excluded.template_name,
           description = excluded.description,
           exposed = excluded.exposed,
           updated_at = excluded.updated_at`
      )
      .run(
        input.skillId,
        input.agentId ?? null,
        input.templateName ?? null,
        input.description,
        input.exposed ? 1 : 0,
        now,
        now
      );

    const row = this.db
      .prepare('SELECT * FROM published_skills WHERE skill_id = ?')
      .get(input.skillId) as SkillRow;
    return toSkill(row);
  }

  listExposed(): PublishedSkill[] {
    const rows = this.db
      .prepare('SELECT * FROM published_skills WHERE exposed = 1 ORDER BY skill_id')
      .all() as SkillRow[];
    return rows.map(toSkill);
  }

  listAll(): PublishedSkill[] {
    const rows = this.db.prepare('SELECT * FROM published_skills ORDER BY skill_id').all() as SkillRow[];
    return rows.map(toSkill);
  }

  get(skillId: string): PublishedSkill | undefined {
    const row = this.db.prepare('SELECT * FROM published_skills WHERE skill_id = ?').get(skillId) as
      SkillRow | undefined;
    return row === undefined ? undefined : toSkill(row);
  }
}

export interface A2AServerDeps {
  skills: PublishedSkillStore;
  scheduler: JobScheduler;
  agents: AgentRegistry;
  logger: Logger;
  defaultRunner: RunnerName;
  serverName: string;
  serverVersion: string;
  publicUrl: string;
  /** Ceiling on an inbound task, so a job can never outlive the task reporting it. */
  taskTimeoutSec?: number;
}

/**
 * How long an inbound task may run. The job carries this as its own timeoutSec
 * as well, so the scheduler aborts it rather than leaving it running after the
 * task has already been reported failed.
 */
export const DEFAULT_INBOUND_TASK_TIMEOUT_SEC = 300;

/** Build our Agent Card from the skills explicitly opted in via agent_publish. */
export function buildAgentCard(deps: A2AServerDeps): AgentCard {
  const skills: AgentSkill[] = deps.skills.listExposed().map(skill => ({
    id: skill.skillId,
    name: skill.skillId,
    description: skill.description,
    tags: [],
    examples: [],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
    securityRequirements: []
  }));

  return {
    name: deps.serverName,
    description: 'Agent orchestrator exposing explicitly published local agents as A2A skills.',
    version: deps.serverVersion,
    supportedInterfaces: [
      { url: deps.publicUrl, protocolName: 'JSONRPC', protocolVersion: '1.0', tenant: '' }
    ],
    provider: undefined,
    skills,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    security: [],
    signatures: []
  } as unknown as AgentCard;
}

/**
 * Maps an incoming A2A task onto a local job. Only skills marked exposed can be
 * reached; anything else is rejected rather than quietly routed somewhere.
 */
class OrchestratorExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>();
  /** Task to the job running it, so a cancel reaches the actual work. */
  private readonly jobByTask = new Map<string, string>();

  constructor(private readonly deps: A2AServerDeps) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    const instruction = textFromMessage(requestContext.userMessage);

    const requestedSkill =
      (requestContext.userMessage.metadata?.['skillId'] as string | undefined) ??
      this.deps.skills.listExposed()[0]?.skillId;

    const statusFor = (state: TaskState, text: string) => ({
      state,
      message: {
        messageId: newId('message'),
        contextId,
        taskId,
        role: Role.ROLE_AGENT,
        parts: [textPart(text)],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: []
      },
      timestamp: new Date().toISOString()
    });

    // The SDK requires the first event to be the task itself; later changes go
    // out as status updates.
    let taskPublished = false;

    // Events go on the bus wrapped as {kind, data} — the SDK reads
    // `event.data.status`, so a flat object throws deep inside the bus
    // listener rather than anywhere near here.
    const publish = (state: TaskState, text: string): void => {
      if (!taskPublished) {
        taskPublished = true;
        eventBus.publish({
          kind: 'task',
          data: {
            id: taskId,
            contextId,
            status: statusFor(state, text),
            artifacts: [],
            history: [],
            metadata: undefined
          }
        });
        return;
      }

      eventBus.publish({
        kind: 'statusUpdate',
        data: { taskId, contextId, status: statusFor(state, text), metadata: undefined }
      });
    };

    const skill = requestedSkill === undefined ? undefined : this.deps.skills.get(requestedSkill);

    if (skill === undefined || !skill.exposed) {
      publish(TaskState.TASK_STATE_REJECTED, `No published skill named "${requestedSkill ?? 'default'}".`);
      eventBus.finished();
      return;
    }

    publish(TaskState.TASK_STATE_WORKING, `Running ${skill.skillId}.`);

    try {
      // Full visibility here is correct, not a gap: agent_publish already
      // requires orch:admin, so an operator has already decided this exact
      // agent is externally reachable by anyone who can reach this server.
      const agent = resolveAgentTarget(
        this.deps.agents,
        {
          ...(skill.agentId !== undefined && { agentId: skill.agentId }),
          ...(skill.templateName !== undefined && { template: skill.templateName })
        },
        { runner: this.deps.defaultRunner },
        { ownerId: '', isAdmin: true }
      );

      const timeoutSec = this.deps.taskTimeoutSec ?? DEFAULT_INBOUND_TASK_TIMEOUT_SEC;

      const job = this.deps.scheduler.submit({
        // Same convention as a spawned sub-job: the job belongs to whoever
        // owns the agent doing the work, not to nobody. Without this it
        // defaulted to ownerId '' — the admin-wide shared sentinel — which
        // JobStore.getVisible does not special-case the way agent visibility
        // does, so job_get/job_list/job_wait/job_cancel could never find it
        // for anyone but an admin, even the owner of the agent that ran it.
        ownerId: agent.ownerId,
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction,
        // Without this the job has no deadline of its own and keeps running —
        // and spending — after the wait below has already reported it failed.
        timeoutSec
      });

      this.jobByTask.set(taskId, job.id);

      // A cancel that arrived before the job existed still has to land.
      if (this.cancelled.has(taskId)) this.deps.scheduler.cancel(job.id, 'Cancelled by the A2A caller.');

      const [finished] = await this.deps.scheduler.wait([job.id], 'all', timeoutSec * 1000);

      if (this.cancelled.has(taskId) || finished?.state === 'cancelled') {
        publish(TaskState.TASK_STATE_CANCELED, 'Cancelled.');
      } else if (finished?.state === 'succeeded') {
        publish(TaskState.TASK_STATE_COMPLETED, finished.resultText ?? '');
      } else {
        publish(TaskState.TASK_STATE_FAILED, finished?.error?.message ?? 'The job did not complete.');
      }
    } catch (error) {
      this.deps.logger.error({ err: error, taskId }, 'A2A execution failed');
      publish(TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : String(error));
    }

    this.jobByTask.delete(taskId);
    // cancelTask() only ever adds to this set, never removes — without this,
    // every task that was ever cancelled stays in memory for the rest of the
    // process's life, however long ago it actually finished.
    this.cancelled.delete(taskId);
    eventBus.finished();
  }

  /** Stops the work, not just the reporting of it. */
  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.add(taskId);

    const jobId = this.jobByTask.get(taskId);
    if (jobId === undefined) return;

    try {
      this.deps.scheduler.cancel(jobId, 'Cancelled by the A2A caller.');
    } catch (error) {
      this.deps.logger.warn({ err: error, taskId, jobId }, 'could not cancel the job behind an A2A task');
    }
  }
}

export interface A2AServerHandle {
  /** The card as it stands now, rebuilt whenever the published skills change. */
  card(): AgentCard;
  /** Handles one JSON-RPC request body and resolves with the response. */
  handleJsonRpc(body: unknown, headers?: Record<string, string>): Promise<unknown>;
}

/** Identifies the exposed-skill set, so a change to it is cheap to detect. */
function skillSignature(deps: A2AServerDeps): string {
  return deps.skills
    .listExposed()
    .map(skill => `${skill.skillId}:${skill.description}`)
    .join('|');
}

export function createA2AServer(deps: A2AServerDeps): A2AServerHandle {
  // One task store and one executor for the life of the server: task state has
  // to survive across requests, since sendMessage and getTask are separate
  // calls. Only the card-bearing handler is rebuilt.
  const taskStore = new InMemoryTaskStore();
  const executor = new OrchestratorExecutor(deps);

  let signature = skillSignature(deps);
  let card = buildAgentCard(deps);
  let handler = new DefaultRequestHandler(card, taskStore, executor);
  let jsonRpc = new JsonRpcTransportHandler(handler);

  // DefaultRequestHandler takes the card by value, so publishing or
  // withdrawing a skill would otherwise keep serving the card as it looked at
  // startup — advertising skills that no longer answer.
  const refresh = (): void => {
    const current = skillSignature(deps);
    if (current === signature) return;

    signature = current;
    card = buildAgentCard(deps);
    handler = new DefaultRequestHandler(card, taskStore, executor);
    jsonRpc = new JsonRpcTransportHandler(handler);
  };

  return {
    card() {
      refresh();
      return card;
    },
    async handleJsonRpc(body: unknown, headers: Record<string, string> = {}) {
      refresh();

      const context = defaultServerCallContextBuilder({
        headers,
        extensions: [],
        user: new UnauthenticatedUser()
      });
      return jsonRpc.handle(body as Record<string, unknown>, context);
    }
  };
}
