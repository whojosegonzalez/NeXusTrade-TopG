import { BotEngine } from "./engine/bot-engine";

const bot = new BotEngine();

process.on('SIGINT', async () => {
    console.log("\n🛑 Stopping Bot...");
    await bot.stop();
    process.exit(0);
});

// CONFIGURATION:
// Start with 10 SOL
// Max 10 Positions
// 0.2 SOL per Trade
void bot.start(10.0, 10, 0.2);