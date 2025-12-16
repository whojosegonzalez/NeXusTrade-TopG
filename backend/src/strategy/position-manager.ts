import { prisma } from '../database/client';
import { SessionManager } from './session-manager';
import { JupiterPriceOracle } from '../market/jupiter-price';

export class PositionManager {
    private sessionManager: SessionManager;
    private oracle: JupiterPriceOracle;

    // Configurable Exit Rules
    private TAKE_PROFIT_PCT = 0.30; // +30%
    private STOP_LOSS_PCT = -0.30;  // -30%

    // Rate Limit Handling: Track when we last checked each token
    private lastCheck: Map<string, number> = new Map();
    private CHECK_INTERVAL_MS = 30000; // Check every 30 seconds

    constructor(sessionManager: SessionManager) {
        this.sessionManager = sessionManager;
        this.oracle = new JupiterPriceOracle();
    }

    async managePositions(sessionId: string): Promise<void> {
        const openTrades = await prisma.trade.findMany({
            where: { sessionId: sessionId, status: 'OPEN' }
        });

        if (openTrades.length === 0) return;

        // console.log(`   🔄 Monitoring ${openTrades.length} open positions...`);

        for (const trade of openTrades) {
            await this.evaluatePosition(trade);
        }
    }

    private async evaluatePosition(trade: any) {
        // 1. Rate Limit Check
        const now = Date.now();
        const last = this.lastCheck.get(trade.mint) || 0;
        if (now - last < this.CHECK_INTERVAL_MS) {
            return; // Too soon to check again
        }
        this.lastCheck.set(trade.mint, now);

        // 2. Fetch REAL Price from Jupiter
        const currentPrice = await this.oracle.getPriceInSOL(trade.mint);

        // If price is null, the token might be too new for Jupiter or API failed. 
        // We just SKIP this turn and hold.
        if (currentPrice === null) return;

        // 3. Calculate Performance
        const priceChange = (currentPrice - trade.buyPrice) / trade.buyPrice;
        const pnlPercent = priceChange * 100;
        
        // Log status occasionally
        console.log(`      📊 ${trade.symbol}: ${pnlPercent.toFixed(2)}% (Price: ${currentPrice.toFixed(6)})`);

        // 4. DECISION LOGIC
        let action = 'HOLD';
        let reason = '';

        if (priceChange >= this.TAKE_PROFIT_PCT) {
            action = 'SELL_PROFIT';
            reason = `Target Hit (+${pnlPercent.toFixed(2)}%)`;
        } else if (priceChange <= this.STOP_LOSS_PCT) {
            action = 'SELL_LOSS';
            reason = `Stop Loss Hit (${pnlPercent.toFixed(2)}%)`;
        }

        if (action !== 'HOLD') {
            await this.executeSell(trade, currentPrice, reason, priceChange);
        }
    }

    private async executeSell(trade: any, exitPrice: number, reason: string, priceChange: number) {
        console.log(`   🚨 EXECUTING SELL: ${trade.symbol}`);
        console.log(`      Reason: ${reason}`);

        const sellValueSOL = trade.buyAmount * exitPrice;
        const pnlSOL = sellValueSOL - trade.buyCostSOL;

        await prisma.trade.update({
            where: { id: trade.id },
            data: {
                status: 'CLOSED',
                sellPrice: exitPrice,
                sellAmount: trade.buyAmount,
                sellValueSOL: sellValueSOL,
                sellTimestamp: new Date(),
                pnlSOL: pnlSOL,
                pnlPercent: priceChange * 100
            }
        });

        const session = await prisma.session.findUnique({ where: { id: trade.sessionId } });
        if (session) {
            const newBalance = session.currentBalance + sellValueSOL;
            await this.sessionManager.updateBalance(newBalance, pnlSOL);
            console.log(`      💰 PnL: ${pnlSOL.toFixed(4)} SOL | New Balance: ${newBalance.toFixed(4)} SOL`);
        }
    }
}