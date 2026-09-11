import type { Db } from './sqlite.js';
import { MIGRATIONS, type Migration } from './migrations.js';

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

export function getSchemaVersion(db: Db): number {
  db.exec(CREATE_MIGRATIONS_TABLE);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  return row.version ?? 0;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: readonly number[];
}

export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  const from = getSchemaVersion(db);
  const pending = migrations.filter(m => m.version > from).sort((a, b) => a.version - b.version);

  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');

  const run = db.transaction((batch: readonly Migration[]) => {
    for (const migration of batch) {
      db.exec(migration.up);
      insert.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  run(pending);

  return { from, to: getSchemaVersion(db), applied: pending.map(m => m.version) };
}
