#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PRESET="${1:-smoke}"
if [[ "$PRESET" != "smoke" && "$PRESET" != "standard" && "$PRESET" != "stress" && "$PRESET" != "concurrent" ]]; then
    echo "Usage: bash tools/harness/open-grafana.sh [smoke|standard|stress|concurrent]" >&2
    exit 1
fi

# Load local env defaults if present
if [[ -f .env ]]; then
    set -a
    source .env
    set +a
fi

GRAFANA_USER="${GF_SECURITY_ADMIN_USER:-admin}"
GRAFANA_PASS="${GF_SECURITY_ADMIN_PASSWORD:-admin}"
GRAFANA_URL="http://localhost:3001"
DASHBOARD_URL="${GRAFANA_URL}/d/mmpm-sprint7-harness/mmpm-sprint-7-harness?orgId=1&from=now-30m&to=now&timezone=browser"
EXPORTER_URL="http://127.0.0.1:9466"
EXPORTER_LOG="/tmp/mmpm-bench-exporter.log"
EXPORTER_PID_FILE="/tmp/mmpm-bench-exporter.pid"

echo "[1/5] Starting Docker stack (API + Prometheus + Grafana)..."
docker compose up -d --build

echo "[2/5] Running benchmark preset '$PRESET' against API..."
npx ts-node tools/harness/cli.ts \
    --preset "$PRESET" \
    --api \
    --out tools/harness/results/latest.json \
    --prom-out tools/harness/results/latest.prom \
    --print

echo "[3/5] Ensuring harness exporter is running on :9466..."
if curl -fsS "$EXPORTER_URL/health" >/dev/null 2>&1; then
    echo "  Exporter already running."
else
    nohup npm run bench:exporter >"$EXPORTER_LOG" 2>&1 < /dev/null &
    EXPORTER_PID=$!
    echo "$EXPORTER_PID" > "$EXPORTER_PID_FILE"
    disown "$EXPORTER_PID" >/dev/null 2>&1 || true
    for _ in {1..30}; do
        if curl -fsS "$EXPORTER_URL/health" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    if ! curl -fsS "$EXPORTER_URL/health" >/dev/null 2>&1; then
        echo "ERROR: Exporter failed to start. Log: $EXPORTER_LOG" >&2
        exit 1
    fi
    echo "  Exporter started (pid: $EXPORTER_PID, log: $EXPORTER_LOG)."
fi

echo "[4/5] Waiting for Grafana..."
for _ in {1..30}; do
    if curl -fsS "$GRAFANA_URL/api/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if ! curl -fsS "$GRAFANA_URL/api/health" >/dev/null 2>&1; then
    echo "ERROR: Grafana is not reachable at $GRAFANA_URL" >&2
    exit 1
fi

echo "[5/5] Grafana ready."

# Auto-favorite dashboards for quick access (best-effort)
for DASH_UID in mmpm-sprint7-harness mmpm-main; do
    curl -fsS -u "$GRAFANA_USER:$GRAFANA_PASS" -X POST "$GRAFANA_URL/api/user/stars/dashboard/uid/$DASH_UID" >/dev/null 2>&1 || true
done

echo ""
echo "Grafana URL      : $GRAFANA_URL"
echo "Dashboard URL    : $DASHBOARD_URL"
echo "Grafana Username : $GRAFANA_USER"
echo "Grafana Password : $GRAFANA_PASS"
echo ""
echo "Available dashboards:"
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const dir = path.resolve('grafana/dashboards');
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const full = path.join(dir, file);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));
  const title = json.title || file.replace(/\.json$/, '');
  console.log(`- ${title}`);
}
NODE

if command -v open >/dev/null 2>&1; then
    open "$DASHBOARD_URL"
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$DASHBOARD_URL"
fi

echo ""
echo "If dashboard shows 'No data', wait 5-15s for Prometheus scrape and click Refresh."
echo "Exporter health: $EXPORTER_URL/health"
echo "Exporter log   : $EXPORTER_LOG"
echo "Prometheus tgt : http://localhost:9090/targets"
echo "Tip: stop stack with 'docker compose down'"
