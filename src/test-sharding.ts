import { ShardedOrchestrator } from './orchestrator';
import * as fs from 'fs';
import * as path from 'path';

async function verifySharding() {
    const NUM_SHARDS = 4;
    const testData = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];

    console.log(`--- Initializing Orchestrator with ${NUM_SHARDS} Shards ---`);
    const orchestrator = new ShardedOrchestrator(NUM_SHARDS, testData);
    await orchestrator.init();

    console.log("\n--- Training logical paths ---");
    await orchestrator.train(["Alpha", "Beta", "Gamma"]);
    await orchestrator.train(["Delta", "Epsilon"]);

    console.log("\n--- Physical Storage Audit ---");
    const dbPath = path.join(process.cwd(), 'mmpm-db');

    if (!fs.existsSync(dbPath)) {
        console.error("❌ Error: mmpm-db directory not found. Did the shards initialize?");
        return;
    }

    const shards = fs.readdirSync(dbPath).filter(f => f.startsWith('shard_'));

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
    const report = await orchestrator.access("Alpha");
    console.log(`Data: ${report.currentData}`);
    console.log(`Latency: ${report.latencyMs.toFixed(4)}ms`);
    console.log(`Recursive Proof Check: ${report.shardRootProof ? "PASSED" : "FAILED"}`);
}

verifySharding().catch(console.error);