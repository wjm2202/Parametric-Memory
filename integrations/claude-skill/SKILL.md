# Parametric-Memory (MMPM) — Claude Skill

**Install this skill in Claude Cowork to give Claude persistent, cryptographically verifiable memory backed by your local MMPM server.**

---

## What this skill does

This skill connects Claude to your running Parametric-Memory (MMPM) server. Claude can:

- **Remember facts, events, and state** across sessions — stored as typed atoms
- **Recall previous context** at the start of any session
- **Prove** what it remembered — every atom has a Merkle proof path
- **Predict** what context is most relevant next, via the Markov chain engine

---

## Setup

1. **Start your MMPM server** (takes 10 seconds):
   ```bash
   cd your-parametric-memory-repo
   ./start.sh
   # or: docker-compose up
   ```
   Server runs at `http://localhost:3000` by default.

2. **Install this skill** in Claude Cowork:
   - Copy the `integrations/claude-skill/` folder to your Claude skills directory
   - Or drag `parametric-memory.skill` (if provided) into Cowork

3. **Set your API key** (optional but recommended):
   - Add `MMPM_API_KEY=your-key` to `.env` in the repo
   - The skill reads this automatically

---

## Server config

Default URL: `http://localhost:3000`

Before making any API calls, check that the server is running and auto-start if needed:

```bash
curl -s http://localhost:3000/health
```

If it returns `{"status":"ok","ready":true,...}` you're good. If it fails (exit code 7), start it:

```bash
cd /path/to/parametric-memory && ./start.sh &
```

Set these shell variables for all subsequent calls:

```bash
MMPM_URL="http://localhost:3000"
# Read API key from .env if available
if [ -f /path/to/parametric-memory/.env ]; then
  _ENV_KEY=$(grep -E '^MMPM_API_KEY=' /path/to/parametric-memory/.env | head -1 | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d ' ')
fi
MMPM_KEY="${_ENV_KEY:-}"
```

---

## Atom format

MMPM stores typed atoms in the form `v1.<type>.<value>`:

| Type | Use for | Example |
|------|---------|---------|
| `fact` | Stable facts, preferences | `v1.fact.user_prefers_dark_mode` |
| `state` | Current working state | `v1.state.working_on_sprint_13` |
| `event` | Completed milestones | `v1.event.feature_shipped_2026_04_06` |
| `relation` | Links between concepts | `v1.relation.MMPM_uses_LevelDB` |
| `other` | Anything else | `v1.other.misc_note` |

Rules: snake_case, no spaces, no punctuation in value.

---

## Loading memory at session start

```bash
# Fast context endpoint (preferred)
curl -s -H "Authorization: Bearer $MMPM_KEY" "$MMPM_URL/memory/context"

# Walk Markov chain to surface what's most relevant now
curl -s -X POST \
  -H "Authorization: Bearer $MMPM_KEY" \
  -H "Content-Type: application/json" \
  "$MMPM_URL/access" \
  -d '{"data":"v1.event.session_started"}'
```

Present context warmly — lead with the most meaningful facts, not a raw list.

---

## Saving memory

```bash
# Store atoms
curl -s -X POST \
  -H "Authorization: Bearer $MMPM_KEY" \
  -H "Content-Type: application/json" \
  "$MMPM_URL/atoms" \
  -d '{"atoms": ["v1.fact.user_name_is_Glen", "v1.state.working_on_launch"]}'

# Commit immediately
curl -s -X POST -H "Authorization: Bearer $MMPM_KEY" "$MMPM_URL/admin/commit"

# Train sequence for Markov prediction
curl -s -X POST \
  -H "Authorization: Bearer $MMPM_KEY" \
  -H "Content-Type: application/json" \
  "$MMPM_URL/train" \
  -d '{"sequence": ["v1.event.session_started", "v1.state.working_on_launch"]}'
```

---

## Auditing memory

```bash
# Get atom with its full Merkle proof
curl -s -H "Authorization: Bearer $MMPM_KEY" "$MMPM_URL/atoms/v1.fact.example"

# Verify a proof independently (no auth required)
curl -s -X POST "$MMPM_URL/verify" \
  -H "Content-Type: application/json" \
  -d '{"atom":"v1.fact.example","proof":{...}}'

# Point-in-time replay — what did memory look like yesterday?
curl -s -H "Authorization: Bearer $MMPM_KEY" \
  "$MMPM_URL/memory/context?asOfMs=1772000000000"
```

---

## Cleaning up stale state

```bash
# Tombstone an outdated state atom
curl -s -X DELETE -H "Authorization: Bearer $MMPM_KEY" \
  "$MMPM_URL/atoms/v1.state.old_state_name"

# Find atoms that haven't been touched in 30 days
curl -s -H "Authorization: Bearer $MMPM_KEY" \
  "$MMPM_URL/atoms/stale?type=state&maxAgeDays=30"
```

---

## End-of-session save pattern

Always finish a session by:
1. Storing new facts/events
2. Tombstoning completed state atoms
3. Committing
4. Training the session arc so next session cold-start is useful

```bash
curl -s -X POST -H "Authorization: Bearer $MMPM_KEY" -H "Content-Type: application/json" \
  "$MMPM_URL/atoms" \
  -d '{"atoms": ["v1.event.task_completed_today", "v1.state.next_task_is_X"]}'

curl -s -X DELETE -H "Authorization: Bearer $MMPM_KEY" \
  "$MMPM_URL/atoms/v1.state.old_task"

curl -s -X POST -H "Authorization: Bearer $MMPM_KEY" "$MMPM_URL/admin/commit"

curl -s -X POST -H "Authorization: Bearer $MMPM_KEY" -H "Content-Type: application/json" \
  "$MMPM_URL/train" \
  -d '{"sequence":["v1.event.session_started","v1.state.next_task_is_X","v1.event.task_completed_today"]}'
```

---

## More information

- GitHub: https://github.com/wjm2202/Parametric-Memory
- Website: https://parametric-memory.dev
- API docs: see `README.md` in the repo root
