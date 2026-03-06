#!/usr/bin/env bash
# =============================================================================
# MMPM Scientific Benchmark Runner
# Runs N independent trials and captures system metadata for citable results.
# See SCIENTIFIC_BENCHMARK_PROTOCOL.md before using.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
TRIALS=10
PROFILE="concurrent"
WARMUP_OPS=10000
DURATION_MS=60000
OUT_BASE="$SCRIPT_DIR/results/scientific"
SERVER_URL="${MMPM_BASE_URL:-http://127.0.0.1:3000}"
PROTOCOL_VERSION="1.0"

# ── Argument parsing ──────────────────────────────────────────────────────────
usage() {
  echo "Usage: $0 [options]"
  echo ""
  echo "Options:"
  echo "  --trials N          Number of independent trials (default: $TRIALS)"
  echo "  --profile NAME      Harness profile: smoke|concurrent|stress (default: $PROFILE)"
  echo "  --warmup-ops N      Ops before measurement starts (default: $WARMUP_OPS)"
  echo "  --duration-ms N     Measurement window per trial in ms (default: $DURATION_MS)"
  echo "  --out DIR           Output base directory (default: $OUT_BASE)"
  echo "  --server URL        MMPM server URL (default: $SERVER_URL)"
  echo "  --help              Show this help"
  echo ""
  echo "Output: <out>/run_<timestamp>/{system.json, trial_01.json … trial_N.json, summary.json, prometheus_snapshot.prom}"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --trials)    TRIALS="$2";     shift 2 ;;
    --profile)   PROFILE="$2";   shift 2 ;;
    --warmup-ops) WARMUP_OPS="$2"; shift 2 ;;
    --duration-ms) DURATION_MS="$2"; shift 2 ;;
    --out)       OUT_BASE="$2";  shift 2 ;;
    --server)    SERVER_URL="$2"; shift 2 ;;
    --help)      usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# ── Setup ─────────────────────────────────────────────────────────────────────
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
RUN_DIR="$OUT_BASE/run_$TIMESTAMP"
mkdir -p "$RUN_DIR"

log() { echo "[scientific_runner] $*"; }
log "Protocol v$PROTOCOL_VERSION  |  $TRIALS trials  |  profile=$PROFILE  |  duration=${DURATION_MS}ms"
log "Output: $RUN_DIR"

# ── Step 1: Verify server is ready ────────────────────────────────────────────
log "Checking server readiness at $SERVER_URL ..."
READY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$SERVER_URL/ready" 2>/dev/null || echo "000")
if [[ "$READY_STATUS" != "200" ]]; then
  echo "ERROR: Server not ready at $SERVER_URL (HTTP $READY_STATUS). Start it first."
  echo "  node dist/server.js"
  exit 1
fi
log "Server ready."

# ── Step 2: Capture system metadata ───────────────────────────────────────────
log "Capturing system metadata..."

OS_NAME="$(uname -s)"
OS_RELEASE="$(uname -r)"
ARCH="$(uname -m)"
HOSTNAME_VAL="$(hostname)"

# CPU info
if [[ "$OS_NAME" == "Darwin" ]]; then
  CPU_MODEL="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'unknown')"
  CPU_CORES="$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 'unknown')"
  RAM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  RAM_GB="$(echo "scale=1; $RAM_BYTES / 1073741824" | bc 2>/dev/null || echo 'unknown')"
  OS_FULL="macOS $(sw_vers -productVersion 2>/dev/null || echo '?') $ARCH"
elif [[ "$OS_NAME" == "Linux" ]]; then
  CPU_MODEL="$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || echo 'unknown')"
  CPU_CORES="$(nproc 2>/dev/null || echo 'unknown')"
  RAM_KB="$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)"
  RAM_GB="$(echo "scale=1; $RAM_KB / 1048576" | bc 2>/dev/null || echo 'unknown')"
  OS_FULL="Linux $OS_RELEASE $ARCH"
else
  CPU_MODEL="unknown"
  CPU_CORES="unknown"
  RAM_GB="unknown"
  OS_FULL="$OS_NAME $OS_RELEASE $ARCH"
fi

NODE_VER="$(node --version 2>/dev/null || echo 'unknown')"
NPM_VER="$(npm --version 2>/dev/null || echo 'unknown')"
TS_VER="$(node -e "console.log(require('$REPO_ROOT/node_modules/typescript/package.json').version)" 2>/dev/null || echo 'unknown')"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')"
GIT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
GIT_DIRTY="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | grep -c '' | awk '{print ($1 > 0) ? "true" : "false"}')"
API_KEY_SET="$([ -n "${MMPM_API_KEY:-}" ] && echo 'true' || echo 'false')"

