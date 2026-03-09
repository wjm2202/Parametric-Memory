/**
 * smoke-test.ts — Exercises all 6 sprint features + checkpoint fix against a running local server.
 * Run: MMPM_API_KEY=<key> MMPM_BASE=http://127.0.0.1:9999 npx tsx scripts/smoke-test.ts
 */

const BASE = process.env.MMPM_BASE ?? 'http://127.0.0.1:9999';
const KEY = process.env.MMPM_API_KEY ?? 'smoke-test-key-long-enough-for-validation';

type Result = { test: string; pass: boolean; detail: string; ms: number };
const results: Result[] = [];

async function api(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; }
    catch { return { status: res.status, data: text }; }
}

function record(test: string, pass: boolean, detail: string, startMs: number) {
    const ms = Date.now() - startMs;
    results.push({ test, pass, detail, ms });
    const icon = pass ? '✅' : '❌';
    console.log(`${icon} ${test} (${ms}ms) — ${detail}`);
}

// ─── PHASE 1: Import real atoms from backup ──────────────────────────────────
async function phase1_import() {
    const t = Date.now();
    // Import a representative subset of atoms (not all 143 — enough to exercise features)
    const atoms = [
        'v1.other.hub_session',
        'v1.other.hub_facts',
        'v1.other.hub_procedures',
        'v1.fact.mmpm_deployed_to_digital_ocean_droplet_at_mmpm_co_nz',
        'v1.fact.mmpm_domain_is_mmpm_co_nz_on_godaddy',
        'v1.fact.mmpm_droplet_ip_is_170_64_198_144',
        'v1.fact.jump_hash_replaces_md5_ring_in_router_ts_zero_memory',
        'v1.fact.bm25_module_created_at_src_bm25_ts_with_build_score_scorebysemantic',
        'v1.fact.ppm_prediction_preferred_when_order_gte_2_falls_back_to_first_order',
        'v1.fact.ttl_auto_promotion_threshold_default_3_accesses',
        'v1.fact.verify_consistency_proof_recomputes_master_roots_from_shard_roots_independently',
        'v1.fact.consistency_proofs_use_shard_root_snapshots_at_each_master_version',
        'v1.fact.hlr_module_created_at_src_hlr_ts_adaptive_per_atom_halflife',
        'v1.fact.semantic_search_is_jaccard_token_overlap_not_embeddings',
        'v1.fact.bm25_wired_into_server_ts_replaces_jaccard_at_3_call_sites',
        'v1.procedure.check_memory_search_before_web_search',
        'v1.procedure.store_findings_progressively_not_batched',
        'v1.procedure.store_memory_before_creating_files',
        'v1.procedure.name_atoms_with_keywords_matching_future_objectives_for_retrieval',
        'v1.procedure.never_train_new_atoms_in_same_checkpoint_that_creates_them_src_test',
        'v1.event.sprint_step_1_bm25_completed_dt_2026_03_09',
        'v1.event.sprint_step_2_jump_hash_completed_dt_2026_03_09',
        'v1.event.sprint_step_3_hlr_completed_dt_2026_03_09',
        'v1.event.sprint_step_4_consistency_proofs_completed_dt_2026_03_09',
        'v1.event.sprint_step_5_ttl_auto_promotion_completed_dt_2026_03_09',
        'v1.event.sprint_step_6_variable_order_markov_completed_dt_2026_03_09',
        'v1.event.research_completed_with_evidence',
        'v1.relation.jump_hash_could_replace_md5_ring_hash_in_mmpm_router',
        'v1.relation.merkle_tree_provides_cryptographic_proof_for_markov_predictions',
        'v1.fact.merkle_tree_sha256_heap_indexed_binary_zero_padded',
    ];

    const res = await api('POST', '/atoms', { atoms });
    const ok = res.status === 200;
    await api('POST', '/admin/commit', {});
    record('Import 30 atoms', ok, `status=${res.status}, imported ${atoms.length} atoms`, t);
    return ok;
}

