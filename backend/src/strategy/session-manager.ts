import { prisma } from '../database/client';

export interface SessionConfig {
    startBalance: number;
    targetProfit: number;
    stopLoss: number;      // Realized PnL limit
    maxPositions: number;  // NEW: Max open trades allowed
    tradeSizeSOL: number;  // NEW: Amount to buy per trade
}

export class SessionManager {
    private sessionId: string | null = null;
    public config: SessionConfig | null = null; // Changed to public for easy access
    private realizedPnL: number = 0;

    async start(config: SessionConfig): Promise<string> {
        this.config = config;
        this.realizedPnL = 0;

        // Resume active session logic...
        const activeSession = await prisma.session.findFirst({
            where: { status: 'ACTIVE' }
        });

        if (activeSession) {
            console.log(`🔄 Resuming Active Session: ${activeSession.id}`);
            this.sessionId = activeSession.id;
            // Note: In a full app, we would load these specific values from DB extra columns
            // For now, we assume the passed config is correct for resume
            return this.sessionId;
        }

        console.log(`🆕 Starting New Session...`);
        console.log(`   💰 Balance: ${config.startBalance} SOL`);
        console.log(`   🎲 Trade Size: ${config.tradeSizeSOL} SOL`);
        console.log(`   ✋ Max Positions: ${config.maxPositions}`);

        const session = await prisma.session.create({
            data: {
                status: 'ACTIVE',
                startBalance: config.startBalance,
                currentBalance: config.startBalance,
                targetProfit: config.targetProfit,
                stopLoss: config.stopLoss
            }
        });

        this.sessionId = session.id;
        return this.sessionId;
    }

    async updateBalance(newBalance: number, tradePnL: number = 0): Promise<{ status: 'CONTINUE' | 'WIND_DOWN', reason?: string }> {
        if (!this.sessionId || !this.config) throw new Error("Session not started");

        this.realizedPnL += tradePnL;

        await prisma.session.update({
            where: { id: this.sessionId },
            data: { currentBalance: newBalance }
        });

        // 1. Global Take Profit
        if (newBalance >= this.config.targetProfit) {
            return { status: 'WIND_DOWN', reason: 'Global Take Profit Hit 🚀' };
        }

        // 2. Global Stop Loss (Realized)
        // e.g. Start 10, StopLoss 8. Max Loss allowed is 2.
        // If realizedPnL is -2.1, we stop.
        const maxLoss = -Math.abs(this.config.stopLoss - this.config.startBalance);
        
        if (this.realizedPnL <= maxLoss) {
            return { status: 'WIND_DOWN', reason: 'Global Stop Loss Hit (Realized) 🛑' };
        }

        return { status: 'CONTINUE' };
    }

    async end(reason: string): Promise<void> {
        if (!this.sessionId) return;
        console.log(`🛑 Closing Session: ${reason}`);
        await prisma.session.update({
            where: { id: this.sessionId },
            data: {
                status: 'COMPLETED',
                endTime: new Date(),
            }
        });
        this.sessionId = null;
    }
    
    // Helper to get config
    getConfig() {
        return this.config;
    }
}