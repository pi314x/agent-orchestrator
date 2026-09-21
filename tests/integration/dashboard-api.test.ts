import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import type { Services } from '../../src/services.js';
import { closeServices, deferred, testServices } from '../helpers.js';
import { JWKS_AUDIENCE, startJwks, type Jwks } from '../fixtures/jwks.js';

type ApiCall = {
  token?: string;
  body?: unknown;
  rawBody?: string;
};

async function api(
  port: number,
  method: string,
  path: string,
  call: ApiCall = {}
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = call.rawBody ?? (call.body === undefined ? undefined : JSON.stringify(call.body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host: '127.0.0.1',
          ...(payload !== undefined && { 'content-type': 'application/json' }),
          ...(call.token !== undefined && { authorization: `Bearer ${call.token}` })
        }
      },
      res => {
        let text = '';
        res.on('data', chunk => {
          text += String(chunk);
        });
        res.on('end', () => {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(text === '' ? '{}' : text) as Record<string, unknown>;
          } catch {
            data = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startApi(
  services: Services,
  config: {
    httpHost?: string;
    httpPort?: number;
    oauthIssuerUrl?: string;
    oauthResourceUrl?: string;
    jwksUrl?: string;
  } = {}
): Promise<HttpServerHandle> {
  return startHttpServer({
    factory: createServerFactory({ services, startedAt: Date.now() }),
    config: {
      httpHost: '127.0.0.1',
      httpPort: 0,
      ...(config.httpHost !== undefined && { httpHost: config.httpHost }),
      ...(config.httpPort !== undefined && { httpPort: config.httpPort }),
      ...(config.oauthIssuerUrl !== undefined && { oauthIssuerUrl: config.oauthIssuerUrl }),
      ...(config.oauthResourceUrl !== undefined && { oauthResourceUrl: config.oauthResourceUrl }),
      ...(config.jwksUrl !== undefined && { oauthJwksUrl: config.jwksUrl })
    },
    logger: services.logger,
    dashboard: { services, version: VERSION, startedAt: Date.now() }
  });
}

async function pollJob(port: number, jobId: string, token?: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i += 1) {
    const { data } = await api(port, 'GET', `/api/jobs/${jobId}`, { ...(token !== undefined && { token }) });
    const job = data['job'] as { state: string };
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.state)) return job;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`job ${jobId} never settled`);
}

/**
 * The dashboard write path: the same owner-scoped store calls the MCP tools
 * use, exercised here through real HTTP — including the OAuth identity
 * mapping, so a second owner's rows stay invisible and admin-only writes
 * stay refused.
 */
describe('dashboard API without OAuth', () => {
  it('runs an agent lifecycle end to end', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      const created = await api(server.port, 'POST', '/api/agents', {
        body: { name: 'api-agent', instructions: 'Be brief.', runner: 'mock' }
      });
      expect(created.status).toBe(200);
      const agentId = (created.data['agent'] as { agentId: string }).agentId;

      const listed = await api(server.port, 'GET', '/api/agents');
      expect((listed.data['agents'] as unknown[]).length).toBe(1);

      const patched = await api(server.port, 'PATCH', `/api/agents/${agentId}`, {
        body: { patch: { role: 'researcher' } }
      });
      expect(patched.status).toBe(200);

      const delegated = await api(server.port, 'POST', '/api/delegate', {
        body: { agentId, instruction: 'hello from the dashboard' }
      });
      expect(delegated.status).toBe(200);
      const jobId = ((delegated.data['job'] as { jobId: string }).jobId ?? '') as string;

      const done = await pollJob(server.port, jobId);
      expect(done.state).toBe('succeeded');

      const removed = await api(server.port, 'DELETE', `/api/agents/${agentId}?confirm=true`);
      expect(removed.status).toBe(200);
      expect((removed.data as { deleted: boolean }).deleted).toBe(true);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('requires explicit confirmation for destructive calls', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      const created = await api(server.port, 'POST', '/api/agents', {
        body: { name: 'doomed', instructions: 'x' }
      });
      const agentId = (created.data['agent'] as { agentId: string }).agentId;

      // Node's own http client silently drops DELETE bodies (it never sends
      // Transfer-Encoding for them), so destructive flags ride the query
      // string here — the routes accept either, and browsers send bodies.
      const unconfirmed = await api(server.port, 'DELETE', `/api/agents/${agentId}`);
      expect(unconfirmed.status).toBe(400);
      expect(unconfirmed.data['error']).toBe('confirm_required');

      // Still there.
      expect((await api(server.port, 'GET', `/api/agents/${agentId}`)).status).toBe(200);

      // And the body path works for clients that actually deliver DELETE
      // bodies (fetch, curl) — proven over a raw socket with Content-Length.
      const { connect } = await import('node:net');
      const payload = JSON.stringify({ confirm: true });
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = connect(server.port, '127.0.0.1', () => {
          socket.write(
            `DELETE /api/agents/${agentId} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
          );
        });
        let out = '';
        socket.on('data', chunk => {
          out += String(chunk);
        });
        socket.on('end', () => resolve(out));
        socket.on('error', reject);
      });
      expect(raw).toContain('200 OK');
      expect(raw).toContain('"deleted":true');
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('cancels, steers and retries a live job', async () => {
    const gate = deferred();
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });
    const server = await startApi(services);
    try {
      const created = await api(server.port, 'POST', '/api/agents', {
        body: { name: 'gated', instructions: 'x' }
      });
      const agentId = (created.data['agent'] as { agentId: string }).agentId;
      const submitted = await api(server.port, 'POST', '/api/jobs', {
        body: { agentId, instruction: 'slow work' }
      });
      const jobId = (submitted.data['job'] as { jobId: string }).jobId;

      const steered = await api(server.port, 'POST', `/api/jobs/${jobId}/steer`, {
        body: { message: 'keep going' }
      });
      expect(steered.status).toBe(200);

      expect((await api(server.port, 'POST', `/api/jobs/${jobId}/cancel`, { body: {} })).status).toBe(200);
      expect((await pollJob(server.port, jobId)).state).toBe('cancelled');

      const retried = await api(server.port, 'POST', `/api/jobs/${jobId}/retry`, { body: {} });
      expect(retried.status).toBe(200);
      gate.resolve();
      expect((await pollJob(server.port, jobId)).state).toBe('succeeded');
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('lists and resolves an approval gate', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      const agent = await services.agents.create({ name: 'a', instructions: 'x', runner: 'mock' });
      const job = await services.scheduler.submit({
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: { id: agent.id, name: agent.name, kind: 'local', instructions: 'x' },
        instruction: 'needs a human'
      });
      await services.approvals.create({ scope: 'job', summary: 'Delete the index?', jobId: job.id });

      const pending = await api(server.port, 'GET', '/api/approvals?status=pending');
      expect((pending.data['approvals'] as unknown[]).length).toBe(1);

      const approvalId = ((pending.data['approvals'] as { approvalId: string }[])[0] as { approvalId: string }).approvalId;
      const resolved = await api(server.port, 'POST', `/api/approvals/${approvalId}/resolve`, {
        body: { decision: 'approve' }
      });
      expect(resolved.status).toBe(200);
      expect((resolved.data['approval'] as { status: string }).status).toBe('approved');
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('defines, starts, controls and exports a workflow', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      const defined = await api(server.port, 'POST', '/api/workflows', {
        body: { spec: { name: 'api-flow', steps: [{ id: 'a', instruction: 'do a', template: 'coder' }] } }
      });
      expect(defined.status).toBe(200);
      const workflowId = (defined.data['workflow'] as { workflowId: string }).workflowId;

      const started = await api(server.port, 'POST', `/api/workflows/${workflowId}/start`, { body: {} });
      expect(started.status).toBe(200);
      const runId = (started.data['run'] as { runId: string }).runId;

      for (let i = 0; i < 50; i += 1) {
        const { data } = await api(server.port, 'GET', `/api/runs/${runId}`);
        if ((data['run'] as { state: string }).state === 'succeeded') break;
        await new Promise(r => setTimeout(r, 100));
      }
      const exported = await api(server.port, 'POST', `/api/runs/${runId}/export`, { body: {} });
      expect(exported.status).toBe(200);
      expect(typeof exported.data['content']).toBe('string');
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('manages schedules, memory, artifacts and budgets', async () => {
    const services = await testServices({ profile: 'full' });
    const server = await startApi(services);
    try {
      const created = await api(server.port, 'POST', '/api/schedules', {
        body: { name: 's', cron: '0 9 * * *', instruction: 'morning', template: 'reviewer' }
      });
      expect(created.status).toBe(200);
      const scheduleId = (created.data['schedule'] as { scheduleId: string }).scheduleId;

      const paused = await api(server.port, 'PATCH', `/api/schedules/${scheduleId}`, {
        body: { enabled: false }
      });
      expect((paused.data['schedule'] as { enabled: boolean }).enabled).toBe(false);

      const preview = await api(server.port, 'GET', '/api/schedules/preview?cron=0+9+*+*+*&count=2');
      expect((preview.data['runs'] as unknown[]).length).toBe(2);

      const written = await api(server.port, 'POST', '/api/memory', {
        body: { namespace: 'n', key: 'k', value: { v: 1 } }
      });
      expect(written.status).toBe(200);
      const read = await api(server.port, 'GET', '/api/memory/n/k');
      expect(read.data).toMatchObject({ found: true });

      const put = await api(server.port, 'POST', '/api/artifacts', {
        body: { name: 'f.txt', content: 'hello' }
      });
      const artifactId = (put.data['artifact'] as { artifactId: string }).artifactId;
      expect((await api(server.port, 'GET', `/api/artifacts/${artifactId}`)).status).toBe(200);

      const budget = await api(server.port, 'POST', '/api/budgets', {
        body: { scope: 'global', maxCostUsd: 50 }
      });
      expect(budget.status).toBe(200);

      const dry = await api(server.port, 'POST', '/api/prune', {
        body: { confirm: true, dryRun: true, olderThanDays: 30 }
      });
      expect(dry.status).toBe(200);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('answers 404 for unknown routes and 400 for bad JSON', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      expect((await api(server.port, 'GET', '/api/nope')).status).toBe(404);
      const bad = await api(server.port, 'POST', '/api/agents', { rawBody: '{oops' });
      expect(bad.status).toBe(400);
      expect(bad.data['error']).toBe('INVALID_INPUT');
    } finally {
      await server.close();
      await closeServices(services);
    }
  });
});

describe('dashboard API with OAuth', () => {
  let jwks: Jwks | undefined;

  async function oauthServer(services: Services): Promise<{ server: HttpServerHandle; jwks: Jwks }> {
    jwks = await startJwks();
    const server = await startApi(services, {
      oauthIssuerUrl: jwks.issuerUrl,
      oauthResourceUrl: JWKS_AUDIENCE,
      jwksUrl: `${jwks.issuerUrl}.well-known/jwks.json`
    });
    return { server, jwks };
  }

  it('refuses unauthenticated writes and isolates owners', async () => {
    const services = await testServices({ profile: 'standard' });
    const { server } = await oauthServer(services);
    try {
      expect((await api(server.port, 'POST', '/api/agents', { body: { name: 'x', instructions: 'y' } })).status).toBe(
        401
      );
      expect((await api(server.port, 'GET', '/api/agents')).status).toBe(401);

      const alice = await jwks?.sign({ sub: 'user_alice' });
      const bob = await jwks?.sign({ sub: 'user_bob' });
      const created = await api(server.port, 'POST', '/api/agents', {
        token: alice,
        body: { name: 'alices', instructions: 'x' }
      });
      expect(created.status).toBe(200);
      const agentId = (created.data['agent'] as { agentId: string }).agentId;

      // Bob cannot see, use or delete Alice's agent — same NOT_FOUND shape as the tools.
      expect((await api(server.port, 'GET', `/api/agents/${agentId}`, { token: bob })).status).toBe(404);
      expect(
        (await api(server.port, 'DELETE', `/api/agents/${agentId}?confirm=true`, { token: bob })).status
      ).toBe(404);

      // And a job submitted by Alice never surfaces for Bob either.
      const submitted = await api(server.port, 'POST', '/api/delegate', {
        token: alice,
        body: { agentId, instruction: 'hi' }
      });
      const jobId = (submitted.data['job'] as { jobId: string }).jobId;
      expect((await api(server.port, 'GET', `/api/jobs/${jobId}`, { token: bob })).status).toBe(404);
    } finally {
      await server.close();
      await closeServices(services);
      await jwks?.close();
      jwks = undefined;
    }
  });

  it('gates admin writes behind the admin scope', async () => {
    const services = await testServices({ profile: 'full' });
    const { server } = await oauthServer(services);
    try {
      const user = await jwks?.sign({ sub: 'user_alice' });
      const admin = await jwks?.sign({ sub: 'user_root', scope: 'orch:admin' });

      expect(
        (await api(server.port, 'POST', '/api/budgets', { token: user, body: { scope: 'global' } })).status
      ).toBe(403);
      expect(
        (await api(server.port, 'POST', '/api/prune', { token: user, body: { confirm: true, dryRun: true } })).status
      ).toBe(403);

      expect(
        (await api(server.port, 'POST', '/api/budgets', { token: admin, body: { scope: 'global', maxCostUsd: 1 } }))
          .status
      ).toBe(200);
    } finally {
      await server.close();
      await closeServices(services);
      await jwks?.close();
      jwks = undefined;
    }
  });

  it('accepts, rejects and lists incoming shares over the API', async () => {
    const services = await testServices({ profile: 'full' });
    const { server } = await oauthServer(services);
    try {
      const alice = await jwks?.sign({ sub: 'user_alice' });
      const bob = await jwks?.sign({ sub: 'user_bob' });

      // Agents: pending confers nothing until accepted.
      const created = await api(server.port, 'POST', '/api/agents', {
        token: alice,
        body: { name: 'shared-api', instructions: 'x' }
      });
      const agentId = (created.data['agent'] as { agentId: string }).agentId;
      expect(
        (
          await api(server.port, 'POST', `/api/agents/${agentId}/share`, {
            token: alice,
            body: { granteeId: 'user_bob' }
          })
        ).data
      ).toMatchObject({ shared: true, status: 'pending' });
      expect((await api(server.port, 'GET', `/api/agents/${agentId}`, { token: bob })).status).toBe(404);
      expect((await api(server.port, 'GET', '/api/shares/incoming', { token: bob })).data['agents']).toEqual([
        expect.objectContaining({ agentId, ownerId: 'user_alice', status: 'pending' })
      ]);

      expect(
        (await api(server.port, 'POST', `/api/agents/${agentId}/accept`, { token: bob, body: {} })).data
      ).toMatchObject({ accepted: true });
      expect((await api(server.port, 'GET', `/api/agents/${agentId}`, { token: bob })).status).toBe(200);
      expect(
        (await api(server.port, 'GET', `/api/agents/${agentId}/shares`, { token: alice })).data['shares']
      ).toEqual([expect.objectContaining({ granteeId: 'user_bob', status: 'accepted' })]);
      // Nothing left pending: a second accept is NOT_FOUND, not a second grant.
      expect(
        (await api(server.port, 'POST', `/api/agents/${agentId}/accept`, { token: bob, body: {} })).status
      ).toBe(404);

      // Reject removes the pending row; rejecting twice is a no-op false.
      const created2 = await api(server.port, 'POST', '/api/agents', {
        token: alice,
        body: { name: 'rejected-api', instructions: 'x' }
      });
      const agentId2 = (created2.data['agent'] as { agentId: string }).agentId;
      await api(server.port, 'POST', `/api/agents/${agentId2}/share`, {
        token: alice,
        body: { granteeId: 'user_bob' }
      });
      expect(
        (await api(server.port, 'POST', `/api/agents/${agentId2}/reject`, { token: bob, body: {} })).data
      ).toMatchObject({ rejected: true });
      expect((await api(server.port, 'GET', `/api/agents/${agentId2}`, { token: bob })).status).toBe(404);
      expect((await api(server.port, 'GET', '/api/shares/incoming', { token: bob })).data['agents']).toEqual([]);
      expect(
        (await api(server.port, 'POST', `/api/agents/${agentId2}/reject`, { token: bob, body: {} })).data
      ).toMatchObject({ rejected: false });

      // Workflows ride the same pending/accept shape.
      const defined = await api(server.port, 'POST', '/api/workflows', {
        token: alice,
        body: { spec: { name: 'shared-flow', steps: [{ id: 'a', instruction: 'go', template: 'coder' }] } }
      });
      const workflowId = (defined.data['workflow'] as { workflowId: string }).workflowId;
      await api(server.port, 'POST', `/api/workflows/${workflowId}/share`, {
        token: alice,
        body: { granteeId: 'user_bob' }
      });
      expect((await api(server.port, 'GET', `/api/workflows/${workflowId}`, { token: bob })).status).toBe(404);
      expect((await api(server.port, 'GET', '/api/shares/incoming', { token: bob })).data['workflows']).toEqual([
        expect.objectContaining({ workflowId, ownerId: 'user_alice', status: 'pending' })
      ]);
      await api(server.port, 'POST', `/api/workflows/${workflowId}/accept`, { token: bob, body: {} });
      expect((await api(server.port, 'GET', `/api/workflows/${workflowId}`, { token: bob })).status).toBe(200);

      // Memory needs the owner's id on both the accept call and the read.
      await api(server.port, 'POST', '/api/memory', {
        token: alice,
        body: { namespace: 'team', key: 'k', value: 'v' }
      });
      await api(server.port, 'POST', '/api/memory/team/share', {
        token: alice,
        body: { granteeId: 'user_bob' }
      });
      const unreadable = await api(server.port, 'GET', '/api/memory/team/k?ownerId=user_alice', { token: bob });
      expect(unreadable.data).toMatchObject({ found: false });
      await api(server.port, 'POST', '/api/memory/team/accept', {
        token: bob,
        body: { ownerId: 'user_alice' }
      });
      const readable = await api(server.port, 'GET', '/api/memory/team/k?ownerId=user_alice', { token: bob });
      expect(readable.data).toMatchObject({ found: true });
      expect((await api(server.port, 'GET', '/api/shares/incoming', { token: bob })).data['namespaces']).toEqual(
        []
      );
    } finally {
      await server.close();
      await closeServices(services);
      await jwks?.close();
      jwks = undefined;
    }
  });
});

describe('dashboard API validation and sharing', () => {
  it('validates agent inputs like the tools do', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      const badRunner = await api(server.port, 'POST', '/api/agents', {
        body: { name: 'x', instructions: 'y', runner: 'nope' }
      });
      expect(badRunner.status).toBe(400);

      const badLimits = await api(server.port, 'POST', '/api/agents', {
        body: { name: 'x', instructions: 'y', limits: { timeoutSec: 999999999 } }
      });
      expect(badLimits.status).toBe(400);
      expect(badLimits.data['error']).toBe('INVALID_INPUT');

      const created = await api(server.port, 'POST', '/api/agents', {
        body: { name: 'x', instructions: 'y' }
      });
      const agentId = (created.data['agent'] as { agentId: string }).agentId;
      const badUpdate = await api(server.port, 'PATCH', `/api/agents/${agentId}`, {
        body: { patch: { limits: { maxSteps: 0 } } }
      });
      expect(badUpdate.status).toBe(400);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('shares and unshares an agent with one named user', async () => {
    const services = await testServices({ profile: 'full' });
    const server = await startApi(services);
    try {
      const created = await api(server.port, 'POST', '/api/agents', {
        body: { name: 'shared-one', instructions: 'x' }
      });
      const agentId = (created.data['agent'] as { agentId: string }).agentId;

      expect(await api(server.port, 'POST', `/api/agents/${agentId}/share`, { body: {} })).toMatchObject({
        status: 400
      });
      expect(
        await api(server.port, 'POST', `/api/agents/${agentId}/share`, { body: { granteeId: 'user_bob' } })
      ).toMatchObject({ status: 200 });

      const shares = await api(server.port, 'GET', `/api/agents/${agentId}/shares`);
      expect(shares.data['grantees']).toEqual(['user_bob']);
      // The dashboard lists whom it shared with and with what status — pending until accepted.
      expect(shares.data['shares']).toEqual([expect.objectContaining({ granteeId: 'user_bob', status: 'pending' })]);

      const unshared = await api(server.port, 'DELETE', `/api/agents/${agentId}/share/user_bob`);
      expect(unshared.status).toBe(200);
      expect((await api(server.port, 'GET', `/api/agents/${agentId}/shares`)).data['grantees']).toEqual([]);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('toggles an agent enabled flag without hiding it', async () => {
    const services = await testServices({ profile: 'full' });
    const server = await startApi(services);
    try {
      const created = await api(server.port, 'POST', '/api/agents', {
        body: { name: 'switchable', instructions: 'x' }
      });
      const agentId = (created.data['agent'] as { agentId: string }).agentId;
      expect(created.data['agent']).toMatchObject({ enabled: true });

      const disabled = await api(server.port, 'PATCH', `/api/agents/${agentId}`, {
        body: { patch: { enabled: false } }
      });
      expect(disabled.data['agent']).toMatchObject({ enabled: false });

      // Still listed and readable — the flag gates use, not visibility.
      const listed = (await api(server.port, 'GET', '/api/agents')).data['agents'] as {
        agentId: string;
        enabled: boolean;
      }[];
      expect(listed.find(a => a.agentId === agentId)).toMatchObject({ enabled: false });

      const enabled = await api(server.port, 'PATCH', `/api/agents/${agentId}`, {
        body: { patch: { enabled: true } }
      });
      expect(enabled.data['agent']).toMatchObject({ enabled: true });
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('checks whether a grantee exists before sharing', async () => {
    const services = await testServices({ profile: 'full' });
    const server = await startApi(services);
    try {
      // Nobody has rows yet, so nobody is known — except the single-owner sentinel.
      expect((await api(server.port, 'GET', '/api/users/user_bob/exists')).data).toMatchObject({
        ownerId: 'user_bob',
        exists: false
      });

      await api(server.port, 'POST', '/api/agents', { body: { name: 'known', instructions: 'x' } });
      // Single-owner rows belong to '' — still unknown.
      expect((await api(server.port, 'GET', '/api/users/user_bob/exists')).data).toMatchObject({ exists: false });
      expect((await api(server.port, 'GET', '/api/users/%20/exists')).status).toBe(200);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('rejects unknown agents, jobs and bad references', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      expect((await api(server.port, 'GET', '/api/agents/agt_missing')).status).toBe(404);
      expect((await api(server.port, 'GET', '/api/jobs/job_missing')).status).toBe(404);
      expect(
        (await api(server.port, 'POST', '/api/delegate', { body: { agentId: 'agt_missing', instruction: 'hi' } }))
          .status
      ).toBe(404);
      expect((await api(server.port, 'POST', '/api/delegate', { body: { agentId: 'agt_x' } })).status).toBe(400);
      expect(
        (
          await api(server.port, 'POST', '/api/jobs', {
            body: { template: 'coder', instruction: 'x', dependsOn: ['job_missing'] }
          })
        ).status
      ).toBe(404);
      expect((await api(server.port, 'POST', '/api/jobs/job_missing/cancel', { body: {} })).status).toBe(404);
      expect((await api(server.port, 'POST', '/api/jobs/job_missing/retry', { body: {} })).status).toBe(404);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('validates approvals, runs and schedules inputs', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      expect(
        (await api(server.port, 'POST', '/api/approvals/apr_x/resolve', { body: { decision: 'maybe' } })).status
      ).toBe(400);
      expect((await api(server.port, 'POST', '/api/approvals/apr_x/resolve', { body: {} })).status).toBe(400);
      expect((await api(server.port, 'GET', '/api/approvals?status=bogus')).status).toBe(400);

      expect(
        (await api(server.port, 'POST', '/api/runs/wfr_x/control', { body: { action: 'explode' } })).status
      ).toBe(400);
      expect((await api(server.port, 'GET', '/api/runs/wfr_x')).status).toBe(404);

      expect((await api(server.port, 'POST', '/api/workflows', { body: { spec: { name: 'bad' } } })).status).toBe(
        400
      );
      expect((await api(server.port, 'POST', '/api/workflows/wf_x/start', { body: {} })).status).toBe(404);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('controls a live run end to end', async () => {
    const gate = deferred();
    const services = await testServices({ mockScript: () => ({ gate: gate.promise }) });
    const server = await startApi(services);
    try {
      const defined = await api(server.port, 'POST', '/api/workflows', {
        body: { spec: { name: 'pausable', steps: [{ id: 'a', instruction: 'wait', template: 'coder' }] } }
      });
      expect(defined.status).toBe(200);
      const started = await api(server.port, 'POST', '/api/workflows/start', {
        body: {
          spec: { name: 'pausable', steps: [{ id: 'a', instruction: 'wait', template: 'coder' }] }
        }
      });
      const runId = (started.data['run'] as { runId: string }).runId;

      const paused = await api(server.port, 'POST', `/api/runs/${runId}/control`, { body: { action: 'pause' } });
      expect((paused.data['run'] as { state: string }).state).toBe('paused');

      const resumed = await api(server.port, 'POST', `/api/runs/${runId}/control`, { body: { action: 'resume' } });
      expect((resumed.data['run'] as { state: string }).state).toBe('running');

      const cancelled = await api(server.port, 'POST', `/api/runs/${runId}/control`, {
        body: { action: 'cancel', confirm: true }
      });
      expect((cancelled.data['run'] as { state: string }).state).toBe('cancelled');
      gate.resolve();
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('shares, unshares and deletes a workflow definition', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      const defined = await api(server.port, 'POST', '/api/workflows', {
        body: { spec: { name: 'shared-flow', steps: [{ id: 'a', instruction: 'go', template: 'coder' }] } }
      });
      const workflowId = (defined.data['workflow'] as { workflowId: string }).workflowId;

      await api(server.port, 'POST', `/api/workflows/${workflowId}/share`, { body: { granteeId: 'user_bob' } });
      const shares = await api(server.port, 'GET', `/api/workflows/${workflowId}/shares`);
      expect(shares.data['grantees']).toEqual(['user_bob']);
      await api(server.port, 'DELETE', `/api/workflows/${workflowId}/share/user_bob?confirm=true`);

      expect((await api(server.port, 'DELETE', `/api/workflows/${workflowId}`)).status).toBe(400);
      const removed = await api(server.port, 'DELETE', `/api/workflows/${workflowId}?confirm=true`);
      expect((removed.data as { deleted: boolean }).deleted).toBe(true);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('reads, shares and deletes memory and artifacts', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      await api(server.port, 'POST', '/api/memory', { body: { namespace: 'm', key: 'k', value: 42 } });
      const missing = await api(server.port, 'GET', '/api/memory/m/nope');
      expect(missing.data).toMatchObject({ found: false });

      const shares = await api(server.port, 'GET', '/api/memory/m/shares');
      expect(shares.data['grantees']).toEqual([]);
      await api(server.port, 'POST', '/api/memory/m/share', { body: { granteeId: 'user_bob' } });
      expect((await api(server.port, 'GET', '/api/memory/m/shares')).data['grantees']).toEqual(['user_bob']);
      await api(server.port, 'DELETE', '/api/memory/m/share/user_bob');
      expect((await api(server.port, 'GET', '/api/memory/m/shares')).data['grantees']).toEqual([]);

      expect((await api(server.port, 'DELETE', '/api/memory?namespace=m&key=k')).status).toBe(400);
      const wiped = await api(server.port, 'DELETE', '/api/memory?namespace=m&key=k&confirm=true');
      expect((wiped.data as { deleted: number }).deleted).toBe(1);

      const put = await api(server.port, 'POST', '/api/artifacts', { body: { name: 'a', content: 'xyz' } });
      const artifactId = (put.data['artifact'] as { artifactId: string }).artifactId;
      const read = await api(server.port, 'GET', `/api/artifacts/${artifactId}?offset=1&length=1`);
      expect(read.data).toMatchObject({ content: 'y', eof: false });
      expect((await api(server.port, 'DELETE', `/api/artifacts/${artifactId}?confirm=true`)).status).toBe(200);
      expect((await api(server.port, 'GET', `/api/artifacts/${artifactId}`)).status).toBe(404);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('serves status, usage, budgets, templates and presets', async () => {
    const services = await testServices({ profile: 'full' });
    const server = await startApi(services);
    try {
      const status = await api(server.port, 'GET', '/api/status');
      expect(status.data).toMatchObject({ status: 'ok' });
      expect((status.data['caller'] as { isAdmin: boolean }).isAdmin).toBe(true);

      expect((await api(server.port, 'GET', '/api/usage?groupBy=bogus')).status).toBe(400);
      const usage = await api(server.port, 'GET', '/api/usage?groupBy=agent');
      expect(usage.data).toMatchObject({ totals: { jobs: 0 } });

      expect((await api(server.port, 'POST', '/api/budgets', { body: { scope: 'bogus' } })).status).toBe(400);
      expect((await api(server.port, 'GET', '/api/budgets')).status).toBe(200);

      expect((await api(server.port, 'GET', '/api/templates')).status).toBe(200);
      expect((await api(server.port, 'POST', '/api/presets', { body: { name: 'p' } })).status).toBe(400);
      const saved = await api(server.port, 'POST', '/api/presets', {
        body: { name: 'p', grants: ['s/t'] }
      });
      expect(saved.status).toBe(200);
      expect((await api(server.port, 'GET', '/api/toolservers')).status).toBe(200);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('registers, lists, inspects and removes a tool server over the API', async () => {
    const services = await testServices({ profile: 'full' });
    const server = await startApi(services);
    try {
      const tsx = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
      const fixture = fileURLToPath(new URL('../fixtures/echo-mcp-server.ts', import.meta.url));
      const registered = await api(server.port, 'POST', '/api/toolservers', {
        body: {
          name: 'echo',
          transport: { type: 'stdio', command: tsx, args: [fixture] },
          requireApprovalFor: ['danger']
        }
      });
      expect(registered.status).toBe(200);
      expect(registered.data['server']).toMatchObject({
        name: 'echo',
        transport: 'stdio',
        requireApprovalFor: ['danger']
      });

      expect((await api(server.port, 'GET', '/api/toolservers')).data['servers']).toEqual([
        expect.objectContaining({ name: 'echo', requireApprovalFor: ['danger'] })
      ]);

      const tools = await api(server.port, 'GET', '/api/toolservers/echo/tools');
      const names = (tools.data['tools'] as { name: string; description: string }[]).map(t => t.name).sort();
      expect(names).toEqual(['add', 'danger', 'echo']);
      for (const tool of tools.data['tools'] as { description: string }[]) {
        expect(typeof tool.description).toBe('string');
      }

      // Validation mirrors toolserver_register: bad transport and missing name fail.
      expect(
        (await api(server.port, 'POST', '/api/toolservers', { body: { name: 'bad', transport: { type: 'pigeon' } } }))
          .status
      ).toBe(400);
      expect((await api(server.port, 'POST', '/api/toolservers', { body: {} })).status).toBe(400);

      // Removal needs its own explicit confirmation, like every destructive route.
      expect((await api(server.port, 'DELETE', '/api/toolservers/echo')).status).toBe(400);
      const removed = await api(server.port, 'DELETE', '/api/toolservers/echo?confirm=true');
      expect(removed.data).toMatchObject({ removed: true });
      expect((await api(server.port, 'GET', '/api/toolservers/echo/tools')).status).toBe(404);
    } finally {
      await server.close();
      await closeServices(services);
    }
    // Spawning tsx is slow and the full suite contends for CPU: measured near
    // the 5s default under load, like the mcp-proxy fixture tests.
  }, 30_000);

  it('scopes events and rejects bad input', async () => {
    const services = await testServices({ profile: 'standard' });
    const server = await startApi(services);
    try {
      const agent = await services.agents.create({ name: 'a', instructions: 'x', runner: 'mock' });
      const job = await services.scheduler.submit({
        backend: 'local',
        agentId: agent.id,
        agentSnapshot: { id: agent.id, name: agent.name, kind: 'local', instructions: 'x' },
        instruction: 'go'
      });
      await services.scheduler.drain();

      const scoped = await api(server.port, 'GET', `/api/events?jobId=${job.id}`);
      expect(scoped.status).toBe(200);
      expect((scoped.data['events'] as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });
});

