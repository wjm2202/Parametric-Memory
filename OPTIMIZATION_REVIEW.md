# MMPM Optimization Review (Prediction-Safe)

Date: 2026-03-03

## Scope
This review targets runtime efficiency improvements that **must not change Markov prediction semantics**.

### Hard invariants
- Do not change transition learning behavior (`recordTransition`).
- Do not change prediction winner/tie behavior.
- Do not change tombstone filtering rules.
- Do not change proof generation/validation semantics.

---

## Implemented Safe Optimizations (Phase 1)

### 1) `PendingWrites.addLeaf()` from O(n) to O(1)

#### Problem
`addLeaf()` computed prior add count by scanning all queued ops with `filter()` each call.

#### Change
Track a dedicated `addCount` field and increment on each add operation.

#### Expected impact
- Lower enqueue cost under heavy ingestion.
- Eliminates avoidable per-atom allocations and scans.

#### Semantics risk
None. Returned index hint remains the same logic (`count of prior add ops`).

---

### 2) Orchestrator hash-to-shard index for cross-shard hash resolution

#### Problem
Cross-shard resolution used repeated linear scans over all shards for:
- predicted hash fallback in `/access` and `/batch-access`
- unresolved transition targets in `getWeights()`

#### Change
Maintain orchestrator-level `Map<Hash, shardId>` and resolve hash directly to owning shard.

#### Index maintenance points
- Build index after `init()` from active atoms.
- Add/update entries after `addAtoms()` commits.
- Remove tombstoned atom entry during `removeAtom()`.

#### Expected impact
- Replaces O(shardCount) scans with near O(1) lookups.
- Lower p95 latency under multi-shard workloads.

#### Semantics risk
Low when implemented as a pure lookup optimization. Prediction selection logic is unchanged.

---

## Next candidates (not yet implemented)

1. Incremental/dirty-row CSR updates instead of full rebuild per commit.
2. Reduce allocation-heavy fallback paths in policy-constrained candidate selection.
3. Reduce WAL compaction check I/O frequency (`fd.stat()` cadence).
4. Optional atom-type cache by index to avoid repeated parsing in hot loops.

---

## Implemented Safe Optimizations (Phase 2)

### 3) Dirty-aware CSR rebuild gating on commit

#### Problem
CSR projection rebuild was executed on commit even when no transition/tombstone changes required it.

#### Change
Added a CSR dirty flag and conditional rebuild policy in shard commit flow:
- Rebuild CSR when transitions were updated since last rebuild.
- Rebuild CSR when tombstones are part of the pending commit.
- Skip rebuild on add-only commits with no transition dirtiness.

#### Why prediction semantics are preserved
- No change to transition learning/update logic.
- No change to selection logic or tie behavior.
- CSR content is rebuilt under the same rules when it is needed for semantic correctness.

### 4) Single-pass policy-constrained fallback selection

#### Problem
Policy-constrained fallback path allocated and sorted candidate arrays.

#### Change
Replaced allocation-heavy map/filter/sort fallback with single-pass best-candidate selection while preserving ordering semantics (weight desc, then index asc).

#### Why prediction semantics are preserved
- Candidate ranking comparator remains identical to previous sort order.
- Filtered/not-filtered outcome remains equivalent to prior "first allowed in ranked list" behavior.

---

## Additional validation evidence (Phase 2)

Command run:

```bash
npm test -- src/__tests__/shard_worker.test.ts src/__tests__/orchestrator.test.ts src/__tests__/versioning.test.ts src/__tests__/convergence.test.ts
```

Observed result:
- Test files: `4 passed`
- Tests: `99 passed (99)`

Interpretation:
- Prediction behavior, convergence properties, orchestrator behavior, and versioning checks remained green after Phase 2 changes.

---

## Implemented Safe Optimization (Phase 3)

### 5) Atom-type cache by index in shard hot paths

#### Problem
Policy-constrained prediction paths repeatedly called `parseAtomV1()` for source/target atom type checks.

#### Change
Added `atomTypes: AtomType[]` cache in `ShardWorker`, maintained at:
- constructor seed load,
- LevelDB hydration,
- WAL replay for recovered `ADD` entries,
- runtime `addAtoms()` path.

Then replaced repeated parse calls in hot paths with index-based type lookup.

#### Why prediction semantics are preserved
- Atom strings remain unchanged.
- Type is derived once from the same parser and reused.
- Policy checks still evaluate the same `(fromType, toType)` relation.
- Ranking and tie-break behavior are unchanged.

## Additional validation evidence (Phase 3)

Command run:

```bash
npm test -- src/__tests__/shard_worker.test.ts src/__tests__/orchestrator.test.ts src/__tests__/versioning.test.ts src/__tests__/convergence.test.ts
```

Observed result:
- Test files: `4 passed`
- Tests: `99 passed (99)`

Interpretation:
- Prediction outputs and convergence checks remained stable with atom-type caching enabled.

---

## Implemented Safe Optimization (Phase 4)

### 6) WAL compaction stat-check gating

#### Problem
`compactIfNeeded()` performed file `stat()` checks on every appended WAL entry, adding unnecessary filesystem overhead.

