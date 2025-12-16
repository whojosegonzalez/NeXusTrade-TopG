import { HeliusRiskEngine } from "../risk/helius-risk";
import { TokenIngestor } from "../pipeline/ingestor";
import { SessionManager } from "../strategy/session-manager";
import { PositionManager } from "../strategy/position-manager";
import { SimpleSafeStrategy } from "../strategy/simple-strategy";
import { prisma } from "../database/client";
import { TokenCandidate, IScanner } from "../scanners/interfaces"; // Updated import
import { JupiterPriceOracle } from "../market/jupiter-price";

export class BotEngine {
    private scanners: IScanner[]; // CHANGED: Array of scanners
    private riskEngine: HeliusRiskEngine;
    private ingestor: TokenIngestor;
    private sessionManager: SessionManager;
    private positionManager: PositionManager;
    private strategy: SimpleSafeStrategy;
    private priceOracle: JupiterPriceOracle;

    private isRunning = false;
    private isBuying = true;
    private sessionId: string | null = null;
    
    private activePositionsCount = 0;

    // CHANGED: Constructor now accepts scanners
    constructor(scanners: IScanner[]) {
        this.scanners = scanners;
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
            maxPositions: maxPositions,
            tradeSizeSOL: tradeSize
        });

        this.activePositionsCount = 0;
        this.isRunning = true;
        this.isBuying = true;

        // CHANGED: Loop through all scanners and start them
        for (const scanner of this.scanners) {
            console.log(`   🔌 Attaching Scanner: ${scanner.name}`);
            // We don't await here because we want them running in parallel
            // and we don't want one scanner to block the others.
            scanner.start(async (token) => {
                // Shared Callback: All scanners pipe data to this function
                if (this.sessionId) {
                    await this.positionManager.managePositions(this.sessionId);
                    
                    // Sync count less frequently (optimization)
                    if (Math.random() < 0.1) {
                        this.activePositionsCount = await prisma.trade.count({
                            where: { sessionId: this.sessionId, status: 'OPEN' }
                        });
                    }
                }

                if (this.isBuying) {
                    await this.processToken(token);
                }
            }).catch(e => console.error(`❌ Scanner ${scanner.name} crashed:`, e));
        }
    }

    async stop() {
        this.isRunning = false;
        this.isBuying = false;
        
        // CHANGED: Stop all scanners
        for (const scanner of this.scanners) {
            scanner.stop();
        }
        
        await this.sessionManager.end("USER_STOPPED");
    }

    private async processToken(token: TokenCandidate) {
        if (!this.sessionId) return;
        const config = this.sessionManager.getConfig();
        if (!config) return;

        // 1. CHECK LIMITS
        if (this.activePositionsCount >= config.maxPositions) return;

        // 2. CHECK DUPLICATE (Dedup Logic)
        // This is critical now that we have multiple scanners. 
        // Helius and DexScreener might find the same token.
        const exists = await prisma.trade.findFirst({
            where: { sessionId: this.sessionId, mint: token.mint }
        });
        if (exists) return;

        // 3. Risk & Strategy
        const risk = await this.riskEngine.evaluate(token.mint);
        await this.ingestor.ingest(token, risk);
        const decision = await this.strategy.evaluate(token, risk);

        if (decision.action === 'BUY') {
            await this.executeSimulatedBuy(token, config.tradeSizeSOL);
        }
    }

    private async executeSimulatedBuy(token: TokenCandidate, amountSOL: number) {
        if (!this.sessionId) return;

        // Fetch Real Price
        const realPrice = await this.priceOracle.getPriceInSOL(token.mint);
        
        if (!realPrice) {
            // console.log(`   ⚠️ Skipping Buy: No market price found for ${token.symbol} yet.`);
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