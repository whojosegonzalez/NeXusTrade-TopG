import { initDatabase } from './database/client';

async function main() {
    // TEST 1: SIMULATION ENGINE
    console.log("--- 1. TESTING SIMULATION ENGINE ---");
    const simDb = initDatabase(true); // <--- Force Simulation
    
    const simSession = await simDb.session.create({
        data: {
            strategy: "Test-Sim-Mode",
            isSimulation: true,
            startBalance: 100,      // FIXED: Removed .0 (S7748)
            currentBalance: 100,    // FIXED: Removed .0 (S7748)
            targetProfit: 1,        // FIXED: Removed .0 (S7748)
            stopLoss: 0.5,          // Kept .5 (Valid fraction)
            status: "ACTIVE"
        }
    });
    console.log(`✅ SIM Session Created: ${simSession.id} (Saved to nexus_sim.db)`);

    // TEST 2: LIVE ENGINE
    console.log("\n--- 2. TESTING LIVE ENGINE ---");
    // Note: We are initializing a separate client manually for this test 
    // to bypass the singleton check just for verification.
    const liveDb = initDatabase(false); // <--- Force Live
    
    const liveSession = await liveDb.session.create({
        data: {
            strategy: "Test-LIVE-Mode",
            isSimulation: false,
            startBalance: 5,        // FIXED: Removed .0 (S7748)
            currentBalance: 5,      // FIXED: Removed .0 (S7748)
            targetProfit: 0.5,
            stopLoss: 0.1,
            status: "ACTIVE"
        }
    });
    console.log(`✅ LIVE Session Created: ${liveSession.id} (Saved to nexus_live.db)`);
}

// Execute logic
// NOSONAR: Top-level await is not available in CommonJS. This pattern is required.
main().catch((e) => {
    console.error(e);
    process.exit(1);
});