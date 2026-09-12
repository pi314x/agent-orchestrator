import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/core/memory.js';
import { migratedDb } from '../helpers.js';

const OWNER = '';

function store() {
  const db = migratedDb();
  return { db, memory: new MemoryStore(db) };
}

describe('MemoryStore', () => {
  it('round-trips a JSON value', () => {
    const { memory, db } = store();
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'findings', value: { count: 3, items: ['a'] } });

    expect(memory.read(OWNER, 'run', 'findings')?.value).toEqual({ count: 3, items: ['a'] });
    db.close();
  });

  it('overwrites on repeated write to the same key', () => {
    const { memory, db } = store();
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'k', value: 1 });
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'k', value: 2 });

    expect(memory.read(OWNER, 'run', 'k')?.value).toBe(2);
    db.close();
  });

  it('returns undefined for a missing key', () => {
    const { memory, db } = store();
    expect(memory.read(OWNER, 'run', 'nope')).toBeUndefined();
    db.close();
  });

  it('hides an entry once its ttl has passed', () => {
    vi.useFakeTimers();
    const { memory, db } = store();
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'temp', value: 'here', ttlSec: 60 });

    expect(memory.read(OWNER, 'run', 'temp')?.value).toBe('here');

    vi.advanceTimersByTime(61_000);
    expect(memory.read(OWNER, 'run', 'temp')).toBeUndefined();

    vi.useRealTimers();
    db.close();
  });

  it('finds entries by full-text search', () => {
    const { memory, db } = store();
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'a', value: 'the deployment failed on staging' });
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'b', value: 'unrelated note about cats' });

    const hits = memory.search({ ownerId: OWNER, query: 'deployment' });

    expect(hits.map(h => h.key)).toEqual(['a']);
    db.close();
  });

  it('keeps the search index in step with updates and deletes', () => {
    const { memory, db } = store();
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'a', value: 'original wording' });
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'a', value: 'replacement wording' });

    expect(memory.search({ ownerId: OWNER, query: 'original' })).toHaveLength(0);
    expect(memory.search({ ownerId: OWNER, query: 'replacement' })).toHaveLength(1);

    memory.delete(OWNER, 'run', { key: 'a' });
    expect(memory.search({ ownerId: OWNER, query: 'replacement' })).toHaveLength(0);
    db.close();
  });

  it('narrows search by namespace and tags', () => {
    const { memory, db } = store();
    memory.write({ ownerId: OWNER, namespace: 'x', key: 'a', value: 'shared topic', tags: ['keep'] });
    memory.write({ ownerId: OWNER, namespace: 'y', key: 'b', value: 'shared topic', tags: ['drop'] });

    expect(memory.search({ ownerId: OWNER, query: 'shared', namespace: 'x' }).map(h => h.key)).toEqual(['a']);
    expect(memory.search({ ownerId: OWNER, query: 'shared', tags: ['keep'] }).map(h => h.key)).toEqual(['a']);
    db.close();
  });

  it('does not let punctuation break the FTS query', () => {
    const { memory, db } = store();
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'a', value: 'error in module' });

    expect(() => memory.search({ ownerId: OWNER, query: 'error AND ("' })).not.toThrow();
    db.close();
  });

  it('deletes by prefix', () => {
    const { memory, db } = store();
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'file:a', value: 1 });
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'file:b', value: 2 });
    memory.write({ ownerId: OWNER, namespace: 'run', key: 'other', value: 3 });

    expect(memory.delete(OWNER, 'run', { prefix: 'file:' })).toBe(2);
    expect(memory.read(OWNER, 'run', 'other')?.value).toBe(3);
    db.close();
  });
});

describe('MemoryStore ownership', () => {
  const alice = 'user_alice';
  const bob = 'user_bob';

  // The point of the widened unique constraint: two owners choosing the exact
  // same namespace/key must not collide, silently or otherwise.
  it('lets two owners use the same namespace and key independently', () => {
    const { memory, db } = store();
    memory.write({ ownerId: alice, namespace: 'notes', key: 'todo', value: "alice's list" });
    memory.write({ ownerId: bob, namespace: 'notes', key: 'todo', value: "bob's list" });

    expect(memory.read(alice, 'notes', 'todo')?.value).toBe("alice's list");
    expect(memory.read(bob, 'notes', 'todo')?.value).toBe("bob's list");
    db.close();
  });

  it("one owner's write does not overwrite another's entry at the same key", () => {
    const { memory, db } = store();
    memory.write({ ownerId: alice, namespace: 'shared-name', key: 'k', value: 'first' });
    memory.write({ ownerId: bob, namespace: 'shared-name', key: 'k', value: 'second' });
    memory.write({ ownerId: alice, namespace: 'shared-name', key: 'k', value: 'first-updated' });

    expect(memory.read(alice, 'shared-name', 'k')?.value).toBe('first-updated');
    expect(memory.read(bob, 'shared-name', 'k')?.value).toBe('second');
    db.close();
  });

  it("cannot read another owner's entry by exact key", () => {
    const { memory, db } = store();
    memory.write({ ownerId: alice, namespace: 'n', key: 'secret', value: 'classified' });

    expect(memory.read(bob, 'n', 'secret')).toBeUndefined();
    db.close();
  });

  it("full-text search does not surface another owner's entries", () => {
    const { memory, db } = store();
    memory.write({ ownerId: alice, namespace: 'n', key: 'a', value: 'the deployment failed on staging' });
    memory.write({ ownerId: bob, namespace: 'n', key: 'b', value: 'the deployment failed differently' });

    const aliceHits = memory.search({ ownerId: alice, query: 'deployment' });
    const bobHits = memory.search({ ownerId: bob, query: 'deployment' });

    expect(aliceHits.map(h => h.key)).toEqual(['a']);
    expect(bobHits.map(h => h.key)).toEqual(['b']);
    db.close();
  });

  it('search with no ownerId spans every owner, for the admin path', () => {
    const { memory, db } = store();
    memory.write({ ownerId: alice, namespace: 'n', key: 'a', value: 'deployment note one' });
    memory.write({ ownerId: bob, namespace: 'n', key: 'b', value: 'deployment note two' });

    const all = memory.search({ query: 'deployment' });

    expect(all.map(h => h.key).sort()).toEqual(['a', 'b']);
    db.close();
  });

  it("deleting by prefix or namespace only removes the caller's own entries", () => {
    const { memory, db } = store();
    memory.write({ ownerId: alice, namespace: 'n', key: 'file:a', value: 1 });
    memory.write({ ownerId: bob, namespace: 'n', key: 'file:a', value: 2 });

    expect(memory.delete(alice, 'n', { prefix: 'file:' })).toBe(1);
    expect(memory.read(alice, 'n', 'file:a')).toBeUndefined();
    expect(memory.read(bob, 'n', 'file:a')?.value).toBe(2);
    db.close();
  });
});
