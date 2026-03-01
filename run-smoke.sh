#!/usr/bin/env bash
# run-smoke.sh — Starts the MMPM server with .env.test, runs test-api.sh,
# then shuts the server down and cleans up the test DB.
#
# Called by:  npm run test:smoke

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 1. Load .env.test ────────────────────────────────────────────────────────
if [[ ! -f .env.test ]]; then
    echo "ERROR: .env.test not found in $SCRIPT_DIR" >&2
    exit 1
fi
set -a
source .env.test
set +a

PORT="${PORT:-3001}"
HOST="${HOST:-127.0.0.1}"
DB_BASE_PATH="${DB_BASE_PATH:-./mmpm-test-smoke-db}"
MMPM_BASE_URL="${MMPM_BASE_URL:-http://${HOST}:${PORT}}"

# ── 2. Clean any leftover DB from a previous run ────────────────────────────
rm -rf "$DB_BASE_PATH"

# ── 3. Start the server in the background ───────────────────────────────────
echo "→ Starting MMPM server on ${HOST}:${PORT} ..."
npx ts-node src/server.ts &
SERVER_PID=$!

# Ensure the server is killed on exit (including errors)
cleanup() {
    echo ""
    echo "→ Stopping server (PID $SERVER_PID) ..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    rm -rf "$DB_BASE_PATH"
}
trap cleanup EXIT

# ── 4. Wait for the server to become ready (poll /metrics) ──────────────────
echo "→ Waiting for server to be ready ..."
RETRIES=20
until curl -sf "${MMPM_BASE_URL}/metrics" > /dev/null 2>&1; do
    RETRIES=$((RETRIES - 1))
    if [[ $RETRIES -le 0 ]]; then
        echo "ERROR: Server did not become ready in time." >&2
        exit 1
    fi
    sleep 0.5
done
echo "→ Server ready."
echo ""

# ── 5. Run the smoke test script ────────────────────────────────────────────
bash test-api.sh "$MMPM_BASE_URL" "${MMPM_API_KEY:-}"
