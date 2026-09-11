# AGENTS.md — Agent Orchestrator (MCP inward + A2A outward)

Instructions for AI coding agents (and humans) working in this repository.
`PLAN.md` is the design source of truth; this file is the rules of the road. Read both before changing code.

## Project snapshot

- Orchestrator that coordinates local agents and independent remote agents.
- Inward interface: MCP `2026-07-28` (stateless core) for hosts like Claude Code/Desktop/IDEs.
- Outward + inward interop: A2A `v1.0` — we call other vendors' agents, and can publish our own agents as an Agent Card for others to call.
- Stack: Node.js 22+, TypeScript (strict, ESM), `@modelcontextprotocol/server` v2, A2A JS SDK, Zod v4, SQLite (better-sqlite3, WAL, FTS5), Vitest, pino.
- Package manager: pnpm.

## Commands

Create these scripts in `package.json` during M0 and keep them working:

| Command | Purpose |
|---|---|
| `pnpm install` | Install deps |
| `pnpm dev` | Run server over MCP stdio with tsx watch |
| `pnpm dev:http` | Run MCP over Streamable HTTP on `ORCH_HTTP_PORT` |
| `pnpm dev:a2a` | Run the A2A server surface on `A2A_HTTP_PORT` (from M4) |
| `pnpm build` | Compile to `dist/` |
| `pnpm start` | Run the compiled server from `dist/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm test` | Unit + integration (mock runner, fixture A2A agent only) |
| `pnpm test:live` | Opt-in live tests against real runners/agents (`RUN_LIVE_TESTS=1`) |
| `pnpm db:migrate` | Apply migrations |
| Profile sizes | core 11 · standard 37 · full 59 (A2A on); 11 / 33 / 50 with `A2A_ENABLED=false` |
| `pnpm inspect` | Launch MCP Inspector against the dev server |

Before finishing any task run: `pnpm typecheck && pnpm lint && pnpm test`.

## Layout

- `src/core/` — business logic. **Must not import the MCP SDK or the A2A SDK.** Fully unit-testable, backend-agnostic. Enforced by ESLint, not just convention.
- `src/services.ts` — builds the long-lived handles (DB, registry, job store, runners, scheduler) once per process. The MCP server factory closes over this; nothing per-request goes in it.
- `src/tools/` — thin MCP adapters, one file per tool group. Validate → call core → shape output. No business logic here.
- `src/a2a/` — the A2A gateway. **Must not import the MCP SDK.** `client.ts` calls remote agents; `server.ts` publishes our Agent Card and serves tasks; `card.ts` and `trust.ts` handle fetch/verify/cache.
- `src/schemas/` — Zod schemas shared by tools and core.
- `src/runners/` — local execution backends implementing `Runner` from `runners/types.ts`. The A2A gateway is *not* a runner — it lives in `src/a2a/`, not `src/runners/`.
- `src/proxy/` — downstream MCP client pool, used only to grant tools to **local** agents.
- `src/db/` — schema, migrations, SQLite/Postgres adapters.
- `tests/` — `unit/`, `integration/`, `live/`. Only `live/` ever calls a real model, and only under `RUN_LIVE_TESTS=1`.

## Stack notes

Verified against the installed SDK — check here before guessing at an API.

