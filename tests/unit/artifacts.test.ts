import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/core/artifacts.js';
import { generateDataKey } from '../../src/core/pqc.js';
import type { Db } from '../../src/db/sqlite.js';
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

describe('ArtifactStore with a PQC data key', () => {
  async function sealed(): Promise<{ db: Db; artifacts: ArtifactStore; raw: (id: string) => Promise<string> }> {
    const db = await migratedDb();
    const artifacts = new ArtifactStore(db, { dataKey: generateDataKey() });
    const raw = async (id: string): Promise<string> =>
      ((await db.prepare('SELECT content FROM artifacts WHERE id = ?').get(id)) as { content: string }).content;
    return { db, artifacts, raw };
  }

  it('seals content at rest but reads back plaintext with paging intact', async () => {
    const { artifacts, raw, db } = await sealed();
    const record = await artifacts.put({ name: 'secret.md', content: 'abcdef' });

    // The row holds an envelope, never the plaintext.
    expect(await raw(record.artifactId)).toMatch(/^pqc1\./);
    expect(await raw(record.artifactId)).not.toContain('abcdef');

    // The hash still names the logical content, so fingerprints survive sealing.
    const plain = new ArtifactStore(db);
    const twin = await plain.put({ name: 'twin.md', content: 'abcdef' });
    expect(twin.contentHash).toBe(record.contentHash);

    expect((await artifacts.read(record.artifactId)).content).toBe('abcdef');
    expect((await artifacts.read(record.artifactId, 0, 3)).content).toBe('abc');
    await db.close();
  });

  it('fails closed reading a sealed row without the key, never leaking the box', async () => {
    const { artifacts, db } = await sealed();
    const record = await artifacts.put({ name: 'secret.md', content: 'abcdef' });

    const keyless = new ArtifactStore(db);
    await expect(keyless.read(record.artifactId)).rejects.toThrow(/no .*DATA_KEY/i);
    await db.close();
  });
});
