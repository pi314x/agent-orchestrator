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
  },
  {
    version: 2,
    name: 'agents_and_jobs',
    up: `
      CREATE TABLE agents (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
        name         TEXT NOT NULL,
        role         TEXT,
        instructions TEXT NOT NULL DEFAULT '',
        runner       TEXT,
        model        TEXT,
        tool_grants  TEXT NOT NULL DEFAULT '[]',
        limits       TEXT NOT NULL DEFAULT '{}',
        status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
        ephemeral    INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE UNIQUE INDEX idx_agents_name ON agents (name) WHERE status = 'active' AND ephemeral = 0;
      CREATE INDEX idx_agents_kind ON agents (kind, status);

      CREATE TABLE jobs (
        id               TEXT PRIMARY KEY,
        backend          TEXT NOT NULL CHECK (backend IN ('local', 'a2a_remote')),
        state            TEXT NOT NULL CHECK (state IN (
                           'queued', 'blocked', 'running', 'awaiting_input',
                           'succeeded', 'failed', 'cancelled', 'timed_out')),
        agent_id         TEXT NOT NULL REFERENCES agents (id),
        agent_snapshot   TEXT NOT NULL,
        instruction      TEXT NOT NULL,
        context          TEXT,
        output_schema    TEXT,
        depends_on       TEXT NOT NULL DEFAULT '[]',
        priority         INTEGER NOT NULL DEFAULT 0,
        timeout_sec      INTEGER,
        idempotency_key  TEXT,
        parent_job_id    TEXT REFERENCES jobs (id),
        depth            INTEGER NOT NULL DEFAULT 0,
        attempt          INTEGER NOT NULL DEFAULT 1,
        result_text      TEXT,
        result_structured TEXT,
        error            TEXT,
        usage            TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        started_at       TEXT,
        finished_at      TEXT
      );

      -- Submit tools are idempotent: a client retry must not create a second job.
      CREATE UNIQUE INDEX idx_jobs_idempotency ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX idx_jobs_queue ON jobs (state, priority DESC, created_at);
      CREATE INDEX idx_jobs_agent ON jobs (agent_id, created_at);
      CREATE INDEX idx_jobs_parent ON jobs (parent_job_id) WHERE parent_job_id IS NOT NULL;
    `
  }
] as const;

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