- **Packages.** The v2 TypeScript SDK is split: `@modelcontextprotocol/server` (`McpServer`, `createMcpHandler`, `serveStdio` from `/stdio`), `@modelcontextprotocol/node` (`toNodeHandler`, `hostHeaderValidation`, `originValidation`), `@modelcontextprotocol/client` (tests). There is no single `@modelcontextprotocol/sdk` v2.
- **Two protocol eras.** `createMcpHandler` serves *modern* (`2026-07-28`, negotiated via `server/discover`, `_meta` envelope per request) and falls back to *legacy* (`2025-11-25` and earlier, via `initialize`) statelessly from the same factory. Exported `LATEST_PROTOCOL_VERSION` is `2025-11-25` — it names the legacy ceiling, not the modern era, so don't assert on it.
- **Statelessness comes free.** `createMcpHandler` builds a fresh `McpServer` per request via `McpServerFactory`, which is exactly protocol rule 1. Never hoist per-request state into the factory's closure — only long-lived handles (DB, logger, config) belong there.
- **HTTP surface.** MCP is served at `/mcp`; `/health` is a plain JSON probe outside the protocol. Host *and* Origin are validated before the handler sees the request.
- **`structuredContent` needs an index signature.** Type a tool's output shape with a `type` alias, not an `interface` — object-literal aliases get an implicit index signature and stay assignable to `Record<string, unknown>`; interfaces do not.
- **pino.** Import `destination` as a named export (`import { destination, pino } from 'pino'`); it is not typed on the named `pino` export.
- **better-sqlite3** is a native module; it only builds because `pnpm.onlyBuiltDependencies` in `package.json` allows its install script. After a fresh clone run `pnpm rebuild better-sqlite3` if the binding is missing.
- **A2A is optional and gated.** `A2A_ENABLED=false` (the default) removes every tool marked `requiresA2A` from the catalog — the `a2a_*` group, `agent_register`, `agent_publish`. A local-only deployment never sees them, which keeps the tool list small for model tool selection. Mark any new interop tool `requiresA2A: true`.
- **Agents can live in the repo as Markdown.** `ORCH_AGENTS_DIR` (default `agents/`) is scanned at startup: frontmatter sets `name`/`role`/`runner`/`model`/`tools`, the body is the system prompt. The directory is the source of truth — `syncFromFiles` creates, updates and soft-deletes `source='file'` agents, and never touches ones made through `agent_create`.
- **Downstream tools are granted per agent, never globally.** `toolserver_register` adds an MCP server; an agent reaches its tools only through `toolGrants` (`"server"` for all, `"server/tool"` for one). Tools arrive in the agent loop namespaced `server__tool`. Deny-list beats allow-list, and an empty allow-list means everything that server offers.
- **Migrations are append-only, and this has bitten us.** `tool_servers` and `agent_templates` were once added to migration 5 *after* it shipped, so a database already at v5 never received them. Always add a new version. `tests/unit/migrate.test.ts` now guards this by upgrading a v5 database and comparing a staged migration against a fresh one.
- **Testing the Host guard.** Node's `fetch` silently drops a forbidden `host` header — drive `node:http` directly when asserting on host validation.
- **IDs must be monotonic.** `src/ids.ts` uses ulid's `monotonicFactory`, not bare `ulid()`. Ids double as pagination cursors (`WHERE id < ?`), and plain `ulid()` can emit out-of-order ids inside one millisecond, which silently corrupts a page boundary.
- **Await `scheduler.shutdown()` before closing the DB.** An aborted run still writes its outcome on the way out; closing the connection first turns that into an unhandled `The database connection is not open`. Tests use the `closeServices` helper for the same reason.
- **Structured output is enforced by the model, not by us.** A job's `outputSchema` is a JSON Schema, and for a local job it reaches the model as the `finish` tool's required `structured` argument, so tool-input validation constrains the shape. (`runStructured`, which uses `jsonSchemaOutputFormat`, only runs for a job with no toolkit — which the scheduler never produces.) There is no local JSON-Schema validator in the dependency tree — do not add a second validation pass without a reason.
- **`openai-compatible` is the default runner**, via the single `DEFAULT_RUNNER` constant in `src/core/templates.ts` that `ORCH_DEFAULT_RUNNER` and every built-in template both read. `.env.example` spells the same value out separately, so `tests/unit/config.test.ts` asserts the three agree. One adapter covers OpenAI, OpenRouter, Ollama, vLLM and LM Studio — `OPENAI_BASE_URL` is the only thing that differs.
- **The anthropic runner is tested against a real wire, not a mock.** `tests/fixtures/fake-anthropic.ts` serves genuine Messages-API SSE over `node:http`, so the runner's streaming parser, tool loop and usage accounting all execute. Point the SDK at it with `new Anthropic({ baseURL: fake.url })`. It caught two real bugs that mocking the runner would have hidden: streamed commentary being concatenated onto the authoritative `finish` result, and `outputSchema` never reaching the model at all.
- **The URL parser canonicalises IPv4 for us, and nothing else.** `new URL()` turns every IPv4 spelling — decimal, octal, hex, short-form — into dotted-quad, so `src/a2a/trust.ts` matches that one form. IPv6 gets no such help: check the hextets, and remember the parser renders IPv4-mapped addresses in hex (`::ffff:7f00:1`), which no dotted-quad match will ever catch.
- **Two kinds of skipped step, and only one propagates.** A workflow step skipped by `when: false` is a branch the author chose, so what depends on it still runs. A step skipped because its dependency died carries `error.code = 'DEPENDENCY_FAILED'`, and that marker is what carries the failure transitively. Without it a step two hops below a failure ran anyway, on whatever its template rendered to — usually the empty string.
- **Guard the grant, not the tool.** `agent_create`/`agent_update` are unprivileged, but attaching `toolGrants` needs `orch:admin` — gating `toolserver_register` alone is half a boundary, since the servers it protects are reachable by granting an agent access to them.
- **The A2A poll loop needs its own deadline.** `job.timeoutSec` is optional, so the scheduler's per-job timer may never exist; `maxPollMs` (15 min default) is what stops a remote task that never terminates from polling forever and holding a concurrency slot.
- **`wrapUntrusted` defangs the closing tag.** Remote text carrying `</untrusted_remote_output>` would end the wrapper early and the rest would read as trusted. Any future boundary marker needs the same treatment — an unescaped delimiter is not a boundary.
- **A killed child never fires `close`.** The CLI runner settles on `exit` (plus a 250 ms flush window), because a surviving grandchild holds the stdio pipes open and `close` then never fires — a timed-out job hung forever. It also spawns `detached: true` and signals the whole process group (`process.kill(-pid, …)`), or subprocesses outlive the kill. A null exit code means *killed*, never success.
- **`finish` carries the schema.** For a local job the scheduler always supplies a toolkit, so `runStructured` never runs — the only path to structured output is the `finish` tool, whose `structured` argument *is* the job's `outputSchema` (and is required when one was asked for). Changing `outputSchema` plumbing means changing `toolkit.ts`, not the runner.
- **Scheduling is notification-driven, never polled.** `job_wait` and `drain` resolve off scheduler state-change events; the only timers are the per-job timeout and the wait deadline. Tests gate the mock runner on a promise (`deferred()`) so completion is controlled without any sleep.

