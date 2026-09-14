import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardStore } from '../../src/a2a/card.js';
import type { Db } from '../../src/db/sqlite.js';
import { migratedDb } from '../helpers.js';

let db: Db;

beforeEach(async () => {
  db = await migratedDb();
});

afterEach(async () => {
  await db.close();
});

// Regression: fetchAndCache's cardUrl is caller-supplied (agent_register's
// cardUrl, a2a_card_get's url) and reached a real fetch() with no validation
// at all — unlike a webhook callback or a card signature's jku, which both
// already go through validateFetchUrl. Neither agent_register nor
// a2a_card_get requires admin scope, so any authenticated caller could point
// this at an internal service or the cloud metadata endpoint and learn
// whether it answers (and sometimes read the response) from the
// orchestrator's own network position.
describe('CardStore.fetchAndCache SSRF guard', () => {
  it('refuses a non-HTTPS card URL without ever calling fetch', async () => {
    const fetchImpl = vi.fn();
    const cards = new CardStore(db, { fetchImpl });

    await expect(cards.fetchAndCache('http://example.com/agent-card.json')).rejects.toThrow(/non-HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['loopback', 'https://127.0.0.1/agent-card.json'],
    ['private', 'https://192.168.1.1/agent-card.json'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['NAT64-embedded cloud metadata', 'https://[64:ff9b::a9fe:a9fe]/latest/meta-data/']
  ])('refuses a card URL pointing at a %s address without ever calling fetch', async (_name, url) => {
    const fetchImpl = vi.fn();
    const cards = new CardStore(db, { fetchImpl });

    await expect(cards.fetchAndCache(url)).rejects.toThrow(/private or loopback/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still fetches a legitimate public HTTPS card URL', async () => {
    const card = { name: 'remote-agent', description: 'x', skills: [] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(card), { status: 200 }));
    const cards = new CardStore(db, { fetchImpl });

    const cached = await cards.fetchAndCache('https://agents.example.com/');

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cached.card.name).toBe('remote-agent');
  });
});
