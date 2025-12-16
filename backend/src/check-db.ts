import { prisma } from './database/client';
async function check() {
    const count = await prisma.tokenRadar.count();
    console.log(`📊 Tokens in Radar: ${count}`);
    const tokens = await prisma.tokenRadar.findMany({ take: 3 });
    console.log(tokens);
}
void check();