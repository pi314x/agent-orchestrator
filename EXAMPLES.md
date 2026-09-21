# Examples

Copyable flows for the orchestrator's MCP tools. Every snippet assumes the
server is connected (`claude mcp get orchestrator` reports connected) and the
default `standard` profile. See `README.md` for the full tool reference and
`PLAN.md` §5 for the catalog.

## Quick reference

| Goal | Reach for |
|---|---|---|
| One thing done by one agent | `delegate` |
| Recurring work on a cron expression | `schedule_create` |
| Reuse one grant bundle across agents | `grant_preset_save` → `agent_create grantPreset` |
| Trim old finished history | `maintenance_prune` |
| Same instruction over many items | `fan_out` |
| Work you don't want to block on | `job_submit` + `job_wait` |
| Ordered steps with gates | `workflow_define` → `workflow_start` |
| Review / audit something | `delegate` with a specialist template, or the audit prompts |
| Share state between jobs | `memory_*` (small) / `artifact_*` (large) |
| Let someone use your agent | `orchestrator_status` → `agent_share` → `agent_unshare` |
| Archive or hand over a run | `workflow_export` |
| Re-run successes that produced nothing | `workflow_run_control` with `reconcile` |

## Delegate one thing

```
delegate { instruction: "Summarize this incident report in 3 bullets.",
           template: "summarizer" }
→ { status: "completed", result: "...", usage: { tokens: 812, costUsd: 0.0031 } }
```

Unsure how big the task is? Ask the `task_classify` prompt first: simple work
goes straight to `delegate`, larger work to `plan_create` + `workflow_start`.

## Borrow the client's model for one call

```
delegate { instruction: "Summarize this incident report in 3 bullets.",
           template: "summarizer", runner: "sampling" }
```

Only for legacy (pre-`2026-07-28`) clients, and only synchronously: the job
runs inline inside this call (bounded by `timeoutSec`) and lands in history
like any other job. `job_submit`, workflows and fan-out cannot borrow — use a
configured runner there.

## Fan out, then reduce

```
fan_out {
  instructionTemplate: "Review {{item}} for a null-check bug in the auth path.",
  items: ["src/auth/login.ts", "src/auth/refresh.ts", "src/auth/session.ts"],
  template: "reviewer",
  concurrency: 3,
  reduce: { template: "summarizer", instruction: "Merge these findings, dedupe overlaps." }
}
```

## Background work with a dependency

```
job_submit { instruction: "Draft the release notes for v1.4.", template: "writer" }
→ { jobId: "job_01H..." }

job_submit { instruction: "Proofread the draft release notes.", template: "reviewer",
             dependsOn: ["job_01H..."] }
→ { jobId: "job_01J..." }   # stays queued until the first job finishes

job_wait { jobIds: ["job_01H...", "job_01J..."], mode: "all", timeoutSec: 60 }
```

## A workflow with a human approval gate

Steps that touch the same file must be ordered — two unordered steps claiming
one file are rejected at define time, before anything runs:

```
workflow_define {
  name: "ship-feature",
  steps: [
    { id: "plan",   instruction: "Plan the change.",    template: "planner" },
    { id: "build",  instruction: "Implement the plan.", template: "coder",    dependsOn: ["plan"], files: ["src/auth.ts"] },
    { id: "review", instruction: "Review the diff.",    template: "reviewer", dependsOn: ["build"], files: ["src/auth.ts"], approval: true },
    { id: "ship",   instruction: "Open the PR.",        template: "coder",    dependsOn: ["review"] }
  ]
}

workflow_start { workflowId: "wf_...", inputs: { feature: "dark mode toggle" } }
→ { runId: "run_..." }

# once the "review" step pauses on its gate:
approval_list { status: "pending" }
approval_resolve { approvalId: "appr_...", decision: "approve" }
```

A step whose template name does not exist (or is disabled via
`ORCH_DISABLED_TEMPLATES`) is rejected at define/start time, not mid-run.

## Reconcile empty successes

A step can report success with blank output — the run flags it with a
`job.progress` event ("empty output; verify before chaining"). Re-run every
such step at once, or narrow to one:

```
workflow_run_control { runId: "run_...", action: "reconcile" }
→ { reconciled: ["build"] }   # empty when there is nothing to re-run

workflow_run_control { runId: "run_...", action: "reconcile", stepId: "build" }
```

Failed steps still go through `retry_step`.

## Audit with a specialist

```
delegate { instruction: "Audit src/auth/ for auth, secret and injection risk.",
           template: "security-engineer" }
delegate { instruction: "Profile the slow query in src/db/search.ts.",
           template: "performance-engineer" }
delegate { instruction: "Why does login return 500 after deploy 1.4?",
           template: "debugger" }
```

The `security_audit`, `perf_check`, `debug_workflow`, `a11y_audit` and
`compliance_check` prompts chain the same templates into a starting brief.

## Share state across jobs

