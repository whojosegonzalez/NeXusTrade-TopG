import axios from 'axios';
import { CONFIG } from '../config';
import { IRiskEngine, RiskScore } from './interfaces';

export class HeliusRiskEngine implements IRiskEngine {
    private apiKey: string;
    private rpcUrl: string;

    constructor() {
        if (!CONFIG.HELIUS_API_KEY) throw new Error("Helius API Key required for Risk Engine");
        this.apiKey = CONFIG.HELIUS_API_KEY;
        this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
    }

    async evaluate(mint: string): Promise<RiskScore> {
        try {
            const response = await axios.post(this.rpcUrl, {
                jsonrpc: '2.0',
                id: 'my-id',
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

            const authorities = asset.authorities || [];
            const mintAuth = authorities.find((a: any) => a.scopes.includes('mint'));
            
            if (mintAuth) {
                score -= 50;
                reasons.push('MINT_AUTHORITY_ENABLED');
            }

            const freezeAuth = authorities.find((a: any) => a.scopes.includes('freeze'));
            if (freezeAuth) {
                score = 0;
                isRug = true;
                reasons.push('FREEZE_AUTHORITY_ENABLED');
            }

            return {
                score,
                isRug,
                reasons,
                mintAuthority: mintAuth ? mintAuth.address : null,
                freezeAuthority: freezeAuth ? freezeAuth.address : null,
                supply: asset.token_info?.supply || 0
            };

        } catch (error) {
            console.error("Risk Check Failed:", error);
            return {
                score: 0,
                isRug: true,
                reasons: ['API_ERROR'],
                mintAuthority: null,
                freezeAuthority: null,
                supply: 0
            };
        }
    }
}