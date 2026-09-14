import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
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

  constructor(
    private readonly db: Db,
    private readonly logger: Logger
  ) {}

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

    const client = new Client({ name: 'agent-orchestrator-proxy', version: '1.0.0' });

    try {
      if (server.transport.type === 'stdio') {
        await client.connect(
          new StdioClientTransport({
            command: server.transport.command,
            args: server.transport.args ?? [],
            ...(server.transport.cwd !== undefined && { cwd: server.transport.cwd }),
            // Downstream stdout is protocol; its stderr must not pollute ours.
            stderr: 'pipe'
          })
        );
      } else {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.transport.url)));
      }
    } catch (error) {
      throw new OrchestratorError(
        'RUNNER_FAILED',
        `Could not connect to tool server "${server.name}": ${error instanceof Error ? error.message : String(error)}`,
        'Check the command or URL with toolserver_list.'
      );
    }

    this.clients.set(server.name, client);
    return client;
  }

  private async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client === undefined) return;
    this.clients.delete(name);
    await client.close().catch((error: unknown) => {
      this.logger.warn({ err: error, name }, 'failed to close downstream MCP client');
    });
  }

  /** The tools this server offers, after allow/deny filtering. */
  async tools(name: string): Promise<DownstreamTool[]> {
    const server = await this.getOrThrow(name);
    const client = await this.connect(server);
    const { tools } = await client.listTools();

    return tools
      .filter(tool => isToolAllowed(server, tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>
      }));
  }

  async call(name: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const server = await this.getOrThrow(name);

    if (!isToolAllowed(server, toolName)) {
      throw new OrchestratorError(
        'POLICY_DENIED',
        `Tool "${toolName}" is not granted on server "${name}".`,
        'Adjust allowTools or denyTools with toolserver_register.'
      );
    }

    const client = await this.connect(server);
    const result = await client.callTool({ name: toolName, arguments: args });

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
    await Promise.all([...this.clients.keys()].map(name => this.disconnect(name)));
  }
}
