# MMPM Scientific Benchmark Protocol

**Version:** 1.0
**Status:** Active
**Maintainer:** Glen Osborne
**Last updated:** 2026-03-05

---

## Purpose

This document defines the exact methodology for producing benchmark results that can support
scientifically verifiable claims about MMPM. Every result cited in a paper, presentation, or
technical report must follow this protocol. Deviation must be explicitly noted and justified.

---

## What You Can Claim (and What You Can't)

### Claimable with this protocol

| Claim | What it requires |
|---|---|
| "P95 access latency ≤ X ms at Y ops/sec" | ≥10 trials, steady-state window, system metadata recorded |
| "Zero proof failures across N accesses" | N ≥ 100,000, correctness counter validated against raw logs |
| "Markov hit rate ≥ Z% after K training sequences" | Controlled atom set, fixed random seed for atom selection |
| "Throughput of T ops/sec with N atoms under C concurrency" | Steady-state measurement only (excludes warmup) |
| "Latency scales sub-linearly with atom count from A to B atoms" | Scaling experiments with ≥5 data points, R² reported |
| "No stale reads under concurrent read/write pressure" | Concurrent profile with explicit write pressure |
| "Commit latency p95 ≤ X ms" | Measured from Prometheus histogram, not harness estimate |

### Not claimable without additional work

- Cross-system superiority claims (requires comparison system + same protocol)
- Claims about specific hardware (requires pinned hardware + multiple same-machine trials)
- Production scalability (requires real-world workload replay, not synthetic harness)
- Statistical significance vs. alternative approaches (requires controlled A/B on same machine)

---

## Protocol Requirements

### 1. Environment Capture (mandatory before every run)

The following must be recorded automatically by the runner and embedded in the result JSON:

```
system.os                  # e.g. "macOS 15.3.1 arm64"
system.cpu_model           # e.g. "Apple M3 Pro"
system.cpu_cores           # logical core count
system.ram_gb              # total RAM in GB
system.node_version        # e.g. "v20.18.0"
system.npm_version
system.git_sha             # full 40-char SHA of HEAD
system.git_branch          # branch name
system.git_dirty           # boolean: true if uncommitted changes exist
system.ts_version          # TypeScript version from node_modules
system.mmpm_api_key_set    # boolean (not the key itself)
run.protocol_version       # "1.0" — this document
run.started_at             # ISO8601 timestamp
run.profile                # benchmark profile name (e.g. "concurrent")
run.n_trials               # number of independent trials
run.warmup_ops             # ops run before measurement begins
run.atom_count             # atoms ingested before measurement
run.train_sequences        # sequences trained before measurement
run.concurrency            # agent concurrency for the concurrent profile
run.duration_ms            # measurement window per trial
run.random_seed            # if applicable
```

**Rule:** Any result JSON missing `system.*` fields is NOT citable.

### 2. Isolation Requirements

- No other benchmark processes running simultaneously
- System not under interactive use during measurement
- Terminal only — no browser or other heavy processes
- If on a laptop: plugged into power, fan/thermal steady (wait 60s after any heavy prior task)
- Close other applications to minimize memory pressure on the JIT and GC

### 3. Trial Protocol

Each **trial** is an independent run of the full benchmark (warmup + measurement). Trials must be:

- Run sequentially (not in parallel with each other)
- Each trial gets a fresh OS process for the harness (not reused state)
- MMPM server process stays running across trials (simulates real production)
- Measurement window: configurable, default 60 seconds of steady state
- Warmup: minimum 10,000 ops or 10 seconds before measurement begins (whichever is longer)

**Minimum trial counts by claim type:**

| Claim type | Minimum N |
|---|---|
| Point performance (latency/throughput) | 10 |
| Correctness (proof failures, stale reads) | 5 (but ops count must be ≥100k per trial) |
| Scaling experiment | 3 per atom-count data point |
| Cross-system comparison | 10 per system |
| Regression check (CI gate) | 3 |

### 4. Measurement Windows and What to Exclude

- **Exclude:** Server startup, initial atom ingestion, first 10% of measurement window
- **Include:** Only steady-state portion — server warm, atoms committed, Markov chains trained
- **Exclude from latency reporting:** Any measurement < 0.001ms (measurement noise floor)
- **Include from Prometheus:** Snapshot of all `mmpm_*` metrics taken mid-measurement window

### 5. Statistical Reporting Requirements

For any numeric claim in a paper or report, you must report:

| Stat | Symbol | How to compute |
|---|---|---|
| Mean | μ | arithmetic mean across trials |
| Standard deviation | σ | sample std dev (N-1 denominator) |
| 95% Confidence Interval | 95% CI | t-distribution: μ ± t(0.975, N-1) × σ/√N |
| Coefficient of Variation | CV | σ/μ — must be < 0.15 for a stable claim |
| Min / Max | | across trials |

