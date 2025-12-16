export interface RiskScore {
    score: number;        // 0 (SCAM) to 100 (SAFE)
    isRug: boolean;       // Hard fail flag (e.g., mint authority enabled)
    reasons: string[];    // Why did it get this score?
    mintAuthority: string | null;
    freezeAuthority: string | null;
    supply: number;
}

export interface IRiskEngine {
    evaluate(mint: string): Promise<RiskScore>;
}