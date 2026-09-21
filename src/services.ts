import { CardStore } from './a2a/card.js';
import { A2AGateway, type ClientProvider } from './a2a/client.js';
import { PublishedSkillStore } from './a2a/server.js';
import type { Config } from './config.js';
import { ApprovalStore } from './core/approvals.js';
import { ArtifactStore } from './core/artifacts.js';
import { BudgetTracker } from './core/budget.js';
import { MessageBus } from './core/bus.js';
import { EventLog } from './core/events.js';
import { GrantPresetStore, GrantStore } from './core/grants.js';
import { JobStore } from './core/jobs.js';
import { MemoryStore } from './core/memory.js';
import { parseDataKey, type PqcDataKey } from './core/pqc.js';
import { AgentRegistry } from './core/registry.js';
import { TemplateStore } from './core/templates.js';
import { JobScheduler } from './core/scheduler.js';
import { ScheduleRunner, ScheduleStore } from './core/schedules.js';
import { WebhookStore } from './core/webhooks.js';
import { WorkflowEngine } from './core/workflow-engine.js';
import type { Db } from './db/sqlite.js';
import type { Logger } from './logger.js';
import { AnthropicRunner } from './runners/anthropic.js';
import { MockRunner } from './runners/mock.js';
import { SamplingRunner } from './runners/sampling.js';
import { OrchestratorError } from './errors.js';
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
  templates: TemplateStore;
  presets: GrantPresetStore;
  webhooks: WebhookStore;
  cards: CardStore;
  publishedSkills: PublishedSkillStore;
  a2aGateway: A2AGateway;
  proxy: McpProxyPool;
  runners: RunnerRegistry;
  scheduler: JobScheduler;
  workflows: WorkflowEngine;
  schedules: ScheduleStore;
  scheduleRunner: ScheduleRunner;
  /** Set once the inbound A2A listener is actually up, so tools can say so. */
  a2aServing?: boolean;
  /**
   * Post-quantum posture, parsed once at boot. `dataKey` seals artifacts and
   * memory values at rest; `cardSigner` signs our published Agent Card.
   * Absent means classical-only — the secure default is to say so, not to
   * pretend otherwise (see orchestrator_status `pqc`).
   */
  pqc: { dataKey?: PqcDataKey; cardSigner?: { secretKey: Uint8Array; kid: string } };
}

export interface CreateServicesInput {
  config: Config;
  db: Db;
  logger: Logger;
  /** Lets tests point the A2A gateway at an in-repo fixture agent. */
  a2aClientProvider?: ClientProvider;
  /** Lets tests compress the transient-retry backoff into milliseconds. */
  retry?: { maxRetries?: number; baseDelayMs?: number };
  /** Lets tests capture webhook delivery instead of hitting the network. */
  notifyFetch?: typeof fetch;
  /** Lets tests lock webhook callbacks to a host allow-list. */
  webhookAllowedHosts?: readonly string[];
  /**
   * Job-lease timings. The defaults suit every deployment — a lease is renewed
   * while the job runs, so a long job never expires one — and exist here so a
   * test can compress minutes into milliseconds.
   */
  lease?: { heartbeatMs?: number; expiresAfterMs?: number; cancelPollMs?: number };
}

/**
 * Built once per process and shared by every serving unit. These are long-lived
 * handles, not per-request state — nothing here is keyed by connection.
 */