#### Change
Added byte-accumulator gating in `ShardWAL`:
- Track bytes written since the last compaction-size check.
- Only call `fd.stat()` once accumulated bytes exceed a configurable interval.
- Keep compaction threshold semantics unchanged.

#### Why system semantics are preserved
- Durability ordering is unchanged (`write` + `fsync` still happens per entry).
- Recovery/read/compaction logic is unchanged once compaction check is triggered.
- No interaction with prediction logic.

## Additional validation evidence (Phase 4)

Commands run:

```bash
npm test -- src/__tests__/wal.test.ts
npm test -- src/__tests__/shard_worker.test.ts src/__tests__/orchestrator.test.ts src/__tests__/versioning.test.ts src/__tests__/convergence.test.ts
```

Observed result:
- WAL suite: `11 passed (11)`
- Prediction/versioning suite: `99 passed (99)`

Interpretation:
- WAL behavior remains correct under compaction-focused tests.
- Prediction and convergence behavior remains unchanged.

---

## Implemented Safe Optimization (Phase 5)

### 7) Atom hash caching in shard hot paths

#### Problem
`sha256(atom)` was recomputed in multiple shard paths (`getHash`, `getAtomRecord`, tombstone fallback), causing repeated CPU work for stable atom strings.

#### Change
Added `atomHashes: Map<DataAtom, Hash>` cache in `ShardWorker` and wired it through:
- constructor seed setup,
- LevelDB hydration,
- WAL replay ADD recovery,
- runtime `addAtoms()`.

Then reused cached hashes in existing call sites.

#### Why system semantics are preserved
- Hash function and atom inputs are unchanged.
- Cached values are exact results of prior `sha256(atom)` computation.
- No changes to prediction ranking, transition updates, proofs, or durability ordering.

## Additional validation evidence (Phase 5)

Commands run:

```bash
npm test -- src/__tests__/shard_worker.test.ts src/__tests__/orchestrator.test.ts src/__tests__/versioning.test.ts src/__tests__/convergence.test.ts
npm test -- src/__tests__/wal.test.ts
```

Observed result:
- Prediction/versioning suite: `99 passed (99)`
- WAL suite: `11 passed (11)`

Interpretation:
- Prediction behavior and persistence behavior remained stable with hash caching enabled.

---

## Implemented Safe Optimization (Phase 6)

### 8) Router ring build-path optimization (single sort)

#### Problem
Router constructor sorted ring keys repeatedly after each shard insertion.

#### Change
Deferred sorting of ring keys until all virtual nodes are inserted, performing a single sort in constructor finalization.

#### Why system semantics are preserved
- Final sorted key set is identical to prior implementation.
- Binary-search routing logic is unchanged.
- Hash function and vnode generation are unchanged.

## Additional validation evidence (Phase 6)

Commands run:

```bash
npm test -- src/__tests__/router.test.ts
npm test -- src/__tests__/orchestrator.test.ts src/__tests__/shard_consistency.test.ts src/__tests__/convergence.test.ts
```

Observed result:
- Router suite: `7 passed (7)`
- Integration/convergence suite: `77 passed (77)`

Interpretation:
- Routing determinism and shard behavior remain unchanged after the build-path optimization.

---

## Implemented Safe Optimization (Phase 7)

### 9) Merkle proof-path allocation reduction

#### Problem
`MerkleSnapshot.getProof()` used dynamic array growth for audit paths and allocated a fallback zero buffer per iteration.

#### Change
- Precomputed proof depth and pre-sized the `auditPath` array.
- Reused a shared zero buffer constant for defensive sibling fallback.
- Reused direct leaf-to-hex conversion in return payload.

#### Why system semantics are preserved
- Proof sibling order and hash material are unchanged.
- Root and leaf values are unchanged.
- Verification algorithm and expected outputs are unchanged.

## Additional validation evidence (Phase 7)

Commands run:

```bash
npm test -- src/__tests__/merkle_snapshot.test.ts src/__tests__/incremental_merkle.test.ts src/__tests__/merkle.test.ts
npm test -- src/__tests__/shard_worker.test.ts src/__tests__/orchestrator.test.ts src/__tests__/versioning.test.ts src/__tests__/convergence.test.ts
```

Observed result:
- Merkle-focused suites: `65 passed (65)`
- Prediction/versioning suite: `99 passed (99)`

Interpretation:
- Proof correctness and compatibility remain intact.
- Downstream prediction and convergence behavior remains unchanged.

---

## Cumulative Gains Snapshot (2026-03-03)

This section aggregates measured results after Phases 1–7.

### 1) Microbench evidence (algorithm-level)

From the reproducible Node microbench command in this document:

- `PendingWrites.addLeaf` old-vs-new path (`25,000` enqueues):
	- old: `1814.277125 ms`
	- new: `1.035667 ms`
	- measured speedup: `1751.80x`

- Cross-shard resolution strategy (`16` shards, `20,000` lookups):
	- shard scan: `5.759708 ms`
	- indexed lookup: `1.624625 ms`
	- measured speedup: `3.55x`

