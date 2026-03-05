#!/usr/bin/env python3
"""
MMPM Scientific Results Analyzer
Computes confidence intervals, runs statistical tests, and produces
citable markdown reports from scientific_runner.sh output.

Usage:
  # Single run report
  python3 tools/harness/analyze_results.py --run tools/harness/results/scientific/run_<ts>

  # Cross-system or cross-version comparison
  python3 tools/harness/analyze_results.py \
    --run tools/harness/results/scientific/run_<ts_A> \
    --compare tools/harness/results/scientific/run_<ts_B> \
    [--output report.md]

  # Analyze raw trial JSONs from a directory
  python3 tools/harness/analyze_results.py --run <dir> --output report.md
"""

import argparse
import json
import math
import sys
from pathlib import Path
from datetime import datetime, timezone


# ── Statistics utilities ──────────────────────────────────────────────────────

def mean(xs):
    return sum(xs) / len(xs) if xs else None

def sample_std(xs):
    if len(xs) < 2:
        return 0.0
    mu = mean(xs)
    return math.sqrt(sum((x - mu) ** 2 for x in xs) / (len(xs) - 1))

def t_critical(df, confidence=0.95):
    """Two-tailed t critical value. Lookup table for common df values."""
    table = {
        1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
        6: 2.447,  7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
        11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
        20: 2.086, 25: 2.060, 30: 2.042, 40: 2.021, 60: 2.000,
        120: 1.980,
    }
    closest = min(table.keys(), key=lambda k: abs(k - df))
    return table[closest]

def ci95(xs):
    n = len(xs)
    if n < 2:
        return (None, None)
    mu = mean(xs)
    sigma = sample_std(xs)
    t = t_critical(n - 1)
    margin = t * sigma / math.sqrt(n)
    return (mu - margin, mu + margin)

def welch_t_test(xs, ys):
    """Welch's t-test (unequal variances). Returns (t_stat, approx_p_value_category)."""
    if len(xs) < 2 or len(ys) < 2:
        return None, "insufficient data"
    mu_x, mu_y = mean(xs), mean(ys)
    var_x = sample_std(xs) ** 2
    var_y = sample_std(ys) ** 2
    n_x, n_y = len(xs), len(ys)
    se = math.sqrt(var_x / n_x + var_y / n_y)
    if se == 0:
        return 0, "p=1 (identical)"
    t = (mu_x - mu_y) / se
    # Welch–Satterthwaite df
    num = (var_x / n_x + var_y / n_y) ** 2
    denom = (var_x / n_x) ** 2 / (n_x - 1) + (var_y / n_y) ** 2 / (n_y - 1)
    df = num / denom if denom > 0 else min(n_x, n_y) - 1
    t_crit_05 = t_critical(int(df))
    t_crit_01 = t_critical(int(df)) * 1.15  # rough approximation
    if abs(t) > t_crit_01:
        p_cat = "p<0.01"
    elif abs(t) > t_crit_05:
        p_cat = "p<0.05"
    else:
        p_cat = "p≥0.05 (not significant)"
    return round(t, 3), p_cat

def cohen_d(xs, ys):
    """Cohen's d effect size."""
    if len(xs) < 2 or len(ys) < 2:
        return None
    n_x, n_y = len(xs), len(ys)
    s_x = sample_std(xs)
    s_y = sample_std(ys)
    pooled = math.sqrt(((n_x - 1) * s_x**2 + (n_y - 1) * s_y**2) / (n_x + n_y - 2))
    if pooled == 0:
        return 0
    return (mean(xs) - mean(ys)) / pooled

def effect_label(d):
    if d is None: return "N/A"
    d = abs(d)
    if d < 0.2: return "negligible"
    if d < 0.5: return "small"
    if d < 0.8: return "medium"
    return "large"


# ── Data loading ──────────────────────────────────────────────────────────────

