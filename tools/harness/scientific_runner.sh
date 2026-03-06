#!/usr/bin/env bash
# =============================================================================
# MMPM Scientific Benchmark Runner  (protocol v2)
#
# Design principles:
#   • Benchmarks the real HTTP API — no in-process shortcuts.
#   • Each trial starts a fresh MMPM server with a clean LevelDB database,
#     giving statistically independent measurements.
#   • One warmup trial runs before measurement trials and is discarded,
#     priming JIT, OS page cache, and TypeScript compilation.
#   • Errors are logged per-trial, never silently swallowed.
#   • Trial duration is actually forwarded to the agent simulation.
#
# Usage:  bash tools/harness/scientific_runner.sh [options]
# See --help for full option list.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
TRIALS=10
PROFILE="concurrent"
DURATION_MS=20000           # agent-sim window per trial (ms); 20s × 10 trials ≈ 6 min total
OUT_BASE="$SCRIPT_DIR/results/scientific"
SERVER_PORT="${MMPM_PORT:-3000}"
SERVER_URL="http://127.0.0.1:${SERVER_PORT}"
PROTOCOL_VERSION="2.0"

# ── Argument parsing ──────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --trials N          Independent measurement trials (default: $TRIALS; min 5 for citable)
  --profile NAME      Preset: smoke|standard|concurrent|stress (default: $PROFILE)
  --duration-ms N     Agent-sim window per trial in ms (default: $DURATION_MS)
  --out DIR           Output directory base (default: $OUT_BASE)
  --port N            Server port (default: $SERVER_PORT)
  --help              Show this help

Mode: HTTP API. Each trial starts a fresh server + clean LevelDB for independence.
One warmup trial runs before measurement and is discarded.

Timing guide (concurrent preset):
  --duration-ms 20000  →  ~30s/trial  →  10 trials ≈ 6 min  (publishable)
  --duration-ms 30000  →  ~40s/trial  →  10 trials ≈ 8 min
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trials)      TRIALS="$2";      shift 2 ;;
    --profile)     PROFILE="$2";     shift 2 ;;
    --duration-ms) DURATION_MS="$2"; shift 2 ;;
    --out)         OUT_BASE="$2";    shift 2 ;;
    --port)        SERVER_PORT="$2"; SERVER_URL="http://127.0.0.1:${SERVER_PORT}"; shift 2 ;;
    --help)        usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# ── Load .env (sets MMPM_API_KEY etc.; inherited by server child processes) ───
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

# ── Setup ─────────────────────────────────────────────────────────────────────
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
RUN_DIR="$OUT_BASE/run_$TIMESTAMP"
mkdir -p "$RUN_DIR"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
log "MMPM Scientific Benchmark  protocol=v${PROTOCOL_VERSION}  trials=${TRIALS}+1warmup  profile=${PROFILE}  agent_sim=${DURATION_MS}ms"
log "Mode: HTTP API  |  fresh server per trial  |  output: $RUN_DIR"

# ── Server lifecycle ──────────────────────────────────────────────────────────
SERVER_PID=""
BENCH_DB=""

start_server() {
  local label="$1"
  BENCH_DB="${REPO_ROOT}/mmpm-bench-db-${label}-$$"
  DB_BASE_PATH="$BENCH_DB" PORT="$SERVER_PORT" \
    node "$REPO_ROOT/dist/server.js" \
    >> "$RUN_DIR/server_${label}.log" 2>&1 &
  SERVER_PID=$!

  # Wait up to 30s for readiness
  local deadline=$(( SECONDS + 30 ))
  while [[ $SECONDS -lt $deadline ]]; do
    # Bail early if the server process died
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "ERROR: Server process died during startup (trial $label). See $RUN_DIR/server_${label}.log"
      exit 1
    fi
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/ready" 2>/dev/null || echo "000")
    if [[ "$status" == "200" ]]; then return 0; fi
    sleep 0.3
  done
  log "ERROR: Server not ready after 30s (trial $label)"
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
}

stop_server() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
  if [[ -n "$BENCH_DB" ]] && [[ -d "$BENCH_DB" ]]; then
    rm -rf "$BENCH_DB"
    BENCH_DB=""
  fi
}

# Guarantee cleanup on any exit
trap 'stop_server' EXIT

