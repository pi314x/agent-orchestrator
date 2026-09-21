import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from './config.js';
import { pqcVerify, PQC_SIGN_ALG } from './core/pqc.js';
import { SINGLE_USER_PRINCIPAL, type Principal } from './core/principal.js';

/**
 * Scopes gating the tools that can change what the orchestrator is allowed to
 * do, per PLAN §11. Checked per tool, not only at the endpoint.
 */
export const ADMIN_SCOPE = 'orch:admin';

export interface OAuthSettings {
  issuerUrl: string;
  resourceUrl: string;
  requiredScopes: string[];
  /** Skip OIDC discovery and fetch keys here instead. For providers whose discovery is unreachable. */
  jwksUrl?: string;
  /** App-role values that grant orch:admin (e.g. an Entra app role). Case-sensitive, matched exactly. */
  adminRoles: string[];
}

export function oauthSettings(config: Config): OAuthSettings | undefined {
  if (config.oauthIssuerUrl === undefined) return undefined;

  return {
    issuerUrl: config.oauthIssuerUrl,
    resourceUrl: config.oauthResourceUrl ?? `http://${config.httpHost}:${config.httpPort}/mcp`,
    requiredScopes: config.oauthRequiredScopes,
    ...(config.oauthJwksUrl !== undefined && { jwksUrl: config.oauthJwksUrl }),
    adminRoles: config.oauthAdminRoles
  };
}

/**
 * Verifies a bearer JWT against the issuer's JWKS. `iss` is checked against the
 * configured issuer (RFC 9207) and the audience against our resource URL, so a
 * token minted for a different resource cannot be replayed here.
 */
