import {
  parseTokenMintAddress,
  type ProviderName,
  type QuoteRequest,
  type QuoteResult,
  type TokenEnrichmentSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";

import type { MarketDataService } from "../providers/MarketDataService.js";
import type { PaperSellCandidate } from "./PaperSellCandidateSelector.js";
import type { PaperSellRuntimeConfig } from "./PaperSellConfig.js";
import {
  calculateGrossProceedsLamports,
  calculatePriceSolFromProceeds,
  isPositiveDecimal,
  parseTokenAmountToAtomic,
} from "./PaperMath.js";
import type {
  PaperSellRejectionCode,
  PaperSellValidationRejection,
} from "./PaperSellValidationService.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");

export type PaperSellPriceSource = "QUOTE" | "REFRESHED_PRICE" | "CACHED_RADAR_PRICE";

export interface PaperSellQuoteContext {
  readonly priceSource: PaperSellPriceSource;
  readonly quoteSource: string;
  readonly provider?: ProviderName;
  readonly priceSol: string;
  readonly priceUsd?: string;
  readonly tokensSold: string;
  readonly grossProceedsLamports: number;
  readonly priceImpactBps?: number;
  readonly quoteFetchedAtMs?: number;
  readonly priceFetchedAtMs?: number;
  readonly cachedPriceAgeMs?: number;
  readonly tokenDecimals?: number;
  readonly tokenAmountRaw?: string;
  readonly fallbackUsed: boolean;
  readonly fallbackReason?: string;
  readonly warnings: readonly string[];
}

export type PaperSellQuoteResolution =
  | {
      readonly ok: true;
      readonly quote: PaperSellQuoteContext;
    }
  | {
      readonly ok: false;
      readonly rejection: PaperSellValidationRejection;
    };

export class PaperSellQuoteService {
  constructor(private readonly marketDataService: Pick<MarketDataService, "enrichToken">) {}

  async resolveQuote(
    candidate: PaperSellCandidate,
    config: PaperSellRuntimeConfig,
    nowMs: number,
  ): Promise<PaperSellQuoteResolution> {
    const warnings: string[] = [];
    const mintAddress = parseTokenMintAddress(candidate.position.mintAddress);
    const tokenDecimalsFromRadar = readTokenDecimalsFromRadar(candidate);
    let enrichment = await this.tryRefresh(mintAddress, warnings);
    const tokenDecimals =
      tokenDecimalsFromRadar ?? enrichment?.identity.decimals ?? enrichment?.metadata?.decimals;
    const exactQuote = await this.tryExactSellQuote({
      mintAddress,
      tokensHeld: candidate.position.tokensHeld,
      tokenDecimals,
      config,
      warnings,
    });

    if (exactQuote) {
      return {
        ok: true,
        quote: exactQuote,
      };
    }

    if (!enrichment) {
      enrichment = await this.tryRefresh(mintAddress, warnings);
    }

    const refreshedPrice = this.resolveRefreshedPrice(candidate, enrichment, warnings);

    if (refreshedPrice) {
      return {
        ok: true,
        quote: refreshedPrice,
      };
    }

    const cachedPrice = this.resolveCachedPrice(candidate, config, nowMs, warnings);

    if (cachedPrice.ok) {
      return {
        ok: true,
        quote: cachedPrice.quote,
      };
    }

    return {
      ok: false,
      rejection: cachedPrice.rejection,
    };
  }

  private async tryExactSellQuote(input: {
    readonly mintAddress: TokenMintAddress;
    readonly tokensHeld: string;
    readonly tokenDecimals: number | undefined;
    readonly config: PaperSellRuntimeConfig;
    readonly warnings: string[];
  }): Promise<PaperSellQuoteContext | undefined> {
    if (input.tokenDecimals === undefined) {
      input.warnings.push("Exact sell quote skipped: token decimals unavailable.");
      return undefined;
    }

    const amountRaw = parseTokenAmountToAtomic(input.tokensHeld, input.tokenDecimals);

    if (!amountRaw) {
      input.warnings.push("Exact sell quote skipped: token amount cannot be represented exactly.");
      return undefined;
    }

    const sellQuoteRequest: QuoteRequest = {
      inputMint: input.mintAddress,
      outputMint: SOL_MINT,
      amountRaw,
      side: "SELL",
      slippageBps: input.config.slippageBps,
    };
    const enrichment = await this.tryRefresh(input.mintAddress, input.warnings, sellQuoteRequest);
    const sellQuote = enrichment?.sellQuote;

    if (!sellQuote) {
      input.warnings.push("Exact sell quote unavailable.");
      return undefined;
    }

    const quote = buildQuoteContextFromQuote({
      sellQuote,
      tokensHeld: input.tokensHeld,
      tokenDecimals: input.tokenDecimals,
      amountRaw,
      priceUsd: enrichment?.price?.priceUsd,
      warnings: input.warnings,
    });

    if (!quote) {
      input.warnings.push("Exact sell quote returned unusable proceeds.");
    }

    return quote;
  }

