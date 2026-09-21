import type { Db } from './types.js';
import { MIGRATIONS, type Migration } from './migrations.js';
import { POSTGRES_MIGRATIONS } from './migrations.postgres.js';

/** The set written for whichever backend this `Db` is. */
export function migrationsFor(db: Db): readonly Migration[] {
  return db.dialect === 'postgres' ? POSTGRES_MIGRATIONS : MIGRATIONS;
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

/**
 * An arbitrary constant, shared by every instance: two migrators agree on it
 * and so contend for the same advisory lock. Nothing else in the database uses
 * advisory locks, so it only ever collides with another migrator.
 */
const MIGRATION_LOCK_KEY = 4021755001;

async function versionIn(tx: Db): Promise<number> {
  const row = (await tx.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()) as {
    version: number | null;
  };
  return row.version ?? 0;
}

export async function getSchemaVersion(db: Db): Promise<number> {
  await db.exec(CREATE_MIGRATIONS_TABLE);
  return versionIn(db);
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: readonly number[];
}

/**
 * Bring the database to the latest schema version.
 *
 * Everything happens inside one transaction that holds an exclusive lock for
 * its whole duration, because instances start concurrently — a rolling restart
 * or a scaled-out deployment is precisely the case Postgres was added for.
 * Reading the version outside the transaction let two instances both see
 * version 0 against a fresh database and both apply migration 1; the loser
 * died at boot on a duplicate relation, and `migrate()` is awaited at the top
 * level of `index.ts`, so that is a dead process rather than a retry.
 *
 * Serialized, the second instance blocks until the first commits, then reads
 * the version again inside its own transaction, finds nothing pending, and
 * boots normally.
 */
export async function migrate(
  db: Db,
  migrations: readonly Migration[] = migrationsFor(db)
): Promise<MigrationResult> {
  return db.transaction(async tx => {
    if (tx.dialect === 'postgres') {
      // Transaction-scoped, so COMMIT or ROLLBACK always releases it — a
      // migrator that throws cannot leave the lock held against every other
      // instance. SQLite needs no equivalent: `transaction()` opens with
      // BEGIN IMMEDIATE and so already holds the single write lock.
      await tx.prepare(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`).get();
    }

    // Inside the lock, so two instances cannot race on creating it either.
    await tx.exec(CREATE_MIGRATIONS_TABLE);

    const from = await versionIn(tx);
    const pending = migrations.filter(m => m.version > from).sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      await tx.exec(migration.up);
      await tx
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    }

    return { from, to: await versionIn(tx), applied: pending.map(m => m.version) };
  });
}
