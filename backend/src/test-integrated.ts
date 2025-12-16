import { HeliusScanner } from './scanners/helius';
import { HeliusRiskEngine } from './risk/helius-risk';
import { TokenCandidate } from './scanners/interfaces';

async function main() {
    console.log("🚀 Starting Integrated System Test (Scanner + Risk Engine)...");
    console.log("----------------------------------------------------------------");

    const scanner = new HeliusScanner();
    const riskEngine = new HeliusRiskEngine();

    // Define the full pipeline
    const onNewToken = async (token: TokenCandidate) => {
        const startTime = Date.now();
        
        // 1. Log Detection
        console.log(`\n🔎 DETECTED: ${token.mint}`);
        
        // 2. Perform Risk Analysis
        console.log("   🛡️  Running Risk Check...");
        const risk = await riskEngine.evaluate(token.mint);
        
        const latency = Date.now() - startTime;

        // 3. Display Results
        if (risk.isRug) {
            console.log(`   ❌ RUG DETECTED (Score: ${risk.score})`);
            console.log(`      Reasons: ${risk.reasons.join(', ')}`);
        } else if (risk.score < 70) {
            console.log(`   ⚠️  HIGH RISK (Score: ${risk.score})`);
            console.log(`      Reasons: ${risk.reasons.join(', ')}`);
        } else {
            console.log(`   ✅ SAFE CANDIDATE (Score: ${risk.score})`);
        }
        
        console.log(`   ⏱️  Analysis Time: ${latency}ms`);
        console.log("----------------------------------------------------------------");
    };

    // Start the engine
    await scanner.start(onNewToken);
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log("\n🛑 Shutting down...");
    process.exit(0);
});

void main();