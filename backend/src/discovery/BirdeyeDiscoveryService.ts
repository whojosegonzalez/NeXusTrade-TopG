import { BirdeyeBudgetTracker } from "../services/BirdeyeBudgetTracker.js";

export interface BirdeyeTrendingToken {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly liquidity: number;
  readonly price: number;
  readonly volume24hUSD?: number | undefined;
  readonly rank: number;
}

export interface BirdeyeDiscoveryOptions {
  readonly apiKey?: string;
  readonly budgetTracker?: BirdeyeBudgetTracker;
  readonly fetchFn?: typeof fetch;
  readonly logger?: (msg: string) => void;
}

export interface ProbeSmartMoneyResult {
  readonly supported: boolean;
  readonly status: number;
}

export class BirdeyeDiscoveryService {
  private readonly apiKey: string;
  private readonly budgetTracker: BirdeyeBudgetTracker;
  private readonly fetchFn: typeof fetch;
  private readonly logger: (msg: string) => void;

  private smartMoneyAvailable = false;
  private cachedTrendingTokens: readonly BirdeyeTrendingToken[] = [];

  constructor(options: BirdeyeDiscoveryOptions = {}) {
    this.apiKey = options.apiKey ?? (process.env.BIRDEYE_API_KEY || "");
    this.budgetTracker = options.budgetTracker ?? new BirdeyeBudgetTracker();
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.logger = options.logger ?? ((msg: string) => console.log(msg));
  }

  getBudgetTracker(): BirdeyeBudgetTracker {
    return this.budgetTracker;
  }

  isSmartMoneyAvailable(): boolean {
    return this.smartMoneyAvailable;
  }

  async probeSmartMoney(): Promise<ProbeSmartMoneyResult> {
    if (!this.apiKey) {
      this.logger("[BirdeyeDiscovery] No Birdeye API key configured. Smart Money disabled.");
      this.smartMoneyAvailable = false;
      return { supported: false, status: 401 };
    }

    try {
      const url = "https://public-api.birdeye.so/smart-money/v1/token/list";
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          "X-API-KEY": this.apiKey,
          "x-chain": "solana",
        },
      });

      if (response.status === 403) {
        this.logger(
          "[BirdeyeDiscovery] Smart Money endpoint returned 403 Forbidden (Standard plan active). Disabling Smart Money discovery stream.",
        );
        this.smartMoneyAvailable = false;
        return { supported: false, status: 403 };
      }

      if (response.ok) {
        this.smartMoneyAvailable = true;
        this.logger("[BirdeyeDiscovery] Smart Money endpoint verified available.");
        return { supported: true, status: 200 };
      }

      this.smartMoneyAvailable = false;
      return { supported: false, status: response.status };
    } catch (err) {
      this.logger(`[BirdeyeDiscovery] Error probing smart money endpoint: ${String(err)}`);
      this.smartMoneyAvailable = false;
      return { supported: false, status: 0 };
    }
  }

  async fetchTrendingTokens(
    limit = 20,
    nowMs: number = Date.now(),
  ): Promise<readonly BirdeyeTrendingToken[]> {
    if (!this.apiKey) {
      return this.cachedTrendingTokens;
    }

    if (!this.budgetTracker.canPollTrending(nowMs)) {
      return this.cachedTrendingTokens;
    }

    try {
      const url = `https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=${limit}`;
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          "X-API-KEY": this.apiKey,
          "x-chain": "solana",
        },
      });

      if (!response.ok) {
        this.logger(
          `[BirdeyeDiscovery] Trending tokens fetch returned status ${response.status}: ${response.statusText}`,
        );
        return this.cachedTrendingTokens;
      }

      this.budgetTracker.recordTrendingPoll(nowMs);

      const json = (await response.json()) as {
        data?: {
          tokens?: Array<{
            address?: string;
            symbol?: string;
            name?: string;
            decimals?: number;
            liquidity?: number;
            price?: number;
            volume24hUSD?: number;
            rank?: number;
          }>;
        };
      };

      const rawTokens = json.data?.tokens ?? [];
      const parsedTokens: BirdeyeTrendingToken[] = rawTokens
        .filter((t): t is typeof t & { address: string; symbol: string } =>
          Boolean(t.address && t.symbol),
        )
        .map((t, idx) => ({
          address: t.address,
          symbol: t.symbol,
          name: t.name ?? t.symbol,
          decimals: t.decimals ?? 9,
          liquidity: t.liquidity ?? 0,
          price: t.price ?? 0,
          ...(t.volume24hUSD !== undefined ? { volume24hUSD: t.volume24hUSD } : {}),
          rank: t.rank ?? idx + 1,
        }));

      this.cachedTrendingTokens = parsedTokens;
      return parsedTokens;
    } catch (err) {
      this.logger(`[BirdeyeDiscovery] Error fetching trending tokens: ${String(err)}`);
      return this.cachedTrendingTokens;
    }
  }
}
