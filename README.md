# Agent Orchestrator

An MCP server that delegates work to sub-agents. **MCP inward** — your client (Claude
Code, Claude Desktop, any MCP client) talks to it over stdio or Streamable HTTP.
**A2A outward, optionally** — it can call agents built by other people on other
frameworks, and that half is off by default.

Agents can be rows in its database, or Markdown files in your repo. Nothing here
requires an external vendor beyond the model you point a runner at.

## Quickstart

```bash
pnpm install
cp .env.example .env        # set OPENAI_API_KEY, or ANTHROPIC_API_KEY + ORCH_DEFAULT_RUNNER=anthropic
pnpm build
pnpm start                  # stdio
ORCH_TRANSPORT=http pnpm start   # http://127.0.0.1:3333/mcp, health at /health
```

Check what it thinks of its own configuration before using it:

```
orchestrator_status   # version, schema, job counts, limits, whether A2A is on
runner_list           # each runner, and exactly what an unavailable one is missing
```

A job against an unconfigured runner fails immediately with that runner's own
reason, so `runner_list` is the first thing to read when a delegate fails.

### Connecting Claude Code

```bash
claude mcp add orchestrator -- node /absolute/path/to/dist/index.js
```

## The everyday tools

| Tool | Use |
|---|---|
| `delegate` | Run one instruction on the best-matching agent, get the answer back |
| `fan_out` | Run one instruction over many items in parallel, optionally reducing |
| `job_submit` / `job_wait` / `job_get` | Background work, dependencies, audit trail |
| `workflow_start` | A DAG of steps, with conditions and human approval gates |
| `agent_create` / `agent_template_list` | Define agents, or use the eight built-in roles |

`ORCH_TOOL_PROFILE` controls how many of the 59 tools are exposed: `core` (11),
`standard` (33, the default), `full` (50). With `A2A_ENABLED=true` the interop
tools appear too, taking `full` to 59. A smaller profile means better tool
selection by the model, so raise it only when you need something.

## The eight built-in roles

Every one is just a name and a system prompt. Target one with
`delegate { template: "reviewer" }`, or shadow any of them with your own wording
using `agent_template_save`.

| Role | What it is for |
|---|---|
| `planner` | Breaks a goal into an ordered set of concrete steps |
| `researcher` | Gathers and synthesizes information on a question |
| `coder` | Writes and modifies code to a specification |
| `reviewer` | Reviews work for correctness and risk |
| `tester` | Designs and evaluates tests |
| `writer` | Produces clear prose for a stated audience |
| `critic` | Argues against a proposal to surface weaknesses |
| `summarizer` | Condenses material without losing load-bearing detail |

`agent_create` makes a named agent of your own; `agent_template_list` shows the
roles currently available, custom ones included.

## What an agent can actually do

Two sources, and the `cli` runner is neither of them — that is *how* an agent
runs, not what it can call.

**The built-in toolkit.** Every local agent gets these inside its own loop, with
no configuration: `report_progress`, `finish`, `memory_write` / `memory_read` /
`memory_search`, `artifact_put` / `artifact_get`, `message_send` /
`message_list`, and `spawn_job`. They are internal — never exposed over MCP, and
a remote A2A agent never sees them.

**Granted downstream MCP tools.** Register a server with `toolserver_register`,
then grant an agent access through `toolGrants` — `"files"` for everything that
server offers, `"files/read_file"` for a single tool. They arrive in the agent's
loop namespaced `files__read_file`. A deny-list beats an allow-list, an empty
allow-list means everything that server offers, and attaching grants to an agent
requires the `orch:admin` scope once OAuth is configured.

## Agents as Markdown

`ORCH_AGENTS_DIR` (default `agents/`) is scanned at startup. The directory is the
source of truth: edits land on restart, deleting a file withdraws the agent, and
agents made through `agent_create` are never touched.

```markdown
---
name: example-reviewer
role: reviewer
runner: openai-compatible
---

You are a code reviewer for this repository.
Look for correctness bugs and security risk, most severe first.
```

## Runners

| Runner | Notes |
|---|---|
| `openai-compatible` | **Default.** OpenAI, OpenRouter, Ollama, vLLM, LM Studio — `OPENAI_BASE_URL` is the only difference |
| `anthropic` | Claude models, streaming with tool use |
| `cli` | Spawns a headless coding-agent CLI, confined to `ORCH_CLI_WORKSPACE_DIRS` |
| `mock` | Deterministic, for tests and CI |

## A2A is off by default

`A2A_ENABLED=false` removes the whole `a2a_*` group, `agent_register` and
`agent_publish` from `tools/list`, and starts no second listener. If every agent you
use lives in this repo, leave it off — the tool list stays small and nothing reaches
the network on your behalf.

Turning it on enables both directions:

