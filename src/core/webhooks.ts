import { validateWebhookUrl } from '../a2a/trust.js';
import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logger.js';

/** Settle events a callback may subscribe to. Cancelled runs report as workflow.failed (existing quirk, payload.state says cancelled). */
export const WEBHOOK_EVENTS = [
  'job.succeeded',
  'job.failed',
  'job.cancelled',
  'job.timed_out',
  'workflow.succeeded',
  'workflow.failed'
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type WebhookRecord = {
  webhookId: string;
  ownerId: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
};

type WebhookRow = {
  id: string;
  owner_id: string;
  url: string;
  events: string;
  created_at: string;
};

function toRecord(row: WebhookRow): WebhookRecord {
  return {
    webhookId: row.id,
    ownerId: row.owner_id,
    url: row.url,
    events: JSON.parse(row.events) as WebhookEvent[],
    createdAt: row.created_at
  };
}

function assertValidEvents(events: readonly string[]): asserts events is readonly WebhookEvent[] {
  for (const event of events) {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(event)) {
      throw new OrchestratorError(
        'INVALID_INPUT',
        `Cannot subscribe to "${event}".`,
        `Subscribable events: ${WEBHOOK_EVENTS.join(', ')}.`
      );
    }
  }
}

/**
 * Completion callbacks. Registration is admin-gated at the tool layer (a
 * callback exfiltrates job data to a third party, like a tool server
 * connection), but delivery is owner-scoped: a webhook only ever hears
 * about its own owner's jobs and runs.
 */
export class WebhookStore {
  constructor(private readonly db: Db) {}

  async register(ownerId: string, url: string, events: readonly string[], allowedHosts: readonly string[] = []): Promise<WebhookRecord> {
    // Checked here, not just at send time: a bad URL must fail the
    // registration call, not surface weeks later as a silent delivery skip.
    validateWebhookUrl(url, allowedHosts);
    assertValidEvents(events);
    if (events.length === 0) {
      throw new OrchestratorError('INVALID_INPUT', 'Subscribe to at least one event.');
    }

    const id = newId('webhook');
    await this.db
      .prepare('INSERT INTO webhooks (id, owner_id, url, events, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ownerId, url, JSON.stringify([...new Set(events)]), new Date().toISOString());
    return this.getOrThrow(id);
  }

  async getOrThrow(webhookId: string): Promise<WebhookRecord> {
    const row = (await this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId)) as
      | WebhookRow
      | undefined;
    if (row === undefined) {
      throw new OrchestratorError('NOT_FOUND', `No webhook with id ${webhookId}.`, 'Call webhook_list.');
    }
    return toRecord(row);
  }

  async list(): Promise<WebhookRecord[]> {
    const rows = (await this.db.prepare('SELECT * FROM webhooks ORDER BY created_at ASC').all()) as WebhookRow[];
    return rows.map(toRecord);
  }

  async remove(webhookId: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId);
    return result.changes > 0;
  }

  /** An owner's hooks subscribed to this settle event. Small per-owner sets, so filter in JS. */
  async matching(ownerId: string, type: WebhookEvent): Promise<WebhookRecord[]> {
    const rows = (await this.db
      .prepare('SELECT * FROM webhooks WHERE owner_id = ? ORDER BY created_at ASC')
      .all(ownerId)) as WebhookRow[];
    return rows.map(toRecord).filter(hook => hook.events.includes(type));
  }
}

export interface NotifyDeps {
  webhooks: WebhookStore;
  fetchImpl?: typeof fetch;
  allowedHosts?: readonly string[];
  logger: Logger;
}

const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Post one settle event to every matching hook. At-most-once each: failures
 * are logged with the webhook id, never retried (a retrying notifier turns
 * one completion into a slow fan-out) and never allowed to fail the
 * settlement itself. Deliveries run concurrently: sequential sends would let
 * N hanging callbacks stall drain() for N timeouts.
 */
export async function notifyOwner(
  deps: NotifyDeps,
  ownerId: string,
  type: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  const deliver = async (hook: WebhookRecord): Promise<void> => {
    try {
      // Re-validated at send time: the allow-list may have tightened since
      // registration, and a stored string is not trustworthy on its own.
      const url = validateWebhookUrl(hook.url, deps.allowedHosts ?? []);
      const response = await (deps.fetchImpl ?? fetch)(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, ...payload }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new Error(`callback returned ${response.status}`);
      }
    } catch (error) {
      deps.logger.warn({ err: error, webhookId: hook.webhookId }, 'webhook delivery failed');
    }
  };

  await Promise.all((await deps.webhooks.matching(ownerId, type)).map(hook => deliver(hook)));
}
