export class MockPriceOracle {
    // Memory to store the "Current Price" for each token
    private priceCache: Map<string, number> = new Map();

    /**
     * Simulates a "Random Walk" market.
     * The price moves relative to its LAST position, not the entry price.
     * This allows trends to form (and crash).
     */
    getNextPrice(tokenMint: string, currentOrEntryPrice: number): number {
        // 1. Get the last known price, or start at entry
        let lastPrice = this.priceCache.get(tokenMint) || currentOrEntryPrice;

        // 2. Generate volatility (Bias slightly negative to test Stop Loss, or positive for Profit)
        // Move between -3% and +3% per tick
        const volatility = 0.97 + Math.random() * 0.06; 
        
        // 3. Calculate new price
        const newPrice = lastPrice * volatility;

        // 4. Save it
        this.priceCache.set(tokenMint, newPrice);

        return newPrice;
    }
}