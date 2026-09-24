import {
  createProviderError,
  providerFailure,
  providerSuccess,
  type ProviderCapability,
  type ProviderName,
  type ProviderResult,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";

import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { withProviderRetries } from "../http/providerRetry.js";
import type { TokenMetadataProvider } from "../interfaces/index.js";
import type { ProviderHealthService } from "../ProviderHealthService.js";
import { dasAssetSchema, dasRpcResponseSchema } from "./das.schemas.js";
import { mapDasAssetToMetadata } from "./das.mappers.js";

export type DasProviderName = Extract<ProviderName, "ALCHEMY_DAS" | "QUICKNODE_DAS">;

export interface DasMetadataAdapterOptions {
  readonly providerName: DasProviderName;
  readonly httpClient: ProviderHttpClient;
  readonly healthService?: ProviderHealthService;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly allowRawPayloadLogging: boolean;
  readonly metadataEnabled: boolean;
}

export class DasMetadataAdapter implements TokenMetadataProvider {
  readonly capabilities: readonly ProviderCapability[] = ["TOKEN_METADATA"];

  constructor(private readonly options: DasMetadataAdapterOptions) {}

  get name(): DasProviderName {
    return this.options.providerName;
  }

  async getTokenMetadata(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<TokenMetadataSnapshot>> {
    const context = createDasContext(this.name);

    return this.execute(
      "get-asset-metadata",
      async () => {
        if (!this.options.metadataEnabled) {
          return providerFailure({
            provider: this.name,
            error: createProviderError({
              code: "PROVIDER_UNAVAILABLE",
              message: `${this.name} metadata is disabled by configuration.`,
              retryable: false,
            }),
            warnings: [`${this.name} metadata disabled.`],
          });
        }

        const rpcResult = await this.postRpc("getAsset", {
          id: mintAddress,
          options: {
            showFungible: true,
          },
        });

        if (!rpcResult.ok) {
          context.dasFailureCategory = rpcResult.error.code;
          return rpcResult;
        }

        const parsed = dasAssetSchema.safeParse(rpcResult.data);

        if (!parsed.success) {
          context.dasFailureCategory = "INVALID_ASSET";

          return providerFailure({
            provider: this.name,
            error: createProviderError({
              code: "INVALID_RESPONSE",
              message: `Expected ${this.name} getAsset result object.`,
              retryable: false,
            }),
            fetchedAt: rpcResult.fetchedAt,
            latencyMs: rpcResult.latencyMs,
            warnings: rpcResult.warnings,
            raw: this.options.allowRawPayloadLogging ? rpcResult.raw : undefined,
          });
        }

        context.dasFailureCategory = "NONE";

        return providerSuccess({
          provider: this.name,
          data: mapDasAssetToMetadata(parsed.data, mintAddress, this.name, rpcResult.fetchedAt),
          fetchedAt: rpcResult.fetchedAt,
          latencyMs: rpcResult.latencyMs,
          warnings: [
            ...rpcResult.warnings,
            `${this.name} metadata is supplementary metadata evidence only.`,
          ],
          raw: this.options.allowRawPayloadLogging ? rpcResult.raw : undefined,
        });
      },
      context,
    );
  }

  private async postRpc(method: string, params: unknown): Promise<ProviderResult<unknown>> {
    const httpResult = await this.options.httpClient.postJson<unknown>({
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

    const parsed = dasRpcResponseSchema.safeParse(httpResult.data);

    if (!parsed.success) {
      return providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "INVALID_RESPONSE",
          message: `Expected ${this.name} JSON-RPC response object.`,
          retryable: false,
        }),
        fetchedAt: httpResult.fetchedAt,
        latencyMs: httpResult.latencyMs,
        warnings: httpResult.warnings,
        raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
      });
    }

    if (parsed.data.error) {
      return providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "BAD_REQUEST",
          message: parsed.data.error.message ?? `${this.name} JSON-RPC request failed.`,
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
  ): Promise<ProviderResult<T>> {
    const result = await withProviderRetries(request, {
      maxRetries: this.options.maxRetries,
      retryBackoffMs: this.options.retryBackoffMs,
    });

    this.options.healthService?.recordResult(operation, result, context);

    return result;
  }
}

function createDasContext(providerName: DasProviderName): Record<string, unknown> {
  return {
    dasProvider: providerName,
    dasEvidenceType: "TOKEN_METADATA",
    dasEvidenceSource: "LIVE",
    authorityEvidenceSource: providerName,
  };
}
