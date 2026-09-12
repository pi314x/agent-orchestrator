import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import type { Db } from '../db/sqlite.js';
import { OrchestratorError } from '../errors.js';
import { newId } from '../ids.js';
import { validateFetchUrl, verifyCard, type TrustLevel } from './trust.js';

export type CachedCard = {
  cardId: string;
  url: string;
  card: AgentCard;
  trustLevel: TrustLevel;
  verifiedAt?: string;
  fetchedAt: string;
};

type CardRow = {
  id: string;
  url: string;
  card: string;
  trust_level: string;
  verified_at: string | null;
  fetched_at: string;
};

function toCached(row: CardRow): CachedCard {
  return {
    cardId: row.id,
    url: row.url,
    card: JSON.parse(row.card) as AgentCard,
    trustLevel: row.trust_level as TrustLevel,
    fetchedAt: row.fetched_at,
    ...(row.verified_at !== null && { verifiedAt: row.verified_at })
  };
}

/** Resolve a base URL to its well-known Agent Card location. */
export function cardUrlFor(baseUrl: string): string {
  if (baseUrl.endsWith('.json')) return baseUrl;
  return new URL(AGENT_CARD_PATH, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

export interface CardStoreOptions {
  fetchImpl?: typeof fetch;
}

export class CardStore {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly db: Db,
    options: CardStoreOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Fetch a card, verify its signature, and cache the result. */
  async fetchAndCache(url: string): Promise<CachedCard> {
    const cardUrl = cardUrlFor(url);
    // cardUrl is caller-supplied (agent_register's cardUrl, a2a_card_get's
    // url) and reaches a real fetch() below, exactly like a webhook callback
    // or a card signature's jku — both of which already go through this same
    // check. Without it, any authenticated caller could point this at an
    // internal service or the cloud metadata endpoint and learn whether it's
    // reachable (and sometimes its response) from the orchestrator's network
    // position, neither profile nor admin scope gating this tool at all.
    validateFetchUrl(cardUrl);

    let response: Response;
    try {
      response = await this.fetchImpl(cardUrl, { headers: { accept: 'application/json' } });
    } catch (error) {
      throw new OrchestratorError(
        'REMOTE_UNREACHABLE',
        `Could not reach ${cardUrl}: ${error instanceof Error ? error.message : String(error)}`,
        'Check the URL and that the agent is running.'
      );
    }

    if (!response.ok) {
      throw new OrchestratorError(
        'REMOTE_UNREACHABLE',
        `Agent Card fetch returned ${response.status} from ${cardUrl}.`
      );
    }

    const card = (await response.json()) as AgentCard;
    if (typeof card?.name !== 'string') {
      throw new OrchestratorError('INVALID_INPUT', `${cardUrl} did not return an Agent Card.`);
    }

    return this.cache(cardUrl, card);
  }

  cache(url: string, card: AgentCard): Promise<CachedCard>;
  async cache(url: string, card: AgentCard): Promise<CachedCard> {
    const { trustLevel } = await verifyCard(card);
    const now = new Date().toISOString();

    const existing = this.db.prepare('SELECT id FROM agent_cards WHERE url = ?').get(url) as
      { id: string } | undefined;
    const id = existing?.id ?? newId('card');

    this.db
      .prepare(
        `INSERT INTO agent_cards (id, url, card, trust_level, verified_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET
           card = excluded.card,
           trust_level = excluded.trust_level,
           verified_at = excluded.verified_at,
           fetched_at = excluded.fetched_at`
      )
      .run(id, url, JSON.stringify(card), trustLevel, trustLevel === 'verified' ? now : null, now);

    return this.getByUrlOrThrow(url);
  }

  get(cardId: string): CachedCard | undefined {
    const row = this.db.prepare('SELECT * FROM agent_cards WHERE id = ?').get(cardId) as CardRow | undefined;
    return row === undefined ? undefined : toCached(row);
  }

  getByUrl(url: string): CachedCard | undefined {
    const row = this.db.prepare('SELECT * FROM agent_cards WHERE url = ?').get(url) as CardRow | undefined;
    return row === undefined ? undefined : toCached(row);
  }

  getByUrlOrThrow(url: string): CachedCard {
    const found = this.getByUrl(url);
    if (found === undefined) {
      throw new OrchestratorError('NOT_FOUND', `No cached Agent Card for ${url}.`);
    }
    return found;
  }

  getOrThrow(cardId: string): CachedCard {
    const found = this.get(cardId);
    if (found === undefined) {
      throw new OrchestratorError(
        'NOT_FOUND',
        `No Agent Card with id ${cardId}.`,
        'Fetch it with a2a_card_get.'
      );
    }
    return found;
  }

  list(): CachedCard[] {
    const rows = this.db.prepare('SELECT * FROM agent_cards ORDER BY fetched_at DESC').all() as CardRow[];
    return rows.map(toCached);
  }

  /** Re-verify a cached card without re-fetching it. */
  async reverify(cardId: string): Promise<CachedCard> {
    const cached = this.getOrThrow(cardId);
    const { trustLevel } = await verifyCard(cached.card);
    const now = new Date().toISOString();

    this.db
      .prepare('UPDATE agent_cards SET trust_level = ?, verified_at = ? WHERE id = ?')
      .run(trustLevel, trustLevel === 'verified' ? now : null, cardId);

    return this.getOrThrow(cardId);
  }
}

/** Score a card's skills against a free-text query, for skill-based routing. */
export function cardMatchesSkill(card: AgentCard, query: string): boolean {
  const needle = query.toLowerCase();

  if (card.name?.toLowerCase().includes(needle)) return true;
  if (card.description?.toLowerCase().includes(needle)) return true;

  return (card.skills ?? []).some(
    skill =>
      skill.id?.toLowerCase().includes(needle) ||
      skill.name?.toLowerCase().includes(needle) ||
      skill.description?.toLowerCase().includes(needle) ||
      (skill.tags ?? []).some(tag => tag.toLowerCase().includes(needle))
  );
}

/** The endpoint to talk to, taken from the card's preferred interface. */
export function endpointFor(card: AgentCard): string | undefined {
  return card.supportedInterfaces?.[0]?.url;
}
