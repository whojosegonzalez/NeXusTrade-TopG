import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { CONFIG } from '../config';
import { IScanner, TokenCandidate } from './interfaces';

// Raydium Liquidity Pool V4 Program ID
const RAYDIUM_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
// Wrapped SOL Mint Address (We want to ignore this)
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export class HeliusScanner implements IScanner {
    name = "Helius Raydium Scanner";
    private connection: Connection;
    private isRunning = false;
    private lastSignature: string | null = null;

    constructor() {
        this.connection = new Connection(CONFIG.RPC_URL);
    }

    async start(callback: (token: TokenCandidate) => Promise<void>): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`👀 ${this.name}: Started monitoring...`);

        while (this.isRunning) {
            try {
                await this.scan(callback);
                // RATE LIMIT FIX: Wait 5 seconds between polls to avoid 429s on Free Tier
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                console.error(`⚠️ Scanner Error: ${error instanceof Error ? error.message : String(error)}`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
    }

    stop(): void {
        this.isRunning = false;
        console.log(`🛑 ${this.name}: Stopped.`);
    }

    private async scan(callback: (token: TokenCandidate) => Promise<void>) {
        const signatures = await this.connection.getSignaturesForAddress(
            RAYDIUM_PROGRAM_ID,
            { limit: 10, until: this.lastSignature || undefined }
        );

        if (signatures.length === 0) return;

        this.lastSignature = signatures[0].signature;
        const txIds = signatures.map(s => s.signature);

        // Fetch parsed transactions
        const url = `https://api.helius.xyz/v0/transactions/?api-key=${CONFIG.HELIUS_API_KEY}`;
        const { data: transactions } = await axios.post(url, { transactions: txIds });

        for (const tx of transactions) {
            const description = tx.description?.toLowerCase() || "";
            const isLiquidityCreate = description.includes("initialize") || 
                                      (tx.type === "SWAP" && tx.tokenTransfers.length >= 2); 

            if (isLiquidityCreate) {
                const tokenTransfers = tx.tokenTransfers || [];
                if (tokenTransfers.length >= 2) {
                    // INTELLIGENT SELECTION:
                    // Find the token that is NOT Solana (WSOL)
                    let tokenMint = tokenTransfers[0].mint;
                    if (tokenMint === WSOL_MINT) {
                        tokenMint = tokenTransfers[1].mint;
                    }

                    // Double check we didn't just pick WSOL again
                    if (tokenMint === WSOL_MINT) continue;

                    const candidate: TokenCandidate = {
                        mint: tokenMint,
                        symbol: "UNKNOWN", 
                        name: "Unknown Token",
                        liquidityUSD: 0,
                        createdAt: new Date(tx.timestamp * 1000),
                        bondingCurveComplete: true
                    };
                    
                    await callback(candidate);
                }
            }
        }
    }
}