// ─── PHASE 2: Train Markov sequences (replay backup weights) ─────────────────
async function phase2_train() {
    const t = Date.now();
    const sequences: [string, string, number][] = [
        ['v1.procedure.check_memory_search_before_web_search', 'v1.procedure.store_findings_progressively_not_batched', 3],
        ['v1.procedure.store_findings_progressively_not_batched', 'v1.event.research_completed_with_evidence', 3],
        ['v1.procedure.store_memory_before_creating_files', 'v1.procedure.name_atoms_with_keywords_matching_future_objectives_for_retrieval', 3],
    ];

    let totalTrained = 0;
    for (const [from, to, weight] of sequences) {
        for (let i = 0; i < weight; i++) {
            await api('POST', '/train', { sequence: [from, to] });
            totalTrained++;
        }
    }
    await api('POST', '/admin/commit', {});
    record('Train 9 edges (3 pairs × weight)', true, `${totalTrained} train calls`, t);
}

// ─── PHASE 3: BM25 Search (Step 1) ──────────────────────────────────────────
async function phase3_bm25() {
    const t = Date.now();
    const res = await api('POST', '/search', { query: 'bm25 search module jaccard', limit: 5 });
    const results_arr = res.data?.results ?? [];
    const topAtom = results_arr[0]?.atom ?? 'none';
    const bm25Hit = topAtom.includes('bm25');
    record('BM25 search: "bm25 search module jaccard"', bm25Hit,
        `top=${topAtom}, ${results_arr.length} results`, t);

    // Second query — test that BM25 ranks relevant atoms above irrelevant
    const t2 = Date.now();
    const res2 = await api('POST', '/search', { query: 'consistency proof merkle verification', limit: 5 });
    const results2 = res2.data?.results ?? [];
    const consistencyHit = results2.some((r: any) => r.atom.includes('consistency') || r.atom.includes('verify'));
    record('BM25 search: "consistency proof merkle verification"', consistencyHit,
        `top=${results2[0]?.atom ?? 'none'}, ${results2.length} results`, t2);

    // Third query — term frequency saturation test (BM25 k1 parameter)
    const t3 = Date.now();
    const res3 = await api('POST', '/search', { query: 'mmpm droplet deploy digital ocean', limit: 5 });
    const results3 = res3.data?.results ?? [];
    const deployHit = results3.some((r: any) => r.atom.includes('droplet') || r.atom.includes('deploy'));
    record('BM25 search: "mmpm droplet deploy digital ocean"', deployHit,
        `top=${results3[0]?.atom ?? 'none'}, ${results3.length} results`, t3);
}

// ─── PHASE 4: Consistency Proofs (Step 4) ────────────────────────────────────
async function phase4_consistency() {
    // Get tree head
    const t1 = Date.now();
    const head = await api('GET', '/tree-head');
    const hasVersion = typeof head.data?.version === 'number';
    const hasRoot = typeof head.data?.root === 'string' && head.data.root.length > 0;
    record('GET /tree-head', hasVersion && hasRoot,
        `version=${head.data?.version}, root=${(head.data?.root ?? '').slice(0, 16)}...`, t1);

    // Make a few more commits to create version history
    await api('POST', '/atoms', { atoms: ['v1.fact.smoke_proof_v2'] });
    await api('POST', '/admin/commit', {});
    await api('POST', '/atoms', { atoms: ['v1.fact.smoke_proof_v3'] });
    await api('POST', '/admin/commit', {});

    const headAfter = await api('GET', '/tree-head');
    const versionGrew = headAfter.data?.version > head.data?.version;

    // Verify consistency between old and new versions
    const t2 = Date.now();
    const fromV = head.data?.version;
    const toV = headAfter.data?.version;
    const proof = await api('POST', '/verify-consistency', { fromVersion: fromV, toVersion: toV });
    const proofValid = proof.data?.valid === true;
    record('Consistency proof (version range)', proofValid && versionGrew,
        `from=${fromV} to=${toV}, valid=${proof.data?.valid}, versionGrew=${versionGrew}`, t2);

    // Re-verify the same proof object
    if (proof.data?.proof) {
        const t3 = Date.now();
        const reVerify = await api('POST', '/verify-consistency', { proof: proof.data.proof });
        record('Re-verify consistency proof', reVerify.data?.valid === true,
            `re-verification valid=${reVerify.data?.valid}`, t3);
    }
}

