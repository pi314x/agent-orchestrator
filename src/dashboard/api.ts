import type { IncomingMessage, ServerResponse } from 'node:http';
import { OAuthError, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { ZodError } from 'zod';
import { principalFor } from '../auth.js';
import { APPROVAL_SCOPES, APPROVAL_STATUSES } from '../core/approvals.js';
import { ownerFilter, SINGLE_OWNER, type Principal } from '../core/principal.js';
import { resolveAgentTarget, toSnapshot, type AgentLimits } from '../core/registry.js';
import { RUNNER_NAMES, type RunnerName } from '../core/templates.js';
import { getSchemaVersion } from '../db/migrate.js';
import { LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import { OrchestratorError } from '../errors.js';
import { JOB_STATES, type JobState } from '../core/jobs.js';
import { isSharedWithViewer, toAgentView, toJobView, AgentLimitsInputSchema } from '../schemas/common.js';
import { isApprovalVisible } from '../tools/approvals.js';
import { SpecSchema } from '../tools/workflows.js';
import type { Services } from '../services.js';
import { buildStatus } from '../core/status.js';
import { OVERLAP_POLICIES } from '../core/schedules.js';
import { previewCronRuns } from '../core/cron.js';
import { pruneOldData } from '../core/maintenance.js';
import { RUN_STATES, type WorkflowSpec } from '../core/workflow-engine.js';
import type { ToolServerTransport } from '../proxy/pool.js';

/**
 * The dashboard's write path: the same owner-scoped store calls the MCP
 * tools use, over plain HTTPS. Every endpoint below mirrors its tool
 * sibling's checks in the same order (visibility first, then the action) —
 * change one and check the other, or the two surfaces drift apart.
 *
 * Authentication mirrors the tools' posture exactly: without OAuth there is
 * no caller identity and everything is open (the loopback default); with
 * OAuth the browser sends `Authorization: Bearer <token>` (kept in
 * sessionStorage by the dashboard page, never in a cookie, so there is
 * nothing for CSRF to ride on) and the principal derives from the verified
 * token, admin scope included. There is deliberately no session, no cookie
 * and no second identity system.
 */

export interface ApiOptions {
  services: Services;
  version: string;
  startedAt: number;
  verifier?: OAuthTokenVerifier;
}

const MAX_BODY_BYTES = 1_000_000;

/** Throw these (or OrchestratorError) from handlers; the router maps both. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  POLICY_DENIED: 403,
  BUDGET_EXCEEDED: 409,
  DEPTH_EXCEEDED: 400,
  TIMEOUT: 408
};

function errorToResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ApiFailure) {
    return {
      status: error.status,
      body:
        error.hint === undefined
          ? { error: error.code, message: error.message }
          : { error: error.code, message: error.message, hint: error.hint }
    };
  }
  if (error instanceof OrchestratorError) {
    const payload = error.toPayload();
    return {
      status: STATUS_BY_CODE[error.code] ?? 500,
      body: { ...payload, error: payload.code }
    };
  }
  if (error instanceof OAuthError) return { status: 401, body: { error: 'invalid_token', message: error.message } };
  // Shared input schemas (agent limits today) validate like the tools do;
  // their failures are client errors, never 500s.
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return {
      status: 400,
      body: {
        error: 'INVALID_INPUT',
        message: first === undefined ? 'Invalid input.' : `${first.path.join('.') || 'input'}: ${first.message}`
      }
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: 'internal', message } };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new OrchestratorError('INVALID_INPUT', 'Request body too large.'));
        req.destroy();
        return;
      }
      raw += chunk.toString();
    });
    req.on('end', () => {
      if (raw === '') return resolve({});
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new OrchestratorError('INVALID_INPUT', 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function str(value: unknown, field: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new OrchestratorError('INVALID_INPUT', `"${field}" must be a non-empty string.`);
  }
  return value;
}

/**
 * The same shape toolserver_register validates with Zod — hand-rolled here
 * like every other dashboard input, since the API parses plain JSON bodies.
 */
function parseTransport(value: unknown): ToolServerTransport {
  if (typeof value !== 'object' || value === null) {
    throw new OrchestratorError('INVALID_INPUT', '"transport" must be an object with type "stdio" or "http".');
  }
  const input = value as Record<string, unknown>;
  if (input['type'] === 'stdio') {
    if (typeof input['command'] !== 'string' || input['command'].trim() === '') {
      throw new OrchestratorError('INVALID_INPUT', 'A stdio transport needs a non-empty "command".');
    }
    const args = input['args'];
    if (args !== undefined && (!Array.isArray(args) || args.some(a => typeof a !== 'string'))) {
      throw new OrchestratorError('INVALID_INPUT', '"args" must be an array of strings.');
    }
    return {
      type: 'stdio',
      command: (input['command'] as string).trim(),
      ...((args as string[] | undefined) !== undefined && { args: (args as string[]).map(String) }),
      ...(typeof input['cwd'] === 'string' && input['cwd'] !== '' && { cwd: input['cwd'] })
    };
  }
  if (input['type'] === 'http') {
    if (typeof input['url'] !== 'string' || input['url'].trim() === '') {
      throw new OrchestratorError('INVALID_INPUT', 'An http transport needs a "url".');
    }
    try {
      new URL(input['url'] as string);
    } catch {
      throw new OrchestratorError('INVALID_INPUT', `"url" is not a valid URL: ${input['url']}.`);
    }
    return { type: 'http', url: (input['url'] as string).trim() };
  }
  throw new OrchestratorError('INVALID_INPUT', '"transport.type" must be "stdio" or "http".');
}

function asRunnerName(value: unknown): RunnerName | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(RUNNER_NAMES as readonly string[]).includes(value)) {
    throw new OrchestratorError(
      'INVALID_INPUT',
      `"runner" must be one of ${(RUNNER_NAMES as readonly string[]).join(', ')}.`
    );
  }
  return value as RunnerName;
}

async function principalForRequest(
  req: IncomingMessage,
  verifier: OAuthTokenVerifier | undefined
): Promise<Principal> {
  // No OAuth, no identity — everything open, exactly like the tools.
  if (verifier === undefined) return principalFor(undefined);

  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ') || header.length <= 'Bearer '.length) {
    throw new ApiFailure(401, 'unauthorized', 'Pass Authorization: Bearer <token>.');
  }
  try {
    return principalFor(await verifier.verifyAccessToken(header.slice('Bearer '.length)));
  } catch (error) {
    if (error instanceof OAuthError) throw new ApiFailure(401, 'invalid_token', error.message);
    throw error;
  }
}

function asLimits(value: unknown): { limits?: AgentLimits } {
  if (value === undefined) return {};
  // The same schema the tools validate with — a bound skipped here would
  // store garbage the views echo and the scheduler chokes on.
  return { limits: AgentLimitsInputSchema.parse(value) as AgentLimits };
}