export function createServices({
  config,
  db,
  logger,
  a2aClientProvider,
  lease,
  retry,
  notifyFetch,
  webhookAllowedHosts
}: CreateServicesInput): Services {
  const events = new EventLog(db);
  const grants = new GrantStore(db);
  const agents = new AgentRegistry(db, grants, config.disabledTemplates);
  const jobs = new JobStore(db);
  // A malformed key bundle fails the boot, not the first sealed read months
  // later — half-keyed encryption is worse than none, because it looks safe.
  let dataKey: PqcDataKey | undefined;
  if (config.pqcDataKey !== undefined) dataKey = parseDataKey(config.pqcDataKey);
  let cardSigner: { secretKey: Uint8Array; kid: string } | undefined;
  if (config.pqcSigningKey !== undefined) {
    let secretKey: Uint8Array;
    try {
      secretKey = new Uint8Array(Buffer.from(config.pqcSigningKey, 'base64'));
    } catch {
      throw new Error('ORCH_PQC_SIGNING_KEY is not base64.');
    }
    // An ML-DSA-65 secret key is exactly 4032 bytes. Anything else would boot
    // fine and then fail inside every card build — a 500 on a2a_server_info
    // and the card endpoint months later, instead of one clear boot error now.
    if (secretKey.length !== 4032) {
      throw new Error(
        `ORCH_PQC_SIGNING_KEY decodes to ${secretKey.length} bytes, not the 4032 of an ML-DSA-65 secret key.`
      );
    }
    cardSigner = { secretKey, kid: config.pqcSigningKid ?? 'pqc-1' };
  }
  const memory = new MemoryStore(db, grants, { ...(dataKey !== undefined && { dataKey }) });
  const artifacts = new ArtifactStore(db, { ...(dataKey !== undefined && { dataKey }) });
  const bus = new MessageBus(db);
  const budgets = new BudgetTracker(db);
  const approvals = new ApprovalStore(db, events);
  const templates = new TemplateStore(db);
  const presets = new GrantPresetStore(db);
  const webhooks = new WebhookStore(db);
  // Saved templates shadow built-ins wherever a template name is resolved.
  agents.resolveTemplate = name => templates.resolve(name);
  const cards = new CardStore(db);
  const publishedSkills = new PublishedSkillStore(db);

  const a2aGateway = new A2AGateway({
    db,
    cards,
    logger,
    trustMode: config.a2aTrustMode,
    allowedWebhookHosts: config.a2aWebhookAllowedHosts,
    approvals,
    ...(a2aClientProvider !== undefined && { clientProvider: a2aClientProvider })
  });

  const proxy = new McpProxyPool(db, logger);

  const runners = new RunnerRegistry([
    new MockRunner(),
    // Request-bound borrowing never flows through the registry: without a
    // live client there is nothing to sample from, so this instance only
    // exists to fail detached sampling jobs with a clear reason.
    new SamplingRunner({
      sampler: () =>
        Promise.reject(
          new OrchestratorError(
            'RUNNER_FAILED',
            'Sampling needs a live legacy (pre-2026-07-28) client request.',
            'Use delegate with wait, or point a runner at a model endpoint instead.'
          )
        )
    }),
    new AnthropicRunner({
      ...(config.anthropicApiKey !== undefined && { apiKey: config.anthropicApiKey }),
      ...(config.anthropicModel !== undefined && { defaultModel: config.anthropicModel })
    }),
    new OpenAiCompatibleRunner({
      ...(config.openaiApiKey !== undefined && { apiKey: config.openaiApiKey }),
      ...(config.openaiBaseUrl !== undefined && { baseUrl: config.openaiBaseUrl }),
      ...(config.openaiModel !== undefined && { defaultModel: config.openaiModel })
    }),
    new CliRunner({
      workspaceDirs: config.cliWorkspaceDirs,
      allowNetwork: config.cliAllowNetwork,
      args: config.cliArgs,
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
    approvals,
    logger,
    a2aGateway,
    proxy,
    maxConcurrency: config.maxConcurrency,
    maxDepth: config.maxDepth,
    defaultRunner: config.defaultRunner,
    retry: { maxRetries: config.runnerRetries, ...(retry ?? {}) },
    // The cancel poll rides the same override shape as the lease clock: the
    // config sets the production cadence, tests compress it.
    lease: { cancelPollMs: config.cancelPollSec * 1000, ...(lease ?? {}) },
    webhooks,
    allowedWebhookHosts: webhookAllowedHosts ?? config.webhookAllowedHosts,
    ...(notifyFetch !== undefined && { notifyFetch })
  });

  const workflows = new WorkflowEngine({
    db,
    jobs,
    scheduler,
    agents,
    approvals,
    artifacts,
    grants,
    webhooks,
    webhookAllowedHosts: webhookAllowedHosts ?? config.webhookAllowedHosts,
    ...(notifyFetch !== undefined && { webhookFetch: notifyFetch }),
    events,
    logger,
    defaultRunner: config.defaultRunner
  });

  const schedules = new ScheduleStore(db);
  const scheduleRunner = new ScheduleRunner({
    db,
    store: schedules,
    agents,
    events,
    submit: input => scheduler.submit(input),
    defaultRunner: config.defaultRunner,
    logger,
    tickMs: config.scheduleTickSec * 1000
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
    templates,
    presets,
    webhooks,
    cards,
    publishedSkills,
    a2aGateway,
    proxy,
    runners,
    scheduler,
    workflows,
    schedules,
    scheduleRunner,
    pqc: {
      ...(dataKey !== undefined && { dataKey }),
      ...(cardSigner !== undefined && { cardSigner })
    }
  };
}