# Load API key if present
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi
API_KEY_SET="$([ -n "${MMPM_API_KEY:-}" ] && echo 'true' || echo 'false')"

cat > "$RUN_DIR/system.json" << SYSTEM_JSON
{
  "system": {
    "os": "$OS_FULL",
    "cpu_model": "$CPU_MODEL",
    "cpu_cores": $CPU_CORES,
    "ram_gb": $RAM_GB,
    "hostname": "$HOSTNAME_VAL",
    "node_version": "$NODE_VER",
    "npm_version": "$NPM_VER",
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
    "profile": "$PROFILE",
    "n_trials": $TRIALS,
    "warmup_ops": $WARMUP_OPS,
    "duration_ms": $DURATION_MS,
    "server_url": "$SERVER_URL"
  }
}
SYSTEM_JSON

log "System metadata saved to system.json"
if [[ "$GIT_DIRTY" == "true" ]]; then
  log "WARNING: Git working tree is dirty. Results from this run are NOT citable (see protocol §1)."
  log "         Run 'git stash' or commit your changes before a citable benchmark."
fi

# ── Step 3: Run trials ────────────────────────────────────────────────────────
log "Starting $TRIALS trials..."

TRIAL_FILES=()
for i in $(seq 1 "$TRIALS"); do
  TRIAL_NUM=$(printf "%02d" "$i")
  TRIAL_OUT="$RUN_DIR/trial_${TRIAL_NUM}.json"
  log "  Trial $TRIAL_NUM / $TRIALS ..."

  # Add small jitter between trials to avoid thermal caching artifacts
  if [[ "$i" -gt 1 ]]; then sleep 2; fi

  cd "$REPO_ROOT"
  node_modules/.bin/ts-node tools/harness/cli.ts \
    --preset "$PROFILE" \
    --out "$TRIAL_OUT" \
    --prom-out "$RUN_DIR/trial_${TRIAL_NUM}.prom" \
    2>/dev/null

  if [[ -f "$TRIAL_OUT" ]]; then
    log "  Trial $TRIAL_NUM complete."
    TRIAL_FILES+=("$TRIAL_OUT")
  else
    log "  ERROR: Trial $TRIAL_NUM produced no output. Aborting."
    exit 1
  fi
done

# ── Step 4: Capture mid-run Prometheus snapshot ───────────────────────────────
log "Capturing Prometheus metrics snapshot..."
curl -s "$SERVER_URL/metrics" > "$RUN_DIR/prometheus_snapshot.prom" 2>/dev/null || true

# ── Step 5: Compute summary statistics ───────────────────────────────────────
log "Computing summary statistics..."

python3 << PYEOF
import json, math, os, sys
from pathlib import Path

run_dir = Path("$RUN_DIR")
trial_files = sorted(run_dir.glob("trial_*.json"))

if not trial_files:
    print("ERROR: no trial files found")
    sys.exit(1)

trials = []
for tf in trial_files:
    with open(tf) as f:
        trials.append(json.load(f))

n = len(trials)

def vals(key_path):
    """Extract a nested value from all trials. key_path like 'latency.accessP95Ms'"""
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
    n = len(values)
    mu = sum(values) / n
    if n > 1:
        variance = sum((x - mu)**2 for x in values) / (n - 1)
        sigma = math.sqrt(variance)
    else:
        sigma = 0
    cv = (sigma / mu) if mu > 0 else 0

    # t-distribution critical value for 95% CI (two-tailed)
    # Approximation for common N values; use scipy.stats.t for precision
    t_table = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
               6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
               15: 2.131, 20: 2.086, 30: 2.042}
    df = n - 1
    t_crit = t_table.get(df, t_table.get(min(t_table.keys(), key=lambda k: abs(k-df)), 2.0))
    margin = t_crit * sigma / math.sqrt(n)

    return {
        "n": n,
        "mean": round(mu, 6),
        "std": round(sigma, 6),
        "cv": round(cv, 4),
        "ci95_low": round(mu - margin, 6),
        "ci95_high": round(mu + margin, 6),
        "min": round(min(values), 6),
        "max": round(max(values), 6),
        "citable": cv < 0.15 and n >= 10
    }