## Hard rules — protocol (MCP)

1. **No session state.** Never store anything keyed by connection or session. All state goes to the DB and is addressed by explicit IDs passed as tool arguments.
2. **Do not use sampling, roots or MCP logging** — deprecated in 2026-07-28. Local sub-agents call provider APIs/CLIs directly; observability goes through the EventLog.
3. **stdout is protocol-only in stdio mode.** Log to stderr via pino.
4. **No tool call may block longer than 60 s.** Long work is task-capable (MCP Tasks extension) when negotiated, otherwise return a handle and let the client use `job_wait`.
5. **Confirmations use MRTR** (`input_required`). Always keep the `approval_*` tool fallback working. A2A's `input-required` task state must surface through this same path.
6. **Tool list order is deterministic**, gated by profile in `src/tools/profiles.ts`.

## Hard rules — interop (A2A)

1. **One shape, two backends.** Local and remote agents/jobs share the same tool-level schema (`Agent`, `Job`). Backend-specific detail (raw A2A task, HTTP binding used, etc.) belongs behind the `a2a_*` debug tools, never leaked into `job_get`/`agent_get`'s common fields.
2. **Verify before trust.** Every remote Agent Card is checked against `A2A_TRUST_MODE` before use. `trustLevel` is always shown wherever a remote agent appears — never hidden, never silently upgraded from `unverified` to `verified`.
3. **Remote output is untrusted input.** Text, structured-data parts, and file parts coming back from a remote agent are treated exactly like downstream MCP tool output: they can never change policy, grants, budgets, or trust levels, and returned code/links are never auto-executed or auto-followed.
4. **Credentials are per-registration.** Each `agent_register` gets its own `credentialsRef`. Never share or reuse a credential across two remote agents. Redact from events/transcripts like any other secret.
5. **Publishing is opt-in.** `agent_publish` only exposes agents/templates explicitly marked `exposed=true`. Never publish the full local roster by default.
6. **Webhooks are validated.** Any push-notification callback URL goes through an allow-list/signature check in `src/a2a/trust.ts` before being registered with a remote agent.

