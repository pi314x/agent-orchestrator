import { describe, expect, it } from 'vitest';
import { getSchemaVersion, migrate } from '../../src/db/migrate.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/db/migrations.js';
import { openDatabase } from '../../src/db/sqlite.js';

describe('migrate', () => {
  it('applies every migration to a fresh database', async () => {
    const db = openDatabase({ url: ':memory:' });

    const result = await migrate(db);

    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toEqual(MIGRATIONS.map(m => m.version));
    await db.close();
  });

  it('is idempotent', async () => {
    const db = openDatabase({ url: ':memory:' });
    await migrate(db);

    const second = await migrate(db);

    expect(second.applied).toEqual([]);
    expect(await getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    await db.close();
  });

  it('rolls back the batch when a migration fails', async () => {
    const db = openDatabase({ url: ':memory:' });

    await expect(
      migrate(db, [
        { version: 1, name: 'ok', up: 'CREATE TABLE a (id TEXT);' },
        { version: 2, name: 'broken', up: 'THIS IS NOT SQL;' }
      ])
    ).rejects.toThrow();

    expect(await getSchemaVersion(db)).toBe(0);
    await db.close();
  });

  it('creates the event log the orchestrator writes its audit trail to', async () => {
    const db = openDatabase({ url: ':memory:' });
    await migrate(db);

    await db
      .prepare('INSERT INTO events (id, ts, type, payload) VALUES (?, ?, ?, ?)')
      .run('evt_1', new Date().toISOString(), 'test', '{}');

    expect(await db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    await db.close();
  });
});

describe('migration integrity', () => {
  it('never edits a shipped migration: every version is unique and ordered', async () => {
    const versions = MIGRATIONS.map(m => m.version);

    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  // Regression: tool_servers and agent_templates were once appended to an
  // already-shipped migration 5, so a database created at v5 never got them.
  it('upgrades a database that stopped at an older version', async () => {
    const db = openDatabase({ url: ':memory:' });

    const upTo5 = MIGRATIONS.filter(m => m.version <= 5);
    await migrate(db, upTo5);
    expect(await getSchemaVersion(db)).toBe(5);

    await migrate(db);

    const tables = (
      (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()) as { name: string }[]
    ).map(row => row.name);

    expect(tables).toContain('tool_servers');
    expect(tables).toContain('agent_templates');
    expect(await getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    await db.close();
  });

  it('reaches the same schema whether applied at once or in stages', async () => {
    const fresh = openDatabase({ url: ':memory:' });
    await migrate(fresh);

    const staged = openDatabase({ url: ':memory:' });
    for (const migration of MIGRATIONS) await migrate(staged, [migration]);

    const tablesOf = async (db: ReturnType<typeof openDatabase>) =>
      (
        (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()) as {
          name: string;
        }[]
      )
        .map(row => row.name)
        .sort();

    expect(tablesOf(staged)).toEqual(tablesOf(fresh));
    await fresh.close();
    await staged.close();
  });
});
