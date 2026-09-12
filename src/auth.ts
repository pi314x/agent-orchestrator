import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from './config.js';
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
}

export function oauthSettings(config: Config): OAuthSettings | undefined {
  if (config.oauthIssuerUrl === undefined) return undefined;

  return {
    issuerUrl: config.oauthIssuerUrl,
    resourceUrl: config.oauthResourceUrl ?? `http://${config.httpHost}:${config.httpPort}/mcp`,
    requiredScopes: config.oauthRequiredScopes
  };
}

/**
 * Verifies a bearer JWT against the issuer's JWKS. `iss` is checked against the
 * configured issuer (RFC 9207) and the audience against our resource URL, so a
 * token minted for a different resource cannot be replayed here.
 */
export function createJwtVerifier(settings: OAuthSettings): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL('.well-known/jwks.json', ensureTrailingSlash(settings.issuerUrl)));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // requireBearerAuth's own challenge-response mapping (bearerAuthChallengeResponse)
      // answers 401 with a proper WWW-Authenticate challenge only for an
      // OAuthError; anything else — every error jose itself throws (bad
      // signature, expired, wrong issuer/audience, malformed JWT) included —
      // becomes a bare 500. A client implementing the OAuth challenge flow
      // correctly (as this project's own StreamableHTTPClientTransport does)
      // never even sees a chance to reauthorize: it just sees a server error.
      let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer: settings.issuerUrl,
          audience: settings.resourceUrl
        }));
      } catch (error) {
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
      if (typeof payload.sub !== 'string' || payload.sub === '') {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          'Token carries no subject (sub) claim, so it cannot be mapped to an owner.'
        );
      }

      const scopes = typeof payload['scope'] === 'string' ? payload['scope'].split(' ') : [];

      return {
        token,
        clientId: payload.sub,
        scopes,
        // Bearer verification rejects a token with no expiry, so this must be set.
        expiresAt: payload.exp ?? 0
      };
    }
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
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
