import {
  createProviderError,
  providerFailure,
  providerSuccess,
  type ProviderCapability,
  type ProviderResult,
  type ProviderSuccess,
  type QuoteRequest,
  type QuoteResult,
  type TokenMetadataSnapshot,
  type TokenMintAddress,
  type TokenPriceSnapshot,
} from "@nexustrade/shared";

import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { withProviderRetries } from "../http/providerRetry.js";
import type { PriceProvider, QuoteProvider, TokenMetadataProvider } from "../interfaces/index.js";
import type { ProviderHealthService } from "../ProviderHealthService.js";
import type { QuoteRequestContext } from "../quotes/QuotePriority.js";
import type {
  JupiterDemandController,
  JupiterDemandDecision,
  JupiterDemandRequest,
  JupiterDemandSnapshot,
} from "./JupiterDemandController.js";
import { mapJupiterPrice, mapJupiterPriceToMetadata, mapJupiterQuote } from "./jupiter.mappers.js";
import {
  jupiterPriceResponseSchema,
  jupiterQuoteResponseSchema,
  type JupiterPriceResponse,
} from "./jupiter.schemas.js";

export interface JupiterAdapterOptions {
  readonly priceHttpClient: ProviderHttpClient;
  readonly swapHttpClient: ProviderHttpClient;
  readonly healthService?: ProviderHealthService;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly allowRawPayloadLogging: boolean;
  readonly enableTokenMetadata?: boolean;
  readonly demandController?: JupiterDemandController;
}

export class JupiterAdapter implements PriceProvider, QuoteProvider, TokenMetadataProvider {
  readonly name = "JUPITER" as const;
  readonly capabilities: readonly ProviderCapability[];

  constructor(private readonly options: JupiterAdapterOptions) {
    this.capabilities = options.enableTokenMetadata
      ? ["PRICE", "QUOTE", "TOKEN_METADATA"]
      : ["PRICE", "QUOTE"];
  }

  async getPrice(mintAddress: TokenMintAddress): Promise<ProviderResult<TokenPriceSnapshot>> {
    const pricesResult = await this.getPrices([mintAddress]);

    if (!pricesResult.ok) {
      return pricesResult;
    }

    const price = pricesResult.data[0];

    if (!price) {
      return this.notFound<TokenPriceSnapshot>(mintAddress, pricesResult);
    }

    return providerSuccess({
      provider: this.name,
      data: price,
      fetchedAt: pricesResult.fetchedAt,
      latencyMs: pricesResult.latencyMs,
      warnings: pricesResult.warnings,
      ...(pricesResult.httpAttempts ? { httpAttempts: pricesResult.httpAttempts } : {}),
    });
  }

  async getPrices(
    mintAddresses: readonly TokenMintAddress[],
  ): Promise<ProviderResult<readonly TokenPriceSnapshot[]>> {
    return this.execute("price", { operation: "PRICE", priority: "LOW" }, async () => {
      const httpResult = await this.options.priceHttpClient.getJson<unknown>({
        operation: "price",
        endpointId: "JUPITER_PRICE",
        query: {
          ids: mintAddresses.join(","),
        },
        allowRawPayloadLogging: this.options.allowRawPayloadLogging,
      });

      if (!httpResult.ok) {
        return httpResult;
      }

      const parsed = jupiterPriceResponseSchema.safeParse(httpResult.data);

      if (!parsed.success) {
        return this.invalidResponse(httpResult, "Expected Jupiter price response object.");
      }

      return providerSuccess({
        provider: this.name,
        data: mintAddresses.flatMap((mintAddress) => {
          const entry = parsed.data[mintAddress];
          return entry ? [mapJupiterPrice(mintAddress, entry, httpResult.fetchedAt)] : [];
        }),
        fetchedAt: httpResult.fetchedAt,
        latencyMs: httpResult.latencyMs,
        warnings: httpResult.warnings,
        raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
        ...(httpResult.httpAttempts ? { httpAttempts: httpResult.httpAttempts } : {}),
      });
    });
  }

