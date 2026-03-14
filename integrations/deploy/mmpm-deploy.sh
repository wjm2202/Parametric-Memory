#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# MMPM Deploy Orchestrator — run from your Mac
#
# Single command to provision, deploy, or update MMPM on a Digital Ocean droplet.
#
# Usage:
#   bash integrations/deploy/mmpm-deploy.sh provision   # Create droplet + full setup
#   bash integrations/deploy/mmpm-deploy.sh deploy       # Update existing droplet
#   bash integrations/deploy/mmpm-deploy.sh status       # Health check
#   bash integrations/deploy/mmpm-deploy.sh logs         # Tail production logs
#   bash integrations/deploy/mmpm-deploy.sh backup       # Download NDJSON backup
#   bash integrations/deploy/mmpm-deploy.sh ssh          # Interactive SSH session
#
# Environment:
#   MMPM_HOST        Droplet IP or hostname    (default: mmpm.co.nz)
#   MMPM_USER        SSH user                  (default: root)
#   MMPM_SSH_KEY     Path to SSH private key   (default: ~/.ssh/id_ed25519)
#   MMPM_DOMAIN      Domain for TLS cert       (default: mmpm.co.nz)
#   MMPM_REPO        GitHub repo URL           (default: from git remote)
#   MMPM_BRANCH      Branch to deploy          (default: main)
#   DO_TOKEN         DigitalOcean API token    (required for 'provision')
#   DO_SSH_KEY_ID    DO SSH key fingerprint    (required for 'provision')
#
# Design principles:
#   • Idempotent — safe to run repeatedly
#   • Atomic deploys — build succeeds before old container stops
#   • Zero-downtime updates via docker compose rolling restart
#   • Model2Vec vocab deployed as a Docker volume, not baked into the image
#   • All secrets stay on the droplet, keys exported to local file on provision
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
MMPM_HOST="${MMPM_HOST:-mmpm.co.nz}"
MMPM_USER="${MMPM_USER:-root}"
MMPM_SSH_KEY="${MMPM_SSH_KEY:-$HOME/.ssh/id_ed25519}"
MMPM_DOMAIN="${MMPM_DOMAIN:-mmpm.co.nz}"
MMPM_BRANCH="${MMPM_BRANCH:-main}"
MMPM_REPO="${MMPM_REPO:-$(cd "$REPO_ROOT" && git remote get-url origin 2>/dev/null || echo "https://github.com/wjm2202/Parametric-Memory.git")}"
REMOTE_DIR="/opt/mmpm"
# Prefer binary (.bin) for 10× faster startup; fall back to JSON
if [[ -f "${REPO_ROOT}/data/model2vec_vocab.bin" ]]; then
    MODEL2VEC_LOCAL="${REPO_ROOT}/data/model2vec_vocab.bin"
    MODEL2VEC_REMOTE="model2vec_vocab.bin"
else
    MODEL2VEC_LOCAL="${REPO_ROOT}/data/model2vec_vocab.json"
    MODEL2VEC_REMOTE="model2vec_vocab.json"
fi

# ── SSH helper ────────────────────────────────────────────────────────────────
ssh_cmd() {
    ssh -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=10 \
        -i "$MMPM_SSH_KEY" \
        "${MMPM_USER}@${MMPM_HOST}" "$@"
}

scp_to() {
    scp -o StrictHostKeyChecking=accept-new \
        -i "$MMPM_SSH_KEY" \
        "$1" "${MMPM_USER}@${MMPM_HOST}:$2"
}

scp_from() {
    scp -o StrictHostKeyChecking=accept-new \
        -i "$MMPM_SSH_KEY" \
        "${MMPM_USER}@${MMPM_HOST}:$1" "$2"
}

