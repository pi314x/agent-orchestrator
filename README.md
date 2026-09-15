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
```

Then start it, either through the package manager or by running the compiled
output directly — they do the same thing, since `pnpm start` (see
`package.json`) is just a thin wrapper around the second form:

```bash
pnpm start                       # stdio
ORCH_TRANSPORT=http pnpm start   # http://127.0.0.1:3333/mcp, health at /health

# equivalent, without going through pnpm — useful once something else
# (a process manager, an MCP client, systemd) is launching it directly:
node dist/index.js
ORCH_TRANSPORT=http node dist/index.js
```

Check what it thinks of its own configuration before using it:

```
orchestrator_status   # version, schema, job counts, limits, whether A2A is on
runner_list           # each runner, and exactly what an unavailable one is missing
```

A job against an unconfigured runner fails immediately with that runner's own
reason, so `runner_list` is the first thing to read when a delegate fails.

### Connecting Claude Code

Prefer Streamable HTTP: start the server once, keep it running, and point the
client at a URL. There's no path for the client to get wrong and no process
for it to manage.

```bash
ORCH_TRANSPORT=http node dist/index.js &    # or: ORCH_TRANSPORT=http pnpm start
claude mcp add --transport http orchestrator http://127.0.0.1:3333/mcp
```

Alternative: stdio, where Claude Code launches and owns the process itself.
This needs the **absolute** path to `dist/index.js` — a relative path, or a
placeholder like `/absolute/path/to/dist/index.js` left unedited, connects to
nothing and fails with `CONNECTION_CLOSED`:

```bash
claude mcp add orchestrator -- node /absolute/path/to/agent-orchestrator/dist/index.js
```

Verify either way with `claude mcp get orchestrator` — it should report
`Status: ✔ Connected`.

## Tools

`ORCH_TOOL_PROFILE` controls how many tools are exposed: `core` (11), `standard`
(33, the default), `full` (56) — with A2A off, which it is by default. Profiles
are cumulative, and turning on `A2A_ENABLED=true` adds the interop tools to
whichever profile is active except `core` (none of its tools require A2A):
`standard` grows to 37, `full` to 65. A smaller profile means better tool
selection by the model, so raise it only when you need something. Tools marked
`*` below require `A2A_ENABLED=true` regardless of the profile they're listed at.

**Delegation & orchestration**

| Tool | Profile | Use |
|---|---|---|
| `delegate` | core | Run one instruction on the best-matching agent, wait for the result |
| `fan_out` | core | The same instruction over many items in parallel, with an optional reduce step |
| `plan_create` | standard | Turn a goal into a draft workflow spec via a planner agent — returned, never run |
| `consensus` | full | Put one question to several agents, aggregate the answers by vote or judge |

**Jobs** — the queue underneath `delegate`/`fan_out`, for work you don't want to block on

| Tool | Profile | Use |
|---|---|---|
| `job_submit` | core | Queue work and return a handle immediately |
| `job_get` | core | Fetch one job's state, result and usage |
| `job_wait` | core | Block (≤60s) until given jobs finish |
| `job_cancel` | core | Cancel a queued or running job |
| `job_list` | standard | List jobs by state, agent or backend |
| `job_retry` | standard | Re-queue a failed, cancelled or timed-out job |
| `job_steer` | standard | Send guidance to a running job through its message inbox |

**Workflows** — a named DAG of steps, with conditions, retries and approval gates

| Tool | Profile | Use |
|---|---|---|
| `workflow_define` | standard | Create or replace a named workflow spec |
| `workflow_list` / `workflow_get` | standard | List / fetch workflow definitions |
| `workflow_start` | standard | Start a run from a defined or inline spec |
| `workflow_run_get` | standard | Per-step state and outputs for a run |
| `workflow_run_control` | standard | `pause` / `resume` / `cancel` / `retry_step` |
| `workflow_delete` | full | Remove a definition (past runs unaffected) |
| `workflow_run_list` | full | List runs, filtered by workflow or state |

**Agents**

| Tool | Profile | Use |
|---|---|---|
| `agent_template_list` | core | List built-in role templates |
| `agent_create` | standard | Define a persistent local agent |
| `agent_list` / `agent_get` | standard | List / fetch agents, local and remote together |
| `agent_register` * | standard | Register a remote A2A agent from its Agent Card |
| `agent_publish` * | standard | Expose a local agent or template on this orchestrator's own Agent Card |
| `agent_update` / `agent_delete` | full | Change or remove a local agent |
| `agent_template_save` | full | Add or overwrite a role template (admin) |
| `agent_share` / `agent_unshare` / `agent_share_list` | full | Peer-share one agent with one named user |

**Memory** — a namespaced JSON blackboard, shared by every agent

| Tool | Profile | Use |
|---|---|---|
| `memory_write` / `memory_read` / `memory_search` | standard | Write, read, full-text search |
| `memory_delete` | full | Delete a key, a prefix, or a whole namespace |
| `memory_share` / `memory_unshare` / `memory_share_list` | full | Peer-share a namespace with one named user |

**Artifacts** — content too large to pass inline between tool calls

| Tool | Profile | Use |
|---|---|---|
| `artifact_get` | core | Read an artifact, with `offset`/`length` for paging |
| `artifact_put` / `artifact_list` | standard | Store / list artifacts |
| `artifact_delete` | full | Delete an artifact (irreversible) |

**Messaging**

| Tool | Profile | Use |
|---|---|---|
| `message_send` / `message_list` | full | Message an agent, a shared channel, or a running job |
| `channel_create` / `channel_list` | full | Create / list shared topic channels |

**Human in the loop**

| Tool | Profile | Use |
|---|---|---|
| `approval_list` / `approval_resolve` | core | List and resolve gates left by a workflow step marked `approval: true` |

**Observability & budgets**

| Tool | Profile | Use |
|---|---|---|
| `events_query` | standard | Read the append-only audit trail |
| `trace_get` | standard | Build a span tree for a job or workflow run, with timings and usage |
| `usage_report` | standard | Tokens and cost, grouped by agent, model or backend |
| `budget_set` | full | Set a hard spend cap — deployment, one agent, or one job (admin) |

**Downstream MCP servers** — what `toolGrants` on an agent draws from

| Tool | Profile | Use |
|---|---|---|
| `toolserver_register` | full | Register a downstream MCP server, stdio or HTTP (admin) |
| `toolserver_list` / `toolserver_tools` | full | List servers / the tools one offers, after allow/deny lists (admin) |
| `toolserver_remove` | full | Unregister a server and close its connection (admin) |

**Admin**

| Tool | Profile | Use |
|---|---|---|
| `orchestrator_status` | core | Health, version, active profile, queue depth, schema version |
| `runner_list` | standard | Each execution backend, and whether it's usable right now |

**A2A interop** (`A2A_ENABLED=true` only)

| Tool | Profile | Use |
|---|---|---|
| `a2a_server_info` | standard | Show this orchestrator's own published Agent Card |
| `a2a_card_get` | standard | Fetch and cache a remote Agent Card without registering it |
| `a2a_card_verify` | full | Re-check a cached card's signature, report `trustLevel` |
| `a2a_discover` | full | Search cached cards (and a configured registry) by skill |
| `a2a_task_get` / `a2a_task_cancel` | full | Read or cancel the raw remote task behind a job |
| `a2a_push_config_set` | full | Ask a remote agent to push task updates to a webhook instead of being polled |

`orch://` resources (`agent`, `job`, `job-transcript`, `workflow`, `workflow-run`,
`artifact`, `memory`, `templates`, plus `a2a/card` when A2A is on) mirror this
same state for a host that prefers pulling context over calling tools — see
[Ownership](#ownership) for how they're scoped. Six built-in prompts
(`orchestrate`, `build_feature`, `research_team`, `code_review_swarm`,
`cross_vendor_review`, `postmortem_run`) chain these tools into a starting
point for a common task; the host still drives every actual tool call.

## Examples

**Delegate one thing and read the answer:**

```
delegate { instruction: "Summarize this incident report in 3 bullets.",
           template: "summarizer" }
→ { status: "completed", result: "...", usage: { tokens: 812, costUsd: 0.0031 } }
```

**Fan out over files, then reduce:**

```
fan_out {
  instructionTemplate: "Review {{item}} for a null-check bug in the auth path.",
  items: ["src/auth/login.ts", "src/auth/refresh.ts", "src/auth/session.ts"],
  template: "reviewer",
  concurrency: 3,
  reduce: { template: "summarizer", instruction: "Merge these findings, dedupe overlaps." }
}
```

**Background work with a dependency, then wait on both:**

```
job_submit { instruction: "Draft the release notes for v1.4.", template: "writer" }
→ { jobId: "job_01H..." }

job_submit { instruction: "Proofread the draft release notes.", template: "reviewer",
             dependsOn: ["job_01H..."] }
→ { jobId: "job_01J..." }   # stays queued until the first job finishes

job_wait { jobIds: ["job_01H...", "job_01J..."], mode: "all", timeoutSec: 60 }
```

**A workflow with a human approval gate before shipping:**

```
workflow_define {
  name: "ship-feature",
  steps: [
    { id: "plan",   instruction: "Plan the change.",    template: "planner" },
    { id: "build",  instruction: "Implement the plan.", template: "coder",    dependsOn: ["plan"] },
    { id: "review", instruction: "Review the diff.",    template: "reviewer", dependsOn: ["build"], approval: true },
    { id: "ship",   instruction: "Open the PR.",        template: "coder",    dependsOn: ["review"] }
  ]
}

workflow_start { workflowId: "wf_...", inputs: { feature: "dark mode toggle" } }
→ { runId: "run_..." }

# once the "review" step pauses on its gate:
approval_list { status: "pending" }
approval_resolve { approvalId: "appr_...", decision: "approve" }
```

**Share state across jobs with memory and artifacts:**

```
memory_write { namespace: "release-1.4", key: "changelog", value: { items: ["..."] } }
artifact_put { name: "full-diff.patch", content: "<patch text>", mimeType: "text/x-diff" }
→ { artifactId: "art_..." }

# a later job reads both back:
memory_read   { namespace: "release-1.4", key: "changelog" }
artifact_get  { artifactId: "art_...", offset: 0 }
```

**Grant an agent a downstream MCP tool:**

```
toolserver_register {
  name: "files",
  transport: { type: "stdio", command: "npx",
               args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/repo"] }
}

agent_create {
  name: "repo-reader",
  role: "researcher",
  instructions: "Answer questions about the repo at /srv/repo using the files tools.",
  toolGrants: ["files/read_file", "files/list_directory"]
}
```

`repo-reader` sees these inside its own loop as `files__read_file` and
`files__list_directory` — see [What an agent can actually do](#what-an-agent-can-actually-do).

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
| `cli` | Spawns a headless coding-agent CLI (`claude`, `codex`, …) under **your own login**, confined to `ORCH_CLI_WORKSPACE_DIRS` |
| `mock` | Deterministic, for tests and CI |

### The orchestrator has no model of its own

There is no LLM in here. Every model call goes to an endpoint you name, so you
can point it at your own gateway, a local Ollama or vLLM, or an application that
fronts its own model — and **an endpoint that is not `api.openai.com` needs no
API key at all**:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8080/v1   # wherever your model lives
ORCH_DEFAULT_RUNNER=openai-compatible
# OPENAI_MODEL=your-model                  # optional — see below
# no OPENAI_API_KEY, no ANTHROPIC_API_KEY
```

`OPENAI_MODEL` is optional against your own endpoint. Set it and it is sent as
usual; leave it unset and the `model` field is **omitted** rather than guessed,
so a server that serves one loaded model (llama.cpp, LM Studio, a single-model
gateway) works with no configuration at all. Nothing invents a model name for a
non-OpenAI endpoint — `runner_list` reports no `defaultModel` instead of naming
one your server has never heard of. An agent can always override with its own
`model`.

That is the whole of it — a configuration, not a mode. The server boots with no
keys set, `runner_list` reports `openai-compatible` as available, and jobs,
workflows, fan-out and budgets all behave exactly as documented; usage still
accounts, so `budget_set` keeps working against someone else's model. Operation
is unchanged: everything goes through the same MCP tools.

`tests/integration/bring-your-own-llm.test.ts` keeps it that way — it runs a job
end to end with no API key configured and asserts the request reached the
supplied endpoint.

### Or let a coding-agent CLI be the model

If the model you want to use is one you are already logged into — a `claude` or
`codex` CLI — the `cli` runner spawns it per job and reads its answer from
stdout. Its own login is the credential, so again there is no key here:

```bash
ORCH_CLI_COMMAND=claude
ORCH_CLI_ARGS=-p                       # comma-separated; `codex,exec` for Codex
ORCH_CLI_WORKSPACE_DIRS=/srv/workspaces
ORCH_CLI_ALLOW_NETWORK=true            # the CLI has to reach its own backend
```

Two things to know before choosing this over a base URL. A `cli` agent gets
**no toolkit** — no `finish`, no `memory_*`, no `artifact_put`, no spawning
sub-agents; the instruction goes in on stdin and whatever the process prints
comes back as the result. And only wall-clock duration is recorded, not tokens,
so `maxTokens` and `maxCostUsd` budgets do not bind it (`maxCalls` and
`maxConcurrent` still do). The workspace allow-list is the security boundary:
with none set the runner refuses to run at all.

MCP's *sampling* (`sampling/createMessage`) would be a third way to do this,
with the client answering each model call. It is deliberately **not** used here:
it is deprecated as of protocol revision `2026-07-28` (SEP-2577), whose own
guidance is to call LLM provider APIs directly, and it would trade a single
environment variable for a resumable agent loop, a capability gate and a second
code path. A base URL does the same job.

## A2A is off by default

`A2A_ENABLED=false` removes the whole `a2a_*` group, `agent_register` and
`agent_publish` from `tools/list`, and starts no second listener. If every agent you
use lives in this repo, leave it off — the tool list stays small and nothing reaches
the network on your behalf.

Turning it on enables both directions:

**Outbound** — calling agents other people run. `A2A_TRUST_MODE` (`verified-only` by
default) decides whether an unsigned Agent Card is usable, and remote output always
arrives wrapped as untrusted data. Every URL this orchestrator itself fetches on a
caller's behalf — a card URL (`agent_register`, `a2a_card_get`), a card signature's
key location, a push-notification callback — is HTTPS-only and refuses a private,
loopback or cloud-metadata address, so registering a remote agent can't be used to
probe your internal network.

**Inbound** — letting them call you. A second HTTP server starts on
`A2A_HTTP_PORT` (3334), serving the Agent Card at `/.well-known/agent-card.json`
and JSON-RPC at `/a2a`. It is loopback-bound and Host- and Origin-validated
like the MCP surface. Nothing is exposed until `agent_publish` opts a skill in
explicitly:

```
agent_publish  { skillId: "review", templateName: "reviewer",
                 description: "Reviews a diff for correctness and risk.", exposed: true }
a2a_server_info    # serving: true, and the card as it now stands
```

Withdraw it with `exposed: false` and it stops being advertised immediately — no
restart. Set `A2A_AGENT_CARD_URL` when fronting the server with a proxy, so the
card advertises the URL peers should actually call.

## Storage

Two backends, chosen in `.env` by what `ORCH_DB_URL` points at:

| `ORCH_DB_URL` | Backend |
|---|---|
| unset, or a file path | SQLite (default: `~/.agent-orchestrator/orchestrator.sqlite`) |
| `postgres://…` or `postgresql://…` | Postgres |

Nothing else changes: the same stores, the same tools, the same migrations by
number and name. SQLite runs through
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) in WAL mode with
foreign keys on and a 5-second busy timeout; Postgres runs through
[`pg`](https://github.com/brianc/node-postgres) on a connection pool sized by
`ORCH_DB_MAX_CONNECTIONS` (default 10). Schema changes are append-only migrations
applied at startup; `orchestrator_status` reports the current version.

**The data layer is async.** Every store — jobs, memory, artifacts, agents,
messages, budgets — returns promises, because a network database driver has no
other option. SQLite still does its I/O synchronously under the hood; the adapter
just hands back already-resolved promises, and serializes operations through a
FIFO queue so one connection is never asked to interleave two transactions.

### Concurrency

**Several orchestrator processes can share one database.** What makes that safe
is that every place two instances could collide is a single atomic statement
rather than a read followed by a write:

- taking a queued job (`UPDATE ... WHERE state = 'queued' RETURNING *`), so two
  schedulers never run the same job, and the loser simply moves on;
- resolving an approval (`UPDATE ... WHERE status = 'pending'`), so an approve can
  never land on top of someone else's reject;
- starting a workflow step (`UPDATE ... WHERE state = 'pending' RETURNING`), so a
  step is submitted by whichever instance takes the row and skipped by the other.
  Every instance re-evaluates every live run on any job state change, so two of
  them reach the same pending step routinely, not rarely;
- moving a job between states (`UPDATE ... WHERE id = ? AND state = ?`), so the
  instance finishing a job and a `job_cancel` served elsewhere cannot both write
  — one wins, the loser is told, and the job never ends up `cancelled` while
  carrying a successful result.

Their atomicity comes from being one statement, not from the caller running
synchronously, which is why it survived the async conversion intact and holds on
both backends. `tests/integration/shared-db.test.ts` covers the job claim against
a real shared SQLite file, running twelve jobs across two schedulers to check
each executes exactly once; `tests/integration/postgres-db.test.ts` re-proves the
claim and the approval against a live Postgres server.

One case needed more than one statement. A job left `running` by a process
that died has to be recovered — but from a database row alone, "abandoned" and
"a sibling is working on it right now" look identical. So a claim records
**who** took the job, and that instance renews the lease every 15 seconds while
it runs. Recovery only takes jobs whose lease has gone unrenewed for a minute:
four missed heartbeats, because reclaiming a job that is merely slow would run
it twice. A reclaimed job is re-queued if it carries an `idempotencyKey` (a
client retrying that key would be handed the same job anyway, so it cannot
duplicate) and failed as `INTERRUPTED` otherwise, rather than silently looking
live. The reaper runs on every instance, so a crashed one's work is picked up by
a live sibling instead of waiting for the dead process to come back — which,
behind a load balancer, it may never do.

Waiting works across instances too. `job_wait` — and `delegate`, `fan_out` and
`consensus`, which all wait internally — reacts to this instance's own job
events and also re-reads the jobs every 250ms, because those events only ever
fire for work this process ran. Without the second half, a wait on a job another
instance picked up ran to its full timeout on work that had already finished.

Cancelling works across instances too, in two steps for the same reason. The
`AbortController` that actually stops a run lives in the memory of the one
process running it, so `job_cancel` served anywhere else records the request and
that process acts on it on its next lease tick — a few seconds. `job_cancel`
therefore returns the job still `running`; poll `job_get` for the final state.
Writing `cancelled` onto the row from another instance would have been a lie:
the agent would keep working and keep spending, then overwrite the row with its
own result.

Two limits that sound alike are counted in different places. `ORCH_MAX_CONCURRENCY`
is one process's worker pool, so it applies per instance. A `maxConcurrent`
budget is a cap on the deployment, so it is counted in the database — counted in
memory it was silently enforced once per instance, making a cap of 1 across three
instances allow three.

**SQLite's boundary is the host.** WAL gives one writer and any number of
concurrent readers, with competing writers queueing against the busy timeout
rather than failing — but every instance must reach the same file, and SQLite over
NFS or SMB is not safe. Postgres lifts that boundary: instances on different hosts
share one server.

### Postgres

```bash
ORCH_DB_URL=postgres://orch:secret@db.internal:5432/orchestrator
ORCH_DB_MAX_CONNECTIONS=10
```

Migrations run at startup like they do for SQLite, from a parallel set carrying
the same version numbers. Two queries have no portable form and branch on the
dialect: memory search (SQLite FTS5 `MATCH` against an external-content virtual
table, Postgres `tsvector` + GIN with `plainto_tsquery`), and the budget spend
aggregate (`json_extract` vs `::jsonb ->>`). Everything else — `?` placeholders,
`INSERT ... ON CONFLICT DO UPDATE`, `UPDATE ... RETURNING`, partial indexes — is
written once and runs on both, with `?` rewritten to `$n` inside the adapter.

For a local database to develop against:

```bash
docker compose up -d db
TEST_POSTGRES_URL=postgres://orch:orch@127.0.0.1:5432/orch pnpm test
```

`tests/integration/postgres-db.test.ts` skips cleanly when `TEST_POSTGRES_URL` is
unset, so a checkout without a database still runs a green suite.

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
| Inbound A2A task jobs | belong to whoever owns the published agent handling the delegation — the same "belongs to whoever owns the agent doing the work" rule as a spawned job, so the agent's real owner can `job_get`/`job_wait`/`job_cancel` it too, not only an admin |
| Workflow definitions | listed, fetched and deleted only by their owner; names are unique per owner, so two users can each define `"deploy"` |
| Workflow runs | listed, fetched and controlled (`pause`/`resume`/`cancel`/`retry_step`) only by their owner; `workflow_start`'s `workflowId` resolves only a workflow the caller can see, and `idempotencyKey` is scoped per owner so two users choosing the same key never collide |
| `delegate`/`fan_out`/`consensus` by `agentId` or `skillQuery` | resolve only agents the caller can see — never another owner's private agent, even by naming its id directly |
| `job_wait` | can only be pointed at jobs the caller already owns or can see — naming another owner's jobId is refused before any waiting starts, not just filtered out of the result |
| `job_submit`'s `dependsOn` | every id named must already be visible to the caller — otherwise a job blocked on another owner's private job would leak that job's existence, exact state and the timing of its state changes through the dependent's own `job.blocked` event and auto-release, without ever calling `job_get` |
| `agent_register` | the registered remote agent belongs to whoever registered it, exactly like `agent_create` |
| `a2a_task_get`/`a2a_task_cancel`/`a2a_push_config_set` | all resolve `jobId` through the same visibility check as `job_get`/`job_cancel` — naming another owner's job is refused, not just routed to a different (and possibly missing) remote task |
| `events_query`/`trace_get` | a non-admin must scope these to a `jobId`, `agentId` or `runId` they can see; there is no unscoped view of every owner's event history |
| `approval_list`/`approval_resolve` | approvals carry no owner column of their own — resolved through the run they gate, the same way as `events_query` — so a non-admin sees and can only resolve gates on a run they can see; naming another owner's `approvalId` reads as `NOT_FOUND` |
| `message_send`/`message_list` | a `toAgentId`/`toJobId` (or `agentId`/`jobId` to read) must already be visible to the caller — messages carry no owner column either, so an agent's inbox and a job's steering channel are only as private as the visibility check on the agent or job itself; a `toChannel`/`channel` is deliberately shared team space and stays open to everyone. The same check applies to the internal toolkit's `message_send` a running agent calls on itself, since `toAgentId` there is model-supplied and gets no more trust than any other tool argument |
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
Point `ORCH_DB_URL` at a `postgres://` URL to run several instances across hosts
against one database instead.

### Reaching it from a hosted client (ChatGPT, or any client that is not on this host)

`ORCH_HTTP_HOST=0.0.0.0` alone does **not** make the server reachable from a
hosted MCP client. `httpHost` is only the bind *address*; a real client — behind
a reverse proxy terminating TLS in front of this process, which is how you'd
expose it — sends its own public hostname in the Host header (and browsers send
Origin), and that string has nothing to do with the bind address. Without
naming it, the DNS-rebinding guard rejects every such request with a bare 403
before OAuth, routing, or any tool ever runs:

```bash
ORCH_HTTP_HOST=0.0.0.0
ORCH_HTTP_ALLOWED_HOSTS=orchestrator.example.com   # comma-separated for more than one
```

This is additive — loopback names keep working regardless — and it is an
allowlist, not a switch that disables the check: a Host or Origin that is not
named here is still rejected. `tests/integration/http-remote-host.test.ts`
covers both the default (still closed) and the configured (now reachable) case
against the real HTTP server.

Before exposing it beyond localhost, also set `ORCH_OAUTH_ISSUER_URL` — tools that change
what the orchestrator may do (`budget_set`, `toolserver_*`, `agent_publish`, and
attaching `toolGrants` to an agent) then require the `orch:admin` scope. Without
OAuth configured there is no caller identity and every tool is open, which is the
right default for a loopback server and the wrong one for a shared host.

## Development

```bash
pnpm test        # 475 tests, no network, no model calls
pnpm test:live   # opt-in: needs RUN_LIVE_TESTS=1 and a real ANTHROPIC_API_KEY

# The 10 Postgres tests skip unless pointed at a database (docker compose up -d db):
TEST_POSTGRES_URL=postgres://orch:orch@127.0.0.1:5432/orch pnpm test   # 485
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
- **The Postgres backend is new.** Its migrations, both dialect branches and the
  atomicity guarantees are proven against a live server by
  `tests/integration/postgres-db.test.ts`, but it has nothing like SQLite's
  mileage here. SQLite remains the default and the better-worn path for a single
  host; see [Storage](#storage) below.
- **A `maxConcurrent` budget can still overshoot by one.** It is counted in the
  database, so it is a deployment-wide cap rather than a per-instance one, but
  the count is read just before the claim rather than reserved with it — two
  instances checking at the same moment can both pass. Overshoot is bounded by
  one, not by the number of instances.
- **`job_cancel` is not instant across instances.** Only the process running a
  job holds the handle that stops it, so a cancel served elsewhere is recorded
  and acted on within a heartbeat (15s by default). The call returns the job
  still `running`; poll `job_get`.
- **Multi-user isolation is partial — do not treat it as a tenancy boundary yet.**
  See [Ownership](#ownership) below for exactly what is and is not separated.
- **Human-in-the-loop only covers a paused workflow step today.** `approval_list`
  / `approval_resolve` and the `awaiting_approval` gate work; a downstream tool
  marked `requireApprovalFor` fails the call outright instead of pausing for a
  human, an unverified remote agent card is only ever allowed or blocked by
  `A2A_TRUST_MODE` (never gated through an approval), and an A2A task that
  reports `input-required` fails the job immediately rather than waiting for
  someone to answer it — there is no way yet to feed a remote task more input
  mid-run.
