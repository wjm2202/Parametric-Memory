# Memory Persistence Marker

**Created:** 2026-03-07T06:36:03Z
**Purpose:** Prove that MMPM memory is sticky and persistent across sessions.

---

## The Test

In a future session, ask Claude:

> *"Find the MEMORY_MARKER canary atom and tell me its value."*

Claude should be able to retrieve the atom from MMPM without any other hints, proving that memory survived across context resets.

---

## What Was Stored

Four atoms were written to MMPM memory on 2026-03-07:

| Atom | Type | Meaning |
|------|------|---------|
| `v1.fact.marker_atom_value_is_CANARY_LODESTAR_7749` | fact | **The canary** — this is the needle to find |
| `v1.fact.marker_created_during_sprint16_security_hardening` | fact | Context: when this was created |
| `v1.event.memory_persistence_marker_created_2026_03_07_063603` | event | Timestamp event |
| `v1.state.memory_persistence_test_pending_verification` | state | Signals the test is awaiting future verification |

The Markov chain was also trained with the sequence:
`session_started → marker_created_event → CANARY_LODESTAR_7749 → test_pending_verification`

This means the canary can be surfaced either by:
- Direct search: `POST /search {"query": "CANARY_LODESTAR_7749"}`
- Markov traversal from `v1.event.session_started`

---

## Verification Steps (for the future session)

1. Start MMPM server if not running
2. Run: `POST /search {"query": "CANARY_LODESTAR_7749", "limit": 3}`
3. Confirm `v1.fact.marker_atom_value_is_CANARY_LODESTAR_7749` is returned as rank 1
4. Update the state atom — tombstone `v1.state.memory_persistence_test_pending_verification` and store `v1.state.memory_persistence_test_PASSED_<date>`

---

## Merkle Proof (at time of creation)

The canary atom was written to **shard 0**, Merkle tree root:
`0b2a9170284501e21c3ae1f175b4b6f6f8450e1cfd69894dc1fddef6018843a4`

Leaf hash: `dfc647430ef0928d3b4472a7283425b43365236c85e16f70590d8746ba93df3e`

This proof can be independently verified with `GET /atoms/v1.fact.marker_atom_value_is_CANARY_LODESTAR_7749/proof`.