function asJobState(value: string | null): { state?: JobState } {
  if (value === null) return {};
  if (!(JOB_STATES as readonly string[]).includes(value)) {
    throw new OrchestratorError('INVALID_INPUT', `"state" must be one of ${JOB_STATES.join(', ')}.`);
  }
  return { state: value as JobState };
}

function asApprovalStatus(value: string): (typeof APPROVAL_STATUSES)[number] {
  if (!(APPROVAL_STATUSES as readonly string[]).includes(value)) {
    throw new OrchestratorError('INVALID_INPUT', '"status" must be pending, approved or rejected.');
  }
  return value as (typeof APPROVAL_STATUSES)[number];
}

function asApprovalScope(value: string): (typeof APPROVAL_SCOPES)[number] {
  if (!(APPROVAL_SCOPES as readonly string[]).includes(value)) {
    throw new OrchestratorError('INVALID_INPUT', `"scope" must be one of ${APPROVAL_SCOPES.join(', ')}.`);
  }
  return value as (typeof APPROVAL_SCOPES)[number];
}

function requireAdmin(principal: Principal, what: string): void {
  if (!principal.isAdmin) {
    throw new OrchestratorError('POLICY_DENIED', `${what} needs the orch:admin scope.`);
  }
}

/**
 * A boolean flag from the body or the query string — both, because Node's
 * own http client silently drops request bodies on DELETE (no
 * Transfer-Encoding is ever sent), while fetch and curl deliver them fine.
 * Destructive routes must stay callable from either.
 */
function flag(body: unknown, query: URLSearchParams, name: string): boolean {
  if (query.get(name) === 'true') return true;
  const input = body as Record<string, unknown>;
  return typeof input === 'object' && input !== null && (input as Record<string, unknown>)[name] === true;
}

/** Resolve like delegate/job_submit do: visibility-checked, owner-stamped. */
async function resolveTarget(
  services: Services,
  principal: Principal,
  ref: { agentId?: unknown; template?: unknown; skillQuery?: unknown },
  overrides: { runner?: unknown; model?: unknown }
) {
  return resolveAgentTarget(
    services.agents,
    {
      ...(typeof ref.agentId === 'string' && { agentId: ref.agentId }),
      ...(typeof ref.template === 'string' && { template: ref.template }),
      ...(typeof ref.skillQuery === 'string' && { skillQuery: ref.skillQuery })
    },
    {
      runner: asRunnerName(overrides.runner) ?? services.config.defaultRunner,
      ...(typeof overrides.model === 'string' && { model: overrides.model })
    },
    principal
  );
}

type Route = {
  method: string;
  pattern: RegExp;
  run: (ctx: RouteContext, match: RegExpMatchArray, query: URLSearchParams) => Promise<unknown>;
};

type RouteContext = { services: Services; principal: Principal; version: string; startedAt: number; body: unknown };

const num = (value: string | null, fallback: number, max: number, min = 1): number => {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new OrchestratorError('INVALID_INPUT', 'Pagination values must be positive integers.');
  }
  return Math.min(parsed, max);
};

const agentViewOf = (principal: Principal, agent: Parameters<typeof toAgentView>[0]) =>
  toAgentView(agent, { sharedWithYou: isSharedWithViewer(agent, principal) });

