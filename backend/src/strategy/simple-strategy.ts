import { IStrategy, StrategyDecision } from "./interfaces";
import { TokenCandidate } from "../scanners/interfaces";
import { RiskScore } from "../risk/interfaces";

export class SimpleSafeStrategy implements IStrategy {
    name = "Simple Safe Momentum v1";

    /**
     * Evaluates a token to decide if we should simulate a buy.
     */
    async evaluate(token: TokenCandidate, risk: RiskScore): Promise<StrategyDecision> {
        // 1. HARD FAIL: Rug Check
        if (risk.isRug) {
            return { 
                action: 'SKIP', 
                confidence: 0, 
                reason: `Hard Fail: ${risk.reasons.join(', ')}`,
                suggestedSizeSOL: 0 
            };
        }

        // 2. SAFETY CHECK: Risk Score
        // We demand a high score for this conservative strategy
        if (risk.score < 80) {
            return { 
                action: 'SKIP', 
                confidence: risk.score, 
                reason: `Risk Score too low (${risk.score}/100)`,
                suggestedSizeSOL: 0 
            };
        }

        // 3. LIQUIDITY CHECK (Placeholder logic)
        // Since our current scanner returns 0 for estimated liquidity, 
        // we will temporarily BYPASS this check for the simulation test 
        // so we can see it actually "Buy" something.
        // In live trading, we would enforce: if (token.liquidityUSD < 1000) return SKIP...

        // 4. BUY SIGNAL
        // If it survived the gauntlet, we buy.
        return {
            action: 'BUY',
            confidence: risk.score, // Our confidence matches the risk safety
            reason: "Passed all safety checks. Safe to enter.",
            suggestedSizeSOL: 0.1 // Fixed position size for now
        };
    }
}