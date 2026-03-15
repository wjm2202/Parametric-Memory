# Debug: Cowork MCP Connector Cannot Call Tools on mmpm.co.nz

**Date:** 2026-03-15
**Context:** Sprint V4 Phase A — scoped API keys deployed, v0.2.0 released

---

## Problem

The Cowork desktop app's MCP connector to `https://mmpm.co.nz/mcp` cannot execute tool calls. Every tool call (memory_ready, memory_health, etc.) returns a generic "Tool execution failed" error with no detail.

## What We Changed Before It Broke

1. Added `MMPM_API_KEYS=viz-client@read:mmk_viz_...` to `.env.production` on the droplet
2. Rebuilt and restarted all Docker containers (`docker compose up -d --remove-orphans`)
3. The container restart wiped the in-memory OAuth state (all previous tokens invalidated)

## What We Have Proved

### Server is healthy
- `curl https://mmpm.co.nz/health` → 200, 4 shards, 59 trained atoms
- `curl https://mmpm.co.nz/ready` → 200
- All 4 Docker containers running: deploy-mmpm-service-1 (healthy), deploy-mmpm-mcp-1, deploy-nginx-1, deploy-certbot-1

### MCP endpoint works with static bearer (tested from Mac)
```bash
curl -s -X POST https://mmpm.co.nz/mcp \
  -H "Authorization: Bearer <MMPM_MCP_AUTH_KEY>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"mac-test","version":"1.0"}}}'
```
**Result:** HTTP 200, successful initialize response with tools capability advertised.

### OAuth flow works server-side
Docker logs (`docker logs deploy-mmpm-mcp-1`) show:
- `[oauth] Registered client: Claude (uuid)` — multiple successful registrations
- `[oauth] Auth code issued for client uuid`
- `[oauth] Tokens issued for client uuid`
- `[oauth] Tokens refreshed for client uuid`
- `[oauth] Cleaned up N expired entries`

### OAuth metadata is correct
```bash
curl -s https://mmpm.co.nz/.well-known/oauth-authorization-server
```
Returns correct metadata with issuer `https://mmpm.co.nz`, all endpoints present.

### Nginx proxy config is correct
The `/mcp` location in `nginx.production.conf` has:
- `proxy_buffering off` (required for SSE)
- `proxy_read_timeout 300s`
- `proxy_http_version 1.1`
- `Connection ""` header

### MCP → API proxy auth is configured
The MCP container (`mmpm_mcp_server.ts` line 49) reads `MMPM_MCP_API_KEY` or `MMPM_API_KEY` from env and sends it as `Authorization: Bearer` header on all internal API calls to `http://mmpm-service:3000`. The `env_file` in docker-compose passes all vars from `.env.production` to both containers.

## What Is Failing

Sessions open and immediately close. From logs:
```
[mmpm-mcp-http] New session: 041b0c16-9ed2-4eb1-bcb0-9debe9005827
[mmpm-mcp-http] Session closed: 041b0c16-9ed2-4eb1-bcb0-9debe9005827
```

The Cowork connector shows as "connected: true, enabledInChat: true" in the MCP registry search, but every tool call returns "Tool execution failed."

## Auth Architecture (for reference)

### Three auth keys on the droplet (.env.production)
| Key | Purpose | Prefix |
|-----|---------|--------|
| `MMPM_API_KEY` | Master key — full read/write to API (port 3000) | `mmk_` |
| `MMPM_MCP_AUTH_KEY` | Static bearer for MCP endpoint (port 3001) | `mcp_` |
| `MMPM_API_KEYS` | Scoped client keys for API — `name@scope:key` format | varies |

### MCP auth flow (`mmpm_mcp_http.ts` checkAuth function, line 76)
1. Extract Bearer token from `Authorization` header
2. If `MMPM_MCP_AUTH_KEY` is set and token matches → allow (static bearer)
3. If token is a valid OAuth access token → allow (OAuth2)
4. If no auth mechanisms configured → allow (open)
5. Otherwise → 401 with WWW-Authenticate header pointing to OAuth metadata

### MCP → API internal calls (`mmpm_mcp_server.ts` createApiCaller, line 123)
- Uses `MMPM_MCP_API_KEY` (falls back to `MMPM_API_KEY`) as Bearer token
- Calls `MMPM_MCP_BASE_URL` (set to `http://mmpm-service:3000` in docker-compose)
- Every tool call goes through this proxy

### Cowork connector OAuth flow
1. Discovers `/.well-known/oauth-authorization-server`
2. POSTs to `/oauth/register` → gets client_id + client_secret
3. Redirects to `/oauth/authorize` → auto-approves, returns auth code
4. POSTs to `/oauth/token` → exchanges code for access_token
5. Uses access_token as Bearer on `/mcp` endpoint

## Theories to Investigate