# ── Step 1: Verify clean git state ────────────────────────────────────────────
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')"
GIT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
GIT_DIRTY="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | awk '{print ($1 > 0) ? "true" : "false"}')"

if [[ "$GIT_DIRTY" == "true" ]]; then
  log "WARNING: Git tree is dirty — results will be flagged as non-citable."
fi

# ── Step 2: Build TypeScript (server + imports; harness stays ts-node) ────────
log "Building TypeScript (src/ → dist/) ..."
cd "$REPO_ROOT"
node_modules/.bin/tsc
log "Build complete."

# ── Step 3: Capture system metadata ───────────────────────────────────────────
log "Capturing system metadata ..."

OS_NAME="$(uname -s)"
OS_RELEASE="$(uname -r)"
ARCH="$(uname -m)"
HOSTNAME_VAL="$(hostname)"

if [[ "$OS_NAME" == "Darwin" ]]; then
  CPU_MODEL="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'unknown')"
  CPU_CORES="$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 'unknown')"
  RAM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  RAM_GB="$(echo "scale=1; $RAM_BYTES / 1073741824" | bc 2>/dev/null || echo 'unknown')"
  OS_FULL="macOS $(sw_vers -productVersion 2>/dev/null || echo '?') $ARCH"
elif [[ "$OS_NAME" == "Linux" ]]; then
  CPU_MODEL="$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | tr -d '\n\r' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//' || true)"
  # Fallback for ARM: try lscpu Vendor ID + Architecture, or Hardware field
  [[ -z "$CPU_MODEL" ]] && CPU_MODEL="$(lscpu 2>/dev/null | awk -F': +' '/Vendor ID/{v=$2} /Architecture/{a=$2} END{if(v && a) print v " " a}' || true)"
  [[ -z "$CPU_MODEL" ]] && CPU_MODEL="$(grep -m1 'Hardware' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | tr -d '\n\r' | sed 's/^[[:space:]]*//' || true)"
  [[ -z "$CPU_MODEL" ]] && CPU_MODEL="unknown"
  CPU_CORES="$(nproc 2>/dev/null || echo 'unknown')"
  RAM_KB="$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)"
  RAM_GB="$(echo "scale=1; $RAM_KB / 1048576" | bc 2>/dev/null || echo 'unknown')"
  OS_FULL="Linux $OS_RELEASE $ARCH"
else
  CPU_MODEL="unknown"; CPU_CORES="unknown"; RAM_GB="unknown"
  OS_FULL="$OS_NAME $OS_RELEASE $ARCH"
fi

NODE_VER="$(node --version 2>/dev/null || echo 'unknown')"
TS_VER="$(node -e "console.log(require('$REPO_ROOT/node_modules/typescript/package.json').version)" 2>/dev/null || echo 'unknown')"
API_KEY_SET="$([ -n "${MMPM_API_KEY:-}" ] && echo 'true' || echo 'false')"

# Sanitize strings for safe JSON embedding (strip control chars, escape backslashes and quotes)
sanitize_json_str() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
CPU_MODEL="$(sanitize_json_str "$CPU_MODEL")"
OS_FULL="$(sanitize_json_str "$OS_FULL")"
HOSTNAME_VAL="$(sanitize_json_str "$HOSTNAME_VAL")"
NODE_VER="$(sanitize_json_str "$NODE_VER")"
TS_VER="$(sanitize_json_str "$TS_VER")"
GIT_SHA="$(sanitize_json_str "$GIT_SHA")"
GIT_BRANCH="$(sanitize_json_str "$GIT_BRANCH")"
# Ensure numeric fields are actually numeric
CPU_CORES_JSON="$(echo "$CPU_CORES" | grep -E '^[0-9]+$' || echo 0)"
RAM_GB_JSON="$(echo "$RAM_GB" | grep -E '^[0-9]+(\.[0-9]+)?$' || echo 0)"

