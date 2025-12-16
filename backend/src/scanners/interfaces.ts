export interface TokenCandidate {
    mint: string;       // The token's address
    symbol: string;     // e.g., "BONK"
    name: string;
    liquidityUSD: number;
    createdAt: Date;
    bondingCurveComplete: boolean; // Vital for Pump.fun tokens
}

export interface IScanner {
    name: string;
    /**
     * Starts listening for new tokens.
     * @param callback Function to call when a new token is found
     */
    start(callback: (token: TokenCandidate) => Promise<void>): Promise<void>;
    
    /**
     * Stops the scanner.
     */
    stop(): void;
}
