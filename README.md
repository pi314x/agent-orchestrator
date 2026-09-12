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

`ORCH_TOOL_PROFILE` controls how many of the 65 tools are exposed: `core` (11),
`standard` (33, the default), `full` (56). With `A2A_ENABLED=true` the interop
tools appear too, taking `full` to 65. A smaller profile means better tool
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

`ORCH_AGENTS_DIR` (default `agents/`) is scanned once at startup — there is no
file watcher, so an edit takes effect on the next restart, not live. The
directory is the source of truth: deleting a file withdraws the agent, and
agents made through `agent_create` are never touched.

**This is plain local filesystem access** (`readdirSync`/`readFileSync`), not a
remote fetch. The file has to already be on the disk the server process reads
from before it restarts — there is no git-clone, no network mount, no upload
endpoint built in. Getting a laptop-local file there means `scp`/`rsync` to the
box, a git push the deploy pulls, or a CI sync — whatever your deploy already
uses. A user with no way to get a file onto the server's disk cannot use this
path at all; give them `agent_create` over MCP instead, which needs nothing
more than the client they already have.

`agents/` ships with one file per built-in role — `planner.md`, `researcher.md`,
`coder.md`, `reviewer.md`, `tester.md`, `writer.md`, `critic.md`,
`summarizer.md` — each the same persona as `delegate { template: "..." }`, as a
concrete, editable, tool-grantable starting point:

```markdown
---
name: reviewer
role: reviewer
description: Reviews work for correctness and risk.
---

You are a reviewer. Look for correctness bugs, unhandled cases and security
risk, most severe first. Report only issues you can justify from the material
in front of you.
```

None of the eight set `runner:`, so each follows whatever `ORCH_DEFAULT_RUNNER`
the deployment configures — matching how the built-in templates behave when
delegated to, rather than locking in one runner regardless of how the server is
set up. Set `runner:` explicitly only when an agent genuinely needs a specific
one.

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

## Ownership

With OAuth configured, the token's subject becomes the owner of everything that
caller creates, and each user sees only their own. Without OAuth there is no
caller identity at all, so everything belongs to one owner and the orchestrator
behaves exactly as it did before — the right default for a loopback server.

The `orch:admin` scope reads and acts across owners.

**Isolated today**, enforced in the store rather than in each tool handler, so a
new tool cannot forget:

| | |
|---|---|
| Agents | listed, fetched, updated and deleted only by their owner |
| Jobs | listed, fetched, cancelled and retried only by their owner |
| Artifacts | read, listed and deleted only by their owner — including `artifact_get` inside a running agent's own toolkit, so an artifactId the model picks up from anywhere cannot reach another owner's content |
| Memory | `namespace`/`key` uniqueness is per owner, so two users can both use `"notes"`; reads, writes, deletes and full-text search are all scoped |
| Workflow jobs | a workflow's spawned jobs belong to whoever started it, so `job_list` finds them like any other job |
| Workflow definitions | listed, fetched and deleted only by their owner; names are unique per owner, so two users can each define `"deploy"` |
| Workflow runs | listed, fetched and controlled (`pause`/`resume`/`cancel`/`retry_step`) only by their owner; `workflow_start`'s `workflowId` resolves only a workflow the caller can see, and `idempotencyKey` is scoped per owner so two users choosing the same key never collide |
| `delegate`/`fan_out`/`consensus` by `agentId` or `skillQuery` | resolve only agents the caller can see — never another owner's private agent, even by naming its id directly |
| `job_wait` | can only be pointed at jobs the caller already owns or can see — naming another owner's jobId is refused before any waiting starts, not just filtered out of the result |
| `agent_register` | the registered remote agent belongs to whoever registered it, exactly like `agent_create` |
| `a2a_task_get`/`a2a_task_cancel`/`a2a_push_config_set` | all resolve `jobId` through the same visibility check as `job_get`/`job_cancel` — naming another owner's job is refused, not just routed to a different (and possibly missing) remote task |
| `events_query`/`trace_get` | a non-admin must scope these to a `jobId`, `agentId` or `runId` they can see; there is no unscoped view of every owner's event history |
| `orch://workflows/{id}` and `orch://workflow-runs/{id}` resources | scoped the same way as the `workflow_get`/`workflow_run_get` tools — a resource is a separate registration path from a tool and does not inherit a tool's checks automatically |

