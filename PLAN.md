# Agent Orchestrator — Plan (MCP inward + A2A outward)

Status: Draft v0.2 · Protocols: MCP `2026-07-28` (inward) · A2A `v1.0` (outward + inward) · Stack: TypeScript, `@modelcontextprotocol/server` v2, A2A JS SDK, Zod v4
Companion file: `AGENTS.md` (rules for anyone — human or AI — writing code in this repo)

---

## 1. Goal

An orchestrator that coordinates a team of agents and can talk to **agents built by other vendors, on other frameworks, hosted elsewhere** — not just agents it owns. Three doors in and out:

- **MCP (inward):** Claude Code, Claude Desktop, IDEs and other MCP hosts drive the orchestrator through tools.
- **A2A (outward, as a client):** the orchestrator discovers, verifies, and delegates to independent remote agents via their Agent Cards, regardless of what they're built with.
- **A2A (inward, as a server):** the orchestrator can publish its own agents as an Agent Card, so other vendors' agents/orchestrators can discover and delegate work *to us*.

Local agents (ones we own, prompt and grant tools to) and remote agents (opaque, reached over A2A) are exposed through the **same** `delegate` / `job_*` tools, so a caller doesn't need to know or care which backend actually ran the work.

Non-goals for v1: hosted multi-tenant SaaS, model training, a general chat UI (an optional dashboard comes later).

---

## 2. Design decisions driven by the specs

### MCP `2026-07-28`

| Spec change | Consequence for this server |
|---|---|
| No `initialize` handshake, no `Mcp-Session-Id` | All state lives in the orchestrator's DB and is addressed by explicit handles (`agentId`, `jobId`, `runId`) passed as tool arguments. Any instance can serve any request. |
| MRTR replaces server→client elicitation/sampling/roots | Used directly by one tool today: `workflow_run_control`'s cancel confirmation returns `resultType: "input_required"` and the client retries with `inputResponses`. A paused `workflow_step` approval gate is different — it never surfaces as MRTR at all, only as a DB row a caller discovers by polling `approval_list` / resolves with `approval_resolve`; there is no in-protocol signal to fall back from. A2A's `input-required` task state does not surface here either — nothing maps an inbound task into that state yet. |
| Sampling, Roots, Logging deprecated | Local sub-agents call provider APIs/CLIs directly. Observability via our own `events_query` / `trace_get`. |
| Tasks moved to extension `io.modelcontextprotocol/tasks` | Long-running tools are task-capable when negotiated; otherwise return a handle and the client uses `job_wait`. |
| List results cacheable (`ttlMs`, `cacheScope`) | Tool catalog is static per profile and deterministically ordered. |

### A2A `v1.0`

| A2A concept | Consequence for this server |
|---|---|
| Agent Card (JSON descriptor, e.g. at `/.well-known/agent-card.json`) lists skills, capabilities, security schemes | `agent_register` stores a remote agent's Card; `delegate`/`fan_out` route by matching requested skills against `card.skills[]`. `agent_publish` builds *our* Card from opted-in local agents/templates. |
| Task lifecycle (`submitted → working → input-required → completed / failed / canceled`), stable across JSON-RPC/gRPC/REST bindings | Job entity gets `backend: 'local' \| 'a2a_remote'`; A2A task states map directly onto our Job state machine (see §4). `input-required` drives the same MRTR/approval path as local jobs. |
| Agent Card Signature Verification | `agent_register` verifies signatures per `A2A_TRUST_MODE`; every surface that shows a remote agent also shows its `trustLevel` (`verified` / `unverified`). Never silently upgraded. |
| Push notification config (webhook for task updates) | Long remote jobs register a push callback where the remote agent supports it; otherwise we poll `a2a_task_get`. |
| Standard error object (`google.rpc.Status`) | Translated into our own error codes (§`src/errors.ts`) so callers see one consistent shape regardless of backend. |
| Extension mechanism (spec §4.6) | Vendor-specific capabilities (streaming, extra part types) are opt-in extensions, never assumed. |
| Multi-tenancy / execution-mode control | Per-remote-agent scoping in `budget_set` and `a2a_agent`-level credentials — never a single shared credential across registrations. |

---

## 3. Architecture

```
        MCP clients                        External A2A agents / orchestrators
 (Claude Code, Desktop, IDEs)                 (other vendors, other frameworks)
         │ MCP (stdio / HTTP)                          │ A2A (JSON-RPC/REST, HTTPS)
 ┌───────▼─────────────────────┐          ┌────────────▼─────────────────────┐
 │ MCP layer (inward)          │          │ A2A server (inward)              │
 │  tools · resources · prompts│          │  publishes our Agent Card,       │
 │  MRTR · Tasks extension     │          │  serves tasks for agents marked  │
 │                              │          │  exposed via agent_publish       │
 └───────────────┬──────────────┘          └────────────────┬──────────────────┘
                 │                                           │
                 ▼                                           ▼
        ┌───────────────────────────────────────────────────────────────┐
        │ Core services (pure TS — no MCP or A2A SDK imports)            │
        │   AgentRegistry   JobScheduler    WorkflowEngine (DAG)        │
        │   MessageBus      MemoryStore     ArtifactStore                │
        │   PolicyEngine (approvals, trust, depth)   BudgetTracker      │
        │   EventLog (append-only audit)                                 │
        └───────────────┬─────────────────────────────┬──────────────────┘
                         ▼                             ▼
        ┌──────────────────────────────┐   ┌──────────────────────────────────┐
        │ Local runners                 │   │ A2A gateway (outward, as client) │
        │   anthropic · openai · cli    │   │   card fetch + verify + cache    │
        │   · mock                      │   │   task create/get/cancel          │
        │                                │   │   push-notification receiver      │
        └───────────────┬────────────────┘   └───────────────┬────────────────────┘
                         ▼                                    ▼
        Downstream MCP proxy (tools granted to        Remote agents at other
        local agents only — see §5.10)                vendors/orgs (opaque)
                         │
                         ▼
              Storage: SQLite (WAL+FTS5) / Postgres, blobs
```

