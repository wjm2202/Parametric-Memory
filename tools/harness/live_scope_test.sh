#!/bin/bash
# Live Integration Test — MMPM Local Server
# Tests MASTER and READ-ONLY client against http://127.0.0.1:3000

BASE="http://127.0.0.1:3000"
MASTER_KEY="mmk_test_master_key_12345"
READ_KEY="mmk_test_read_key_67890"
MASTER_AUTH="Bearer $MASTER_KEY"
READ_AUTH="Bearer $READ_KEY"

PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1: $2"; }

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label" "expected $expected, got $actual"
  fi
}

echo ""
echo "═══════════════════════════════════════════════════"
echo "  MMPM Live Integration Test Suite"
echo "  Server: $BASE"
echo "═══════════════════════════════════════════════════"

# ─── PART 1: Health & Probes ───
echo ""
echo "▸ PART 1: Health & Probes (no auth required)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
check "GET /health" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/ready")
check "GET /ready" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/metrics")
check "GET /metrics (with auth)" 200 "$CODE"

# ─── PART 2: Auth Edge Cases ───
echo ""
echo "▸ PART 2: Auth Edge Cases"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/atoms")
check "GET /atoms (no auth) → 401" 401 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer bad_key" "$BASE/atoms")
check "GET /atoms (bad key) → 401" 401 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Basic dXNlcjpwYXNz" "$BASE/atoms")
check "GET /atoms (Basic auth) → 401" 401 "$CODE"

# ─── PART 3: Master — Full MCP Checkpoint Flow ───
echo ""
echo "▸ PART 3: Master — MCP Checkpoint Flow"
echo "  (POST /atoms → POST /admin/commit → POST /train → POST /admin/commit)"

# Step 1: Add atoms (atoms are plain strings)
BODY=$(curl -s -X POST "$BASE/atoms" \
  -H "Authorization: $MASTER_AUTH" -H "Content-Type: application/json" \
  -d '{"atoms":["v1.fact.live_test_alpha","v1.fact.live_test_beta","v1.fact.live_test_gamma"]}')
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/atoms" \
  -H "Authorization: $MASTER_AUTH" -H "Content-Type: application/json" \
  -d '{"atoms":["v1.fact.live_test_alpha","v1.fact.live_test_beta","v1.fact.live_test_gamma"]}')
check "Master: POST /atoms (add 3 atoms)" 200 "$CODE"
echo "$BODY" | grep -q "Queued" && pass "Master: atoms queued" || fail "Master: atoms queued" "$BODY"

# Step 2: First commit
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/commit" \
  -H "Authorization: $MASTER_AUTH" -H "Content-Type: application/json" -d '{}')
check "Master: POST /admin/commit (1st)" 200 "$CODE"

# Step 3: Train (uses 'sequence' not 'atoms', no 'passes')
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/train" \
  -H "Authorization: $MASTER_AUTH" -H "Content-Type: application/json" \
  -d '{"sequence":["v1.fact.live_test_alpha","v1.fact.live_test_beta"]}')
check "Master: POST /train (sequence)" 200 "$CODE"

# Train again for extra weight
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/train" \
  -H "Authorization: $MASTER_AUTH" -H "Content-Type: application/json" \
  -d '{"sequence":["v1.fact.live_test_alpha","v1.fact.live_test_beta"]}')
check "Master: POST /train (2nd pass)" 200 "$CODE"

# Step 4: Second commit
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/commit" \
  -H "Authorization: $MASTER_AUTH" -H "Content-Type: application/json" -d '{}')
check "Master: POST /admin/commit (2nd)" 200 "$CODE"

# ─── PART 4: Master — Read Endpoints ───
echo ""
echo "▸ PART 4: Master — Read Endpoints"

# List atoms
BODY=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/atoms")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/atoms")
check "Master: GET /atoms" 200 "$CODE"
echo "$BODY" | grep -q "live_test_alpha" && pass "Master: atoms list has live_test_alpha" || fail "Master: atoms list has live_test_alpha" "missing"

# Atom detail
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/atoms/v1.fact.live_test_alpha")
check "Master: GET /atoms/:atom" 200 "$CODE"

# Access (uses 'data' not 'item')
BODY=$(curl -s -H "Authorization: $MASTER_AUTH" -X POST "$BASE/access" \
  -H "Content-Type: application/json" -d '{"data":"v1.fact.live_test_alpha"}')
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" -X POST "$BASE/access" \
  -H "Content-Type: application/json" -d '{"data":"v1.fact.live_test_alpha"}')
check "Master: POST /access" 200 "$CODE"
echo "$BODY" | grep -q "currentProof" && pass "Master: access has currentProof" || fail "Master: access has currentProof" "missing"
echo "$BODY" | grep -q "predictedNext" && pass "Master: access has predictedNext" || fail "Master: access has predictedNext" "missing"

# Batch access
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" -X POST "$BASE/batch-access" \
  -H "Content-Type: application/json" -d '{"items":["v1.fact.live_test_alpha","v1.fact.live_test_beta"]}')