```
memory_write { namespace: "release-1.4", key: "changelog", value: { items: ["..."] } }
artifact_put { name: "full-diff.patch", content: "<patch text>", mimeType: "text/x-diff" }
→ { artifactId: "art_..." }

# a later job reads both back:
memory_read   { namespace: "release-1.4", key: "changelog" }
artifact_get  { artifactId: "art_...", offset: 0 }
```

## Share an agent with someone, then revoke

Everything is private by default. To let one named user delegate to your
agent, you need their id — ask them to read it from their own status call:

```
# they run:
orchestrator_status
→ { caller: { ownerId: "user_bob", isAdmin: false }, ... }

# you run, with the id they gave you:
agent_share { agentId: "agt_...", granteeId: "user_bob" }

# they accept (shares stay pending and invisible until then):
agent_share_accept { agentId: "agt_..." }   # run by user_bob; see agent_share_incoming for pending offers

# they can now see and delegate to it (agent_list, agent_get, delegate),
# but cannot modify, delete or re-share it. To revoke:
agent_unshare { agentId: "agt_...", granteeId: "user_bob" }
agent_share_list { agentId: "agt_..." }   # current grantees with pending/accepted status, owner only
```

The same shape works for memory namespaces (`memory_share` /
`memory_unshare` / `memory_share_list` / `memory_share_accept`); the grantee
passes your ownerId to `memory_read` / `memory_search`. Workflow definitions
share the same way (`workflow_share` / `workflow_unshare` /
`workflow_share_list` / `workflow_share_accept`) — the grantee
can read the spec and start their own runs, but your run history stays
private and only you can modify or delete the definition.

## Ask a human mid-loop, answer a remote task

A running agent pauses for a decision with `request_approval` (inside its own
toolkit — never exposed over MCP); you answer from `approval_list`:

```
# inside the agent loop:
request_approval { summary: "Deploy to production now?",
                   details: "Staging is green; the window closes at 18:00." }
# ...blocks until you run:
approval_resolve { approvalId: "appr_...", decision: "approve",
                   editedInput: { window: "after-hours" } }
```

A downstream tool marked `requireApprovalFor` pauses the same way
automatically, and your `editedInput` becomes its call arguments. A remote
task waiting for input pauses identically — approve with
`editedInput: { message: "..." }` and the answer goes back to that same
remote task. A rejection stops the job; a bare approve with no message fails
loudly instead of sending nothing.

## Run work on a schedule, reuse grants, prune history

```
# Every weekday at 09:00 UTC, as you: one job per firing, no catch-up runs.
schedule_create {
  name: "morning-review", cron: "0 9 * * mon-fri",
  instruction: "Review yesterday's commits on main for risk.",
  template: "reviewer"
}
schedule_list    # next run times
schedule_preview { cron: "0 9 * * mon-fri", timezone: "Europe/Berlin", count: 3 }
schedule_update { scheduleId: "sch_...", enabled: false }   # pause without deleting
schedule_delete { scheduleId: "sch_..." }   # fired jobs run on

# Curate a grant bundle once (admin), stamp it onto agents (anyone):
grant_preset_save { name: "reader", grants: ["files", "files/read_file"] }
agent_create { name: "repo-reader", role: "researcher",
               instructions: "...", grantPreset: "reader" }

# Delete finished history older than 90 days (admin) — dry-run first:
maintenance_prune { olderThanDays: 90, dryRun: true }
maintenance_prune { olderThanDays: 90 }

## Declare the deployment in a file

`orchestrator.config.json` in the working directory (or `ORCH_CONFIG_FILE`
elsewhere) lands once at boot — templates, toolservers, presets, schedules
and budgets, all upserted:

```json
{
  "toolservers": [
    { "name": "files", "transport": { "type": "stdio", "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/repo"] } }
  ],
  "presets": [{ "name": "reader", "grants": ["files/read_file"] }],
  "schedules": [
    { "name": "morning-review", "cron": "0 9 * * mon-fri", "timezone": "Europe/Berlin",
      "instruction": "Review yesterday's commits on main for risk.", "template": "reviewer" }
  ],
  "budgets": [{ "scope": "global", "maxCostUsd": 50 }]
}
```

# Get called when your work settles instead of polling (admin):
webhook_register { url: "https://hooks.example.com/orch",
                   events: ["job.failed", "workflow.failed"] }
# → POSTs { type, jobId?, runId? } at most once per settlement; failures logged, never retried
```

## Grant an agent a downstream MCP tool

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
`files__list_directory`. Attaching grants needs the `orch:admin` scope once
OAuth is configured.

## Export a run for archiving or handover

```
workflow_export { runId: "run_..." }
→ { artifactId: "art_...", steps: 4, sizeBytes: 18342 }

artifact_get { artifactId: "art_..." }   # markdown: inputs, per-step outputs, durations
```

For span timings use `trace_get { runId }`; for the raw history,
`events_query { runId }`.
