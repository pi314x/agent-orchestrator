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
import { corsHeaders, parseCorsPolicy, preflightHeaders, requestOrigin } from './cors.js';
import { handleApiRequest } from './dashboard/api.js';
import { collectDashboardData, DASHBOARD_HTTP_PRINCIPAL } from './dashboard/data.js';
import { renderDashboard } from './dashboard/html.js';
import type { Logger } from './logger.js';
import type { Services } from './services.js';
import { SERVER_NAME, VERSION } from './version.js';

export const MCP_PATH = '/mcp';
export const DASHBOARD_PATH = '/dashboard';
export const DASHBOARD_JSON_PATH = '/dashboard.json';

export interface HttpServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartHttpServerOptions {
  factory: McpServerFactory;
  config: Pick<Config, 'httpHost' | 'httpPort'> &
    Partial<
      Pick<
        Config,
        | 'oauthIssuerUrl'
        | 'oauthResourceUrl'
        | 'oauthRequiredScopes'
        | 'oauthJwksUrl'
        | 'httpAllowedHosts'
        | 'corsAllowedOrigins'
      >
    >;
  logger: Logger;
  /**
   * Enables the read-only live dashboard (`GET /dashboard` + `/dashboard.json`).
   * Absent in tests that only need the MCP surface; always set in index.ts.
   */
  dashboard?: { services: Services; version: string; startedAt: number };
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
  logger,
  dashboard
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
  const verifier = oauth === undefined ? undefined : createJwtVerifier(oauth);
  const gate =
    oauth === undefined || verifier === undefined
      ? undefined
      : requireBearerAuth({
          verifier,
          requiredScopes: oauth.requiredScopes,
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(oauth.resourceUrl))
        });

  // DNS-rebinding and cross-site protection. `httpHost` alone only ever
  // covers loopback and the bind address itself — the hostname a real remote
  // client sends (a reverse proxy's public domain) is a different string, so
  // ORCH_HTTP_ALLOWED_HOSTS is what actually makes a publicly exposed
  // deployment reachable. Without it every remote request is rejected here,
  // before OAuth or anything else runs.
  const cors = parseCorsPolicy(config.corsAllowedOrigins);
  const allowedHostnames = Array.from(
    new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      config.httpHost,
      ...(config.httpAllowedHosts ?? []),
      // A named CORS origin must pass the Origin guard too, or the CORS
      // headers below would allow what the guard then rejects. Allow-all
      // bypasses the guard by definition (see src/cors.ts).
      ...cors.originHosts
    ])
  );
  const validateHost = hostHeaderValidation(allowedHostnames);
  // Allow-all CORS bypasses this guard by definition (see src/cors.ts): any
  // website may call us, so per-origin CSRF protection cannot hold. A named
  // list keeps the guard, extended with the CORS hosts above.
  const validateOrigin: (req: IncomingMessage, res: ServerResponse) => boolean = cors.allowAll
    ? () => true
    : originValidation(allowedHostnames);

  const server: Server = createServer((req, res) => {
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;

    // Set before any route writes: writeHead merges these with whatever the
    // route (or the MCP handler it delegates to) sets itself.
    const origin = requestOrigin(req.headers);
    for (const [header, value] of Object.entries(corsHeaders(cors, origin))) {
      res.setHeader(header, value);
    }

    // CORS preflight never reaches a route: answer what the browser may send
    // and which origins may read it, then stop.
    if (req.method === 'OPTIONS') {
      const requested = Array.isArray(req.headers['access-control-request-headers'])
        ? req.headers['access-control-request-headers'][0]
        : req.headers['access-control-request-headers'];
      res.writeHead(204, preflightHeaders(cors, origin, requested));
      res.end();
      return;
    }

    const path = (req.url ?? '/').split('?')[0];

    if (path === '/health') {
      sendJson(res, 200, { status: 'ok', name: SERVER_NAME, version: VERSION });
      return;
    }

    // The dashboard's interactive API. Routed before the OAuth gate below,
    // which consumes the body stream the API needs to read itself — and the
    // API enforces the same principal scoping per endpoint, so nothing here
    // bypasses what the gate protects on the MCP surface.
    if (dashboard !== undefined && (path ?? '').startsWith('/api/')) {
      void handleApiRequest(req, res, {
        services: dashboard.services,
        version: dashboard.version,
        startedAt: dashboard.startedAt,
        ...(verifier !== undefined && { verifier })
      });
      return;
    }

    // Read-only live dashboard from the approved mockup (PLAN §8): the same
    // collector the `orch://dashboard` resource serves, rendered as HTML
    // behind the same Host/Origin guards as everything else on this port.
    // Unauthenticated like /health, so it reads as a non-admin single owner —
    // in a single-owner deployment that is everything, and once OAuth is on
    // it is only admin-shared rows, never another owner's private state.
    // Actions are hints naming the MCP tool to run, never writes: there is no
    // second, scope-free mutation path around the tools.
    if ((path === DASHBOARD_PATH || path === DASHBOARD_JSON_PATH) && req.method === 'GET') {
      if (dashboard === undefined) {
        sendJson(res, 404, { error: 'not_found', hint: 'The dashboard is not enabled on this server.' });
        return;
      }
      // Plain callback, not async — same fire-and-settle shape as the A2A
      // card route, so a slow store read cannot wedge the listener.
      void collectDashboardData(dashboard.services, DASHBOARD_HTTP_PRINCIPAL, {
        version: dashboard.version,
        startedAt: dashboard.startedAt,
        era: 'http',
        authRequired: oauth !== undefined
      })
        .then(data => {
          if (path === DASHBOARD_JSON_PATH) {
            sendJson(res, 200, data);
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderDashboard(data));
        })
        .catch(error => {
          logger.error({ err: error }, 'dashboard failed');
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
        });
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
