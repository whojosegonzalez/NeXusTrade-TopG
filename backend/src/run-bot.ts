import { BotEngine } from "./engine/bot-engine";

const bot = new BotEngine();

// Handle shutdown
process.on('SIGINT', async () => {
    console.log("\n🛑 Stopping Bot...");
    await bot.stop();
    process.exit(0);
});

// Run
void bot.start();