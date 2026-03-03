#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# Optional profile argument: balanced|read-heavy|write-heavy|policy-stress
PROFILE="${1:-balanced}"
case "$PROFILE" in
    balanced|read-heavy|write-heavy|policy-stress) ;;
    *)
        echo "Usage: bash tools/harness/open-grafana-continuous.sh [balanced|read-heavy|write-heavy|policy-stress]" >&2
        exit 1
        ;;
esac

# Load defaults from .env if present
if [[ -f .env ]]; then
    set -a
    # shellcheck source=.env
    source .env
    set +a
fi

BASE_URL="${MMPM_BASE_URL:-http://localhost:3000}"
API_KEY="${MMPM_API_KEY:-}"
GRAFANA_URL="http://localhost:3001"
PROM_URL="http://localhost:9090"
TARGETS_URL="$PROM_URL/targets"
TARGETS_API_URL="$PROM_URL/api/v1/targets"
CLIENT_METRICS_URL="http://127.0.0.1:9470"
DASHBOARD_URL="${GRAFANA_URL}/d/mmpm-main/mmpm-markov-merkle-predictive-memory?orgId=1&from=now-30m&to=now&timezone=browser"

CLIENT_PID=""

cleanup() {
    echo ""
    echo "[cleanup] stopping continuous client..."
    if [[ -n "$CLIENT_PID" ]] && kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
        kill "$CLIENT_PID" >/dev/null 2>&1 || true
        wait "$CLIENT_PID" 2>/dev/null || true
    fi

    echo "[cleanup] tearing down docker stack..."
    docker compose down >/dev/null 2>&1 || true
    echo "[cleanup] done"
}
trap cleanup EXIT INT TERM

echo "[1/6] Starting Docker stack (API + Prometheus + Grafana)..."
docker compose up -d --build

echo "[2/6] Waiting for API readiness..."
for _ in {1..90}; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/ready" || true)"
    if [[ "$code" == "200" ]]; then
        break
    fi
    sleep 1
done

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/ready" || true)"
if [[ "$code" != "200" ]]; then
    echo "ERROR: API not ready at $BASE_URL/ready" >&2
    exit 1
fi

echo "[3/6] Starting continuous client (profile=$PROFILE, exporter=:9470)..."
CLIENT_CMD=(
    npx ts-node tools/harness/continuous_client.ts
    --profile "$PROFILE"
    --baseUrl "$BASE_URL"
    --duration-ms 3600000
    --target-ops 120
    --concurrency 8
    --metrics-port 9470
    --metrics-host 0.0.0.0
)
if [[ -n "$API_KEY" ]]; then
    CLIENT_CMD+=(--apiKey "$API_KEY")
fi

"${CLIENT_CMD[@]}" > /tmp/mmpm-continuous-client.log 2>&1 &
CLIENT_PID=$!

echo "[4/6] Waiting for continuous client exporter..."
for _ in {1..45}; do
    if [[ -n "$CLIENT_PID" ]] && ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
        echo "ERROR: Continuous client exited before exporter became ready" >&2
        echo "Log: /tmp/mmpm-continuous-client.log" >&2
        exit 1
    fi
    if curl -fsS "$CLIENT_METRICS_URL/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
if ! curl -fsS "$CLIENT_METRICS_URL/health" >/dev/null 2>&1; then
    echo "ERROR: Continuous client exporter not reachable at $CLIENT_METRICS_URL/health" >&2
    echo "Log: /tmp/mmpm-continuous-client.log" >&2
    exit 1
fi

echo "[5/6] Waiting for Prometheus to show client target..."
for _ in {1..60}; do
    if [[ -n "$CLIENT_PID" ]] && ! kill -0 "$CLIENT_PID" >/dev/null 2>&1; then
        echo "ERROR: Continuous client exited while waiting for Prometheus target" >&2
        echo "Log: /tmp/mmpm-continuous-client.log" >&2
        exit 1
    fi

    # Prometheus /targets is a JS app shell; use API endpoint for target state.
    if curl -fsS "$TARGETS_API_URL" | grep -q '"labels":{"instance":"host.docker.internal:9470","job":"mmpm_continuous_client"}.*"health":"up"'; then
        break
    fi
    sleep 1
done

if ! curl -fsS "$TARGETS_API_URL" | grep -q '"labels":{"instance":"host.docker.internal:9470","job":"mmpm_continuous_client"}.*"health":"up"'; then
    echo "ERROR: Prometheus did not report mmpm_continuous_client target as up" >&2
    echo "Targets API: $TARGETS_API_URL" >&2
    echo "Log: /tmp/mmpm-continuous-client.log" >&2
    exit 1
fi

echo "[6/6] Opening Grafana dashboard..."
if command -v open >/dev/null 2>&1; then
    open "$DASHBOARD_URL"
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$DASHBOARD_URL"
fi

echo ""
echo "Stack is running with live continuous client traffic."
echo "Grafana:        $GRAFANA_URL"
echo "Dashboard:      $DASHBOARD_URL"
echo "Prometheus:     $PROM_URL"
echo "Prom targets:   $TARGETS_URL"
echo "Client metrics: $CLIENT_METRICS_URL/metrics"
echo "Client log:     /tmp/mmpm-continuous-client.log"
echo ""
echo "Press Ctrl+C in this terminal to stop client and tear everything down."

# Keep script alive while client runs so trap handles teardown.
wait "$CLIENT_PID"
