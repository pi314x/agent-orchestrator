import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import { testServices } from '../helpers.js';

/**
 * `httpHost` is a bind *address* (`0.0.0.0` to accept remote connections);
 * the Host header a real remote client sends is the public hostname it
 * connects to — a reverse proxy's domain — which is an entirely different
 * string. Before ORCH_HTTP_ALLOWED_HOSTS existed, binding 0.0.0.0 alone did
 * not make the server reachable by any real remote client: every request
 * carrying a public Host header was rejected with 403 by the DNS-rebinding
 * guard before OAuth, routing, or anything else ran. This is what actually
 * blocked a hosted client (ChatGPT's connector backend, or any other) from
 * reaching a deployment exposed behind a reverse proxy.
 */
async function get(port: number, host: string, path = '/health'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, res =>
      resolve(res.statusCode ?? 0)
    );
    req.on('error', reject);
    req.end();
  });
}

describe('exposing the server beyond localhost', () => {
  it('rejects an unlisted public Host by default — the security boundary is unchanged', async () => {
    const services = await testServices({ profile: 'standard' });
    const server: HttpServerHandle = await startHttpServer({
      factory: createServerFactory({ services, startedAt: Date.now() }),
      config: { httpHost: '0.0.0.0', httpPort: 0 },
      logger: services.logger
    });

    expect(await get(server.port, 'orchestrator.example.com')).toBe(403);
    // Loopback names always work, independent of any configuration.
    expect(await get(server.port, '127.0.0.1')).toBe(200);

    await server.close();
  });

  it('accepts the reverse proxy domain once ORCH_HTTP_ALLOWED_HOSTS names it', async () => {
    const services = await testServices({ profile: 'standard' });
    const server: HttpServerHandle = await startHttpServer({
      factory: createServerFactory({ services, startedAt: Date.now() }),
      config: { httpHost: '0.0.0.0', httpPort: 0, httpAllowedHosts: ['orchestrator.example.com'] },
      logger: services.logger
    });

    expect(await get(server.port, 'orchestrator.example.com')).toBe(200);
    // Still rejects anything not explicitly named — this is an allowlist,
    // not a switch that turns the check off.
    expect(await get(server.port, 'evil.example.com')).toBe(403);

    await server.close();
  });
});