  private resolveRefreshedPrice(
    candidate: PaperSellCandidate,
    enrichment: TokenEnrichmentSnapshot | undefined,
    warnings: string[],
  ): PaperSellQuoteContext | undefined {
    const priceSol = enrichment?.price?.priceSol ?? enrichment?.bestPair?.priceNative;
    const priceFetchedAt = enrichment?.price?.fetchedAt ?? enrichment?.bestPair?.fetchedAt;
    const provider = enrichment?.price?.source ?? enrichment?.bestPair?.source;
    const priceUsd = enrichment?.price?.priceUsd ?? enrichment?.bestPair?.priceUsd;

    if (priceSol === undefined || priceSol <= 0 || !priceFetchedAt || !provider) {
      warnings.push("Refreshed price unavailable.");
      return undefined;
    }

    const priceSolText = String(priceSol);
    const grossProceedsLamports = calculateGrossProceedsLamports(
      candidate.position.tokensHeld,
      priceSolText,
    );

    if (!grossProceedsLamports) {
      warnings.push("Refreshed price produced unusable gross proceeds.");
      return undefined;
    }

    return {
      priceSource: "REFRESHED_PRICE",
      quoteSource: provider,
      provider,
      priceSol: priceSolText,
      ...(priceUsd !== undefined ? { priceUsd: String(priceUsd) } : {}),
      tokensSold: candidate.position.tokensHeld,
      grossProceedsLamports,
      priceFetchedAtMs: priceFetchedAt.getTime(),
      fallbackUsed: true,
      fallbackReason: "Exact quote unavailable; used refreshed provider price.",
      warnings,
    };
  }

  private resolveCachedPrice(
    candidate: PaperSellCandidate,
    config: PaperSellRuntimeConfig,
    nowMs: number,
    warnings: string[],
  ): PaperSellQuoteResolution {
    if (!config.allowCachedRadarPrice) {
      return reject("MISSING_SELL_PRICE", "No fresh sell quote or refreshed price was available.", {
        warnings,
      });
    }

    const tokenRadar = candidate.tokenRadar;

    if (!tokenRadar) {
      return reject("MISSING_SELL_PRICE", "No TokenRadar row is available for cached fallback.", {
        warnings,
      });
    }

    const priceSol = tokenRadar.priceSol;

    if (!isPositiveDecimal(priceSol)) {
      return reject("MISSING_SELL_PRICE", "Cached TokenRadar price is missing or invalid.", {
        warnings,
      });
    }

    const cachedPriceAgeMs = nowMs - tokenRadar.updatedAtMs;

    if (cachedPriceAgeMs > config.maxCachedPriceAgeMs) {
      return reject("STALE_PRICE", "Cached TokenRadar price is stale.", {
        cachedPriceAgeMs,
        maxCachedPriceAgeMs: config.maxCachedPriceAgeMs,
        warnings,
      });
    }

    const grossProceedsLamports = calculateGrossProceedsLamports(
      candidate.position.tokensHeld,
      priceSol,
    );

    if (!grossProceedsLamports) {
      return reject("MISSING_SELL_PRICE", "Cached TokenRadar price produced unusable proceeds.", {
        warnings,
      });
    }

    return {
      ok: true,
      quote: {
        priceSource: "CACHED_RADAR_PRICE",
        quoteSource: tokenRadar.source,
        priceSol,
        ...(tokenRadar.priceUsd ? { priceUsd: tokenRadar.priceUsd } : {}),
        tokensSold: candidate.position.tokensHeld,
        grossProceedsLamports,
        cachedPriceAgeMs,
        fallbackUsed: true,
        fallbackReason: "Used explicitly allowed cached TokenRadar price.",
        warnings,
      },
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
        error instanceof Error ? error.message : "Unknown market data refresh failure.",
      );
      return undefined;
    }
  }
}

function buildQuoteContextFromQuote(input: {
  readonly sellQuote: QuoteResult;
  readonly tokensHeld: string;
  readonly tokenDecimals: number;
  readonly amountRaw: string;
  readonly priceUsd: number | undefined;
  readonly warnings: readonly string[];
}): PaperSellQuoteContext | undefined {
  const grossProceedsLamports = parseOutputLamports(input.sellQuote.outputAmountRaw);

  if (!grossProceedsLamports) {
    return undefined;
  }

  const priceSol = calculatePriceSolFromProceeds(grossProceedsLamports, input.tokensHeld);

  if (!priceSol) {
    return undefined;
  }

  return {
    priceSource: "QUOTE",
    quoteSource: input.sellQuote.source,
    provider: input.sellQuote.source,
    priceSol,
    ...(input.priceUsd !== undefined ? { priceUsd: String(input.priceUsd) } : {}),
    tokensSold: input.tokensHeld,
    grossProceedsLamports,
    ...(input.sellQuote.estimatedPriceImpactPct !== undefined
      ? { priceImpactBps: Math.round(input.sellQuote.estimatedPriceImpactPct * 100) }
      : {}),
    quoteFetchedAtMs: input.sellQuote.fetchedAt.getTime(),
    tokenDecimals: input.tokenDecimals,
    tokenAmountRaw: input.amountRaw,
    fallbackUsed: false,
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

function readTokenDecimalsFromRadar(candidate: PaperSellCandidate): number | undefined {
  const rawDataJson = candidate.tokenRadar?.rawDataJson;

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

function reject(
  code: PaperSellRejectionCode,
  message: string,
  context?: unknown,
): PaperSellQuoteResolution {
  return {
    ok: false,
    rejection: {
      code,
      message,
      ...(context === undefined ? {} : { context }),
    },
  };
}
