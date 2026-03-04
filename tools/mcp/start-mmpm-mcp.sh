#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

if [[ -z "${MMPM_MCP_API_KEY:-}" && -n "${MMPM_API_KEY:-}" ]]; then
  export MMPM_MCP_API_KEY="$MMPM_API_KEY"
fi

export MMPM_MCP_BASE_URL="${MMPM_MCP_BASE_URL:-http://127.0.0.1:3000}"
export MMPM_MCP_ENABLE_MUTATIONS="${MMPM_MCP_ENABLE_MUTATIONS:-1}"
export MMPM_MCP_ENABLE_SEMANTIC_TOOLS="${MMPM_MCP_ENABLE_SEMANTIC_TOOLS:-1}"

cd "$REPO_ROOT"
exec npm run mcp:serve