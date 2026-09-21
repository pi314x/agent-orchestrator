import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/core/memory.js';
import { generateDataKey } from '../../src/core/pqc.js';
import { migratedDb } from '../helpers.js';

const OWNER = '';

async function store() {
  const db = await migratedDb();
  return { db, memory: new MemoryStore(db) };
}

describe('MemoryStore', () => {
  it('round-trips a JSON value', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'findings', value: { count: 3, items: ['a'] } });

    expect((await memory.read(OWNER, 'run', 'findings'))?.value).toEqual({ count: 3, items: ['a'] });
    await db.close();
  });

  it('overwrites on repeated write to the same key', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'k', value: 1 });
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'k', value: 2 });

    expect((await memory.read(OWNER, 'run', 'k'))?.value).toBe(2);
    await db.close();
  });

  it('returns undefined for a missing key', async () => {
    const { memory, db } = await store();
    expect(await memory.read(OWNER, 'run', 'nope')).toBeUndefined();
    await db.close();
  });

  it('hides an entry once its ttl has passed', async () => {
    vi.useFakeTimers();
    const { memory, db } = await store();
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'temp', value: 'here', ttlSec: 60 });

    expect((await memory.read(OWNER, 'run', 'temp'))?.value).toBe('here');

    vi.advanceTimersByTime(61_000);
    expect(await memory.read(OWNER, 'run', 'temp')).toBeUndefined();

    vi.useRealTimers();
    await db.close();
  });

  it('finds entries by full-text search', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'a', value: 'the deployment failed on staging' });
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'b', value: 'unrelated note about cats' });

    const hits = await memory.search({ ownerId: OWNER, query: 'deployment' });

    expect(hits.map(h => h.key)).toEqual(['a']);
    await db.close();
  });

  it('keeps the search index in step with updates and deletes', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'a', value: 'original wording' });
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'a', value: 'replacement wording' });

    expect(await memory.search({ ownerId: OWNER, query: 'original' })).toHaveLength(0);
    expect(await memory.search({ ownerId: OWNER, query: 'replacement' })).toHaveLength(1);

    await memory.delete(OWNER, 'run', { key: 'a' });
    expect(await memory.search({ ownerId: OWNER, query: 'replacement' })).toHaveLength(0);
    await db.close();
  });

  it('narrows search by namespace and tags', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: OWNER, namespace: 'x', key: 'a', value: 'shared topic', tags: ['keep'] });
    await memory.write({ ownerId: OWNER, namespace: 'y', key: 'b', value: 'shared topic', tags: ['drop'] });

    expect((await memory.search({ ownerId: OWNER, query: 'shared', namespace: 'x' })).map(h => h.key)).toEqual(['a']);
    expect((await memory.search({ ownerId: OWNER, query: 'shared', tags: ['keep'] })).map(h => h.key)).toEqual(['a']);
    await db.close();
  });

  it('does not let punctuation break the FTS query', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'a', value: 'error in module' });

    await expect(memory.search({ ownerId: OWNER, query: 'error AND ("' })).resolves.toBeDefined();
    await db.close();
  });

  it('deletes by prefix', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'file:a', value: 1 });
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'file:b', value: 2 });
    await memory.write({ ownerId: OWNER, namespace: 'run', key: 'other', value: 3 });

    expect(await memory.delete(OWNER, 'run', { prefix: 'file:' })).toBe(2);
    expect((await memory.read(OWNER, 'run', 'other'))?.value).toBe(3);
    await db.close();
  });
});

