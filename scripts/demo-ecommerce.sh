#!/usr/bin/env bash
# =============================================================================
#  MMPM Use-Case Demo — E-Commerce Navigation Prediction
# =============================================================================
#
#  Scenario:
#    An e-commerce platform captures anonymised page-visit sequences from user
#    sessions.  MMPM is trained on those sequences so it can:
#      1. Predict the most likely next page for any current page.
#      2. Pre-fetch a cryptographic Merkle proof for that prediction so the
#         client can verify data integrity at zero extra round-trip cost.
#      3. Expose per-atom confidence scores (dominance ratio) so the UI can
#         decide whether a recommendation is worth surfacing.
#
#  What this script does:
#    Phase 1  — Uploads 20 representative user-session sequences.
#    Phase 2  — Queries each key page atom and prints:
#                 • predicted next page
#                 • dominance ratio (prediction confidence 0–1)
#                 • Merkle proof depth (audit path length)
#    Phase 3  — Queries /weights for two high-traffic atoms to show full
#               outgoing transition tables.
#
#  Prerequisites:
#    • MMPM server running (npm start  OR  docker compose up)
#    • curl, jq, python3 (all stock on macOS)
#
#  Usage:
#    ./demo-ecommerce.sh [base_url] [api_key]
#    ./demo-ecommerce.sh                          # defaults to localhost:3000
#    ./demo-ecommerce.sh http://localhost:3000 my-secret
# =============================================================================

set -eo pipefail

BASE="${1:-http://localhost:3000}"
API_KEY="${2:-}"
AUTH_ARGS=()
[[ -n "$API_KEY" ]] && AUTH_ARGS=(-H "Authorization: Bearer $API_KEY")

# ---------------------------------------------------------------------------
# All atoms used in the demo sequences — the server must know them at startup
# so the Merkle tree is built with the full atom universe.
# ---------------------------------------------------------------------------
DEMO_ATOMS="home,category:electronics,category:clothing,search,\
product:laptop,product:phone,product:tshirt,product:jeans,\
cart,checkout,payment,confirmation,wishlist,returns,refund"

# If the server isn't already running with our atoms, start it fresh.
_start_server() {
    local script_dir; script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    echo -e "  Starting MMPM server with e-commerce atom universe…"
    # Kill anything already on port 3000 so we own the process
    kill "$(lsof -ti tcp:3000)" 2>/dev/null || true
    sleep 0.5
    # Wipe the demo db so every run starts from a clean state
    rm -rf "$script_dir/mmpm-demo-db"
    # Use compiled dist if present; fall back to ts-node for dev environments
    local server_cmd
    if [[ -f "$script_dir/dist/server.js" ]]; then
        server_cmd="node $script_dir/dist/server.js"
    else
        echo -e "  Compiling TypeScript first…"
        (cd "$script_dir" && npm run build &>/tmp/mmpm-demo-build.log) \
            || { echo "  Build failed. See /tmp/mmpm-demo-build.log" >&2; exit 1; }
        server_cmd="node $script_dir/dist/server.js"
    fi
    MMPM_INITIAL_DATA="$DEMO_ATOMS" \
    DB_BASE_PATH="$script_dir/mmpm-demo-db" \
    SHARD_COUNT=4 \
        $server_cmd \
        &>/tmp/mmpm-demo-server.log &
    SERVER_PID=$!
    # Wait up to 10 s for the /metrics endpoint to respond
    local i=0
    while (( i < 20 )); do
        sleep 0.5
        if curl -sf "$BASE/metrics" &>/dev/null; then
            echo -e "  Server ready (PID $SERVER_PID)"
            return 0
        fi
        (( i++ ))
    done
    echo "  ERROR: server did not start. Logs: /tmp/mmpm-demo-server.log" >&2
    exit 1
}

# Only spin up a server when the script is managing its own lifecycle
# (i.e. BASE is the default localhost:3000 and no external server is detected)
if [[ "$BASE" == "http://localhost:3000" ]] && ! curl -sf "$BASE/metrics" &>/dev/null; then
    _start_server
fi

# Colour helpers (graceful fallback when not in a TTY)
if [[ -t 1 ]]; then
    BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
    YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
    BOLD=''; GREEN=''; CYAN=''; YELLOW=''; RED=''; RESET=''
fi

header() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }
ok()     { echo -e "  ${GREEN}✓${RESET}  $*"; }
info()   { echo -e "  ${YELLOW}→${RESET}  $*"; }
err()    { echo -e "  ${RED}✗${RESET}  $*"; }

train() {
    local label="$1"; shift
    # Build JSON array from remaining args
    local json
    json=$(python3 -c "import json,sys; print(json.dumps({'sequence':sys.argv[1:]}))" "$@")
    local res
    res=$(curl -s -X POST "$BASE/train" \
        -H "Content-Type: application/json" \
        "${AUTH_ARGS[@]}" \
        -d "$json")
    if echo "$res" | grep -q '"Success"'; then
        ok "$label"
    else
        err "$label  →  $res"
    fi
}

