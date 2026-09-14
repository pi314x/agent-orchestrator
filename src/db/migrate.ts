import type { Db } from './sqlite.js';
import { MIGRATIONS, type Migration } from './migrations.js';

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

export async function getSchemaVersion(db: Db): Promise<number> {
  await db.exec(CREATE_MIGRATIONS_TABLE);
  const row = (await db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()) as {
    version: number | null;
  };
  return row.version ?? 0;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: readonly number[];
}

export async function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS
): Promise<MigrationResult> {
  const from = await getSchemaVersion(db);
  const pending = migrations.filter(m => m.version > from).sort((a, b) => a.version - b.version);

  await db.transaction(async tx => {
    for (const migration of pending) {
      await tx.exec(migration.up);
      await tx
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    }
  });

  return { from, to: await getSchemaVersion(db), applied: pending.map(m => m.version) };
}
