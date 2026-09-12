import { request } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpServer, type HttpServerHandle } from '../../src/http.js';
import { createServerFactory } from '../../src/server.js';
import { JWKS_AUDIENCE, startJwks, type Jwks } from '../fixtures/jwks.js';
import { closeServices, testServices } from '../helpers.js';
import type { Services } from '../../src/services.js';

/**
 * Every other multi-user test drives tool handlers directly with a hand-built
 * Principal — real, but it never proves the actual wire is connected: a real
 * HTTP request, carrying a real cryptographically signed JWT, verified against
 * a real JWKS endpoint over the network, turned into the AuthInfo that
 * principalFor derives ownership from. This is the one test that goes through
 * every one of those steps for real, the same "real wire, not a mock"
 * standard already applied to the Anthropic runner and to createJwtVerifier's
 * own unit tests.
 */

let server: HttpServerHandle | undefined;
let services: Services | undefined;
let jwks: Jwks | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await jwks?.close();
  jwks = undefined;
  if (services !== undefined) await closeServices(services);
  services = undefined;
});

async function start(): Promise<HttpServerHandle> {
  jwks = await startJwks();
  services = testServices();
  return startHttpServer({
    factory: createServerFactory({ services, startedAt: Date.now() }),
    config: {
      httpHost: '127.0.0.1',
      httpPort: 0,
      oauthIssuerUrl: jwks.issuerUrl,
      oauthResourceUrl: JWKS_AUDIENCE,
      oauthRequiredScopes: []
    },
    logger: services.logger
  });
}

async function clientWithToken(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'oauth-integration-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } })
  );
  return client;
}

/** Raw socket, not fetch: exercises the gate before any SDK client machinery exists to get in the way. */
function rawToolsList(url: string, authorization?: string): Promise<number> {
  const target = new URL(url);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...(authorization !== undefined && { authorization })
        }
      },
      res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('MCP over Streamable HTTP with a real OAuth token', () => {
  it('refuses a request with no Authorization header at all', async () => {
    server = await start();
    await expect(rawToolsList(server.url)).resolves.toBe(401);
  });

  it('refuses a request whose bearer token has a bad signature', async () => {
    server = await start();
    const token = await (jwks as Jwks).sign({ sub: 'user_alice', scope: '' });
    // Flip a character in the signature segment - still well-formed JWS, still rejected.
    const parts = token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${(parts[2] ?? '').split('').reverse().join('')}`;

    await expect(rawToolsList(server.url, `Bearer ${forged}`)).resolves.toBe(401);
  });

  // Regression: createJwtVerifier let every failure - a bad signature, an
  // expired token, wrong issuer or audience, a missing sub claim - propagate
  // as a bare Error. requireBearerAuth's own bearerAuthChallengeResponse maps
  // a non-OAuthError to a bare 500, not 401: only an actual OAuthError gets
  // the correct 401 plus WWW-Authenticate challenge. A client implementing
  // the OAuth challenge-response flow correctly (this project's own
  // StreamableHTTPClientTransport included) never even got the chance to
  // reauthorize on an expired token - it just saw a server error.
  it('answers an expired token with 401, not 500', async () => {
    server = await start();
    const token = await (jwks as Jwks).sign({ sub: 'user_alice', scope: '' }, { expiresIn: '-10s' });

    await expect(rawToolsList(server.url, `Bearer ${token}`)).resolves.toBe(401);
  });

  it('accepts a genuinely signed token for a known issuer and audience', async () => {
    server = await start();
    const token = await (jwks as Jwks).sign({ sub: 'user_alice', scope: '' });

    await expect(rawToolsList(server.url, `Bearer ${token}`)).resolves.toBe(200);
  });

  // Regression territory: every other cross-owner test in this suite drives
  // tool handlers directly with a Principal built by hand. This is the one
  // proof that a real bearer token, over a real HTTP request, actually
  // produces that same isolation end to end - the JWT's `sub` becomes the
  // ownerId that agent_create stamps and agent_list filters by, not just in
  // a unit test's imagination of what the server does with it.
  it("two real, independently signed tokens see only their own agent, and an admin-scoped token sees both", async () => {
    server = await start();
    const aliceToken = await (jwks as Jwks).sign({ sub: 'user_alice', scope: '' });
    const bobToken = await (jwks as Jwks).sign({ sub: 'user_bob', scope: '' });
    const adminToken = await (jwks as Jwks).sign({ sub: 'user_admin', scope: 'orch:admin' });

    const alice = await clientWithToken(server.url, aliceToken);
    const bob = await clientWithToken(server.url, bobToken);
    const admin = await clientWithToken(server.url, adminToken);

    try {
      const created = await alice.callTool({
        name: 'agent_create',
        arguments: { name: 'alices-real-agent', instructions: 'x', runner: 'mock' }
      });
      expect(created.isError).toBeFalsy();

      const byAlice = await alice.callTool({ name: 'agent_list', arguments: {} });
      const aliceNames = (byAlice.structuredContent as { agents: { name: string }[] }).agents.map(a => a.name);
      expect(aliceNames).toContain('alices-real-agent');

      const byBob = await bob.callTool({ name: 'agent_list', arguments: {} });
      const bobNames = (byBob.structuredContent as { agents: { name: string }[] }).agents.map(a => a.name);
      expect(bobNames).not.toContain('alices-real-agent');

      const byAdmin = await admin.callTool({ name: 'agent_list', arguments: {} });
      const adminNames = (byAdmin.structuredContent as { agents: { name: string }[] }).agents.map(a => a.name);
      expect(adminNames).toContain('alices-real-agent');
    } finally {
      await alice.close();
      await bob.close();
      await admin.close();
    }
  });

  it("refuses a non-admin token's attempt to attach toolGrants, over the real wire", async () => {
    server = await start();
    const bobToken = await (jwks as Jwks).sign({ sub: 'user_bob', scope: '' });
    const bob = await clientWithToken(server.url, bobToken);

    try {
      const result = await bob.callTool({
        name: 'agent_create',
        arguments: { name: 'sneaky', instructions: 'x', toolGrants: ['files'] }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('orch:admin');
    } finally {
      await bob.close();
    }
  });
});
