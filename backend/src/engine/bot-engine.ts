import { HeliusScanner } from "../scanners/helius";
import { HeliusRiskEngine } from "../risk/helius-risk";
import { TokenIngestor } from "../pipeline/ingestor";
import { SessionManager } from "../strategy/session-manager";
import { SimpleSafeStrategy } from "../strategy/simple-strategy";
import { prisma } from "../database/client";
import { TokenCandidate } from "../scanners/interfaces";

export class BotEngine {
    private scanner: HeliusScanner;
    private riskEngine: HeliusRiskEngine;
    private ingestor: TokenIngestor;
    private sessionManager: SessionManager;
    private strategy: SimpleSafeStrategy;

    private isRunning = false;
    private sessionId: string | null = null;
    
    // FIX: Memory cache to prevent double-buying the same token
    private activePositions: Set<string> = new Set();

    constructor() {
        this.scanner = new HeliusScanner();
        this.riskEngine = new HeliusRiskEngine();
        this.ingestor = new TokenIngestor();
        this.sessionManager = new SessionManager();
        this.strategy = new SimpleSafeStrategy();
    }

    async start(startBalance: number = 10.0) {
        if (this.isRunning) return;
        
        console.log("🚀 Starting NeXus Trade Engine...");

        this.sessionId = await this.sessionManager.start({
            startBalance: startBalance,
            targetProfit: startBalance * 1.5,
            stopLoss: startBalance * 0.8
        });

        // Reset cache on start
        this.activePositions.clear();
        this.isRunning = true;

        await this.scanner.start(async (token) => {
            await this.processToken(token);
        });
    }

    async stop() {
        this.isRunning = false;
        this.scanner.stop();
        await this.sessionManager.end("USER_STOPPED");
    }

    private async processToken(token: TokenCandidate) {
        if (!this.sessionId) return;

        // FIX: Check if we already own this token
        if (this.activePositions.has(token.mint)) {
            // console.log(`   ⏭️ Skipping ${token.mint} (Already Active)`);
            return;
        }

        const risk = await this.riskEngine.evaluate(token.mint);
        await this.ingestor.ingest(token, risk);

        const decision = await this.strategy.evaluate(token, risk);

        if (decision.action === 'BUY') {
            await this.executeSimulatedBuy(token, decision.suggestedSizeSOL);
        } else {
            console.log(`\n🔎 Analyzed ${token.mint}: ${decision.action} (${decision.reason})`);
        }
    }

    private async executeSimulatedBuy(token: TokenCandidate, amountSOL: number) {
        if (!this.sessionId) return;

        console.log(`\n💰 SIMULATED BUY: ${amountSOL} SOL of ${token.symbol} (${token.mint})`);

        await prisma.trade.create({
            data: {
                sessionId: this.sessionId,
                mint: token.mint,
                symbol: token.symbol || "UNKNOWN",
                buyPrice: 0.0001, 
                buyAmount: amountSOL / 0.0001,
                buyCostSOL: amountSOL,
                status: 'OPEN',
                buyTimestamp: new Date()
            }
        });

        // FIX: Add to memory cache so we don't buy it again
        this.activePositions.add(token.mint);

        console.log(`   ✅ Trade Logged in Session ${this.sessionId}`);
    }
}