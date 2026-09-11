import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import type { Services } from '../../src/services.js';
import { closeServices, testServices } from '../helpers.js';

let server: HttpServerHandle;
let client: Client;
let services: Services;

type Structured = Record<string, unknown>;

const call = async (name: string, args: Record<string, unknown> = {}): Promise<Structured> => {
  const result = await client.callTool({ name, arguments: args });
  return (result.structuredContent ?? {}) as Structured;
};

beforeAll(async () => {
  services = testServices({ profile: 'standard' });

  server = await startHttpServer({
    factory: createServerFactory({ services, startedAt: Date.now() }),
    config: { httpHost: '127.0.0.1', httpPort: 0 },
    logger: services.logger
  });

  client = new Client({ name: 'delegation-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await closeServices(services);
});

describe('delegate', () => {
  it('runs an instruction on a template agent and returns the result', async () => {
    const output = await call('delegate', { instruction: 'summarize the release', template: 'summarizer' });

    expect(output['completed']).toBe(true);
    const job = output['job'] as Structured;
    expect(job['state']).toBe('succeeded');
    expect(job['resultText']).toContain('summarize the release');
    expect(job['backend']).toBe('local');
  });

  it('routes to an existing agent by skill query', async () => {
    await call('agent_create', {
      name: 'security-reviewer',
      role: 'reviewer',
      instructions: 'Review for security issues.',
      runner: 'mock'
    });

    const output = await call('delegate', { instruction: 'check the auth code', skillQuery: 'reviewer' });
    const job = output['job'] as Structured;

    expect(job['agentName']).toBe('security-reviewer');
    expect(job['state']).toBe('succeeded');
  });

  it('reports an unmatched skill query as a structured error', async () => {
    const result = await client.callTool({
      name: 'delegate',
      arguments: { instruction: 'do a thing', skillQuery: 'underwater-basket-weaving' }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns a handle without blocking when wait is false', async () => {
    const output = await call('delegate', {
      instruction: 'background work',
      template: 'writer',
      wait: false
    });

    expect(output['completed']).toBe(false);
    expect((output['job'] as Structured)['jobId']).toMatch(/^job_/);
  });
});

describe('job lifecycle over MCP', () => {
  it('submits, waits and reads back a job', async () => {
    const submitted = (
      await call('job_submit', {
        instruction: 'analyse the logs',
        template: 'researcher'
      })
    )['job'] as Structured;

    const jobId = submitted['jobId'] as string;

    const waited = await call('job_wait', { jobIds: [jobId], mode: 'all', timeoutSec: 5 });
    expect(waited['settled']).toBe(true);

    const fetched = (await call('job_get', { jobId, includeEvents: true }))['job'] as Structured;
    expect(fetched['state']).toBe('succeeded');
    expect(fetched['attempt']).toBe(1);
  });

  it('records an audit trail for each job', async () => {
    const submitted = (
      await call('job_submit', {
        instruction: 'audited work',
        template: 'coder'
      })
    )['job'] as Structured;

    const jobId = submitted['jobId'] as string;
    await call('job_wait', { jobIds: [jobId], timeoutSec: 5 });

    const events = (await call('job_get', { jobId, includeEvents: true }))['events'] as { type: string }[];
    expect(events.map(e => e.type)).toEqual(['job.submitted', 'job.started', 'job.succeeded']);
  });

  it('honours an idempotency key across retried submissions', async () => {
    const args = { instruction: 'exactly once', template: 'writer', idempotencyKey: 'once-only' };

    const first = (await call('job_submit', args))['job'] as Structured;
    const second = (await call('job_submit', args))['job'] as Structured;

    expect(second['jobId']).toBe(first['jobId']);
  });

  it('reports a missing job rather than inventing one', async () => {
    const result = await client.callTool({ name: 'job_get', arguments: { jobId: 'job_missing' } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists jobs filtered by state', async () => {
    const output = await call('job_list', { state: 'succeeded', limit: 5 });

    const jobs = output['jobs'] as Structured[];
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(job['state']).toBe('succeeded');
  });
});

describe('discovery tools', () => {
  it('lists the eight built-in templates', async () => {
    const templates = (await call('agent_template_list'))['templates'] as { name: string }[];

    expect(templates.map(t => t.name)).toEqual([
      'planner',
      'researcher',
      'coder',
      'reviewer',
      'tester',
      'writer',
      'critic',
      'summarizer'
    ]);
  });

  it('reports the mock runner as available and anthropic as unconfigured', async () => {
    const runners = (await call('runner_list'))['runners'] as { name: string; available: boolean }[];

    expect(runners.find(r => r.name === 'mock')?.available).toBe(true);
    expect(runners.find(r => r.name === 'anthropic')?.available).toBe(false);
  });

  it('surfaces queue depth in orchestrator_status', async () => {
    const status = await call('orchestrator_status');

    expect(status['jobs']).toMatchObject({ queued: 0, running: 0, blocked: 0 });
    expect(status['status']).toBe('ok');
  });
});
