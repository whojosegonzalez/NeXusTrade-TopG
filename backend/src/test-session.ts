import { SessionManager } from './strategy/session-manager';
import { prisma } from './database/client';

async function main() {
    console.log("💰 Starting Session Manager Test...");
    const sessionManager = new SessionManager();

    // 1. Start a Session with 10 SOL
    console.log("\n--- TEST 1: Initialization ---");
    const id = await sessionManager.start({
        startBalance: 10.0,
        targetProfit: 12.0, // Stop if we hit 12
        stopLoss: 8.0       // Stop if we hit 8
    });
    console.log(`✅ Session Created: ${id}`);

    // 2. Simulate a Profit
    console.log("\n--- TEST 2: Making Money ---");
    let result = await sessionManager.updateBalance(11.0);
    console.log(`Current Balance: 11.0 | Status: ${result.status}`);

    // 3. Simulate hitting the Target
    console.log("\n--- TEST 3: Hitting Take Profit ---");
    result = await sessionManager.updateBalance(12.5);
    console.log(`Current Balance: 12.5 | Status: ${result.status} | Reason: ${result.reason}`);

    // 4. Verify DB Status
    const dbSession = await prisma.session.findUnique({ where: { id } });
    console.log(`\n📊 Final DB Status: ${dbSession?.status} (Expected: COMPLETED)`);
    console.log(`💰 Final DB Balance: ${dbSession?.currentBalance}`);
}

// Handle cleanup
void main().catch(console.error).finally(async () => {
    await prisma.$disconnect();
});