# ── Colour output ─────────────────────────────────────────────────────────────
info()  { printf "\033[1;34m→\033[0m %s\n" "$*"; }
ok()    { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m⚠\033[0m %s\n" "$*"; }
fail()  { printf "\033[1;31m✗\033[0m %s\n" "$*"; exit 1; }
header(){ printf "\n\033[1;36m══ %s ══\033[0m\n\n" "$*"; }

# ══════════════════════════════════════════════════════════════════════════════
# PROVISION — create a new droplet and run full setup
# ══════════════════════════════════════════════════════════════════════════════
cmd_provision() {
    header "PROVISION NEW DROPLET"

    [[ -z "${DO_TOKEN:-}" ]] && fail "DO_TOKEN required. Export your DigitalOcean API token."
    [[ -z "${DO_SSH_KEY_ID:-}" ]] && fail "DO_SSH_KEY_ID required. Run: curl -s -H 'Authorization: Bearer \$DO_TOKEN' https://api.digitalocean.com/v2/account/keys | jq '.ssh_keys[] | {name, fingerprint}'"

    local DROPLET_NAME="${MMPM_DOMAIN//./-}"
    local REGION="${DO_REGION:-sfo3}"
    local SIZE="${DO_SIZE:-s-1vcpu-1gb}"
    local IMAGE="${DO_IMAGE:-ubuntu-22-04-x64}"

    info "Creating droplet: ${DROPLET_NAME} (${SIZE} in ${REGION})"

    DROPLET_JSON=$(curl -sf -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${DO_TOKEN}" \
        -d "{
            \"name\": \"${DROPLET_NAME}\",
            \"region\": \"${REGION}\",
            \"size\": \"${SIZE}\",
            \"image\": \"${IMAGE}\",
            \"ssh_keys\": [\"${DO_SSH_KEY_ID}\"],
            \"backups\": false,
            \"monitoring\": true,
            \"tags\": [\"mmpm\", \"production\"]
        }" \
        "https://api.digitalocean.com/v2/droplets") || fail "Failed to create droplet"

    DROPLET_ID=$(echo "$DROPLET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['droplet']['id'])")
    ok "Droplet created: ID=${DROPLET_ID}"

    # Wait for IP assignment
    info "Waiting for IP address..."
    for i in $(seq 1 30); do
        sleep 5
        IP=$(curl -sf \
            -H "Authorization: Bearer ${DO_TOKEN}" \
            "https://api.digitalocean.com/v2/droplets/${DROPLET_ID}" \
            | python3 -c "import sys,json; nets=json.load(sys.stdin)['droplet']['networks']['v4']; print(next((n['ip_address'] for n in nets if n['type']=='public'),''))" 2>/dev/null || echo "")
        [[ -n "$IP" ]] && break
        printf "."
    done
    echo ""

    [[ -z "${IP:-}" ]] && fail "Could not get droplet IP after 150s"
    ok "Droplet IP: ${IP}"

    echo ""
    echo "┌──────────────────────────────────────────────┐"
    echo "│  ACTION REQUIRED: DNS                        │"
    echo "│                                              │"
    echo "│  Add an A record:                            │"
    echo "│    ${MMPM_DOMAIN} → ${IP}                    │"
    echo "│                                              │"
    echo "│  Then wait for propagation and run:           │"
    echo "│    bash integrations/deploy/mmpm-deploy.sh deploy │"
    echo "└──────────────────────────────────────────────┘"
    echo ""

    # Save droplet info locally
    local INFO_FILE="${REPO_ROOT}/.droplet-info"
    cat > "$INFO_FILE" <<EOF
# MMPM Droplet — provisioned $(date -Iseconds)
DROPLET_ID=${DROPLET_ID}
DROPLET_IP=${IP}
MMPM_HOST=${IP}
MMPM_DOMAIN=${MMPM_DOMAIN}
EOF
    chmod 600 "$INFO_FILE"
    ok "Droplet info saved to .droplet-info"

    # Wait for SSH
    info "Waiting for SSH access..."
    export MMPM_HOST="$IP"
    for i in $(seq 1 24); do
        sleep 10
        if ssh_cmd "echo ok" >/dev/null 2>&1; then
            ok "SSH connected"
            # Proceed directly to deploy
            cmd_deploy
            return
        fi
        printf "."
    done
    echo ""
    warn "SSH not ready after 4 min. Run 'mmpm-deploy.sh deploy' when the droplet is accessible."
}

# ══════════════════════════════════════════════════════════════════════════════
# DEPLOY — full deploy/update to an existing droplet
# ══════════════════════════════════════════════════════════════════════════════
cmd_deploy() {
    header "DEPLOY TO ${MMPM_HOST}"

    # ── Phase 1: Verify SSH connectivity ──────────────────────────────────────
    info "Testing SSH connection..."
    ssh_cmd "echo ok" >/dev/null 2>&1 || fail "Cannot SSH to ${MMPM_USER}@${MMPM_HOST}"
    ok "SSH connected"

    # ── Phase 2: Bootstrap system (idempotent) ────────────────────────────────
    info "Bootstrapping system packages..."
    ssh_cmd "bash -s" <<'REMOTE_BOOTSTRAP'
set -euo pipefail

# System updates
apt-get update -qq && apt-get upgrade -y -qq

# Docker
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing"; exit 1; }

# Certbot
command -v certbot &>/dev/null || apt-get install -y -qq certbot

# Git
command -v git &>/dev/null || apt-get install -y -qq git

# Firewall
ufw status | grep -q "Status: active" || {
    ufw --force reset >/dev/null
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow 22/tcp comment "SSH"
    ufw allow 80/tcp comment "HTTP"
    ufw allow 443/tcp comment "HTTPS"
    ufw --force enable
}

echo "system-ready"
REMOTE_BOOTSTRAP
    ok "System bootstrapped"

    # ── Phase 3: Clone or pull repo ───────────────────────────────────────────
    info "Syncing repository (branch: ${MMPM_BRANCH})..."
    ssh_cmd "bash -s" <<REMOTE_SYNC
set -euo pipefail
if [[ -d "${REMOTE_DIR}/.git" ]]; then
    cd "${REMOTE_DIR}"
    git fetch origin
    git checkout "${MMPM_BRANCH}"
    git reset --hard "origin/${MMPM_BRANCH}"
    echo "repo-updated"
else
    git clone --branch "${MMPM_BRANCH}" "${MMPM_REPO}" "${REMOTE_DIR}"
    echo "repo-cloned"
fi
REMOTE_SYNC
    ok "Repository synced"

    # ── Phase 4: Verify Model2Vec vocabulary ─────────────────────────────────
    # The .bin file (29MB) is committed to git, so git pull already brought it.
    # Only SCP as fallback if the repo somehow doesn't have it (e.g. shallow clone).
    info "Checking Model2Vec vocabulary..."
    VOCAB_STATUS=$(ssh_cmd "bash -s" <<'REMOTE_VOCAB'
set -euo pipefail
BIN="/opt/mmpm/data/model2vec_vocab.bin"
JSON="/opt/mmpm/data/model2vec_vocab.json"
if [[ -f "$BIN" ]]; then
    SIZE=$(stat -c%s "$BIN")
    echo "bin:${SIZE}"
elif [[ -f "$JSON" ]]; then
    SIZE=$(stat -c%s "$JSON")
    echo "json:${SIZE}"
else
    echo "none"
fi
REMOTE_VOCAB
    )

    case "$VOCAB_STATUS" in
        bin:*)
            ok "Model2Vec binary vocab present (${VOCAB_STATUS#bin:} bytes, arrived via git)"
            ;;
        json:*)
            ok "Model2Vec JSON vocab present (${VOCAB_STATUS#json:} bytes) — consider converting to .bin for 10× faster startup"
            ;;
        none)
            # Fallback: SCP from local machine if available
            if [[ -f "$MODEL2VEC_LOCAL" ]]; then
                warn "Vocab not in repo on droplet — uploading via SCP..."
                ssh_cmd "mkdir -p ${REMOTE_DIR}/data"
                scp_to "$MODEL2VEC_LOCAL" "${REMOTE_DIR}/data/${MODEL2VEC_REMOTE}"
                ok "Model2Vec vocabulary uploaded via SCP"
            else
                warn "No Model2Vec vocabulary found locally or on droplet"
                warn "Semantic search will fall back to n-gram embeddings"
            fi
            ;;
    esac

    # ── Phase 5: Generate .env.production (idempotent) ────────────────────────
    info "Configuring environment..."
    KEYS_JSON=$(ssh_cmd "bash -s" <<'REMOTE_ENV'
set -euo pipefail
REMOTE_DIR="/opt/mmpm"
ENV_FILE="${REMOTE_DIR}/.env.production"

if [[ ! -f "$ENV_FILE" ]]; then
    MMPM_API_KEY="mmk_$(openssl rand -hex 24)"
    MMPM_MCP_AUTH_KEY="mcp_$(openssl rand -hex 24)"

    # Write the full env file using the setup-droplet.sh template
    cd "$REMOTE_DIR"
    # Generate via the setup script's env block, but we'll write it directly
    cat > "$ENV_FILE" <<ENVEOF
# MMPM Production Environment
# Generated on $(date -Iseconds)
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
SHARD_COUNT=4
DB_BASE_PATH=/app/mmpm-db
LOG_LEVEL=info

MMPM_API_KEY=${MMPM_API_KEY}
MMPM_MCP_AUTH_KEY=${MMPM_MCP_AUTH_KEY}
MMPM_OAUTH_ISSUER=https://${MMPM_DOMAIN:-mmpm.co.nz}

MMPM_BLOCK_SECRET_ATOMS=1
MMPM_METRICS_PUBLIC=0
WRITE_POLICY=auto-write
MMPM_COMMIT_THRESHOLD=50
MMPM_COMMIT_INTERVAL_MS=5000
MMPM_PENDING_HIGH_WATER_MARK=500
MMPM_BACKPRESSURE_RETRY_AFTER_SEC=5
INGEST_BATCH_SIZE=100
INGEST_FLUSH_MS=1000
MMPM_ATOM_FILE=/app/seeds.json
MMPM_WAL_COMPACT_THRESHOLD_BYTES=10485760
MMPM_CONFIDENCE_HALF_LIFE_MS=604800000
MMPM_HLR_ENABLED=1
MMPM_PPM_ENABLED=1
MMPM_PPM_MAX_ORDER=3
MMPM_PPM_ESCAPE_THRESHOLD=0.3
MMPM_PPM_MAX_NODES=100000
MMPM_TIER_ENABLED=1
MMPM_CONSOLIDATION_INTERVAL_MS=3600000
MMPM_CONSOLIDATION_REPLAY_TOP_N=50
MMPM_PRUNE_ENABLED=0
MMPM_PRUNE_STALE_DAYS=30
MMPM_ACCESS_LOG_ENABLED=1
MMPM_ACCESS_LOG_MAX=50000
MMPM_TTL_PROMOTION_THRESHOLD=3
MMPM_TTL_REAPER_INTERVAL_MS=60000
MMPM_AUDIT_LOG_MAX_ENTRIES=1000
# MMPM_BOOTSTRAP_COMPACT_PROOFS=0
# MMPM_BOOTSTRAP_FORCE_FULL_PROOFS=0
GF_SECURITY_ADMIN_USER=admin
GF_SECURITY_ADMIN_PASSWORD=admin
GF_AUTH_DISABLE_LOGIN_FORM=false
GF_AUTH_ANONYMOUS_ENABLED=false
GF_LOG_FILTERS=context:warn
ENVEOF

    chmod 600 "$ENV_FILE"
    echo "{\"new\":true,\"api_key\":\"${MMPM_API_KEY}\",\"mcp_key\":\"${MMPM_MCP_AUTH_KEY}\"}"
else
    # Merge missing defaults (idempotent upgrade)
    DEFAULTS=(
        "MMPM_HLR_ENABLED=1"
        "MMPM_PPM_ENABLED=1"
        "MMPM_PPM_MAX_ORDER=3"
        "MMPM_PPM_ESCAPE_THRESHOLD=0.3"
        "MMPM_PPM_MAX_NODES=100000"
        "MMPM_TIER_ENABLED=1"
        "MMPM_CONSOLIDATION_INTERVAL_MS=3600000"
        "MMPM_CONSOLIDATION_REPLAY_TOP_N=50"
        "MMPM_PRUNE_ENABLED=0"
        "MMPM_PRUNE_STALE_DAYS=30"
        "MMPM_ACCESS_LOG_ENABLED=1"
        "MMPM_ACCESS_LOG_MAX=50000"
        "MMPM_TTL_PROMOTION_THRESHOLD=3"
        "MMPM_TTL_REAPER_INTERVAL_MS=60000"
        "MMPM_AUDIT_LOG_MAX_ENTRIES=1000"
        "# MMPM_BOOTSTRAP_COMPACT_PROOFS=0"
        "# MMPM_BOOTSTRAP_FORCE_FULL_PROOFS=0"
    )
    ADDED=0
    for DEF in "${DEFAULTS[@]}"; do
        KEY="${DEF%%=*}"
        if ! grep -q "^${KEY}=" "$ENV_FILE" 2>/dev/null; then
            echo "${DEF}" >> "$ENV_FILE"
            ((ADDED++)) || true
        fi
    done
    API_KEY=$(grep "^MMPM_API_KEY=" "$ENV_FILE" | cut -d= -f2)
    MCP_KEY=$(grep "^MMPM_MCP_AUTH_KEY=" "$ENV_FILE" | cut -d= -f2)
    echo "{\"new\":false,\"added\":${ADDED},\"api_key\":\"${API_KEY}\",\"mcp_key\":\"${MCP_KEY}\"}"
fi
REMOTE_ENV
    )

    IS_NEW=$(echo "$KEYS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('new',''))")
    API_KEY=$(echo "$KEYS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('api_key',''))")
    MCP_KEY=$(echo "$KEYS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mcp_key',''))")

    if [[ "$IS_NEW" == "True" ]]; then
        ok "Generated new API keys"

        # Save keys locally
        local KEYS_FILE="${REPO_ROOT}/.mmpm-keys"
        cat > "$KEYS_FILE" <<EOF
# MMPM Production Keys — generated $(date -Iseconds)
# KEEP SECRET. Do not commit to git.
MMPM_API_KEY=${API_KEY}
MMPM_MCP_AUTH_KEY=${MCP_KEY}
MMPM_HOST=${MMPM_HOST}
MMPM_DOMAIN=${MMPM_DOMAIN}
EOF
        chmod 600 "$KEYS_FILE"
        echo ""
        echo "  ┌──────────────────────────────────────────────────┐"
        echo "  │  SAVE THESE KEYS (also in .mmpm-keys)            │"
        echo "  ├──────────────────────────────────────────────────┤"
        echo "  │  API Key:  ${API_KEY}"
        echo "  │  MCP Auth: ${MCP_KEY}"
        echo "  └──────────────────────────────────────────────────┘"
        echo ""
    else
        ok "Environment configured (existing keys preserved)"
    fi

    # ── Phase 6: TLS certificate (idempotent) ─────────────────────────────────
    info "Checking TLS certificate..."
    ssh_cmd "bash -s" <<REMOTE_TLS
set -euo pipefail
DOMAIN="${MMPM_DOMAIN}"
if [[ ! -d "/etc/letsencrypt/live/\${DOMAIN}" ]]; then
    echo "Obtaining certificate for \${DOMAIN}..."
    docker compose -f ${REMOTE_DIR}/integrations/deploy/docker-compose.production.yml down 2>/dev/null || true
    certbot certonly --standalone --non-interactive --agree-tos \
        --email entityone22@gmail.com -d "\${DOMAIN}"
    echo "cert-obtained"
else
    echo "cert-exists"
fi
REMOTE_TLS
    ok "TLS certificate ready"

    # ── Phase 7: Build and deploy ─────────────────────────────────────────────
    info "Building and deploying containers..."
    ssh_cmd "bash -s" <<REMOTE_DEPLOY
set -euo pipefail
cd "${REMOTE_DIR}"

COMPOSE_FILE="integrations/deploy/docker-compose.production.yml"

# Build new images before stopping old ones (atomic deploy)
docker compose -f "\$COMPOSE_FILE" build

# Rolling restart — nginx stays up, services restart one at a time
docker compose -f "\$COMPOSE_FILE" up -d --remove-orphans

echo "deploy-started"
REMOTE_DEPLOY
    ok "Containers deployed"

    # ── Phase 8: Health check ─────────────────────────────────────────────────
    info "Waiting for health check..."
    for i in $(seq 1 30); do
        sleep 2
        if curl -sf "https://${MMPM_DOMAIN}/health" >/dev/null 2>&1; then
            echo ""
            ok "MMPM is live at https://${MMPM_DOMAIN}"
            echo ""

            # Verify Model2Vec loaded
            M2V_CHECK=$(curl -sf -H "Authorization: Bearer ${API_KEY}" "https://${MMPM_DOMAIN}/health" 2>/dev/null || echo "{}")
            echo "  Health: $(echo "$M2V_CHECK" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d, indent=2))" 2>/dev/null || echo "$M2V_CHECK")"
            echo ""
            echo "  ┌──────────────────────────────────────────────┐"
            echo "  │  Endpoints                                   │"
            echo "  │  Health:  https://${MMPM_DOMAIN}/health      │"
            echo "  │  API:     https://${MMPM_DOMAIN}/atoms       │"
            echo "  │  MCP:     https://${MMPM_DOMAIN}/mcp         │"
            echo "  │  OAuth:   https://${MMPM_DOMAIN}/.well-known/oauth-authorization-server │"
            echo "  └──────────────────────────────────────────────┘"
            return 0
        fi
        printf "."
    done
    echo ""
    warn "Services not healthy after 60s. Check: ssh ${MMPM_USER}@${MMPM_HOST} 'cd ${REMOTE_DIR} && docker compose -f integrations/deploy/docker-compose.production.yml logs --tail=50'"
    return 1
}