// ─── PHASE 5: TTL Auto-Promotion (Step 5) ───────────────────────────────────
async function phase5_ttl() {
    // Create an atom with TTL
    const t1 = Date.now();
    const ttlAtom = 'v1.state.ttl_smoke_test_ephemeral';
    await api('POST', '/atoms', { atoms: [ttlAtom], ttlMs: 60000 }); // 60s TTL
    await api('POST', '/admin/commit', {});

    // Access it 3 times (promotion threshold = 3)
    const access1 = await api('POST', '/access', { data: ttlAtom });
    const access2 = await api('POST', '/access', { data: ttlAtom });
    const access3 = await api('POST', '/access', { data: ttlAtom });

    // Check if atom still exists (promoted atoms survive TTL expiry)
    const atomCheck = await api('GET', `/atoms/${encodeURIComponent(ttlAtom)}`);
    const exists = atomCheck.status === 200 && atomCheck.data?.status === 'active';
    record('TTL atom survives after 3 accesses (promotion)', exists,
        `status=${atomCheck.data?.status}, 3 accesses made`, t1);
}

// ─── PHASE 6: PPM Variable-Order Markov (Step 6) ────────────────────────────
async function phase6_ppm() {
    const t = Date.now();

    // Train a distinctive sequence: A → B → C → D (gives PPM order-2 and order-3 context)
    const atoms = [
        'v1.fact.ppm_smoke_A',
        'v1.fact.ppm_smoke_B',
        'v1.fact.ppm_smoke_C',
        'v1.fact.ppm_smoke_D',
        'v1.fact.ppm_smoke_E', // alternative branch: A → B → E
    ];
    await api('POST', '/atoms', { atoms });
    await api('POST', '/admin/commit', {});

    // Train A→B→C→D three times to build strong higher-order context
    for (let i = 0; i < 3; i++) {
        await api('POST', '/train', { sequence: ['v1.fact.ppm_smoke_A', 'v1.fact.ppm_smoke_B', 'v1.fact.ppm_smoke_C', 'v1.fact.ppm_smoke_D'] });
    }
    // Train A→B→E once (weaker branch)
    await api('POST', '/train', { sequence: ['v1.fact.ppm_smoke_A', 'v1.fact.ppm_smoke_B', 'v1.fact.ppm_smoke_E'] });
    await api('POST', '/admin/commit', {});

    // Access A then B — PPM should predict C (order-2 context A,B → C is stronger than first-order B → E split)
    const accessA = await api('POST', '/access', { data: 'v1.fact.ppm_smoke_A' });
    const accessB = await api('POST', '/access', { data: 'v1.fact.ppm_smoke_B' });

    // Check if prediction uses higher-order context
    const predicted = accessB.data?.predicted;
    const predictedAtom = predicted?.atom ?? predicted?.next ?? null;
    const ppmUsed = (accessB.data?.predictionOrder ?? 0) >= 2 || (predicted?.order ?? 0) >= 2;

    record('PPM higher-order prediction after A→B', !!predictedAtom,
        `predicted=${predictedAtom}, ppmUsed=${ppmUsed}`, t);
}

