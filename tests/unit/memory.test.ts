import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/core/memory.js';
import { migratedDb } from '../helpers.js';

function store() {
  const db = migratedDb();
  return { db, memory: new MemoryStore(db) };
}

describe('MemoryStore', () => {
  it('round-trips a JSON value', () => {
    const { memory, db } = store();
    memory.write({ namespace: 'run', key: 'findings', value: { count: 3, items: ['a'] } });

    expect(memory.read('run', 'findings')?.value).toEqual({ count: 3, items: ['a'] });
    db.close();
  });

  it('overwrites on repeated write to the same key', () => {
    const { memory, db } = store();
    memory.write({ namespace: 'run', key: 'k', value: 1 });
    memory.write({ namespace: 'run', key: 'k', value: 2 });

    expect(memory.read('run', 'k')?.value).toBe(2);
    db.close();
  });

  it('returns undefined for a missing key', () => {
    const { memory, db } = store();
    expect(memory.read('run', 'nope')).toBeUndefined();
    db.close();
  });

  it('hides an entry once its ttl has passed', () => {
    vi.useFakeTimers();
    const { memory, db } = store();
    memory.write({ namespace: 'run', key: 'temp', value: 'here', ttlSec: 60 });

    expect(memory.read('run', 'temp')?.value).toBe('here');

    vi.advanceTimersByTime(61_000);
    expect(memory.read('run', 'temp')).toBeUndefined();

    vi.useRealTimers();
    db.close();
  });

  it('finds entries by full-text search', () => {
    const { memory, db } = store();
    memory.write({ namespace: 'run', key: 'a', value: 'the deployment failed on staging' });
    memory.write({ namespace: 'run', key: 'b', value: 'unrelated note about cats' });

    const hits = memory.search({ query: 'deployment' });

    expect(hits.map(h => h.key)).toEqual(['a']);
    db.close();
  });

  it('keeps the search index in step with updates and deletes', () => {
    const { memory, db } = store();
    memory.write({ namespace: 'run', key: 'a', value: 'original wording' });
    memory.write({ namespace: 'run', key: 'a', value: 'replacement wording' });

    expect(memory.search({ query: 'original' })).toHaveLength(0);
    expect(memory.search({ query: 'replacement' })).toHaveLength(1);

    memory.delete('run', { key: 'a' });
    expect(memory.search({ query: 'replacement' })).toHaveLength(0);
    db.close();
  });

  it('narrows search by namespace and tags', () => {
    const { memory, db } = store();
    memory.write({ namespace: 'x', key: 'a', value: 'shared topic', tags: ['keep'] });
    memory.write({ namespace: 'y', key: 'b', value: 'shared topic', tags: ['drop'] });

    expect(memory.search({ query: 'shared', namespace: 'x' }).map(h => h.key)).toEqual(['a']);
    expect(memory.search({ query: 'shared', tags: ['keep'] }).map(h => h.key)).toEqual(['a']);
    db.close();
  });

  it('does not let punctuation break the FTS query', () => {
    const { memory, db } = store();
    memory.write({ namespace: 'run', key: 'a', value: 'error in module' });

    expect(() => memory.search({ query: 'error AND ("' })).not.toThrow();
    db.close();
  });

  it('deletes by prefix', () => {
    const { memory, db } = store();
    memory.write({ namespace: 'run', key: 'file:a', value: 1 });
    memory.write({ namespace: 'run', key: 'file:b', value: 2 });
    memory.write({ namespace: 'run', key: 'other', value: 3 });

    expect(memory.delete('run', { prefix: 'file:' })).toBe(2);
    expect(memory.read('run', 'other')?.value).toBe(3);
    db.close();
  });
});