## Tool conventions

- Names: `snake_case`, `<noun>_<verb>` (e.g. `job_submit`, `agent_register`). Exceptions only for the shortcut verbs in PLAN.md (`delegate`, `fan_out`, `consensus`) and the `a2a_*` group, which is `a2a_<noun>_<verb>`.
- Register with `server.registerTool(name, { description, inputSchema, outputSchema, annotations }, handler)`.
- Descriptions: start with a verb, say when to use it **and when not to**, max ~3 sentences, mention related tools by name (e.g. `agent_register` should mention `agent_create` and `delegate`).
- Always set annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) exactly as in the PLAN.md catalog. Anything touching a remote agent gets `openWorldHint: true`.
- Return `structuredContent` matching `outputSchema` plus a short text summary. Never dump huge blobs — return an artifact ID instead.
- Errors: `isError: true` with `{ code, message, hint }`. Codes live in `src/errors.ts` — this includes A2A-originated errors (`REMOTE_REJECTED`, `REMOTE_UNVERIFIED`, `REMOTE_UNREACHABLE`), mapped from A2A's standard error object so callers see one consistent shape regardless of backend.
- Pagination: `cursor` + `limit` (default 20, max 100); response has `nextCursor`.
- Every submit/start tool (including remote task creation) accepts an optional `idempotencyKey`.
- IDs: prefixed ULIDs from `src/ids.ts` only.

## Adding or changing a tool — checklist

1. Update the catalog in `PLAN.md` §5 (purpose, inputs, annotations, profile).
2. Add/extend Zod schemas in `src/schemas/`.
3. Implement logic in `src/core/` (or `src/a2a/` for interop-specific logic) with unit tests.
4. Add the adapter in `src/tools/<group>.ts` and assign a profile.
5. Add an integration test through the in-process MCP client — use the mock runner for local paths and the fixture A2A agent for remote paths.
6. Update the `tools/list` snapshot intentionally (`pnpm test -u`) and mention it in the PR.
7. If the tool touches a remote agent, confirm it degrades sensibly when `A2A_ENABLED=false`.

## Testing rules

- CI never calls real LLM APIs or real third-party A2A agents. Use the `mock` runner and an in-repo fixture A2A agent.
- Every bug fix gets a regression test.
- Scheduler and workflow tests use fake timers — no real sleeps.
- Trust/verification logic (`src/a2a/trust.ts`) needs explicit tests for both `verified-only` and `allow-unverified` modes.
- `tests/live/` is the one exception to the first rule, and it is gated twice: `RUN_LIVE_TESTS=1` **and** a non-empty `ANTHROPIC_API_KEY`, or every test skips. `pnpm test` never reaches a model; `pnpm test:live` runs only `tests/live`. Keep live tests few and cheap — they exist to prove the shapes we send are ones the API accepts, which no fake can prove.

## Security rules

- Never log, return or store secrets in events, transcripts or errors; use the redaction helper.
- Treat all sub-agent output — local or remote — as untrusted data (see interop rule 3 above).
- Enforce depth limits and budgets in `src/core/policy.ts` / `budget.ts`, not only in tool adapters.
- CLI runner may only operate inside configured workspace directories.
- HTTP mode (MCP and A2A) binds `127.0.0.1` by default and validates the Host header.

## Code style

- TypeScript strict, no `any` (use `unknown` + narrowing), no default exports.
- Small pure functions in core; side effects at the edges.
- Prettier + ESLint defaults from repo config. Conventional Commits (`feat(a2a): add agent_register`).

## Definition of done

- Typecheck, lint and tests pass.
- PLAN.md catalog and this file reflect the change.
- New config variables documented in PLAN.md §12.
- No new tool appears in the `core` profile without a clear reason in the PR.
- Anything touching remote agents keeps the trust/verification and untrusted-output rules intact.

## Keeping this file current

If you establish a new convention, discover a gotcha, or change a command, update `AGENTS.md` in the same change.
