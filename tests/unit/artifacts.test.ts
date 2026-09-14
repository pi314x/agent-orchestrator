import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/core/artifacts.js';
import { migratedDb } from '../helpers.js';

async function store() {
  const db = await migratedDb();
  return { db, artifacts: new ArtifactStore(db) };
}

describe('ArtifactStore', () => {
  it('stores content and reports its size and hash', async () => {
    const { artifacts, db } = await store();
    const record = await artifacts.put({ name: 'report.md', content: 'hello' });

    expect(record.artifactId).toMatch(/^art_/);
    expect(record.sizeBytes).toBe(5);
    expect(record.contentHash).toHaveLength(64);
    await db.close();
  });

  it('gives identical content the same hash', async () => {
    const { artifacts, db } = await store();
    const a = await artifacts.put({ name: 'one', content: 'same bytes' });
    const b = await artifacts.put({ name: 'two', content: 'same bytes' });

    expect(a.contentHash).toBe(b.contentHash);
    expect(a.artifactId).not.toBe(b.artifactId);
    await db.close();
  });

  it('reads content back whole', async () => {
    const { artifacts, db } = await store();
    const record = await artifacts.put({ name: 'f', content: 'abcdef' });

    const result = await artifacts.read(record.artifactId);

    expect(result.content).toBe('abcdef');
    expect(result.eof).toBe(true);
    await db.close();
  });

  it('slices large content and reports eof correctly', async () => {
    const { artifacts, db } = await store();
    const record = await artifacts.put({ name: 'f', content: 'abcdef' });

    const first = await artifacts.read(record.artifactId, 0, 3);
    expect(first.content).toBe('abc');
    expect(first.eof).toBe(false);

    const rest = await artifacts.read(record.artifactId, 3, 3);
    expect(rest.content).toBe('def');
    expect(rest.eof).toBe(true);
    await db.close();
  });

  it('reports a missing artifact rather than returning empty content', async () => {
    const { artifacts, db } = await store();
    await expect(artifacts.read('art_missing')).rejects.toThrow(/No artifact/);
    await db.close();
  });

  it('filters by job and by tags', async () => {
    const { artifacts, db } = await store();
    await artifacts.put({ name: 'a', content: '1', jobId: 'job_1', tags: ['draft'] });
    await artifacts.put({ name: 'b', content: '2', jobId: 'job_2', tags: ['final'] });

    expect((await artifacts.list({ jobId: 'job_1' })).map(a => a.name)).toEqual(['a']);
    expect((await artifacts.list({ tags: ['final'] })).map(a => a.name)).toEqual(['b']);
    await db.close();
  });

  it('deletes an artifact', async () => {
    const { artifacts, db } = await store();
    const record = await artifacts.put({ name: 'gone', content: 'x' });

    expect(await artifacts.delete(record.artifactId)).toBe(true);
    expect(await artifacts.delete(record.artifactId)).toBe(false);
    await db.close();
  });
});
