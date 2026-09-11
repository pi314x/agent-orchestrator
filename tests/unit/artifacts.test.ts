import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/core/artifacts.js';
import { migratedDb } from '../helpers.js';

function store() {
  const db = migratedDb();
  return { db, artifacts: new ArtifactStore(db) };
}

describe('ArtifactStore', () => {
  it('stores content and reports its size and hash', () => {
    const { artifacts, db } = store();
    const record = artifacts.put({ name: 'report.md', content: 'hello' });

    expect(record.artifactId).toMatch(/^art_/);
    expect(record.sizeBytes).toBe(5);
    expect(record.contentHash).toHaveLength(64);
    db.close();
  });

  it('gives identical content the same hash', () => {
    const { artifacts, db } = store();
    const a = artifacts.put({ name: 'one', content: 'same bytes' });
    const b = artifacts.put({ name: 'two', content: 'same bytes' });

    expect(a.contentHash).toBe(b.contentHash);
    expect(a.artifactId).not.toBe(b.artifactId);
    db.close();
  });

  it('reads content back whole', () => {
    const { artifacts, db } = store();
    const record = artifacts.put({ name: 'f', content: 'abcdef' });

    const result = artifacts.read(record.artifactId);

    expect(result.content).toBe('abcdef');
    expect(result.eof).toBe(true);
    db.close();
  });

  it('slices large content and reports eof correctly', () => {
    const { artifacts, db } = store();
    const record = artifacts.put({ name: 'f', content: 'abcdef' });

    const first = artifacts.read(record.artifactId, 0, 3);
    expect(first.content).toBe('abc');
    expect(first.eof).toBe(false);

    const rest = artifacts.read(record.artifactId, 3, 3);
    expect(rest.content).toBe('def');
    expect(rest.eof).toBe(true);
    db.close();
  });

  it('reports a missing artifact rather than returning empty content', () => {
    const { artifacts, db } = store();
    expect(() => artifacts.read('art_missing')).toThrow(/No artifact/);
    db.close();
  });

  it('filters by job and by tags', () => {
    const { artifacts, db } = store();
    artifacts.put({ name: 'a', content: '1', jobId: 'job_1', tags: ['draft'] });
    artifacts.put({ name: 'b', content: '2', jobId: 'job_2', tags: ['final'] });

    expect(artifacts.list({ jobId: 'job_1' }).map(a => a.name)).toEqual(['a']);
    expect(artifacts.list({ tags: ['final'] }).map(a => a.name)).toEqual(['b']);
    db.close();
  });

  it('deletes an artifact', () => {
    const { artifacts, db } = store();
    const record = artifacts.put({ name: 'gone', content: 'x' });

    expect(artifacts.delete(record.artifactId)).toBe(true);
    expect(artifacts.delete(record.artifactId)).toBe(false);
    db.close();
  });
});
