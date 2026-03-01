import { ShardedOrchestrator } from './orchestrator';

async function runTest() {
    const chain = ["A", "B", "C", "D"];
    const mem = new ShardedOrchestrator(4, chain);
    await mem.init();

    console.log("Training A -> B -> C -> D");
    await mem.train(chain);

    console.log("Accessing A...");
    const res = await mem.access("A");
    console.log(`Current: ${res.currentData}, Predicted Next: ${res.predictedNext}`);
    console.log(`Pre-fetched Proof for next: ${res.predictedProof ? 'YES' : 'NO'}`);
}
runTest();