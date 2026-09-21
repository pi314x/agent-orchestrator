# Connectors

Ready-to-copy MCP client configs for the orchestrator. Every file uses the
**stdio** transport: the host launches `dist/index.js` itself, so there is no
URL to get wrong and no server to keep running. Build first (`pnpm build`),
then replace `/absolute/path/to/agent-orchestrator` with the real checkout
path — a relative path, or the placeholder left unedited, connects to nothing.

| Host | File | Install location |
|---|---|---|
| Gemini CLI | `gemini-settings.json` | merge `mcpServers` into `~/.gemini/settings.json` |
| Qwen Code | `qwen-settings.json` | merge `mcpServers` into `~/.qwen/settings.json` |
| Claude Code | — | `claude mcp add orchestrator -- node /absolute/path/to/agent-orchestrator/dist/index.js` (see README) |
| Claude Desktop | `claude-desktop.json` | merge `mcpServers` into the/*.json config file (Claude → Settings → Developer) |
| VS Code | `vscode-mcp.json` | save as `.vscode/mcp.json` in the workspace |
| OpenAI Codex | `codex-config.toml` | merge `[mcp_servers.orchestrator]` into `~/.codex/config.toml`, then restart Codex |
| Cursor | `cursor-mcp.json` | merge `mcpServers` into `~/.cursor/mcp.json`, then restart Cursor |
| Windsurf | `windsurf-mcp.json` | merge `mcpServers` into `~/.codeium/windsurf/mcp_config.json`, then restart Windsurf |
| Zed | `zed-settings.json` | merge `context_servers` into the Zed settings file (Settings → AI → MCP Servers). Zed speaks Tools + Prompts only — no sampling, so the `sampling` runner cannot borrow Zed's model |
| Continue | `continue-orchestrator.yaml` | save as `.continue/mcpServers/orchestrator.yaml` in the workspace (agent mode required) |
| Pi coding agent | `pi-mcp.json` | merge `mcpServers` into `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project); needs an MCP client extension first (`pi install npm:pi-mcp-extension`), then `/mcp` shows status |
| openCode | `opencode.json` | merge `mcp.orchestrator` into `opencode.json` (global `~/.config/opencode/opencode.json` or project `.opencode/opencode.json`) |
| Roo Code | `roo-mcp.json` | open `Roo Code: Edit MCP settings` and merge `mcpServers` into the workspace or global `mcp.json` |
| Cline | `cline-mcp.json` | open `Cline: MCP Servers` and merge `mcpServers` into `cline_mcp_settings.json` |

Prefer one long-lived server over per-call launches? Start it once with
`pnpm start:http` and point any
Streamable-HTTP-capable host at `http://127.0.0.1:3333/mcp` instead
(`claude mcp add --transport http orchestrator http://127.0.0.1:3333/mcp`).
Beyond localhost, set `ORCH_HTTP_HOST=0.0.0.0` plus
`ORCH_HTTP_ALLOWED_HOSTS` and `ORCH_OAUTH_ISSUER_URL` first — see README
"Reaching it from a hosted client".
