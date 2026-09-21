/**
 * Cross-origin rules for the HTTP surfaces (MCP, dashboard/API, A2A).
 *
 * Browsers refuse to read a cross-origin response unless it carries CORS
 * headers, so any web UI — including a dashboard page served from another
 * origin — needs them. The default is allow-all (`*`): this server is a
 * local-first operator tool, and its first client is code running on the
 * same machine. An operator exposing it beyond localhost narrows this to
 * named origins with ORCH_CORS_ALLOWED_ORIGINS.
 *
 * CORS never replaces the Host/Origin guards: when restricted to a list,
 * those list entries also join the origin allow-list the DNS-rebinding
 * check enforces, so a named origin passes both layers together. With `*`
 * the origin guard is bypassed by definition — any website the operator's
 * browser visits can then call this server, so allow-all belongs on
 * loopback, behind OAuth, or not at all.
 */

/** A bare `*` anywhere in the list means allow-all, same as leaving it unset. */
export const CORS_ALLOW_ALL = '*';

export type CorsPolicy = {
  allowAll: boolean;
  /** Exact origins (`scheme://host[:port]`) accepted when not allow-all. */
  origins: string[];
  /** Their hostnames, for the DNS-rebinding guard to admit alongside loopback. */
  originHosts: string[];
};

export function parseCorsPolicy(raw: readonly string[] | undefined): CorsPolicy {
  const entries = (raw ?? []).map(entry => entry.trim()).filter(entry => entry !== '');
  if (entries.length === 0 || entries.includes(CORS_ALLOW_ALL)) {
    return { allowAll: true, origins: [], originHosts: [] };
  }

  const origins: string[] = [];
  const hosts = new Set<string>();
  for (const entry of entries) {
    // Bare hostnames are accepted as shorthand for https://host.
    const candidate = entry.includes('://') ? entry : `https://${entry}`;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    origins.push(url.origin);
    hosts.add(url.hostname.toLowerCase());
  }
  return { allowAll: false, origins, originHosts: [...hosts] };
}

/** Lowercased request Origin header, or undefined when absent/unparseable. */
export function requestOrigin(headers: { origin?: string | string[] }): string | undefined {
  const raw = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (raw === undefined || raw === '') return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/**
 * CORS response headers for one request. Allow-all answers `*` (no
 * credentials are ever involved — nothing here uses cookies); a list echoes
 * the request origin back if and only if it was named, plus `Vary: Origin`
 * so shared caches do not mix answers across origins.
 */
export function corsHeaders(policy: CorsPolicy, origin: string | undefined): Record<string, string> {
  if (policy.allowAll) return { 'Access-Control-Allow-Origin': '*' };
  if (origin !== undefined && policy.origins.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};
}

/**
 * Preflight (OPTIONS) answer headers. `allowHeaders` echoes what the browser
 * asked to send — the API only ever needs Content-Type and Authorization,
 * and reflecting the request keeps one code path for both.
 */
export function preflightHeaders(
  policy: CorsPolicy,
  origin: string | undefined,
  requestedHeaders?: string
): Record<string, string> {
  const base = corsHeaders(policy, origin);
  if (Object.keys(base).length === 0) return base;
  return {
    ...base,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': requestedHeaders !== undefined && requestedHeaders !== '' ? requestedHeaders : 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}