def load_run(run_dir: Path):
    """Load all trial JSONs and system metadata from a run directory."""
    if not run_dir.exists():
        print(f"ERROR: Run directory not found: {run_dir}", file=sys.stderr)
        sys.exit(1)

    # Try summary.json first (faster), fall back to trial files
    summary_file = run_dir / "summary.json"
    if summary_file.exists():
        with open(summary_file) as f:
            summary = json.load(f)
        system = summary.get("system", {})
    else:
        system = {}
        summary = None

    trial_files = sorted(run_dir.glob("trial_*.json"))
    if not trial_files:
        # Maybe it's an older results directory with just one file
        json_files = [f for f in run_dir.glob("*.json") if "system" not in f.name and "summary" not in f.name]
        if len(json_files) == 1:
            print(f"  Found single result file (pre-protocol): {json_files[0].name}")
            trial_files = json_files
        else:
            print(f"ERROR: No trial_*.json files found in {run_dir}", file=sys.stderr)
            sys.exit(1)

    trials = []
    for tf in trial_files:
        with open(tf) as f:
            trials.append(json.load(f))

    system_file = run_dir / "system.json"
    if system_file.exists():
        with open(system_file) as f:
            system_meta = json.load(f)
        if not system:
            system = system_meta.get("system", {})
        # Promote git and run fields into summary so report can access them
        if summary is None:
            summary = {}
        if "git" not in summary:
            summary["git"] = system_meta.get("git", {})
        if "run" not in summary:
            summary["run"] = system_meta.get("run", {})

    return {"trials": trials, "system": system, "run_dir": run_dir, "summary": summary}


def extract_metric(trials, *keys):
    """Extract a scalar metric from all trials."""
    results = []
    for t in trials:
        v = t
        try:
            for k in keys:
                v = v[k]
            results.append(float(v))
        except (KeyError, TypeError, ValueError):
            pass
    return results


# ── Reporting ─────────────────────────────────────────────────────────────────

METRICS = [
    ("Access p95 latency (ms)",    ["latency", "accessP95Ms"]),
    ("Access p50 latency (ms)",    ["latency", "accessP50Ms"]),
    ("Access p99 latency (ms)",    ["latency", "accessP99Ms"]),
    ("Commit p95 latency (ms)",    ["latency", "commitP95Ms"]),
    ("Proof verify avg (ms)",      ["latency", "proofVerifyAvgMs"]),
    ("Throughput (ops/sec)",        ["throughput", "totalOpsPerSec"]),
    ("Read throughput (ops/sec)",   ["throughput", "readsPerSec"]),
    ("Markov hit rate",             ["prediction", "hitRate"]),
    ("Proof failures",              ["correctness", "proofFailures"]),
    ("Stale reads",                 ["correctness", "staleReads"]),
    ("Version mismatches",          ["correctness", "versionMismatches"]),
]

def format_ci(lo, hi):
    if lo is None or hi is None:
        return "N/A"
    return f"[{lo:.4f}, {hi:.4f}]"