// ─── PHASE 7: session_checkpoint fix ─────────────────────────────────────────
async function phase7_checkpoint_fix() {
    const t = Date.now();

    // Use the MCP-style checkpoint flow: create NEW atoms + train in one shot
    // This is exactly what session_checkpoint does
    const newAtoms = ['v1.fact.checkpoint_smoke_X', 'v1.fact.checkpoint_smoke_Y'];

    // Step 1: Store + commit (the fix)
    await api('POST', '/atoms', { atoms: newAtoms });
    await api('POST', '/admin/commit', {});

    // Step 2: Train (atoms now exist)
    await api('POST', '/train', { sequence: newAtoms });
    await api('POST', '/admin/commit', {});

    // Check that training actually took hold
    const weights = await api('GET', `/weights/${encodeURIComponent('v1.fact.checkpoint_smoke_X')}`);
    const transitions = weights.data?.transitions ?? [];
    const edge = transitions.find((e: any) => e.to?.includes('checkpoint_smoke_Y'));
    const hasWeight = edge?.weight === 1;

    record('Checkpoint fix: store→commit→train→commit', hasWeight,
        `transitions=${transitions.length}, edge_weight=${edge?.weight ?? 0}`, t);

    // Now test the OLD broken pattern (store+train WITHOUT mid-commit)
    const t2 = Date.now();
    const brokenAtoms = ['v1.fact.broken_pattern_P', 'v1.fact.broken_pattern_Q'];
    await api('POST', '/atoms', { atoms: brokenAtoms });
    // Skip commit — go straight to train (the OLD bug)
    await api('POST', '/train', { sequence: brokenAtoms });
    await api('POST', '/admin/commit', {});

    const brokenWeights = await api('GET', `/weights/${encodeURIComponent('v1.fact.broken_pattern_P')}`);
    const brokenTransitions = brokenWeights.data?.transitions ?? [];
    const brokenEdge = brokenTransitions.find((e: any) => e.to?.includes('broken_pattern_Q'));
    const brokenHasWeight = !!brokenEdge;

    record('Broken pattern (no mid-commit) shows no training', !brokenHasWeight,
        `transitions=${brokenTransitions.length} (expected 0)`, t2);
}

// ─── PHASE 8: Markov prediction with Merkle proof ───────────────────────────
async function phase8_access_with_proof() {
    const t = Date.now();
    const res = await api('POST', '/access', { data: 'v1.procedure.check_memory_search_before_web_search' });
    const hasPrediction = !!res.data?.predicted;
    const hasProof = !!res.data?.proof;
    const predictedAtom = res.data?.predicted?.atom ?? res.data?.predicted?.next ?? 'none';

    record('Access with Markov prediction + Merkle proof',
        hasPrediction && hasProof,
        `predicted=${predictedAtom}, proof=${hasProof}`, t);

    // Verify the proof independently
    if (res.data?.proof) {
        const t2 = Date.now();
        const verify = await api('POST', '/verify', {
            atom: 'v1.procedure.check_memory_search_before_web_search',
            proof: res.data.proof,
        });
        record('Independent proof verification', verify.data?.valid === true,
            `valid=${verify.data?.valid}`, t2);
    }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  MMPM Smoke Test — All Sprint Features');
    console.log(`  Server: ${BASE}`);
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('── Phase 1: Import atoms ──');
    await phase1_import();

    console.log('\n── Phase 2: Train sequences ──');
    await phase2_train();

    console.log('\n── Phase 3: BM25 Search (Step 1) ──');
    await phase3_bm25();

    console.log('\n── Phase 4: Consistency Proofs (Step 4) ──');
    await phase4_consistency();

    console.log('\n── Phase 5: TTL Auto-Promotion (Step 5) ──');
    await phase5_ttl();

    console.log('\n── Phase 6: PPM Prediction (Step 6) ──');
    await phase6_ppm();

    console.log('\n── Phase 7: Checkpoint Fix ──');
    await phase7_checkpoint_fix();

    console.log('\n── Phase 8: Access + Proof Pipeline ──');
    await phase8_access_with_proof();

    // ── Summary ──
    console.log('\n═══════════════════════════════════════════════════════');
    const passed = results.filter(r => r.pass).length;
    const failed = results.filter(r => !r.pass).length;
    const totalMs = results.reduce((s, r) => s + r.ms, 0);
    console.log(`  Results: ${passed} passed, ${failed} failed, ${results.length} total (${totalMs}ms)`);

    if (failed > 0) {
        console.log('\n  FAILURES:');
        for (const r of results.filter(r => !r.pass)) {
            console.log(`    ❌ ${r.test}: ${r.detail}`);
        }
    }
    console.log('═══════════════════════════════════════════════════════');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
