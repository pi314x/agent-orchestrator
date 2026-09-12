import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface Jwks {
  issuerUrl: string;
  sign: (claims: Record<string, unknown>, options?: { expiresIn?: string }) => Promise<string>;
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
        .setIssuer(issuerUrl)
        .setAudience(JWKS_AUDIENCE)
        .setExpirationTime(options.expiresIn ?? '1h');
      if (typeof claims['sub'] === 'string') jwt = jwt.setSubject(claims['sub']);
      return jwt.sign(privateKey);
    },
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  };
}
