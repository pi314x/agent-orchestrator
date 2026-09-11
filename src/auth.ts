import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from './config.js';

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
      const { payload } = await jwtVerify(token, jwks, {
        issuer: settings.issuerUrl,
        audience: settings.resourceUrl
      });

      const scopes = typeof payload['scope'] === 'string' ? payload['scope'].split(' ') : [];

      return {
        token,
        clientId: typeof payload.sub === 'string' ? payload.sub : 'unknown',
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

/** True when the caller holds the scope, or when OAuth is not configured. */
export function hasScope(authInfo: AuthInfo | undefined, scope: string): boolean {
  if (authInfo === undefined) return true;
  return authInfo.scopes.includes(scope);
}
