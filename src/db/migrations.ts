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
  },
  {
    version: 5,
    name: 'a2a_interop',
    up: `
      CREATE TABLE agent_cards (
        id          TEXT PRIMARY KEY,
        url         TEXT NOT NULL UNIQUE,
        card        TEXT NOT NULL,
        trust_level TEXT NOT NULL CHECK (trust_level IN ('verified', 'unverified')),
        verified_at TEXT,
        fetched_at  TEXT NOT NULL
      );

      -- Remote agents carry their card, their own credential, and the trust
      -- level the card was accepted at. Credentials are never shared between
      -- registrations, so this is a per-agent column by design.
      ALTER TABLE agents ADD COLUMN card_id TEXT REFERENCES agent_cards (id);
      ALTER TABLE agents ADD COLUMN credentials_ref TEXT;
      ALTER TABLE agents ADD COLUMN trust_level TEXT;
      ALTER TABLE agents ADD COLUMN endpoint_url TEXT;

      ALTER TABLE jobs ADD COLUMN remote_task_id TEXT;
      ALTER TABLE jobs ADD COLUMN remote_context_id TEXT;

      CREATE INDEX idx_jobs_remote_task ON jobs (remote_task_id) WHERE remote_task_id IS NOT NULL;

      -- Distinguishes agents defined by a repo file from ones created through
      -- the API, so a sync can safely replace the former and never touch the latter.
      ALTER TABLE agents ADD COLUMN source TEXT NOT NULL DEFAULT 'api';
      ALTER TABLE agents ADD COLUMN source_path TEXT;

      CREATE TABLE published_skills (
        skill_id      TEXT PRIMARY KEY,
        agent_id      TEXT,
        template_name TEXT,
        description   TEXT NOT NULL,
        exposed       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `
  },
  {
    version: 6,
    name: 'tool_servers_and_custom_templates',
    up: `
      CREATE TABLE tool_servers (
        name                 TEXT PRIMARY KEY,
        transport            TEXT NOT NULL,
        auth_ref             TEXT,
        allow_tools          TEXT NOT NULL DEFAULT '[]',
        deny_tools           TEXT NOT NULL DEFAULT '[]',
        require_approval_for TEXT NOT NULL DEFAULT '[]',
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );

      CREATE TABLE agent_templates (
        name       TEXT PRIMARY KEY,
        spec       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 7,
    name: 'owner_scoping',
    up: `
      -- Multi-user isolation. '' is the single-owner deployment: no OAuth means
      -- no caller identity, so every existing row keeps working unchanged and a
      -- loopback server behaves exactly as before.
      --
      -- Only the things a user creates and reasons about are owned. Templates,
      -- tool servers, cached Agent Cards, published skills and budgets stay
      -- shared: they are operator configuration, already behind orch:admin.
      ALTER TABLE agents          ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE jobs            ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE artifacts       ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE workflows       ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE workflow_runs   ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';

      CREATE INDEX idx_agents_owner        ON agents (owner_id, status);
      CREATE INDEX idx_jobs_owner          ON jobs (owner_id, created_at);
      CREATE INDEX idx_artifacts_owner     ON artifacts (owner_id, created_at);
      CREATE INDEX idx_workflows_owner     ON workflows (owner_id);
      CREATE INDEX idx_workflow_runs_owner ON workflow_runs (owner_id);

      -- The queue index gains the owner so a per-owner scan stays cheap without
      -- losing the ordering the scheduler depends on.
      CREATE INDEX idx_jobs_owner_queue ON jobs (owner_id, state, priority DESC, created_at);
    `
  },
  {
    version: 8,
    name: 'memory_owner_scoping',
    up: `
      -- Isolate memory per user. The table-level UNIQUE(namespace, key) cannot
      -- be widened to UNIQUE(owner_id, namespace, key) in place, so the table
      -- is rebuilt. Rowids are preserved on the copy (explicit id column) so
      -- the FTS5 external-content index, keyed by content_rowid='id', can be
      -- rebuilt against the same ids rather than needing a rowid remap.
      DROP TRIGGER memory_ai;
      DROP TRIGGER memory_ad;
      DROP TRIGGER memory_au;
      DROP TABLE memory_fts;

      CREATE TABLE memory_new (
        id         INTEGER PRIMARY KEY,
        owner_id   TEXT NOT NULL DEFAULT '',
        namespace  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, namespace, key)
      );

      -- Existing rows predate ownership, so they land on the single-owner
      -- sentinel, same as every other table migration 7 touched.
      INSERT INTO memory_new (id, owner_id, namespace, key, value, tags, expires_at, created_at, updated_at)
      SELECT id, '', namespace, key, value, tags, expires_at, created_at, updated_at FROM memory;

      DROP TABLE memory;
      ALTER TABLE memory_new RENAME TO memory;

      CREATE INDEX idx_memory_owner ON memory (owner_id, namespace);

      CREATE VIRTUAL TABLE memory_fts USING fts5 (
        namespace, key, value, tags, content='memory', content_rowid='id'
      );

      INSERT INTO memory_fts (rowid, namespace, key, value, tags)
      SELECT id, namespace, key, value, tags FROM memory;

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
    `
  },
  {
    version: 9,
    name: 'per_owner_naming_and_workflow_visibility',
    up: `
      -- Agent names were unique across the whole deployment, not per owner, so
      -- two different users could not both name an agent "reviewer" even
      -- though each agent is private to its own owner. A shared agent still
      -- collides with anyone's private name of the same value under this
      -- constraint, which is the intended behaviour: one namespace to pick
      -- from, disambiguated by owner otherwise.
      DROP INDEX idx_agents_name;
      CREATE UNIQUE INDEX idx_agents_name ON agents (owner_id, name) WHERE status = 'active' AND ephemeral = 0;

      -- workflows.name carries a table-level UNIQUE, which SQLite cannot widen
      -- in place, so the table is rebuilt the same way migration 8 reworked
      -- memory. No foreign key references workflows.id, so this is safe.
      CREATE TABLE workflows_new (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL DEFAULT '',
        name       TEXT NOT NULL,
        spec       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );

      INSERT INTO workflows_new (id, owner_id, name, spec, created_at, updated_at)
      SELECT id, '', name, spec, created_at, updated_at FROM workflows;

      DROP TABLE workflows;
      ALTER TABLE workflows_new RENAME TO workflows;

      CREATE INDEX idx_workflows_owner ON workflows (owner_id);

      -- Idempotency keys were unique across the whole deployment, so two
      -- different users choosing the same key string (a plausible client
      -- convention, e.g. "run-1") would have the second submitter handed back
      -- the first user's actual job or run — its result, its instructions,
      -- everything. Scoped per owner instead, matching how every other
      -- uniqueness constraint here now works.
      DROP INDEX idx_jobs_idempotency;
      CREATE UNIQUE INDEX idx_jobs_idempotency ON jobs (owner_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      DROP INDEX idx_runs_idempotency;
      CREATE UNIQUE INDEX idx_runs_idempotency ON workflow_runs (owner_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `
  }
] as const;

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
