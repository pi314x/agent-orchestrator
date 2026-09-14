import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
  toWebRequest
} from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type McpServerFactory
} from '@modelcontextprotocol/server';
import { createJwtVerifier, oauthSettings } from './auth.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { SERVER_NAME, VERSION } from './version.js';

export const MCP_PATH = '/mcp';

export interface HttpServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartHttpServerOptions {
  factory: McpServerFactory;
  config: Pick<Config, 'httpHost' | 'httpPort'> &
    Partial<Pick<Config, 'oauthIssuerUrl' | 'oauthResourceUrl' | 'oauthRequiredScopes' | 'httpAllowedHosts'>>;
  logger: Logger;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Serve MCP over Streamable HTTP. `createMcpHandler` builds a fresh server per
 * request, so the endpoint is stateless and any instance can serve any request.
 */
export async function startHttpServer({
  factory,
  config,
  logger
}: StartHttpServerOptions): Promise<HttpServerHandle> {
  const handler = createMcpHandler(factory, {
    onerror: error => logger.error({ err: error }, 'mcp handler error')
  });

  const nodeHandler = toNodeHandler(handler, {
    onerror: error => logger.error({ err: error }, 'mcp node adapter error')
  });

  // OAuth is opt-in: without an issuer the endpoint stays unauthenticated,
  // which is the right default for a loopback-bound local server.
  const oauth = oauthSettings(config as Config);
  const gate =
    oauth === undefined
      ? undefined
      : requireBearerAuth({
          verifier: createJwtVerifier(oauth),
          requiredScopes: oauth.requiredScopes,
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(oauth.resourceUrl))
        });

  // DNS-rebinding and cross-site protection. `httpHost` alone only ever
  // covers loopback and the bind address itself — the hostname a real remote
  // client sends (a reverse proxy's public domain) is a different string, so
  // ORCH_HTTP_ALLOWED_HOSTS is what actually makes a publicly exposed
  // deployment reachable. Without it every remote request is rejected here,
  // before OAuth or anything else runs.
  const allowedHostnames = Array.from(
    new Set(['localhost', '127.0.0.1', '[::1]', config.httpHost, ...(config.httpAllowedHosts ?? [])])
  );
  const validateHost = hostHeaderValidation(allowedHostnames);
  const validateOrigin = originValidation(allowedHostnames);

  const server: Server = createServer((req, res) => {
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;

    const path = (req.url ?? '/').split('?')[0];

    if (path === '/health') {
      sendJson(res, 200, { status: 'ok', name: SERVER_NAME, version: VERSION });
      return;
    }

    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: 'not_found', hint: `MCP is served at ${MCP_PATH}` });
      return;
    }

    if (gate === undefined) {
      void nodeHandler(req, res);
      return;
    }

    void (async () => {
      const request = await toWebRequest(req);
      const auth = await gate(request);

      if (auth instanceof Response) {
        // The SDK already shaped the 401/403 challenge; relay it verbatim.
        res.writeHead(auth.status, Object.fromEntries(auth.headers));
        res.end(await auth.text());
        return;
      }

      (req as IncomingMessage & { auth?: typeof auth }).auth = auth;

      // Reading the body here (rather than letting nodeHandler do it, the way
      // the no-OAuth path below does) is what lets the gate see the request
      // at all — toWebRequest already consumed the stream. But a malformed
      // body is a client protocol error, not an authentication one: without
      // this try/catch it fell into the outer catch below, which logged it
      // as "authentication failed" and answered a bare 500, instead of the
      // JSON-RPC parse error every other malformed-body path on this server
      // returns.
      let body: unknown;
      if (request.body !== null) {
        try {
          body = await request.json();
        } catch {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error: Invalid JSON' },
            id: null
          });
          return;
        }
      }

      await nodeHandler(req, res, body);
    })().catch(error => {
      logger.error({ err: error }, 'authentication failed');
      sendJson(res, 500, { error: 'internal' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.httpPort, config.httpHost, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.httpPort;
  const url = `http://${config.httpHost}:${port}${MCP_PATH}`;

  return {
    url,
    port,
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  };
}