export function createJwtVerifier(settings: OAuthSettings): OAuthTokenVerifier {
  let cached: ReturnType<typeof createRemoteJWKSet> | undefined;

  // Standard OIDC discovery, not derivation: appending
  // `.well-known/jwks.json` to the issuer works for no real provider —
  // Entra publishes keys at `/discovery/v2.0/keys`, reachable only through
  // the discovery document. Lazy on first use with a cached result; a failed
  // discovery is deliberately not cached, so a briefly unreachable IdP does
  // not wedge verification until the next restart.
  const keySetUrl = async (): Promise<URL> => {
    if (settings.jwksUrl !== undefined) {
      // A malformed override must 401 like every other verifier failure, not
      // escape as a raw TypeError into a bare 500 — same mapping doctrine as
      // the jose errors below.
      try {
        return new URL(settings.jwksUrl);
      } catch {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          `Configured ORCH_OAUTH_JWKS_URL is not a valid URL: ${settings.jwksUrl}`
        );
      }
    }
    const discoveryUrl = new URL('.well-known/openid-configuration', ensureTrailingSlash(settings.issuerUrl));
    let document: { jwks_uri?: unknown };
    try {
      const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`discovery returned ${response.status}`);
      document = (await response.json()) as { jwks_uri?: unknown };
    } catch (error) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        `Cannot discover JWKS for ${settings.issuerUrl}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (typeof document.jwks_uri !== 'string') {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        `Issuer ${settings.issuerUrl} names no jwks_uri in its discovery document.`
      );
    }
    try {
      return new URL(document.jwks_uri);
    } catch {
      throw new OAuthError(OAuthErrorCode.InvalidToken, `Issuer ${settings.issuerUrl} names an invalid jwks_uri.`);
    }
  };

  const keySet = async (): Promise<ReturnType<typeof createRemoteJWKSet>> => {
    cached ??= createRemoteJWKSet(await keySetUrl());
    return cached;
  };

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // requireBearerAuth's own challenge-response mapping (bearerAuthChallengeResponse)
      // answers 401 with a proper WWW-Authenticate challenge only for an
      // OAuthError; anything else — every error jose itself throws (bad
      // signature, expired, wrong issuer/audience, malformed JWT) included —
      // becomes a bare 500. A client implementing the OAuth challenge flow
      // correctly (as this project's own StreamableHTTPClientTransport does)
      // never even sees a chance to reauthorize: it just sees a server error.
      const header = readJwtHeader(token);
      let payload: Record<string, unknown>;
      try {
        payload =
          header.alg === PQC_SIGN_ALG
            ? await verifyPqcToken(token, header.kid, settings, keySetUrl)
            : await verifyJoseToken(token, settings, await keySet());
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          error instanceof Error ? error.message : String(error)
        );
      }

      // Every resource this caller creates is keyed by this value — a
      // fallback to a shared literal here would silently collapse every
      // subject-less token (a client-credentials / service token, which
      // legitimately has no end-user sub, is the ordinary case that produces
      // one) into a single owner, so unrelated services would each see the
      // others' private agents, jobs, memory and artifacts.
      // Entra's stable per-user object id (`oid`) is preferred over `sub`,
      // which varies per application registration: without this, one human
      // would own a different identity per client app. Anything else keeps
      // `sub`.
      const subject =
        typeof payload['oid'] === 'string' && payload['oid'] !== ''
          ? payload['oid']
          : typeof payload['sub'] === 'string'
            ? payload['sub']
            : undefined;
      if (typeof subject !== 'string' || subject === '') {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          'Token carries neither an Entra object id (oid) nor a subject (sub) claim, so it cannot be mapped to an owner.'
        );
      }

      // `scope` (generic OIDC) and `scp` (Entra's name for the same thing)
      // are both space-separated scope lists. `roles` are Entra app-role
      // assignments: any configured admin role present promotes the caller
      // to orch:admin, since Entra never mints our scope name itself.
      const splitClaim = (value: unknown): string[] =>
        typeof value !== 'string'
          ? []
          : value
              .split(' ')
              .map(part => part.trim())
              .filter(part => part !== '');
      const roles = Array.isArray(payload['roles'])
        ? payload['roles'].filter((role): role is string => typeof role === 'string')
        : [];
      const scopes = [...splitClaim(payload['scope']), ...splitClaim(payload['scp'])];
      if (roles.some(role => settings.adminRoles.includes(role))) scopes.push(ADMIN_SCOPE);

      return {
        token,
        clientId: subject,
        scopes,
        // Both verification paths reject a token with no expiry, so this is set.
        expiresAt: typeof payload['exp'] === 'number' ? payload['exp'] : 0
      };
    }
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

type JwtHeader = { alg?: unknown; kid?: unknown };

/** Peek at the token's header to route classical vs PQC verification. */
function readJwtHeader(token: string): JwtHeader {
  const first = token.split('.')[0] ?? '';
  try {
    const header = JSON.parse(Buffer.from(first, 'base64url').toString('utf8')) as JwtHeader;
    if (typeof header !== 'object' || header === null) throw new Error('not an object');
    return header;
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token header is not valid base64url JSON.');
  }
}

async function verifyJoseToken(
  token: string,
  settings: OAuthSettings,
  keys: ReturnType<typeof createRemoteJWKSet>
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: settings.issuerUrl,
    audience: settings.resourceUrl
  });
  return payload as Record<string, unknown>;
}

type PqcJwk = { alg?: unknown; kid?: unknown; x?: unknown };

/** Small JWKS cache for the PQC path: 10 minutes, failures never cached. */
const pqcJwksCache = new Map<string, { at: number; keys: PqcJwk[] }>();
const PQC_JWKS_TTL_MS = 10 * 60 * 1000;

/**
 * Verifies a JWT signed with ML-DSA-65 (NIST FIPS 204). jose knows no such
 * `alg`, so this path resolves the key from the same JWKS document — entries
 * shaped `{ "alg": "ML-DSA-65", "kid", "x" }` with `x` the base64url
 * 1952-byte public key — and checks `iss`/`aud`/`exp` itself, with the same
 * strictness jose applies on the classical path (no clock-skew charity: an
 * expired token is expired).
 */
async function verifyPqcToken(
  token: string,
  kid: unknown,
  settings: OAuthSettings,
  keySetUrl: () => Promise<URL>
): Promise<Record<string, unknown>> {
  if (typeof kid !== 'string' || kid === '') {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'PQC token carries no kid, so its key cannot be located.');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] === '' || parts[1] === '' || parts[2] === '') {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'PQC token is not a three-part compact JWT.');
  }

  const jwksUrl = (await keySetUrl()).toString();
  const now = Date.now();
  const cached = pqcJwksCache.get(jwksUrl);
  let keys = cached !== undefined && now - cached.at < PQC_JWKS_TTL_MS ? cached.keys : undefined;
  if (keys === undefined) {
    const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new OAuthError(OAuthErrorCode.InvalidToken, `JWKS fetch returned ${response.status}.`);
    const jwks = (await response.json()) as { keys?: PqcJwk[] };
    keys = jwks.keys ?? [];
    pqcJwksCache.set(jwksUrl, { at: now, keys });
  }

  const key = keys.find(candidate => candidate.kid === kid && candidate.alg === PQC_SIGN_ALG);
  if (key === undefined || typeof key.x !== 'string') {
    throw new OAuthError(OAuthErrorCode.InvalidToken, `JWKS has no ${PQC_SIGN_ALG} key with kid ${kid}.`);
  }
  const publicKey = new Uint8Array(Buffer.from(key.x, 'base64url'));
  if (publicKey.length !== 1952) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, `JWKS key ${kid} is not a 1952-byte ${PQC_SIGN_ALG} public key.`);
  }

  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = new Uint8Array(Buffer.from(parts[2] ?? '', 'base64url'));
  if (!pqcVerify(publicKey, signingInput, signature)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'PQC signature verification failed.');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'PQC token payload is not valid base64url JSON.');
  }

  if (payload['iss'] !== settings.issuerUrl) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'PQC token issuer does not match the configured issuer.');
  }
  const audience = payload['aud'];
  const audiences = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : [];
  if (!audiences.includes(settings.resourceUrl)) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'PQC token audience does not match this resource.');
  }
  if (typeof payload['exp'] !== 'number' || payload['exp'] * 1000 <= now) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'PQC token is expired or carries no expiry.');
  }

  return payload;
}

/**
 * The token's subject is the owner of what this caller creates. `clientId`
 * carries `sub` (see `createJwtVerifier`): a stable per-user identifier the
 * issuer mints, not a display name and not anything the client chooses.
 *
 * Lives here rather than in `core/` because it speaks the MCP SDK's AuthInfo,
 * and core must not import the SDK.
 */
export function principalFor(authInfo: AuthInfo | undefined): Principal {
  if (authInfo === undefined) return SINGLE_USER_PRINCIPAL;

  return { ownerId: authInfo.clientId, isAdmin: authInfo.scopes.includes(ADMIN_SCOPE) };
}

/** True when the caller holds the scope, or when OAuth is not configured. */
export function hasScope(authInfo: AuthInfo | undefined, scope: string): boolean {
  if (authInfo === undefined) return true;
  return authInfo.scopes.includes(scope);
}
