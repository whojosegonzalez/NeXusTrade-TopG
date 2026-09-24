import {
  createProviderError,
  providerFailure,
  providerSuccess,
  type ProviderCapability,
  type ProviderFailure,
  type ProviderResult,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
  type TokenPriceSnapshot,
} from "@nexustrade/shared";

import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { withProviderRetries } from "../http/providerRetry.js";
import type { PriceProvider, TokenMetadataProvider } from "../interfaces/index.js";
import type { ProviderHealthService } from "../ProviderHealthService.js";
import type { BirdeyeBudgetTracker } from "./BirdeyeBudgetTracker.js";
import type { BirdeyeCache } from "./BirdeyeCache.js";
import {
  mapBirdeyeOverviewToMetadata,
  mapBirdeyePrice,
  summarizeBirdeyeOverview,
  type BirdeyeOverviewContext,
} from "./birdeye.mappers.js";
import { birdeyeEnvelopeSchema, type BirdeyeEnvelope } from "./birdeye.schemas.js";

export type BirdeyeFailureCategory =
  | "NONE"
  | "BIRDEYE_NOT_CONFIGURED"
  | "BIRDEYE_RATE_LIMITED"
  | "BIRDEYE_CU_BUDGET_EXHAUSTED"
  | "BIRDEYE_UNAUTHORIZED"
  | "BIRDEYE_FORBIDDEN"
  | "BIRDEYE_BAD_REQUEST"
  | "BIRDEYE_UNAVAILABLE"
  | "BIRDEYE_TIMEOUT"
  | "BIRDEYE_INVALID_RESPONSE"
  | "BIRDEYE_ACCESS_DENIED_FOR_ENDPOINT"
  | "BIRDEYE_UNKNOWN";

export type BirdeyeCacheStatus = "HIT" | "MISS" | "BYPASS";

export interface BirdeyeAdapterOptions {
  readonly httpClient: ProviderHttpClient;
  readonly healthService?: ProviderHealthService;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly allowRawPayloadLogging: boolean;
  readonly priceEnabled: boolean;
  readonly tokenOverviewEnabled: boolean;
  readonly cacheEnabled: boolean;
  readonly overviewFrames: readonly string[];
  readonly budget: BirdeyeBudgetTracker;
  readonly cache: BirdeyeCache;
}

export interface BirdeyeTokenOverviewRequestOptions {
  readonly selectionReason?: string;
}

export class BirdeyeAdapter implements PriceProvider, TokenMetadataProvider {
  readonly name = "BIRDEYE" as const;
  readonly capabilities: readonly ProviderCapability[] = ["PRICE", "TOKEN_METADATA"];

  constructor(private readonly options: BirdeyeAdapterOptions) {}

  async getPrice(mintAddress: TokenMintAddress): Promise<ProviderResult<TokenPriceSnapshot>> {
    if (!this.options.priceEnabled) {
      return this.disabled<TokenPriceSnapshot>("price", "Birdeye price calls are disabled.", {
        birdeyeEndpoint: "/defi/price",
        birdeyeFailureCategory: "BIRDEYE_NOT_CONFIGURED",
      });
    }

    return this.fetchWithCache({
      operation: "price",
      path: "defi/price",
      query: {
        address: mintAddress,
      },
      cacheKey: `price:${mintAddress}`,
      cuCost: 3,
      selectionReason: "price-provider",
      map: (envelope, fetchedAt) => mapBirdeyePrice(mintAddress, envelope, fetchedAt),
    });
  }

