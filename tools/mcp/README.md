# MMPM MCP Server (Skeleton)

This MCP server exposes the existing MMPM HTTP API as MCP tools/resources so Claude (or any MCP host) can use memory natively.

## What this serves

- Tools for implemented endpoints (`/access`, `/batch-access`, `/train`, `/atoms`, `/policy`, `/health`, `/ready`, `/metrics`, etc.)
- Resources for health/ready/policy/metrics and the in-repo tool catalog
- Read-only by default; mutating tools are opt-in

## Run

From `markov-merkle-memory`:

```bash
npm run mcp:serve
```

## Claude Desktop config (macOS)

Claude Desktop reads MCP server definitions from:

`~/Library/Application Support/Claude/claude_desktop_config.json`

Use one of these templates from this repo:

- Safe default (read-only tools): `tools/mcp/claude_desktop_config.example.json`
- Unsafe (mutating tools enabled): `tools/mcp/claude_desktop_config.unsafe.example.json`

After copying, replace `REPLACE_WITH_YOUR_API_KEY` and keep the `cwd` path pointed at this repo.

## Environment

- `MMPM_MCP_BASE_URL` (default: `http://127.0.0.1:3000`)
- `MMPM_MCP_API_KEY` (falls back to `MMPM_API_KEY`)
- `MMPM_MCP_ENABLE_MUTATIONS=1` to expose mutating tools
- `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1` to expose semantic tools (`memory_search`, `memory_context`)

Unsafe helper:

```bash
npm run mcp:serve:unsafe
```

## Current semantic-tool behavior

`memory_search` and `memory_context` are hidden unless `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1` is set.

## Weekly evaluation MCP tools

- `memory_weekly_eval_status` (read-only): reads `tools/harness/weekly_eval_state.json` and reports due/not-due.
- `memory_weekly_eval_run` (mutating): runs `bash tools/harness/weekly-memory-eval.sh` (optionally forced).

`memory_weekly_eval_run` follows mutating-tool visibility rules, so it is only exposed when `MMPM_MCP_ENABLE_MUTATIONS=1`.

## Tool source of truth

The machine-readable tool mapping is in:

- `tools/mcp/mmpm_tool_catalog.json`

## Notes

- This server is an adapter layer: it does not change Markov/Merkle logic.
- Existing HTTP clients keep working unchanged.
