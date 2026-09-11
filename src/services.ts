import type { Config } from './config.js';
import { ArtifactStore } from './core/artifacts.js';
import { BudgetTracker } from './core/budget.js';
import { MessageBus } from './core/bus.js';
import { EventLog } from './core/events.js';
import { JobStore } from './core/jobs.js';
import { MemoryStore } from './core/memory.js';
import { AgentRegistry } from './core/registry.js';
import { JobScheduler } from './core/scheduler.js';
import type { Db } from './db/sqlite.js';
import type { Logger } from './logger.js';
import { AnthropicRunner } from './runners/anthropic.js';
import { MockRunner } from './runners/mock.js';
import { OpenAiCompatibleRunner } from './runners/openai.js';
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
  runners: RunnerRegistry;
  scheduler: JobScheduler;
}

export interface CreateServicesInput {
  config: Config;
  db: Db;
  logger: Logger;
}

/**
 * Built once per process and shared by every serving unit. These are long-lived
 * handles, not per-request state — nothing here is keyed by connection.
 */
export function createServices({ config, db, logger }: CreateServicesInput): Services {
  const events = new EventLog(db);
  const agents = new AgentRegistry(db);
  const jobs = new JobStore(db);
  const memory = new MemoryStore(db);
  const artifacts = new ArtifactStore(db);
  const bus = new MessageBus(db);
  const budgets = new BudgetTracker(db);

  const runners = new RunnerRegistry([
    new MockRunner(),
    new AnthropicRunner({
      ...(config.anthropicApiKey !== undefined && { apiKey: config.anthropicApiKey }),
      ...(config.anthropicModel !== undefined && { defaultModel: config.anthropicModel })
    }),
    new OpenAiCompatibleRunner({
      ...(config.openaiApiKey !== undefined && { apiKey: config.openaiApiKey }),
      ...(config.openaiBaseUrl !== undefined && { baseUrl: config.openaiBaseUrl })
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
    maxConcurrency: config.maxConcurrency,
    maxDepth: config.maxDepth,
    defaultRunner: config.defaultRunner
  });

  return { config, db, logger, events, agents, jobs, memory, artifacts, bus, budgets, runners, scheduler };
}