**Outbound** — calling agents other people run. `A2A_TRUST_MODE` (`verified-only` by
default) decides whether an unsigned Agent Card is usable, and remote output always
arrives wrapped as untrusted data.

**Inbound** — letting them call you. A second HTTP server starts on
`A2A_HTTP_PORT` (3334), serving the Agent Card at `/.well-known/agent-card.json`
and JSON-RPC at `/a2a`. It is loopback-bound and Host-validated like the MCP
surface. Nothing is exposed until `agent_publish` opts a skill in explicitly:

```
agent_publish  { skillId: "review", templateName: "reviewer",
                 description: "Reviews a diff for correctness and risk.", exposed: true }
a2a_server_info    # serving: true, and the card as it now stands
```

Withdraw it with `exposed: false` and it stops being advertised immediately — no
restart. Set `A2A_AGENT_CARD_URL` when fronting the server with a proxy, so the
card advertises the URL peers should actually call.

## Storage

SQLite, through [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — one
file, at `~/.agent-orchestrator/orchestrator.sqlite` unless `ORCH_DB_URL` says
otherwise. Opened in WAL mode with foreign keys on and a 5-second busy timeout.
Schema changes are append-only migrations applied at startup; `orchestrator_status`
reports the current version.

**The data layer is synchronous, deliberately.** `better-sqlite3` does its I/O on
the calling thread, so every store — jobs, memory, artifacts, agents, messages,
budgets — is plain synchronous code with no `async` anywhere. The scheduler and
workflow engine read job state inside tight loops and rely on that: a query cannot
interleave with another turn of the event loop, so there is no window for a job's
state to change between the read and the decision made from it. Local SQLite reads
are microseconds, and the process is not serving high-concurrency HTTP traffic, so
the usual reason to go async does not apply.

### Concurrency

WAL mode means one writer and any number of concurrent readers, with competing
writers queueing against the busy timeout rather than failing. **Several
orchestrator processes can share one database file**, which is how you run behind
a round-robin front end.

What makes that safe is that the two places where instances could collide are
each a single atomic statement rather than a read followed by a write:

- taking a queued job (`UPDATE ... WHERE state = 'queued' RETURNING *`), so two
  schedulers never run the same job, and the loser simply moves on;
- resolving an approval (`UPDATE ... WHERE status = 'pending'`), so an approve can
  never land on top of someone else's reject.

`tests/integration/shared-db.test.ts` covers both against a real shared file, and
runs twelve jobs across two schedulers to check each executes exactly once.

The boundary is the **host**: every instance must reach the same file, and SQLite
over NFS or SMB is not safe. Multiple hosts need Postgres.

### No Postgres adapter

PLAN.md §13 sketches one and it is not built. Every network database driver is
async, so it is not a drop-in: it means making the store classes async and then
every caller, including the scheduler loops above, where the synchronous read is
currently doing real work for correctness. That is a refactor, not a config
switch.

## Configuration

Every variable is listed with its default in [`.env.example`](.env.example);
[`PLAN.md`](PLAN.md) §12 is the full table. The defaults are chosen for a local,
single-operator server: loopback binding, no auth, SQLite in `~/.agent-orchestrator`.

Before exposing it beyond localhost, set `ORCH_OAUTH_ISSUER_URL` — tools that change
what the orchestrator may do (`budget_set`, `toolserver_*`, `agent_publish`, and
attaching `toolGrants` to an agent) then require the `orch:admin` scope. Without
OAuth configured there is no caller identity and every tool is open, which is the
right default for a loopback server and the wrong one for a shared host.

## Development

```bash
pnpm test        # 324 tests, no network, no model calls
pnpm test:live   # opt-in: needs RUN_LIVE_TESTS=1 and a real ANTHROPIC_API_KEY
pnpm typecheck && pnpm lint && pnpm build
```

[`AGENTS.md`](AGENTS.md) is the contributor guide — architecture rules, verified SDK
behaviour, and the gotchas that have already bitten us. Read it before changing
anything under `src/`.

## Known limitations

- **The live path is tested against a protocol-level fake, not a real vendor.**
  `tests/live/` exists and is written, but has never been executed — it needs a key.
  Run `pnpm test:live` once before trusting this with real work.
- **A2A has never met a real third-party agent.** Both directions are implemented
  and tested over a real socket, using the SDK's own serializers — but every peer
  so far has been ours. Expect to find interop surprises on first contact with
  someone else's implementation.
- **SQLite only.** See [Storage](#storage) below — several processes on one host
  are fine; multiple hosts are not.
- **No multi-user isolation.** There is no owner column on any table: every agent,
  job, memory entry and artifact is global. OAuth identifies callers for the
  `orch:admin` scope but that identity never reaches the data layer, so any user
  can see, cancel or delete another's work. Fine for one team sharing an
  orchestrator; not a tenancy boundary.
