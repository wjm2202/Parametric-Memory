#!/usr/bin/env bash
# ── mcp-entrypoint.sh ────────────────────────────────────────────────────────
#
#   Single entrypoint for MMPM MCP server.
#   Starts the data server (port 3000) if not already running,
#   waits for it to be ready, then launches the MCP server.
#
#   Modes:
#     ./mcp-entrypoint.sh          → stdio transport (Claude Desktop / VSCode)
#     ./mcp-entrypoint.sh --http   → HTTP transport on port 3001 (Cowork)
#
#   Claude Desktop config (stdio):
#   {
#     "parametric-memory": {
#       "command": "bash",
#       "args": ["mcp-entrypoint.sh"],
#       "cwd": "/path/to/markov-merkle-memory",
#       "env": { "MMPM_MCP_ENABLE_MUTATIONS": "1", "MMPM_MCP_ENABLE_SEMANTIC_TOOLS": "1" }
#     }
#   }
#
#   Cowork custom connector:
#     1. Run: ./mcp-entrypoint.sh --http
#     2. Add in Cowork Settings → Connectors → Add custom connector
#        URL: http://localhost:3001/mcp
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-3000}"

# ── Load .env if present ─────────────────────────────────────────────────────
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# ── Ensure DB directory exists ───────────────────────────────────────────────
_RAW_DB_PATH="$(grep -E '^DB_BASE_PATH=' .env 2>/dev/null | cut -d= -f2- || true)"
_RAW_DB_PATH="${_RAW_DB_PATH:-~/.mmpm/data}"
DB_DIR="${_RAW_DB_PATH/#\~/$HOME}"
mkdir -p "$DB_DIR"

# ── Build if needed ──────────────────────────────────────────────────────────
if [[ ! -f dist/server.js ]] || [[ src/server.ts -nt dist/server.js ]]; then
  npm run build --silent >&2
fi

# ── Start data server if not already running ─────────────────────────────────
if ! curl -sf "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1; then
  nohup node dist/server.js >/tmp/mmpm-server.log 2>&1 &
  DATA_PID=$!
  echo "[mcp-entrypoint] Started data server (pid $DATA_PID)" >&2

  # Wait up to 10 seconds for readiness
  for i in $(seq 1 20); do
    sleep 0.5
    if curl -sf "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1; then
      echo "[mcp-entrypoint] Data server ready" >&2
      break
    fi
    if [[ $i -eq 20 ]]; then
      echo "[mcp-entrypoint] ERROR: Data server failed to start — check /tmp/mmpm-server.log" >&2
      exit 1
    fi
  done
else
  echo "[mcp-entrypoint] Data server already running on port $PORT" >&2
fi

# ── Launch MCP server ────────────────────────────────────────────────────────
MODE="${1:-}"
if [[ "$MODE" == "--http" ]]; then
  echo "[mcp-entrypoint] Starting HTTP MCP server on port ${MCP_PORT:-3001}" >&2
  exec npx ts-node tools/mcp/mmpm_mcp_http.ts
else
  exec npx ts-node tools/mcp/mmpm_mcp_server.ts
fi
