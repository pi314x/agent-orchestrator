import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { generateSigningKeypair, pqcSign } from '../../src/core/pqc.js';

export interface Jwks {
  issuerUrl: string;
  sign: (
    claims: Record<string, unknown>,
    options?: { expiresIn?: string; issuer?: string }
  ) => Promise<string>;
  close: () => Promise<void>;
}

/**
 * The audience every token here is signed for. A real absolute URL, not just
 * an opaque string: `startHttpServer` parses its configured `oauthResourceUrl`
 * with `new URL(...)` before `createJwtVerifier` ever compares it against a
 * token's `aud`, so this has to parse too. Fixed rather than tied to any
 * server's bound port, so callers can sign tokens before a `port: 0` server
 * has told them which port it actually got.
 */
export const JWKS_AUDIENCE = 'https://orchestrator.example.test/mcp';

/**
 * A real JWKS endpoint over HTTP, not a mock of `jose` — createJwtVerifier
 * fetches the key set itself via createRemoteJWKSet, so a fixture that skips
 * the network would never exercise the actual verification path at all.
 */
export async function startJwks(): Promise<Jwks> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  const server: Server = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    // Standard OIDC discovery, matched by suffix so Entra-shaped issuers
    // (…/tenant-id/v2.0/) resolve the same way a root issuer does.
    if (req.url !== undefined && req.url.endsWith('/.well-known/openid-configuration')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: issuerUrl,
          jwks_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/jwks.json`
        })
      );
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
    sign: async (claims, options = {}) => {
      let jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(options.issuer ?? issuerUrl)
        .setAudience(JWKS_AUDIENCE)
        .setExpirationTime(options.expiresIn ?? '1h');
      if (typeof claims['sub'] === 'string') jwt = jwt.setSubject(claims['sub']);
      return jwt.sign(privateKey);
    },
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  };
}

export interface PqcJwks {
  issuerUrl: string;
  jwksUrl: string;
  /** Compact JWT signed with ML-DSA-65, same claims shape as the RS256 fixture. */
  sign: (claims: Record<string, unknown>, options?: { expiresInSec?: number; issuer?: string }) => string;
  close: () => Promise<void>;
}

/**
 * Same "real wire, not a mock" standard for the PQC path: the verifier
 * fetches this document itself and checks an ML-DSA-65 signature with noble,
 * never touching jose — jose knows no such alg.
 */
export async function startPqcJwks(): Promise<PqcJwks> {
  const keys = generateSigningKeypair();
  const jwk = {
    kty: 'AKP',
    alg: 'ML-DSA-65',
    kid: 'pqc-key',
    use: 'sig',
    x: Buffer.from(keys.publicKey).toString('base64url')
  };

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

  const b64u = (value: string | Uint8Array): string =>
    Buffer.from(typeof value === 'string' ? value : value).toString('base64url');

  return {
    issuerUrl,
    jwksUrl: `http://127.0.0.1:${port}/.well-known/jwks.json`,
    sign: (claims, options = {}) => {
      const nowSec = Math.floor(Date.now() / 1000);
      const header = b64u(JSON.stringify({ alg: 'ML-DSA-65', kid: 'pqc-key', typ: 'JWT' }));
      const payload = b64u(
        JSON.stringify({
          ...claims,
          iss: options.issuer ?? issuerUrl,
          aud: JWKS_AUDIENCE,
          exp: nowSec + (options.expiresInSec ?? 3600)
        })
      );
      const signature = b64u(pqcSign(keys.secretKey, new TextEncoder().encode(`${header}.${payload}`)));
      return `${header}.${payload}.${signature}`;
    },
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  };
}
