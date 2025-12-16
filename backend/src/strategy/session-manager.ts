import { prisma } from '../database/client';

export interface SessionConfig {
    startBalance: number;  // e.g., 10.0 SOL
    targetProfit: number;  // e.g., 15.0 SOL (Stop when we hit this)
    stopLoss: number;      // e.g., 8.0 SOL (Stop when we drop to this)
}

export class SessionManager {
    private sessionId: string | null = null;
    private config: SessionConfig | null = null;

    /**
     * Starts a new trading session or resumes an active one.
     */
    async start(config: SessionConfig): Promise<string> {
        this.config = config;

        // 1. Check for an existing active session to resume (safety feature)
        const activeSession = await prisma.session.findFirst({
            where: { status: 'ACTIVE' }
        });

        if (activeSession) {
            console.log(`🔄 Resuming Active Session: ${activeSession.id}`);
            this.sessionId = activeSession.id;
            // Update our local config with what was in the DB
            this.config = {
                startBalance: activeSession.startBalance,
                targetProfit: activeSession.targetProfit,
                stopLoss: activeSession.stopLoss
            };
            return this.sessionId;
        }

        // 2. Create a fresh session
        console.log(`🆕 Starting New Session with ${config.startBalance} SOL...`);
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

    /**
     * Updates the current balance and checks for Stop Loss / Take Profit hits.
     */
    async updateBalance(newBalance: number): Promise<{ status: 'CONTINUE' | 'STOP', reason?: string }> {
        if (!this.sessionId || !this.config) throw new Error("Session not started");

        // 1. Update DB
        await prisma.session.update({
            where: { id: this.sessionId },
            data: { currentBalance: newBalance }
        });

        // 2. Check Guard Rails
        if (newBalance >= this.config.targetProfit) {
            await this.end('TAKE_PROFIT');
            return { status: 'STOP', reason: 'Target Profit Hit 🚀' };
        }

        if (newBalance <= this.config.stopLoss) {
            await this.end('STOP_LOSS');
            return { status: 'STOP', reason: 'Stop Loss Hit 🛑' };
        }

        return { status: 'CONTINUE' };
    }

    /**
     * Closes the session properly.
     */
    async end(reason: string): Promise<void> {
        if (!this.sessionId) return;

        console.log(`🛑 Ending Session: ${reason}`);
        await prisma.session.update({
            where: { id: this.sessionId },
            data: {
                status: 'COMPLETED',
                endTime: new Date(),
                // We store the reason in a generic way or add a column later.
                // For now, status 'COMPLETED' implies a clean exit.
            }
        });

        this.sessionId = null;
    }
    
    getSessionId(): string | null {
        return this.sessionId;
    }
}