import { verifyAgentCardSignature, type AgentCard } from '@a2a-js/sdk';
import type { JWK } from 'jose';
import { OrchestratorError } from '../errors.js';

export const TRUST_MODES = ['verified-only', 'allow-unverified'] as const;
export type TrustMode = (typeof TRUST_MODES)[number];

export const TRUST_LEVELS = ['verified', 'unverified'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/**
 * A card is `verified` only when a signature is present and checks out.
 * An unsigned card is `unverified` — never silently upgraded.
 */
export type PublicKeyResolver = (kid: string, jku?: string) => Promise<JWK>;

/**
 * Default resolver: fetch the JWKS the signature header points at and pick the
 * matching key. The `jku` is attacker-supplied, so it goes through the same URL
 * checks as a webhook callback before anything is fetched.
 */
export function createJwksResolver(fetchImpl: typeof fetch = fetch): PublicKeyResolver {
  return async (kid, jku) => {
    if (jku === undefined || jku === '') {
      throw new Error('The card signature carries no jku, so its key cannot be located.');
    }

    const url = validateFetchUrl(jku);
    const response = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`JWKS fetch returned ${response.status}.`);

    const jwks = (await response.json()) as { keys?: JWK[] };
    const key = (jwks.keys ?? []).find(candidate => candidate.kid === kid);
    if (key === undefined) throw new Error(`JWKS at ${jku} has no key with kid ${kid}.`);

    return key;
  };
}

export async function verifyCard(
  card: AgentCard,
  resolver: PublicKeyResolver = createJwksResolver()
): Promise<{ trustLevel: TrustLevel; reason?: string }> {
  if (card.signatures === undefined || card.signatures.length === 0) {
    return { trustLevel: 'unverified', reason: 'The card carries no signature.' };
  }

  try {
    const verify = verifyAgentCardSignature(resolver);
    await verify(card);
    return { trustLevel: 'verified' };
  } catch (error) {
    return {
      trustLevel: 'unverified',
      reason: error instanceof Error ? error.message : 'Signature verification failed.'
    };
  }
}

/**
 * The gate every remote delegation passes through. `verified-only` is the
 * default so an unsigned card cannot be used by accident.
 */
export function assertTrusted(trustLevel: TrustLevel, mode: TrustMode, agentLabel: string): void {
  if (mode === 'allow-unverified') return;
  if (trustLevel === 'verified') return;

  throw new OrchestratorError(
    'REMOTE_UNVERIFIED',
    `The Agent Card for ${agentLabel} is unverified and A2A_TRUST_MODE is verified-only.`,
    'Set A2A_TRUST_MODE=allow-unverified for testing, or use an agent whose card is signed.'
  );
}

const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0', '[::]', '::']);

/**
 * Push-notification callbacks are handed to a third party, so the URL is
 * checked before it leaves: HTTPS only, no private or loopback targets, and an
 * explicit allow-list when one is configured. This is the SSRF and
 * spoofed-callback boundary.
 */
export function validateFetchUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OrchestratorError('INVALID_INPUT', `"${rawUrl}" is not a valid URL.`);
  }

  if (url.protocol !== 'https:') {
    throw new OrchestratorError(
      'POLICY_DENIED',
      `Refusing a non-HTTPS URL (${url.protocol}).`,
      'Only HTTPS endpoints are accepted here.'
    );
  }

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname) || isPrivateAddress(hostname)) {
    throw new OrchestratorError(
      'POLICY_DENIED',
      `Refusing a URL pointing at a private or loopback address (${hostname}).`,
      'Use a publicly reachable HTTPS endpoint.'
    );
  }

  return url;
}

export function validateWebhookUrl(rawUrl: string, allowedHosts: readonly string[] = []): URL {
  const url = validateFetchUrl(rawUrl);
  const hostname = url.hostname.toLowerCase();

  if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
    throw new OrchestratorError(
      'POLICY_DENIED',
      `Callback host ${hostname} is not in the configured allow-list.`,
      `Allowed: ${allowedHosts.join(', ')}.`
    );
  }

  return url;
}