cat > "$RUN_DIR/system.json" << SYSTEM_JSON
{
  "system": {
    "os": "$OS_FULL",
    "cpu_model": "$CPU_MODEL",
    "cpu_cores": $CPU_CORES_JSON,
    "ram_gb": $RAM_GB_JSON,
    "hostname": "$HOSTNAME_VAL",
    "node_version": "$NODE_VER",
    "ts_version": "$TS_VER"
  },
  "git": {
    "sha": "$GIT_SHA",
    "branch": "$GIT_BRANCH",
    "dirty": $GIT_DIRTY
  },
  "run": {
    "protocol_version": "$PROTOCOL_VERSION",
    "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "mode": "http_api",
    "profile": "$PROFILE",
    "n_trials": $TRIALS,
    "agent_sim_duration_ms": $DURATION_MS,
    "server_url": "$SERVER_URL",
    "api_key_set": $API_KEY_SET,
    "trial_independence": "fresh_server_fresh_db"
  }
}
SYSTEM_JSON

log "System metadata saved."

# Helper: run one harness trial (warmup or measurement)
run_trial() {
  local label="$1"   # e.g. "warmup" or "01"
  local out_file="$2"
  local prom_file="$3"
  local stderr_log="$4"

  # TS_NODE_TRANSPILE_ONLY skips type-checking, cuts ts-node startup by ~3s
  TS_NODE_TRANSPILE_ONLY=true \
  node_modules/.bin/ts-node tools/harness/cli.ts \
    --preset  "$PROFILE" \
    --durationMs "$DURATION_MS" \
    --api \
    --baseUrl "$SERVER_URL" \
    --no-print \
    --out     "$out_file" \
    --prom-out "$prom_file" \
    2>>"$stderr_log"
}

# ── Step 4: Warmup trial (trial 00 — results discarded) ──────────────────────
log "─── Warmup trial (priming JIT + OS cache; not counted in results) ───"
start_server "warmup"
cd "$REPO_ROOT"
run_trial \
  "warmup" \
  "$RUN_DIR/trial_warmup.json" \
  "$RUN_DIR/trial_warmup.prom" \
  "$RUN_DIR/trial_warmup.stderr.log" || {
    log "WARNING: Warmup trial failed — continuing anyway."
  }
stop_server
log "Warmup complete."

# ── Step 5: Measurement trials ────────────────────────────────────────────────
log "─── Starting $TRIALS measurement trials ───"
TRIAL_FILES=()

for i in $(seq 1 "$TRIALS"); do
  TRIAL_NUM=$(printf "%02d" "$i")
  TRIAL_OUT="$RUN_DIR/trial_${TRIAL_NUM}.json"
  TRIAL_PROM="$RUN_DIR/trial_${TRIAL_NUM}.prom"
  TRIAL_STDERR="$RUN_DIR/trial_${TRIAL_NUM}.stderr.log"

  log "  Trial $TRIAL_NUM/$TRIALS — starting fresh server ..."
  start_server "$TRIAL_NUM"
  cd "$REPO_ROOT"

  if run_trial "$TRIAL_NUM" "$TRIAL_OUT" "$TRIAL_PROM" "$TRIAL_STDERR"; then
    stop_server
    if [[ -f "$TRIAL_OUT" ]]; then
      log "  Trial $TRIAL_NUM complete."
      TRIAL_FILES+=("$TRIAL_OUT")
    else
      log "  ERROR: Trial $TRIAL_NUM: harness exited 0 but produced no output file. Aborting."
      exit 1
    fi
  else
    EXIT_CODE=$?
    stop_server
    log "  ERROR: Trial $TRIAL_NUM failed (exit $EXIT_CODE). See: $TRIAL_STDERR"
    if [[ -s "$TRIAL_STDERR" ]]; then
      log "  Last 5 lines of stderr:"
      tail -5 "$TRIAL_STDERR" | while IFS= read -r line; do log "    $line"; done
    fi
    log "  Aborting."
    exit 1
  fi
done

# ── Step 6: Post-run Prometheus snapshot ──────────────────────────────────────
log "Capturing post-run Prometheus snapshot (fresh server, baseline state) ..."
start_server "prom"
curl -s "$SERVER_URL/metrics" > "$RUN_DIR/prometheus_snapshot.prom" 2>/dev/null || true
stop_server

# ── Step 7: Compute summary statistics ────────────────────────────────────────
log "Computing summary statistics ..."

export RUN_DIR_PY="$RUN_DIR"
python3 << 'PYEOF'
import json, math, os, sys
from pathlib import Path

