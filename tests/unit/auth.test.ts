import { afterEach, describe, expect, it } from 'vitest';
import { createJwtVerifier, hasScope, principalFor } from '../../src/auth.js';
import { SINGLE_USER_PRINCIPAL } from '../../src/core/principal.js';
import { JWKS_AUDIENCE, startJwks, startPqcJwks, type PqcJwks } from '../fixtures/jwks.js';

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
      requiredScopes: [],
      adminRoles: []
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
      requiredScopes: [],
      adminRoles: []
    });

    const token = await jwks.sign({ scope: 'read' });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/subject/i);
  });

  // Entra mints a stable per-user object id (oid) while sub varies per
  // application registration. Preferring oid keeps one human on one owner
  // across every client app; anything else keeps sub.
  it('prefers oid over sub for the owner id', async () => {
    jwks = await startJwks();
    const verifier = createJwtVerifier({
      issuerUrl: jwks.issuerUrl,
      resourceUrl: JWKS_AUDIENCE,
      requiredScopes: [],
      adminRoles: []
    });

    const entra = await jwks.sign({ oid: 'entra-object-id', sub: 'pairwise-subject', scp: 'read' });
    expect((await verifier.verifyAccessToken(entra)).clientId).toBe('entra-object-id');

    const plain = await jwks.sign({ sub: 'user_alice', scope: 'read' });
    expect((await verifier.verifyAccessToken(plain)).clientId).toBe('user_alice');
  });

  it('merges scp alongside scope, and maps a configured admin role', async () => {
    jwks = await startJwks();
    const verifier = createJwtVerifier({
      issuerUrl: jwks.issuerUrl,
      resourceUrl: JWKS_AUDIENCE,
      requiredScopes: [],
      adminRoles: ['Orchestrator.Admin']
    });

    const scoped = await jwks.sign({ sub: 'user_bob', scp: 'orch:admin read' });
    expect((await verifier.verifyAccessToken(scoped)).scopes).toEqual(['orch:admin', 'read']);

    const roled = await jwks.sign({ sub: 'user_carol', roles: ['Orchestrator.Admin'] });
    const authInfo = await verifier.verifyAccessToken(roled);
    expect(authInfo.scopes).toContain('orch:admin');
    expect(principalFor(authInfo).isAdmin).toBe(true);
  });

  it('still refuses a token with neither oid nor sub', async () => {
    jwks = await startJwks();
    const verifier = createJwtVerifier({
      issuerUrl: jwks.issuerUrl,
      resourceUrl: JWKS_AUDIENCE,
      requiredScopes: [],
      adminRoles: []
    });

    await expect(verifier.verifyAccessToken(await jwks.sign({}))).rejects.toThrow(/subject/i);
  });

  // The whole point of discovery: an Entra-shaped issuer keeps its keys at
  // /discovery/v2.0/keys, a URL no derivation from the issuer could produce.
  it('discovers the JWKS for a sub-path issuer instead of deriving it', async () => {
    jwks = await startJwks();
    const issuerUrl = `${jwks.issuerUrl}tenant-abc/v2.0/`;
    const verifier = createJwtVerifier({ issuerUrl, resourceUrl: JWKS_AUDIENCE, requiredScopes: [], adminRoles: [] });

    const token = await jwks.sign({ sub: 'user_alice' }, { issuer: issuerUrl });
    expect((await verifier.verifyAccessToken(token)).clientId).toBe('user_alice');
  });

  it('rejects a malformed JWKS override as invalid-token, not a TypeError', async () => {
    jwks = await startJwks();
    const verifier = createJwtVerifier({
      issuerUrl: jwks.issuerUrl,
      resourceUrl: JWKS_AUDIENCE,
      requiredScopes: [],
      adminRoles: [],
      jwksUrl: 'not a url at all'
    });

    const token = await jwks.sign({ sub: 'user_alice' });
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/not a valid URL/);
  });

  it('uses a configured JWKS url without discovery', async () => {
    jwks = await startJwks();
    const verifier = createJwtVerifier({
      issuerUrl: jwks.issuerUrl,
      resourceUrl: JWKS_AUDIENCE,
      requiredScopes: [],
      adminRoles: [],
      jwksUrl: `${jwks.issuerUrl}.well-known/jwks.json`
    });

    const token = await jwks.sign({ sub: 'user_alice' });
    expect((await verifier.verifyAccessToken(token)).clientId).toBe('user_alice');
  });
});

describe('createJwtVerifier with ML-DSA-65 (NIST FIPS 204)', () => {
  let pqc: PqcJwks | undefined;

  afterEach(async () => {
    await pqc?.close();
    pqc = undefined;
  });

  async function verifier() {
    pqc = await startPqcJwks();
    return createJwtVerifier({
      issuerUrl: pqc.issuerUrl,
      resourceUrl: JWKS_AUDIENCE,
      requiredScopes: [],
      adminRoles: [],
      jwksUrl: pqc.jwksUrl
    });
  }

  it('verifies a PQC-signed token without touching jose', async () => {
    const verify = await verifier();
    const authInfo = await verify.verifyAccessToken(pqc?.sign({ sub: 'user_alice', scope: 'read' }) ?? '');

    expect(authInfo.clientId).toBe('user_alice');
    expect(authInfo.scopes).toEqual(['read']);
  });

  it('rejects a tampered payload as invalid-token, not a crash', async () => {
    const verify = await verifier();
    const good = pqc?.sign({ sub: 'user_alice' }) ?? '';
    const [header, payload, signature] = good.split('.');
    const edited = Buffer.from(JSON.stringify({ sub: 'user_bob' })).toString('base64url');

    await expect(verify.verifyAccessToken(`${header}.${edited}.${signature}`)).rejects.toThrow(
      /signature verification failed/
    );
    expect(payload).not.toBe(edited);
  });

  it('rejects an expired PQC token and one minted for another resource', async () => {
    const verify = await verifier();

    await expect(
      verify.verifyAccessToken(pqc?.sign({ sub: 'user_alice' }, { expiresInSec: -10 }) ?? '')
    ).rejects.toThrow(/expired/);

    // Re-mint manually below would need the fixture key; instead prove the
    // audience check with a token whose aud jose would also refuse — the PQC
    // path checks the same value through its own code.
    const verifierOther = createJwtVerifier({
      issuerUrl: pqc?.issuerUrl ?? '',
      resourceUrl: 'https://other.example.test/mcp',
      requiredScopes: [],
      adminRoles: [],
      jwksUrl: pqc?.jwksUrl ?? ''
    });
    await expect(
      verifierOther.verifyAccessToken(pqc?.sign({ sub: 'user_alice' }) ?? '')
    ).rejects.toThrow(/audience/);
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
