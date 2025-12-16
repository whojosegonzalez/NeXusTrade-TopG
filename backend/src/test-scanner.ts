import { HeliusScanner } from './scanners/helius';
import { TokenCandidate } from './scanners/interfaces';

async function main() {
    console.log("👀 Starting Helius Scanner Test...");
    console.log("🔍 Watching Raydium for new 'Initialize' events...");
    console.log("----------------------------------------------------");

    const scanner = new HeliusScanner();

    // Define the reaction function (what happens when we see a token)
    const onNewToken = async (token: TokenCandidate) => {
        console.log(`\n🚨 NEW POOL DETECTED [${new Date().toLocaleTimeString()}]`);
        console.log(`   💎 Mint:   ${token.mint}`);
        console.log(`   📅 Time:   ${token.createdAt.toISOString()}`);
        console.log(`   💧 Liq:    $${token.liquidityUSD} (Est)`);
        console.log(`   🔗 Link:   https://solscan.io/tx/${token.mint}`); // Note: Mint isn't TX, but useful for debug
        console.log("----------------------------------------------------");
    };

    // Start the scanner
    // This will enter the polling loop defined in helius.ts
    await scanner.start(onNewToken);

    // Handle graceful shutdown so we don't leave connections hanging
    process.on('SIGINT', () => {
        console.log("\n🛑 Stopping Scanner...");
        scanner.stop();
        process.exit(0);
    });
}

// Execute
void main();