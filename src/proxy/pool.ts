import { Client, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import type { Logger } from '../logger.js';

export type ToolServerTransport =
  { type: 'stdio'; command: string; args?: string[]; cwd?: string } | { type: 'http'; url: string };

export type ToolServerRecord = {
  name: string;
  transport: ToolServerTransport;
  authRef?: string;
  allowTools: string[];
  denyTools: string[];
  requireApprovalFor: string[];
  createdAt: string;
  updatedAt: string;
};

export type DownstreamTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolServerHealth = {
  name: string;
  reachable: boolean;
  toolCount?: number;
  reason?: string;
};

type ServerRow = {
  name: string;
  transport: string;
  auth_ref: string | null;
  allow_tools: string;
  deny_tools: string;
  require_approval_for: string;
  created_at: string;
  updated_at: string;
};

function toRecord(row: ServerRow): ToolServerRecord {
  return {
    name: row.name,
    transport: JSON.parse(row.transport) as ToolServerTransport,
    allowTools: JSON.parse(row.allow_tools) as string[],
    denyTools: JSON.parse(row.deny_tools) as string[],
    requireApprovalFor: JSON.parse(row.require_approval_for) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.auth_ref !== null && { authRef: row.auth_ref })
  };
}

/**
 * A tool is usable only when the allow-list admits it and the deny-list does
 * not. An empty allow-list means "everything this server offers".
 */
export function isToolAllowed(server: ToolServerRecord, toolName: string): boolean {
  if (server.denyTools.includes(toolName)) return false;
  if (server.allowTools.length === 0) return true;
  return server.allowTools.includes(toolName);
}

export interface RegisterToolServerInput {
  name: string;
  transport: ToolServerTransport;
  authRef?: string;
  allowTools?: readonly string[];
  denyTools?: readonly string[];
  requireApprovalFor?: readonly string[];
}

/**
 * Pool of downstream MCP servers whose tools are granted to **local** agents
 * only. Remote A2A agents are opaque and bring their own tools, so nothing here
 * ever reaches them.
 */