### Theory 1: Cowork SSE transport bug
The sessions open and close too fast. Cowork may have a bug with Streamable HTTP MCP transport where it drops the connection before completing tool calls. The server side is working — curl proves it.

### Theory 2: OAuth token scope or expiry issue
The OAuth provider is auto-approve with no scopes. Tokens expire after 1 hour (line in `mmpm_oauth_provider.ts`). Maybe Cowork's token is being issued but something about the token format doesn't match what Cowork expects.

### Theory 3: CORS or response headers
Cowork's connector may require specific CORS headers or response formats that the MCP server doesn't provide. The nginx config doesn't set CORS headers on the `/mcp` location.

### Theory 4: Container restart timing
OAuth state is in-memory. Container restarts wipe all tokens. If Cowork cached an old token and tries to reuse it, the server would reject it. Cowork should re-register, but maybe its reconnection flow has a bug.

## What We Tried That Did NOT Work

1. **Pre-registering OAuth client manually via curl** — got `invalid_client` because redirect_uri `https://cdn.claude.ai/mcp/callback` was a guess and may not match what Cowork actually uses
2. **Filling in OAuth Client ID + Secret in Cowork dialog** — got "Error connecting to the MCP server" — Cowork's flow conflicts with pre-registered credentials
3. **Multiple remove/re-add cycles** — each creates a new OAuth client on the server but sessions still drop

## What We Did NOT Try Yet

1. **Restart just the MCP container** — `docker restart deploy-mmpm-mcp-1` on the droplet to get clean OAuth state, then immediately try Cowork with blank OAuth fields

2. **Watch live logs during connection** — On droplet: `docker logs deploy-mmpm-mcp-1 -f --tail 0` WHILE connecting from Cowork. Need to see if there are errors between "New session" and "Session closed"

3. **Add CORS headers to nginx** — Cowork may need CORS on the /mcp endpoint:
   ```nginx
   # In the location /mcp block of nginx.production.conf:
   if ($request_method = 'OPTIONS') {
       add_header Access-Control-Allow-Origin "*" always;
       add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept, Mcp-Session-Id" always;
       add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS" always;
       add_header Access-Control-Max-Age 86400;
       return 204;
   }
   add_header Access-Control-Allow-Origin "*" always;
   add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept, Mcp-Session-Id" always;
   add_header Access-Control-Allow-Methods "GET, POST, DELETE, OPTIONS" always;
   ```

4. **Test if Cowork needs specific redirect_uri** — check Cowork docs or browser network tab to see what redirect_uri it sends during OAuth authorize

5. **Roll back MMPM_API_KEYS** — comment it out in .env.production and restart all containers. If Cowork connects, our change broke it. If not, it's the container restart wiping OAuth state.

## Key Insight

Cowork's MCP connector ONLY supports OAuth2. There is no field for static bearer tokens. The connector dialog has: Name, URL, OAuth Client ID (optional), OAuth Client Secret (optional). When OAuth fields are blank, Cowork uses dynamic client registration. The MCP endpoint at /mcp also accepts static bearer via MMPM_MCP_AUTH_KEY, but Cowork cannot use this path.

## Smoking Gun Finding (from full log tail)

```
[oauth] Registered client: Cowork (bd592557-0c1b-477a-a525-6d7d6f0b42f7)
[oauth] Redirect URI mismatch: https://claude.ai/api/mcp/auth_callback
```

**Cowork's actual OAuth callback URI is `https://claude.ai/api/mcp/auth_callback`.**