  async getTokenMetadata(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<TokenMetadataSnapshot>> {
    const overview = await this.getTokenOverview(mintAddress, {
      selectionReason: "metadata-provider",
    });

    if (!overview.ok) {
      return overview;
    }

    if (!overview.rawEnvelope) {
      return providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "INVALID_RESPONSE",
          message: "Birdeye token overview did not retain a response envelope for metadata.",
          retryable: false,
        }),
        fetchedAt: overview.fetchedAt,
        latencyMs: overview.latencyMs,
        warnings: overview.warnings,
      });
    }

    try {
      return providerSuccess({
        provider: this.name,
        data: mapBirdeyeOverviewToMetadata(mintAddress, overview.rawEnvelope, overview.fetchedAt),
        fetchedAt: overview.fetchedAt,
        latencyMs: overview.latencyMs,
        warnings: overview.warnings,
      });
    } catch (error) {
      return providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "INVALID_RESPONSE",
          message: error instanceof Error ? error.message : "Invalid Birdeye overview metadata.",
          retryable: false,
        }),
        fetchedAt: overview.fetchedAt,
        latencyMs: overview.latencyMs,
        warnings: overview.warnings,
      });
    }
  }

  async getTokenOverview(
    mintAddress: TokenMintAddress,
    requestOptions: BirdeyeTokenOverviewRequestOptions = {},
  ): Promise<
    ProviderResult<BirdeyeOverviewContext> & {
      readonly rawEnvelope?: BirdeyeEnvelope;
    }
  > {
    if (!this.options.tokenOverviewEnabled) {
      return this.disabled<BirdeyeOverviewContext>(
        "token-overview",
        "Birdeye token overview calls are disabled.",
        {
          birdeyeEndpoint: "/defi/token_overview",
          birdeyeFailureCategory: "BIRDEYE_NOT_CONFIGURED",
          birdeyeSelectionReason: requestOptions.selectionReason ?? "unspecified",
        },
      );
    }

    return this.fetchWithCache({
      operation: "token-overview",
      path: "defi/token_overview",
      query: {
        address: mintAddress,
        frames: this.options.overviewFrames.join(","),
      },
      cacheKey: `token-overview:${mintAddress}:${this.options.overviewFrames.join("|")}`,
      cuCost: 20,
      selectionReason: requestOptions.selectionReason ?? "unspecified",
      map: (envelope) => summarizeBirdeyeOverview(envelope, this.options.overviewFrames),
    });
  }

  private async fetchWithCache<T>(input: {
    readonly operation: string;
    readonly path: string;
    readonly query: Readonly<Record<string, string>>;
    readonly cacheKey: string;
    readonly cuCost: number;
    readonly selectionReason: string;
    readonly map: (envelope: BirdeyeEnvelope, fetchedAt: Date) => T;
  }): Promise<ProviderResult<T> & { readonly rawEnvelope?: BirdeyeEnvelope }> {
    const baseContext = {
      birdeyeEndpoint: `/${input.path}`,
      birdeyeCuCost: input.cuCost,
      birdeyeSelectionReason: input.selectionReason,
      birdeyeFrames: this.options.overviewFrames.join(","),
    };
    const cacheStatus: BirdeyeCacheStatus = this.options.cacheEnabled ? "MISS" : "BYPASS";
    const cached = this.options.cacheEnabled
      ? this.options.cache.get<{
          readonly data: T;
          readonly rawEnvelope: BirdeyeEnvelope;
          readonly fetchedAt: Date;
        }>(input.cacheKey)
      : undefined;

    if (cached) {
      const result = providerSuccess({
        provider: this.name,
        data: cached.data,
        fetchedAt: cached.fetchedAt,
        latencyMs: 0,
        warnings: ["Birdeye cache hit."],
      });

      this.options.healthService?.recordResult(input.operation, result, {
        ...baseContext,
        birdeyeCacheStatus: "HIT",
        birdeyeFailureCategory: "NONE",
        ...budgetContext(this.options.budget.snapshot()),
      });

      return {
        ...result,
        rawEnvelope: cached.rawEnvelope,
      };
    }

    const reservation = this.options.budget.reserve(input.cuCost);

    if (!reservation.ok) {
      const result = providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "PROVIDER_UNAVAILABLE",
          message: `Birdeye ${reservation.reason ?? "budget"} prevented live request.`,
          retryable: false,
        }),
        warnings: ["Birdeye live request skipped by Phase 9.4 budget guardrail."],
      });

      this.options.healthService?.recordResult(input.operation, result, {
        ...baseContext,
        birdeyeCacheStatus: cacheStatus,
        birdeyeFailureCategory: "BIRDEYE_CU_BUDGET_EXHAUSTED",
        birdeyeBudgetReason: reservation.reason ?? "UNKNOWN",
        ...budgetContext(reservation.snapshot),
      });

      return result;
    }

    const result = await withProviderRetries(
      async () => {
        const httpResult = await this.options.httpClient.getJson<unknown>({
          path: input.path,
          query: input.query,
          allowRawPayloadLogging: this.options.allowRawPayloadLogging,
        });

        if (!httpResult.ok) {
          return httpResult;
        }

        const parsed = birdeyeEnvelopeSchema.safeParse(httpResult.data);

        if (!parsed.success || parsed.data.success === false) {
          return providerFailure({
            provider: this.name,
            error: createProviderError({
              code: "INVALID_RESPONSE",
              message: readEnvelopeMessage(parsed.success ? parsed.data : undefined),
              retryable: false,
            }),
            fetchedAt: httpResult.fetchedAt,
            latencyMs: httpResult.latencyMs,
            warnings: httpResult.warnings,
            raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
          });
        }

        try {
          return providerSuccess({
            provider: this.name,
            data: input.map(parsed.data, httpResult.fetchedAt),
            fetchedAt: httpResult.fetchedAt,
            latencyMs: httpResult.latencyMs,
            warnings: httpResult.warnings,
            raw: parsed.data,
          });
        } catch (error) {
          return providerFailure({
            provider: this.name,
            error: createProviderError({
              code: "INVALID_RESPONSE",
              message: error instanceof Error ? error.message : "Invalid Birdeye response fields.",
              retryable: false,
            }),
            fetchedAt: httpResult.fetchedAt,
            latencyMs: httpResult.latencyMs,
            warnings: httpResult.warnings,
            raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
          });
        }
      },
      {
        maxRetries: this.options.maxRetries,
        retryBackoffMs: this.options.retryBackoffMs,
      },
    );

    const rawEnvelope = result.ok ? (result.raw as BirdeyeEnvelope | undefined) : undefined;
    const healthContext = {
      ...baseContext,
      birdeyeCacheStatus: cacheStatus,
      birdeyeFailureCategory: result.ok ? "NONE" : classifyBirdeyeFailure(result),
      ...(result.ok
        ? {
            birdeyePriceAvailable:
              hasNumber(result.data, "price") || hasNumber(result.data, "priceUsd"),
            birdeyeLiquidityAvailable: hasNumber(result.data, "liquidity"),
            birdeyeVolumeAvailable: hasFrameMetric(result.data, "volumeUsd"),
            birdeyeTradeActivityAvailable: hasFrameMetric(result.data, "tradeCount"),
          }
        : {}),
      ...budgetContext(this.options.budget.snapshot()),
    };

    this.options.healthService?.recordResult(input.operation, result, healthContext);

    if (result.ok && rawEnvelope && this.options.cacheEnabled) {
      this.options.cache.set(input.cacheKey, {
        data: result.data,
        rawEnvelope,
        fetchedAt: result.fetchedAt,
      });
    }

    return result.ok && rawEnvelope
      ? {
          ...result,
          rawEnvelope,
        }
      : result;
  }

  private disabled<T>(
    operation: string,
    message: string,
    context: Readonly<Record<string, unknown>>,
  ): ProviderResult<T> {
    const result = providerFailure({
      provider: this.name,
      error: createProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message,
        retryable: false,
      }),
      warnings: [message],
    });

    this.options.healthService?.recordResult(operation, result, context);

    return result;
  }
}

