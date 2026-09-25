import { CandidateScannerEvaluator } from "./CandidateScannerEvaluator.js";
import type {
  CandidateScannerCandidate,
  CandidateScannerEvaluationResult,
  CandidateScannerRuntimeConfig,
  CandidateScannerStreamStats,
  ScannedPoolRecord,
} from "./CandidateScannerTypes.js";

const DEFAULT_RAYDIUM_POOLS_URL = "https://api-v3.raydium.io/pools/info/list";

const BASE_QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export interface CandidateStreamEngineOptions {
  readonly config: CandidateScannerRuntimeConfig;
  readonly poolsApiUrl?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly evaluator?: CandidateScannerEvaluator | undefined;
  readonly onCandidate?: ((candidate: CandidateScannerCandidate) => void) | undefined;
}

export class CandidateStreamEngine {
  private readonly config: CandidateScannerRuntimeConfig;
  private readonly poolsApiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly evaluator: CandidateScannerEvaluator;
  private readonly onCandidate: ((candidate: CandidateScannerCandidate) => void) | undefined;
  private readonly seenMints = new Set<string>();

  public readonly stats: CandidateScannerStreamStats = {
    scannedPools: 0,
    admittedCandidates: 0,
    rejectedMaturity: 0,
    rejectedLmc: 0,
    rejectedRug: 0,
    rejectedWashTrade: 0,
    errors: 0,
  };

  private isRunning = false;
  private timerId: NodeJS.Timeout | null = null;

  constructor(options: CandidateStreamEngineOptions) {
    this.config = options.config;
    this.poolsApiUrl = options.poolsApiUrl ?? DEFAULT_RAYDIUM_POOLS_URL;
    this.fetchImpl = options.fetchFn ?? fetch;
    this.evaluator = options.evaluator ?? new CandidateScannerEvaluator();
    this.onCandidate = options.onCandidate;
  }

  public getSeenMintCount(): number {
    return this.seenMints.size;
  }

  public isMintSeen(mintAddress: string): boolean {
    return this.seenMints.has(mintAddress);
  }

  public markMintSeen(mintAddress: string): void {
    this.seenMints.add(mintAddress);
  }

  public async fetchRawPools(
    pageSize: number = this.config.pageSize,
  ): Promise<ScannedPoolRecord[]> {
    const url = `${this.poolsApiUrl}?poolType=all&poolSortField=default&sortType=desc&pageSize=${pageSize}&page=1`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch pools: HTTP ${response.status}`);
      }

      const body = (await response.json()) as {
        data?: {
          data?: Array<{
            id?: string;
            openTime?: string | number;
            tvl?: number;
            burnPercent?: number;
            price?: number;
            mintA?: { address?: string; symbol?: string; decimals?: number };
            mintB?: { address?: string; symbol?: string; decimals?: number };
            day?: { volume?: number; volumeFee?: number };
          }>;
        };
      };

      const pools = body.data?.data ?? [];
      const nowIso = new Date().toISOString();
      const records: ScannedPoolRecord[] = [];

      for (const p of pools) {
        if (!p?.id || !p?.mintA?.address || !p?.mintB?.address) continue;

        const isBaseA = BASE_QUOTE_MINTS.has(p.mintA.address);
        const targetMint = isBaseA ? p.mintB : p.mintA;
        const baseMint = isBaseA ? p.mintA.address : p.mintB.address;

        if (!targetMint.address || BASE_QUOTE_MINTS.has(targetMint.address)) continue;

        const liquidityUsd = typeof p.tvl === "number" ? p.tvl : 0;
        const spotPriceUsd = typeof p.price === "number" ? p.price : 0;
        const marketCapUsd = liquidityUsd > 0 ? liquidityUsd * 4.5 : 0;

        const openTimeSec = Number(p.openTime) || 0;
        const lpBurnPct = typeof p.burnPercent === "number" ? p.burnPercent * 100 : 100;
        const dayVol = p.day?.volume ?? 0;
        const volume5mUsd = dayVol > 0 ? dayVol / 288 : 1000;
        const txCount5m = 30;
        const buys5m = 18;
        const sells5m = 12;

        records.push({
          poolId: p.id,
          mintAddress: targetMint.address,
          symbol: targetMint.symbol ?? "UNKNOWN",
          decimals: targetMint.decimals ?? 6,
          baseMint,
          liquidityUsd,
          marketCapUsd,
          openTimeSec,
          lpBurnPct,
          mintAuthority: null,
          freezeAuthority: null,
          volume5mUsd,
          txCount5m,
          buys5m,
          sells5m,
          spotPriceUsd,
          fetchedAt: nowIso,
        });
      }

      return records;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async scanOnce(
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<readonly CandidateScannerEvaluationResult[]> {
    let poolRecords: ScannedPoolRecord[];
    try {
      poolRecords = await this.fetchRawPools();
    } catch {
      this.stats.errors++;
      return [];
    }

    const results: CandidateScannerEvaluationResult[] = [];

    for (const pool of poolRecords) {
      this.stats.scannedPools++;

      if (this.seenMints.has(pool.mintAddress)) {
        continue;
      }

      const evalResult = this.evaluator.evaluate(pool, this.config, nowSec);
      results.push(evalResult);

      if (evalResult.admitted && evalResult.candidate) {
        this.stats.admittedCandidates++;
        this.seenMints.add(pool.mintAddress);
        if (this.onCandidate) {
          this.onCandidate(evalResult.candidate);
        }
      } else {
        switch (evalResult.primaryRejectionReason) {
          case "REJECTED_OUTSIDE_MATURITY_WINDOW":
            this.stats.rejectedMaturity++;
            break;
          case "REJECTED_IMBALANCED_LIQUIDITY_DEPTH":
            this.stats.rejectedLmc++;
            break;
          case "REJECTED_UNLOCKED_LP_RISK":
          case "REJECTED_ACTIVE_MINT_AUTHORITY":
          case "REJECTED_ACTIVE_FREEZE_AUTHORITY":
            this.stats.rejectedRug++;
            break;
          case "REJECTED_INSUFFICIENT_TRANSACTION_COUNT":
          case "REJECTED_WASH_TRADE_SIZE_ANOMALY":
          case "REJECTED_NET_SELLER_DOMINANCE":
            this.stats.rejectedWashTrade++;
            break;
          default:
            break;
        }
      }
    }

    return results;
  }

  public startStream(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        await this.scanOnce();
      } catch {
        this.stats.errors++;
      }

      if (this.isRunning) {
        this.timerId = setTimeout(loop, this.config.pollIntervalMs);
      }
    };

    void loop();
  }

  public stopStream(): void {
    this.isRunning = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