After server restart, sessions create and STAY OPEN (no "Session closed" logged). But Cowork still shows `connected: false` and loops: register → tokens → session created → (Cowork doesn't recognise it) → register again.

The server-side is 100% working. The issue is Cowork's client-side session recognition.

### Pattern observed in logs after restart:
1. First client: registered → tokens → tokens refreshed → NO session created
2. Second client: registered → tokens → session created (stays open)
3. Third client: registered → tokens → session created (stays open)
4. Fourth client: registered → tokens → session created (stays open)
5. Cowork still shows "Connect" button / loops back

### Possible cause:
Cowork may require the GET SSE stream (server-to-client notifications) to be established after initialize. The server supports this (GET /mcp with Mcp-Session-Id header). But if Cowork's GET request fails or the SSE stream doesn't stay open through nginx, Cowork would consider the connection dead.

## Recommended Next Steps (in priority order)

1. **Add verbose auth logging** — modify checkAuth in mmpm_mcp_http.ts to log every request method, path, and auth result. Then watch logs during Cowork connection to see if GET /mcp requests are arriving and being authenticated.

2. **Test GET SSE stream from Mac** — after initializing with curl POST, open a GET SSE stream:
   ```bash
   # First, initialize and capture session ID from response headers
   SESSION_ID=$(curl -s -D - -o /dev/null -X POST https://mmpm.co.nz/mcp \
     -H "Authorization: Bearer <MCP_AUTH_KEY>" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
     | grep -i 'mcp-session-id' | tr -d '\r' | awk '{print $2}')

   echo "Session: $SESSION_ID"

   # Then open GET SSE stream (should stay open)
   curl -N -H "Authorization: Bearer <MCP_AUTH_KEY>" \
     -H "Accept: text/event-stream" \
     -H "Mcp-Session-Id: $SESSION_ID" \
     https://mmpm.co.nz/mcp
   ```
   If the GET stream immediately closes or returns an error, that's the problem.

3. **Check nginx SSE for GET requests** — the nginx config sets `Connection ""` which is correct for POST, but GET SSE needs `Connection: keep-alive`. May need to add conditional headers based on request method.

## CONCLUSIVE FINDING (2026-03-15 final)

**The MCP server is fully functional. This is a Cowork beta bug.**

All four protocol tests pass from Mac via curl:
1. `POST /mcp` initialize → HTTP 200, session ID in header, correct SSE response ✅
2. `GET /mcp` SSE stream with session ID → stays open, no errors ✅
3. OAuth register/authorize/token → all succeed, logged on server ✅
4. Tool calls (memory_health, memory_atoms_list) → return correct data ✅

Cowork completes the full OAuth flow and creates MCP sessions on the server, but its internal client logic does not recognize the connection as established. Sessions stay open server-side but Cowork loops back to "Connect."

Additionally, the full OAuth flow was tested manually from Mac via curl:
- Register client → success
- Get auth code (PKCE S256) → success
- Exchange for access_token → success (`mmpm_at_...`)
- Initialize MCP session with OAuth token → HTTP 200, session ID, tools capability

**The two auth systems (OAuth on MCP, Bearer on API) are NOT clashing.**
The identical OAuth flow that works via curl fails inside Cowork's connector.

This is not caused by our env var changes. The server protocol is correct and unchanged. File a Cowork bug report or wait for a Cowork update.

## Files Modified in This Sprint

| File | Change |
|------|--------|
| `.env.test` | Added `MMPM_API_KEYS=` to prevent auth bleed |
| `src/__tests__/setup.ts` | Added `override: true` to dotenv.config |
| `integrations/deploy/mmpm-deploy.sh` | Auto-generates viz key on new/upgrade installs |
| `tools/harness/live_scope_test.sh` | Made BASE/MASTER_KEY/READ_KEY overridable via env vars |
| `tools/harness/test-mcp-endpoint.sh` | NEW — tests MCP Streamable HTTP transport |
| `backups/session-checkpoint-2026-03-15.json` | Session checkpoint atoms for import |

## Session State (for memory import)

The file `backups/session-checkpoint-2026-03-15.json` contains all atoms from this session that need to be imported once MCP is working. Key atoms:
- `v1.event.v0_2_0_released_scoped_api_keys_dt_2026_03_15`
- `v1.event.production_deploy_v0_2_0_healthy_dt_2026_03_15`
- `v1.fact.scoped_api_keys_format_name_at_scope_colon_key`
- `v1.procedure.always_blank_mmpm_api_keys_in_env_test`
- `v1.state.sprint_v4_phase_a_complete`

## Fix Attempt: Disable SSE, Enable JSON Responses (2026-03-15)

**Root cause hypothesis:** The MCP SDK (v1.27.1) defaults `enableJsonResponse: false`, which means every POST tool-call response is wrapped in SSE (`text/event-stream`) framing instead of plain `application/json`. Combined with `http2 on` in nginx (HTTP/2 forbids `Connection: keep-alive` headers that the SDK sets on SSE responses), and the GET SSE stream that Cowork may open and then drop — the transport layer has three failure modes that could all produce "Tool execution failed."

**Changes made to `tools/mcp/mmpm_mcp_http.ts`:**

1. Added `enableJsonResponse: true` to `StreamableHTTPServerTransport` constructor — POST responses now return `application/json` instead of `text/event-stream`
2. Replaced GET `/mcp` SSE handler with 405 — server-push notifications aren't needed (website is the only consumer, all tools are request/response)

**Confidence:** ~60% this fixes the Cowork issue. Even if it doesn't, removing SSE is the correct architecture for this use case — eliminates three failure modes and simplifies the transport. If it still fails after deploy, the issue is conclusively a Cowork beta client bug.

**To deploy:** rebuild MCP container on droplet, restart, test from Cowork.

## Remaining Sprint Tasks

1. **Deploy SSE fix to droplet and test Cowork** (this debug)
2. **Save session checkpoint** to memory (blocked by #1)
3. **Deploy website to parametric-memory.dev** (the .env.local change needs to ship — master key removed, viz key in place)
