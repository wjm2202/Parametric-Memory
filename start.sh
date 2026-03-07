#!/usr/bin/env bash
# ── Parametric-Memory ─────────────────────────────────────────────────────────
#
#   ./start.sh              Start the server (default, fast — ~500ms)
#   ./start.sh --monitor    Start server + Grafana/Prometheus in Docker
#   ./start.sh --stop       Stop the server (and monitoring stack if running)
#
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

MODE="${1:-}"

# ── stop ──────────────────────────────────────────────────────────────────────
if [[ "$MODE" == "--stop" ]]; then
  PID=$(lsof -ti:${PORT:-3000} 2>/dev/null || true)
  if [[ -n "$PID" ]]; then
    kill "$PID" && echo "✓ Server stopped (pid $PID)"
  else
    echo "Server not running on port ${PORT:-3000}"
  fi
  if docker compose -f docker-compose.monitoring.yml ps -q 2>/dev/null | grep -q .; then
    docker compose -f docker-compose.monitoring.yml down
    echo "✓ Monitoring stack stopped"
  fi
  exit 0
fi

# ── ensure DB directory exists outside the repo ───────────────────────────────
# Reads DB_BASE_PATH from .env if present, falls back to ~/.mmpm/data.
# This ensures the directory exists before the server tries to open LevelDB.
_RAW_DB_PATH="$(grep -E '^DB_BASE_PATH=' .env 2>/dev/null | cut -d= -f2- || true)"
_RAW_DB_PATH="${_RAW_DB_PATH:-~/.mmpm/data}"
# Expand leading ~
DB_DIR="${_RAW_DB_PATH/#\~/$HOME}"
if [[ ! -d "$DB_DIR" ]]; then
  mkdir -p "$DB_DIR"
  echo "→ Created DB directory: $DB_DIR"
fi

# ── build if needed ───────────────────────────────────────────────────────────
if [[ ! -f dist/server.js ]] || [[ src/server.ts -nt dist/server.js ]]; then
  echo "→ Building…"
  npm run build --silent
fi

# ── start server ──────────────────────────────────────────────────────────────
PORT="${PORT:-3000}"
echo "→ Starting Parametric-Memory on port ${PORT}..."

if [[ "$MODE" == "--monitor" ]]; then
  # Background the server so we can also bring up the monitoring stack
  nohup node dist/server.js >/tmp/mmpm-server.log 2>&1 &
  SERVER_PID=$!
  echo "  Server pid: $SERVER_PID  (logs: /tmp/mmpm-server.log)"

  # Wait for ready
  for i in $(seq 1 20); do
    sleep 0.3
    curl -s "http://localhost:$PORT/health" 2>/dev/null | grep -q '"ready":true' && break
    [[ $i -eq 20 ]] && echo "Server didn't become ready — check /tmp/mmpm-server.log" && exit 1
  done
  echo "  Server ready"

  # Start monitoring stack (Grafana + Prometheus)
  echo "→ Starting monitoring stack…"
  docker compose -f docker-compose.monitoring.yml up -d
  echo ""
  echo "  Grafana    → http://localhost:3001  (admin / admin)"
  echo "  Prometheus → http://localhost:9090"
  echo ""
  echo "  Stop everything: ./start.sh --stop"
else
  # Foreground — exec replaces this shell, Ctrl-C stops it cleanly
  exec node dist/server.js
fi
