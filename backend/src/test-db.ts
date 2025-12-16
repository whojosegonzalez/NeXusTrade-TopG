import { prisma } from './database/client';

async function main() {
    console.log("🧪 Starting Database Smoke Test...");

    try {
        // 1. Create a dummy session
        const session = await prisma.session.create({
            data: {
                status: "TEST_ACTIVE",
                targetProfit: 10.0,
                stopLoss: 5.0,
                startBalance: 100.0,
                currentBalance: 100.0
            }
        });

        console.log(`✅ Success! Created Session ID: ${session.id}`);
        console.log(`📊 Session Status: ${session.status}`);

        // 2. Double check we can read it back
        const count = await prisma.session.count();
        console.log(`📈 Total Sessions in DB: ${count}`);

    } catch (e) {
        console.error("❌ Test Failed:", e);
    } finally {
        await prisma.$disconnect();
    }
}

// Execute and ignore return value to satisfy linter
void main();