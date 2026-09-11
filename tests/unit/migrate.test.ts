import { describe, expect, it } from 'vitest';
import { getSchemaVersion, migrate } from '../../src/db/migrate.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/db/migrations.js';
import { openDatabase } from '../../src/db/sqlite.js';

describe('migrate', () => {
  it('applies every migration to a fresh database', () => {
    const db = openDatabase({ url: ':memory:' });

    const result = migrate(db);

    expect(result.from).toBe(0);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toEqual(MIGRATIONS.map(m => m.version));
    db.close();
  });

  it('is idempotent', () => {
    const db = openDatabase({ url: ':memory:' });
    migrate(db);

    const second = migrate(db);

    expect(second.applied).toEqual([]);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('rolls back the batch when a migration fails', () => {
    const db = openDatabase({ url: ':memory:' });

    expect(() =>
      migrate(db, [
        { version: 1, name: 'ok', up: 'CREATE TABLE a (id TEXT);' },
        { version: 2, name: 'broken', up: 'THIS IS NOT SQL;' }
      ])
    ).toThrow();

    expect(getSchemaVersion(db)).toBe(0);
    db.close();
  });

  it('creates the event log the orchestrator writes its audit trail to', () => {
    const db = openDatabase({ url: ':memory:' });
    migrate(db);

    db.prepare('INSERT INTO events (id, ts, type, payload) VALUES (?, ?, ?, ?)').run(
      'evt_1',
      new Date().toISOString(),
      'test',
      '{}'
    );

    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    db.close();
  });
});

describe('migration integrity', () => {
  it('never edits a shipped migration: every version is unique and ordered', () => {
    const versions = MIGRATIONS.map(m => m.version);

    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  // Regression: tool_servers and agent_templates were once appended to an
  // already-shipped migration 5, so a database created at v5 never got them.
  it('upgrades a database that stopped at an older version', () => {
    const db = openDatabase({ url: ':memory:' });

    const upTo5 = MIGRATIONS.filter(m => m.version <= 5);
    migrate(db, upTo5);
    expect(getSchemaVersion(db)).toBe(5);

    migrate(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map(row => row.name);

    expect(tables).toContain('tool_servers');
    expect(tables).toContain('agent_templates');
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('reaches the same schema whether applied at once or in stages', () => {
    const fresh = openDatabase({ url: ':memory:' });
    migrate(fresh);

    const staged = openDatabase({ url: ':memory:' });
    for (const migration of MIGRATIONS) migrate(staged, [migration]);

    const tablesOf = (db: ReturnType<typeof openDatabase>) =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
        .map(row => row.name)
        .sort();

    expect(tablesOf(staged)).toEqual(tablesOf(fresh));
    fresh.close();
    staged.close();
  });
});