**`delegate` flow, local:** validate → policy/budget check → create ephemeral agent → run on a local runner → events to EventLog → result + artifacts stored → returned.

**`delegate` flow, remote:** validate → resolve target (`agentId` of a registered card, or skill query) → check `trustLevel` against `A2A_TRUST_MODE` → A2A gateway creates a task → poll or await push callback → map A2A task state onto Job state → result normalized into the same shape a local job would return.

Either path is invisible to the caller: `job_get` looks identical regardless of `backend`.

---

## 4. Domain model

Entities: `Agent` (`kind: 'local' | 'remote'`), `AgentCard` (cached remote cards + our own published card), `AgentTemplate`, `Job` (`backend: 'local' | 'a2a_remote'`), `Workflow`, `WorkflowRun`, `StepRun`, `Message`, `Channel`, `MemoryEntry`, `Artifact`, `Approval`, `ToolServer`, `Budget`, `Event`.

IDs are prefixed ULIDs: `agt_`, `crd_`, `tpl_`, `job_`, `wf_`, `wfr_`, `msg_`, `art_`, `apr_`, `ts_`, `evt_`, `sch_`.

Job state machine (shared by both backends):

```
          ┌──────── blocked (dependsOn unresolved)
          ▼
 queued ─► running ⇄ awaiting_input
                │
                ├─► succeeded
                ├─► failed ──(job_retry)──► queued
                ├─► cancelled
                └─► timed_out
```

A2A task states map onto this directly: `submitted→queued`, `working→running`, `input-required→awaiting_input`, `completed→succeeded`, `failed→failed`, `canceled→cancelled`, `rejected→failed` (code `REMOTE_REJECTED`).

A Job always records: agent/card snapshot at submit time, instruction, inputs, result, structured output, usage (tokens/cost/duration where the backend reports them — see §11 on remote budgets), parent job, depth, workflow step.

---

## 5. Tool catalog (89 tools)

Annotation legend: **RO** readOnlyHint · **D** destructiveHint · **I** idempotentHint · **OW** openWorldHint · **T** task-capable (MCP Tasks extension).
Profile legend: **C** core (11) · **S** standard (41, cumulative) · **F** full (89, cumulative).
Every tool returns `structuredContent` validated by an `outputSchema`, plus a 1–3 line text summary.

### 5.1 Agents — local & registered (16)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `agent_create` | Define a persistent **local** agent, enabled unless asked otherwise | name, role, instructions, runner, model, toolGrants[], grantPreset?, limits, enabled? | — | S |
| `agent_register` | Register a **remote** A2A agent from its Card | cardUrl or inline card, alias, credentialsRef | OW | S |
| `agent_list` | List agents (local + remote) | kind?, status?, cursor | RO | S |
| `agent_get` | Config/card, stats, recent jobs, trustLevel | agentId | RO | S |
| `agent_update` | Patch a local agent's config, incl. the `enabled` kill switch (future jobs only) | agentId, patch | I | F |
| `agent_delete` | Remove agent or unregister remote; with force cancels its jobs | agentId, force? | D (MRTR confirm) | F |
| `agent_share` | Grant one named user (peer-to-peer, not admin-wide) read/delegate access to your agent — starts pending until accepted | agentId, granteeId | I | F |
| `agent_unshare` | Revoke a peer share (pending or accepted) | agentId, granteeId | D | F |
| `agent_share_list` | List who a private agent is shared with, with pending/accepted status | agentId | RO | F |
| `agent_share_accept` | Accept a pending agent share addressed to you | agentId | I | F |
| `agent_share_reject` | Decline a pending agent share addressed to you | agentId | I | F |
| `agent_share_incoming` | List pending agent shares offered to you | — | RO | F |
| `agent_template_list` | Built-in and custom role templates | — | RO | C |
| `agent_template_save` | Create or overwrite a template | name, spec | I | F |
| `grant_preset_save` | Save a named tool-grant bundle (admin) | name, grants[] | I | F |
| `grant_preset_list` | List grant bundles for `agent_create grantPreset` | — | RO | S |

Built-in templates: `planner`, `researcher`, `coder`, `reviewer`, `tester`, `writer`, `critic`, `summarizer`, `architect`, `debugger`, `security-engineer`, `performance-engineer`, `api-designer`, `devops-engineer`, `data-engineer`, `technical-writer`, `release-manager`, `refactor`, `accessibility-specialist`, `compliance-reviewer`, `marketer`.

