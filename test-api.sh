#!/usr/bin/env bash
# MMPM API Smoke Test — sharded API (/access, /train, /metrics)
#
# Usage (standalone):
#   ./test-api.sh [base_url] [api_key]
#   ./test-api.sh http://localhost:3000 my-secret
#
# Usage via npm (reads from .env.test automatically):
#   npm run test:smoke

# Load .env.test when invoked without explicit arguments (e.g. via npm run)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env.test" && -z "${1:-}" ]]; then
    set -a
    # shellcheck source=.env.test
    source "$SCRIPT_DIR/.env.test"
    set +a
fi

BASE="${1:-${MMPM_BASE_URL:-http://localhost:3000}}"
API_KEY="${2:-${MMPM_API_KEY:-}}"
PASS=0
FAIL=0

check() {
    local label="$1"
    local expected="$2"
    local actual="$3"
    if echo "$actual" | grep -q "$expected"; then
        echo "  ✓ $label"
        PASS=$((PASS + 1))
    else
        echo "  ✗ $label"
        echo "    Expected to find: $expected"
        echo "    Got: $actual"
        FAIL=$((FAIL + 1))
    fi
}

# Build auth header array (empty when no key is configured)
AUTH_ARGS=()
[[ -n "$API_KEY" ]] && AUTH_ARGS=(-H "Authorization: Bearer $API_KEY")

echo "=== MMPM Smoke Test: $BASE ==="
echo ""

# ── 1. Train a known sequence ───────────────────────────────────────────────
echo "[1] POST /train  (NodeA → NodeB → NodeC → NodeD)"
RES=$(curl -s -X POST "$BASE/train" \
    -H "Content-Type: application/json" \
    "${AUTH_ARGS[@]}" \
    -d '{"sequence":["NodeA","NodeB","NodeC","NodeD"]}')
check "status is Success"     '"status":"Success"' "$RES"
check "message field present" '"message"'          "$RES"

# ── 2. Access — verify report shape ─────────────────────────────────────────
echo "[2] POST /access  (NodeA — report shape)"
RES=$(curl -s -X POST "$BASE/access" \
    -H "Content-Type: application/json" \
    "${AUTH_ARGS[@]}" \
    -d '{"data":"NodeA"}')
check "currentData returned"  '"currentData":"NodeA"' "$RES"
check "currentProof present"  '"currentProof"'        "$RES"
check "latencyMs present"     '"latencyMs"'           "$RES"

# ── 3. Access — Markov prediction fires after training ──────────────────────
echo "[3] POST /access  (NodeA — prediction after training)"
RES=$(curl -s -X POST "$BASE/access" \
    -H "Content-Type: application/json" \
    "${AUTH_ARGS[@]}" \
    -d '{"data":"NodeA"}')
check "predictedNext is NodeB"  '"predictedNext":"NodeB"' "$RES"
check "predictedProof present"  '"predictedProof"'        "$RES"

# ── 4. Validation — missing data field returns 400 ──────────────────────────
echo "[4] POST /access  (missing data field → 400)"
RES=$(curl -s -X POST "$BASE/access" \
    -H "Content-Type: application/json" \
    "${AUTH_ARGS[@]}" \
    -d '{}')
check "error field present" '"error"' "$RES"

# ── 5. Validation — unknown atom returns 404 ────────────────────────────────
echo "[5] POST /access  (unknown atom → 404)"
RES=$(curl -s -X POST "$BASE/access" \
    -H "Content-Type: application/json" \
    "${AUTH_ARGS[@]}" \
    -d '{"data":"DOES_NOT_EXIST_XYZ"}')
check "error field present" '"error"' "$RES"

# ── 6. Validation — /train with non-array sequence returns 400 ───────────────
echo "[6] POST /train  (non-array sequence → 400)"
RES=$(curl -s -X POST "$BASE/train" \
    -H "Content-Type: application/json" \
    "${AUTH_ARGS[@]}" \
    -d '{"sequence":"not-an-array"}')
check "error field present" '"error"' "$RES"

# ── 7. Prometheus metrics endpoint ──────────────────────────────────────────
echo "[7] GET /metrics"
RES=$(curl -s "$BASE/metrics")
check "nodejs heap metric"  'nodejs_heap_size_total_bytes'  "$RES"
check "process cpu metric"  'process_cpu_seconds_total'     "$RES"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