check "Master: POST /batch-access" 200 "$CODE"

# Search
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" -X POST "$BASE/search" \
  -H "Content-Type: application/json" -d '{"query":"live test","limit":5}')
check "Master: POST /search" 200 "$CODE"

# Weights
BODY=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/weights/v1.fact.live_test_alpha")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/weights/v1.fact.live_test_alpha")
check "Master: GET /weights/:atom" 200 "$CODE"
echo "$BODY" | grep -q '"weight"' && pass "Master: weights has weight field" || fail "Master: weights has weight field" "$BODY"

# Policy
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/policy")
check "Master: GET /policy" 200 "$CODE"

# Write policy
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/write-policy")
check "Master: GET /write-policy" 200 "$CODE"

# Export
BODY=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/admin/export")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/admin/export")
check "Master: GET /admin/export" 200 "$CODE"
echo "$BODY" | grep -q "live_test_alpha" && pass "Master: export has test atom" || fail "Master: export has test atom" "missing"

# Audit log (correct route: /admin/audit-log)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/admin/audit-log?limit=10")
check "Master: GET /admin/audit-log" 200 "$CODE"

# Tree head (correct route: /tree-head)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/tree-head")
check "Master: GET /tree-head" 200 "$CODE"

# Consistency (correct route: /verify-consistency)
# verify-consistency needs both fromVersion AND toVersion
TV=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/tree-head" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',1))" 2>/dev/null)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" -X POST "$BASE/verify-consistency" \
  -H "Content-Type: application/json" -d "{\"fromVersion\":1,\"toVersion\":$TV}")
check "Master: POST /verify-consistency" 200 "$CODE"

# Memory context
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $MASTER_AUTH" "$BASE/memory/context?objective=test&maxTokens=500")
check "Master: GET /memory/context" 200 "$CODE"

# ─── PART 5: Master — Tombstone ───
echo ""
echo "▸ PART 5: Master — Tombstone"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/atoms/v1.fact.live_test_gamma" \
  -H "Authorization: $MASTER_AUTH")
check "Master: DELETE /atoms/:atom" 200 "$CODE"

# Tombstoned atoms show status:tombstoned in list (not fully removed)
BODY=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/atoms")
echo "$BODY" | grep -q '"tombstoned"' && pass "Master: tombstoned atom marked with status:tombstoned" || fail "Master: tombstone status missing" ""

# ─── PART 6: Read-Only — Write Blocks ───
echo ""
echo "▸ PART 6: Read-Only Client — Write Blocks (expect 403)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/atoms" \
  -H "Authorization: $READ_AUTH" -H "Content-Type: application/json" -d '{"atoms":["v1.fact.blocked"]}')
check "Read: POST /atoms → 403" 403 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/train" \
  -H "Authorization: $READ_AUTH" -H "Content-Type: application/json" -d '{"sequence":["v1.fact.a","v1.fact.b"]}')
check "Read: POST /train → 403" 403 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/commit" \
  -H "Authorization: $READ_AUTH" -H "Content-Type: application/json" -d '{}')
check "Read: POST /admin/commit → 403" 403 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/atoms/v1.fact.live_test_alpha" \
  -H "Authorization: $READ_AUTH")
check "Read: DELETE /atoms/:atom → 403" 403 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/policy" \
  -H "Authorization: $READ_AUTH" -H "Content-Type: application/json" -d '{}')
check "Read: POST /policy → 403" 403 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/write-policy" \
  -H "Authorization: $READ_AUTH" -H "Content-Type: application/json" -d '{}')
check "Read: POST /write-policy → 403" 403 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/import" \
  -H "Authorization: $READ_AUTH" -H "Content-Type: text/plain" -d '{}')
check "Read: POST /admin/import → 403" 403 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/import-full" \
  -H "Authorization: $READ_AUTH" -H "Content-Type: text/plain" -d '{}')
check "Read: POST /admin/import-full → 403" 403 "$CODE"

# Verify 403 body structure
BODY=$(curl -s -X POST "$BASE/atoms" \
  -H "Authorization: $READ_AUTH" -H "Content-Type: application/json" -d '{"atoms":["v1.fact.x"]}')
echo "$BODY" | grep -q '"scope":"read"' && pass "Read: 403 body has scope:read" || fail "Read: 403 body has scope:read" "$BODY"
echo "$BODY" | grep -q '"requiredScope":"master"' && pass "Read: 403 body has requiredScope:master" || fail "Read: 403 body has requiredScope:master" "$BODY"

# ─── PART 7: Read-Only — Read Access ───
echo ""
echo "▸ PART 7: Read-Only Client — Read Access (expect 200)"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" "$BASE/atoms")
check "Read: GET /atoms" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" "$BASE/atoms/v1.fact.live_test_alpha")
check "Read: GET /atoms/:atom" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" -X POST "$BASE/access" \
  -H "Content-Type: application/json" -d '{"data":"v1.fact.live_test_alpha"}')