const routes: Route[] = [
  // -- status -------------------------------------------------------------
  {
    method: 'GET',
    pattern: /^status$/,
    run: async ({ services, principal, version, startedAt }) => {
      const [queued, running, blocked] = await Promise.all([
        services.jobs.countByState('queued'),
        services.jobs.countByState('running'),
        services.jobs.countByState('blocked')
      ]);
      return buildStatus({
        version,
        profile: services.config.toolProfile,
        transport: services.config.transport,
        protocolEra: 'http',
        schemaVersion: await getSchemaVersion(services.db),
        latestSchemaVersion: LATEST_SCHEMA_VERSION,
        a2aEnabled: services.config.a2aEnabled,
        maxConcurrency: services.config.maxConcurrency,
        maxDepth: services.config.maxDepth,
        uptimeSec: (Date.now() - startedAt) / 1000,
        jobs: { queued, running, blocked },
        caller: { ownerId: principal.ownerId, isAdmin: principal.isAdmin },
        pqc: {
          atRest: services.pqc.dataKey !== undefined,
          cardSigned: services.pqc.cardSigner !== undefined
        }
      });
    }
  },

  // -- agents ---------------------------------------------------------------
  {
    method: 'GET',
    pattern: /^agents$/,
    run: async ({ services, principal }, _m, query) => {
      const kind = query.get('kind');
      if (kind !== null && kind !== 'local' && kind !== 'remote') {
        throw new OrchestratorError('INVALID_INPUT', '"kind" must be local or remote.');
      }
      const { agents } = await services.agents.list({
        ...ownerFilter(principal),
        ...(kind !== null && { kind }),
        limit: num(query.get('limit'), 100, 100)
      });
      return { agents: agents.map(agent => agentViewOf(principal, agent)) };
    }
  },
  {
    method: 'POST',
    pattern: /^agents$/,
    run: async ({ services, principal, body }) => {
      const input = body as Record<string, unknown>;
      const shared = input['shared'] === true;
      if (shared) requireAdmin(principal, 'Shared agents');
      const toolGrants = Array.isArray(input['toolGrants'])
        ? (input['toolGrants'] as unknown[]).map(g => String(g))
        : undefined;
      if (toolGrants !== undefined) requireAdmin(principal, 'Attaching tool grants');
      if (typeof input['grantPreset'] === 'string') requireAdmin(principal, 'Grant presets');
      let grants = toolGrants;
      if (typeof input['grantPreset'] === 'string') {
        const preset = await services.presets.get(input['grantPreset']);
        if (preset === undefined) throw new OrchestratorError('NOT_FOUND', `No grant preset named "${input['grantPreset']}".`);
        grants = [...new Set([...preset.grants, ...(toolGrants ?? [])])];
      }
      const agent = await services.agents.create({
        ownerId: shared ? SINGLE_OWNER : principal.ownerId,
        name: str(input['name'], 'name') as string,
        instructions: str(input['instructions'], 'instructions') as string,
        runner: asRunnerName(input['runner']) ?? services.config.defaultRunner,
        ...(typeof input['role'] === 'string' && { role: input['role'] }),
        ...(typeof input['model'] === 'string' && { model: input['model'] }),
        ...(grants !== undefined && { toolGrants: grants }),
        ...(typeof input['enabled'] === 'boolean' && { enabled: input['enabled'] }),
        ...asLimits(input['limits'])
      });
      return { agent: agentViewOf(principal, agent) };
    }
  },
  {
    method: 'GET',
    pattern: /^agents\/([^/]+)$/,
    run: async ({ services, principal }, match) => {
      const agent = await services.agents.getVisible(match[1] as string, principal);
      const { jobs } = await services.jobs.list({ ...ownerFilter(principal), agentId: agent.id, limit: 10 });
      return {
        agent: agentViewOf(principal, agent),
        trustLevel: agent.trustLevel ?? null,
        recentJobs: jobs.map(job => ({ jobId: job.id, state: job.state }))
      };
    }
  },
  {
    method: 'PATCH',
    pattern: /^agents\/([^/]+)$/,
    run: async ({ services, principal, body }, match) => {
      const agentId = match[1] as string;
      const input = body as { patch?: Record<string, unknown> };
      if (typeof input.patch !== 'object' || input.patch === null) {
        throw new OrchestratorError('INVALID_INPUT', '"patch" must be an object.');
      }
      if (input.patch['toolGrants'] !== undefined) requireAdmin(principal, 'Attaching tool grants');
      await services.agents.getManaged(agentId, principal);
      const agent = await services.agents.update(agentId, {
        ...(typeof input.patch['role'] === 'string' && { role: input.patch['role'] }),
        ...(typeof input.patch['instructions'] === 'string' && { instructions: input.patch['instructions'] }),
        ...(asRunnerName(input.patch['runner']) !== undefined && {
          runner: asRunnerName(input.patch['runner']) as RunnerName
        }),
        ...(typeof input.patch['model'] === 'string' && { model: input.patch['model'] }),
        ...(Array.isArray(input.patch['toolGrants']) && {
          toolGrants: (input.patch['toolGrants'] as unknown[]).map(g => String(g))
        }),
        ...(typeof input.patch['enabled'] === 'boolean' && { enabled: input.patch['enabled'] }),
        ...asLimits(input.patch['limits'])
      });
      return { agent: agentViewOf(principal, agent) };
    }
  },
  {
    method: 'DELETE',
    pattern: /^agents\/([^/]+)$/,
    run: async ({ services, principal, body }, match, query) => {
      const agentId = match[1] as string;
      const force = flag(body, query, 'force');
      // No MRTR over plain HTTP: destructive calls carry their own explicit
      // confirmation instead of a two-step prompt.
      if (!flag(body, query, 'confirm')) {
        throw new ApiFailure(400, 'confirm_required', 'Pass { "confirm": true } to delete this agent.', 'Re-send the same request with confirm: true.');
      }
      const agent = await services.agents.getManaged(agentId, principal);
      const { jobs: agentJobs } = await services.jobs.list({ agentId: agent.id, limit: 100 });
      const live = agentJobs.filter(job => job.finishedAt === undefined);
      if (live.length > 0 && !force) {
        throw new OrchestratorError(
          'CONFLICT',
          `${agent.name} still has ${live.length} live job(s).`,
          'Pass force: true to cancel them, or wait for them to finish.'
        );
      }
      const cancelledJobs: string[] = [];
      for (const job of live) {
        await services.scheduler.cancel(job.id, 'Agent deleted.');
        cancelledJobs.push(job.id);
      }
      const deleted = await services.agents.delete(agent.id);
      return { deleted, cancelledJobs };
    }
  },
  {
    method: 'GET',
    pattern: /^agents\/([^/]+)\/shares$/,
    run: async ({ services, principal }, match) => {
      // listShares already requires managing the agent.
      const shares = await services.agents.listShares(match[1] as string, principal);
      return { grantees: shares.map(s => s.granteeId), shares };
    }
  },
  {
    method: 'POST',
    pattern: /^agents\/([^/]+)\/share$/,
    run: async ({ services, principal, body }, match) => {
      const agentId = match[1] as string;
      const granteeId = str((body as Record<string, unknown>)['granteeId'], 'granteeId') as string;
      await services.agents.share(agentId, principal, granteeId);
      return { shared: true, status: 'pending' };
    }
  },
  {
    method: 'POST',
    pattern: /^agents\/([^/]+)\/accept$/,
    run: async ({ services, principal }, match) => {
      await services.agents.acceptShare(match[1] as string, principal);
      return { accepted: true };
    }
  },
  {
    method: 'POST',
    pattern: /^agents\/([^/]+)\/reject$/,
    run: async ({ services, principal }, match) => {
      return { rejected: await services.agents.rejectShare(match[1] as string, principal) };
    }
  },
  {
    method: 'GET',
    pattern: /^shares\/incoming$/,
    run: async ({ services, principal }) => {
      const [agents, workflows, namespaces] = await Promise.all([
        services.agents.listIncoming(principal),
        services.workflows.listIncoming(principal),
        services.memory.listIncoming(principal.ownerId)
      ]);
      return { agents, workflows, namespaces };
    }
  },
  {
    method: 'DELETE',
    pattern: /^agents\/([^/]+)\/share\/([^/]+)$/,
    run: async ({ services, principal }, match) => {
      const agentId = match[1] as string;
      const granteeId = decodeURIComponent(match[2] as string);
      return { revoked: await services.agents.unshare(agentId, principal, granteeId) };
    }
  },

  // -- jobs -----------------------------------------------------------------
  {
    method: 'GET',
    pattern: /^jobs$/,
    run: async ({ services, principal }, _m, query) => {
      const { jobs, nextCursor } = await services.jobs.list({
        ...ownerFilter(principal),
        ...asJobState(query.get('state')),
        ...(query.get('agentId') !== null && { agentId: query.get('agentId') as string }),
        ...(query.get('cursor') !== null && { cursor: query.get('cursor') as string }),
        limit: num(query.get('limit'), 20, 100)
      });
      return { jobs: jobs.map(toJobView), ...(nextCursor !== undefined && { nextCursor }) };
    }
  },
  {
    method: 'POST',
    pattern: /^jobs$/,
    run: async ({ services, principal, body }) => {
      const input = body as Record<string, unknown>;
      // Required fields first, so a missing instruction is a 400 even when
      // the agent reference is also bad — same precedence the SDK's input
      // validation gives the tools.
      const instruction = str(input['instruction'], 'instruction') as string;
      // Mirror job_submit: dependency ids are caller-supplied and resolved on
      // every pump, so each one is visibility-checked up front.
      for (const depId of Array.isArray(input['dependsOn']) ? (input['dependsOn'] as unknown[]) : []) {
        if (typeof depId !== 'string') throw new OrchestratorError('INVALID_INPUT', '"dependsOn" must be job id strings.');
        await services.jobs.getVisible(depId, principal);
      }
      const agent = await resolveTarget(services, principal, input, input);
      const job = await services.scheduler.submit({
        ownerId: principal.ownerId,
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: {
          ...toSnapshot(agent),
          ...(asRunnerName(input['runner']) !== undefined && {
            runner: asRunnerName(input['runner']) as RunnerName
          }),
          ...(typeof input['model'] === 'string' && { model: input['model'] })
        },
        instruction,
        ...(typeof input['context'] === 'object' && input['context'] !== null && {
          context: input['context'] as Record<string, unknown>
        }),
        ...(typeof input['outputSchema'] === 'object' && input['outputSchema'] !== null && {
          outputSchema: input['outputSchema'] as Record<string, unknown>
        }),
        ...(Array.isArray(input['dependsOn']) && { dependsOn: (input['dependsOn'] as unknown[]).map(String) }),
        ...(typeof input['priority'] === 'number' && { priority: input['priority'] }),
        ...(typeof input['timeoutSec'] === 'number' && { timeoutSec: input['timeoutSec'] }),
        ...(typeof input['idempotencyKey'] === 'string' && { idempotencyKey: input['idempotencyKey'] })
      });
      return { job: toJobView(job) };
    }
  },
  {
    method: 'GET',
    pattern: /^jobs\/([^/]+)$/,
    run: async ({ services, principal }, match) => {
      return { job: toJobView(await services.jobs.getVisible(match[1] as string, principal)) };
    }
  },
  {
    method: 'POST',
    pattern: /^jobs\/([^/]+)\/cancel$/,
    run: async ({ services, principal, body }, match) => {
      const jobId = match[1] as string;
      const reason = (body as Record<string, unknown>)['reason'];
      await services.jobs.getVisible(jobId, principal);
      const job = await services.scheduler.cancel(
        jobId,
        ...(typeof reason === 'string' ? [reason] : [])
      );
      return { job: toJobView(job) };
    }
  },
  {
    method: 'POST',
    pattern: /^jobs\/([^/]+)\/retry$/,
    run: async ({ services, principal }, match) => {
      const jobId = match[1] as string;
      await services.jobs.getVisible(jobId, principal);
      return { job: toJobView(await services.scheduler.retry(jobId)) };
    }
  },
  {
    method: 'POST',
    pattern: /^jobs\/([^/]+)\/steer$/,
    run: async ({ services, principal, body }, match) => {
      const jobId = match[1] as string;
      const message = str((body as Record<string, unknown>)['message'], 'message') as string;
      const job = await services.jobs.getVisible(jobId, principal);
      if (job.finishedAt !== undefined) {
        throw new OrchestratorError(
          'CONFLICT',
          `Job ${job.id} already finished (${job.state}).`,
          'Submit a new job with the revised instruction.'
        );
      }
      if (job.backend === 'a2a_remote') {
        throw new OrchestratorError(
          'INVALID_INPUT',
          'This remote agent does not advertise steering.',
          'Cancel the job and submit a revised one instead.'
        );
      }
      await services.bus.send({ toJobId: job.id, toAgentId: job.agentId, body: message });
      await services.events.append({
        type: 'job.progress',
        jobId: job.id,
        payload: { message: `steered: ${message}` }
      });
      return { delivered: true, state: job.state };
    }
  },

  // -- delegate (async submit; the UI polls the job) --------------------------
  {
    method: 'POST',
    pattern: /^delegate$/,
    run: async ({ services, principal, body }) => {
      const input = body as Record<string, unknown>;
      const instruction = str(input['instruction'], 'instruction') as string;
      const agent = await resolveTarget(services, principal, input, input);
      const job = await services.scheduler.submit({
        ownerId: principal.ownerId,
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: {
          ...toSnapshot(agent),
          ...(asRunnerName(input['runner']) !== undefined && {
            runner: asRunnerName(input['runner']) as RunnerName
          }),
          ...(typeof input['model'] === 'string' && { model: input['model'] })
        },
        instruction,
        ...(typeof input['timeoutSec'] === 'number' && { timeoutSec: input['timeoutSec'] }),
        ...(typeof input['idempotencyKey'] === 'string' && { idempotencyKey: input['idempotencyKey'] })
      });
      return { job: toJobView(job) };
    }
  },

  // -- approvals --------------------------------------------------------------
  {
    method: 'GET',
    pattern: /^approvals$/,
    run: async ({ services, principal }, _m, query) => {
      const scope = query.get('scope');
      return {
        approvals: await services.approvals.list(
          {
            status: asApprovalStatus(query.get('status') ?? 'pending'),
            ...(scope !== null && { scope: asApprovalScope(scope) }),
            limit: num(query.get('limit'), 50, 100)
          },
          principal
        )
      };
    }
  },
  {
    method: 'POST',
    pattern: /^approvals\/([^/]+)\/resolve$/,
    run: async ({ services, principal, body }, match) => {
      const approvalId = match[1] as string;
      const input = body as Record<string, unknown>;
      if (input['decision'] !== 'approve' && input['decision'] !== 'reject') {
        throw new OrchestratorError('INVALID_INPUT', '"decision" must be approve or reject.');
      }
      const existing = await services.approvals.getOrThrow(approvalId);
      if (!(await isApprovalVisible({ services, principal }, existing))) {
        throw new OrchestratorError('NOT_FOUND', `No approval with id ${approvalId}.`);
      }
      const approval = await services.approvals.resolve(approvalId, input['decision'], {
        ...(typeof input['comment'] === 'string' && { comment: input['comment'] }),
        ...(typeof input['editedInput'] === 'object' && input['editedInput'] !== null && {
          editedInput: input['editedInput'] as Record<string, unknown>
        })
      });
      await services.events.append({
        type: 'approval.resolved',
        ...(approval.jobId !== undefined && { jobId: approval.jobId }),
        ...(approval.runId !== undefined && { runId: approval.runId }),
        payload: { decision: input['decision'], approvalId: approval.approvalId }
      });
      if (approval.runId !== undefined) {
        await services.workflows.control(approval.runId, 'resume');
      }
      return { approval };
    }
  },

  // -- runs & workflows ---------------------------------------------------------
  {
    method: 'GET',
    pattern: /^runs$/,
    run: async ({ services, principal }, _m, query) => {
      const state = query.get('state');
      if (state !== null && !(RUN_STATES as readonly string[]).includes(state)) {
        throw new OrchestratorError('INVALID_INPUT', `"state" must be one of ${RUN_STATES.join(', ')}.`);
      }
      return {
        runs: await services.workflows.listRuns({
          limit: num(query.get('limit'), 20, 100),
          ...(state !== null && { state: state as (typeof RUN_STATES)[number] }),
          ...(principal.isAdmin ? {} : { ownerId: principal.ownerId })
        })
      };
    }
  },
  {
    method: 'GET',
    pattern: /^runs\/([^/]+)$/,
    run: async ({ services, principal }, match) => {
      return { run: await services.workflows.getVisibleRun(match[1] as string, principal) };
    }
  },
  {
    method: 'POST',
    pattern: /^runs\/([^/]+)\/control$/,
    run: async ({ services, principal, body }, match) => {
      const runId = match[1] as string;
      const input = body as Record<string, unknown>;
      const action = input['action'];
      if (action !== 'pause' && action !== 'resume' && action !== 'cancel' && action !== 'retry_step' && action !== 'reconcile') {
        throw new OrchestratorError('INVALID_INPUT', '"action" must be pause, resume, cancel, retry_step or reconcile.');
      }
      const stepId = input['stepId'];
      if (stepId !== undefined && typeof stepId !== 'string') {
        throw new OrchestratorError('INVALID_INPUT', '"stepId" must be a string.');
      }
      // Visibility first, mirroring the tool — including for the
      // confirmation, which would otherwise leak that the run exists.
      await services.workflows.getVisibleRun(runId, principal);
      // No MRTR over plain HTTP: cancelling discards in-flight work, so it
      // carries its own explicit confirmation like agent_delete does.
      if (action === 'cancel' && (body as Record<string, unknown>)['confirm'] !== true) {
        throw new ApiFailure(400, 'confirm_required', 'Pass { "action": "cancel", "confirm": true } to cancel this run.', 'Re-send the same request with confirm: true.');
      }
      if (action === 'reconcile') {
        const { run, reconciled } = await services.workflows.reconcile(
          runId,
          typeof stepId === 'string' ? stepId : undefined,
          principal
        );
        return { run, reconciled };
      }
      const run = await services.workflows.control(
        runId,
        action,
        typeof stepId === 'string' ? stepId : undefined,
        principal
      );
      return { run };
    }
  },
  {
    method: 'POST',
    pattern: /^runs\/([^/]+)\/export$/,
    run: async ({ services, principal }, match) => {
      const exported = await services.workflows.exportRun(match[1] as string, principal);
      const { content } = await services.artifacts.readVisible(exported.artifactId, principal);
      return { artifactId: exported.artifactId, content };
    }
  },
  {
    method: 'GET',
    pattern: /^workflows$/,
    run: async ({ services, principal }, _m, query) => {
      return {
        workflows: await services.workflows.listWorkflows(
          num(query.get('limit'), 20, 100),
          principal.isAdmin ? undefined : principal.ownerId
        )
      };
    }
  },
  {
    method: 'GET',
    pattern: /^workflows\/([^/]+)$/,
    run: async ({ services, principal }, match) => {
      return { workflow: await services.workflows.getVisibleWorkflow(match[1] as string, principal) };
    }
  },
  {
    method: 'DELETE',
    pattern: /^workflows\/([^/]+)$/,
    run: async ({ services, principal, body }, match, query) => {
      if (!flag(body, query, 'confirm')) {
        throw new ApiFailure(400, 'confirm_required', 'Pass { "confirm": true } to delete this definition.', 'Re-send the same request with confirm: true.');
      }
      return { deleted: await services.workflows.deleteWorkflow(match[1] as string, principal) };
    }
  },
  {
    method: 'POST',
    pattern: /^workflows$/,
    run: async ({ services, principal, body }) => {
      const spec = (body as Record<string, unknown>)['spec'];
      // The same schema the tool validates with — without it a malformed
      // spec dies inside define() as a raw TypeError (500) instead of a 400.
      const parsed = SpecSchema.safeParse(spec);
      if (!parsed.success) {
        throw new OrchestratorError('INVALID_INPUT', `Invalid workflow spec: ${parsed.error.issues[0]?.message ?? 'rejected'}.`);
      }
      return { workflow: await services.workflows.define(parsed.data as WorkflowSpec, principal.ownerId) };
    }
  },
  {
    method: 'POST',
    pattern: /^workflows\/([^/]+)\/start$/,
    run: async ({ services, principal, body }, match) => {
      const input = body as Record<string, unknown>;
      const run = await services.workflows.start({
        ownerId: principal.ownerId,
        isAdmin: principal.isAdmin,
        workflowId: match[1] as string,
        ...(typeof input['inputs'] === 'object' && input['inputs'] !== null && {
          inputs: input['inputs'] as Record<string, unknown>
        }),
        ...(typeof input['idempotencyKey'] === 'string' && { idempotencyKey: input['idempotencyKey'] })
      });
      return { run };
    }
  },
  {
    method: 'POST',
    pattern: /^workflows\/start$/,
    run: async ({ services, principal, body }) => {
      const input = body as Record<string, unknown>;
      const spec = input['spec'];
      const parsed = SpecSchema.safeParse(spec);
      if (!parsed.success) {
        throw new OrchestratorError('INVALID_INPUT', `Invalid workflow spec: ${parsed.error.issues[0]?.message ?? 'rejected'}.`);
      }
      const run = await services.workflows.start({
        ownerId: principal.ownerId,
        isAdmin: principal.isAdmin,
        spec: parsed.data as WorkflowSpec,
        ...(typeof input['inputs'] === 'object' && input['inputs'] !== null && {
          inputs: input['inputs'] as Record<string, unknown>
        }),
        ...(typeof input['idempotencyKey'] === 'string' && { idempotencyKey: input['idempotencyKey'] })
      });
      return { run };
    }
  },
  {
    method: 'GET',
    pattern: /^workflows\/([^/]+)\/shares$/,
    run: async ({ services, principal }, match) => {
      const shares = await services.workflows.listShares(match[1] as string, principal);
      return { grantees: shares.map(s => s.granteeId), shares };
    }
  },
  {
    method: 'POST',
    pattern: /^workflows\/([^/]+)\/share$/,
    run: async ({ services, principal, body }, match) => {
      const granteeId = str((body as Record<string, unknown>)['granteeId'], 'granteeId') as string;
      await services.workflows.share(match[1] as string, principal, granteeId);
      return { shared: true, status: 'pending' };
    }
  },
  {
    method: 'POST',
    pattern: /^workflows\/([^/]+)\/accept$/,
    run: async ({ services, principal }, match) => {
      await services.workflows.acceptShare(match[1] as string, principal);
      return { accepted: true };
    }
  },
  {
    method: 'POST',
    pattern: /^workflows\/([^/]+)\/reject$/,
    run: async ({ services, principal }, match) => {
      return { rejected: await services.workflows.rejectShare(match[1] as string, principal) };
    }
  },
  {
    method: 'DELETE',
    pattern: /^workflows\/([^/]+)\/share\/([^/]+)$/,
    run: async ({ services, principal }, match) => {
      await services.workflows.unshare(match[1] as string, principal, decodeURIComponent(match[2] as string));
      return { shared: false };
    }
  },

  // -- schedules ------------------------------------------------------------------
  {
    method: 'GET',
    pattern: /^schedules$/,
    run: async ({ services, principal }) => {
      return {
        schedules: await services.schedules.list(50, principal.isAdmin ? undefined : principal.ownerId)
      };
    }
  },
  {
    method: 'POST',
    pattern: /^schedules$/,
    run: async ({ services, principal, body }) => {
      const input = body as Record<string, unknown>;
      if (typeof input['template'] === 'string') {
        if (services.agents.isTemplateDisabled(input['template'])) {
          throw new OrchestratorError('POLICY_DENIED', `Template "${input['template']}" is disabled by configuration.`);
        }
        if ((await services.templates.resolve(input['template'])) === undefined) {
          throw new OrchestratorError('NOT_FOUND', `Template "${input['template']}" does not exist.`);
        }
      }
      if (typeof input['agentId'] === 'string') {
        await services.agents.getVisible(input['agentId'], principal);
      }
      const schedule = await services.schedules.create({
        ownerId: principal.ownerId,
        name: str(input['name'], 'name') as string,
        cron: str(input['cron'], 'cron') as string,
        instruction: str(input['instruction'], 'instruction') as string,
        ...(typeof input['agentId'] === 'string' && { agentId: input['agentId'] }),
        ...(typeof input['template'] === 'string' && { template: input['template'] }),
        ...(typeof input['model'] === 'string' && { model: input['model'] }),
        ...(typeof input['runner'] === 'string' && { runner: asRunnerName(input['runner']) as RunnerName }),
        ...(typeof input['priority'] === 'number' && { priority: input['priority'] }),
        ...(typeof input['timeoutSec'] === 'number' && { timeoutSec: input['timeoutSec'] }),
        ...(typeof input['enabled'] === 'boolean' && { enabled: input['enabled'] }),
        ...(typeof input['overlap'] === 'string' &&
          (OVERLAP_POLICIES as readonly string[]).includes(input['overlap']) && {
            overlap: input['overlap'] as (typeof OVERLAP_POLICIES)[number]
          }),
        ...(typeof input['timezone'] === 'string' && { timezone: input['timezone'] })
      });
      return { schedule };
    }
  },
  {
    method: 'GET',
    pattern: /^schedules\/preview$/,
    run: async (_ctx, _m, query) => {
      const cron = query.get('cron');
      if (cron === null) throw new OrchestratorError('INVALID_INPUT', '"cron" query parameter is required.');
      return {
        runs: previewCronRuns(cron, {
          ...(query.get('timezone') !== null && { timezone: query.get('timezone') as string }),
          count: num(query.get('count'), 5, 20)
        })
      };
    }
  },
  {
    method: 'PATCH',
    pattern: /^schedules\/([^/]+)$/,
    run: async ({ services, principal, body }, match) => {
      const input = body as Record<string, unknown>;
      const schedule = await services.schedules.update(
        match[1] as string,
        {
          ...(typeof input['enabled'] === 'boolean' && { enabled: input['enabled'] }),
          ...(typeof input['cron'] === 'string' && { cron: input['cron'] }),
          ...(typeof input['instruction'] === 'string' && { instruction: input['instruction'] })
        },
        principal
      );
      return { schedule };
    }
  },
  {
    method: 'DELETE',
    pattern: /^schedules\/([^/]+)$/,
    run: async ({ services, principal, body }, match, query) => {
      if (!flag(body, query, 'confirm')) {
        throw new ApiFailure(400, 'confirm_required', 'Pass { "confirm": true } to delete this schedule.', 'Re-send the same request with confirm: true.');
      }
      return { deleted: await services.schedules.delete(match[1] as string, principal) };
    }
  },

  // -- memory -----------------------------------------------------------------------
  // NOTE on ordering: routes match first-fit, so the specific `shares` /
  // `share` shapes below must come before the generic `:namespace/:key`
  // read — otherwise `GET memory/n/shares` reads a key literally named
  // "shares" instead of listing grantees. Same rule everywhere: specific
  // patterns first, catch-alls last.
  {
    method: 'GET',
    pattern: /^memory$/,
    run: async ({ services, principal }, _m, query) => {
      const namespace = query.get('namespace');
      const queryText = query.get('query');
      if (queryText === null) throw new OrchestratorError('INVALID_INPUT', '"query" query parameter is required.');
      return {
        entries: await services.memory.searchVisible(
          {
            query: queryText,
            ...(namespace !== null && { namespace }),
            ownerId: query.get('ownerId') ?? principal.ownerId
          },
          principal
        )
      };
    }
  },
  {
    method: 'GET',
    pattern: /^memory\/([^/]+)\/shares$/,
    run: async ({ services, principal }, match) => {
      const shares = await services.memory.listShares(principal.ownerId, decodeURIComponent(match[1] as string));
      return { grantees: shares.map(s => s.granteeId), shares };
    }
  },
  {
    method: 'POST',
    pattern: /^memory\/([^/]+)\/share$/,
    run: async ({ services, principal, body }, match) => {
      const granteeId = str((body as Record<string, unknown>)['granteeId'], 'granteeId') as string;
      await services.memory.share(principal.ownerId, decodeURIComponent(match[1] as string), granteeId);
      return { shared: true, status: 'pending' };
    }
  },
  {
    method: 'POST',
    pattern: /^memory\/([^/]+)\/accept$/,
    run: async ({ services, principal, body }, match) => {
      const input = body as Record<string, unknown>;
      const ownerId =
        typeof input['ownerId'] === 'string' && input['ownerId'] !== '' ? input['ownerId'] : principal.ownerId;
      await services.memory.acceptShare(ownerId, decodeURIComponent(match[1] as string), principal.ownerId);
      return { accepted: true };
    }
  },
  {
    method: 'POST',
    pattern: /^memory\/([^/]+)\/reject$/,
    run: async ({ services, principal, body }, match) => {
      const input = body as Record<string, unknown>;
      const ownerId =
        typeof input['ownerId'] === 'string' && input['ownerId'] !== '' ? input['ownerId'] : principal.ownerId;
      return {
        rejected: await services.memory.rejectShare(ownerId, decodeURIComponent(match[1] as string), principal.ownerId)
      };
    }
  },
  {
    method: 'DELETE',
    pattern: /^memory\/([^/]+)\/share\/([^/]+)$/,
    run: async ({ services, principal }, match) => {
      return {
        revoked: await services.memory.unshare(
          principal.ownerId,
          decodeURIComponent(match[1] as string),
          decodeURIComponent(match[2] as string)
        )
      };
    }
  },
  {
    method: 'GET',
    pattern: /^memory\/([^/]+)\/([^/]+)$/,
    run: async ({ services, principal }, match, query) => {
      const namespace = decodeURIComponent(match[1] as string);
      const key = decodeURIComponent(match[2] as string);
      const ownerId = query.get('ownerId') ?? principal.ownerId;
      const entry = await services.memory.readVisible(ownerId, namespace, key, principal);
      return entry === undefined ? { found: false } : { found: true, entry };
    }
  },
  {
    method: 'POST',
    pattern: /^memory$/,
    run: async ({ services, principal, body }) => {
      const input = body as Record<string, unknown>;
      const entry = await services.memory.write({
        ownerId: principal.ownerId,
        namespace: str(input['namespace'], 'namespace') as string,
        key: str(input['key'], 'key') as string,
        value: input['value'] ?? null,
        ...(Array.isArray(input['tags']) && { tags: (input['tags'] as unknown[]).map(String) }),
        ...(typeof input['ttlSec'] === 'number' && { ttlSec: input['ttlSec'] })
      });
      return { entry };
    }
  },
  {
    method: 'DELETE',
    pattern: /^memory$/,
    run: async ({ services, principal, body }, _m, query) => {
      const input = body as Record<string, unknown>;
      const namespace = (typeof input['namespace'] === 'string' ? input['namespace'] : query.get('namespace')) as string | null;
      if (namespace === null) throw new OrchestratorError('INVALID_INPUT', '"namespace" is required.');
      const key = typeof input['key'] === 'string' ? input['key'] : undefined;
      const prefix = typeof input['prefix'] === 'string' ? input['prefix'] : undefined;
      if (!flag(body, query, 'confirm')) {
        throw new ApiFailure(400, 'confirm_required', 'Pass { "confirm": true } to delete memory.', 'Re-send the same request with confirm: true.');
      }
      return {
        deleted: await services.memory.delete(principal.ownerId, namespace, {
          ...(key !== undefined && { key }),
          ...(prefix !== undefined && { prefix })
        })
      };
    }
  },

  // -- artifacts ----------------------------------------------------------------------
  {
    method: 'GET',
    pattern: /^artifacts$/,
    run: async ({ services, principal }, _m, query) => {
      return {
        artifacts: await services.artifacts.list({
          ...ownerFilter(principal),
          ...(query.get('jobId') !== null && { jobId: query.get('jobId') as string }),
          limit: num(query.get('limit'), 20, 100)
        })
      };
    }
  },
  {
    method: 'POST',
    pattern: /^artifacts$/,
    run: async ({ services, principal, body }) => {
      const input = body as Record<string, unknown>;
      const artifact = await services.artifacts.put({
        ownerId: principal.ownerId,
        name: str(input['name'], 'name') as string,
        content: str(input['content'], 'content') as string,
        ...(typeof input['mimeType'] === 'string' && { mimeType: input['mimeType'] }),
        ...(typeof input['jobId'] === 'string' && { jobId: input['jobId'] }),
        ...(typeof input['workflowRunId'] === 'string' && { workflowRunId: input['workflowRunId'] }),
        ...(Array.isArray(input['tags']) && { tags: (input['tags'] as unknown[]).map(String) })
      });
      return { artifact };
    }
  },
  {
    method: 'GET',
    pattern: /^artifacts\/([^/]+)$/,
    run: async ({ services, principal }, match, query) => {
      const offset = query.get('offset') === null ? 0 : num(query.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0);
      const length = query.get('length') === null ? undefined : num(query.get('length'), 0, Number.MAX_SAFE_INTEGER, 0);
      const { record, content, eof } = await services.artifacts.readVisible(
        match[1] as string,
        principal,
        offset,
        length
      );
      return { artifact: record, content, eof };
    }
  },
  {
    method: 'DELETE',
    pattern: /^artifacts\/([^/]+)$/,
    run: async ({ services, principal, body }, match, query) => {
      if (!flag(body, query, 'confirm')) {
        throw new ApiFailure(400, 'confirm_required', 'Pass { "confirm": true } to delete this artifact.', 'Re-send the same request with confirm: true.');
      }
      return { deleted: await services.artifacts.deleteVisible(match[1] as string, principal) };
    }
  },

  // -- observability & admin --------------------------------------------------------------
  {
    method: 'GET',
    pattern: /^events$/,
    run: async ({ services, principal }, _m, query) => {
      const jobId = query.get('jobId');
      const agentId = query.get('agentId');
      const runId = query.get('runId');
      // Same rule as the tool: unscoped queries have nothing to check against.
      if (!principal.isAdmin && jobId === null && agentId === null && runId === null) {
        throw new OrchestratorError(
          'POLICY_DENIED',
          'Scope events to a jobId, agentId or runId you can see.',
          'There is no unscoped view of every owner’s events; an operator with orch:admin can see the full log.'
        );
      }
      if (!principal.isAdmin) {
        if (jobId !== null) await services.jobs.getVisible(jobId, principal);
        else if (agentId !== null) await services.agents.getVisible(agentId, principal);
        else if (runId !== null) await services.workflows.getVisibleRun(runId, principal);
      }
      return {
        events: await services.events.query({
          ...(jobId !== null && { jobId }),
          ...(agentId !== null && { agentId }),
          ...(runId !== null && { runId }),
          ...ownerFilter(principal),
          limit: num(query.get('limit'), 50, 1000)
        })
      };
    }
  },
  {
    method: 'GET',
    pattern: /^usage$/,
    run: async ({ services, principal }, _m, query) => {
      const groupBy = query.get('groupBy') ?? 'agent';
      if (groupBy !== 'agent' && groupBy !== 'model' && groupBy !== 'backend') {
        throw new OrchestratorError('INVALID_INPUT', '"groupBy" must be agent, model or backend.');
      }
      const { jobs } = await services.jobs.list({ ...ownerFilter(principal), limit: 500 });
      const groups = new Map<string, { key: string; jobs: number; costUsd: number; tokens: number }>();
      for (const job of jobs) {
        const key =
          groupBy === 'agent'
            ? job.agentSnapshot.name
            : groupBy === 'model'
              ? (job.agentSnapshot.model ?? job.agentSnapshot.runner ?? 'unknown')
              : job.backend;
        const group = groups.get(key) ?? { key, jobs: 0, costUsd: 0, tokens: 0 };
        group.jobs += 1;
        group.costUsd += job.usage?.costUsd ?? 0;
        group.tokens += (job.usage?.inputTokens ?? 0) + (job.usage?.outputTokens ?? 0);
        groups.set(key, group);
      }
      const list = [...groups.values()].sort((a, b) => b.jobs - a.jobs);
      return {
        groups: list,
        totals: {
          jobs: jobs.length,
          costUsd: list.reduce((sum, g) => sum + g.costUsd, 0),
          tokens: list.reduce((sum, g) => sum + g.tokens, 0)
        }
      };
    }
  },
  {
    method: 'GET',
    pattern: /^budgets$/,
    run: async ({ services, principal }) => {
      requireAdmin(principal, 'Reading budgets');
      return { budgets: await services.budgets.list() };
    }
  },
  {
    method: 'POST',
    pattern: /^budgets$/,
    run: async ({ services, principal, body }) => {
      requireAdmin(principal, 'Setting budgets');
      const input = body as Record<string, unknown>;
      const scope = input['scope'];
      if (scope !== 'global' && scope !== 'agent' && scope !== 'job') {
        throw new OrchestratorError('INVALID_INPUT', '"scope" must be global, agent or job.');
      }
      const budget = await services.budgets.set({
        scope,
        ...(typeof input['id'] === 'string' && { scopeId: input['id'] }),
        ...(typeof input['maxCostUsd'] === 'number' && { maxCostUsd: input['maxCostUsd'] }),
        ...(typeof input['maxTokens'] === 'number' && { maxTokens: input['maxTokens'] }),
        ...(typeof input['maxCalls'] === 'number' && { maxCalls: input['maxCalls'] }),
        ...(typeof input['maxConcurrent'] === 'number' && { maxConcurrent: input['maxConcurrent'] })
      });
      return { budget };
    }
  },
  {
    method: 'POST',
    pattern: /^prune$/,
    run: async ({ services, principal, body }) => {
      requireAdmin(principal, 'Pruning history');
      const input = body as Record<string, unknown>;
      if (input['confirm'] !== true) {
        throw new ApiFailure(400, 'confirm_required', 'Pass { "confirm": true } to prune history.', 'Dry-run first with dryRun: true.');
      }
      const days =
        typeof input['olderThanDays'] === 'number' ? input['olderThanDays'] : services.config.retentionDays;
      if (days === undefined) {
        throw new OrchestratorError(
          'INVALID_INPUT',
          'No retention cutoff: pass olderThanDays or set ORCH_RETENTION_DAYS.',
          'Pruning needs an explicit age, never a guessed default.'
        );
      }
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const dryRun = input['dryRun'] === true;
      const pruned = await pruneOldData(services.db, cutoff, { dryRun });
      return { cutoff, dryRun, pruned };
    }
  },
  {
    method: 'GET',
    pattern: /^toolservers$/,
    run: async ({ services, principal }) => {
      // Names, transport kinds and approval gates only — connection details
      // stay admin-tool-only.
      requireAdmin(principal, 'Listing tool servers');
      return {
        servers: (await services.proxy.list()).map(server => ({
          name: server.name,
          transport: server.transport.type,
          requireApprovalFor: [...server.requireApprovalFor]
        }))
      };
    }
  },
  {
    method: 'GET',
    pattern: /^toolservers\/([^/]+)\/tools$/,
    run: async ({ services, principal }, match) => {
      requireAdmin(principal, 'Inspecting tool servers');
      return { tools: await services.proxy.tools(match[1] as string) };
    }
  },
  {
    method: 'POST',
    pattern: /^toolservers$/,
    run: async ({ services, principal, body }) => {
      requireAdmin(principal, 'Registering tool servers');
      const input = body as Record<string, unknown>;
      const name = str(input['name'], 'name') as string;
      const transport = parseTransport(input['transport']);
      const listOf = (value: unknown, field: string): string[] | undefined => {
        if (value === undefined) return undefined;
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
          throw new OrchestratorError('INVALID_INPUT', `"${field}" must be an array of strings.`);
        }
        return (value as string[]).map(v => v.trim()).filter(v => v !== '');
      };
      const record = await services.proxy.register({
        name,
        transport,
        ...(typeof input['authRef'] === 'string' && input['authRef'] !== '' && { authRef: input['authRef'] }),
        ...(listOf(input['allowTools'], 'allowTools') !== undefined && {
          allowTools: listOf(input['allowTools'], 'allowTools') as string[]
        }),
        ...(listOf(input['denyTools'], 'denyTools') !== undefined && {
          denyTools: listOf(input['denyTools'], 'denyTools') as string[]
        }),
        ...(listOf(input['requireApprovalFor'], 'requireApprovalFor') !== undefined && {
          requireApprovalFor: listOf(input['requireApprovalFor'], 'requireApprovalFor') as string[]
        })
      });
      return {
        server: {
          name: record.name,
          transport: record.transport.type,
          requireApprovalFor: [...record.requireApprovalFor]
        }
      };
    }
  },
  {
    method: 'DELETE',
    pattern: /^toolservers\/([^/]+)$/,
    run: async ({ services, principal, body }, match, query) => {
      requireAdmin(principal, 'Removing tool servers');
      if (!flag(body, query, 'confirm')) {
        throw new ApiFailure(400, 'confirm_required', 'Pass { "confirm": true } to remove this server.', 'Re-send the same request with confirm: true.');
      }
      return { removed: await services.proxy.remove(decodeURIComponent(match[1] as string)) };
    }
  },
  {
    method: 'GET',
    pattern: /^templates$/,
    run: async ({ services }) => {
      return {
        templates: (await services.templates.all()).map(template => ({
          name: template.name,
          role: template.role,
          description: template.description
        }))
      };
    }
  },
  {
    method: 'GET',
    pattern: /^users\/([^/]+)\/exists$/,
    run: async ({ services }, match) => {
      const ownerId = decodeURIComponent(match[1] as string);
      if (ownerId === '') return { ownerId, exists: true };
      const checks: Array<Promise<unknown>> = [
        services.db.prepare('SELECT 1 FROM agents WHERE owner_id = ? LIMIT 1').get(ownerId),
        services.db.prepare('SELECT 1 FROM jobs WHERE owner_id = ? LIMIT 1').get(ownerId),
        services.db.prepare('SELECT 1 FROM workflows WHERE owner_id = ? LIMIT 1').get(ownerId),
        services.db.prepare('SELECT 1 FROM workflow_runs WHERE owner_id = ? LIMIT 1').get(ownerId),
        services.db.prepare('SELECT 1 FROM artifacts WHERE owner_id = ? LIMIT 1').get(ownerId),
        services.db.prepare('SELECT 1 FROM memory WHERE owner_id = ? LIMIT 1').get(ownerId),
        services.db.prepare('SELECT 1 FROM resource_grants WHERE grantee_id = ? LIMIT 1').get(ownerId),
        services.db.prepare('SELECT 1 FROM resource_grants WHERE owner_id = ? LIMIT 1').get(ownerId)
      ];
      const results = await Promise.all(checks);
      return { ownerId, exists: results.some(row => row !== undefined) };
    }
  },
  {
    method: 'GET',
    pattern: /^presets$/,
    run: async ({ services }) => {
      return { presets: await services.presets.list() };
    }
  },
  {
    method: 'POST',
    pattern: /^presets$/,
    run: async ({ services, principal, body }) => {
      requireAdmin(principal, 'Saving grant presets');
      const input = body as Record<string, unknown>;
      const name = str(input['name'], 'name') as string;
      const grants = Array.isArray(input['grants']) ? (input['grants'] as unknown[]).map(String) : [];
      if (grants.length === 0) throw new OrchestratorError('INVALID_INPUT', '"grants" must be a non-empty array.');
      return { preset: await services.presets.save(name, grants) };
    }
  }
];

/**
 * Serve the routes above. Returns true when the path belonged to the API
 * (even on error), false for anything else so the caller keeps routing.
 */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ApiOptions
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;

  const sendError = (error: unknown): void => {
    if (!res.headersSent) {
      const { status, body } = errorToResponse(error);
      send(res, status, body);
    }
  };

  try {
    const path = url.pathname.slice('/api/'.length);
    const route = routes.find(candidate => candidate.method === req.method && candidate.pattern.test(path));
    if (route === undefined) {
      send(res, 404, { error: 'not_found', hint: 'Unknown API route.' });
      return true;
    }
    const match = path.match(route.pattern) as RegExpMatchArray;
    // Identity before anything else: with OAuth on, every route below is
    // principal-scoped; a bad token fails here, never halfway through.
    const principal = await principalForRequest(req, options.verifier);
    const result = await route.run(
      { services: options.services, principal, version: options.version, startedAt: options.startedAt, body: await readBody(req) },
      match,
      url.searchParams
    );
    send(res, 200, result);
  } catch (error) {
    options.services.logger.error({ err: error }, 'dashboard API failed');
    sendError(error);
  }
  return true;
}