# ══════════════════════════════════════════════════════════════════════════════
# STATUS — health check and service info
# ══════════════════════════════════════════════════════════════════════════════
cmd_status() {
    header "STATUS: ${MMPM_DOMAIN}"

    echo "  HTTPS health:"
    curl -sf "https://${MMPM_DOMAIN}/health" | python3 -m json.tool 2>/dev/null || echo "  (unreachable)"

    echo ""
    echo "  Container status:"
    ssh_cmd "cd ${REMOTE_DIR} && docker compose -f integrations/deploy/docker-compose.production.yml ps" 2>/dev/null || echo "  (SSH failed)"

    echo ""
    echo "  Disk usage:"
    ssh_cmd "df -h / | tail -1 && echo '' && du -sh ${REMOTE_DIR}/data/ 2>/dev/null || echo '  no data dir'" 2>/dev/null || echo "  (SSH failed)"

    echo ""
    echo "  Docker volumes:"
    ssh_cmd "docker system df -v 2>/dev/null | head -20" 2>/dev/null || echo "  (SSH failed)"
}

# ══════════════════════════════════════════════════════════════════════════════
# LOGS — tail production logs
# ══════════════════════════════════════════════════════════════════════════════
cmd_logs() {
    local LINES="${2:-100}"
    ssh_cmd "cd ${REMOTE_DIR} && docker compose -f integrations/deploy/docker-compose.production.yml logs --tail=${LINES} -f"
}

