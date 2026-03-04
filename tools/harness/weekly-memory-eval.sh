#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

STATE_FILE="tools/harness/weekly_eval_state.json"
RESULTS_DIR="tools/harness/results"
FORCE="${1:-}"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "ERROR: Missing $STATE_FILE" >&2
  exit 1
fi

mkdir -p "$RESULTS_DIR"

DUE_CHECK="$(node <<'NODE'
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('tools/harness/weekly_eval_state.json', 'utf8'));
const last = Date.parse(state.lastCompletedAt || '1970-01-01T00:00:00.000Z');
const now = Date.now();
const ageMs = Math.max(0, now - (Number.isFinite(last) ? last : 0));
const ageDays = ageMs / (1000 * 60 * 60 * 24);
const due = ageDays >= 7;
console.log(JSON.stringify({ due, ageDays, lastCompletedAt: state.lastCompletedAt || null }));
NODE
)"

DUE="$(echo "$DUE_CHECK" | node -e "const i=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(i.due?'1':'0');")"
AGE_DAYS="$(echo "$DUE_CHECK" | node -e "const i=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(i.ageDays.toFixed(2));")"
LAST_DONE="$(echo "$DUE_CHECK" | node -e "const i=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(i.lastCompletedAt||'never'));")"

if [[ "$FORCE" != "--force" && "$DUE" != "1" ]]; then
  echo "Weekly evaluation not due yet (last: $LAST_DONE, age: ${AGE_DAYS} days)."
  echo "Use --force to run anyway."
  exit 0
fi

echo "Running weekly evaluation (last: $LAST_DONE, age: ${AGE_DAYS} days)..."

npm run bench:run:concurrent

RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
REPORT_FILE="$RESULTS_DIR/weekly-${RUN_ID}.json"
PROM_FILE="$RESULTS_DIR/weekly-${RUN_ID}.prom"

cp "$RESULTS_DIR/latest.json" "$REPORT_FILE"
cp "$RESULTS_DIR/latest.prom" "$PROM_FILE"

RUN_ID="$RUN_ID" REPORT_FILE="$REPORT_FILE" PROM_FILE="$PROM_FILE" node <<'NODE'
const fs = require('fs');
const statePath = 'tools/harness/weekly_eval_state.json';
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const runId = process.env.RUN_ID;
const reportFile = process.env.REPORT_FILE;
const promFile = process.env.PROM_FILE;
state.lastCompletedAt = new Date().toISOString();
state.lastReportFile = reportFile;
state.lastPromFile = promFile;
state.lastRunId = runId;
state.lastProfile = 'concurrent';
state.notes = 'Auto-updated by tools/harness/weekly-memory-eval.sh';
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
NODE

npm run bench:track:save

echo "Weekly evaluation complete."
echo "Report: $REPORT_FILE"
echo "Prom:   $PROM_FILE"
echo "State:  $STATE_FILE"