  async getTokenMetadata(
    mintAddress: TokenMintAddress,
  ): Promise<ProviderResult<TokenMetadataSnapshot>> {
    return this.execute(
      "token-metadata-from-price",
      { operation: "PRICE", priority: "LOW" },
      async () => {
        const priceResponse = await this.fetchPriceResponse([mintAddress]);

        if (!priceResponse.ok) {
          return priceResponse;
        }

        const entry = priceResponse.data[mintAddress];

        if (!entry) {
          return this.notFound<TokenMetadataSnapshot>(mintAddress, priceResponse);
        }

        return providerSuccess({
          provider: this.name,
          data: mapJupiterPriceToMetadata(mintAddress, entry, priceResponse.fetchedAt),
          fetchedAt: priceResponse.fetchedAt,
          latencyMs: priceResponse.latencyMs,
          warnings: [
            ...priceResponse.warnings,
            "Jupiter Price API supplies partial token metadata only.",
          ],
          raw: this.options.allowRawPayloadLogging ? priceResponse.raw : undefined,
          ...(priceResponse.httpAttempts ? { httpAttempts: priceResponse.httpAttempts } : {}),
        });
      },
    );
  }

  async getQuote(request: QuoteRequest): Promise<ProviderResult<QuoteResult>> {
    return this.getQuoteWithContext(request);
  }

  async getQuoteWithContext(
    request: QuoteRequest,
    context: QuoteRequestContext = {},
  ): Promise<ProviderResult<QuoteResult>> {
    return this.execute(
      "quote",
      {
        operation: "QUOTE",
        ...(context.priority ? { priority: context.priority } : {}),
      },
      async () => {
        const httpResult = await this.options.swapHttpClient.getJson<unknown>({
          path: "quote",
          operation: "quote",
          endpointId: "JUPITER_SWAP_QUOTE",
          query: {
            inputMint: request.inputMint,
            outputMint: request.outputMint,
            amount: request.amountRaw,
            slippageBps: request.slippageBps,
            onlyDirectRoutes: request.onlyDirectRoutes,
            maxAccounts: request.maxAccounts,
          },
          allowRawPayloadLogging: this.options.allowRawPayloadLogging,
        });

        if (!httpResult.ok) {
          return httpResult;
        }

        const parsed = jupiterQuoteResponseSchema.safeParse(httpResult.data);

        if (!parsed.success) {
          return this.invalidResponse(httpResult, "Expected Jupiter quote response object.");
        }

        try {
          return providerSuccess({
            provider: this.name,
            data: mapJupiterQuote(parsed.data, httpResult.fetchedAt),
            fetchedAt: httpResult.fetchedAt,
            latencyMs: httpResult.latencyMs,
            warnings: httpResult.warnings,
            raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
            ...(httpResult.httpAttempts ? { httpAttempts: httpResult.httpAttempts } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid Jupiter quote fields.";

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
            ...(httpResult.httpAttempts ? { httpAttempts: httpResult.httpAttempts } : {}),
          });
        }
      },
    );
  }

  private async fetchPriceResponse(
    mintAddresses: readonly TokenMintAddress[],
  ): Promise<ProviderResult<JupiterPriceResponse>> {
    const httpResult = await this.options.priceHttpClient.getJson<unknown>({
      operation: "price",
      endpointId: "JUPITER_PRICE",
      query: {
        ids: mintAddresses.join(","),
      },
      allowRawPayloadLogging: this.options.allowRawPayloadLogging,
    });

    if (!httpResult.ok) {
      return httpResult;
    }

    const parsed = jupiterPriceResponseSchema.safeParse(httpResult.data);

    if (!parsed.success) {
      return this.invalidResponse(httpResult, "Expected Jupiter price response object.");
    }

    return providerSuccess({
      provider: this.name,
      data: parsed.data,
      fetchedAt: httpResult.fetchedAt,
      latencyMs: httpResult.latencyMs,
      warnings: httpResult.warnings,
      raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
      ...(httpResult.httpAttempts ? { httpAttempts: httpResult.httpAttempts } : {}),
    });
  }

  private async execute<T>(
    operation: string,
    demandRequest: JupiterDemandRequest,
    request: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const result = this.options.demandController
      ? await this.executeWithDemand(demandRequest, request)
      : await withProviderRetries(request, {
          maxRetries: this.options.maxRetries,
          retryBackoffMs: this.options.retryBackoffMs,
        });

    // Router-owned quote health is written once by QuoteProviderRouter. Direct
    // price and metadata work still records its controller diagnostics here.
    if (operation !== "quote") {
      this.options.healthService?.recordResult(operation, result, result.diagnostics);
    }

    return result;
  }

  private async executeWithDemand<T>(
    demandRequest: JupiterDemandRequest,
    request: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const controller = this.options.demandController;
    if (!controller) {
      return request();
    }
    const decision = await controller.acquire(demandRequest);

    if (!decision.allowed) {
      return providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "PROVIDER_UNAVAILABLE",
          message: `Jupiter ${demandRequest.operation.toLowerCase()} deferred by local demand control (${decision.action}).`,
          retryable: false,
        }),
        warnings: ["Jupiter live request deferred by local demand control."],
        diagnostics: demandDiagnostics(decision),
      });
    }

    // The controller records each actual network result and deliberately suppresses
    // immediate local retries after a 429. Its adaptive interval is the retry policy.
    const result = await request();
    const retryAfterMs = lastRetryAfterMs(result);
    const snapshot = controller.recordLiveOutcome({
      rateLimited: result.rateLimited,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });

    return withDemandDiagnostics(result, decision, snapshot);
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
      ...(httpResult.httpAttempts ? { httpAttempts: httpResult.httpAttempts } : {}),
    });
  }

  private notFound<T>(
    mintAddress: TokenMintAddress,
    result: ProviderSuccess<readonly TokenPriceSnapshot[] | JupiterPriceResponse>,
  ): ProviderResult<T> {
    return providerFailure({
      provider: this.name,
      error: createProviderError({
        code: "NOT_FOUND",
        message: `Jupiter did not return data for ${mintAddress}.`,
        retryable: false,
      }),
      fetchedAt: result.fetchedAt,
      latencyMs: result.latencyMs,
      warnings: result.warnings,
      ...(result.httpAttempts ? { httpAttempts: result.httpAttempts } : {}),
    });
  }
}

