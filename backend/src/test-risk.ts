import { HeliusRiskEngine } from './risk/helius-risk';

async function main() {
    console.log("🛡️ Starting Risk Engine Test...");
    const riskEngine = new HeliusRiskEngine();

    // Test 1: USDC (Should be safe, but might have authorities because it's centralized)
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    console.log(`\nEvaluating USDC (${usdcMint})...`);
    const usdcRisk = await riskEngine.evaluate(usdcMint);
    console.log("Result:", usdcRisk);

    // Test 2: A recent mint from your scanner logs (likely dangerous or mutable)
    // Replace this string with one of the "Diamond Mints" from your previous log
    const randomMint = 'So11111111111111111111111111111111111111112'; // Using Wrapped SOL for test
    console.log(`\nEvaluating Wrapped SOL (${randomMint})...`);
    const solRisk = await riskEngine.evaluate(randomMint);
    console.log("Result:", solRisk);
}

void main();