function isPrivateIPv4(hostname: string): boolean {
  // The WHATWG URL parser canonicalises every IPv4 notation — decimal
  // (2130706433), octal (0177.0.0.1), hex (0x7f.0.0.1), short (127.1) — into
  // dotted-quad before we see it, so matching that one form is enough.
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part))) return false;

  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Expand a bracketed IPv6 literal into its eight hextets. */
function ipv6Hextets(hostname: string): number[] | undefined {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return undefined;

  const halves = hostname.slice(1, -1).toLowerCase().split('::');
  if (halves.length > 2) return undefined;

  const toParts = (part: string): number[] =>
    part === '' ? [] : part.split(':').map(hextet => Number.parseInt(hextet, 16));

  const left = toParts(halves[0] ?? '');
  const right = halves.length === 2 ? toParts(halves[1] ?? '') : [];
  const gap = 8 - left.length - right.length;
  if (gap < 0 || (halves.length === 1 && gap !== 0)) return undefined;

  const hextets = [...left, ...(Array(gap).fill(0) as number[]), ...right];
  return hextets.every(h => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? hextets : undefined;
}

/** Render two hextets as the dotted-quad they encode. */
function dottedQuad(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateIPv6(hostname: string): boolean {
  const hextets = ipv6Hextets(hostname);
  if (hextets === undefined) return false;

  const first = hextets[0] ?? 0;
  const second = hextets[1] ?? 0;

  // ::/128 unspecified and ::1/128 loopback.
  if (hextets.every((h, i) => (i === 7 ? h <= 1 : h === 0))) return true;
  // fc00::/7 unique-local.
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  // fe80::/10 link-local.
  if (first >= 0xfe80 && first <= 0xfebf) return true;

  // ::ffff:0:0/96 — an IPv4 address wearing an IPv6 costume. The URL parser
  // renders these as hex (::ffff:7f00:1), so the dotted-quad check never saw
  // them and every loopback and private range was reachable through one.
  if (hextets.slice(0, 5).every(h => h === 0) && hextets[5] === 0xffff) {
    return isPrivateIPv4(dottedQuad(hextets[6] ?? 0, hextets[7] ?? 0));
  }

  // 64:ff9b::/96 — the NAT64 well-known prefix (RFC 6052), the same
  // IPv4-in-IPv6 embedding as ::ffff:0:0/96 above under a different prefix.
  // On any network running NAT64 (common on IPv6-only/dual-stack cellular
  // and cloud networks), a request to this address is actually routed to
  // the embedded IPv4 address — including 127.0.0.1 and the 169.254.169.254
  // cloud metadata endpoint, both reachable this way with nothing above
  // catching it.
  if (first === 0x0064 && second === 0xff9b && hextets.slice(2, 6).every(h => h === 0)) {
    return isPrivateIPv4(dottedQuad(hextets[6] ?? 0, hextets[7] ?? 0));
  }

  return false;
}

function isPrivateAddress(hostname: string): boolean {
  return isPrivateIPv4(hostname) || isPrivateIPv6(hostname);
}

/** Tolerates the spacing and casing an attacker would try. */
const CLOSING_TAG = /<\/\s*untrusted_remote_output\s*>/gi;

/**
 * Remote text can contain anything, including something shaped like an
 * instruction. Wrapping it marks the boundary for whoever reads it next.
 */
export function wrapUntrusted(source: string, text: string): string {
  // Text carrying the closing tag would end the wrapper early, and everything
  // after it would read as trusted — so defang it. Without this the boundary
  // is advisory, which is no boundary at all.
  const body = text.replace(CLOSING_TAG, '&lt;/untrusted_remote_output&gt;');

  // `source` is attacker-controlled too: for a registered remote agent it is
  // that agent's own self-reported Agent Card name, no less untrusted than
  // its output. Stripping quotes alone stops it breaking out of the
  // attribute, but a literal closing tag inside it — no quote needed — reads
  // to whoever consumes this next as if the boundary already ended before
  // the real body even started, defeating the escaping above entirely.
  const safeSource = source
    .replace(CLOSING_TAG, '&lt;/untrusted_remote_output&gt;')
    .replace(/"/g, '');

  return `<untrusted_remote_output source="${safeSource}">\n${body}\n</untrusted_remote_output>`;
}
