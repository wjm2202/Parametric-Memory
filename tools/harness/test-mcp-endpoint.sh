#!/bin/bash
# MCP Endpoint Integration Test — tests Streamable HTTP MCP transport
# Works against local or remote MMPM MCP server
#
# Usage:
#   MCP_URL=https://mmpm.co.nz MCP_AUTH_KEY=mcp_xxx bash test-mcp-endpoint.sh
#
# The script tests:
#   1. OAuth metadata discovery
#   2. MCP session init (initialize) via static bearer
#   3. MCP tool call (memory_health) via the session
#   4. MCP session cleanup (DELETE)

MCP_URL="${MCP_URL:-http://127.0.0.1:3001}"
MCP_AUTH_KEY="${MCP_AUTH_KEY:-}"

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
echo "  MMPM MCP Endpoint Test Suite"
echo "  Server: $MCP_URL"
echo "═══════════════════════════════════════════════════"

# ─── PART 1: OAuth Metadata ───
echo ""
echo "▸ PART 1: OAuth Discovery"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$MCP_URL/.well-known/oauth-authorization-server")
check "GET /.well-known/oauth-authorization-server" 200 "$CODE"

ISSUER=$(curl -s "$MCP_URL/.well-known/oauth-authorization-server" | python3 -c "import sys,json; print(json.load(sys.stdin).get('issuer',''))" 2>/dev/null)
[ -n "$ISSUER" ] && pass "OAuth issuer present: $ISSUER" || fail "OAuth issuer" "missing"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$MCP_URL/health")
check "GET /health" 200 "$CODE"

# ─── PART 2: MCP Session Init (Static Bearer) ───
echo ""
echo "▸ PART 2: MCP Session — Initialize"

if [ -z "$MCP_AUTH_KEY" ]; then
  echo "  ⚠️  No MCP_AUTH_KEY set, skipping static bearer tests"
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  RESULTS: $PASS passed / $FAIL failed / $((PASS+FAIL)) total"
  echo "═══════════════════════════════════════════════════"
  exit 0
fi

# JSON-RPC initialize request
INIT_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "mcp-test-script", "version": "1.0.0" }
    }
  }')

INIT_CODE=$(echo "$INIT_RESPONSE" | tail -1)
INIT_BODY=$(echo "$INIT_RESPONSE" | sed '$d')
check "POST /mcp initialize" 200 "$INIT_CODE"

# Extract session ID from response header
SESSION_ID=$(curl -s -D - -o /dev/null \
  -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer $MCP_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "mcp-test-session", "version": "1.0.0" }
    }
  }' | grep -i 'mcp-session-id' | tr -d '\r' | awk '{print $2}')

if [ -n "$SESSION_ID" ]; then
  pass "Session ID returned: $SESSION_ID"
else
  fail "Session ID" "not returned in headers"
fi

# Check server capabilities in init response
echo "$INIT_BODY" | grep -q '"tools"' && pass "Server advertises tools capability" || fail "Server tools capability" "missing"

# ─── PART 3: MCP Tool Call — memory_health ───
echo ""
echo "▸ PART 3: MCP Tool Call (memory_health)"

if [ -n "$SESSION_ID" ]; then
  # Send initialized notification first
  curl -s -o /dev/null \
    -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_AUTH_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    -d '{
      "jsonrpc": "2.0",
      "method": "notifications/initialized"
    }'

  # List tools
  TOOLS_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_AUTH_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    -d '{
      "jsonrpc": "2.0",
      "id": 3,
      "method": "tools/list"
    }')

  TOOLS_CODE=$(echo "$TOOLS_RESPONSE" | tail -1)
  TOOLS_BODY=$(echo "$TOOLS_RESPONSE" | sed '$d')
  check "POST /mcp tools/list" 200 "$TOOLS_CODE"

  TOOL_COUNT=$(echo "$TOOLS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result',{}).get('tools',[])))" 2>/dev/null || echo "0")
  [ "$TOOL_COUNT" -gt 0 ] && pass "Server exposes $TOOL_COUNT tools" || fail "Tool count" "0 tools found"

  # Call memory_health
  HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_AUTH_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    -d '{
      "jsonrpc": "2.0",
      "id": 4,
      "method": "tools/call",
      "params": {
        "name": "memory_health",
        "arguments": {}
      }
    }')

  HEALTH_CODE=$(echo "$HEALTH_RESPONSE" | tail -1)
  HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | sed '$d')
  check "POST /mcp tools/call(memory_health)" 200 "$HEALTH_CODE"
  echo "$HEALTH_BODY" | grep -q "shard" && pass "memory_health returned shard data" || fail "memory_health body" "no shard data"

  # Call memory_atoms_list
  ATOMS_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_AUTH_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $SESSION_ID" \
    -d '{
      "jsonrpc": "2.0",
      "id": 5,
      "method": "tools/call",
      "params": {
        "name": "memory_atoms_list",
        "arguments": {"limit": 3}
      }
    }')

  ATOMS_CODE=$(echo "$ATOMS_RESPONSE" | tail -1)
  ATOMS_BODY=$(echo "$ATOMS_RESPONSE" | sed '$d')
  check "POST /mcp tools/call(memory_atoms_list)" 200 "$ATOMS_CODE"
  echo "$ATOMS_BODY" | grep -q "v1\." && pass "memory_atoms_list returned atoms" || fail "memory_atoms_list" "no atoms"

  # ─── PART 4: Session Cleanup ───
  echo ""
  echo "▸ PART 4: Session Cleanup"

  CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X DELETE "$MCP_URL/mcp" \
    -H "Authorization: Bearer $MCP_AUTH_KEY" \
    -H "Mcp-Session-Id: $SESSION_ID")
  check "DELETE /mcp (close session)" 200 "$CODE"

else
  echo "  ⚠️  Skipping tool calls — no session ID"
fi

# ─── PART 5: Auth Rejection ───
echo ""
echo "▸ PART 5: Auth Edge Cases"

CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$MCP_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}')
check "POST /mcp (no auth) → 401" 401 "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$MCP_URL/mcp" \
  -H "Authorization: Bearer bad_token_xxx" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}')
check "POST /mcp (bad token) → 401" 401 "$CODE"

# ═══════════════════════════════════════════════════
TOTAL=$((PASS+FAIL))
echo ""
echo "═══════════════════════════════════════════════════"
echo "  RESULTS: $PASS passed / $FAIL failed / $TOTAL total"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "  🎉 All MCP endpoint tests passed!"