function withDemandDiagnostics<T>(
  result: ProviderResult<T>,
  decision: JupiterDemandDecision,
  snapshot: JupiterDemandSnapshot,
): ProviderResult<T> {
  const diagnostics = {
    ...result.diagnostics,
    ...demandDiagnostics(decision),
    jupiterControllerRateLimitObserved: snapshot.liveRateLimitObserved,
    jupiterEffectiveIntervalMs: snapshot.effectiveIntervalMs,
    jupiterDemandEffectiveIntervalMs: snapshot.effectiveIntervalMs,
    jupiterAdaptiveLevel: snapshot.adaptiveLevel,
    ...(snapshot.retryAfterUntil ? { jupiterRetryAfterUntil: snapshot.retryAfterUntil } : {}),
    ...(snapshot.retryAfterMs !== undefined
      ? { jupiterDemandRetryAfterMs: snapshot.retryAfterMs }
      : {}),
  };

  return result.ok
    ? providerSuccess({ ...result, diagnostics })
    : providerFailure({ ...result, diagnostics });
}

function demandDiagnostics(decision: JupiterDemandDecision): Record<string, unknown> {
  return {
    jupiterDemandAction: decision.action,
    jupiterDemandOperation: decision.operation,
    jupiterDemandPriority: decision.priority,
    jupiterDemandAllowed: decision.allowed,
    jupiterDemandSavedLiveCall: !decision.allowed,
    ...(decision.allowed ? {} : { jupiterDemandDeferredReason: decision.action }),
    jupiterSharedWindowUsage: decision.windowUsage,
    jupiterSharedWindowLimit: decision.windowLimit,
    jupiterDemandWindowUsed: decision.windowUsage,
    jupiterDemandWindowLimit: decision.windowLimit,
    jupiterLowPriorityWindowUsage: decision.lowPriorityWindowUsage,
    jupiterLowPriorityWindowLimit: decision.lowPriorityWindowLimit,
    jupiterEffectiveIntervalMs: decision.effectiveIntervalMs,
    jupiterDemandEffectiveIntervalMs: decision.effectiveIntervalMs,
    jupiterAdaptiveLevel: decision.adaptiveLevel,
    ...(decision.retryAfterUntil ? { jupiterRetryAfterUntil: decision.retryAfterUntil } : {}),
    ...(decision.retryAfterMs !== undefined
      ? { jupiterDemandRetryAfterMs: decision.retryAfterMs }
      : {}),
  };
}

function lastRetryAfterMs(result: ProviderResult<unknown>): number | undefined {
  return result.httpAttempts?.[result.httpAttempts.length - 1]?.retryAfterMs;
}