describe('MemoryStore ownership', () => {
  const alice = 'user_alice';
  const bob = 'user_bob';

  // The point of the widened unique constraint: two owners choosing the exact
  // same namespace/key must not collide, silently or otherwise.
  it('lets two owners use the same namespace and key independently', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: alice, namespace: 'notes', key: 'todo', value: "alice's list" });
    await memory.write({ ownerId: bob, namespace: 'notes', key: 'todo', value: "bob's list" });

    expect((await memory.read(alice, 'notes', 'todo'))?.value).toBe("alice's list");
    expect((await memory.read(bob, 'notes', 'todo'))?.value).toBe("bob's list");
    await db.close();
  });

  it("one owner's write does not overwrite another's entry at the same key", async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: alice, namespace: 'shared-name', key: 'k', value: 'first' });
    await memory.write({ ownerId: bob, namespace: 'shared-name', key: 'k', value: 'second' });
    await memory.write({ ownerId: alice, namespace: 'shared-name', key: 'k', value: 'first-updated' });

    expect((await memory.read(alice, 'shared-name', 'k'))?.value).toBe('first-updated');
    expect((await memory.read(bob, 'shared-name', 'k'))?.value).toBe('second');
    await db.close();
  });

  it("cannot read another owner's entry by exact key", async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: alice, namespace: 'n', key: 'secret', value: 'classified' });

    expect(await memory.read(bob, 'n', 'secret')).toBeUndefined();
    await db.close();
  });

  it("full-text search does not surface another owner's entries", async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: alice, namespace: 'n', key: 'a', value: 'the deployment failed on staging' });
    await memory.write({ ownerId: bob, namespace: 'n', key: 'b', value: 'the deployment failed differently' });

    const aliceHits = await memory.search({ ownerId: alice, query: 'deployment' });
    const bobHits = await memory.search({ ownerId: bob, query: 'deployment' });

    expect(aliceHits.map(h => h.key)).toEqual(['a']);
    expect(bobHits.map(h => h.key)).toEqual(['b']);
    await db.close();
  });

  it('search with no ownerId spans every owner, for the admin path', async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: alice, namespace: 'n', key: 'a', value: 'deployment note one' });
    await memory.write({ ownerId: bob, namespace: 'n', key: 'b', value: 'deployment note two' });

    const all = await memory.search({ query: 'deployment' });

    expect(all.map(h => h.key).sort()).toEqual(['a', 'b']);
    await db.close();
  });

  it("deleting by prefix or namespace only removes the caller's own entries", async () => {
    const { memory, db } = await store();
    await memory.write({ ownerId: alice, namespace: 'n', key: 'file:a', value: 1 });
    await memory.write({ ownerId: bob, namespace: 'n', key: 'file:a', value: 2 });

    expect(await memory.delete(alice, 'n', { prefix: 'file:' })).toBe(1);
    expect(await memory.read(alice, 'n', 'file:a')).toBeUndefined();
    expect((await memory.read(bob, 'n', 'file:a'))?.value).toBe(2);
    await db.close();
  });
});

describe('MemoryStore with a PQC data key', () => {
  it('seals values at rest but reads back the original JSON', async () => {
    const db = await migratedDb();
    const memory = new MemoryStore(db, undefined, { dataKey: generateDataKey() });
    await memory.write({ ownerId: 'user_alice', namespace: 'run', key: 'plan', value: { steps: 3 } });

    // The row holds a single-key envelope, never the plaintext value.
    const row = (await db.prepare('SELECT value FROM memory WHERE key = ?').get('plan')) as { value: string };
    expect(row.value).toContain('__pqc_envelope_v1');
    expect(row.value).not.toContain('steps');

    expect((await memory.read('user_alice', 'run', 'plan'))?.value).toEqual({ steps: 3 });
    expect(await memory.listNamespaces('user_alice')).toEqual(['run']);
    await db.close();
  });

  it('reads plaintext rows written before encryption alongside sealed ones', async () => {
    const db = await migratedDb();
    const plain = new MemoryStore(db);
    await plain.write({ ownerId: 'user_alice', namespace: 'run', key: 'old', value: 'legacy' });

    const sealed = new MemoryStore(db, undefined, { dataKey: generateDataKey() });
    await sealed.write({ ownerId: 'user_alice', namespace: 'run', key: 'new', value: 'fresh' });

    // Mixed tables work with no migration: each row declares its own shape.
    expect((await sealed.read('user_alice', 'run', 'old'))?.value).toBe('legacy');
    expect((await sealed.read('user_alice', 'run', 'new'))?.value).toBe('fresh');
    await db.close();
  });

  it('fails closed reading a sealed row without the key', async () => {
    const db = await migratedDb();
    const sealed = new MemoryStore(db, undefined, { dataKey: generateDataKey() });
    await sealed.write({ ownerId: 'user_alice', namespace: 'run', key: 'k', value: 'v' });

    const keyless = new MemoryStore(db);
    await expect(keyless.read('user_alice', 'run', 'k')).rejects.toThrow(/DATA_KEY/);
    await db.close();
  });

  it('full-text search matches nothing sealed, without failing', async () => {
    const db = await migratedDb();
    const sealed = new MemoryStore(db, undefined, { dataKey: generateDataKey() });
    await sealed.write({
      ownerId: 'user_alice',
      namespace: 'run',
      key: 'k',
      value: 'the deployment failed on staging'
    });

    // The FTS index holds ciphertext, so content search is blind by design —
    // but it must stay blind silently, never throw, and exact reads keep working.
    expect(await sealed.search({ ownerId: 'user_alice', query: 'deployment' })).toEqual([]);
    expect((await sealed.read('user_alice', 'run', 'k'))?.value).toBe('the deployment failed on staging');
    await db.close();
  });
});