def single_run_report(run: dict, title: str = None) -> str:
    trials = run["trials"]
    system = run["system"]
    n = len(trials)

    lines = []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines.append(f"# MMPM Scientific Benchmark Report")
    lines.append(f"")
    lines.append(f"**Generated:** {now}  ")
    lines.append(f"**Protocol version:** 1.0  ")
    lines.append(f"**Run directory:** `{run['run_dir']}`  ")
    lines.append(f"")

    # System metadata
    lines.append("## System Environment")
    lines.append("")
    lines.append(f"| Property | Value |")
    lines.append(f"|---|---|")
    lines.append(f"| CPU | {system.get('cpu_model', 'N/A')} |")
    lines.append(f"| Cores | {system.get('cpu_cores', 'N/A')} |")
    lines.append(f"| RAM | {system.get('ram_gb', 'N/A')} GB |")
    lines.append(f"| OS | {system.get('os', 'N/A')} |")
    lines.append(f"| Node.js | {system.get('node_version', 'N/A')} |")
    lines.append(f"| TypeScript | {system.get('ts_version', 'N/A')} |")

    summary = run.get("summary") or {}
    git = summary.get("git") or summary.get("system", {}).get("git", {}) or {}
    run_meta = summary.get("run") or {}
    lines.append(f"| Git SHA | `{git.get('sha', 'N/A')}` |")
    lines.append(f"| Git branch | `{git.get('branch', 'N/A')}` |")
    lines.append(f"| Git clean | {'✓ Yes' if not git.get('dirty') else '✗ No (not citable)'} |")
    lines.append(f"| Profile | `{run_meta.get('profile', 'N/A')}` |")
    lines.append(f"| N trials | {n} |")
    lines.append(f"")

    # Results table
    lines.append("## Results")
    lines.append("")
    lines.append("All values are mean across N independent trials.")
    lines.append("")
    lines.append(f"| Metric | Mean | 95% CI | σ | CV | N | Citable |")
    lines.append(f"|---|---:|---|---:|---:|---:|:---:|")

    all_citable = True
    for label, keys in METRICS:
        vals = extract_metric(trials, *keys)
        if not vals:
            continue
        mu = mean(vals)
        sigma = sample_std(vals)
        cv = sigma / mu if mu > 0 else 0
        lo, hi = ci95(vals)
        citable = cv < 0.15 and len(vals) >= 10
        if not citable:
            all_citable = False
        lines.append(
            f"| {label} | {mu:.4f} | {format_ci(lo, hi)} | {sigma:.4f} | {cv:.3f} | {len(vals)} | {'✓' if citable else '✗'} |"
        )

    lines.append("")

    # Citeability checklist
    lines.append("## Citeability Checklist")
    lines.append("")
    git_clean = not git.get("dirty", True)
    n_ok = n >= 10
    checks = [
        ("Git tree clean (no uncommitted changes)", git_clean),
        ("N ≥ 10 trials", n_ok),
        ("All metrics CV < 0.15", all_citable),
    ]
    for desc, ok in checks:
        lines.append(f"- {'✓' if ok else '✗'} {desc}")
    lines.append("")
    if all(ok for _, ok in checks):
        lines.append("**✓ FULLY CITABLE** — All protocol requirements met.")
    else:
        lines.append("**✗ NOT FULLY CITABLE** — See items marked ✗ above.")
    lines.append("")

    # Template citation text
    lines.append("## Citation Template")
    lines.append("")
    lines.append("Copy-paste this into your paper (fill in bracketed values):")
    lines.append("")
    vals_p95 = extract_metric(trials, "latency", "accessP95Ms")
    vals_ops = extract_metric(trials, "throughput", "totalOpsPerSec")
    vals_hit = extract_metric(trials, "prediction", "hitRate")
    vals_pf = extract_metric(trials, "correctness", "proofFailures")
    if vals_p95:
        mu_p95 = mean(vals_p95)
        lo_p95, hi_p95 = ci95(vals_p95)
    if vals_ops:
        mu_ops = mean(vals_ops)
        lo_ops, hi_ops = ci95(vals_ops)
    if vals_hit:
        mu_hit = mean(vals_hit)
    if vals_pf:
        mu_pf = mean(vals_pf)

    lines.append(f"> \"Under the concurrent benchmark profile on {system.get('cpu_model', '[CPU]')} ")
    lines.append(f"> ({system.get('cpu_cores', '[N]')} cores, {system.get('ram_gb', '[N]')} GB RAM, ")
    lines.append(f"> {system.get('os', '[OS]')}, Node.js {system.get('node_version', '[version]')}), ")
    if vals_p95:
        lines.append(f"> MMPM achieves a P95 access latency of {mu_p95:.3f} ms ")
        lines.append(f"> (95% CI: {lo_p95:.3f}–{hi_p95:.3f} ms, N={len(vals_p95)} trials, Protocol v1.0, ")
        lines.append(f"> git {git.get('sha','?')[:12]}). ")
    if vals_ops:
        lines.append(f"> Sustained throughput: {mu_ops:.0f} ops/sec ")
        lines.append(f"> (95% CI: {lo_ops:.0f}–{hi_ops:.0f}). ")
    if vals_hit:
        lines.append(f"> Markov prediction hit rate: {mu_hit:.1%}. ")
    if vals_pf:
        lines.append(f"> Proof failures: {int(mu_pf)}.\"")
    lines.append("")

    return "\n".join(lines)