check "Read: POST /access" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" -X POST "$BASE/batch-access" \
  -H "Content-Type: application/json" -d '{"items":["v1.fact.live_test_alpha"]}')
check "Read: POST /batch-access" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" -X POST "$BASE/search" \
  -H "Content-Type: application/json" -d '{"query":"live test","limit":5}')
check "Read: POST /search" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" "$BASE/weights/v1.fact.live_test_alpha")
check "Read: GET /weights/:atom" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" "$BASE/policy")
check "Read: GET /policy" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" "$BASE/write-policy")
check "Read: GET /write-policy" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" "$BASE/admin/export")
check "Read: GET /admin/export" 200 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: $READ_AUTH" "$BASE/admin/audit-log?limit=10")
check "Read: GET /admin/audit-log" 200 "$CODE"

# Read client can see what master wrote
BODY=$(curl -s -H "Authorization: $READ_AUTH" "$BASE/atoms")
echo "$BODY" | grep -q "live_test_alpha" && pass "Read: can see master's atoms" || fail "Read: can see master's atoms" "missing"

# ─── PART 8: Zero-Mutation Proof ───
echo ""
echo "▸ PART 8: Zero-Mutation Proof (10 read accesses → no weight/tree change)"

# Snapshot before
W_BEFORE=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/weights/v1.fact.live_test_alpha" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(sorted([(t['to'],t['weight']) for t in d.get('transitions',[])]))" 2>/dev/null)
TV_BEFORE=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/tree-head" | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null)
METRICS_BEFORE=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/metrics" | grep 'mmpm_train_total' | head -1)

# 10 read-client accesses
for i in $(seq 1 10); do
  curl -s -o /dev/null -X POST "$BASE/access" \
    -H "Authorization: $READ_AUTH" -H "Content-Type: application/json" \
    -d '{"data":"v1.fact.live_test_alpha"}'
done

# Snapshot after
W_AFTER=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/weights/v1.fact.live_test_alpha" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(sorted([(t['to'],t['weight']) for t in d.get('transitions',[])]))" 2>/dev/null)
TV_AFTER=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/tree-head" | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null)
METRICS_AFTER=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/metrics" | grep 'mmpm_train_total' | head -1)

[ "$W_BEFORE" = "$W_AFTER" ] && pass "Stable weights unchanged after 10 read accesses" || fail "Weights changed" "before=$W_BEFORE after=$W_AFTER"
[ "$TV_BEFORE" = "$TV_AFTER" ] && pass "Tree version unchanged ($TV_BEFORE → $TV_AFTER)" || fail "Tree version changed" "before=$TV_BEFORE after=$TV_AFTER"
[ "$METRICS_BEFORE" = "$METRICS_AFTER" ] && pass "Train counter unchanged" || fail "Train counter changed" "before=$METRICS_BEFORE after=$METRICS_AFTER"

# ─── PART 9: Audit Trail ───
echo ""
echo "▸ PART 9: Audit Trail Verification"

AUDIT=$(curl -s -H "Authorization: $MASTER_AUTH" "$BASE/admin/audit-log?limit=50")

MASTER_COUNT=$(echo "$AUDIT" | python3 -c "
import sys,json
d = json.load(sys.stdin)
entries = d.get('entries', d) if isinstance(d, dict) else d
print(len([e for e in entries if e.get('clientName') == 'default']))
" 2>/dev/null || echo "0")

[ "$MASTER_COUNT" -gt 0 ] && pass "Audit: $MASTER_COUNT master entries found" || fail "Audit: no master entries" ""

# Master write operations should be audited
WRITE_AUDITED=$(echo "$AUDIT" | python3 -c "
import sys,json
d = json.load(sys.stdin)
entries = d.get('entries', d) if isinstance(d, dict) else d
events = set(e.get('event') for e in entries if e.get('clientName') == 'default')
print(' '.join(sorted(events)))
" 2>/dev/null || echo "none")
echo "  ℹ️  Master audited events: $WRITE_AUDITED"

# Blocked read-client write ops should NOT appear in audit
BLOCKED_COUNT=$(echo "$AUDIT" | python3 -c "
import sys,json
d = json.load(sys.stdin)
entries = d.get('entries', d) if isinstance(d, dict) else d
print(len([e for e in entries if e.get('clientName') == 'test-viewer' and e.get('event') in ('write','train','commit','tombstone','import')]))
" 2>/dev/null || echo "0")

[ "$BLOCKED_COUNT" -eq 0 ] && pass "Audit: no blocked-op entries for read client" || fail "Audit: found blocked entries" "$BLOCKED_COUNT"

# ═══════════════════════════════════════════════════
TOTAL=$((PASS+FAIL))
echo ""
echo "═══════════════════════════════════════════════════"
echo "  RESULTS: $PASS passed / $FAIL failed / $TOTAL total"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "  🎉 All tests passed!"