### 5.2 Jobs (7)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `job_submit` | Queue work for an agent (local or remote — same call) | agentId or template or skillQuery, instruction, context, dependsOn[], priority, timeoutSec, outputSchema?, requireApproval?, idempotencyKey?, runner? | T | C |
| `job_get` | Status, progress, result, usage — identical shape for both backends | jobId, include {transcript, events}? | RO | C |
| `job_list` | Filter jobs | status, agentId, backend?, workflowRunId, since, cursor | RO | S |
| `job_wait` | Wait until any/all jobs finish (≤ 60 s per call) | jobIds[], mode any/all, timeoutSec | RO | C |
| `job_cancel` | Cancel a job; for remote jobs this calls A2A task cancel underneath | jobId, reason | D | C |
| `job_retry` | Re-run a failed/cancelled job | jobId, overrides? | — | S |
| `job_steer` | Inject guidance into a running job's next turn (local: next agent turn; remote: only if the agent's card advertises steering) | jobId, message | — | S |

### 5.3 Delegation shortcuts (4)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `delegate` | One-shot: run an instruction on the best-matching local or remote agent, return the result. Most-used tool. | instruction, agentId? or skillQuery?, template?, model?, runner?, wait=true, timeoutSec, outputSchema?, idempotencyKey? | T, OW | C |
| `fan_out` | Same instruction over N items, in parallel, across local and/or remote agents, optional reduce step | instructionTemplate, items[], agentId? or skillQuery?, concurrency, reduce {instruction}? | T, OW | C |
| `consensus` | Ask N agents (mix of local/remote) the same question, aggregate by vote, judge or debate | question, participants[], strategy, rounds | T, OW | F |
| `plan_create` | Planner agent turns a goal into a draft workflow spec (not executed) | goal, constraints, allowedTemplates? | OW | S |

`skillQuery` matches against registered A2A Agent Card skills (id/tags/description) as well as local agent roles, so the same call can land on either backend.

### 5.4 Workflows (15)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `workflow_define` | Create and validate a DAG (cycle, template targets, file ownership) | name, inputsSchema, steps[{id, agentId or skillQuery or template, instruction, dependsOn, when?, retries, approval?, outputSchema?, files?}] | I | S |
| `workflow_list` | List workflows | cursor | RO | S |
| `workflow_get` | Full spec | workflowId | RO | S |
| `workflow_delete` | Remove definition (runs stay in history) | workflowId | D | F |
| `workflow_start` | Start a run | workflowId or inline spec, inputs, idempotencyKey? | T | S |
| `workflow_run_get` | Per-step state and outputs, incl. which backend ran each step | runId | RO | S |
| `workflow_run_list` | List runs | workflowId?, status?, cursor | RO | F |
| `workflow_run_control` | pause / resume / cancel / retry_step / reconcile | runId, action, stepId? | D (cancel) | S |
| `workflow_export` | Render a run into a markdown artifact for archiving/sharing | runId | RO | S |
| `workflow_share` | Grant one named user read/start access to a definition — starts pending until accepted | workflowId, granteeId | I | F |
| `workflow_unshare` | Revoke a peer share (pending or accepted) | workflowId, granteeId | D | F |
| `workflow_share_list` | List who a definition is shared with, with pending/accepted status | workflowId | RO | F |
| `workflow_share_accept` | Accept a pending workflow share addressed to you | workflowId | I | F |
| `workflow_share_reject` | Decline a pending workflow share addressed to you | workflowId | I | F |
| `workflow_share_incoming` | List pending workflow shares offered to you | — | RO | F |

### 5.5 Messaging (4)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `message_send` | Send to an agent, channel or running job (local agents and A2A agents whose card supports messaging) | to, body, replyTo? | — | F |
| `message_list` | Read inbox or channel | agentId or channel, since, unreadOnly | RO | F |
| `channel_create` | Topic channel for a team | name, members[] | I | F |
| `channel_list` | List channels | — | RO | F |

### 5.6 Shared memory / blackboard (10)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `memory_write` | JSON key-value with tags and TTL | namespace, key, value, tags, ttlSec | I | S |
| `memory_read` | Read one entry, or another user's shared namespace if granted | namespace, key, ownerId? | RO | S |
| `memory_search` | Full-text search (FTS5), or another user's shared namespace if granted | namespace?, query, tags, limit, ownerId? | RO | S |
| `memory_delete` | Delete key or prefix | namespace, key or prefix | D | F |
| `memory_share` | Grant one named user (peer-to-peer) read access to a namespace you own — starts pending until accepted | namespace, granteeId | I | F |
| `memory_unshare` | Revoke a peer share (pending or accepted) | namespace, granteeId | D | F |
| `memory_share_list` | List who a namespace is shared with, with pending/accepted status | namespace | RO | F |
| `memory_share_accept` | Accept a pending namespace share addressed to you | namespace, ownerId | I | F |
| `memory_share_reject` | Decline a pending namespace share addressed to you | namespace, ownerId | I | F |
| `memory_share_incoming` | List pending namespace shares offered to you | — | RO | F |

Memory is orchestrator-local. Remote agents never get direct memory access — only whatever is placed into their `context` at submit time.

### 5.7 Artifacts (4)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `artifact_put` | Store text, binary or file reference (content-hashed) | name, content or path, mimeType, jobId?, tags | — | S |
| `artifact_get` | Read, with offset/length for large items | artifactId, offset, length | RO | C |
| `artifact_list` | Filter artifacts | jobId?, workflowRunId?, tags | RO | S |
| `artifact_delete` | Delete | artifactId | D | F |

