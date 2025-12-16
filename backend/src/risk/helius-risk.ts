import axios from 'axios';
import { CONFIG } from '../config';
import { IRiskEngine, RiskScore } from './interfaces';

export class HeliusRiskEngine implements IRiskEngine {
    private rpcUrl: string;

    constructor() {
        if (!CONFIG.HELIUS_API_KEY) throw new Error("Helius API Key required for Risk Engine");
        // We use the standard RPC URL which supports DAS methods
        this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${CONFIG.HELIUS_API_KEY}`;
    }

    async evaluate(mint: string): Promise<RiskScore> {
        try {
            // Helius DAS Method: getAsset
            const response = await axios.post(this.rpcUrl, {
                jsonrpc: '2.0',
                id: 'risk-eval',
                method: 'getAsset',
                params: { id: mint }
            });

            const asset = response.data.result;
            
            if (!asset) {
                return {
                    score: 0,
                    isRug: true,
                    reasons: ['METADATA_NOT_FOUND'],
                    mintAuthority: null,
                    freezeAuthority: null,
                    supply: 0
                };
            }

            const reasons: string[] = [];
            let score = 100;
            let isRug = false;

            // 1. Check Mint Authority (Can they print more tokens?)
            // Section 6.2.1 of Gemini Report: "If mint_authority != null, return RISK_INFINITE_MINT"
            const authorities = asset.authorities || [];
            const mintAuth = authorities.find((a: any) => a.scopes.includes('mint'));
            
            if (mintAuth) {
                score -= 50;
                reasons.push('MINT_AUTHORITY_ENABLED');
                // In many "fair launch" meme coins, this should be revoked (null).
            }

            // 2. Check Freeze Authority (Can they blacklist you?)
            // Section 6.2.2 of Gemini Report: "If freeze_authority != null, return RISK_FREEZE"
            const freezeAuth = authorities.find((a: any) => a.scopes.includes('freeze'));
            if (freezeAuth) {
                score = 0;
                isRug = true;
                reasons.push('FREEZE_AUTHORITY_ENABLED');
            }

            // 3. Supply Check (Basic validation)
            const supply = asset.token_info?.supply || 0;
            if (supply === 0) {
                reasons.push('ZERO_SUPPLY');
                score -= 20;
            }

            return {
                score,
                isRug,
                reasons,
                mintAuthority: mintAuth ? mintAuth.address : null,
                freezeAuthority: freezeAuth ? freezeAuth.address : null,
                supply
            };

        } catch (error) {
            console.error(`⚠️ Risk Check Failed for ${mint}:`, error instanceof Error ? error.message : String(error));
            return {
                score: 0,
                isRug: true, // Fail safe: if we can't check, assume it's dangerous
                reasons: ['API_ERROR'],
                mintAuthority: null,
                freezeAuthority: null,
                supply: 0
            };
        }
    }
}