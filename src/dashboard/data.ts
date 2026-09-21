import { getSchemaVersion } from '../db/migrate.js';
import { LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import { SINGLE_OWNER, ownerFilter, type Principal } from '../core/principal.js';
import { buildStatus } from '../core/status.js';
import type { Services } from '../services.js';

/**
 * The unauthenticated HTTP dashboard (`GET /dashboard`) derives no identity
 * from a token — there is none — so it reads as a non-admin single owner.
 * In a single-owner deployment (no OAuth) every row belongs to `''` and the
 * page shows everything; once OAuth is on it shows only admin-shared rows
 * plus `''`-owned ones, never another owner's private agents, jobs, memory
 * or artifacts. The authenticated path is the `orch://dashboard` resource,
 * which collects with the caller's own principal instead.
 */
export const DASHBOARD_HTTP_PRINCIPAL: Principal = { ownerId: SINGLE_OWNER, isAdmin: false };

export type DashboardAgent = {
  id: string;
  name: string;
  kind: string;
  role?: string;
  runner?: string;
  model?: string;
  trustLevel?: string;
  /** 'you own it' | 'shared · admin' | 'shared with you'. */
  access: string;
  sharedBy?: string;
  enabled: boolean;
};

export type DashboardJob = {
  id: string;
  state: string;
  agentId?: string;
  agentName: string;
  backend: string;
  summary: string;
  /** Set for spawned/fanned-out children — the edge of the delegation graph. */
  parentJobId?: string;
  /** Present when the job settled failed/cancelled/timed_out — the reason, alongside the state pill. */
  error?: { code: string; message: string };
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
};

export type DashboardStep = { stepId: string; state: string; error?: { code: string; message: string } };
export type DashboardRun = {
  runId: string;
  name: string;
  state: string;
  ownerId: string;
  steps: DashboardStep[];
  updatedAt: string;
};
export type DashboardDefinition = { id: string; name: string; steps: string[] };

export type DashboardApproval = { approvalId: string; scope: string; summary: string };
export type DashboardSchedule = {
  scheduleId: string;
  name: string;
  cron: string;
  timezone?: string;
  target: string;
  nextRunAt: string;
  overlap: string;
  enabled: boolean;
};
export type DashboardArtifact = {
  artifactId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
};
export type DashboardBudget = {
  scope: string;
  scopeId?: string;
  maxCostUsd?: number;
  maxTokens?: number;
  maxCalls?: number;
  maxConcurrent?: number;
};
export type DashboardEvent = { ts: string; type: string; label: string };
export type DashboardToolServer = {
  name: string;
  transport: string;
  /** Tools gated behind a human on this server — shown as tags, never the connection itself. */
  requireApprovalFor: string[];
};

export type DashboardData = {
  generatedAt: string;
  status: ReturnType<typeof buildStatus>;
  agents: DashboardAgent[];
  templateNames: string[];
  jobs: DashboardJob[];
  runs: DashboardRun[];
  definitions: DashboardDefinition[];
  approvals: DashboardApproval[];
  schedules: DashboardSchedule[];
  namespaces: string[];
  artifacts: DashboardArtifact[];
  /** Caps only, and only when the principal is an admin — same gate as budget_set. */
  budgets: DashboardBudget[];
  recentTotals: { jobs: number; inputTokens: number; outputTokens: number; costUsd: number };
  events: DashboardEvent[];
  /** Names and transport kinds only — never commands, urls or authRefs. Admins only. */
  toolservers: DashboardToolServer[];
  a2aEnabled: boolean;
  /** Whether the HTTP API needs `Authorization: Bearer` — the page asks then. */
  auth: { required: boolean };
};

export interface DashboardContext {
  version: string;
  startedAt: number;
  era: string;
  /** Whether the HTTP API needs a bearer token — the page then asks for one. */
  authRequired: boolean;
}

/** Shorten a long id the way the mockup does (`job_04J…`). */
export function shortId(id: string): string {
  return id.length > 7 ? `${id.slice(0, 7)}…` : id;
}

function jobSummary(job: {
  state: string;
  instruction: string;
  resultText?: string;
  error?: { message?: string };
  remoteTaskId?: string;
}): string {
  const text = (job.resultText ?? '').trim();
  if (text !== '') return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  if (job.error !== undefined) return job.error.message ?? 'failed';
  if (job.remoteTaskId !== undefined) return `remote task ${shortId(job.remoteTaskId)}`;
  return job.instruction.length > 90 ? `${job.instruction.slice(0, 90)}…` : job.instruction;
}

function eventLabel(event: {
  type: string;
  jobId?: string;
  agentId?: string;
  runId?: string;
  payload: Record<string, unknown>;
}): string {
  const target = event.jobId ?? event.agentId ?? event.runId ?? '';
  const detail =
    typeof event.payload['message'] === 'string'
      ? event.payload['message']
      : typeof event.payload['summary'] === 'string'
        ? event.payload['summary']
        : '';
  const suffix = detail.length > 80 ? `${detail.slice(0, 80)}…` : detail;
  return `${event.type} ${shortId(target)}${suffix === '' ? '' : ` — ${suffix}`}`.trim();
}

/**
 * One read-only pass over the stores the mockup's seven tabs need. Every
 * listing goes through the caller's principal exactly like the matching tool
 * does — the dashboard is a view, never a wider door than the tools.
 */
export async function collectDashboardData(
  services: Services,
  principal: Principal,
  ctx: DashboardContext
): Promise<DashboardData> {
  const { agents, jobs, approvals, schedules, memory, artifacts, budgets, events, proxy, templates, workflows } =
    services;

  const [agentPage, jobPage, runList, pendingApprovals, templateList, definitions] = await Promise.all([
    agents.list({ ...ownerFilter(principal), limit: 100 }),
    jobs.list({ ...ownerFilter(principal), limit: 20 }),
    workflows.listRuns({ limit: 5, ...(principal.isAdmin ? {} : { ownerId: principal.ownerId }) }),
    approvals.list({ status: 'pending', limit: 50 }, principal),
    templates.all(),
    workflows.listWorkflows(20, principal.isAdmin ? undefined : principal.ownerId)
  ]);

  const [queued, running, blocked] = await Promise.all([
    jobs.countByState('queued'),
    jobs.countByState('running'),
    jobs.countByState('blocked')
  ]);

  const [scheduleList, namespaceList, artifactList, eventList] = await Promise.all([
    schedules.list(50, principal.isAdmin ? undefined : principal.ownerId),
    memory.listNamespaces(principal.ownerId),
    artifacts.list({ ...ownerFilter(principal), limit: 20 }),
    events.query({ limit: 12, ...ownerFilter(principal) })
  ]);

  // Budgets and downstream-server connection details are admin-gated reads,
  // mirroring budget_set and toolserver_list — a non-admin dashboard omits
  // the sections rather than showing a redacted row.
  const [budgetList, toolserverList] = await Promise.all([
    principal.isAdmin ? budgets.list() : Promise.resolve([]),
    principal.isAdmin ? proxy.list() : Promise.resolve([])
  ]);

  const status = buildStatus({
    version: ctx.version,
    profile: services.config.toolProfile,
    transport: services.config.transport,
    protocolEra: ctx.era,
    schemaVersion: await getSchemaVersion(services.db),
    latestSchemaVersion: LATEST_SCHEMA_VERSION,
    a2aEnabled: services.config.a2aEnabled,
    maxConcurrency: services.config.maxConcurrency,
    maxDepth: services.config.maxDepth,
    uptimeSec: (Date.now() - ctx.startedAt) / 1000,
    jobs: { queued, running, blocked },
    caller: { ownerId: principal.ownerId, isAdmin: principal.isAdmin },
    pqc: {
      atRest: services.pqc.dataKey !== undefined,
      cardSigned: services.pqc.cardSigner !== undefined
    }
  });

  const recentTotals = jobPage.jobs.reduce(
    (totals, job) => ({
      jobs: totals.jobs + 1,
      inputTokens: totals.inputTokens + (job.usage?.inputTokens ?? 0),
      outputTokens: totals.outputTokens + (job.usage?.outputTokens ?? 0),
      costUsd: totals.costUsd + (job.usage?.costUsd ?? 0)
    }),
    { jobs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  );

  return {
    generatedAt: new Date().toISOString(),
    status,
    agents: agentPage.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      ...(agent.role !== undefined && { role: agent.role }),
      ...(agent.runner !== undefined && { runner: agent.runner }),
      ...(agent.model !== undefined && { model: agent.model }),
      ...(agent.trustLevel !== undefined && { trustLevel: agent.trustLevel }),
      // Credentials never leave the store: each registration owns its own
      // credentialsRef and the dashboard has no business showing even the
      // reference, let alone the secret behind it.
      access:
        agent.ownerId === principal.ownerId
          ? 'you own it'
          : agent.ownerId === SINGLE_OWNER
            ? 'shared · admin'
            : 'shared with you',
      ...(agent.ownerId !== principal.ownerId &&
        agent.ownerId !== SINGLE_OWNER && { sharedBy: agent.ownerId }),
      enabled: agent.enabled
    })),
    templateNames: templateList.map(template => template.name),
    jobs: jobPage.jobs.map(job => ({
      id: job.id,
      state: job.state,
      agentId: job.agentId,
      agentName: job.agentSnapshot.name,
      backend: job.backend,
      summary: jobSummary(job),
      ...(job.parentJobId !== undefined && { parentJobId: job.parentJobId }),
      ...(job.error !== undefined && { error: { code: job.error.code, message: job.error.message } }),
      ...(job.usage !== undefined && {
        usage: {
          ...(job.usage.inputTokens !== undefined && { inputTokens: job.usage.inputTokens }),
          ...(job.usage.outputTokens !== undefined && { outputTokens: job.usage.outputTokens }),
          ...(job.usage.costUsd !== undefined && { costUsd: job.usage.costUsd })
        }
      })
    })),
    runs: runList.map(run => ({
      runId: run.runId,
      name: run.name,
      state: run.state,
      ownerId: run.ownerId,
      steps: run.steps.map(step => ({
        stepId: step.stepId,
        state: step.state,
        ...(step.error !== undefined && { error: { code: step.error.code, message: step.error.message } })
      })),
      updatedAt: run.updatedAt
    })),
    definitions: definitions.map(definition => ({
      id: definition.workflowId,
      name: definition.name,
      steps: definition.spec.steps.map(step => step.id)
    })),
    approvals: pendingApprovals.map(approval => ({
      approvalId: approval.approvalId,
      scope: approval.scope,
      summary: approval.summary
    })),
    schedules: scheduleList.map(schedule => ({
      scheduleId: schedule.scheduleId,
      name: schedule.name,
      cron: schedule.cron,
      ...(schedule.timezone !== undefined && { timezone: schedule.timezone }),
      target: schedule.agentId ?? schedule.template ?? 'default',
      nextRunAt: schedule.nextRunAt,
      overlap: schedule.overlap,
      enabled: schedule.enabled
    })),
    namespaces: namespaceList,
    artifacts: artifactList.map(artifact => ({
      artifactId: artifact.artifactId,
      name: artifact.name,
      sizeBytes: artifact.sizeBytes,
      mimeType: artifact.mimeType,
      createdAt: artifact.createdAt
    })),
    budgets: budgetList.map(budget => ({
      scope: budget.scope,
      ...(budget.scopeId !== undefined && { scopeId: budget.scopeId }),
      ...(budget.maxCostUsd !== undefined && { maxCostUsd: budget.maxCostUsd }),
      ...(budget.maxTokens !== undefined && { maxTokens: budget.maxTokens }),
      ...(budget.maxCalls !== undefined && { maxCalls: budget.maxCalls }),
      ...(budget.maxConcurrent !== undefined && { maxConcurrent: budget.maxConcurrent })
    })),
    recentTotals,
    events: eventList.map(event => ({ ts: event.ts, type: event.type, label: eventLabel(event) })),
    toolservers: toolserverList.map(server => ({
      name: server.name,
      transport: server.transport.type,
      requireApprovalFor: [...server.requireApprovalFor]
    })),
    a2aEnabled: services.config.a2aEnabled,
    auth: { required: ctx.authRequired }
  };
}