A2A file/data parts returned by a remote task are normalized into artifacts, same as local job output.

### 5.8 Human-in-the-loop (2)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `approval_list` | Pending approvals: paused `workflow_step` gates, mid-loop `request_approval` calls and gated downstream calls (`scope: 'job'`), remote tasks waiting for input (`scope: 'job'`, answer via `editedInput.message`), and refusal notices filed for visibility (`scope: 'budget'` on cap-hits, `scope: 'unverified_card'` on trust blocks — resolving one only acknowledges it) | status, scope | RO | C |
| `approval_resolve` | Approve, reject or edit | approvalId, decision, editedInput?, comment | — | C |

### 5.9 A2A interoperability (8)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `a2a_card_get` | Fetch and cache a remote agent's Agent Card without registering it | url | RO, OW | S |
| `a2a_card_verify` | Verify a cached card's signature; returns trustLevel | cardId or url | RO, OW | F |
| `a2a_discover` | Query a configured registry/catalog for agents matching a skill | query, tags | RO, OW | F |
| `a2a_task_get` | Raw underlying A2A task status (debug layer under `job_get`) | jobId | RO, OW | F |
| `a2a_task_cancel` | Low-level cancel (normally use `job_cancel`) | jobId, reason | D, OW | F |
| `a2a_push_config_set` | Register a webhook so a remote agent pushes task updates instead of us polling | jobId, callbackUrl | I, OW | F |
| `a2a_server_info` | Show the Agent Card *we* currently publish, and to whom | — | RO | S |
| `agent_publish` | Opt a local agent or template into our published Agent Card as an A2A skill | agentId or templateName, skillId, description, exposed=true/false | I | S |

Everyday use never needs this section — `agent_register` + `delegate`/`job_*` cover it. These tools exist for setup, debugging, and advanced control, mirroring how `toolserver_*` relates to `toolGrants`.

### 5.10 Downstream MCP tool servers — local agents only (4)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `toolserver_register` | Add an MCP server that **local** agents may use | name, transport {stdio command or http url}, authRef, allowTools[], denyTools[], requireApprovalFor[] | OW | F |
| `toolserver_list` | List registered servers + health | — | RO | F |
| `toolserver_tools` | Inspect a server's tools | name | RO, OW | F |
| `toolserver_remove` | Unregister | name | D | F |

Remote A2A agents are opaque and bring their own tools; this section never applies to them.

### 5.11 Observability & budgets (4)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `events_query` | Audit/event log across both backends | jobId?, agentId?, runId?, types[], since, limit | RO | S |
| `trace_get` | Span tree with timings, tokens/cost where known, incl. remote-call spans | jobId or runId | RO | S |
| `usage_report` | Usage grouped by agent/model/workflow; remote agents show call counts and any self-reported cost | groupBy, period | RO | S |
| `budget_set` | Hard caps — token/cost for local agents, call-count/time/max-concurrent for remote agents | scope, id?, maxCostUsd?, maxTokens?, maxCalls?, maxConcurrent? | I | F |

### 5.12 Admin (3)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `orchestrator_status` | Health, version, queue depth, active jobs, active profile, A2A server enabled? | — | RO | C |
| `runner_list` | Available local runners, models and their health | — | RO | S |
| `maintenance_prune` | Delete finished history older than a cutoff, or dry-run it (admin) | olderThanDays?, dryRun? | D | F |

### 5.13 Profile sizes

- **core (11):** `delegate`, `fan_out`, `job_submit`, `job_get`, `job_wait`, `job_cancel`, `agent_template_list`, `artifact_get`, `approval_list`, `approval_resolve`, `orchestrator_status`
- **standard (41):** core + agents (create/register/list/get) + jobs (list/retry/steer) + `plan_create` + workflows (define/list/get/start/run_get/run_control/export) + memory (write/read/search) + artifacts (put/list) + `a2a_card_get` + `a2a_server_info` + `agent_publish` + observability (events/trace/usage) + `runner_list` + `grant_preset_list` + `schedule_list`
- **full (89):** everything, incl. destructive/admin tools, messaging, `consensus`, `toolserver_*`, `budget_set`, the remaining `a2a_*` debug tools (`card_verify`, `discover`, `task_get`, `task_cancel`, `push_config_set`), peer-to-peer sharing (`agent_share`/`agent_unshare`/`agent_share_list`/`agent_share_accept`/`agent_share_reject`/`agent_share_incoming`, `memory_share`/`memory_unshare`/`memory_share_list`/`memory_share_accept`/`memory_share_reject`/`memory_share_incoming`, `workflow_share`/`workflow_unshare`/`workflow_share_list`/`workflow_share_accept`/`workflow_share_reject`/`workflow_share_incoming`), grant presets (`grant_preset_save`), schedules (`schedule_create`/`schedule_update`/`schedule_delete`), completion callbacks (`webhook_register`/`webhook_list`/`webhook_remove`) and `maintenance_prune`

Peer shares start `pending` and confer no visibility until the grantee accepts them with `*_share_accept` (decline with `*_share_reject`, list incoming with `*_share_incoming`). The owner sees `pending` in `*_share_list` until then, and may revoke a pending share with `*_unshare` the same as an accepted one.

