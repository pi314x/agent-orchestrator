import { request } from 'node:http';
import { Role, SendMessageRequest } from '@a2a-js/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { startA2AServer, AGENT_CARD_PATH, type A2AHttpHandle } from '../../src/a2a/http.js';
import { SERVER_NAME, VERSION } from '../../src/version.js';
import type { Services } from '../../src/services.js';
import { closeServices, deferred, testServices } from '../helpers.js';

let server: A2AHttpHandle | undefined;
let services: Services | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (services !== undefined) await closeServices(services);
  services = undefined;
});

async function start(svc: Services): Promise<A2AHttpHandle> {
  return startA2AServer({
    deps: {
      skills: svc.publishedSkills,
      scheduler: svc.scheduler,
      agents: svc.agents,
      logger: svc.logger,
      defaultRunner: 'mock',
      serverName: SERVER_NAME,
      serverVersion: VERSION,
      taskTimeoutSec: 5
    },
    host: '127.0.0.1',
    port: 0,
    logger: svc.logger
  });
}

/** One JSON-RPC round trip, the way a remote agent would make it. */
async function rpc(url: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'r1', method, params })
  });
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Built through the SDK's own serializer rather than by hand, so the test
 * exercises the wire format a real peer would send (parts are `{text}`, not
 * the `$case` union the TypeScript types use).
 */
function sendParams(text: string, skillId?: string): unknown {
  return SendMessageRequest.toJSON({
    tenant: '',
    message: {
      messageId: `m-${Date.now()}`,
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: 'text', value: text },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain'
        }
      ],
      metadata: skillId === undefined ? undefined : { skillId },
      extensions: [],
      referenceTaskIds: []
    },
    configuration: undefined,
    metadata: undefined
  } as never);
}

/** `fetch` silently drops a forbidden `host` header, so drive the socket. */
function getWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        headers: { host }
      },
      res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Same reason as getWithHost: drive the socket so a forbidden Origin actually reaches the server. */
function postWithOrigin(url: string, origin: string | undefined, body: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(origin !== undefined && { origin })
        }
      },
      res => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('A2A inbound server', () => {
  it('serves the Agent Card at the well-known path', async () => {
    services = testServices();
    services.publishedSkills.upsert({
      skillId: 'review',
      templateName: 'reviewer',
      description: 'Reviews code.',
      exposed: true
    });
    server = await start(services);

    const card = (await (await fetch(server.cardUrl)).json()) as Record<string, unknown>;

    expect(server.cardUrl).toContain(AGENT_CARD_PATH);
    expect(card['name']).toBe(SERVER_NAME);
    expect((card['skills'] as { id: string }[]).map(s => s.id)).toEqual(['review']);
  });

  it('publishes nothing until a skill is opted in', async () => {
    services = testServices();
    server = await start(services);

    const card = (await (await fetch(server.cardUrl)).json()) as { skills: unknown[] };

    expect(card.skills).toEqual([]);
  });

  // Regression: DefaultRequestHandler takes the card by value, so a skill
  // withdrawn after startup stayed advertised until the process restarted.
  it('stops advertising a skill as soon as it is withdrawn', async () => {
    services = testServices();
    const skill = { skillId: 'review', templateName: 'reviewer', description: 'x' };
    services.publishedSkills.upsert({ ...skill, exposed: true });
    server = await start(services);

    expect(((await (await fetch(server.cardUrl)).json()) as { skills: unknown[] }).skills).toHaveLength(1);

    services.publishedSkills.upsert({ ...skill, exposed: false });

    expect(((await (await fetch(server.cardUrl)).json()) as { skills: unknown[] }).skills).toEqual([]);
  });

  it('runs a published skill and returns its result', async () => {
    services = testServices({ mockScript: job => ({ text: `handled:${job.instruction}` }) });
    services.publishedSkills.upsert({
      skillId: 'review',
      templateName: 'reviewer',
      description: 'x',
      exposed: true
    });
    server = await start(services);

    const body = await rpc(server.url, 'SendMessage', sendParams('check this diff', 'review'));

    expect(body['error']).toBeUndefined();
    expect(JSON.stringify(body['result'])).toContain('handled:check this diff');
  });

  it('rejects a skill that was never published', async () => {
    services = testServices();
    server = await start(services);

    const body = await rpc(server.url, 'SendMessage', sendParams('do something', 'not-published'));

    expect(JSON.stringify(body)).toMatch(/No published skill/);
  });

  it('refuses a request whose Host header is not allowed', async () => {
    services = testServices();
    server = await start(services);

    await expect(getWithHost(server.cardUrl, 'evil.example.com')).resolves.toBe(403);
    await expect(getWithHost(server.cardUrl, '127.0.0.1')).resolves.toBe(200);
  });

  // Regression: only Host was checked here, never Origin. A browser's fetch()
  // always sends a Host matching the URL it targets, regardless of the page's
  // own origin, so Host validation alone does not stop a page at any origin
  // from posting JSON-RPC directly to this loopback server - only Origin
  // validation does, which is why the MCP surface (src/http.ts) checks both.
  it('refuses a request whose Origin header is not allowed, even with a valid Host', async () => {
    services = testServices();
    server = await start(services);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'r1',
      method: 'SendMessage',
      params: sendParams('hi')
    });

    await expect(postWithOrigin(server.url, 'https://evil.example.com', body)).resolves.toBe(403);
    await expect(postWithOrigin(server.url, 'http://127.0.0.1', body)).resolves.toBe(200);
    // Real A2A peers are not browsers and do not send an Origin at all.
    await expect(postWithOrigin(server.url, undefined, body)).resolves.toBe(200);
  });

  it('answers a malformed body with a JSON-RPC parse error, not a crash', async () => {
    services = testServices();
    server = await start(services);

    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    });
    const body = (await response.json()) as { error?: { code?: number } };

    expect(body.error?.code).toBe(-32700);
  });

  it('404s an unknown path with a pointer to the real ones', async () => {
    services = testServices();
    server = await start(services);

    const response = await fetch(`${server.url.replace('/a2a', '')}/nope`);
    const body = (await response.json()) as { hint?: string };

    expect(response.status).toBe(404);
    expect(body.hint).toContain(AGENT_CARD_PATH);
  });

  // Regression: cancelTask only recorded the task id, so the job behind it ran
  // to completion — the cancel changed the report, not the work.
  it('cancelling a task cancels the job behind it', async () => {
    const gate = deferred();
    services = testServices({ mockScript: () => ({ gate: gate.promise }) });
    services.publishedSkills.upsert({
      skillId: 'slow',
      templateName: 'coder',
      description: 'x',
      exposed: true
    });
    server = await start(services);

    const send = rpc(server.url, 'SendMessage', sendParams('long job', 'slow'));

    // Wait for the job to actually be running before cancelling it.
    let jobId: string | undefined;
    for (let attempt = 0; attempt < 40 && jobId === undefined; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      jobId = (services as Services).jobs.list({ state: 'running' }).jobs[0]?.id;
    }
    expect(jobId).toBeDefined();

    const listed = await rpc(server.url, 'ListTasks', { tenant: '' });
    const taskId = (listed['result'] as { tasks: { id: string }[] }).tasks[0]?.id;
    expect(taskId).toBeDefined();

    const cancelled = await rpc(server.url, 'CancelTask', { id: taskId });
    expect(cancelled['error']).toBeUndefined();

    // The job must already be cancelled — without ever releasing the gate.
    const after = (services as Services).jobs.getOrThrow(jobId as string);
    expect(after.state).toBe('cancelled');

    gate.resolve();
    await send;
  });
});