### 2) Harness benchmark snapshots (system-level)

Smoke preset command:

```bash
npm run bench:run
```

Observed report (`run: 2026-03-03T08-43-06-643Z`):
- Throughput: `469.62 ops/sec`
- Access latency p50/p95/p99: `0.01 / 0.02 / 0.08 ms`
- Commit latency p50/p95/p99: `391.44 / 436.38 / 436.38 ms`
- Proof verify avg: `0.02 ms`
- Correctness: `proof failures 0`, `stale reads 0`, `version mismatches 0`

Concurrent preset command:

```bash
npm run bench:run:concurrent
```

Observed report (`run: 2026-03-03T08-44-40-213Z`):
- Throughput: `6030.78 ops/sec` (`reads/sec 4691.42`)
- Access latency p50/p95/p99: `0.05 / 0.09 / 0.13 ms`
- Proof verify avg: `0.04 ms`
- Prediction hit rate: `70.00%`
- Correctness: `proof failures 0`, `stale reads 0`, `version mismatches 0`

### 3) Notes on interpretation

- Microbench numbers isolate local algorithm improvements and provide clear old-vs-new evidence.
- Harness snapshots provide post-optimization end-to-end behavior and correctness indicators.
- A strict before/after harness delta requires preserving a baseline report from pre-optimization commits.

### 4) Harness compatibility fixes required to run benchmarks

Two non-core adjustments were needed to unblock benchmark scripts under current strict settings:
- `tools/harness/agent_sim.ts`: narrowed optional stat fields locally for TypeScript strictness.
- `tools/harness/cli.ts`: updated embedded boot atoms to schema-v1 format.

These changes do not alter core Markov prediction logic.

---

## Validation approach
- Run existing prediction and shard consistency tests.
- Ensure before/after top predictions match for same training sequences.
- Confirm proof and tombstone behavior unchanged.

---

## Measured Evidence (Local, Reproducible)

Environment:
- Node: `v20.14.0`
- OS: `darwin`
- Arch: `arm64`

### A) Regression correctness evidence

Command run:

```bash
npm test -- src/__tests__/orchestrator.test.ts src/__tests__/shard_worker.test.ts src/__tests__/versioning.test.ts
```

Observed result:
- Test files: `3 passed`
- Tests: `84 passed (84)`

Interpretation:
- The two implemented optimizations did not break covered orchestrator/prediction/versioning behavior.

### B) Microbenchmark evidence for implemented optimizations

Repro command:

```bash
set +H; node -e "const p=require('perf_hooks').performance;let oldOps=[];let t0=p.now();for(let i=0;i<25000;i++){const c=oldOps.filter(o=>o.kind==='add').length;oldOps.push({kind:'add',data:'a'+i,hint:c});}let t1=p.now();let newOps=[];let addCount=0;let t2=p.now();for(let i=0;i<25000;i++){const c=addCount;newOps.push({kind:'add',data:'a'+i,hint:c});addCount++;}let t3=p.now();const shards=16,perShard=5000,samples=20000;const all=[];const maps=[];const idx=new Map();for(let s=0;s<shards;s++){const m=new Map();for(let i=0;i<perShard;i++){const h='h_'+s+'_'+i;m.set(h,{atom:'a_'+s+'_'+i});all.push(h);idx.set(h,s);}maps.push(m);}const sample=[];for(let i=0;i<samples;i++){sample.push(all[(i*17)%all.length]);}let t4=p.now();for(const h of sample){let found=null;for(let s=0;s<maps.length;s++){const r=maps[s].get(h);if(r){found=r;break;}}if(found===null)throw new Error('scan fail');}let t5=p.now();for(const h of sample){const s=idx.get(h);const found=s===undefined?null:maps[s].get(h);if(found===null)throw new Error('idx fail');}let t6=p.now();console.log(JSON.stringify({env:{node:process.version,platform:process.platform,arch:process.arch},pendingAdds_25k:{oldMs:t1-t0,newMs:t3-t2,speedup:(t1-t0)/(t3-t2)},hashResolution_16x5k_20kSamples:{scanMs:t5-t4,indexMs:t6-t5,speedup:(t5-t4)/(t6-t5)}},null,2));"
```

Observed JSON output:

```json
{
	"env": {
		"node": "v20.14.0",
		"platform": "darwin",
		"arch": "arm64"
	},
	"pendingAdds_25k": {
		"oldMs": 1814.277125,
		"newMs": 1.0356669999998758,
		"speedup": 1751.795823368146
	},
	"hashResolution_16x5k_20kSamples": {
		"scanMs": 5.759708000000046,
		"indexMs": 1.6246249999999236,
		"speedup": 3.545253827806612
	}
}
```

Interpretation:
- `PendingWrites.addLeaf` counter approach is dramatically faster than repeated `filter()` under synthetic high-volume enqueue.
- Indexed hash-to-shard resolution is materially faster than shard scanning at 16-shard scale in synthetic lookup tests.

### Notes on proof quality
- These are microbenchmarks of the exact algorithmic paths, not end-to-end API benchmarks.
- They provide strong evidence of local improvement; run the project harness for full-system latency deltas.
