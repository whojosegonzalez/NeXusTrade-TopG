import { BotEngine } from "./engine/bot-engine";
import { HeliusScanner } from "./scanners/helius";

// FACTORY: We can now add multiple scanners here!
const scanners = [
    new HeliusScanner(),
    // new DexScreenerScanner() // Coming soon...
];

const bot = new BotEngine(scanners);

process.on('SIGINT', async () => {
    console.log("\n🛑 Stopping Bot...");
    await bot.stop();
    process.exit(0);
});

// Start Simulation (10 SOL, 5 Max Pos, 0.1 Trade)
void bot.start(10.0, 5, 0.1);