def comparison_report(run_a: dict, run_b: dict, label_a="Run A", label_b="Run B") -> str:
    lines = []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines.append(f"# MMPM Cross-Run Comparison Report")
    lines.append(f"")
    lines.append(f"**Generated:** {now}  ")
    lines.append(f"**Protocol version:** 1.0  ")
    lines.append(f"")

    sys_a = run_a["system"]
    sys_b = run_b["system"]
    git_a = (run_a.get("summary") or {}).get("git", {}) or {}
    git_b = (run_b.get("summary") or {}).get("git", {}) or {}

    lines.append("## System Comparison")
    lines.append("")
    lines.append(f"| Property | {label_a} | {label_b} |")
    lines.append(f"|---|---|---|")
    for prop in ["cpu_model", "cpu_cores", "ram_gb", "os", "node_version"]:
        lines.append(f"| {prop} | {sys_a.get(prop,'N/A')} | {sys_b.get(prop,'N/A')} |")
    lines.append(f"| Git SHA | `{git_a.get('sha','?')[:12]}` | `{git_b.get('sha','?')[:12]}` |")
    lines.append(f"| N trials | {len(run_a['trials'])} | {len(run_b['trials'])} |")
    lines.append("")

    same_sha = git_a.get("sha") == git_b.get("sha") and git_a.get("sha")
    if not same_sha:
        lines.append("> ⚠️  **Different git SHAs.** Results reflect different code versions. ")
        lines.append("> Note this when interpreting differences — they may reflect code changes, not just hardware.")
        lines.append("")

    # Metric comparison table
    lines.append("## Metric Comparison")
    lines.append("")
    lines.append(f"| Metric | {label_a} mean (95% CI) | {label_b} mean (95% CI) | Δ | t-stat | p-value | Effect (Cohen's d) |")
    lines.append(f"|---|---|---|---:|---:|---|---|")

    for label, keys in METRICS:
        vals_a = extract_metric(run_a["trials"], *keys)
        vals_b = extract_metric(run_b["trials"], *keys)
        if not vals_a or not vals_b:
            continue
        mu_a, mu_b = mean(vals_a), mean(vals_b)
        lo_a, hi_a = ci95(vals_a)
        lo_b, hi_b = ci95(vals_b)
        delta = mu_b - mu_a
        t_stat, p_cat = welch_t_test(vals_a, vals_b)
        d = cohen_d(vals_a, vals_b)
        d_label = effect_label(d)
        delta_pct = (delta / mu_a * 100) if mu_a else 0
        delta_str = f"{delta:+.4f} ({delta_pct:+.1f}%)"
        d_str = f"{d_label} (d={d:.2f})" if d is not None else "N/A"
        t_str = f"{t_stat:.3f}" if t_stat is not None else "N/A"
        lines.append(
            f"| {label} "
            f"| {mu_a:.4f} {format_ci(lo_a, hi_a)} "
            f"| {mu_b:.4f} {format_ci(lo_b, hi_b)} "
            f"| {delta_str} "
            f"| {t_str} "
            f"| {p_cat} "
            f"| {d_str} |"
        )

    lines.append("")
    lines.append("> **Interpretation guidance:** p<0.05 indicates a statistically significant difference at the 95% confidence level.")
    lines.append("> Cohen's d: negligible (<0.2), small (0.2–0.5), medium (0.5–0.8), large (>0.8).")
    lines.append("> A statistically significant difference is not necessarily practically significant — consider effect size.")
    lines.append("")

    return "\n".join(lines)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="MMPM Scientific Results Analyzer")
    parser.add_argument("--run", required=True, help="Path to run directory (contains trial_*.json)")
    parser.add_argument("--compare", help="Optional second run directory for comparison")
    parser.add_argument("--label-a", default="Run A", help="Label for --run in comparison")
    parser.add_argument("--label-b", default="Run B", help="Label for --compare in comparison")
    parser.add_argument("--output", help="Output markdown file (default: print to stdout)")
    args = parser.parse_args()

    run_a = load_run(Path(args.run))
    print(f"Loaded {len(run_a['trials'])} trials from {args.run}", file=sys.stderr)

    if args.compare:
        run_b = load_run(Path(args.compare))
        print(f"Loaded {len(run_b['trials'])} trials from {args.compare}", file=sys.stderr)
        report = comparison_report(run_a, run_b, label_a=args.label_a, label_b=args.label_b)
    else:
        report = single_run_report(run_a)

    if args.output:
        Path(args.output).write_text(report)
        print(f"Report written to {args.output}", file=sys.stderr)
    else:
        print(report)


if __name__ == "__main__":
    main()
