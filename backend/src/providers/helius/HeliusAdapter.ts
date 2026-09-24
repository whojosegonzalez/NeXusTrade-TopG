import {
  createProviderError,
  providerFailure,
  providerSuccess,
  type PriorityFeeEstimateSnapshot,
  type ProviderCapability,
  type ProviderFailure,
  type ProviderResult,
  type ProviderSuccess,
  type RiskEvidenceSnapshot,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";

import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { withProviderRetries } from "../http/providerRetry.js";
import type {
  PriorityFeeProvider,
  PriorityFeeRequest,
  RiskEvidenceProvider,
  TokenMetadataProvider,
} from "../interfaces/index.js";
import type { ProviderHealthService } from "../ProviderHealthService.js";
import type { HeliusBackoffPolicy } from "./HeliusBackoffPolicy.js";
import type { HeliusEvidenceCache, HeliusEvidenceCacheKind } from "./HeliusEvidenceCache.js";
import {
  mapHeliusAssetToMetadata,
  mapHeliusAssetToRiskEvidence,
  mapHeliusPriorityFeeEstimate,
} from "./helius.mappers.js";
import {
  heliusAssetSchema,
  heliusPriorityFeeResultSchema,
  heliusRpcResponseSchema,
  type HeliusAsset,
} from "./helius.schemas.js";

export interface HeliusAdapterOptions {
  readonly httpClient: ProviderHttpClient;
  readonly apiKey: string;
  readonly healthService?: ProviderHealthService;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly allowRawPayloadLogging: boolean;
  readonly evidenceCache?: HeliusEvidenceCache;
  readonly backoff?: HeliusBackoffPolicy;
  readonly metadataCacheEnabled: boolean;
  readonly riskEvidenceCacheEnabled: boolean;
  readonly skipLowPriorityDuringCooldown: boolean;
}

export class HeliusAdapter
  implements TokenMetadataProvider, RiskEvidenceProvider, PriorityFeeProvider
{
  readonly name = "HELIUS" as const;
  readonly capabilities: readonly ProviderCapability[] = [
    "TOKEN_METADATA",
    "RISK_EVIDENCE",
    "PRIORITY_FEE",
  ];

  constructor(private readonly options: HeliusAdapterOptions) {}

  async getTokenMetadata(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<TokenMetadataSnapshot>> {
    const context = createEvidenceContext("TOKEN_METADATA");

    return this.execute(
      "get-asset-metadata",
      async () => {
        const assetResult = await this.getAsset(
          mintAddress,
          "TOKEN_METADATA",
          this.options.metadataCacheEnabled,
          context,
        );

        if (!assetResult.ok) {
          return assetResult;
        }

        return providerSuccess({
          provider: this.name,
          data: mapHeliusAssetToMetadata(assetResult.data, mintAddress, assetResult.fetchedAt),
          fetchedAt: assetResult.fetchedAt,
          latencyMs: assetResult.latencyMs,
          warnings: assetResult.warnings,
          raw: this.options.allowRawPayloadLogging ? assetResult.raw : undefined,
        });
      },
      context,
      {
        maxRetries: 0,
      },
    );
  }

  async getRiskEvidence(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<RiskEvidenceSnapshot>> {
    const context = createEvidenceContext("RISK_EVIDENCE");

    return this.execute(
      "get-asset-risk-evidence",
      async () => {
        const assetResult = await this.getAsset(
          mintAddress,
          "RISK_EVIDENCE",
          this.options.riskEvidenceCacheEnabled,
          context,
        );

        if (!assetResult.ok) {
          return assetResult;
        }

        return providerSuccess({
          provider: this.name,
          data: mapHeliusAssetToRiskEvidence(assetResult.data, mintAddress, assetResult.fetchedAt),
          fetchedAt: assetResult.fetchedAt,
          latencyMs: assetResult.latencyMs,
          warnings: [
            ...assetResult.warnings,
            "Helius authority fields are evidence only, not a risk-engine decision.",
          ],
          raw: this.options.allowRawPayloadLogging ? assetResult.raw : undefined,
        });
      },
      context,
      {
        maxRetries: 0,
      },
    );
  }

  async getPriorityFeeEstimate(
    request: PriorityFeeRequest = {},
  ): Promise<ProviderResult<PriorityFeeEstimateSnapshot>> {
    return this.execute(
      "get-priority-fee-estimate",
      async () => {
        const rpcResult = await this.postRpc("getPriorityFeeEstimate", [
          {
            ...(request.accountKeys ? { accountKeys: request.accountKeys } : {}),
            options: {
              includeAllPriorityFeeLevels: true,
              recommended: true,
            },
          },
        ]);

        if (!rpcResult.ok) {
          return rpcResult;
        }

        const parsed = heliusPriorityFeeResultSchema.safeParse(rpcResult.data);

        if (!parsed.success) {
          return this.invalidResponse(
            rpcResult,
            "Expected Helius getPriorityFeeEstimate result object.",
          );
        }

        return providerSuccess({
          provider: this.name,
          data: mapHeliusPriorityFeeEstimate(parsed.data, rpcResult.fetchedAt),
          fetchedAt: rpcResult.fetchedAt,
          latencyMs: rpcResult.latencyMs,
          warnings: rpcResult.warnings,
          raw: this.options.allowRawPayloadLogging ? rpcResult.raw : undefined,
        });
      },
      {},
    );
  }

  private getAsset(
    mintAddress: TokenMintAddress,
    cacheKind: HeliusEvidenceCacheKind,
    cacheEnabled: boolean,
    context: Record<string, unknown>,
  ): Promise<ProviderResult<HeliusAsset>> {
    if (cacheEnabled) {
      const cached = this.options.evidenceCache?.get(cacheKind, mintAddress);

      if (cached) {
        context.heliusEvidenceSource = "CACHE";
        context.heliusCacheStatus = "HIT";

        return Promise.resolve(
          providerSuccess({
            ...cached,
            warnings: [...cached.warnings, "Helius evidence cache hit."],
            latencyMs: 0,
          }),
        );
      }
    }

    const backoffDecision = this.options.backoff?.getDecision("getAsset");

    if (backoffDecision?.active === true && this.options.skipLowPriorityDuringCooldown) {
      context.heliusEvidenceSource = "SKIPPED_COOLDOWN";
      context.heliusCacheStatus = cacheEnabled ? "MISS" : "BYPASS";
      context.heliusCooldownSkipped = true;
      context.heliusCooldownRemainingMs = backoffDecision.remainingMs;

      return Promise.resolve(
        providerFailure({
          provider: this.name,
          error: createProviderError({
            code: "RATE_LIMITED",
            message: `Helius getAsset is cooling down for ${backoffDecision.remainingMs}ms.`,
          }),
          rateLimited: true,
          warnings: ["Helius getAsset skipped during cooldown."],
        }),
      );
    }

    context.heliusEvidenceSource = "LIVE";
    context.heliusCacheStatus = cacheEnabled ? "MISS" : "BYPASS";

    return this.postRpc("getAsset", {
      id: mintAddress,
    }).then((rpcResult) => {
      if (!rpcResult.ok) {
        this.recordHeliusBackoff(rpcResult);
        return rpcResult;
      }

      const parsed = heliusAssetSchema.safeParse(rpcResult.data);

      if (!parsed.success) {
        return this.invalidResponse(rpcResult, "Expected Helius getAsset result object.");
      }

      const result = providerSuccess({
        provider: this.name,
        data: parsed.data,
        fetchedAt: rpcResult.fetchedAt,
        latencyMs: rpcResult.latencyMs,
        warnings: rpcResult.warnings,
        raw: this.options.allowRawPayloadLogging ? rpcResult.raw : undefined,
      });

      this.options.backoff?.recordSuccess("getAsset");

      if (cacheEnabled) {
        this.options.evidenceCache?.set(cacheKind, mintAddress, result);
      }

      return result;
    });
  }

  private async postRpc(method: string, params: unknown): Promise<ProviderResult<unknown>> {
    const httpResult = await this.options.httpClient.postJson<unknown>({
      query: {
        "api-key": this.options.apiKey,
      },
      body: {
        jsonrpc: "2.0",
        id: "1",
        method,
        params,
      },
      allowRawPayloadLogging: this.options.allowRawPayloadLogging,
    });

    if (!httpResult.ok) {
      return httpResult;
    }

    const parsed = heliusRpcResponseSchema.safeParse(httpResult.data);

    if (!parsed.success) {
      return this.invalidResponse(httpResult, "Expected Helius JSON-RPC response object.");
    }

    if (parsed.data.error) {
      return providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "BAD_REQUEST",
          message: parsed.data.error.message ?? "Helius JSON-RPC request failed.",
          retryable: false,
        }),
        fetchedAt: httpResult.fetchedAt,
        latencyMs: httpResult.latencyMs,
        warnings: httpResult.warnings,
      });
    }

    return providerSuccess({
      provider: this.name,
      data: parsed.data.result,
      fetchedAt: httpResult.fetchedAt,
      latencyMs: httpResult.latencyMs,
      warnings: httpResult.warnings,
      raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
    });
  }

  private async execute<T>(
    operation: string,
    request: () => Promise<ProviderResult<T>>,
    context: Readonly<Record<string, unknown>>,
    options: { readonly maxRetries?: number } = {},
  ): Promise<ProviderResult<T>> {
    const result = await withProviderRetries(request, {
      maxRetries: options.maxRetries ?? this.options.maxRetries,
      retryBackoffMs: this.options.retryBackoffMs,
    });

    this.options.healthService?.recordResult(operation, result, context);

    return result;
  }

  private recordHeliusBackoff(result: ProviderFailure): void {
    if (result.rateLimited) {
      this.options.backoff?.recordRateLimit("getAsset");
    }
  }

  private invalidResponse<T>(
    httpResult: ProviderSuccess<unknown>,
    message: string,
  ): ProviderResult<T> {
    return providerFailure({
      provider: this.name,
      error: createProviderError({
        code: "INVALID_RESPONSE",
        message,
        retryable: false,
      }),
      fetchedAt: httpResult.fetchedAt,
      latencyMs: httpResult.latencyMs,
      warnings: httpResult.warnings,
      raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
    });
  }
}

function createEvidenceContext(
  evidenceType: "TOKEN_METADATA" | "RISK_EVIDENCE",
): Record<string, unknown> {
  return {
    heliusEvidenceType: evidenceType,
    heliusEvidenceSource: "LIVE",
    heliusCacheStatus: "MISS",
  };
}
