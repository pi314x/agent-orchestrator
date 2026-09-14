import { afterEach, describe, expect, it } from 'vitest';
import { createJwtVerifier, hasScope, principalFor } from '../../src/auth.js';
import { SINGLE_USER_PRINCIPAL } from '../../src/core/principal.js';
import { JWKS_AUDIENCE, startJwks } from '../fixtures/jwks.js';

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
      resourceUrl: JWKS_AUDIENCE,
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
      resourceUrl: JWKS_AUDIENCE,
      requiredScopes: []
    });

    const token = await jwks.sign({ scope: 'read' });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/subject/i);
  });
});

describe('principalFor', () => {
  it('is the single-owner sentinel when there is no auth info at all', async () => {
    expect(principalFor(undefined)).toEqual(SINGLE_USER_PRINCIPAL);
  });

  it('derives ownerId from clientId and isAdmin from the admin scope', async () => {
    const principal = principalFor({
      token: 't',
      clientId: 'user_bob',
      scopes: ['orch:admin'],
      expiresAt: 0
    });

    expect(principal).toEqual({ ownerId: 'user_bob', isAdmin: true });
  });

  it('is not admin without the admin scope', async () => {
    const principal = principalFor({ token: 't', clientId: 'user_bob', scopes: [], expiresAt: 0 });
    expect(principal.isAdmin).toBe(false);
  });
});

describe('hasScope', () => {
  it('is true for anyone when there is no auth info (OAuth not configured)', async () => {
    expect(hasScope(undefined, 'orch:admin')).toBe(true);
  });

  it('checks the scope list when auth info is present', async () => {
    const authInfo = { token: 't', clientId: 'user_bob', scopes: ['orch:admin'], expiresAt: 0 };
    expect(hasScope(authInfo, 'orch:admin')).toBe(true);
    expect(hasScope(authInfo, 'other:scope')).toBe(false);
  });
});
