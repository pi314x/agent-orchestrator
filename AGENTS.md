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
| `pnpm inspect` | Launch MCP Inspector against the dev server |

Before finishing any task run: `pnpm typecheck && pnpm lint && pnpm test`.

## Layout

- `src/core/` — business logic. **Must not import the MCP SDK or the A2A SDK.** Fully unit-testable, backend-agnostic.
- `src/tools/` — thin MCP adapters, one file per tool group. Validate → call core → shape output. No business logic here.
- `src/a2a/` — the A2A gateway. **Must not import the MCP SDK.** `client.ts` calls remote agents; `server.ts` publishes our Agent Card and serves tasks; `card.ts` and `trust.ts` handle fetch/verify/cache.
- `src/schemas/` — Zod schemas shared by tools and core.
- `src/runners/` — local execution backends implementing `Runner` from `runners/types.ts`. The A2A gateway is *not* a runner — it lives in `src/a2a/`, not `src/runners/`.
- `src/proxy/` — downstream MCP client pool, used only to grant tools to **local** agents.
- `src/db/` — schema, migrations, SQLite/Postgres adapters.
- `tests/` — `unit/`, `integration/`, `snapshots/`.

## Stack notes

Verified against the installed SDK — check here before guessing at an API.

- **Packages.** The v2 TypeScript SDK is split: `@modelcontextprotocol/server` (`McpServer`, `createMcpHandler`, `serveStdio` from `/stdio`), `@modelcontextprotocol/node` (`toNodeHandler`, `hostHeaderValidation`, `originValidation`), `@modelcontextprotocol/client` (tests). There is no single `@modelcontextprotocol/sdk` v2.
- **Two protocol eras.** `createMcpHandler` serves *modern* (`2026-07-28`, negotiated via `server/discover`, `_meta` envelope per request) and falls back to *legacy* (`2025-11-25` and earlier, via `initialize`) statelessly from the same factory. Exported `LATEST_PROTOCOL_VERSION` is `2025-11-25` — it names the legacy ceiling, not the modern era, so don't assert on it.
- **Statelessness comes free.** `createMcpHandler` builds a fresh `McpServer` per request via `McpServerFactory`, which is exactly protocol rule 1. Never hoist per-request state into the factory's closure — only long-lived handles (DB, logger, config) belong there.
- **HTTP surface.** MCP is served at `/mcp`; `/health` is a plain JSON probe outside the protocol. Host *and* Origin are validated before the handler sees the request.
- **`structuredContent` needs an index signature.** Type a tool's output shape with a `type` alias, not an `interface` — object-literal aliases get an implicit index signature and stay assignable to `Record<string, unknown>`; interfaces do not.
- **pino.** Import `destination` as a named export (`import { destination, pino } from 'pino'`); it is not typed on the named `pino` export.
- **better-sqlite3** is a native module; it only builds because `pnpm.onlyBuiltDependencies` in `package.json` allows its install script. After a fresh clone run `pnpm rebuild better-sqlite3` if the binding is missing.
- **Testing the Host guard.** Node's `fetch` silently drops a forbidden `host` header — drive `node:http` directly when asserting on host validation.

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
