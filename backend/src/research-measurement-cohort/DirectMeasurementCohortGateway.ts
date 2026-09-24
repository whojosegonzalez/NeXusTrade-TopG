import type { TokenMintAddress } from "@nexustrade/shared";

import { DexScreenerAdapter } from "../providers/dexscreener/DexScreenerAdapter.js";
import { ProviderHttpClient } from "../providers/http/ProviderHttpClient.js";
import type {
  MeasurementCohortGateway,
  MeasurementDiscoveryCandidate,
  MeasurementGatewayResult,
  MeasurementMarketContext,
} from "./MeasurementCohortTypes.js";

/**
 * Deliberately narrow: this contains the V3 protocol's sole direct capability.
 * It is constructed only after the fixed protocol and named launch record pass.
 */
export function createDirectMeasurementCohortGateway(): MeasurementCohortGateway {
  return new DirectMeasurementCohortGateway(
    new DexScreenerAdapter({
      httpClient: new ProviderHttpClient({
        provider: "DEXSCREENER",
        baseUrl: "https://api.dexscreener.com",
        timeoutMs: 10_000,
        rateLimitPerMinute: 1,
      }),
      maxRetries: 0,
      retryBackoffMs: 0,
      allowRawPayloadLogging: false,
    }),
  );
}

class DirectMeasurementCohortGateway implements MeasurementCohortGateway {
  constructor(private readonly dexScreener: DexScreenerAdapter) {}

  async discover(
    limit: 100,
  ): Promise<MeasurementGatewayResult<readonly MeasurementDiscoveryCandidate[]>> {
    const result = await this.dexScreener.discoverTokens(limit);
    if (!result.ok) return failure(result);
    return {
      ok: true,
      value: result.data.map((token) => ({
        mint: token.mintAddress,
        sourceKind: "DEXSCREENER_TOKEN_PROFILE",
        firstObservedAt: result.fetchedAt,
      })),
      observedAt: result.fetchedAt,
      outcomeCode: "OK",
      latencyMs: result.latencyMs,
    };
  }

  async marketContext(mint: string): Promise<MeasurementGatewayResult<MeasurementMarketContext>> {
    const result = await this.dexScreener.getBestPairForToken(mint as TokenMintAddress);
    if (!result.ok) return failure(result);
    const pair = result.data;
    return {
      ok: true,
      value: {
        observedAt: result.fetchedAt,
        ...(pair.baseMint === mint && finite(pair.priceUsd) ? { priceUsd: pair.priceUsd } : {}),
        ...(finite(pair.liquidityUsd) ? { liquidityUsd: pair.liquidityUsd } : {}),
      },
      observedAt: result.fetchedAt,
      outcomeCode: "OK",
      latencyMs: result.latencyMs,
    };
  }
}

function failure<
  T extends {
    readonly error: { readonly code: string };
    readonly fetchedAt: Date;
    readonly latencyMs: number;
  },
>(result: T): MeasurementGatewayResult<never> {
  return {
    ok: false,
    observedAt: result.fetchedAt,
    outcomeCode: result.error.code,
    latencyMs: result.latencyMs,
  };
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}
