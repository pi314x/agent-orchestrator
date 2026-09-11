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
  },
  {
    version: 3,
    name: 'shared_state',
    up: `
      CREATE TABLE memory (
        id         INTEGER PRIMARY KEY,
        namespace  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (namespace, key)
      );

      -- External-content FTS5 index kept in step by triggers, so memory_search
      -- never drifts from the table it indexes.
      CREATE VIRTUAL TABLE memory_fts USING fts5 (
        namespace, key, value, tags, content='memory', content_rowid='id'
      );

      CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts (rowid, namespace, key, value, tags)
        VALUES (new.id, new.namespace, new.key, new.value, new.tags);
      END;

      CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts (memory_fts, rowid, namespace, key, value, tags)
        VALUES ('delete', old.id, old.namespace, old.key, old.value, old.tags);
      END;

      CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts (memory_fts, rowid, namespace, key, value, tags)
        VALUES ('delete', old.id, old.namespace, old.key, old.value, old.tags);
        INSERT INTO memory_fts (rowid, namespace, key, value, tags)
        VALUES (new.id, new.namespace, new.key, new.value, new.tags);
      END;

      CREATE TABLE artifacts (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        mime_type       TEXT NOT NULL DEFAULT 'text/plain',
        content_hash    TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL,
        content         BLOB,
        path            TEXT,
        job_id          TEXT,
        workflow_run_id TEXT,
        tags            TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL
      );

      CREATE INDEX idx_artifacts_job ON artifacts (job_id) WHERE job_id IS NOT NULL;
      CREATE INDEX idx_artifacts_run ON artifacts (workflow_run_id) WHERE workflow_run_id IS NOT NULL;
      CREATE INDEX idx_artifacts_hash ON artifacts (content_hash);

      CREATE TABLE channels (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        members    TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id            TEXT PRIMARY KEY,
        to_agent_id   TEXT,
        to_channel    TEXT,
        to_job_id     TEXT,
        from_agent_id TEXT,
        body          TEXT NOT NULL,
        reply_to      TEXT,
        read_at       TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX idx_messages_agent ON messages (to_agent_id, created_at) WHERE to_agent_id IS NOT NULL;
      CREATE INDEX idx_messages_channel ON messages (to_channel, created_at) WHERE to_channel IS NOT NULL;
      CREATE INDEX idx_messages_job ON messages (to_job_id, created_at) WHERE to_job_id IS NOT NULL;

      CREATE TABLE budgets (
        id             TEXT PRIMARY KEY,
        scope          TEXT NOT NULL CHECK (scope IN ('global', 'agent', 'job')),
        scope_id       TEXT NOT NULL DEFAULT '',
        max_cost_usd   REAL,
        max_tokens     INTEGER,
        max_calls      INTEGER,
        max_concurrent INTEGER,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE UNIQUE INDEX idx_budgets_scope ON budgets (scope, scope_id);
    `
  },
  {
    version: 4,
    name: 'workflows_and_approvals',
    up: `
      CREATE TABLE workflows (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        spec       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workflow_runs (
        id              TEXT PRIMARY KEY,
        workflow_id     TEXT,
        spec            TEXT NOT NULL,
        inputs          TEXT NOT NULL DEFAULT '{}',
        state           TEXT NOT NULL CHECK (state IN (
                          'running', 'paused', 'succeeded', 'failed', 'cancelled')),
        idempotency_key TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        finished_at     TEXT
      );

      CREATE UNIQUE INDEX idx_runs_idempotency ON workflow_runs (idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX idx_runs_workflow ON workflow_runs (workflow_id, created_at);

      CREATE TABLE step_runs (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES workflow_runs (id),
        step_id    TEXT NOT NULL,
        job_id     TEXT,
        state      TEXT NOT NULL CHECK (state IN (
                     'pending', 'awaiting_approval', 'running', 'succeeded',
                     'failed', 'skipped', 'cancelled')),
        output     TEXT,
        error      TEXT,
        attempt    INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (run_id, step_id)
      );

      CREATE INDEX idx_step_runs_run ON step_runs (run_id);

      CREATE TABLE approvals (
        id           TEXT PRIMARY KEY,
        status       TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        scope        TEXT NOT NULL,
        summary      TEXT NOT NULL,
        job_id       TEXT,
        run_id       TEXT,
        step_id      TEXT,
        payload      TEXT NOT NULL DEFAULT '{}',
        decision     TEXT,
        comment      TEXT,
        edited_input TEXT,
        created_at   TEXT NOT NULL,
        resolved_at  TEXT
      );

      CREATE INDEX idx_approvals_status ON approvals (status, created_at);
    `
  }
] as const;

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