metrics = {
    "latency": {
        "access_p50_ms": stats(vals("latency.accessP50Ms")),
        "access_p95_ms": stats(vals("latency.accessP95Ms")),
        "access_p99_ms": stats(vals("latency.accessP99Ms")),
        "commit_p95_ms": stats(vals("latency.commitP95Ms")),
        "proof_verify_avg_ms": stats(vals("latency.proofVerifyAvgMs")),
    },
    "throughput": {
        "total_ops_per_sec": stats(vals("throughput.totalOpsPerSec")),
        "reads_per_sec": stats(vals("throughput.readsPerSec")),
    },
    "prediction": {
        "hit_rate": stats(vals("prediction.hitRate")),
    },
    "correctness": {
        "proof_failures": stats(vals("correctness.proofFailures")),
        "stale_reads": stats(vals("correctness.staleReads")),
        "version_mismatches": stats(vals("correctness.versionMismatches")),
    }
}

# Load system metadata
system_file = run_dir / "system.json"
system_meta = json.loads(system_file.read_text()) if system_file.exists() else {}

summary = {
    "protocol_version": "$PROTOCOL_VERSION",
    "run_dir": str(run_dir),
    "n_trials": n,
    "trial_files": [str(f.name) for f in trial_files],
    "system": system_meta,
    "metrics": metrics,
    "citeability": {
        "all_citable": all(
            v.get("citable", False)
            for group in metrics.values()
            for v in group.values()
            if v is not None
        ),
        "git_clean": system_meta.get("git", {}).get("dirty") == False,
        "n_sufficient": n >= 10,
        "notes": []
    }
}

# Add citeability notes
if system_meta.get("git", {}).get("dirty"):
    summary["citeability"]["notes"].append("WARN: git tree is dirty — results not citable")
if n < 10:
    summary["citeability"]["notes"].append(f"WARN: only {n} trials — need ≥10 for citable results")
for group_name, group in metrics.items():
    for metric_name, s in group.items():
        if s and s["cv"] >= 0.15:
            summary["citeability"]["notes"].append(
                f"WARN: {group_name}.{metric_name} has high variance (CV={s['cv']:.3f}) — system unstable for this metric"
            )

out_path = run_dir / "summary.json"
out_path.write_text(json.dumps(summary, indent=2))
print(f"Summary written to {out_path}")

# Print human-readable table
print()
print("=" * 70)
print("MMPM SCIENTIFIC BENCHMARK SUMMARY")
print("=" * 70)
print(f"Trials: {n}  |  Profile: $PROFILE  |  Protocol: v$PROTOCOL_VERSION")
sys_info = system_meta.get("system", {})
print(f"System: {sys_info.get('cpu_model','?')} | {sys_info.get('ram_gb','?')}GB RAM | {sys_info.get('os','?')}")
print(f"Node:   {sys_info.get('node_version','?')}  |  Git: {system_meta.get('git',{}).get('sha','?')[:12]}...")
print()
print(f"{'Metric':<35} {'Mean':>10} {'95% CI':>22} {'CV':>6} {'Citable':>8}")
print("-" * 85)

def fmt_metric(label, s):
    if s is None:
        return
    ci = f"[{s['ci95_low']:.4f}, {s['ci95_high']:.4f}]"
    citable = "✓" if s.get('citable') else "✗"
    print(f"{label:<35} {s['mean']:>10.4f} {ci:>22} {s['cv']:>6.3f} {citable:>8}")

fmt_metric("Access latency p95 (ms)", metrics["latency"]["access_p95_ms"])
fmt_metric("Access latency p50 (ms)", metrics["latency"]["access_p50_ms"])
fmt_metric("Access latency p99 (ms)", metrics["latency"]["access_p99_ms"])
fmt_metric("Commit latency p95 (ms)", metrics["latency"]["commit_p95_ms"])
fmt_metric("Proof verify avg (ms)",   metrics["latency"]["proof_verify_avg_ms"])
fmt_metric("Throughput (ops/sec)",     metrics["throughput"]["total_ops_per_sec"])
fmt_metric("Read throughput (ops/sec)", metrics["throughput"]["reads_per_sec"])
fmt_metric("Markov hit rate",          metrics["prediction"]["hit_rate"])
fmt_metric("Proof failures",           metrics["correctness"]["proof_failures"])
fmt_metric("Stale reads",              metrics["correctness"]["stale_reads"])

print()
if summary["citeability"]["all_citable"] and summary["citeability"]["git_clean"]:
    print("✓ CITABLE: All metrics pass protocol requirements.")
else:
    print("✗ NOT FULLY CITABLE:")
    for note in summary["citeability"]["notes"]:
        print(f"  {note}")
print()
print(f"Full results: {run_dir}/")
PYEOF

log "Done. Results in: $RUN_DIR"
log ""
log "Next steps:"
log "  1. Run statistical analysis:"
log "     python3 tools/harness/analyze_results.py --run $RUN_DIR"
log "  2. Compare with another run:"
log "     python3 tools/harness/analyze_results.py --run $RUN_DIR --compare <other_run_dir>"
