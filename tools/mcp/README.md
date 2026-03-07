# MMPM MCP Server (Skeleton)

This MCP server exposes the existing MMPM HTTP API as MCP tools/resources so Claude (or any MCP host) can use memory natively.

## What this serves

- Tools for implemented endpoints (`/access`, `/batch-access`, `/train`, `/atoms`, `/policy`, `/health`, `/ready`, `/metrics`, etc.)
- Resources for health/ready/policy/metrics and the in-repo tool catalog
- Three permission tiers: read-only, write (default), and dangerous (admin ops)

## Run

From `markov-merkle-memory`:

```bash
# Default — read + write (session_checkpoint, add, train, commit). Recommended.
npm run mcp:serve

# Read-only — no mutations at all
npm run mcp:serve:readonly

# Unsafe — read + write + dangerous ops (delete, import, policy changes)
npm run mcp:serve:unsafe
```

## Permission tiers

| Script | Read | Write (add/train/checkpoint) | Dangerous (delete/import/policy) |
|--------|------|------------------------------|----------------------------------|
| `mcp:serve:readonly` | ✅ | ❌ | ❌ |
| `mcp:serve` | ✅ | ✅ | ❌ |
| `mcp:serve:unsafe` | ✅ | ✅ | ✅ |

Writing atoms (`session_checkpoint`, `memory_atoms_add`, `memory_train`, `memory_commit`) is a normal memory operation and is enabled by default in `mcp:serve`. Destructive operations (tombstone, bulk import, policy mutation) require the explicit `mcp:serve:unsafe` mode.

## Claude Desktop config (macOS)

Claude Desktop reads MCP server definitions from:

`~/Library/Application Support/Claude/claude_desktop_config.json`

Use one of these templates from this repo:

- Default (read + write): `tools/mcp/claude_desktop_config.example.json`
- Unsafe (+ dangerous ops): `tools/mcp/claude_desktop_config.unsafe.example.json`

After copying, replace `REPLACE_WITH_YOUR_API_KEY` and keep the `cwd` path pointed at this repo.

## Environment

- `MMPM_MCP_BASE_URL` (default: `http://127.0.0.1:3000`)
- `MMPM_MCP_API_KEY` (falls back to `MMPM_API_KEY`)
- `MMPM_MCP_ENABLE_MUTATIONS=1` to expose write tools (set automatically by `mcp:serve`)
- `MMPM_MCP_ENABLE_DANGEROUS=1` to expose destructive/admin tools (set by `mcp:serve:unsafe` only)
- `MMPM_MCP_ENABLE_SEMANTIC_TOOLS=1` to expose semantic tools (`memory_search`, `memory_context`)

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
