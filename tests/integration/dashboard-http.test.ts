import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import { closeServices, testServices } from '../helpers.js';

function get(port: number, path: string): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      let body = '';
      res.on('data', chunk => {
        body += String(chunk);
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * The live dashboard: the same collector the `orch://dashboard` resource
 * serves, rendered as HTML at GET /dashboard (and raw at /dashboard.json)
 * behind the same Host/Origin guards as the MCP surface.
 */
describe('dashboard over HTTP', () => {
  it('serves live HTML and JSON from the same collector', async () => {
    const startedAt = Date.now();
    const services = await testServices({ profile: 'standard' });
    await services.agents.create({ name: 'dash-agent', instructions: 'Be brief.', runner: 'mock' });

    const server: HttpServerHandle = await startHttpServer({
      factory: createServerFactory({ services, startedAt }),
      config: { httpHost: '127.0.0.1', httpPort: 0 },
      logger: services.logger,
      dashboard: { services, version: VERSION, startedAt }
    });

    try {
      const html = await get(server.port, '/dashboard');
      expect(html.status).toBe(200);
      expect(html.contentType).toContain('text/html');
      expect(html.body).toContain('Agent Orchestrator');
      expect(html.body).toContain('dash-agent');
      expect(html.body).toContain('Memory &amp; Artifacts');

      const json = await get(server.port, '/dashboard.json');
      expect(json.status).toBe(200);
      expect(json.contentType).toContain('application/json');
      const data = JSON.parse(json.body) as { agents: { name: string }[]; status: { version: string } };
      expect(data.agents.map(agent => agent.name)).toContain('dash-agent');
      expect(data.status.version).toBe(VERSION);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('answers 404 when the dashboard is not wired up', async () => {
    const services = await testServices({ profile: 'standard' });
    const server: HttpServerHandle = await startHttpServer({
      factory: createServerFactory({ services, startedAt: Date.now() }),
      config: { httpHost: '127.0.0.1', httpPort: 0 },
      logger: services.logger
    });

    try {
      expect((await get(server.port, '/dashboard')).status).toBe(404);
    } finally {
      await server.close();
      await closeServices(services);
    }
  });
});