A job spawned by an agent inherits the parent's owner, and artifacts and memory
an agent writes belong to the job's owner. Asking for something another user
owns returns `NOT_FOUND` rather than `POLICY_DENIED` — confirming it exists
would leak the id space.

This applies across **MCP tools, the `orch://` resources and the built-in prompts**
— `orch://agents/{id}`, `orch://jobs/{id}`, `orch://jobs/{id}/transcript`,
`orch://artifacts/{id}`, `orch://memory/{namespace}/{key}`, `orch://workflows/{id}`
and `orch://workflow-runs/{id}` are all owner-checked, and the `cross_vendor_review`
prompt lists only the caller's own registered remote agents. Each is a separate
registration path with its own call site to forget: scoping the tools alone left
every resource readable by URI regardless of who owned the row, and scoping the
resources still left the one prompt that lists agents showing every owner's
remote registrations to anyone who invoked it.

### Central, admin-managed agents

`agent_create { ..., shared: true }` — admin only (`orch:admin`) — creates an
agent every caller can see and delegate to, alongside their own. It shows up
in everyone's `agent_list`, resolves by id or `skillQuery` for anyone, and
`agent_get` reports `shared: true` so a caller can tell it apart from their own.
Only an admin may `agent_update` or `agent_delete` it — a non-admin gets
`POLICY_DENIED` naming that explicitly, not `NOT_FOUND`, since its existence is
already visible to them.

This is the same mechanism a single-owner (no-OAuth) deployment already runs
on: every agent there is owner `''`, which is exactly the "shared" sentinel.
Turning on OAuth is what makes `''` mean "deliberately shared by an admin"
instead of "the only owner there is."

Templates remain global and admin-only to change (`agent_template_save`),
unrelated to sharing — a template is a role you can spin an ephemeral agent
from, not a persistent agent itself.

### Peer-to-peer sharing

Everything a user creates is private by default — visible to nobody but its
owner (and an admin) unless the owner explicitly shares it. `agent_share {
agentId, granteeId }` and `memory_share { namespace, granteeId }` grant one
named other user access to exactly that one resource; `agent_unshare`/
`memory_unshare` revoke it, and `agent_share_list`/`memory_share_list` show
current grantees. Only the resource's own owner (or an admin) may share or
revoke it.

This is distinct from the admin-wide `shared: true` sentinel above: a peer
share names exactly one grantee and nothing else changes — the resource
still doesn't show up for anyone else, and the owner keeps sole write access
(a shared agent can be used via `delegate`, and a shared memory namespace can
be read, but not modified by the grantee).

`granteeId` is the other user's `ownerId` — the OAuth subject from their own
token (their Entra object id, if Entra ID is the issuer). There is no user
directory built in, so the owner needs to already know that id (e.g. from
`orchestrator_status` output tied to their session, or simply because your
own IdP shows it) — sharing by email or display name is not supported.

Reading a namespace shared with you needs the owner's id on every call:
`memory_read`/`memory_search` take an optional `ownerId`, and without a grant
on that exact `(ownerId, namespace)` pair they behave exactly like a miss —
`found: false`, or no results — never an error that would confirm whether
the namespace exists at all.

**Not yet isolated.** These remain global:

| | |
|---|---|
| Messages and channels | agent-to-agent messaging is shared |
| Approvals | the review queue is shared, which may well be what you want — resolving one resumes the run regardless of who owns it, since a reviewer resuming a run they don't own is the point of the gate, not a bypass of it |
| Events (unscoped) | a non-admin can only query events tied to a specific job/agent/run they can see (above); there is no per-owner view of the *whole* log, only the admin one |

Templates, registered tool servers, cached Agent Cards, published skills and
budgets are shared **by design** — they are operator configuration, already
behind `orch:admin`.

So: safe for separating colleagues' work on a shared team instance, where
everyone is trusted and the point is not tripping over each other.

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
pnpm test        # 416 tests, no network, no model calls
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
- **Multi-user isolation is partial — do not treat it as a tenancy boundary yet.**
  See [Ownership](#ownership) below for exactly what is and is not separated.