export class McpProxyPool {
  private readonly clients = new Map<string, Client>();
  private readonly callTimeoutMs: number;
  /**
   * Connects still starting. Without this, two calls racing on a cold server
   * each miss the map above and each spawn their own child — the loser is
   * overwritten, never closed, and its stdio process is orphaned. The ticket
   * is dropped before the client lands, so a remove/re-register/disconnect
   * that wins the race is honored by the settler instead of resurrected.
   */
  private readonly pending = new Map<string, Promise<Client>>();

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    options: { callTimeoutMs?: number } = {}
  ) {
    // Every SDK call below carries this as its `timeout` (overriding the
    // SDK's own 60s default) — a hung downstream server fails loudly instead
    // of wedging the worker. Without any bound, a job with no timeoutSec of
    // its own awaited the call indefinitely while holding its concurrency
    // slot, and only an explicit job_cancel freed it. Generous on purpose —
    // downstream tools do real work, unlike a 30s web fetch — but finite.
    this.callTimeoutMs = options.callTimeoutMs ?? 300_000;
  }

  async register(input: RegisterToolServerInput): Promise<ToolServerRecord> {
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO tool_servers (name, transport, auth_ref, allow_tools, deny_tools, require_approval_for, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           transport = excluded.transport,
           auth_ref = excluded.auth_ref,
           allow_tools = excluded.allow_tools,
           deny_tools = excluded.deny_tools,
           require_approval_for = excluded.require_approval_for,
           updated_at = excluded.updated_at`
      )
      .run(
        input.name,
        JSON.stringify(input.transport),
        input.authRef ?? null,
        JSON.stringify([...(input.allowTools ?? [])]),
        JSON.stringify([...(input.denyTools ?? [])]),
        JSON.stringify([...(input.requireApprovalFor ?? [])]),
        now,
        now
      );

    // A changed transport must not keep talking to the old process.
    void this.disconnect(input.name);
    return this.getOrThrow(input.name);
  }

  async get(name: string): Promise<ToolServerRecord | undefined> {
    const row = (await this.db.prepare('SELECT * FROM tool_servers WHERE name = ?').get(name)) as
      ServerRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  async getOrThrow(name: string): Promise<ToolServerRecord> {
    const found = await this.get(name);
    if (found === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No tool server named "${name}".`,
        'Register it with toolserver_register, or call toolserver_list.'
      );
    }
    return found;
  }

  async list(): Promise<ToolServerRecord[]> {
    const rows = (await this.db.prepare('SELECT * FROM tool_servers ORDER BY name').all()) as ServerRow[];
    return rows.map(toRecord);
  }

  async remove(name: string): Promise<boolean> {
    await this.disconnect(name);
    const result = await this.db.prepare('DELETE FROM tool_servers WHERE name = ?').run(name);
    return result.changes > 0;
  }

  /** Connect lazily and keep the client, so a stdio server is spawned once. */
  private async connect(server: ToolServerRecord): Promise<Client> {
    const existing = this.clients.get(server.name);
    if (existing !== undefined) return existing;

    const inflight = this.pending.get(server.name);
    if (inflight !== undefined) return inflight;

    const started: Promise<Client> = this.doConnect(server).then(
      async client => {
        // A disconnect that landed mid-connect owns the outcome: close what
        // just started instead of putting it back in the map behind its back.
        if (this.pending.get(server.name) !== started) {
          await client.close().catch(() => undefined);
          return client;
        }
        this.pending.delete(server.name);
        this.clients.set(server.name, client);
        return client;
      },
      error => {
        if (this.pending.get(server.name) === started) this.pending.delete(server.name);
        throw error;
      }
    );
    this.pending.set(server.name, started);
    return started;
  }

  private async doConnect(server: ToolServerRecord): Promise<Client> {
    const client = new Client({ name: 'agent-orchestrator-proxy', version: '1.0.0' });

    try {
      // Ceiling-only: the job's own signal must never reach a cached,
      // shared client — one job's cancel would otherwise kill the transport
      // every other job on this server is using. A cancel that lands mid
      // handshake waits out the ceiling at most.
      const handshake = AbortSignal.timeout(this.callTimeoutMs);
      if (server.transport.type === 'stdio') {
        await client.connect(
          new StdioClientTransport({
            command: server.transport.command,
            args: server.transport.args ?? [],
            ...(server.transport.cwd !== undefined && { cwd: server.transport.cwd }),
            // Downstream stdout is protocol; its stderr must not pollute ours.
            stderr: 'pipe'
          }),
          { requestSignal: handshake, timeout: this.callTimeoutMs }
        );
      } else {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.transport.url)), {
          requestSignal: handshake,
          timeout: this.callTimeoutMs
        });
      }
    } catch (error) {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `Could not connect to tool server "${server.name}": ${error instanceof Error ? error.message : String(error)}`,
        'Check the command or URL with toolserver_list.'
      );
    }

    return client;
  }

  private async disconnect(name: string): Promise<void> {
    // Drop the ticket first: a connect still starting must not land in the
    // map after this — its settler sees the missing ticket and closes its
    // own client instead of keeping it.
    this.pending.delete(name);
    const client = this.clients.get(name);
    if (client === undefined) return;
    this.clients.delete(name);
    await client.close().catch((error: unknown) => {
      this.logger.warn({ err: error, name }, 'failed to close downstream MCP client');
    });
  }

  /**
   * The job's own signal combined with the per-call ceiling, so a hung
   * server trips the timeout while a cancelled job still reads as cancelled.
   * Never constructed without the ceiling: an uncombined job signal alone
   * reintroduces the unbounded wait for every job that sets no timeoutSec.
   */
  private bound(signal: AbortSignal | undefined): AbortSignal {
    const ceiling = AbortSignal.timeout(this.callTimeoutMs);
    return signal === undefined ? ceiling : AbortSignal.any([signal, ceiling]);
  }

  /** An SDK timeout, as opposed to anything else that can fail a call. */
  private isTimeout(error: unknown): boolean {
    return SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout;
  }

  /** The tools this server offers, after allow/deny filtering. */
  async tools(name: string, signal?: AbortSignal): Promise<DownstreamTool[]> {
    const server = await this.getOrThrow(name);
    const client = await this.connect(server);
    const { tools } = await client.listTools(undefined, {
      requestSignal: this.bound(signal),
      timeout: this.callTimeoutMs
    });

    return tools
      .filter(tool => isToolAllowed(server, tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>
      }));
  }

  async call(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    const server = await this.getOrThrow(name);

    if (!isToolAllowed(server, toolName)) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Tool "${toolName}" is not granted on server "${name}".`,
        'Adjust allowTools or denyTools with toolserver_register.'
      );
    }

    const client = await this.connect(server);
    const bounded = this.bound(signal);
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await client.callTool(
        { name: toolName, arguments: args },
        { requestSignal: bounded, timeout: this.callTimeoutMs }
      );
    } catch (error) {
      // Our own ceiling, not the job's cancel: the job signal is still quiet
      // while the SDK reports a timeout. Reported as transient so the run
      // retries with backoff like any other blip — and a genuinely cancelled
      // job keeps its own abort untouched, which finishFailed maps to
      // cancelled rather than failed.
      if (this.isTimeout(error) && !(signal?.aborted ?? false)) {
        throw new OrchestratorError(
          'TRANSIENT',
          `Downstream tool "${toolName}" on "${name}" produced nothing within ${Math.round(this.callTimeoutMs / 1000)}s.`,
          'Retried automatically with backoff.'
        );
      }
      throw error;
    }

    const text = (result.content as { type: string; text?: string }[] | undefined)
      ?.filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n');

    if (result.isError === true) {
      throw new OrchestratorError('RUNNER_FAILED', text || `Tool "${toolName}" failed.`);
    }

    return text ?? '';
  }

  async health(name: string): Promise<ToolServerHealth> {
    try {
      const tools = await this.tools(name);
      return { name, reachable: true, toolCount: tools.length };
    } catch (error) {
      return {
        name,
        reachable: false,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async close(): Promise<void> {
    // Pending-only names have no client yet, so keys() alone would miss
    // them — and their settlers must still find no ticket waiting.
    const names = new Set([...this.clients.keys(), ...this.pending.keys()]);
    await Promise.all([...names].map(name => this.disconnect(name)));
  }
}
