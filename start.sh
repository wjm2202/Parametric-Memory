#!/usr/bin/env bash
# ── Parametric-Memory quick start ─────────────────────────────────────────────
# Usage: ./start.sh
# Builds if needed, loads .env, starts the server.
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Build if dist/server.js is missing
if [ ! -f dist/server.js ]; then
  echo "→ Building…"
  npm run setup
fi

# Load .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

echo "→ Starting Parametric-Memory on port ${PORT:-3000}…"
exec node dist/server.js
