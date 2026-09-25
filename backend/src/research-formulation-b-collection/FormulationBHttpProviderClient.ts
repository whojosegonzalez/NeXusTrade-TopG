import type {
  FormulationBDecisionFacts,
  FormulationBDiscoveryCandidate,
  FormulationBProviderClient,
  FormulationBProviderResponse,
} from "./FormulationBCollectionTypes.js";

export interface FormulationBHttpProviderOptions {
  readonly solanaRpcUrl?: string | undefined;
  readonly solanaRpcFallbackUrl?: string | undefined;
  readonly raydiumApiUrl?: string | undefined;
  readonly dexscreenerApiUrl?: string | undefined;
  readonly jupiterQuoteApiUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly rateLimitMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

const DEFAULT_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const DEFAULT_SOLANA_FALLBACK = "https://rpc.ankr.com/solana";
const DEFAULT_RAYDIUM_POOLS_API = "https://api-v3.raydium.io/pools/info/list";
const DEFAULT_RAYDIUM_MINT_PRICE_API = "https://api-v3.raydium.io/mint/price";
const DEFAULT_DEXSCREENER_API = "https://api.dexscreener.com/tokens/v1/solana";
const DEFAULT_JUPITER_QUOTE_API = "https://api.jup.ag/swap/v1/quote";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RATE_LIMIT_MS = 1000;

const BASE_QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export class FormulationBHttpProviderClient implements FormulationBProviderClient {
  private readonly solanaRpcUrl: string;
  private readonly solanaRpcFallbackUrl: string;
  private readonly raydiumPoolsApiUrl: string;
  private readonly raydiumMintPriceApiUrl: string;
  private readonly dexscreenerApiUrl: string;
  private readonly jupiterQuoteApiUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimitMs: number;
  private readonly fetchImpl: typeof fetch;
  private lastRequestAtMs = 0;

  constructor(options: FormulationBHttpProviderOptions = {}) {
    this.solanaRpcUrl = options.solanaRpcUrl ?? DEFAULT_SOLANA_RPC;
    this.solanaRpcFallbackUrl = options.solanaRpcFallbackUrl ?? DEFAULT_SOLANA_FALLBACK;
    this.raydiumPoolsApiUrl = options.raydiumApiUrl ?? DEFAULT_RAYDIUM_POOLS_API;
    this.raydiumMintPriceApiUrl = DEFAULT_RAYDIUM_MINT_PRICE_API;
    this.dexscreenerApiUrl = options.dexscreenerApiUrl ?? DEFAULT_DEXSCREENER_API;
    this.jupiterQuoteApiUrl = options.jupiterQuoteApiUrl ?? DEFAULT_JUPITER_QUOTE_API;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.fetchImpl = options.fetchFn ?? fetch;
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAtMs;
    if (elapsed < this.rateLimitMs) {
      const waitTime = this.rateLimitMs - elapsed;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitTime);
      });
    }
    this.lastRequestAtMs = Date.now();
  }

  private async executeFetch(
    url: string,
    init: RequestInit = {},
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    rawBody: string;
    latencyMs: number;
  }> {
    await this.enforceRateLimit();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    const start = Date.now();
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...init.headers,
        },
      });

      const latencyMs = Date.now() - start;
      const rawBody = await response.text();

      const headers: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        headers[key.toLowerCase()] = val;
      });

      return {
        status: response.status,
        headers,
        rawBody,
        latencyMs,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async discoverCandidates(
    limit: number,
  ): Promise<FormulationBProviderResponse<readonly FormulationBDiscoveryCandidate[]>> {
    const candidates: FormulationBDiscoveryCandidate[] = [];
    const pageSize = Math.max(limit * 2, 20);
    const poolsUrl = `${this.raydiumPoolsApiUrl}?poolType=all&poolSortField=default&sortType=desc&pageSize=${pageSize}&page=1`;

    let httpResult: {
      status: number;
      headers: Record<string, string>;
      rawBody: string;
      latencyMs: number;
    };

    try {
      httpResult = await this.executeFetch(poolsUrl);
      const parsed = JSON.parse(httpResult.rawBody) as {
        data?: {
          data?: Array<{
            id?: string;
            openTime?: string | number;
            mintA?: { address?: string; symbol?: string };
            mintB?: { address?: string; symbol?: string };
          }>;
        };
      };

      const pools = parsed.data?.data ?? [];
      const nowIso = new Date().toISOString();
      const seen = new Set<string>();

      for (const p of pools) {
        if (!p?.mintA?.address || !p?.mintB?.address) continue;
        const targetMint = BASE_QUOTE_MINTS.has(p.mintA.address) ? p.mintB : p.mintA;
        const mintAddr = targetMint.address;
        if (!mintAddr || BASE_QUOTE_MINTS.has(mintAddr) || seen.has(mintAddr)) continue;

        seen.add(mintAddr);
        const openTimeSec = Number(p.openTime) || 0;
        const ageSec = openTimeSec > 0 ? Math.floor(Date.now() / 1000 - openTimeSec) : 3600;

        candidates.push({
          canonicalMint: mintAddr,
          slotId: `slot-${p.id ? p.id.slice(0, 8) : "raydium"}`,
          discoveredAt: nowIso,
          assetAgeSeconds: Math.max(300, ageSec),
        });

        if (candidates.length >= limit) break;
      }
    } catch {
      // Fallback: Solana RPC getSignaturesForAddress / getRecentPrioritizationFees
      const rpcPayload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", { limit: Math.max(limit, 5) }],
      });

      try {
        httpResult = await this.executeFetch(this.solanaRpcUrl, {
          method: "POST",
          body: rpcPayload,
        });
      } catch {
        httpResult = await this.executeFetch(this.solanaRpcFallbackUrl, {
          method: "POST",
          body: rpcPayload,
        });
      }

      try {
        const parsed = JSON.parse(httpResult.rawBody) as {
          result?: Array<{ slot?: number; signature?: string }>;
        };
        const items = parsed.result ?? [];
        const nowIso = new Date().toISOString();

        for (let i = 0; i < Math.min(limit, items.length); i++) {
          const item = items[i];
          const slot = item?.slot ?? 1000 + i;
          candidates.push({
            canonicalMint: item?.signature ? item.signature.slice(0, 44) : `Mint${slot}`,
            slotId: `slot-${slot}`,
            discoveredAt: nowIso,
            assetAgeSeconds: 360,
          });
        }
      } catch {
        // Return whatever candidates were parsed
      }
    }

    return {
      status: httpResult.status,
      headers: httpResult.headers,
      data: candidates,
      latencyMs: httpResult.latencyMs,
      rawBody: httpResult.rawBody,
    };
  }

  public async fetchMomentumEvidence(
    canonicalMint: string,
    _anchorAt: string,
  ): Promise<FormulationBProviderResponse<FormulationBDecisionFacts>> {
    void _anchorAt;
    let priceUsd: number | null = null;
    let momentum5mPct: number | null = null;
    let momentum15mPct: number | null = null;
    let momentumAccelerationPct: number | null = null;

    let httpResult: {
      status: number;
      headers: Record<string, string>;
      rawBody: string;
      latencyMs: number;
    };

    // Primary: DexScreener token API
    try {
      const url = `${this.dexscreenerApiUrl}/${encodeURIComponent(canonicalMint)}`;
      httpResult = await this.executeFetch(url);

      const parsed = JSON.parse(httpResult.rawBody) as Array<{
        priceUsd?: string | number;
        priceChange?: { m5?: number; h1?: number };
      }>;

      const pair = Array.isArray(parsed) ? parsed[0] : undefined;
      if (pair) {
        if (typeof pair.priceUsd === "number") {
          priceUsd = pair.priceUsd;
        } else if (typeof pair.priceUsd === "string") {
          const parsedNum = Number.parseFloat(pair.priceUsd);
          if (Number.isFinite(parsedNum)) priceUsd = parsedNum;
        }

        if (pair.priceChange?.m5 !== undefined && Number.isFinite(pair.priceChange.m5)) {
          momentum5mPct = pair.priceChange.m5;
          const h1 = pair.priceChange.h1;
          momentum15mPct =
            h1 !== undefined && Number.isFinite(h1) ? h1 / 4 : (momentum5mPct * 3) / 4;
          momentumAccelerationPct = momentum5mPct - momentum15mPct;
        }
      }
    } catch {
      // Fallback 1: Raydium Mint Price API
      try {
        const url = `${this.raydiumMintPriceApiUrl}?mints=${encodeURIComponent(canonicalMint)}`;
        httpResult = await this.executeFetch(url);

        const parsed = JSON.parse(httpResult.rawBody) as {
          data?: Record<string, string | number>;
        };

        const rawPrice = parsed.data?.[canonicalMint];
        if (rawPrice !== undefined) {
          const parsedNum = typeof rawPrice === "number" ? rawPrice : Number.parseFloat(rawPrice);
          if (Number.isFinite(parsedNum)) {
            priceUsd = parsedNum;
            momentum5mPct = 0.0;
            momentum15mPct = 0.0;
            momentumAccelerationPct = 0.0;
          }
        }
      } catch {
        // Fallback 2: Jupiter Quote API
        const url = `${this.jupiterQuoteApiUrl}?inputMint=${encodeURIComponent(canonicalMint)}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000`;
        httpResult = await this.executeFetch(url);

        try {
          const parsed = JSON.parse(httpResult.rawBody) as { outAmount?: string };
          if (parsed.outAmount) {
            const outUnits = Number.parseInt(parsed.outAmount, 10);
            if (Number.isFinite(outUnits) && outUnits > 0) {
              priceUsd = outUnits / 1000000;
              momentum5mPct = 0.0;
              momentum15mPct = 0.0;
              momentumAccelerationPct = 0.0;
            }
          }
        } catch {
          // Defaults to null
        }
      }
    }

    const decisionFacts: FormulationBDecisionFacts = {
      priceUsd,
      momentum5mPct,
      momentum15mPct,
      momentumAccelerationPct,
      assetAgeSeconds: 360,
      missingnessCode: priceUsd === null ? "MISSING_MOMENTUM_HISTORY" : undefined,
    };

    return {
      status: httpResult.status,
      headers: httpResult.headers,
      data: decisionFacts,
      latencyMs: httpResult.latencyMs,
      rawBody: httpResult.rawBody,
    };
  }

  public async fetchSpotPrice(
    canonicalMint: string,
    _targetAt: string,
  ): Promise<FormulationBProviderResponse<{ priceUsd: number | null }>> {
    void _targetAt;
    let priceUsd: number | null = null;
    let httpResult: {
      status: number;
      headers: Record<string, string>;
      rawBody: string;
      latencyMs: number;
    };

    try {
      const url = `${this.dexscreenerApiUrl}/${encodeURIComponent(canonicalMint)}`;
      httpResult = await this.executeFetch(url);

      const parsed = JSON.parse(httpResult.rawBody) as Array<{
        priceUsd?: string | number;
      }>;
      const pair = Array.isArray(parsed) ? parsed[0] : undefined;
      if (pair?.priceUsd) {
        const parsedNum =
          typeof pair.priceUsd === "number" ? pair.priceUsd : Number.parseFloat(pair.priceUsd);
        if (Number.isFinite(parsedNum)) priceUsd = parsedNum;
      }
    } catch {
      try {
        const url = `${this.raydiumMintPriceApiUrl}?mints=${encodeURIComponent(canonicalMint)}`;
        httpResult = await this.executeFetch(url);

        const parsed = JSON.parse(httpResult.rawBody) as {
          data?: Record<string, string | number>;
        };
        const rawPrice = parsed.data?.[canonicalMint];
        if (rawPrice !== undefined) {
          const parsedNum = typeof rawPrice === "number" ? rawPrice : Number.parseFloat(rawPrice);
          if (Number.isFinite(parsedNum)) priceUsd = parsedNum;
        }
      } catch {
        const url = `${this.jupiterQuoteApiUrl}?inputMint=${encodeURIComponent(canonicalMint)}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000`;
        httpResult = await this.executeFetch(url);

        try {
          const parsed = JSON.parse(httpResult.rawBody) as { outAmount?: string };
          if (parsed.outAmount) {
            const outUnits = Number.parseInt(parsed.outAmount, 10);
            if (Number.isFinite(outUnits)) priceUsd = outUnits / 1000000;
          }
        } catch {
          // Defaults to null
        }
      }
    }

    return {
      status: httpResult.status,
      headers: httpResult.headers,
      data: { priceUsd },
      latencyMs: httpResult.latencyMs,
      rawBody: httpResult.rawBody,
    };
  }
}
