import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { corsHeaders, parseCorsPolicy, preflightHeaders, requestOrigin } from '../cors.js';
import type { Logger } from '../logger.js';
import { SERVER_NAME, VERSION } from '../version.js';
import { createA2AServer, type A2AServerDeps, type A2AServerHandle } from './server.js';

/** Where A2A clients look for a card by convention; the SDK's own default. */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const A2A_RPC_PATH = '/a2a';

/** Bodies are JSON-RPC envelopes, not payloads; a megabyte is already generous. */
const MAX_BODY_BYTES = 1_000_000;

export interface A2AHttpHandle {
  readonly url: string;
  readonly cardUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartA2AServerOptions {
  deps: Omit<A2AServerDeps, 'publicUrl'> & { publicUrl?: string };
  host: string;
  port: number;
  logger: Logger;
  /** Browser origins allowed cross-origin; unset means allow-all. See src/cors.ts. */
  corsAllowedOrigins?: readonly string[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A browser's fetch() always sends a Host matching the URL it targets,
 * regardless of the page's own origin, so Host validation alone does not stop
 * a page at any origin from posting JSON-RPC directly to a loopback server —
 * only Origin validation does. Absent entirely for a non-browser caller (every
 * real A2A peer), so only a present-and-disallowed value is rejected.
 */
function validateOrigin(req: IncomingMessage, res: ServerResponse, allowedHosts: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;

  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    sendJson(res, 403, { error: 'forbidden', hint: `Origin "${origin}" could not be parsed.` });
    return false;
  }

  if (!allowedHosts.has(hostname)) {
    sendJson(res, 403, { error: 'forbidden', hint: `Origin "${origin}" is not allowed.` });
    return false;
  }
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * The inbound half of A2A: serves our Agent Card so other agents can discover
 * us, and the JSON-RPC endpoint they then call. Deliberately separate from the
 * MCP surface on its own port — the two speak different protocols to different
 * audiences, and an operator should be able to expose one without the other.
 *
 * Bound to the same loopback default as MCP, and Host-validated for the same
 * reason: a browser on the operator's machine must not be able to reach it by
 * rebinding DNS to a name that resolves here.
 */
export async function startA2AServer({
  deps,
  host,
  port,
  logger,
  corsAllowedOrigins
}: StartA2AServerOptions): Promise<A2AHttpHandle> {
  // Resolved after listen() when the port is 0, so the card advertises the port
  // it actually got rather than the one that was asked for.
  let publicUrl = deps.publicUrl ?? '';

  let handle: A2AServerHandle | undefined;
  const a2a = (): A2AServerHandle => {
    handle ??= createA2AServer({ ...deps, publicUrl });
    return handle;
  };

  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', host]);
  const cors = parseCorsPolicy(corsAllowedOrigins);
  // Named CORS origins join the origin check, same as the MCP surface — and
  // allow-all skips it, since per-origin protection cannot hold then anyway.
  for (const originHost of cors.originHosts) allowedHosts.add(originHost);

  const server: Server = createServer((req, res) => {
    // Host and Origin validation, matching the MCP surface (src/http.ts,
    // which pulls in the MCP SDK's own host/origin guards — this file can't,
    // since src/a2a is barred from importing the MCP SDK). An explicitly
    // configured public URL means the operator is fronting this with a
    // proxy, so the check would only reject their own hostname.
    if (deps.publicUrl === undefined) {
      const hostname = (req.headers.host ?? '').split(':')[0] ?? '';
      if (!allowedHosts.has(hostname)) {
        sendJson(res, 403, { error: 'forbidden', hint: `Host "${hostname}" is not allowed.` });
        return;
      }
      if (!cors.allowAll && !validateOrigin(req, res, allowedHosts)) return;
    }

    const origin = requestOrigin(req.headers);
    for (const [header, value] of Object.entries(corsHeaders(cors, origin))) {
      res.setHeader(header, value);
    }

    if (req.method === 'OPTIONS') {
      const requested = Array.isArray(req.headers['access-control-request-headers'])
        ? req.headers['access-control-request-headers'][0]
        : req.headers['access-control-request-headers'];
      res.writeHead(204, preflightHeaders(cors, origin, requested));
      res.end();
      return;
    }

    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok', name: SERVER_NAME, version: VERSION, surface: 'a2a' });
      return;
    }

    if (req.method === 'GET' && path === AGENT_CARD_PATH) {
      // Rebuilt per request: a skill withdrawn a moment ago must stop being
      // advertised a moment later, not at the next restart.
      void a2a()
        .card()
        .then(card => sendJson(res, 200, card))
        .catch(error => {
          logger.error({ err: error }, 'failed to build the Agent Card');
          sendJson(res, 500, { error: 'internal' });
        });
      return;
    }

    if (path !== A2A_RPC_PATH) {
      sendJson(res, 404, {
        error: 'not_found',
        hint: `The Agent Card is at ${AGENT_CARD_PATH}; JSON-RPC is at ${A2A_RPC_PATH}.`
      });
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    void (async () => {
      const raw = await readBody(req);

      let body: unknown;
      try {
        body = JSON.parse(raw === '' ? 'null' : raw);
      } catch {
        // JSON-RPC parse error, per spec, rather than a bare HTTP 400.
        sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }

      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
      ) as Record<string, string>;

      const result = await a2a().handleJsonRpc(body, headers);

      // We advertise streaming: false, so a single response is the contract.
      // A generator can only arrive if that ever changes; drain it to the last
      // response rather than hanging the caller.
      if (typeof result === 'object' && result !== null && Symbol.asyncIterator in result) {
        let last: unknown;
        for await (const item of result as AsyncGenerator<unknown>) last = item;
        sendJson(res, 200, last ?? null);
        return;
      }

      sendJson(res, 200, result);
    })().catch(error => {
      logger.error({ err: error }, 'a2a request failed');
      if (!res.headersSent) {
        sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  publicUrl = deps.publicUrl ?? `http://${host}:${actualPort}${A2A_RPC_PATH}`;

  return {
    url: publicUrl,
    cardUrl: `http://${host}:${actualPort}${AGENT_CARD_PATH}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error === undefined ? resolve() : reject(error)));
      })
  };
}
