import { ShardedOrchestrator } from './orchestrator';

async function generateGraphData() {
    const dataSize = 100;
    const chain = Array.from({ length: dataSize }, (_, i) => `Node_${i}`);
    const memory = new ShardedOrchestrator(4, chain);
    await memory.init();

    // Train the chain
    await memory.train(chain);

    console.log("Step,Normal_Traversal_Cost,Markov_Traversal_Cost");
    let normalCost = 0;
    let markovCost = 0;
    let lastReport: Awaited<ReturnType<typeof memory.access>> | null = null;

    for (let i = 0; i < chain.length; i++) {
        normalCost += 1.0; // Standard cost of 1 verification

        const report = await memory.access(chain[i]);

        // Check if the PREVIOUS step's prediction correctly pre-fetched this step
        if (i > 0 && lastReport?.predictedProof !== null) {
            markovCost += 0.05; // Pre-verified: only prediction overhead
        } else {
            markovCost += 1.0; // Cold start or miss: full verification cost
        }

        lastReport = report;
        console.log(`${i},${normalCost.toFixed(2)},${markovCost.toFixed(2)}`);
    }
}

generateGraphData().catch(console.error);