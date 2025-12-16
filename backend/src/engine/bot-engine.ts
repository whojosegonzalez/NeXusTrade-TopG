import { HeliusScanner } from "../scanners/helius";
import { HeliusRiskEngine } from "../risk/helius-risk";
import { TokenIngestor } from "../pipeline/ingestor";
import { SessionManager } from "../strategy/session-manager";
import { PositionManager } from "../strategy/position-manager";
import { SimpleSafeStrategy } from "../strategy/simple-strategy";
import { prisma } from "../database/client";
import { TokenCandidate } from "../scanners/interfaces";
import { JupiterPriceOracle } from "../market/jupiter-price"; // Need this to get initial buy price!

export class BotEngine {
    private scanner: HeliusScanner;
    private riskEngine: HeliusRiskEngine;
    private ingestor: TokenIngestor;
    private sessionManager: SessionManager;
    private positionManager: PositionManager;
    private strategy: SimpleSafeStrategy;
    private priceOracle: JupiterPriceOracle; // New

    private isRunning = false;
    private isBuying = true;
    private sessionId: string | null = null;
    
    // We can rely on the DB count for accuracy, or keep a local cache
    private activePositionsCount = 0;

    constructor() {
        this.scanner = new HeliusScanner();
        this.riskEngine = new HeliusRiskEngine();
        this.ingestor = new TokenIngestor();
        this.sessionManager = new SessionManager();
        this.positionManager = new PositionManager(this.sessionManager);
        this.strategy = new SimpleSafeStrategy();
        this.priceOracle = new JupiterPriceOracle();
    }

    async start(startBalance: number = 10.0, maxPositions: number = 5, tradeSize: number = 0.1) {
        if (this.isRunning) return;
        
        console.log("🚀 Starting NeXus Trade Engine (Paper Trading Mode)...");

        this.sessionId = await this.sessionManager.start({
            startBalance: startBalance,
            targetProfit: startBalance * 1.5,
            stopLoss: startBalance * 0.8,
            maxPositions: maxPositions, // Configurable Limit
            tradeSizeSOL: tradeSize     // Configurable Size
        });

        this.activePositionsCount = 0;
        this.isRunning = true;
        this.isBuying = true;

        await this.scanner.start(async (token) => {
            if (this.sessionId) {
                // 1. Manage Positions
                await this.positionManager.managePositions(this.sessionId);
                
                // Sync position count occasionally (or just query DB here if not high frequency)
                this.activePositionsCount = await prisma.trade.count({
                    where: { sessionId: this.sessionId, status: 'OPEN' }
                });
            }

            if (this.isBuying) {
                await this.processToken(token);
            }
        });
    }

    async stop() {
        this.isRunning = false;
        this.isBuying = false;
        this.scanner.stop();
        await this.sessionManager.end("USER_STOPPED");
    }

    private async processToken(token: TokenCandidate) {
        if (!this.sessionId) return;
        const config = this.sessionManager.getConfig();
        if (!config) return;

        // 1. CHECK LIMITS: Max Positions
        if (this.activePositionsCount >= config.maxPositions) {
            // Silent skip to reduce log spam
            return;
        }

        // 2. CHECK: Duplicate
        const exists = await prisma.trade.findFirst({
            where: { sessionId: this.sessionId, mint: token.mint }
        });
        if (exists) return;

        // 3. Risk & Strategy
        const risk = await this.riskEngine.evaluate(token.mint);
        await this.ingestor.ingest(token, risk);
        const decision = await this.strategy.evaluate(token, risk);

        if (decision.action === 'BUY') {
            // Use the Configured Trade Size
            await this.executeSimulatedBuy(token, config.tradeSizeSOL);
        }
    }

    private async executeSimulatedBuy(token: TokenCandidate, amountSOL: number) {
        if (!this.sessionId) return;

        // FETCH REAL PRICE for Entry
        // If we can't get a price, we can't open a "Real" paper trade
        const realPrice = await this.priceOracle.getPriceInSOL(token.mint);
        
        if (!realPrice) {
            // Silent skip to reduce log spam
            // Console.log(`   ⚠️ Skipping Buy: No market price found for ${token.symbol} yet.`);
            return;
        }

        console.log(`\n💰 OPENING TRADE: ${amountSOL} SOL of ${token.symbol}`);
        console.log(`   💎 Mint: ${token.mint}`);
        console.log(`   💲 Entry Price: ${realPrice.toFixed(9)} SOL`);

        await prisma.trade.create({
            data: {
                sessionId: this.sessionId,
                mint: token.mint,
                symbol: token.symbol || "UNKNOWN",
                buyPrice: realPrice, 
                buyAmount: amountSOL / realPrice,
                buyCostSOL: amountSOL,
                status: 'OPEN',
                buyTimestamp: new Date()
            }
        });

        // Deduct "Cash" (Paper Money)
        const currentBal = (await prisma.session.findUnique({where: {id: this.sessionId}}))?.currentBalance || 0;
        const result = await this.sessionManager.updateBalance(currentBal - amountSOL, 0);

        this.activePositionsCount++;
        console.log(`   ✅ Trade Active. Total Open: ${this.activePositionsCount}`);

        if (result.status === 'WIND_DOWN') {
            console.log(`   ⚠️  ENTERING WIND-DOWN MODE: ${result.reason}`);
            this.isBuying = false;
        }
    }
}