Rationale: large tool lists degrade model tool selection — MCP's own roadmap flags this and is working on progressive discovery. Default to `standard`; select via `ORCH_TOOL_PROFILE`.

### 5.14 Agent-side toolkit (internal — not exposed over MCP or A2A)

Tools **local** sub-agents get inside the runner loop: `report_progress`, `finish` (validated against outputSchema), `memory_read`/`memory_write`/`memory_search`, `artifact_put`/`artifact_get`, `message_send`/`message_list`, `spawn_job` (depth-limited), `request_approval` (files a `job`-scoped gate and waits for `approval_resolve`; holds only that job's concurrency slot), `web_fetch` (public HTTPS as text, SSRF-guarded per redirect hop, truncated past maxBytes), plus granted downstream MCP tools. Remote A2A agents have none of this — they only see what we send in the task's `context`/message parts. A granted tool with `requireApprovalFor` set gates through the same mechanism automatically (the approver may substitute arguments via `editedInput`) instead of failing the call outright (see §5.8).

### 5.15 Schedules (5)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `schedule_create` | Run an instruction on a cron expression (UTC or named zone) | name, cron, instruction, agentId? or template?, model?, runner?, enabled? | I | F |
| `schedule_list` | List schedules with next run times | — | RO | S |
| `schedule_preview` | Show next fire times for an expression or schedule, storing nothing | scheduleId? or cron?, timezone?, count? | RO | S |
| `schedule_update` | Pause, retune or rewrite a schedule | scheduleId, enabled?, cron?, instruction? | I | F |
| `schedule_delete` | Remove a schedule (fired jobs run on) | scheduleId | D | F |

Each firing submits one job owned by the schedule owner; the claim is atomic across instances, overdue schedules fire once with no catch-up, and unresolvable targets skip a round with a warning instead of wedging the ticker.

### 5.16 Completion callbacks (3)

| Tool | Purpose | Key inputs | Ann. | Prof. |
|---|---|---|---|---|
| `webhook_register` | POST a JSON body to a URL on settle (admin) | url, events[] | OW | F |
| `webhook_list` | List callbacks and subscriptions (admin) | — | RO | F |
| `webhook_remove` | Unregister a callback (admin) | webhookId | D | F |

Delivery is at-most-once per settling job or run, bounded per callback, never retried and never allowed to fail the settlement. Registration and every send pass the same URL boundary as push configs (`ORCH_WEBHOOK_ALLOWED_HOSTS` optionally narrows it further); a webhook hears only its own owner's jobs and runs.

---

## 6. Resources (read-only, with `ttlMs` hints)

| URI | Content | TTL |
|---|---|---|
| `orch://templates` | Template catalog | long |
| `orch://agents/{agentId}` | Agent config or cached card, stats, trustLevel | medium |
| `orch://jobs/{jobId}` | Job status + result | short |
| `orch://jobs/{jobId}/transcript` | Full transcript (local) or task history (remote) | short |
| `orch://workflows/{workflowId}` | Workflow spec | medium |
| `orch://workflow-runs/{runId}` | Run state | short |
| `orch://artifacts/{artifactId}` | Artifact content | long (immutable) |
| `orch://memory/{namespace}/{key}` | Memory entry | short |
| `orch://a2a/card` | The Agent Card we currently publish | medium |
| `orch://dashboard` | The nine-tab dashboard data (agents, jobs, delegations, runs, approvals, schedules, memory, artifacts, tools, budgets, events) | short (5 s) |

Change notifications for job and run status via `subscriptions/listen`.

---

## 7. Prompts

| Prompt | What it sets up |
|---|---|
| `orchestrate` | Goal → `plan_create` → review → `workflow_start` → synthesize |
| `build_feature` | planner → coder → tester → reviewer loop (local) |
| `research_team` | fan-out researchers (local and/or remote) → critic → summarizer |
| `code_review_swarm` | parallel reviewers by concern → merged report |
| `cross_vendor_review` | send the same brief to registered agents from different vendors, diff their answers |
| `postmortem_run` | explain why a run failed, using `trace_get` + `events_query` |
| `security_audit` | security-engineer assessment, then reviewer prunes unjustified findings |
| `perf_check` | performance-engineer bottleneck, smallest fix, verification |
| `debug_workflow` | trace + events evidence into debugger for root cause and safe fixes |
| `a11y_audit` | accessibility-specialist barriers with exact locations |
| `compliance_check` | compliance-reviewer blockers vs cautions with cited basis |
| `task_classify` | simple → `delegate`, medium/complex → `plan_create` + `workflow_start` |

---

## 8. Extensions & protocols in play

1. **MCP Tasks** (`io.modelcontextprotocol/tasks`): task-capable tools in §5. Progress via `tasks/update`; client polls `tasks/get`. Fallback: handles + `job_wait`.
2. **MRTR**: `agent_delete`, `workflow_run_control(cancel)`, budget overruns, approval gates, and A2A `input-required` all surface as `input_required`.
3. **A2A v1.0**: JSON-RPC binding first (simplest, closest to MCP's own mental model); gRPC/REST bindings considered later if a partner requires them. Agent Card fetch/verify/cache, task lifecycle mapping, push notifications, standard error mapping — all in `src/a2a/`.
4. **MCP Apps** (later, optional): a live dashboard for workflow runs and job graphs, rendered by the host in a sandboxed iframe. Until then the server renders its own dashboard: `GET /dashboard` (HTML) and `GET /dashboard.json` (JSON) on the MCP HTTP surface when `ORCH_TRANSPORT=http`, plus the `orch://dashboard` resource on both transports — all three from the one collector in `src/dashboard/`. The page is interactive through a JSON API under `/api/` (same owner-scoped store calls as the tools, bearer-token identity when OAuth is on, explicit confirmation for destructive calls instead of MRTR).

---

## 9. Runners vs. the A2A gateway

Local **runners** execute agents we own. The **A2A gateway** (`src/a2a/client.ts`) is not a runner — it never runs a model itself, it calls someone else's agent and normalizes the result.

| Runner | Use | Notes |
|---|---|---|
| `openai-compatible` | **Default.** OpenAI, OpenRouter, Ollama, vLLM, LM Studio | One adapter via base URL |
| `anthropic` | Claude agents | Messages API with tool use; prompt caching |
| `cli` | Heavy coding jobs | Spawns a headless coding-agent CLI in a sandboxed workspace dir |
| `mock` | Tests and CI | Scripted, deterministic responses |
| `sampling` | Borrowed host model | Legacy clients only; `delegate` with `wait`, executed inline via `runInline`, never queued |
| *(A2A gateway, not a runner)* | Remote agents | `src/a2a/client.ts` handles card fetch, task create/poll/cancel, push callbacks |

Runner interface: `run(job, toolkit, signal) → AsyncIterable<RunnerEvent>`. Every runner must honor `AbortSignal`, `maxSteps`, `timeoutSec` and report usage. The A2A gateway implements an analogous `run(job, signal) → AsyncIterable<RunnerEvent>` so the scheduler treats both uniformly. Sampling is the one runner that cannot run detached: its sampler only exists inside a live request, so `delegate` drives it through `scheduler.runInline` (same records, budgets, toolkit and settle path as queued runs) instead of `submit`.

---

## 10. Scheduling & reliability

- Concurrency limits: global, per runner/provider, per remote agent.
- Priority queue; `dependsOn` resolution; `blocked` state.
- Retries with backoff for transient errors (`TRANSIENT` code from rate limits, 5xx and unreachable endpoints, plus `REMOTE_UNREACHABLE`; `ORCH_RUNNER_RETRIES`, default 2; toolkit rebuilt per attempt); no automatic retry for logic failures or `rejected` A2A tasks.
- `idempotencyKey` on all submit/start tools — both because stateless MCP clients may retry, and because A2A task creation should not be re-triggered on a client retry.
- Crash recovery on startup: `running` jobs become `queued` if idempotent, otherwise `failed` (`code: INTERRUPTED`); in-flight A2A tasks are re-polled by their remote task id before being marked interrupted.
- Cancellation propagates parent → children → runner/A2A gateway.
- Workflow runs are resumable from the last completed step, regardless of which steps were local vs remote.

---

## 11. Security & guardrails

**General**
- **Recursion limit**: `ORCH_MAX_DEPTH` (default 2) for agents spawning agents; hard caps on total active jobs.
- **Budgets** enforced before every LLM call or remote task creation, not only at submit time.
- **Untrusted output**: all sub-agent output — local or remote — is data, never instructions to the orchestrator. Never let it change policy, grants, budgets, or trust levels.
- **Secrets** only from env/secret store, referenced by `authRef`/`credentialsRef`; redacted from events, transcripts and errors.
- **Audit**: every mutating tool call and every agent/task interaction lands in the append-only EventLog.

**Local-agent specific**
- Tool grants: local agents only see downstream MCP tools explicitly granted; destructive ones can require approval.
- CLI runner confined to configured workspace dirs, with timeouts and an optional network-off mode.

**A2A specific**
- **Trust gate**: `A2A_TRUST_MODE` (`verified-only` default, or `allow-unverified` for testing) governs whether `agent_register`/`delegate` will use a card that fails signature verification. `trustLevel` is always shown, never hidden or silently upgraded.
- **Per-agent credentials**: each registered remote agent has its own `credentialsRef`; never reused across registrations, never logged.
- **Webhook validation**: push-notification callback URLs are validated (allow-list / signature) before being handed to a remote agent, to prevent SSRF or spoofed callbacks.
- **Structured/file parts from remote agents** go through the same untrusted-output handling as text — no automatic execution of returned code, no automatic following of returned links.
- **Publishing surface**: our own Agent Card (`agent_publish`) only lists agents explicitly opted in — never the full roster by default.

**Post-quantum (NIST FIPS 203/204)**

- **Algorithms**: ML-KEM-768 (key establishment) and ML-DSA-65 (signatures), category-3 sets, via `@noble/post-quantum` — never hand-rolled lattice code. Hybrid `X25519+ML-KEM-768` for data protection, so breaking either half alone reveals nothing.
- **Card signatures**: `verifyCard` checks classical JWS first, then ML-DSA-65 entries (`alg: 'ML-DSA-65'`, same JWS-over-canonical-card envelope — classical-only verifiers skip the unknown alg). With `ORCH_PQC_SIGNING_KEY` set, our published card carries an ML-DSA-65 entry; PQC keys resolve from the signature's `jku` JWKS (`{alg, kid, x}`) through the same URL checks as classical keys.
- **OAuth**: bearer JWTs with `alg: 'ML-DSA-65'` verify against the issuer JWKS through the same `iss`/`aud`/`exp` checks as the jose path (which knows no such alg); every other failure still maps to 401 `invalid_token`, never 500.
- **At rest**: with `ORCH_PQC_DATA_KEY` set, artifact content and memory values rest as sealed hybrid envelopes; hashes still name the plaintext, tags/keys/namespaces stay plaintext (listings, grants and full-text search keep working — content search over sealed values matches nothing by design). Plaintext rows written before the key keep reading back untouched: no migration, mixed tables work, and a sealed row read without the key fails closed instead of leaking the box.
- **Posture is visible**: `orchestrator_status` reports `pqc: {algorithms, atRest, cardSigned}` — classical-only unless keys are configured, and it says so rather than implying otherwise. TLS itself is the boundary: Node's TLS stack negotiates what it negotiates; PQC there arrives with the platform, not this server.

**Remote mode (our MCP surface)**
- OAuth 2.1 with CIMD, validate `iss` per RFC 9207, bind to `127.0.0.1` unless configured, Host header validation, per-tool scopes (e.g. `orch:admin` for `budget_set`, `toolserver_*`, `agent_publish`).
- **Entra ID as issuer.** Point `ORCH_OAUTH_ISSUER_URL` at the tenant-specific v2.0 URL (`https://login.microsoftonline.com/<tenant>/v2.0`, never `common` unless any tenant may call); signing keys resolve by standard OIDC discovery, `oid` becomes the owner id (stable across client apps, unlike `sub`), `scp` merges with `scope`, and an `ORCH_ADMIN_ROLES` app-role value promotes to `orch:admin`. Set the app's audience to `ORCH_OAUTH_RESOURCE_URL`.

---

## 12. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ORCH_DATA_DIR` | `~/.agent-orchestrator` | DB, artifacts |
| `ORCH_TOOL_PROFILE` | `standard` | `core` / `standard` / `full` |
| `ORCH_TRANSPORT` | `stdio` | `stdio` / `http` (MCP surface) |
| `ORCH_HTTP_PORT` | `3333` | MCP HTTP mode |
| `ORCH_HTTP_ALLOWED_HOSTS` | — | Extra hostnames accepted in Host/Origin headers, additive to loopback |
| `ORCH_CORS_ALLOWED_ORIGINS` | allow-all | Browser origins answered with CORS headers; named entries also pass the Origin guard |
| `ORCH_MAX_DEPTH` | `2` | Sub-agent recursion |
| `ORCH_MAX_CONCURRENCY` | `4` | Global parallel jobs |
| `ORCH_RETENTION_DAYS` | — | Keep finished history this many days; unset keeps everything (`maintenance_prune`) |
| `ORCH_SCHEDULE_TICK_SEC` | `30` | How often due cron schedules are checked (minimum 5) |
| `ORCH_CANCEL_POLL_SEC` | `2` | How often an instance checks for jobs another instance asked to cancel (minimum 1); independent of the slower lease heartbeat |
| `ORCH_RUNNER_RETRIES` | `2` | Automatic retries per job for transient runner failures only (never logic errors) |
| `ORCH_WEBHOOK_ALLOWED_HOSTS` | — | Hosts completion callbacks may target; empty means any public HTTPS |
| `ORCH_DISABLED_TEMPLATES` | — | Templates excluded from list and use (sensitive repos) |
| `ORCH_CONFIG_FILE` | `./orchestrator.config.json` if present | Declarative templates, toolservers, presets, schedules and budgets applied once at boot |
| `ORCH_OAUTH_JWKS_URL` | OIDC discovery | Skip discovery and fetch signing keys here instead |
| `ORCH_ADMIN_ROLES` | — | App-role values granting `orch:admin`, matched exactly, never lowercased |
| `ORCH_DB_URL` | SQLite file | A file path selects SQLite; a `postgres://` URL selects Postgres |
| `ORCH_DB_MAX_CONNECTIONS` | `10` | Pool size per instance; Postgres only |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` | — | Local runners |
| `A2A_ENABLED` | `false` | Turn on the A2A gateway/server |
| `A2A_HTTP_PORT` | `3334` | Our published A2A endpoint, if different from MCP HTTP |
| `A2A_TRUST_MODE` | `verified-only` | `verified-only` / `allow-unverified` |
| `A2A_AGENT_CARD_URL` | — | Public URL our Card will be served from |
| `A2A_REGISTRY_URL` | — | Optional catalog used by `a2a_discover` |
| `ORCH_PQC_DATA_KEY` | — | Base64 v1 data-key bundle; when set, artifact content and memory values rest as sealed hybrid (X25519+ML-KEM-768) envelopes |
| `ORCH_PQC_SIGNING_KEY` | — | Base64 ML-DSA-65 secret key; when set, our published Agent Card carries a PQC signature entry |
| `ORCH_PQC_SIGNING_KID` | `pqc-1` | Key id advertised alongside the PQC card signature |

Declarative config file `orchestrator.config.json` (see `src/config-file.ts`): templates, toolservers, grant presets, schedules and budgets — all upserted at boot, so re-applying is a no-op and later API changes win until restart. A2A registrations, published skills and runner defaults stay in tools and env vars: credentials do not belong in a file.

---

## 13. Project structure

```
agent-orchestrator/
├─ AGENTS.md
├─ PLAN.md
├─ package.json · tsconfig.json · vitest.config.ts
├─ src/
│  ├─ index.ts              # entry: parse config, pick transport(s)
│  ├─ server.ts             # McpServer setup, profiles, extensions
│  ├─ config.ts
│  ├─ errors.ts             # error codes shared across backends
│  ├─ ids.ts                # prefixed ULIDs
│  ├─ schemas/              # zod v4 schemas shared by tools + core
│  ├─ tools/                # thin MCP adapters, one file per group
│  │  ├─ agents.ts  jobs.ts  delegation.ts  workflows.ts
│  │  ├─ messaging.ts  memory.ts  artifacts.ts  approvals.ts
│  │  ├─ a2a.ts  toolservers.ts  observability.ts  admin.ts
│  │  └─ profiles.ts
│  ├─ resources/  prompts/
│  ├─ core/                 # business logic — no MCP or A2A SDK imports
│  │  ├─ registry.ts  scheduler.ts  workflow-engine.ts
│  │  ├─ bus.ts  memory.ts  artifacts.ts  policy.ts
│  │  ├─ budget.ts  events.ts  templating.ts
│  ├─ runners/  anthropic.ts  openai.ts  cli.ts  mock.ts  types.ts
│  ├─ a2a/                  # A2A gateway — no MCP SDK imports
│  │  ├─ client.ts          # outward: call remote agents
│  │  ├─ server.ts          # inward: publish our Agent Card, serve tasks
│  │  ├─ card.ts            # fetch / verify / cache Agent Cards
│  │  ├─ mapping.ts         # A2A task state ⇄ Job state
│  │  └─ trust.ts           # signature verification, trust levels
│  ├─ proxy/                # downstream MCP client pool (local agents only)
│  └─ db/  schema.ts  migrations/  sqlite.ts  postgres.ts
├─ templates/               # built-in agent templates (JSON/MD)
└─ tests/  unit/  integration/  snapshots/
```

---

## 14. Milestones

| Milestone | Scope | Done when |
|---|---|---|
| **M0 Skeleton** | Repo, stdio transport, config, SQLite + migrations, `orchestrator_status`, CI | Inspector connects and calls `orchestrator_status` |
| **M1 Delegation core** | Templates, local agents, jobs, `delegate`, `job_wait`, anthropic + mock runners, EventLog | `delegate` returns a real result; mock-runner tests green |
| **M2 Parallel & shared state** | `fan_out`, memory, artifacts, messaging, budgets, openai-compatible runner, agent-side toolkit | 20-item fan-out respects concurrency and budget caps |
| **M3 Workflows & HITL** | DAG engine, templating, `plan_create`, approvals via MRTR + tools, MCP Tasks extension | A 4-step workflow with one approval gate pauses, resumes, completes |
| **M4 A2A interoperability** | `src/a2a/*`, `agent_register`, `a2a_*` tools, skill-based routing in `delegate`/`fan_out`, `agent_publish` + our own served Card, trust/signature verification, task↔job state mapping | We delegate a job to a real (or reference) external A2A agent and get a result through `job_get`; an external A2A client discovers and calls one of our published agents |
| **M5 MCP tools & remote transport** | Downstream MCP proxy for local agents, Streamable HTTP + OAuth for our own MCP surface, Postgres adapter, CLI runner | Two server instances behind round-robin serve the same run correctly |
| **M6 Polish** | `consensus`, `trace_get`, `usage_report`, MCP Apps dashboard, docs, examples | Profiles documented; `tools/list` snapshot stable |

---

## 15. Testing strategy

- **Unit**: scheduler, DAG validation, templating, budget math, policy, card signature verification, task-state mapping.
- **Integration**: real MCP client against the server in-process (mock runner); a local reference A2A agent (small fixture server) for A2A integration tests — never call real third-party agents in CI.
- **Contract**: snapshot of `tools/list` per profile — any change must be intentional.
- **Live** (opt-in, `RUN_LIVE_TESTS=1`): one smoke test per real local runner, and one against a real external A2A agent if one is available for testing.
- **Chaos**: kill the process mid-run (local and mid-remote-task), restart, verify recovery.
- **Security**: unverified-card rejection, credential isolation between registrations, webhook allow-listing.
- **Load**: fan-out with 100 items on the mock runner.

---

## 16. Open questions

1. TypeScript (planned) or Python — which fits the team? (The A2A JS SDK and MCP TS SDK v2 both exist, so TS keeps one language end to end.)
2. Which runner ships first after mock: anthropic, openai-compatible, or CLI?
3. A2A binding to speak first: JSON-RPC (recommended default), gRPC, or REST?
4. Do we require verified Agent Cards for all remote delegation from day one, or allow `A2A_TRUST_MODE=allow-unverified` during early testing?
5. Is there a real registry/catalog to back `a2a_discover`, or do remote agents get registered manually by URL for v1?
6. Should `agent_publish` default any built-in template to exposed, or must every published skill be opted in explicitly? (Leaning: explicit only.)
7. Local-only (stdio) or remote from day one for our own MCP surface?
8. Is vector search needed for memory in v1, or is FTS enough?

