import { createServer, type Server, type ServerResponse } from 'node:http';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
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
  config: Pick<Config, 'httpHost' | 'httpPort'>;
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

  // DNS-rebinding and cross-site protection for a locally bound server.
  const allowedHostnames = Array.from(new Set(['localhost', '127.0.0.1', '[::1]', config.httpHost]));
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

    void nodeHandler(req, res);
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