run_dir = Path(os.environ.get("RUN_DIR_PY", "."))
trial_files = sorted(run_dir.glob("trial_[0-9][0-9].json"))   # excludes trial_warmup.json

if not trial_files:
    print("ERROR: no measurement trial files found", file=sys.stderr)
    sys.exit(1)

trials = []
for tf in trial_files:
    with open(tf) as f:
        trials.append(json.load(f))

n = len(trials)

def vals(key_path):
    keys = key_path.split('.')
    result = []
    for t in trials:
        v = t
        try:
            for k in keys:
                v = v[k]
            result.append(float(v))
        except (KeyError, TypeError, ValueError):
            pass
    return result

def stats(values):
    if not values:
        return None
    n_v = len(values)
    mu = sum(values) / n_v
    sigma = math.sqrt(sum((x - mu)**2 for x in values) / (n_v - 1)) if n_v > 1 else 0.0
    cv = (sigma / mu) if mu > 0 else 0.0
    # Student t critical values (two-tailed 95%)
    t_table = {1:12.706, 2:4.303, 3:3.182, 4:2.776, 5:2.571,
               6:2.447,  7:2.365, 8:2.306, 9:2.262, 10:2.228,
               15:2.131, 20:2.086, 30:2.042}
    df = n_v - 1
    t_crit = t_table.get(df, 2.0)
    margin = (t_crit * sigma / math.sqrt(n_v)) if n_v > 1 else 0.0
    return {
        "n": n_v,
        "mean":     round(mu, 6),
        "std":      round(sigma, 6),
        "cv":       round(cv, 4),
        "ci95_low": round(mu - margin, 6),
        "ci95_high":round(mu + margin, 6),
        "min":      round(min(values), 6),
        "max":      round(max(values), 6),
        # Citable if: ≥5 trials AND CV < 15% (stable measurement)
        "citable":  cv < 0.15 and n_v >= 5,
    }

metrics = {
    "latency": {
        "access_p50_ms":       stats(vals("latency.accessP50Ms")),
        "access_p95_ms":       stats(vals("latency.accessP95Ms")),
        "access_p99_ms":       stats(vals("latency.accessP99Ms")),
        "commit_p95_ms":       stats(vals("latency.commitP95Ms")),
        "proof_verify_avg_ms": stats(vals("latency.proofVerifyAvgMs")),
        "proof_verify_p95_ms": stats(vals("latency.proofVerifyP95Ms")),
    },
    "throughput": {
        "total_ops_per_sec":  stats(vals("throughput.totalOpsPerSec")),
        "reads_per_sec":      stats(vals("throughput.readsPerSec")),
        "writes_per_sec":     stats(vals("throughput.writesPerSec")),
    },
    "prediction": {
        "hit_rate":           stats(vals("prediction.hitRate")),
        "avg_latency_saved_ms": stats(vals("prediction.avgLatencySavedMs")),
    },
    "correctness": {
        "proof_failures":      stats(vals("correctness.proofFailures")),
        "stale_reads":         stats(vals("correctness.staleReads")),
        "version_mismatches":  stats(vals("correctness.versionMismatches")),
    },
}

system_file = run_dir / "system.json"
system_meta = json.loads(system_file.read_text()) if system_file.exists() else {}

all_citable = all(
    v.get("citable", False)
    for group in metrics.values()
    for v in group.values()
    if v is not None
)

notes = []
if system_meta.get("git", {}).get("dirty"):
    notes.append("WARN: git tree is dirty — results not citable per protocol")
if n < 5:
    notes.append(f"WARN: only {n} trials — need ≥5 for citable results (≥10 recommended)")
elif n < 10:
    notes.append(f"NOTE: {n} trials — publishable; ≥10 gives tighter confidence intervals")
for group_name, group in metrics.items():
    for metric_name, s in group.items():
        if s and s["cv"] >= 0.15:
            notes.append(
                f"WARN: {group_name}.{metric_name} CV={s['cv']:.3f} (>0.15) — high variance, system may be unstable"
            )