function classifyBirdeyeFailure(result: ProviderFailure): BirdeyeFailureCategory {
  if (result.error.code === "RATE_LIMITED") {
    return "BIRDEYE_RATE_LIMITED";
  }

  if (result.error.code === "UNAUTHORIZED") {
    return result.error.statusCode === 403 ? "BIRDEYE_FORBIDDEN" : "BIRDEYE_UNAUTHORIZED";
  }

  if (result.error.code === "BAD_REQUEST") {
    return "BIRDEYE_BAD_REQUEST";
  }

  if (result.error.code === "PROVIDER_UNAVAILABLE") {
    return "BIRDEYE_UNAVAILABLE";
  }

  if (result.error.code === "TIMEOUT") {
    return "BIRDEYE_TIMEOUT";
  }

  if (result.error.code === "INVALID_RESPONSE") {
    return "BIRDEYE_INVALID_RESPONSE";
  }

  return "BIRDEYE_UNKNOWN";
}

function readEnvelopeMessage(envelope: BirdeyeEnvelope | undefined): string {
  return envelope?.message ?? envelope?.msg ?? "Expected successful Birdeye response envelope.";
}

function budgetContext(snapshot: {
  readonly requestsUsed: number;
  readonly cuUsed: number;
  readonly requestsRemaining: number;
  readonly cuRemaining: number;
}): Readonly<Record<string, number>> {
  return {
    birdeyeRequestsUsed: snapshot.requestsUsed,
    birdeyeCuUsed: snapshot.cuUsed,
    birdeyeRequestsRemaining: snapshot.requestsRemaining,
    birdeyeCuRemaining: snapshot.cuRemaining,
  };
}

function hasNumber(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = (value as Record<string, unknown>)[key];

  return typeof candidate === "number" && Number.isFinite(candidate);
}

function hasFrameMetric(value: unknown, metric: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const frames = (value as Record<string, unknown>).frames;

  if (!frames || typeof frames !== "object") {
    return false;
  }

  return Object.values(frames).some(
    (frame) =>
      frame !== null &&
      typeof frame === "object" &&
      typeof (frame as Record<string, unknown>)[metric] === "number",
  );
}
