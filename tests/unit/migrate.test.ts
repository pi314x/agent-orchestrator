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
