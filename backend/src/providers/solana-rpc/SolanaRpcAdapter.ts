import {
  createProviderError,
  providerFailure,
  providerSuccess,
  type ProviderCapability,
  type ProviderResult,
  type RiskEvidenceSnapshot,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";

import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { withProviderRetries } from "../http/providerRetry.js";
import type { RiskEvidenceProvider, TokenMetadataProvider } from "../interfaces/index.js";
import type { ProviderHealthService } from "../ProviderHealthService.js";
import { mapSolanaRpcMintToMetadata, mapSolanaRpcMintToRiskEvidence } from "./solanaRpc.mappers.js";
import type { SolanaRpcMintAccountCache } from "./SolanaRpcMintAccountCache.js";
import {
  parseSolanaRpcMintAccountResponse,
  type ParsedMintAccountSnapshot,
  type SolanaRpcAuthorityParser,
  type SolanaRpcMintParseFailureCategory,
} from "./SolanaRpcMintAccountParser.js";

export interface SolanaRpcAdapterOptions {
  readonly httpClient: ProviderHttpClient;
  readonly healthService?: ProviderHealthService;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly allowRawPayloadLogging: boolean;
  readonly mintAccountCache?: SolanaRpcMintAccountCache;
  readonly mintAccountCacheEnabled: boolean;
  readonly useJsonParsed: boolean;
  readonly base64FallbackEnabled: boolean;
}

export class SolanaRpcAdapter implements TokenMetadataProvider, RiskEvidenceProvider {
  readonly name = "SOLANA_RPC" as const;
  readonly capabilities: readonly ProviderCapability[] = ["TOKEN_METADATA", "RISK_EVIDENCE"];

  constructor(private readonly options: SolanaRpcAdapterOptions) {}

  async getTokenMetadata(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<TokenMetadataSnapshot>> {
    const context = createRpcContext("TOKEN_METADATA");

    return this.execute(
      "get-account-info-metadata",
      async () => {
        const mintAccount = await this.getMintAccount(mintAddress, context);

        if (!mintAccount.ok) {
          return mintAccount;
        }

        return providerSuccess({
          provider: this.name,
          data: mapSolanaRpcMintToMetadata(mintAccount.data, mintAddress),
          fetchedAt: mintAccount.fetchedAt,
          latencyMs: mintAccount.latencyMs,
          warnings: mintAccount.warnings,
          raw: this.options.allowRawPayloadLogging ? mintAccount.raw : undefined,
        });
      },
      context,
    );
  }

  async getRiskEvidence(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<RiskEvidenceSnapshot>> {
    const context = createRpcContext("RISK_EVIDENCE");

    return this.execute(
      "get-account-info-risk-evidence",
      async () => {
        const mintAccount = await this.getMintAccount(mintAddress, context);

        if (!mintAccount.ok) {
          return mintAccount;
        }

        return providerSuccess({
          provider: this.name,
          data: mapSolanaRpcMintToRiskEvidence(mintAccount.data),
          fetchedAt: mintAccount.fetchedAt,
          latencyMs: mintAccount.latencyMs,
          warnings: [
            ...mintAccount.warnings,
            "Solana RPC authority fields are evidence only, not a risk-engine decision.",
          ],
          raw: this.options.allowRawPayloadLogging ? mintAccount.raw : undefined,
        });
      },
      context,
    );
  }

  private async getMintAccount(
    mintAddress: TokenMintAddress,
    context: Record<string, unknown>,
  ): Promise<ProviderResult<ParsedMintAccountSnapshot>> {
    if (this.options.mintAccountCacheEnabled) {
      const cached = this.options.mintAccountCache?.get(mintAddress);

      if (cached) {
        setMintAccountContext(context, cached.data, "HIT");

        return providerSuccess({
          ...cached,
          warnings: [...cached.warnings, "Solana RPC mint-account cache hit."],
          latencyMs: 0,
        });
      }
    }

    context.rpcCacheStatus = this.options.mintAccountCacheEnabled ? "MISS" : "BYPASS";

    const primaryParser: SolanaRpcAuthorityParser = this.options.useJsonParsed
      ? "JSON_PARSED"
      : "BASE64_LAYOUT";
    const primaryResult = await this.fetchAndParseMintAccount(mintAddress, primaryParser, context);

    if (primaryResult.ok) {
      this.cacheMintAccount(mintAddress, primaryResult);
      return primaryResult;
    }

    if (
      primaryParser === "JSON_PARSED" &&
      this.options.base64FallbackEnabled &&
      primaryResult.error.code === "INVALID_RESPONSE"
    ) {
      context.rpcJsonParsedFallback = true;
      const fallbackResult = await this.fetchAndParseMintAccount(
        mintAddress,
        "BASE64_LAYOUT",
        context,
      );

      if (fallbackResult.ok) {
        this.cacheMintAccount(mintAddress, fallbackResult);
      }

      return fallbackResult;
    }

    return primaryResult;
  }

  private async fetchAndParseMintAccount(
    mintAddress: TokenMintAddress,
    parser: SolanaRpcAuthorityParser,
    context: Record<string, unknown>,
  ): Promise<ProviderResult<ParsedMintAccountSnapshot>> {
    const rpcResult = await this.postRpc("getAccountInfo", [
      mintAddress,
      {
        commitment: "confirmed",
        encoding: parser === "JSON_PARSED" ? "jsonParsed" : "base64",
      },
    ]);

    if (!rpcResult.ok) {
      context.rpcFailureCategory = mapRpcFailureCategory(rpcResult.error.code);
      return rpcResult;
    }

    const parsed = parseSolanaRpcMintAccountResponse(
      rpcResult.data,
      mintAddress,
      rpcResult.fetchedAt,
      parser,
    );

    if (!parsed.ok) {
      context.rpcFailureCategory = parsed.category;

      return providerFailure({
        provider: this.name,
        error: createProviderError({
          code: parsed.category === "SOLANA_RPC_NOT_FOUND" ? "NOT_FOUND" : "INVALID_RESPONSE",
          message: parsed.message,
          retryable: false,
        }),
        fetchedAt: rpcResult.fetchedAt,
        latencyMs: rpcResult.latencyMs,
        raw: this.options.allowRawPayloadLogging ? rpcResult.raw : undefined,
      });
    }

    setMintAccountContext(context, parsed.data, context.rpcCacheStatus ?? "MISS");

    return providerSuccess({
      provider: this.name,
      data: parsed.data,
      fetchedAt: rpcResult.fetchedAt,
      latencyMs: rpcResult.latencyMs,
      warnings: parsed.data.warnings,
      raw: this.options.allowRawPayloadLogging ? rpcResult.raw : undefined,
    });
  }

  private postRpc(method: string, params: unknown): Promise<ProviderResult<unknown>> {
    return this.options.httpClient.postJson<unknown>({
      body: {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      },
      allowRawPayloadLogging: this.options.allowRawPayloadLogging,
    });
  }

  private cacheMintAccount(
    mintAddress: TokenMintAddress,
    result: ProviderResult<ParsedMintAccountSnapshot>,
  ): void {
    if (result.ok && this.options.mintAccountCacheEnabled) {
      this.options.mintAccountCache?.set(mintAddress, result);
    }
  }

  private async execute<T>(
    operation: string,
    request: () => Promise<ProviderResult<T>>,
    context: Record<string, unknown>,
  ): Promise<ProviderResult<T>> {
    const result = await withProviderRetries(request, {
      maxRetries: this.options.maxRetries,
      retryBackoffMs: this.options.retryBackoffMs,
    });

    this.options.healthService?.recordResult(operation, result, context);

    return result;
  }
}

function createRpcContext(
  evidenceType: "RISK_EVIDENCE" | "TOKEN_METADATA",
): Record<string, unknown> {
  return {
    authorityEvidenceType: evidenceType,
  };
}

function setMintAccountContext(
  context: Record<string, unknown>,
  snapshot: ParsedMintAccountSnapshot,
  cacheStatus: unknown,
): void {
  context.authorityEvidenceSource = snapshot.authorityEvidenceSource;
  context.authorityParser = snapshot.parser;
  context.mintAuthorityState = snapshot.mintAuthorityState;
  context.freezeAuthorityState = snapshot.freezeAuthorityState;
  context.tokenProgram = snapshot.tokenProgram;
  context.rpcSlot = snapshot.slot;
  context.rpcCacheStatus = cacheStatus;
  context.rpcFailureCategory = "NONE";
}

function mapRpcFailureCategory(errorCode: string): SolanaRpcMintParseFailureCategory | string {
  switch (errorCode) {
    case "RATE_LIMITED":
      return "SOLANA_RPC_RATE_LIMITED";
    case "TIMEOUT":
      return "SOLANA_RPC_TIMEOUT";
    case "NETWORK_ERROR":
    case "PROVIDER_UNAVAILABLE":
      return "SOLANA_RPC_UNAVAILABLE";
    case "NOT_FOUND":
      return "SOLANA_RPC_NOT_FOUND";
    default:
      return "SOLANA_RPC_INVALID_RESPONSE";
  }
}
