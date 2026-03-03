import { ShardedOrchestrator } from './orchestrator';
import * as fs from 'fs';
import * as path from 'path';

async function verifySharding() {
    const NUM_SHARDS = 4;
    const DB_BASE_PATH = './mmpm-sharding-test-db';
    const testData = [
        "v1.other.Alpha",
        "v1.other.Beta",
        "v1.other.Gamma",
        "v1.other.Delta",
        "v1.other.Epsilon",
        "v1.other.Zeta",
    ];

    try { fs.rmSync(DB_BASE_PATH, { recursive: true, force: true }); } catch { }

    console.log(`--- Initializing Orchestrator with ${NUM_SHARDS} Shards ---`);
    const orchestrator = new ShardedOrchestrator(NUM_SHARDS, testData, DB_BASE_PATH);
    await orchestrator.init();

    console.log("\n--- Training logical paths ---");
    await orchestrator.train(["v1.other.Alpha", "v1.other.Beta", "v1.other.Gamma"]);
    await orchestrator.train(["v1.other.Delta", "v1.other.Epsilon"]);

    console.log("\n--- Physical Storage Audit ---");
    const dbPath = path.join(process.cwd(), DB_BASE_PATH);

    if (!fs.existsSync(dbPath)) {
        console.error("❌ Error: mmpm-db directory not found. Did the shards initialize?");
        return;
    }

    const shards = fs.readdirSync(dbPath).filter(f => {
        if (!/^shard_\d+$/.test(f)) return false;
        const full = path.join(dbPath, f);
        return fs.statSync(full).isDirectory();
    });

    shards.forEach(shardDir => {
        const shardPath = path.join(dbPath, shardDir);
        const files = fs.readdirSync(shardPath);
        const size = files.length;

        if (size > 0) {
            console.log(`✅ ${shardDir}: Active (Contains ${size} LevelDB state files)`);
        } else {
            console.log(`⚠️ ${shardDir}: Empty (No data routed here yet)`);
        }
    });

    console.log("\n--- Retrieval Proof ---");
    const report = await orchestrator.access("v1.other.Alpha");
    console.log(`Data: ${report.currentData}`);
    console.log(`Latency: ${report.latencyMs.toFixed(4)}ms`);
    console.log(`Recursive Proof Check: ${report.shardRootProof ? "PASSED" : "FAILED"}`);

    await orchestrator.close();
    try { fs.rmSync(DB_BASE_PATH, { recursive: true, force: true }); } catch { }
}

verifySharding().catch(console.error);