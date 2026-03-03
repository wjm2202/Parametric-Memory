import { ShardedOrchestrator } from './orchestrator';
import { rmSync } from 'fs';

async function runTest() {
    const chain = ["v1.other.A", "v1.other.B", "v1.other.C", "v1.other.D"];
    const dbBasePath = './mmpm-efficiency-db';
    try { rmSync(dbBasePath, { recursive: true, force: true }); } catch { }

    const mem = new ShardedOrchestrator(4, chain, dbBasePath);
    await mem.init();

    console.log("Training A -> B -> C -> D");
    await mem.train(chain);

    console.log("Accessing A...");
    const res = await mem.access("v1.other.A");
    console.log(`Current: ${res.currentData}, Predicted Next: ${res.predictedNext}`);
    console.log(`Pre-fetched Proof for next: ${res.predictedProof ? 'YES' : 'NO'}`);

    await mem.close();
    try { rmSync(dbBasePath, { recursive: true, force: true }); } catch { }
}
runTest();