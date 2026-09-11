import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';

export type MessageRecord = {
  messageId: string;
  toAgentId?: string;
  toChannel?: string;
  toJobId?: string;
  fromAgentId?: string;
  body: string;
  replyTo?: string;
  readAt?: string;
  createdAt: string;
};

export type ChannelRecord = {
  channelId: string;
  name: string;
  members: string[];
  createdAt: string;
};

export interface SendMessageInput {
  toAgentId?: string;
  toChannel?: string;
  toJobId?: string;
  fromAgentId?: string;
  body: string;
  replyTo?: string;
}

export interface ListMessagesInput {
  agentId?: string;
  channel?: string;
  jobId?: string;
  since?: string;
  unreadOnly?: boolean;
  limit?: number;
}

type MessageRow = {
  id: string;
  to_agent_id: string | null;
  to_channel: string | null;
  to_job_id: string | null;
  from_agent_id: string | null;
  body: string;
  reply_to: string | null;
  read_at: string | null;
  created_at: string;
};

type ChannelRow = { id: string; name: string; members: string; created_at: string };

function toMessage(row: MessageRow): MessageRecord {
  return {
    messageId: row.id,
    body: row.body,
    createdAt: row.created_at,
    ...(row.to_agent_id !== null && { toAgentId: row.to_agent_id }),
    ...(row.to_channel !== null && { toChannel: row.to_channel }),
    ...(row.to_job_id !== null && { toJobId: row.to_job_id }),
    ...(row.from_agent_id !== null && { fromAgentId: row.from_agent_id }),
    ...(row.reply_to !== null && { replyTo: row.reply_to }),
    ...(row.read_at !== null && { readAt: row.read_at })
  };
}

export class MessageBus {
  constructor(private readonly db: Db) {}

  send(input: SendMessageInput): MessageRecord {
    if (input.toAgentId === undefined && input.toChannel === undefined && input.toJobId === undefined) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        'A message needs a recipient.',
        'Set one of toAgentId, toChannel or toJobId.'
      );
    }

    const id = newId('message');

    this.db
      .prepare(
        `INSERT INTO messages (id, to_agent_id, to_channel, to_job_id, from_agent_id, body, reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.toAgentId ?? null,
        input.toChannel ?? null,
        input.toJobId ?? null,
        input.fromAgentId ?? null,
        input.body,
        input.replyTo ?? null,
        new Date().toISOString()
      );

    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow;
    return toMessage(row);
  }

  list(input: ListMessagesInput): MessageRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (input.agentId !== undefined) {
      where.push('to_agent_id = ?');
      params.push(input.agentId);
    }
    if (input.channel !== undefined) {
      where.push('to_channel = ?');
      params.push(input.channel);
    }
    if (input.jobId !== undefined) {
      where.push('to_job_id = ?');
      params.push(input.jobId);
    }
    if (input.since !== undefined) {
      where.push('created_at >= ?');
      params.push(input.since);
    }
    if (input.unreadOnly === true) where.push('read_at IS NULL');

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

    const rows = this.db
      .prepare(`SELECT * FROM messages ${clause} ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(...params, limit) as MessageRow[];

    return rows.map(toMessage);
  }

  markRead(messageIds: readonly string[]): number {
    if (messageIds.length === 0) return 0;
    const placeholders = messageIds.map(() => '?').join(', ');
    return this.db
      .prepare(`UPDATE messages SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`)
      .run(new Date().toISOString(), ...messageIds).changes;
  }

  createChannel(name: string, members: readonly string[] = []): ChannelRecord {
    const existing = this.db.prepare('SELECT * FROM channels WHERE name = ?').get(name) as
      ChannelRow | undefined;
    if (existing !== undefined) {
      return {
        channelId: existing.id,
        name: existing.name,
        members: JSON.parse(existing.members) as string[],
        createdAt: existing.created_at
      };
    }

    const id = newId('message');
    const createdAt = new Date().toISOString();

    this.db
      .prepare('INSERT INTO channels (id, name, members, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, JSON.stringify([...members]), createdAt);

    return { channelId: id, name, members: [...members], createdAt };
  }

  listChannels(): ChannelRecord[] {
    const rows = this.db.prepare('SELECT * FROM channels ORDER BY name ASC').all() as ChannelRow[];
    return rows.map(row => ({
      channelId: row.id,
      name: row.name,
      members: JSON.parse(row.members) as string[],
      createdAt: row.created_at
    }));
  }
}
