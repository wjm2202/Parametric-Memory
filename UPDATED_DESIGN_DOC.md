# Markov–Merkle Predictive Memory (MMPM)
## Updated Design Document (Implementation-Accurate)

**Date:** March 3, 2026  
**Scope:** This document describes the implemented behavior in the current codebase and avoids unverified performance claims.

---

## 1. System Model

MMPM is a sharded memory system with:

1. **State atoms** (schema-v1 strings),
2. **Per-shard Merkle snapshots** for membership proofs,
3. **A master Merkle tree** over shard roots,
4. **Per-shard transition weights** for next-state prediction,
5. **WAL + LevelDB durability** for structural mutations.

### 1.1 Core Sets and Functions

Let:

- $A$ be the set of registered atoms,
- $S = \{0,1,\dots,k-1\}$ be shard IDs,
- $r: A \to S$ be the shard router function,
- $H(x) = \text{SHA-256}(x)$,
- $T_s(i,j) \in \mathbb{N}$ be transition counts in shard $s$.

For atom $a \in A$, prediction is based on outgoing transition counts from its index in its owner shard.

---

## 2. Implemented Architecture

### 2.1 Request/Data Plane

- API routes normalize and validate atoms against strict schema-v1.
- Orchestrator routes atoms via consistent hashing with virtual nodes.
- Reads execute against immutable shard snapshots.
- Writes are batched via ingestion, then committed per shard.

### 2.2 Verification Plane

For each read report:

- `currentProof`: leaf-to-shard-root proof,
- `shardRootProof` (optional but used): shard-root-to-master-root proof,
- `treeVersion`: master version at issuance time.

Validator checks both proof levels and (when given live `MasterKernel`) resolves authoritative root by report version.

### 2.3 Durability Plane

For structural operations (`ADD`, `TOMBSTONE`):

1. WAL append + fsync,
2. in-memory mutation,
3. pending-write queue update,
4. LevelDB write.

Commit writes `COMMIT` marker, then truncates WAL.

---

## 3. Mathematical Formulation

### 3.1 Transition Estimator

For atom/state $i$ with outgoing neighbors $\mathcal{N}(i)$, estimated transition probability is:

$$
\hat P(j\mid i)=\frac{T(i,j)}{\sum_{u\in\mathcal{N}(i)}T(i,u)}.
$$

Implementation uses **argmax** of $T(i,j)$ (with deterministic tie-break by index/order), not random sampling.

### 3.2 Proof Composition

Let:

- $\pi_1$ be a valid Merkle proof for $H(a)$ in shard tree with root $R_s$,
- $\pi_2$ be a valid Merkle proof for $H(R_s)$ in master tree with root $R_m$.

Then the report establishes membership of atom $a$ in the master-anchored shard forest state corresponding to the report version.

---

## 4. Correctness and Safety Proofs

## 4.1 Proof Verification Correctness

**Proposition 1 (Merkle verification correctness).**  
Given a proof tuple $(\ell, \text{auditPath}, i, r)$ produced by the implemented tree construction, the verifier returns `true` iff iterative recomposition from $\ell$ and siblings in `auditPath` equals $r$.

**Proof.**  
At each level, verifier concatenates in left/right order determined by parity of the current index and hashes once. This is exactly the inverse of the construction recurrence used to build parent hashes. Repeating across all levels reconstructs the root of the unique path from leaf position $i$ to the root. Therefore equality holds iff the path data is consistent with root $r$. ∎

---

## 4.2 Two-Level Membership Soundness

**Proposition 2 (Composed membership).**  
If both checks pass:

1. `verifyProof(H(a), currentProof)` and
2. `verifyProof(H(currentProof.root), shardRootProof)`

and `shardRootProof.root` equals the authoritative master root for `treeVersion`, then atom $a$ is a member of the shard represented in the master forest at that version.

**Proof.**  
(1) proves $H(a)$ is a leaf in some shard tree with root $R_s = \text{currentProof.root}$.  
(2) proves $H(R_s)$ is a leaf in the master tree with root $R_m = \text{shardRootProof.root}$.  
Version check binds $R_m$ to the authoritative state for the report’s version. Therefore $a$ is included in that versioned forest state. ∎

---

