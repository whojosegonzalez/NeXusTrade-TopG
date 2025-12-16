import { prisma } from '../database/client';
import { TokenCandidate } from '../scanners/interfaces';
import { RiskScore } from '../risk/interfaces';

export class TokenIngestor {
    /**
     * Saves a scanned token and its risk profile to the database.
     * This allows us to track "Missed Opportunities" (tokens we rejected but pumped).
     */
    async ingest(candidate: TokenCandidate, risk: RiskScore): Promise<void> {
        try {
            // 1. Determine the Decision immediately
            // (In Phase 3, this logic moves to a Strategy Engine, but for now we log the "Why")
            let decision = "WATCHING";
            let rejectReason = null;

            if (risk.isRug) {
                decision = "REJECTED_RUG";
                rejectReason = risk.reasons.join(', ');
            } else if (risk.score < 70) {
                decision = "REJECTED_RISK";
                rejectReason = risk.reasons.join(', ');
            } else {
                decision = "ACCEPTED";
            }

            // 2. Write to Database
            // We use 'upsert' so we don't crash if we see the same token twice
            await prisma.tokenRadar.upsert({
                where: { mint: candidate.mint },
                update: {
                    riskScore: risk.score,
                    liquidityUSD: candidate.liquidityUSD,
                    decision: decision,
                    rejectReason: rejectReason,
                    // If we scan it again, we update the timestamp to show it's still active
                    detectedAt: new Date()
                },
                create: {
                    mint: candidate.mint,
                    symbol: candidate.symbol,
                    liquidityUSD: candidate.liquidityUSD,
                    volume24h: 0, // Initial volume is 0
                    riskScore: risk.score,
                    decision: decision,
                    rejectReason: rejectReason,
                    detectedAt: new Date()
                }
            });

            // console.log(`   💾 Saved ${candidate.symbol} to Database (${decision})`);

        } catch (error) {
            console.error(`   ❌ Failed to ingest token ${candidate.mint}:`, error);
        }
    }
}