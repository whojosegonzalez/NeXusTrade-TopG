import {
  parseTokenMintAddress,
  type ProviderName,
  type QuoteRequest,
  type QuoteResult,
  type TokenEnrichmentSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";

import type { TokenRadarRecord, PositionRecord } from "../db/schema/index.js";
import {
  calculateGrossProceedsLamports,
  calculatePriceSolFromProceeds,
  isPositiveDecimal,
  parseTokenAmountToAtomic,
} from "../paper/PaperMath.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import type { SessionManagerRuntimeConfig } from "./SessionManagerConfig.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");

export type PositionValuationSource =
  | "SELL_QUOTE"
  | "REFRESHED_PRICE"
  | "CACHED_RADAR_PRICE"
  | "ENTRY_PRICE"
  | "COST_BASIS"
  | "UNAVAILABLE";

export interface PositionValuationInput {
  readonly position: PositionRecord;
  readonly tokenRadar?: TokenRadarRecord;
  readonly config: SessionManagerRuntimeConfig;
  readonly nowMs: number;
}

export interface PositionValuationResult {
  readonly position: PositionRecord;
  readonly tokenRadar?: TokenRadarRecord;
  readonly valuationSource: PositionValuationSource;
  readonly quoteSource: string;
  readonly provider?: ProviderName;
  readonly marketValueLamports: number;
  readonly markPriceSol?: string;
  readonly priceUsd?: string;
  readonly liquidityUsd?: string;
  readonly priceImpactBps?: number;
  readonly quoteFetchedAtMs?: number;
  readonly priceFetchedAtMs?: number;
  readonly cachedPriceAgeMs?: number;
  readonly tokenDecimals?: number;
  readonly tokenAmountRaw?: string;
  readonly fallbackUsed: boolean;
  readonly fallbackReason?: string;
  readonly valuationUnavailable: boolean;
  readonly warnings: readonly string[];
}

export class PositionValuationService {
  constructor(private readonly marketDataService: Pick<MarketDataService, "enrichToken">) {}

  async valuePosition(input: PositionValuationInput): Promise<PositionValuationResult> {
    const warnings: string[] = [];
    const mintAddress = parseMintAddress(input.position.mintAddress, warnings);

    if (mintAddress) {
      let enrichment = await this.tryRefresh(mintAddress, warnings);
      const tokenDecimals =
        readTokenDecimalsFromRadar(input.tokenRadar) ??
        enrichment?.identity.decimals ??
        enrichment?.metadata?.decimals;
      const exactQuote = await this.tryExactSellQuote({
        mintAddress,
        position: input.position,
        tokenRadar: input.tokenRadar,
        tokenDecimals,
        config: input.config,
        warnings,
      });

      if (exactQuote) {
        return exactQuote;
      }

      if (!enrichment) {
        enrichment = await this.tryRefresh(mintAddress, warnings);
      }

      const refreshedPrice = this.resolveRefreshedPrice(input.position, enrichment, warnings);

      if (refreshedPrice) {
        return {
          position: input.position,
          ...refreshedPrice,
          ...(input.tokenRadar ? { tokenRadar: input.tokenRadar } : {}),
        };
      }
    }

    const cachedPrice = this.resolveCachedRadarPrice(input, warnings);

    if (cachedPrice) {
      return cachedPrice;
    }

    const entryPrice = input.config.allowEntryPriceFallback
      ? this.resolveEntryPrice(input.position, input.tokenRadar, warnings)
      : undefined;

    if (entryPrice) {
      return entryPrice;
    }

    if (input.config.allowCostBasisFallback) {
      return this.resolveCostBasis(input.position, input.tokenRadar, warnings);
    }

    warnings.push("Snapshot valuation unavailable; cost basis fallback is disabled.");

    return {
      position: input.position,
      ...(input.tokenRadar ? { tokenRadar: input.tokenRadar } : {}),
      valuationSource: "UNAVAILABLE",
      quoteSource: "UNAVAILABLE",
      marketValueLamports: 0,
      fallbackUsed: true,
      fallbackReason: "No valuation source was available.",
      valuationUnavailable: true,
      warnings,
    };
  }

  private async tryExactSellQuote(input: {
    readonly mintAddress: TokenMintAddress;
    readonly position: PositionRecord;
    readonly tokenRadar: TokenRadarRecord | undefined;
    readonly tokenDecimals: number | undefined;
    readonly config: SessionManagerRuntimeConfig;
    readonly warnings: string[];
  }): Promise<PositionValuationResult | undefined> {
    if (input.tokenDecimals === undefined) {
      input.warnings.push("Snapshot exact sell quote skipped: token decimals unavailable.");
      return undefined;
    }

    const amountRaw = parseTokenAmountToAtomic(input.position.tokensHeld, input.tokenDecimals);

    if (!amountRaw) {
      input.warnings.push("Snapshot exact sell quote skipped: token amount is not representable.");
      return undefined;
    }

    const sellQuoteRequest: QuoteRequest = {
      inputMint: input.mintAddress,
      outputMint: SOL_MINT,
      amountRaw,
      side: "SELL",
      slippageBps: input.config.valuationSlippageBps,
    };
    const enrichment = await this.tryRefresh(input.mintAddress, input.warnings, sellQuoteRequest);
    const sellQuote = enrichment?.sellQuote;

    if (!sellQuote) {
      input.warnings.push("Snapshot exact sell quote unavailable.");
      return undefined;
    }

    const quote = buildValuationFromQuote({
      sellQuote,
      position: input.position,
      tokenRadar: input.tokenRadar,
      tokenDecimals: input.tokenDecimals,
      amountRaw,
      priceUsd: enrichment?.price?.priceUsd,
      liquidityUsd: enrichment?.bestPair?.liquidityUsd,
      warnings: input.warnings,
    });

    if (!quote) {
      input.warnings.push("Snapshot exact sell quote returned unusable proceeds.");
    }

    return quote;
  }

  private resolveRefreshedPrice(
    position: PositionRecord,
    enrichment: TokenEnrichmentSnapshot | undefined,
    warnings: string[],
  ): Omit<PositionValuationResult, "position"> | undefined {
    const priceSol = enrichment?.price?.priceSol ?? enrichment?.bestPair?.priceNative;
    const priceFetchedAt = enrichment?.price?.fetchedAt ?? enrichment?.bestPair?.fetchedAt;
    const provider = enrichment?.price?.source ?? enrichment?.bestPair?.source;
    const priceUsd = enrichment?.price?.priceUsd ?? enrichment?.bestPair?.priceUsd;
    const liquidityUsd = enrichment?.bestPair?.liquidityUsd;

    if (priceSol === undefined || priceSol <= 0 || !priceFetchedAt || !provider) {
      warnings.push("Snapshot refreshed price unavailable.");
      return undefined;
    }

    const markPriceSol = String(priceSol);
    const marketValueLamports = calculateGrossProceedsLamports(position.tokensHeld, markPriceSol);

    if (!marketValueLamports) {
      warnings.push("Snapshot refreshed price produced unusable market value.");
      return undefined;
    }

    return {
      valuationSource: "REFRESHED_PRICE",
      quoteSource: provider,
      provider,
      marketValueLamports,
      markPriceSol,
      ...(priceUsd !== undefined ? { priceUsd: String(priceUsd) } : {}),
      ...(liquidityUsd !== undefined ? { liquidityUsd: String(liquidityUsd) } : {}),
      priceFetchedAtMs: priceFetchedAt.getTime(),
      fallbackUsed: true,
      fallbackReason: "Exact quote unavailable; used refreshed provider price.",
      valuationUnavailable: false,
      warnings,
    };
  }

  private resolveCachedRadarPrice(
    input: PositionValuationInput,
    warnings: string[],
  ): PositionValuationResult | undefined {
    if (!input.config.allowCachedRadarPrice || !input.tokenRadar) {
      return undefined;
    }

    const priceSol = input.tokenRadar.priceSol;

    if (!isPositiveDecimal(priceSol)) {
      warnings.push("Snapshot cached TokenRadar price missing or invalid.");
      return undefined;
    }

    const marketValueLamports = calculateGrossProceedsLamports(input.position.tokensHeld, priceSol);

    if (!marketValueLamports) {
      warnings.push("Snapshot cached TokenRadar price produced unusable market value.");
      return undefined;
    }

    return {
      position: input.position,
      tokenRadar: input.tokenRadar,
      valuationSource: "CACHED_RADAR_PRICE",
      quoteSource: input.tokenRadar.source,
      marketValueLamports,
      markPriceSol: priceSol,
      ...(input.tokenRadar.priceUsd ? { priceUsd: input.tokenRadar.priceUsd } : {}),
      ...(input.tokenRadar.liquidityUsd ? { liquidityUsd: input.tokenRadar.liquidityUsd } : {}),
      cachedPriceAgeMs: input.nowMs - input.tokenRadar.updatedAtMs,
      fallbackUsed: true,
      fallbackReason: "Used cached TokenRadar price for SessionManager snapshot.",
      valuationUnavailable: false,
      warnings,
    };
  }

  private resolveEntryPrice(
    position: PositionRecord,
    tokenRadar: TokenRadarRecord | undefined,
    warnings: string[],
  ): PositionValuationResult | undefined {
    if (!isPositiveDecimal(position.avgEntryPriceSol)) {
      warnings.push("Snapshot entry price fallback unavailable.");
      return undefined;
    }

    const marketValueLamports = calculateGrossProceedsLamports(
      position.tokensHeld,
      position.avgEntryPriceSol,
    );

    if (!marketValueLamports) {
      warnings.push("Snapshot entry price fallback produced unusable market value.");
      return undefined;
    }

    return {
      position,
      ...(tokenRadar ? { tokenRadar } : {}),
      valuationSource: "ENTRY_PRICE",
      quoteSource: "POSITION_ENTRY_PRICE",
      marketValueLamports,
      markPriceSol: position.avgEntryPriceSol,
      fallbackUsed: true,
      fallbackReason: "Used position average entry price after provider and cached price fallback.",
      valuationUnavailable: false,
      warnings,
    };
  }

  private resolveCostBasis(
    position: PositionRecord,
    tokenRadar: TokenRadarRecord | undefined,
    warnings: string[],
  ): PositionValuationResult {
    const marketValueLamports = Math.max(0, position.costBasisLamports);

    warnings.push("Snapshot cost basis fallback used; no mark price is available.");

    return {
      position,
      ...(tokenRadar ? { tokenRadar } : {}),
      valuationSource: marketValueLamports > 0 ? "COST_BASIS" : "UNAVAILABLE",
      quoteSource: "POSITION_COST_BASIS",
      marketValueLamports,
      fallbackUsed: true,
      fallbackReason: "Used position cost basis because no price source was available.",
      valuationUnavailable: true,
      warnings,
    };
  }

  private async tryRefresh(
    mintAddress: TokenMintAddress,
    warnings: string[],
    sellQuoteRequest?: QuoteRequest,
  ): Promise<TokenEnrichmentSnapshot | undefined> {
    try {
      const result = await this.marketDataService.enrichToken({
        mintAddress,
        ...(sellQuoteRequest ? { sellQuoteRequest } : {}),
      });

      warnings.push(...result.warnings);

      if (!result.ok) {
        warnings.push(`${result.provider}: ${result.error.code} - ${result.error.message}`);
        return undefined;
      }

      return result.data;
    } catch (error) {
      warnings.push(
        error instanceof Error ? error.message : "Unknown SessionManager market data failure.",
      );
      return undefined;
    }
  }
}

function buildValuationFromQuote(input: {
  readonly sellQuote: QuoteResult;
  readonly position: PositionRecord;
  readonly tokenRadar: TokenRadarRecord | undefined;
  readonly tokenDecimals: number;
  readonly amountRaw: string;
  readonly priceUsd: number | undefined;
  readonly liquidityUsd: number | undefined;
  readonly warnings: readonly string[];
}): PositionValuationResult | undefined {
  const marketValueLamports = parseOutputLamports(input.sellQuote.outputAmountRaw);

  if (!marketValueLamports) {
    return undefined;
  }

  const markPriceSol = calculatePriceSolFromProceeds(
    marketValueLamports,
    input.position.tokensHeld,
  );

  if (!markPriceSol) {
    return undefined;
  }

  return {
    position: input.position,
    ...(input.tokenRadar ? { tokenRadar: input.tokenRadar } : {}),
    valuationSource: "SELL_QUOTE",
    quoteSource: input.sellQuote.source,
    provider: input.sellQuote.source,
    marketValueLamports,
    markPriceSol,
    ...(input.priceUsd !== undefined ? { priceUsd: String(input.priceUsd) } : {}),
    ...(input.liquidityUsd !== undefined ? { liquidityUsd: String(input.liquidityUsd) } : {}),
    ...(input.sellQuote.estimatedPriceImpactPct !== undefined
      ? { priceImpactBps: Math.round(input.sellQuote.estimatedPriceImpactPct * 100) }
      : {}),
    quoteFetchedAtMs: input.sellQuote.fetchedAt.getTime(),
    tokenDecimals: input.tokenDecimals,
    tokenAmountRaw: input.amountRaw,
    fallbackUsed: false,
    valuationUnavailable: false,
    warnings: input.warnings,
  };
}

function parseOutputLamports(outputAmountRaw: string): number | undefined {
  if (!/^\d+$/.test(outputAmountRaw)) {
    return undefined;
  }

  const value = BigInt(outputAmountRaw);

  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }

  return Number(value);
}

function parseMintAddress(mintAddress: string, warnings: string[]): TokenMintAddress | undefined {
  try {
    return parseTokenMintAddress(mintAddress);
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? `Snapshot provider refresh skipped: ${error.message}`
        : "Snapshot provider refresh skipped: invalid mint address.",
    );
    return undefined;
  }
}

function readTokenDecimalsFromRadar(tokenRadar: TokenRadarRecord | undefined): number | undefined {
  const rawDataJson = tokenRadar?.rawDataJson;

  if (!rawDataJson) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawDataJson) as unknown;
    return (
      readNumberAtPath(parsed, ["enrichment", "metadata", "decimals"]) ??
      readNumberAtPath(parsed, ["enrichment", "identity", "decimals"])
    );
  } catch {
    return undefined;
  }
}

function readNumberAtPath(value: unknown, path: readonly string[]): number | undefined {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
