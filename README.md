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
pnpm test        # 274 tests, no network, no model calls
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
- **A2A is outbound only.** Calling other people's agents works and is unit-tested
  against a stubbed client, but has never met a real third-party agent. The *inbound*
  half — serving our own Agent Card so others can call us — is written
  (`src/a2a/server.ts`) and never started: nothing calls `createA2AServer`, so
  `A2A_HTTP_PORT` only composes a URL. `agent_publish` records the opt-in and
  `a2a_server_info` reports `serving: false`. Wiring up the listener is unfinished
  work, not a configuration step.
- **SQLite only.** The Postgres adapter in PLAN.md §13 is not built; every store
  uses better-sqlite3's synchronous API, so adding one is an async refactor rather
  than a drop-in.
- **Single process.** Job state lives in one SQLite file with one scheduler. Two
  processes against the same database will fight over queued jobs.