summary = {
    "protocol_version": system_meta.get("run", {}).get("protocol_version", "2.0"),
    "run_dir": str(run_dir),
    "n_trials": n,
    "trial_files": [f.name for f in trial_files],
    "system": system_meta,
    "metrics": metrics,
    "citeability": {
        "all_citable": all_citable,
        "git_clean": not system_meta.get("git", {}).get("dirty", True),
        "n_sufficient": n >= 5,
        "mode": system_meta.get("run", {}).get("mode", "http_api"),
        "notes": notes,
    },
}

out_path = run_dir / "summary.json"
out_path.write_text(json.dumps(summary, indent=2))
print(f"Summary → {out_path}")

# ── Human-readable table ──────────────────────────────────────────────────────
sys_info = system_meta.get("system", {})
run_info = system_meta.get("run", {})
git_info = system_meta.get("git", {})

print()
print("=" * 82)
print("  MMPM HTTP API BENCHMARK — CITABLE RESULTS")
print("=" * 82)
print(f"  Profile : {run_info.get('profile','?')}   |   Agent sim: {run_info.get('agent_sim_duration_ms','?')} ms/trial   |   Trials: {n}")
print(f"  Mode    : {run_info.get('mode','?')}   |   Independence: {run_info.get('trial_independence','?')}")
print(f"  CPU     : {sys_info.get('cpu_model','?')}")
print(f"  RAM     : {sys_info.get('ram_gb','?')} GB   |   OS: {sys_info.get('os','?')}")
print(f"  Node    : {sys_info.get('node_version','?')}   |   TypeScript: {sys_info.get('ts_version','?')}")
print(f"  Git SHA : {git_info.get('sha','?')[:16]}...   |   Branch: {git_info.get('branch','?')}   |   Dirty: {git_info.get('dirty','?')}")
print()
print(f"  {'Metric':<34}  {'Mean':>10}  {'95% CI (±)':>25}  {'CV':>6}  {'✓':>4}")
print("  " + "-" * 78)

def fmt(label, s, decimals=4):
    if s is None:
        return
    ci = f"[{s['ci95_low']:.{decimals}f}, {s['ci95_high']:.{decimals}f}]"
    tick = "✓" if s.get("citable") else "✗"
    print(f"  {label:<34}  {s['mean']:>10.{decimals}f}  {ci:>25}  {s['cv']:>6.3f}  {tick:>4}")

print()
print("  — Latency (ms) —")
fmt("Access p50",                 metrics["latency"]["access_p50_ms"])
fmt("Access p95",                 metrics["latency"]["access_p95_ms"])
fmt("Access p99",                 metrics["latency"]["access_p99_ms"])
fmt("Commit p95",                 metrics["latency"]["commit_p95_ms"])
fmt("Merkle proof verify avg",    metrics["latency"]["proof_verify_avg_ms"])
fmt("Merkle proof verify p95",    metrics["latency"]["proof_verify_p95_ms"])
print()
print("  — Throughput (ops/sec) —")
fmt("Total ops/sec",              metrics["throughput"]["total_ops_per_sec"], 2)
fmt("Reads/sec",                  metrics["throughput"]["reads_per_sec"], 2)
fmt("Writes/sec",                 metrics["throughput"]["writes_per_sec"], 2)
print()
print("  — Markov Prediction —")
fmt("Hit rate",                   metrics["prediction"]["hit_rate"])
fmt("Avg latency saved (ms)",     metrics["prediction"]["avg_latency_saved_ms"])
print()
print("  — Correctness —")
fmt("Proof failures",             metrics["correctness"]["proof_failures"])
fmt("Stale reads",                metrics["correctness"]["stale_reads"])
fmt("Version mismatches",         metrics["correctness"]["version_mismatches"])

print()
if all_citable and not system_meta.get("git", {}).get("dirty"):
    print("  ✓  CITABLE: all metrics pass protocol v2.0 requirements.")
else:
    print("  ✗  NOT FULLY CITABLE:")
    for note in notes:
        print(f"     {note}")
print()
print(f"  Full results: {run_dir}/")
print("=" * 82)
PYEOF

log "Done. Results: $RUN_DIR"
log ""
log "Key output files:"
log "  summary.json          — statistics table + citeability verdict"
log "  system.json           — hardware + git metadata"
log "  trial_01..${TRIALS}.json    — raw per-trial benchmark reports"
log "  trial_*.stderr.log    — per-trial error logs (check if unexpected)"
