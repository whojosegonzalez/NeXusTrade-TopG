import dotenv from 'dotenv';
import path from 'node:path';

// Load .env file from the backend root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const CONFIG = {
    // 1. Solana Connection
    RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    
    // 2. The Data Triad (API Keys)
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY,
    
    // 3. Security (loaded only when needed)
    PRIVATE_KEY_ENC: process.env.PRIVATE_KEY_ENC, 
    
    // 4. Twin Engine Settings
    // If true, we use "nexus_sim.db" and fake money.
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true',
};

/**
 * STRICT VALIDATION:
 * The bot will refuse to start if critical keys are missing.
 */
export const validateEnv = () => {
    const missing: string[] = [];
    
    // Always require Helius (our eyes)
    if (!CONFIG.HELIUS_API_KEY) missing.push('HELIUS_API_KEY');
    
    // Only require Private Key if we are strictly in LIVE mode
    if (!CONFIG.SIMULATION_MODE && !CONFIG.PRIVATE_KEY_ENC) {
        missing.push('PRIVATE_KEY_ENC (Required for LIVE mode)');
    }

    if (missing.length > 0) {
        console.error(`❌ CRITICAL STARTUP ERROR: Missing environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
    
    console.log(`✅ Environment Validated. Mode: ${CONFIG.SIMULATION_MODE ? '🟢 SIMULATION' : '🔴 LIVE TRADING'}`);
};