## 4.3 Snapshot Read Consistency Under Epoch Protocol

**Proposition 3 (No mixed-snapshot read).**  
A single read operation cannot observe a partially committed state.

**Assumptions from implementation:**

- Read acquires ticket with current epoch and references current immutable snapshot.
- Commit first increments epoch, waits for old-epoch readers to drain, then swaps snapshot pointer.

**Proof.**  
A reader in epoch $e$ uses snapshot pointer valid for $e$ and finishes before commit continues past drain barrier for $e$. Readers that start after epoch increment get epoch $e+1$ and thus post-commit snapshot reference. Since snapshot objects are immutable, no reader observes in-place mutation. Hence each read is consistent with one snapshot version. ∎

---

## 4.4 WAL Recovery Safety

**Proposition 4 (Crash recoverability of structural ops).**  
Any `ADD`/`TOMBSTONE` that returns from WAL append is recoverable after crash, and entries after the last `COMMIT` marker are replayable.

**Proof sketch.**

- WAL append uses fsync before subsequent in-memory/DB effects.
- Recovery loads WAL, verifies checksumed entries, and selects suffix after last `COMMIT`.
- Replay re-applies missing atom/tombstone effects with idempotence guards (`dataIndex`/tombstone checks).
- System then commits and truncates WAL.

Thus operations persisted to WAL but not fully integrated pre-crash are re-materialized; committed prefixes before last `COMMIT` are excluded from replay, preventing duplicate committed-log replay. ∎

---

## 4.5 Tombstone Index Stability

**Proposition 5 (Index stability for non-deleted leaves).**  
Tombstoning an index replaces leaf hash with sentinel zero hash and does not shift indices of other leaves.

**Proof.**  
Operation updates existing leaf position; no removal/compaction of leaf array occurs in commit path. Therefore all other leaf indices are invariant. Only ancestor hashes along tombstoned path change. ∎

---

## 5. Complexity (As Implemented)

Let $N$ be shard leaf count and $d(i)$ be out-degree of state $i$.

- **Proof generation:** $O(\log N)$ using cached heap-indexed node array in snapshot.
- **Proof verification:** $O(\log N)$.
- **Top prediction lookup:**
  - CSR path: approximately $O(1)$ for top prediction retrieval,
  - fallback map path: $O(d(i))$ scan.
- **Single tombstone/update commit work in incremental tree:** $O(\log N)$ for leaf propagation.
- **Append:**
  - $O(\log N)$ within current capacity,
  - occasional $O(N)$ on capacity doubling rebuild.
- **Router lookup:** ring binary search over vnode keys: $O(\log V)$ where $V$ = total virtual nodes.

No fixed latency numbers are asserted here.

---

## 6. Convergence Statement (Statistical, Non-Guarantee)

For repeated observations of transitions from state $i$, empirical frequency estimator for $P(j\mid i)$ is consistent under standard i.i.d./ergodic assumptions on observed transitions:

$$
\hat P_n(j\mid i) \to P(j\mid i) \quad \text{as } n\to\infty.
$$

This is a statistical property of frequency estimators, not a deterministic guarantee of perfect next-step prediction in finite samples.

---

## 7. Operational Guarantees and Limits

### Guarantees (from implementation)

1. **Strict schema-v1 atom validation** at ingestion/access/train boundaries.
2. **Readiness gating** for non-probe traffic until orchestrator initialization completes.
3. **Backpressure admission control** based on projected pending depth.
4. **Versioned proof validation** while root history window retains the target version.

### Limits / Explicit Boundaries

1. If `treeVersion` is older than retained master-root history window, validator cannot verify against evicted root version.
2. Warm-read mode for pending atoms is explicitly unverified (`currentProof = null`).
3. Transition learning is count-based first-order Markov; no higher-order sequence model is implemented.

---

## 8. Summary

The updated MMPM implementation is a **composed correctness system**:

- cryptographic membership correctness (Merkle proofs),
- concurrency correctness (epoch-gated immutable snapshots),
- crash safety (WAL-first replayable mutation log),
- adaptive utility (online sparse transition learning).

Its central engineering result is not a new hash or stochastic theorem, but a robust integration where prediction and verification coexist in one versioned runtime contract.
