import { z } from 'zod';
import { cardMatchesSkill, cardUrlFor, endpointFor } from '../a2a/card.js';
import { buildAgentCard } from '../a2a/server.js';
import { TRUST_LEVELS } from '../a2a/trust.js';
import { AgentViewSchema, toAgentView } from '../schemas/common.js';
import { toolError, toolOk } from './result.js';
import { denyWithoutAdminScope } from './scopes.js';
import type { ToolRegistration } from './types.js';

const CardSummarySchema = z.object({
  cardId: z.string(),
  url: z.string(),
  name: z.string(),
  description: z.string(),
  trustLevel: z.enum(TRUST_LEVELS),
  skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  fetchedAt: z.string()
});

const summarize = (cached: {
  cardId: string;
  url: string;
  trustLevel: string;
  fetchedAt: string;
  card: { name: string; description: string; skills?: { id: string; name: string; description: string }[] };
}) => ({
  cardId: cached.cardId,
  url: cached.url,
  name: cached.card.name,
  description: cached.card.description ?? '',
  trustLevel: cached.trustLevel,
  skills: (cached.card.skills ?? []).map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.description
  })),
  fetchedAt: cached.fetchedAt
});

export const agentRegisterTool: ToolRegistration = {
  name: 'agent_register',
  profile: 'standard',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'agent_register',
      {
        title: 'Register a remote A2A agent',
        description:
          'Register an agent built by someone else from its A2A Agent Card, so delegate and job_submit can route work to it. Its trustLevel is always reported and never silently upgraded. Use agent_create for an agent this orchestrator owns, and a2a_card_get to inspect a card without registering it.',
        inputSchema: z.object({
          cardUrl: z.string().describe('Base URL or full Agent Card URL.'),
          alias: z.string().optional().describe('Local name; defaults to the card name.'),
          credentialsRef: z
            .string()
            .optional()
            .describe('Env var or secret name holding this agent credential. Never shared between agents.')
        }),
        outputSchema: z.object({
          agent: AgentViewSchema,
          card: CardSummarySchema,
          trustLevel: z.enum(TRUST_LEVELS)
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true
        }
      },
      async args => {
        try {
          const cached = await deps.services.cards.fetchAndCache(args.cardUrl);
          const name = args.alias ?? cached.card.name;

          const agent = deps.services.agents.create({
            ownerId: deps.principal.ownerId,
            kind: 'remote',
            name,
            role: 'remote',
            // Card text feeds skill matching; it is descriptive data, not a prompt.
            instructions: [cached.card.description, ...(cached.card.skills ?? []).map(s => s.description)]
              .filter(Boolean)
              .join('\n'),
            cardId: cached.cardId,
            trustLevel: cached.trustLevel,
            ...(endpointFor(cached.card) !== undefined && { endpointUrl: endpointFor(cached.card) }),
            ...(args.credentialsRef !== undefined && { credentialsRef: args.credentialsRef })
          });

          return toolOk(
            { agent: toAgentView(agent), card: summarize(cached), trustLevel: cached.trustLevel },
            `Registered ${name} (${cached.trustLevel}). ${cached.card.skills?.length ?? 0} skill(s).`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const a2aCardGetTool: ToolRegistration = {
  name: 'a2a_card_get',
  profile: 'standard',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'a2a_card_get',
      {
        title: 'Fetch an Agent Card',
        description:
          'Fetch and cache a remote Agent Card without registering the agent. Use it to inspect what an agent offers and whether its card is signed before committing to agent_register.',
        inputSchema: z.object({ url: z.string() }),
        outputSchema: z.object({ card: CardSummarySchema }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async args => {
        try {
          const cached = await deps.services.cards.fetchAndCache(args.url);
          return toolOk(
            { card: summarize(cached) },
            `${cached.card.name} at ${cardUrlFor(args.url)} — ${cached.trustLevel}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const a2aCardVerifyTool: ToolRegistration = {
  name: 'a2a_card_verify',
  profile: 'full',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'a2a_card_verify',
      {
        title: 'Verify a cached Agent Card',
        description:
          'Re-check a cached card signature and report the resulting trustLevel. Use it after a card is re-fetched, or to confirm why a remote delegation was refused under verified-only trust mode.',
        inputSchema: z.object({ cardId: z.string() }),
        outputSchema: z.object({ card: CardSummarySchema, trustLevel: z.enum(TRUST_LEVELS) }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async args => {
        try {
          const cached = await deps.services.cards.reverify(args.cardId);
          return toolOk(
            { card: summarize(cached), trustLevel: cached.trustLevel },
            `${cached.card.name} is ${cached.trustLevel}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const a2aDiscoverTool: ToolRegistration = {
  name: 'a2a_discover',
  profile: 'full',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'a2a_discover',
      {
        title: 'Discover remote agents',
        description:
          'Search cached Agent Cards, and a configured registry when A2A_REGISTRY_URL is set, for agents matching a skill. Everyday routing does not need this — pass a skillQuery to delegate instead.',
        inputSchema: z.object({ query: z.string().min(1), tags: z.array(z.string()).optional() }),
        outputSchema: z.object({ cards: z.array(CardSummarySchema), registryConfigured: z.boolean() }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      args => {
        try {
          const matches = deps.services.cards
            .list()
            .filter(cached => cardMatchesSkill(cached.card, args.query));

          return toolOk(
            {
              cards: matches.map(summarize),
              registryConfigured: deps.services.config.a2aRegistryUrl !== undefined
            },
            `${matches.length} cached card(s) match "${args.query}".`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const a2aTaskGetTool: ToolRegistration = {
  name: 'a2a_task_get',
  profile: 'full',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'a2a_task_get',
      {
        title: 'Get the raw A2A task',
        description:
          'Read the underlying A2A task behind a remote job — the debug layer under job_get. Use job_get for normal work; reach for this when the two disagree or a remote agent is behaving oddly.',
        inputSchema: z.object({ jobId: z.string() }),
        outputSchema: z.object({
          taskId: z.string(),
          contextId: z.string(),
          state: z.string(),
          raw: z.record(z.string(), z.unknown())
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async args => {
        try {
          const job = deps.services.jobs.getOrThrow(args.jobId);
          const task = await deps.services.a2aGateway.getRawTask(job);

          return toolOk(
            {
              taskId: task.id,
              contextId: task.contextId,
              state: String(task.status?.state ?? 'unknown'),
              raw: task as unknown as Record<string, unknown>
            },
            `Remote task ${task.id} is in state ${String(task.status?.state)}.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const a2aTaskCancelTool: ToolRegistration = {
  name: 'a2a_task_cancel',
  profile: 'full',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'a2a_task_cancel',
      {
        title: 'Cancel a raw A2A task',
        description:
          'Cancel the remote task directly without touching the local job. Normally use job_cancel, which does both; this is for when the two have drifted apart.',
        inputSchema: z.object({ jobId: z.string(), reason: z.string().optional() }),
        outputSchema: z.object({ taskId: z.string(), state: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
      },
      async args => {
        try {
          const job = deps.services.jobs.getOrThrow(args.jobId);
          const task = await deps.services.a2aGateway.cancelRemoteTask(job);
          return toolOk(
            { taskId: task.id, state: String(task.status?.state ?? 'unknown') },
            `Remote task ${task.id} cancelled.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const a2aPushConfigSetTool: ToolRegistration = {
  name: 'a2a_push_config_set',
  profile: 'full',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'a2a_push_config_set',
      {
        title: 'Register a push callback',
        description:
          'Ask a remote agent to push task updates to a webhook instead of us polling. The URL must be HTTPS, must not point at a private address, and must match A2A_WEBHOOK_ALLOWED_HOSTS when that is configured.',
        inputSchema: z.object({ jobId: z.string(), callbackUrl: z.string() }),
        outputSchema: z.object({ callbackUrl: z.string() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        }
      },
      async args => {
        try {
          const job = deps.services.jobs.getOrThrow(args.jobId);
          const url = await deps.services.a2aGateway.setPushConfig(job, args.callbackUrl);
          return toolOk({ callbackUrl: url }, `Remote agent will push updates to ${url}.`);
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const a2aServerInfoTool: ToolRegistration = {
  name: 'a2a_server_info',
  profile: 'standard',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'a2a_server_info',
      {
        title: 'Show our published Agent Card',
        description:
          'Show the Agent Card this orchestrator publishes and which local agents are exposed through it. Nothing appears here until agent_publish opts it in explicitly. `serving` tells you whether an inbound listener is actually up: when it is false the card is composed on request but no remote agent can reach it.',
        inputSchema: z.object({}),
        outputSchema: z.object({
          enabled: z.boolean(),
          serving: z.boolean().describe('Whether an inbound A2A listener is actually running.'),
          publicUrl: z.string().optional(),
          card: z.record(z.string(), z.unknown()),
          exposedSkills: z.array(z.object({ skillId: z.string(), description: z.string() }))
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      () => {
        const { config, publishedSkills } = deps.services;
        const exposed = publishedSkills.listExposed();
        const serving = deps.services.a2aServing === true;

        const card = buildAgentCard({
          skills: publishedSkills,
          scheduler: deps.services.scheduler,
          agents: deps.services.agents,
          logger: deps.services.logger,
          defaultRunner: config.defaultRunner,
          serverName: 'agent-orchestrator',
          serverVersion: deps.version,
          publicUrl: config.a2aAgentCardUrl ?? `http://127.0.0.1:${config.a2aHttpPort}/a2a`
        });

        return toolOk(
          {
            enabled: config.a2aEnabled,
            // Reported separately from `enabled`: the tools can be switched on
            // while the listener is not up (in-process use, or a tool call
            // during startup), and claiming reachability we do not have is how
            // an operator ends up handing out a card URL that refuses.
            serving,
            ...(config.a2aAgentCardUrl !== undefined && { publicUrl: config.a2aAgentCardUrl }),
            card: card as unknown as Record<string, unknown>,
            exposedSkills: exposed.map(s => ({ skillId: s.skillId, description: s.description }))
          },
          config.a2aEnabled && serving
            ? `Serving ${exposed.length} published skill(s) at ${config.a2aAgentCardUrl ?? `port ${config.a2aHttpPort}`}.`
            : config.a2aEnabled
              ? `${exposed.length} skill(s) opted in, but no inbound listener is running in this process — the card is composed on request, not served.`
              : 'A2A is disabled (set A2A_ENABLED=true). Outbound interop tools are hidden entirely.'
        );
      }
    );
  }
};

export const agentPublishTool: ToolRegistration = {
  name: 'agent_publish',
  profile: 'standard',
  requiresA2A: true,

  register(server, deps) {
    server.registerTool(
      'agent_publish',
      {
        title: 'Publish an agent as an A2A skill',
        description:
          'Opt one local agent or template into the Agent Card this orchestrator publishes, so other vendors can delegate to it. Publishing is explicit and per-skill — the roster is never exposed by default. Set exposed=false to withdraw one.',
        inputSchema: z.object({
          skillId: z.string().min(1),
          description: z.string().min(1),
          agentId: z.string().optional(),
          templateName: z.string().optional(),
          exposed: z.boolean().default(true)
        }),
        outputSchema: z.object({
          skill: z.object({
            skillId: z.string(),
            agentId: z.string().optional(),
            templateName: z.string().optional(),
            description: z.string(),
            exposed: z.boolean()
          }),
          exposedCount: z.number()
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      (args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'agent_publish');
        if (denied !== undefined) return denied;

        try {
          if (args.agentId === undefined && args.templateName === undefined) {
            return toolError(
              new Error('Specify either agentId or templateName so the skill has something to run.')
            );
          }

          const skill = deps.services.publishedSkills.upsert({
            skillId: args.skillId,
            description: args.description,
            exposed: args.exposed,
            ...(args.agentId !== undefined && { agentId: args.agentId }),
            ...(args.templateName !== undefined && { templateName: args.templateName })
          });

          const exposedCount = deps.services.publishedSkills.listExposed().length;

          return toolOk(
            { skill, exposedCount },
            `${skill.skillId} is ${skill.exposed ? 'published' : 'withdrawn'}; ${exposedCount} skill(s) exposed.`
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};