access_atom() {
    local atom="$1"
    local res
    res=$(curl -s -X POST "$BASE/access" \
        -H "Content-Type: application/json" \
        "${AUTH_ARGS[@]}" \
        -d "{\"data\":\"$atom\"}")

    local predicted proof_depth latency
    predicted=$(echo "$res" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('predictedNext') or '(none)')")
    proof_depth=$(echo "$res" | python3 -c "
import json,sys
d=json.load(sys.stdin)
pp=d.get('predictedProof')
print(len(pp['auditPath']) if pp else 0)
")
    latency=$(echo "$res" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"{d.get('latencyMs',0):.2f}ms\")")
    echo -e "  ${CYAN}${atom}${RESET}  →  predicted: ${BOLD}${predicted}${RESET}   proof-depth: ${proof_depth}   latency: ${latency}"
}

weights_atom() {
    local atom="$1"
    local res
    res=$(curl -s "${AUTH_ARGS[@]}" "$BASE/weights/$atom")
    echo -e "\n  ${BOLD}Outgoing transitions from '${atom}'${RESET}"
    echo "$res" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'error' in d:
    print('    error:', d['error'])
    sys.exit()
total = d.get('totalWeight', 1)
ratio = d.get('dominanceRatio')
print(f\"    dominanceRatio (confidence): {ratio:.2f}\" if ratio is not None else '    dominanceRatio: n/a')
print(f\"    totalWeight : {total}\")
print(f\"    transitions :\")
for t in d.get('transitions', []):
    bar = '█' * int(t['weight'] / total * 20)
    pct = t['weight'] / total * 100
    print(f\"      {t['to']:<28}  {pct:5.1f}%  {bar}\")
"
}

# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}MMPM E-Commerce Navigation Demo${RESET}  —  ${BASE}"

# ── Phase 1: Upload training data ────────────────────────────────────────────
header "Phase 1 — Training on 20 user-session sequences"

# Happy-path buyers (laptop journey)
train "Session  1: home → electronics → laptop → cart → checkout → payment → confirmation" \
    home category:electronics product:laptop cart checkout payment confirmation

train "Session  2: home → electronics → laptop → cart → checkout → payment → confirmation" \
    home category:electronics product:laptop cart checkout payment confirmation

train "Session  3: home → electronics → laptop → cart → checkout → payment → confirmation" \
    home category:electronics product:laptop cart checkout payment confirmation

train "Session  4: home → search → laptop → cart → checkout → payment → confirmation" \
    home search product:laptop cart checkout payment confirmation

train "Session  5: home → search → laptop → cart → checkout → payment → confirmation" \
    home search product:laptop cart checkout payment confirmation

# Happy-path buyers (phone journey)
train "Session  6: home → electronics → phone → cart → checkout → payment → confirmation" \
    home category:electronics product:phone cart checkout payment confirmation

train "Session  7: home → electronics → phone → cart → checkout → payment → confirmation" \
    home category:electronics product:phone cart checkout payment confirmation

# Browse-then-buy (laptop then phone comparison)
train "Session  8: home → electronics → laptop → phone → laptop → cart → checkout → payment → confirmation" \
    home category:electronics product:laptop product:phone product:laptop cart checkout payment confirmation

train "Session  9: home → electronics → laptop → phone → cart → checkout → payment → confirmation" \
    home category:electronics product:laptop product:phone cart checkout payment confirmation

# Clothing happy path
train "Session 10: home → clothing → t-shirt → cart → checkout → payment → confirmation" \
    home category:clothing product:tshirt cart checkout payment confirmation

train "Session 11: home → clothing → t-shirt → cart → checkout → payment → confirmation" \
    home category:clothing product:tshirt cart checkout payment confirmation

train "Session 12: home → clothing → jeans → cart → checkout → payment → confirmation" \
    home category:clothing product:jeans cart checkout payment confirmation

# Drop-offs (payment friction — user leaves at payment step)
train "Session 13: home → electronics → laptop → cart → checkout → payment (drop)" \
    home category:electronics product:laptop cart checkout payment

train "Session 14: home → electronics → phone → cart → checkout → payment (drop)" \
    home category:electronics product:phone cart checkout payment

# Wishlist / browse-only
train "Session 15: home → electronics → laptop → wishlist" \
    home category:electronics product:laptop wishlist

train "Session 16: home → clothing → t-shirt → wishlist" \
    home category:clothing product:tshirt wishlist

# Search-driven journeys
train "Session 17: home → search → phone → cart → checkout → payment → confirmation" \
    home search product:phone cart checkout payment confirmation

train "Session 18: home → search → jeans → cart → checkout → payment → confirmation" \
    home search product:jeans cart checkout payment confirmation

# Returns
train "Session 19: confirmation → returns → refund" \
    confirmation returns refund

# Cross-sell upsell
train "Session 20: product:laptop → product:phone → product:laptop → cart → checkout → payment → confirmation" \
    product:laptop product:phone product:laptop cart checkout payment confirmation

# ── Phase 2: Access key atoms — predictions + proof depths ───────────────────
header "Phase 2 — Access predictions for key page atoms"
echo -e "  ${YELLOW}(predicted next page, Merkle proof depth, latency)${RESET}\n"

for atom in \
    "home" \
    "category:electronics" \
    "category:clothing" \
    "search" \
    "product:laptop" \
    "product:phone" \
    "product:tshirt" \
    "product:jeans" \
    "cart" \
    "checkout" \
    "payment" \
    "confirmation" \
    "wishlist"
do
    access_atom "$atom"
done

# ── Phase 3: Inspect transition weight tables ─────────────────────────────────
header "Phase 3 — Transition weight tables (confidence breakdown)"

weights_atom "cart"
weights_atom "payment"
weights_atom "category:electronics"
weights_atom "product:laptop"

# ── Summary ───────────────────────────────────────────────────────────────────
header "Done"
echo -e "  All atoms carry cryptographic Merkle proofs (SHA-256, O(log N) verification)."
echo -e "  dominanceRatio ≥ 0.7 → high-confidence recommendation safe to surface in UI."
echo -e "  dominanceRatio  < 0.5 → ambiguous path; consider A/B personalisation instead."
echo ""
