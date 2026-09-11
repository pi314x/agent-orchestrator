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
}

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

    const publish = (state: TaskState, text: string): void => {
      if (!taskPublished) {
        taskPublished = true;
        eventBus.publish({
          kind: 'task',
          id: taskId,
          contextId,
          status: statusFor(state, text),
          artifacts: [],
          history: [],
          metadata: undefined
        } as never);
        return;
      }

      eventBus.publish({
        kind: 'statusUpdate',
        taskId,
        contextId,
        status: statusFor(state, text),
        metadata: undefined
      } as never);
    };

    const skill = requestedSkill === undefined ? undefined : this.deps.skills.get(requestedSkill);

    if (skill === undefined || !skill.exposed) {
      publish(TaskState.TASK_STATE_REJECTED, `No published skill named "${requestedSkill ?? 'default'}".`);
      eventBus.finished();
      return;
    }

    publish(TaskState.TASK_STATE_WORKING, `Running ${skill.skillId}.`);

    try {
      const agent = resolveAgentTarget(
        this.deps.agents,
        {
          ...(skill.agentId !== undefined && { agentId: skill.agentId }),
          ...(skill.templateName !== undefined && { template: skill.templateName })
        },
        { runner: this.deps.defaultRunner }
      );

      const job = this.deps.scheduler.submit({
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: toSnapshot(agent),
        instruction
      });

      const [finished] = await this.deps.scheduler.wait([job.id], 'all', 55_000);

      if (this.cancelled.has(taskId)) {
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

    eventBus.finished();
  }

  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
  }
}

export interface A2AServerHandle {
  card: AgentCard;
  /** Handles one JSON-RPC request body and resolves with the response. */
  handleJsonRpc(body: unknown): Promise<unknown>;
}

export function createA2AServer(deps: A2AServerDeps): A2AServerHandle {
  const card = buildAgentCard(deps);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new OrchestratorExecutor(deps));
  const jsonRpc = new JsonRpcTransportHandler(handler);

  return {
    card,
    async handleJsonRpc(body: unknown) {
      const context = defaultServerCallContextBuilder({
        headers: {},
        extensions: [],
        user: new UnauthenticatedUser()
      });
      return jsonRpc.handle(body as Record<string, unknown>, context);
    }
  };
}
