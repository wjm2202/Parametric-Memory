#!/usr/bin/env bash
# ── Restore project-context atoms to a running MMPM instance ──────────────────
#
# Usage (from repo root):
#   bash tools/restore-project-context.sh
#
# Reads memory/project-context.json and POSTs all atoms to the MMPM server.
# Idempotent — already-existing atoms are silently accepted.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTEXT_FILE="$REPO_ROOT/memory/project-context.json"

# Load .env if present
if [[ -f "$REPO_ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO_ROOT/.env"; set +a
fi

MMPM_URL="${MMPM_URL:-http://localhost:3000}"
MMPM_API_KEY="${MMPM_API_KEY:-}"

if [[ -z "$MMPM_API_KEY" ]]; then
  echo "ERROR: MMPM_API_KEY is not set. Add it to .env or export it." >&2
  exit 1
fi

if [[ ! -f "$CONTEXT_FILE" ]]; then
  echo "ERROR: $CONTEXT_FILE not found." >&2
  exit 1
fi

# Verify server is reachable
echo "→ Checking MMPM health at $MMPM_URL ..."
if ! curl -sf "$MMPM_URL/health" > /dev/null; then
  echo "ERROR: MMPM server not reachable at $MMPM_URL" >&2
  exit 1
fi
echo "  ✓ Server is up"

# Read all atoms from the JSON file (strip comments if any)
ATOM_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONTEXT_FILE','utf8')).length)")
echo "→ Loading $ATOM_COUNT atoms from memory/project-context.json ..."

# POST in a single batch
RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer $MMPM_API_KEY" \
  -H "Content-Type: application/json" \
  "$MMPM_URL/atoms" \
  -d "{\"atoms\": $(cat "$CONTEXT_FILE")}")

echo "  ✓ Atoms accepted"

# Commit to disk
echo "→ Committing to disk ..."
curl -sf -X POST \
  -H "Authorization: Bearer $MMPM_API_KEY" \
  "$MMPM_URL/admin/commit" > /dev/null
echo "  ✓ Committed"

# Verify
ACTIVE=$(curl -sf \
  -H "Authorization: Bearer $MMPM_API_KEY" \
  "$MMPM_URL/atoms?status=active&limit=500" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>console.log(JSON.parse(d).atoms?.length ?? 0));
  " 2>/dev/null || echo "?")

echo ""
echo "  Done. Active atoms in DB: $ACTIVE"
echo ""
echo "  To verify context was loaded:"
echo "    curl -s -H \"Authorization: Bearer \$MMPM_API_KEY\" $MMPM_URL/memory/context"
echo ""