**Example acceptable claim:**
> "P95 access latency: 0.088 ms (95% CI: 0.083–0.093 ms, σ=0.008 ms, N=10 trials, M3 Pro, macOS 15.3)"

**Example unacceptable claim:**
> "P95 access latency is about 0.09 ms" ← no CI, no N, no system

### 6. Cross-System Comparison

To compare results from different machines:

1. Both machines must run the same protocol version (check `run.protocol_version` in JSON)
2. Both must use the same git SHA (check `system.git_sha`)
3. Results must not be compared if `system.git_dirty = true`
4. Report system specs alongside numbers — reader must be able to contextualize hardware differences
5. Do **not** report a single "cross-system average" — report each system separately

### 7. Scaling Experiments

To make scalability claims, the `latencyVsAtomCount` experiment must be run:

- Atom counts: [100, 500, 1000, 5000, 10000, 50000, 100000] (minimum 5 points)
- Each point: 3 trials, report mean ± CI
- Fit a regression line: report R², slope, and whether sub-linear (slope < 1 on log-log scale)
- Write pressure variation: [0%, 10%, 30%, 50%] concurrent writes, 3 trials each

---

## Benchmark Profiles

Use these standard profiles (from `tools/harness/cli.ts`):

| Profile | Purpose | Claim scope |
|---|---|---|
| `smoke` | Quick sanity check, ~30s | NOT citable — for dev iteration only |
| `concurrent` | Primary performance profile | Latency, throughput, correctness claims |
| `stress` | High-load boundary testing | Backpressure and SLO-under-stress claims |
| `scaling` | Atom-count and write-pressure sweep | Scalability claims |

**Always use `concurrent` as the primary citable profile.** The `smoke` profile is too short and too light to produce statistically stable results.

---

## Running a Citable Benchmark

### Step 1: Ensure a clean environment

```bash
# Make sure server is running from committed code (no dirty changes for citable runs)
git status  # should show clean tree
git stash   # stash any WIP if needed

# Build from source
npm run build

# Start server fresh
pkill -f 'node dist/server.js' 2>/dev/null || true
sleep 1
node dist/server.js &
sleep 3

# Verify ready
curl -s http://localhost:3000/ready
```

### Step 2: Run the multi-trial scientific runner

```bash
# 10 trials, concurrent profile, 60s measurement window each
bash tools/harness/scientific_runner.sh \
  --trials 10 \
  --profile concurrent \
  --warmup-ops 10000 \
  --duration-ms 60000 \
  --out tools/harness/results/scientific
```

This produces:
- `results/scientific/run_<timestamp>/trial_01.json` … `trial_10.json`
- `results/scientific/run_<timestamp>/summary.json` — statistics across all trials
- `results/scientific/run_<timestamp>/system.json` — hardware/software fingerprint
- `results/scientific/run_<timestamp>/prometheus_snapshot.prom` — metrics mid-run

### Step 3: Run statistical analysis

```bash
python3 tools/harness/analyze_results.py \
  --run tools/harness/results/scientific/run_<timestamp> \
  --output report.md
```

Produces a markdown table with means, CIs, and a citeability checklist.

### Step 4: Compare across systems or runs

```bash
python3 tools/harness/analyze_results.py \
  --run tools/harness/results/scientific/run_<timestamp_A> \
  --compare tools/harness/results/scientific/run_<timestamp_B> \
  --output comparison.md
```

---

## What Must Be Reported Alongside Any Claim

Minimum disclosure for any published number:

1. Git SHA at time of run
2. System specs (CPU model, cores, RAM, OS)
3. Node.js version
4. Protocol version ("Protocol v1.0")
5. N (number of trials)
6. Profile name
7. Mean ± 95% CI
8. CV (coefficient of variation) — must be < 0.15

If any of these are missing, the result is **not citable**.

---

## Existing Baseline Results (2026-03-04)

These two runs were captured before this protocol existed. They are:
- Useful as **engineering references** and **regression baselines**
- **NOT citable** in a paper (missing system metadata, N=1 each, no CI)

| Run | Ops/sec | Access p95 (ms) | Hit Rate | Proof Failures |
|---|---|---|---|---|
| 2026-03-04T07:38:49Z | 6133.20 | 0.0922 | 70% | 0 |
| 2026-03-04T07:42:21Z | 6193.69 | 0.0883 | 70% | 0 |

To produce the first **citable** baseline, run the full 10-trial protocol above.

---

## Falsifiability Statement

For the architecture to be scientifically credible, the following must be *falsifiable*:

- If proof failures > 0, the correctness claim is **falsified**
- If access p95 regresses > 20% from baseline under same conditions, the performance claim must be updated
- If prediction hit rate < 55% after ≥884 train calls, the Markov utility claim requires re-examination
- If CV > 0.15 for any primary metric, the system is unstable under those conditions and the claim cannot be made

---

## Version History

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-03-05 | Initial protocol |