# ══════════════════════════════════════════════════════════════════════════════
# BACKUP — download NDJSON export
# ══════════════════════════════════════════════════════════════════════════════
cmd_backup() {
    header "BACKUP"

    local BACKUP_DIR="${REPO_ROOT}/backups"
    mkdir -p "$BACKUP_DIR"
    local TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    local BACKUP_FILE="${BACKUP_DIR}/mmpm-backup-${TIMESTAMP}.ndjson"

    info "Exporting atoms from droplet..."
    ssh_cmd "bash -s" <<'REMOTE_BACKUP'
set -euo pipefail
API_KEY=$(grep "^MMPM_API_KEY=" /opt/mmpm/.env.production | cut -d= -f2)
curl -sf -H "Authorization: Bearer ${API_KEY}" http://127.0.0.1:3000/admin/export
REMOTE_BACKUP
    > "$BACKUP_FILE"

    # Actually download it
    ssh_cmd "bash -c 'API_KEY=\$(grep \"^MMPM_API_KEY=\" /opt/mmpm/.env.production | cut -d= -f2) && curl -sf -H \"Authorization: Bearer \$API_KEY\" http://127.0.0.1:3000/admin/export'" > "$BACKUP_FILE"

    local LINE_COUNT=$(wc -l < "$BACKUP_FILE")
    ok "Backup saved: ${BACKUP_FILE} (${LINE_COUNT} atoms)"
}

