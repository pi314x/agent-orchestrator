export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

/**
 * Ordered, append-only. Never edit a shipped migration — add the next one.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init_event_log',
    up: `
      CREATE TABLE events (
        id         TEXT PRIMARY KEY,
        ts         TEXT NOT NULL,
        type       TEXT NOT NULL,
        job_id     TEXT,
        agent_id   TEXT,
        run_id     TEXT,
        payload    TEXT NOT NULL
      );

      CREATE INDEX idx_events_ts ON events (ts);
      CREATE INDEX idx_events_type ON events (type, ts);
      CREATE INDEX idx_events_job ON events (job_id, ts) WHERE job_id IS NOT NULL;
      CREATE INDEX idx_events_agent ON events (agent_id, ts) WHERE agent_id IS NOT NULL;
      CREATE INDEX idx_events_run ON events (run_id, ts) WHERE run_id IS NOT NULL;
    `
  }
] as const;

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
