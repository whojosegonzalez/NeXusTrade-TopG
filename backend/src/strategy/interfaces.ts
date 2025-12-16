import { TokenCandidate } from "../scanners/interfaces";
import { RiskScore } from "../risk/interfaces";

export interface StrategyDecision {
    action: 'BUY' | 'SKIP' | 'HOLD';
    confidence: number; // 0 to 100
    reason: string;
    suggestedSizeSOL: number;
}

export interface IStrategy {
    name: string;
    evaluate(token: TokenCandidate, risk: RiskScore): Promise<StrategyDecision>;
}