# ══════════════════════════════════════════════════════════════════════════════
# SSH — interactive session
# ══════════════════════════════════════════════════════════════════════════════
cmd_ssh() {
    ssh -o StrictHostKeyChecking=accept-new -i "$MMPM_SSH_KEY" "${MMPM_USER}@${MMPM_HOST}"
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
usage() {
    cat <<EOF
MMPM Deploy Orchestrator

Usage: $(basename "$0") <command>

Commands:
  provision    Create a new Digital Ocean droplet and deploy MMPM
  deploy       Deploy or update MMPM on an existing droplet
  status       Show health, containers, and disk usage
  logs [N]     Tail last N log lines (default: 100)
  backup       Download NDJSON backup of all atoms
  ssh          Open interactive SSH session

Environment variables:
  MMPM_HOST       Droplet IP or hostname   (default: mmpm.co.nz)
  MMPM_USER       SSH user                 (default: root)
  MMPM_SSH_KEY    SSH private key path     (default: ~/.ssh/id_ed25519)
  MMPM_DOMAIN     Domain for TLS           (default: mmpm.co.nz)
  MMPM_BRANCH     Git branch to deploy     (default: main)
  DO_TOKEN        DigitalOcean API token   (provision only)
  DO_SSH_KEY_ID   DO SSH key fingerprint   (provision only)

Examples:
  # First time — create droplet and deploy
  DO_TOKEN=dop_xxx DO_SSH_KEY_ID=xx:xx:xx bash integrations/deploy/mmpm-deploy.sh provision

  # Update existing droplet after merging new code
  bash integrations/deploy/mmpm-deploy.sh deploy

  # Deploy a feature branch for testing
  MMPM_BRANCH=architecture-upgrade bash integrations/deploy/mmpm-deploy.sh deploy
EOF
}

COMMAND="${1:-}"
case "$COMMAND" in
    provision) cmd_provision ;;
    deploy)    cmd_deploy ;;
    status)    cmd_status ;;
    logs)      cmd_logs "$@" ;;
    backup)    cmd_backup ;;
    ssh)       cmd_ssh ;;
    *)         usage; exit 1 ;;
esac
