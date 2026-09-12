import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createJwtVerifier, hasScope, principalFor } from '../../src/auth.js';
import { SINGLE_USER_PRINCIPAL } from '../../src/core/principal.js';

/**
 * A real JWKS endpoint over HTTP, not a mock of `jose` — createJwtVerifier
 * fetches the key set itself via createRemoteJWKSet, so a fixture that skips
 * the network would never exercise the actual verification path at all.
 */
async function startJwks(): Promise<{ issuerUrl: string; sign: (claims: Record<string, unknown>) => Promise<string>; close: () => Promise<void> }> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const server: Server = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const issuerUrl = `http://127.0.0.1:${port}/`;

  return {
    issuerUrl,
    sign: async claims => {
      let jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuerUrl)
        .setAudience('resource-url')
        .setExpirationTime('1h');
      if (typeof claims['sub'] === 'string') jwt = jwt.setSubject(claims['sub']);
      return jwt.sign(privateKey);
    },
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  };
}

describe('createJwtVerifier', () => {
  let jwks: Awaited<ReturnType<typeof startJwks>> | undefined;

  afterEach(async () => {
    await jwks?.close();
    jwks = undefined;
  });

  it('verifies a well-formed token and reports its subject and scopes', async () => {
    jwks = await startJwks();
    const verifier = createJwtVerifier({
      issuerUrl: jwks.issuerUrl,
      resourceUrl: 'resource-url',
      requiredScopes: []
    });

    const token = await jwks.sign({ sub: 'user_alice', scope: 'orch:admin read' });
    const authInfo = await verifier.verifyAccessToken(token);

    expect(authInfo.clientId).toBe('user_alice');
    expect(authInfo.scopes).toEqual(['orch:admin', 'read']);
  });

  // Regression: a token with no `sub` claim (the ordinary shape of a
  // client-credentials / service token, which has no end-user at all) fell
  // back to the literal string 'unknown' as its clientId. Every resource a
  // caller creates is keyed by that value, so every subject-less token —
  // however many different services they actually belonged to — silently
  // collapsed into one shared owner, each seeing the others' private agents,
  // jobs, memory and artifacts.
  it('refuses a token with no subject claim rather than inventing a shared owner', async () => {
    jwks = await startJwks();
    const verifier = createJwtVerifier({
      issuerUrl: jwks.issuerUrl,
      resourceUrl: 'resource-url',
      requiredScopes: []
    });

    const token = await jwks.sign({ scope: 'read' });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/subject/i);
  });
});

describe('principalFor', () => {
  it('is the single-owner sentinel when there is no auth info at all', () => {
    expect(principalFor(undefined)).toEqual(SINGLE_USER_PRINCIPAL);
  });

  it('derives ownerId from clientId and isAdmin from the admin scope', () => {
    const principal = principalFor({
      token: 't',
      clientId: 'user_bob',
      scopes: ['orch:admin'],
      expiresAt: 0
    });

    expect(principal).toEqual({ ownerId: 'user_bob', isAdmin: true });
  });

  it('is not admin without the admin scope', () => {
    const principal = principalFor({ token: 't', clientId: 'user_bob', scopes: [], expiresAt: 0 });
    expect(principal.isAdmin).toBe(false);
  });
});

describe('hasScope', () => {
  it('is true for anyone when there is no auth info (OAuth not configured)', () => {
    expect(hasScope(undefined, 'orch:admin')).toBe(true);
  });

  it('checks the scope list when auth info is present', () => {
    const authInfo = { token: 't', clientId: 'user_bob', scopes: ['orch:admin'], expiresAt: 0 };
    expect(hasScope(authInfo, 'orch:admin')).toBe(true);
    expect(hasScope(authInfo, 'other:scope')).toBe(false);
  });
});
