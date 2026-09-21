import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { AGENT_CARD_PATH, startA2AServer, type A2AHttpHandle } from '../../src/a2a/http.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import { SERVER_NAME, VERSION } from '../../src/version.js';
import { closeServices, testServices } from '../helpers.js';

function raw(
  port: number,
  path: string,
  options: { method?: string; host?: string; origin?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          host: options.host ?? '127.0.0.1',
          ...(options.origin !== undefined && { origin: options.origin }),
          ...options.headers
        }
      },
      res => {
        let body = '';
        res.on('data', chunk => {
          body += String(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string>, body })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * CORS rides the same Host/Origin guards as everything else on the port: a
 * named origin must pass the origin check to earn its headers, and allow-all
 * answers every origin with a bare star.
 */
describe('CORS on the MCP surface', () => {
  it('answers every origin with a star by default', async () => {
    const services = await testServices({ profile: 'standard' });
    const server: HttpServerHandle = await startHttpServer({
      factory: createServerFactory({ services, startedAt: Date.now() }),
      config: { httpHost: '127.0.0.1', httpPort: 0 },
      logger: services.logger
    });

    try {
      const health = await raw(server.port, '/health', { origin: 'https://anything.example/' });
      expect(health.status).toBe(200);
      expect(health.headers['access-control-allow-origin']).toBe('*');

      const preflight = await raw(server.port, '/mcp', {
        method: 'OPTIONS',
        origin: 'https://anything.example/',
        headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('*');
      expect(String(preflight.headers['access-control-allow-methods'] ?? '')).toContain('POST');
    } finally {
      await server.close();
      await closeServices(services);
    }
  });

  it('echoes a named origin and stays silent for anyone else', async () => {
    const services = await testServices({ profile: 'standard' });
    const server: HttpServerHandle = await startHttpServer({
      factory: createServerFactory({ services, startedAt: Date.now() }),
      config: {
        httpHost: '127.0.0.1',
        httpPort: 0,
        corsAllowedOrigins: ['https://app.example.com']
      },
      logger: services.logger
    });

    try {
      const allowed = await raw(server.port, '/health', { origin: 'https://app.example.com/' });
      expect(allowed.status).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(allowed.headers['vary']).toBe('Origin');

      // A named origin passes the origin guard by hostname, so it reaches
      // the route at all — unlike a stranger, which is still rejected first.
      const stranger = await raw(server.port, '/health', { origin: 'https://evil.example.com/' });
      expect(stranger.status).toBe(403);
      expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await server.close();
      await closeServices(services);
    }
  });
});

describe('CORS on the A2A surface', () => {
  it('serves the card cross-origin by default and honors a list', async () => {
    const services = await testServices();
    const open: A2AHttpHandle = await startA2AServer({
      deps: {
        skills: services.publishedSkills,
        scheduler: services.scheduler,
        agents: services.agents,
        logger: services.logger,
        defaultRunner: 'mock',
        serverName: SERVER_NAME,
        serverVersion: VERSION
      },
      host: '127.0.0.1',
      port: 0,
      logger: services.logger
    });

    try {
      const card = await raw(open.port, AGENT_CARD_PATH, { origin: 'https://anything.example/' });
      expect(card.status).toBe(200);
      expect(card.headers['access-control-allow-origin']).toBe('*');
    } finally {
      await open.close();
    }

    const strict: A2AHttpHandle = await startA2AServer({
      deps: {
        skills: services.publishedSkills,
        scheduler: services.scheduler,
        agents: services.agents,
        logger: services.logger,
        defaultRunner: 'mock',
        serverName: SERVER_NAME,
        serverVersion: VERSION
      },
      host: '127.0.0.1',
      port: 0,
      logger: services.logger,
      corsAllowedOrigins: ['https://app.example.com']
    });

    try {
      const allowed = await raw(strict.port, AGENT_CARD_PATH, { origin: 'https://app.example.com/' });
      expect(allowed.status).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');

      const stranger = await raw(strict.port, AGENT_CARD_PATH, { origin: 'https://evil.example.com/' });
      expect(stranger.status).toBe(403);
    } finally {
      await strict.close();
      await closeServices(services);
    }
  });
});
