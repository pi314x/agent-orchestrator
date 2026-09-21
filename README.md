# Agent Orchestrator

An MCP server that delegates work to sub-agents. **MCP inward** — your client (Claude
Code, Claude Desktop, any MCP client) talks to it over stdio or Streamable HTTP.
**A2A outward, optionally** — it can call agents built by other people on other
frameworks, and that half is off by default.

Agents can be rows in its database, or Markdown files in your repo. Nothing here
requires an external vendor beyond the model you point a runner at.

- [Quickstart](#quickstart) — install, start over stdio or HTTP, connect a client
- [Tools](#tools) — the full catalog by profile, plus resources and prompts
- [Examples](#examples) — delegate, fan-out, workflows with approvals, sharing
- [The twenty-one built-in roles](#the-twenty-one-built-in-roles) — planner to marketer
- [What an agent can actually do](#what-an-agent-can-actually-do) — toolkit vs granted tools
- [Agents as Markdown](#agents-as-markdown) — repo files as the source of truth
- [Runners](#runners) — OpenAI-compatible, Anthropic, CLI, mock, sampling; no model of its own
- [A2A is off by default](#a2a-is-off-by-default) — outbound and inbound interop
- [Storage](#storage) — SQLite or Postgres, shared-database concurrency
- [Ownership](#ownership) — per-user isolation, admin sharing, peer sharing
- [Configuration](#configuration) — env vars, hosted clients, Entra ID
- [Dashboard](#dashboard) — read-only live view over HTTP and MCP
- [Post-quantum crypto](#post-quantum-crypto) — NIST ML-KEM/ML-DSA where it applies
- [Development](#development) — tests, typecheck, lint, build
- [Known limitations](#known-limitations) — what is genuinely not proven yet

## Quickstart

```bash
pnpm install
cp .env.example .env        # set OPENAI_API_KEY, or ANTHROPIC_API_KEY + ORCH_DEFAULT_RUNNER=anthropic
pnpm build
```

Then start it — dev runs from source with auto-reload, prod runs the build.
The commands work on any shell (no Unix-only `VAR=value` prefixes):

```bash
pnpm dev        # dev, MCP over stdio with tsx watch
pnpm dev:http   # dev, MCP over Streamable HTTP with tsx watch
pnpm dev:a2a    # dev, with the A2A interop surface on A2A_HTTP_PORT

pnpm build      # compile to dist/ — required once before any start: command
pnpm start        # prod, compiled server; transport comes from .env
pnpm start:http   # prod, compiled server over Streamable HTTP
```

`pnpm start` (see `package.json`) is a thin wrapper around
`node --env-file=.env dist/index.js` — useful once something else
(a process manager, an MCP client, systemd) launches it directly.
`--env-file` is required there too: nothing else in this project reads
`.env`, so without it the process only sees variables already in its
environment. The explicit `:http` commands override whatever
`ORCH_TRANSPORT` is set to in `.env`. On Windows, `dev.cmd`, `dev-http.cmd`,
`start.cmd` and `start-http.cmd` in the repo root do the same (double-clickable;
the `start` ones build first).

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
pnpm start:http &    # or: pnpm dev:http for source with auto-reload
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

Other hosts connect over the same transports: ready-to-copy configs for
Claude Desktop, VS Code, Gemini CLI, Qwen Code, Codex, Cursor, Windsurf, Zed,
Continue, Roo Code, Cline, openCode and the Pi coding agent live in
[`connectors/`](connectors/README.md).

## Tools

`ORCH_TOOL_PROFILE` controls how many tools are exposed: `core` (11), `standard`
(37, the default), `full` (71) — with A2A off, which it is by default. Profiles
are cumulative, and turning on `A2A_ENABLED=true` adds the interop tools to
whichever profile is active except `core` (none of its tools require A2A):
`standard` grows to 41, `full` to 80. A smaller profile means better tool
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
| `workflow_run_control` | standard | `pause` / `resume` / `cancel` / `retry_step` / `reconcile` |
| `workflow_export` | standard | Render a run into a markdown artifact for archiving or sharing |
| `workflow_delete` | full | Remove a definition (past runs unaffected) |
| `workflow_run_list` | full | List runs, filtered by workflow or state |
| `workflow_share` / `workflow_unshare` / `workflow_share_list` / `workflow_share_accept` / `workflow_share_reject` / `workflow_share_incoming` | full | Peer-share one definition with one named user (runs stay private); shares start pending until accepted |

**Agents**

| Tool | Profile | Use |
|---|---|---|
| `agent_template_list` | core | List built-in role templates |
| `agent_create` | standard | Define a persistent local agent (enabled unless asked otherwise) |
| `agent_list` / `agent_get` | standard | List / fetch agents, local and remote together, with an enabled flag |
| `agent_register` * | standard | Register a remote A2A agent from its Agent Card |
| `agent_publish` * | standard | Expose a local agent or template on this orchestrator's own Agent Card |
| `agent_update` / `agent_delete` | full | Change (incl. the enabled kill switch) or remove a local agent |
| `agent_template_save` | full | Add or overwrite a role template (admin) |
| `agent_share` / `agent_unshare` / `agent_share_list` / `agent_share_accept` / `agent_share_reject` / `agent_share_incoming` | full | Peer-share one agent with one named user; shares start pending until accepted |
| `grant_preset_save` / `grant_preset_list` | full / standard | Admin-curated tool-grant bundles; name one in `agent_create` instead of hand-writing grants |

### Agent limits

`agent_create` / `agent_update` accept `limits: { maxSteps, timeoutSec, maxCostUsd }`,
frozen into each job's snapshot at submit time: `maxSteps` bounds that job's agent
loop (runner defaults apply otherwise), a submit without its own `timeoutSec`
inherits the agent's, and `maxCostUsd` stops work with `BUDGET_EXCEEDED` like any
other cap — visible in `approval_list` as a `budget` notice. Any job timeout is
capped at 7 days; larger values are rejected outright, since past ~24.8 days the
underlying timer would wrap and fire after 1ms. Idempotency keys are per-owner:
re-submitting yours returns your job, and another owner's key never resolves to
their row.

**Memory** — a namespaced JSON blackboard, shared by every agent

| Tool | Profile | Use |
|---|---|---|
| `memory_write` / `memory_read` / `memory_search` | standard | Write, read, full-text search |
| `memory_delete` | full | Delete a key, a prefix, or a whole namespace |
| `memory_share` / `memory_unshare` / `memory_share_list` / `memory_share_accept` / `memory_share_reject` / `memory_share_incoming` | full | Peer-share a namespace with one named user; shares start pending until accepted |

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
| `approval_list` / `approval_resolve` | core | List and resolve gates: workflow approvals, mid-loop `request_approval`, remote input waits, and refusal notices (budget caps, unverified cards) |

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
| `maintenance_prune` | full | Delete finished history older than a cutoff, or dry-run it (admin) |

**Schedules** — cron-triggered work, checked every `ORCH_SCHEDULE_TICK_SEC`

| Tool | Profile | Use |
|---|---|---|
| `schedule_create` | full | Run an instruction on a cron expression (UTC or named zone); each firing submits one of your jobs |
| `schedule_list` | standard | List schedules with next run times |
| `schedule_preview` | standard | Show next fire times for an expression or schedule, storing nothing |
| `schedule_update` | full | Pause, retune or rewrite a schedule without deleting it |
| `schedule_delete` | full | Remove a schedule (already-fired jobs run on) |

**Completion callbacks** — at-most-once POSTs on settle, admin-managed

| Tool | Profile | Use |
|---|---|---|
| `webhook_register` | full | POST a JSON body to a URL when your jobs or runs settle (admin) |
| `webhook_list` | full | List callbacks and their subscribed settle events (admin) |
| `webhook_remove` | full | Unregister a callback (admin) |

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
`artifact`, `memory`, `templates`, `dashboard`, plus `a2a/card` when A2A is on)
mirror this same state for a host that prefers pulling context over calling tools
— see [Ownership](#ownership) for how they're scoped. Thirteen built-in prompts
(`orchestrate`, `build_feature`, `research_team`, `code_review_swarm`,
`cross_vendor_review`, `postmortem_run`, `task_classify`, `security_audit`,
`perf_check`, `debug_workflow`, `a11y_audit`, `compliance_check`, `dashboard`)
chain these tools into a starting point for a common task; the host still drives
every actual tool call.

## Examples

More flows live in [`EXAMPLES.md`](EXAMPLES.md) — fan-out, approvals,
reconcile, audits, agent sharing, run export and downstream tool grants.

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

## The twenty-one built-in roles

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
| `architect` | Designs system structure, interfaces and tradeoffs |
| `debugger` | Finds root causes from symptoms, traces and logs |
| `security-engineer` | Assesses vulnerabilities, auth risk and secret handling |
| `performance-engineer` | Profiles bottlenecks and proposes measured optimizations |
| `api-designer` | Designs endpoints, contracts and error shapes |
| `devops-engineer` | Builds CI, containers and reproducible operations |
| `data-engineer` | Designs schemas, migrations and data pipelines |
| `technical-writer` | Writes docs and API references with examples |
| `release-manager` | Plans releases, notes and safe rollouts |
| `refactor` | Restructures code without changing behaviour |
| `accessibility-specialist` | Reviews WCAG, ARIA and keyboard behaviour |
| `compliance-reviewer` | Reviews privacy, licensing and regulatory risk |
| `marketer` | Writes positioning, landing copy and launch messaging |

`agent_create` makes a named agent of your own; `agent_template_list` shows the
roles currently available, custom ones included.

## What an agent can actually do

Two sources, and the `cli` runner is neither of them — that is *how* an agent
runs, not what it can call.

**The built-in toolkit.** Every local agent gets these inside its own loop, with
no configuration: `report_progress`, `finish`, `memory_write` / `memory_read` /
`memory_search`, `artifact_put` / `artifact_get`, `message_send` /
`message_list`, `spawn_job`, `request_approval` (pause for a human decision)
and `web_fetch` (public HTTPS as text, SSRF-guarded). They are internal —
never exposed over MCP, and a remote A2A agent never sees them.

**Granted downstream MCP tools.** Register a server with `toolserver_register`,
then grant an agent access through `toolGrants` — `"files"` for everything that
server offers, `"files/read_file"` for a single tool. They arrive in the agent's
loop namespaced `files__read_file`. A deny-list beats an allow-list, an empty
allow-list means everything that server offers, and attaching grants to an agent
requires the `orch:admin` scope once OAuth is configured. Calls carry the job's
abort signal under a 5-minute ceiling, so a hung server fails the call (retried
as transient) instead of wedging the worker, and `job_cancel` still lands.

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

Agents synced from these files start **disabled**: nothing shipped runs until
an operator switches it on (dashboard Agents tab, or `agent_update`
`{ enabled: true }`). Re-syncing file edits never rewrites an explicit
enable, so the choice survives restarts. Agents made through `agent_create`
start enabled instead. Either way a disabled agent stays listed and readable
— it just refuses new work with `POLICY_DENIED`, while jobs already running
keep going.

## Runners

| Runner | Notes |
|---|---|
| `openai-compatible` | **Default.** OpenAI, OpenRouter, Ollama, vLLM, LM Studio — `OPENAI_BASE_URL` is the only difference; default model `gpt-5.6-terra` against `api.openai.com`, omitted elsewhere |
| `anthropic` | Claude models, streaming with tool use; default model `sonnet-5` |
| `cli` | Spawns a headless coding-agent CLI (`claude`, `codex`, …) under **your own login**, confined to `ORCH_CLI_WORKSPACE_DIRS` |
| `mock` | Deterministic, for tests and CI |
| `sampling` | Borrows the connected client's model — legacy (pre-`2026-07-28`) clients only, `delegate` with `wait`, never background |

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

MCP's *sampling* (`sampling/createMessage`) is a third way to do this, with the
client answering each model call — and it works, within narrow bounds. It is
deprecated as of protocol revision `2026-07-28` (SEP-2577), and the SDK throws
on modern-era requests, so only legacy (pre-`2026-07-28`) clients can lend
their model at all. And borrowing needs the live request while the scheduler
executes detached from it, so `sampling` runs **inline, never queued**:
`delegate { ..., runner: "sampling" }` with `wait` (the default) runs the
agent loop against the connected client right inside the call, bounded by its
`timeoutSec`. `job_submit`, background waits, workflows and fan-out cannot use
it — the borrowed model only exists while that request is open. Like `cli`,
only wall-clock duration is recorded, so `maxTokens` and `maxCostUsd` budgets
do not bind borrowed runs. The inline run still checks both concurrency caps
before starting, so it cannot overshoot a pool or agent limit the pump would
have enforced. Prefer a base URL or the `cli` runner wherever
either is available; sampling exists for the legacy client with no other
model to point at.

```
delegate { instruction: "Summarize this incident report in 3 bullets.",
           template: "summarizer", runner: "sampling" }
```

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
| Agents | listed, fetched, updated and deleted only by their owner; only enabled agents run new jobs (`POLICY_DENIED` otherwise), while visibility is unaffected |
| Jobs | listed, fetched, cancelled and retried only by their owner |
| Artifacts | read, listed and deleted only by their owner — including `artifact_get` inside a running agent's own toolkit, so an artifactId the model picks up from anywhere cannot reach another owner's content |
| Memory | `namespace`/`key` uniqueness is per owner, so two users can both use `"notes"`; reads, writes, deletes and full-text search are all scoped |
| Workflow jobs | a workflow's spawned jobs belong to whoever started it, so `job_list` finds them like any other job |
| Inbound A2A task jobs | belong to whoever owns the published agent handling the delegation — the same "belongs to whoever owns the agent doing the work" rule as a spawned job, so the agent's real owner can `job_get`/`job_wait`/`job_cancel` it too, not only an admin |
| Workflow definitions | listed, fetched and deleted only by their owner; names are unique per owner, so two users can each define `"deploy"`. `workflow_share` grants one named user read/start access — the grantee starts their own runs, but cannot modify, delete or re-share the definition |
| Workflow runs | listed, fetched and controlled (`pause`/`resume`/`cancel`/`retry_step`/`reconcile`) only by their owner — never shared, even when the definition is; `workflow_start`'s `workflowId` resolves only a workflow the caller can see, and `idempotencyKey` is scoped per owner so two users choosing the same key never collide |
| Schedules | created, listed and deleted only by their owner; names are unique per owner; fired jobs belong to the schedule owner like workflow-spawned jobs belong to the run starter |
| `delegate`/`fan_out`/`consensus` by `agentId` or `skillQuery` | resolve only enabled agents the caller can see — never another owner's private agent, even by naming its id directly, and never a disabled one |
| `job_wait` | can only be pointed at jobs the caller already owns or can see — naming another owner's jobId is refused before any waiting starts, not just filtered out of the result |
| `job_submit`'s `dependsOn` | every id named must already be visible to the caller — otherwise a job blocked on another owner's private job would leak that job's existence, exact state and the timing of its state changes through the dependent's own `job.blocked` event and auto-release, without ever calling `job_get` |
| `agent_register` | the registered remote agent belongs to whoever registered it, exactly like `agent_create` |
| `a2a_task_get`/`a2a_task_cancel`/`a2a_push_config_set` | all resolve `jobId` through the same visibility check as `job_get`/`job_cancel` — naming another owner's job is refused, not just routed to a different (and possibly missing) remote task |
| `events_query`/`trace_get` | a non-admin must scope these to a `jobId`, `agentId` or `runId` they can see; there is no unscoped view of every owner's event history |
| `approval_list`/`approval_resolve` | approvals carry no owner column of their own — resolved through the run or job they gate, the same way as `events_query` — so a non-admin sees and can only resolve gates on a run or job they can see; naming another owner's `approvalId` reads as `NOT_FOUND` |
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
agentId, granteeId }`, `memory_share { namespace, granteeId }` and
`workflow_share { workflowId, granteeId }` grant one named other user access
to exactly that one resource — but the share starts `pending` and confers
nothing until the grantee accepts it (`agent_share_accept` /
`memory_share_accept` / `workflow_share_accept`; decline with `*_reject`,
list incoming with `*_incoming`). `agent_unshare`/`memory_unshare`/
`workflow_unshare` revoke a pending or accepted share, and
`agent_share_list`/`memory_share_list`/`workflow_share_list` show current
grantees with per-grantee `pending`/`accepted` status. Only the resource's
own owner (or an admin) may share or revoke it.

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
| Channels | `toChannel`/`channel` messaging is deliberately shared team space |
| Events (unscoped) | a non-admin can only query events tied to a specific job/agent/run they can see (above); there is no per-owner view of the *whole* log, only the admin one |

Direct (`toAgentId`/`toJobId`) messaging and the approval queue are scoped
through the agent/job/run they belong to, per the table above — they are not
in this list. The one deliberate exception is `control(runId, 'resume')` from
an approval resolution: a reviewer resuming a run they don't own is the point
of the gate, not a bypass of it.

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

### CORS for browser clients

Browsers refuse cross-origin reads without CORS headers, so the server answers
every origin by default (`Access-Control-Allow-Origin: *`, preflight included)
— right for a local-first tool whose first client runs on the same machine.
Narrow it when exposing beyond localhost:

```bash
ORCH_CORS_ALLOWED_ORIGINS=https://app.example.com,https://ops.example.com
```

Named origins also pass the Origin guard, so the two layers agree; anything
unnamed gets no CORS headers and is still rejected first. With the default
allow-all there is no per-origin protection at all — any website can call the
server — so combine it with OAuth (the dashboard then asks for a bearer token)
or keep it on loopback.

### Microsoft Entra ID as the issuer

Entra works as a plain OIDC issuer with three Entra-specific mappings:

```bash
ORCH_OAUTH_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
ORCH_OAUTH_RESOURCE_URL=https://orchestrator.example.com/mcp   # must match the app's audience
ORCH_ADMIN_ROLES=Orchestrator.Admin
```

Use the **tenant-specific** v2.0 URL — never `common`, which accepts any
tenant's tokens. Signing keys resolve by standard OIDC discovery. Each
caller's owner id is their stable `oid` (not the per-app `sub`), so sharing
by `orchestrator_status` caller id works across client apps; `scp` merges
with `scope`. Entra never mints `orch:admin` itself, so create an app role
(e.g. `Orchestrator.Admin`), assign the operators who need it, and name the
value in `ORCH_ADMIN_ROLES` (matched exactly, never lowercased).

## Dashboard

With `ORCH_TRANSPORT=http`, the server also serves a dashboard that acts on
the same state the tools expose:

- `http://127.0.0.1:3333/dashboard` — the nine tabs (agents, jobs,
  delegations, workflows, approvals, schedules, memory & artifacts, tools,
  observability), with working buttons: delegate, cancel, retry, steer,
  approve, share, prune and the rest. Agents show a green/grey
  enabled/disabled pill with an Enable/Disable toggle each; the
  delegations tab draws agent → job and parent → child edges as a graph
  plus copyable Mermaid `flowchart TD` source; the tools tab lists
  downstream MCP servers — click one to expand its tools with approval
  tags — and registers or removes servers through a dialog. Every action runs through a
  structured dialog (no native prompts): the workflow tab draws definitions
  as a draggable DAG — drag nodes to arrange, click to edit in the
  inspector, Connect mode (or an out-port click) to chain dependencies,
  click an edge to remove it — and the share dialogs list current grantees
  with `pending`/`accepted` status plus an inbox for accepting incoming
  shares.
- `http://127.0.0.1:3333/dashboard.json` — the same data as JSON, plus whether
  the API needs a token.
- `orch://dashboard` — the same collector as an MCP resource, scoped to the
  caller's own principal (works over stdio too).

Buttons call a JSON API under `/api/` (agents, jobs, runs, approvals,
schedules, memory, artifacts, budgets and more), which enforces the same
owner scoping as the matching MCP tools — visibility is checked first, then
the action runs. Destructive calls carry their own explicit confirmation
instead of a two-step prompt. With OAuth configured the browser sends
`Authorization: Bearer` (the page asks for the token once and keeps it in
session storage, never in a cookie); without OAuth everything is open, the
same posture as the tools on a loopback server.

## Post-quantum crypto

Classical-only unless configured — `orchestrator_status` reports the real
posture under `pqc`, so there is no guessing. When configured, the
primitives are NIST FIPS 203 (ML-KEM-768) and FIPS 204 (ML-DSA-65) via
`@noble/post-quantum`, with a hybrid `X25519+ML-KEM-768` envelope for data:

```bash
# At-rest encryption for artifact content + memory values (sealed envelopes;
# plaintext rows written before the key keep working, no migration):
ORCH_PQC_DATA_KEY=<base64 data-key bundle>

# PQC signature on the Agent Card we publish (classical verifiers skip it):
ORCH_PQC_SIGNING_KEY=<base64 ML-DSA-65 secret key>
ORCH_PQC_SIGNING_KID=pqc-1
```

Generate both with `pnpm build` first, then (keep them like any other secret —
losing the data key means sealed rows can never be read back):

```bash
# Data-key bundle for ORCH_PQC_DATA_KEY (base64 of a JSON key bundle):
node --input-type=module -e "import('./dist/core/pqc.js').then(m => console.log(Buffer.from(JSON.stringify(m.generateDataKey())).toString('base64')))"

# ML-DSA-65 secret key for ORCH_PQC_SIGNING_KEY (base64 of 4032 raw bytes):
node --input-type=module -e "import('./dist/core/pqc.js').then(m => console.log(Buffer.from(m.generateSigningKeypair().secretKey).toString('base64')))"
```

Inbound, `verifyCard` checks
classical JWS first and ML-DSA-65 entries second — a PQC-only card verifies
as `verified` with its alg on record — and bearer JWTs with
`alg: 'ML-DSA-65'` verify against the issuer JWKS with the same
`iss`/`aud`/`exp` checks as classical tokens. Keys for card signatures
resolve from the signature's `jku` through the same HTTPS/SSRF checks as
classical keys. Tags, names and namespaces stay plaintext (listings and
grants filter on them); content search over sealed values matches nothing
by design. TLS is the stated boundary: PQC on the wire arrives with the
platform's TLS stack, not this server. See [`PLAN.md`](PLAN.md) §11.

## Development

```bash
pnpm test        # unit + integration: mock runner, fixture A2A agent — no network, no model calls
pnpm test:live   # opt-in: needs RUN_LIVE_TESTS=1 and a real ANTHROPIC_API_KEY

# The Postgres tests skip unless pointed at a database (docker compose up -d db):
TEST_POSTGRES_URL=postgres://orch:orch@127.0.0.1:5432/orch pnpm test
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
host; see [Storage](#storage) above.
- **`job_cancel` is fast across instances, but still not instant.** Only the process running a
  job holds the handle that stops it, so a cancel served elsewhere is recorded and the owner
  picks it up on its dedicated poll (every `ORCH_CANCEL_POLL_SEC`, 2 seconds by default —
  deliberately separate from the slower lease heartbeat, which must stay slow or reclaims would
  run work twice). The call returns the job still `running`; poll `job_get` for the final state.
  Writing `cancelled` onto the row from another instance would be a lie: the agent would keep
  working and keep spending, then overwrite the row with its own result.
- **Multi-user isolation is partial — do not treat it as a tenancy boundary yet.**
  See [Ownership](#ownership) above for exactly what is and is not separated. What is separated
  is enforced in the stores (agents, jobs, artifacts, memory, workflows, runs, schedules,
  approvals, direct messages — every one owner-checked, including the agent-side toolkit, and
  every caller-supplied id resolved through a visibility check). What stays shared is
  deliberate: channels are team space, and templates, tool servers, cached Agent Cards,
  published skills, budgets and grant presets are operator configuration behind `orch:admin`.
  There is no per-owner version of any of those, no user directory (sharing needs the raw
  owner id), and the queue-depth counts in `orchestrator_status` are deployment-wide. Safe for
  separating colleagues' work on a shared team instance, where everyone is trusted and the
  point is not tripping over each other.
- **Refusal notices resolve to nothing.** A `budget` or `unverified_card`
  approval records that the orchestrator refused something on its own;
  resolving one only acknowledges it. Caps still change exclusively through
  `budget_set`, trust exclusively through re-registration or
  `A2A_TRUST_MODE`.
- **A mid-loop approval wait holds its job's concurrency slot.**
  `request_approval` (and a gated downstream call, and a remote task waiting
  for input) suspend one job, not the pool — but with `ORCH_MAX_CONCURRENCY=4`
  and four jobs waiting on humans, nothing else runs. The job's own
  `timeoutSec` still bounds the wait.

