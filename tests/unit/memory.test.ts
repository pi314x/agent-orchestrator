import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/core/memory.js';
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
