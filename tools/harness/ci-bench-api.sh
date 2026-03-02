#!/usr/bin/env bash
set -euo pipefail

# CI one-shot API benchmark:
# 1) start compose stack
# 2) wait until mmpm-service is healthy (/ready == 200 via healthcheck)
# 3) run npm benchmark against API
# 4) always tear stack down

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

SERVICE_NAME="${1:-mmpm-service}"
TIMEOUT_SECONDS="${MMPM_HEALTH_TIMEOUT_SEC:-180}"

cleanup() {
    docker compose down >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[ci-bench] starting docker compose stack..."
docker compose up -d --build

echo "[ci-bench] waiting for service health: ${SERVICE_NAME} (timeout ${TIMEOUT_SECONDS}s)"
deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
    container_id="$(docker compose ps -q "$SERVICE_NAME" || true)"
    if [[ -n "$container_id" ]]; then
        status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"
        if [[ "$status" == "healthy" ]]; then
            echo "[ci-bench] service is healthy"
            npm run bench:run:api
            echo "[ci-bench] benchmark completed"
            exit 0
        fi
    fi
    sleep 2
done

echo "[ci-bench] ERROR: service '${SERVICE_NAME}' did not become healthy within ${TIMEOUT_SECONDS}s" >&2
docker compose ps >&2 || true
exit 1
