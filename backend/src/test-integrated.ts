import { HeliusScanner } from './scanners/helius';
import { HeliusRiskEngine } from './risk/helius-risk';
import { TokenIngestor } from './pipeline/ingestor';
import { TokenCandidate } from './scanners/interfaces';
import { prisma } from './database/client';

async function main() {
    console.log("🚀 Starting Full Pipeline Test (Scan -> Risk -> DB)...");
    console.log("----------------------------------------------------------------");

    // Initialize all 3 components of the Sensory System
    const scanner = new HeliusScanner();
    const riskEngine = new HeliusRiskEngine();
    const ingestor = new TokenIngestor();

    const onNewToken = async (token: TokenCandidate) => {
        const startTime = Date.now();
        
        console.log(`\n🔎 DETECTED: ${token.mint} (${token.symbol})`);
        
        // 1. Risk Check
        // console.log("   🛡️  Analyzing Risk...");
        const risk = await riskEngine.evaluate(token.mint);
        
        // 2. Database Ingestion (The new step)
        // console.log("   💾 Saving to DB...");
        await ingestor.ingest(token, risk);
        
        const latency = Date.now() - startTime;

        // 3. Log Result
        if (risk.isRug) {
            console.log(`   ❌ RUG (Score: ${risk.score}) | Reason: ${risk.reasons[0]}`);
        } else if (risk.score < 70) {
            console.log(`   ⚠️  RISKY (Score: ${risk.score}) | Reason: ${risk.reasons[0]}`);
        } else {
            console.log(`   ✅ SAFE (Score: ${risk.score}) | Ready for Strategy`);
        }
        console.log(`   ⏱️  Pipeline Latency: ${latency}ms`);
    };

    // Start scanning
    await scanner.start(onNewToken);
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log("\n🛑 Shutting down...");
    await prisma.$disconnect();
    process.exit(0);
});

void main();