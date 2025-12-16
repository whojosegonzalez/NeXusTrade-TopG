import axios from 'axios';

export class JupiterPriceOracle {
    private baseUrl = 'https://api.jup.ag/price/v2';

    /**
     * Fetches the current price of a token in SOL.
     * @param mint The token mint address
     * @returns Price in SOL (e.g., 0.0023)
     */
    async getPriceInSOL(mint: string): Promise<number | null> {
        try {
            // Request price vs SOL
            // Example: https://api.jup.ag/price/v2?ids=TokenMint&vsToken=So1111...
            const solMint = 'So11111111111111111111111111111111111111112';
            const url = `${this.baseUrl}?ids=${mint}&vsToken=${solMint}`;
            
            const response = await axios.get(url);
            
            const data = response.data.data;
            if (data && data[mint]) {
                return parseFloat(data[mint].price);
            }
            return null;
        } catch (error) {
            // It's common for new tokens to not have a Jupiter price immediately
            // console.warn(`   ⚠️ Failed to fetch price for ${mint}`);
            return null;
        }
    }
}