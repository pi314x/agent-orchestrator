import { CardStore } from './a2a/card.js';
import { A2AGateway, type ClientProvider } from './a2a/client.js';
import { PublishedSkillStore } from './a2a/server.js';
import type { Config } from './config.js';
import { ApprovalStore } from './core/approvals.js';
import { ArtifactStore } from './core/artifacts.js';
import { BudgetTracker } from './core/budget.js';
import { MessageBus } from './core/bus.js';
import { EventLog } from './core/events.js';
import { JobStore } from './core/jobs.js';
import { MemoryStore } from './core/memory.js';
import { AgentRegistry } from './core/registry.js';
import { JobScheduler } from './core/scheduler.js';
import { WorkflowEngine } from './core/workflow-engine.js';
import type { Db } from './db/sqlite.js';
import type { Logger } from './logger.js';
import { AnthropicRunner } from './runners/anthropic.js';
import { MockRunner } from './runners/mock.js';
import { CliRunner } from './runners/cli.js';
import { OpenAiCompatibleRunner } from './runners/openai.js';
import { McpProxyPool } from './proxy/pool.js';
import { RunnerRegistry } from './runners/types.js';

export interface Services {
  config: Config;
  db: Db;
  logger: Logger;
  events: EventLog;
  agents: AgentRegistry;
  jobs: JobStore;
  memory: MemoryStore;
  artifacts: ArtifactStore;
  bus: MessageBus;
  budgets: BudgetTracker;
  approvals: ApprovalStore;
  cards: CardStore;
  publishedSkills: PublishedSkillStore;
  a2aGateway: A2AGateway;
  proxy: McpProxyPool;
  runners: RunnerRegistry;
  scheduler: JobScheduler;
  workflows: WorkflowEngine;
}

export interface CreateServicesInput {
  config: Config;
  db: Db;
  logger: Logger;
  /** Lets tests point the A2A gateway at an in-repo fixture agent. */
  a2aClientProvider?: ClientProvider;
}

/**
 * Built once per process and shared by every serving unit. These are long-lived
 * handles, not per-request state — nothing here is keyed by connection.
 */
export function createServices({ config, db, logger, a2aClientProvider }: CreateServicesInput): Services {
  const events = new EventLog(db);
  const agents = new AgentRegistry(db);
  const jobs = new JobStore(db);
  const memory = new MemoryStore(db);
  const artifacts = new ArtifactStore(db);
  const bus = new MessageBus(db);
  const budgets = new BudgetTracker(db);
  const approvals = new ApprovalStore(db);
  const cards = new CardStore(db);
  const publishedSkills = new PublishedSkillStore(db);

  const a2aGateway = new A2AGateway({
    db,
    cards,
    logger,
    trustMode: config.a2aTrustMode,
    allowedWebhookHosts: config.a2aWebhookAllowedHosts,
    ...(a2aClientProvider !== undefined && { clientProvider: a2aClientProvider })
  });

  const proxy = new McpProxyPool(db, logger);

  const runners = new RunnerRegistry([
    new MockRunner(),
    new AnthropicRunner({
      ...(config.anthropicApiKey !== undefined && { apiKey: config.anthropicApiKey }),
      ...(config.anthropicModel !== undefined && { defaultModel: config.anthropicModel })
    }),
    new OpenAiCompatibleRunner({
      ...(config.openaiApiKey !== undefined && { apiKey: config.openaiApiKey }),
      ...(config.openaiBaseUrl !== undefined && { baseUrl: config.openaiBaseUrl })
    }),
    new CliRunner({
      workspaceDirs: config.cliWorkspaceDirs,
      allowNetwork: config.cliAllowNetwork,
      ...(config.cliCommand !== undefined && { command: config.cliCommand })
    })
  ]);

  const scheduler = new JobScheduler({
    jobs,
    events,
    runners,
    agents,
    memory,
    artifacts,
    bus,
    budgets,
    logger,
    a2aGateway,
    proxy,
    maxConcurrency: config.maxConcurrency,
    maxDepth: config.maxDepth,
    defaultRunner: config.defaultRunner
  });

  const workflows = new WorkflowEngine({
    db,
    jobs,
    scheduler,
    agents,
    approvals,
    events,
    logger,
    defaultRunner: config.defaultRunner
  });

  return {
    config,
    db,
    logger,
    events,
    agents,
    jobs,
    memory,
    artifacts,
    bus,
    budgets,
    approvals,
    cards,
    publishedSkills,
    a2aGateway,
    proxy,
    runners,
    scheduler,
    workflows
  };
}
