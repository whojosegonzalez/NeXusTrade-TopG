import {
  createProviderError,
  providerFailure,
  providerSuccess,
  type ProviderCapability,
  type ProviderFailure,
  type ProviderResult,
  type ProviderSuccess,
  type QuoteRequest,
  type QuoteResult,
} from "@nexustrade/shared";

import type { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { withProviderRetries } from "../http/providerRetry.js";
import type { QuoteProvider } from "../interfaces/index.js";
import type { ProviderHealthService } from "../ProviderHealthService.js";
import {
  classifyRaydiumFailure,
  classifyRaydiumFailureDetail,
  sanitizeRaydiumMessage,
  type RaydiumQuoteFailureDetail,
  type RaydiumQuoteFailureCategory,
} from "./RaydiumErrorClassifier.js";
import { raydiumMintPriceKnown } from "./raydium.mintPrice.mappers.js";
import { raydiumMintPriceResponseSchema } from "./raydium.mintPrice.schemas.js";
import { mapRaydiumQuote } from "./raydium.mappers.js";
import {
  raydiumQuoteEnvelopeSchema,
  raydiumQuoteSuccessResponseSchema,
} from "./raydium.schemas.js";
import type {
  RaydiumPoolPreflightService,
  RaydiumPreflightResult,
} from "./RaydiumPoolPreflightService.js";

export interface RaydiumAdapterOptions {
  readonly httpClient: ProviderHttpClient;
  readonly apiV3HttpClient?: ProviderHttpClient;
  readonly poolPreflightService?: RaydiumPoolPreflightService;
  readonly healthService?: ProviderHealthService;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly allowRawPayloadLogging: boolean;
  readonly txVersion: "LEGACY" | "V0";
  readonly diagnosticsEnabled: boolean;
  readonly mintPriceDiagnosticsEnabled: boolean;
  readonly captureSanitizedErrorContext: boolean;
  readonly maxErrorMessageLength: number;
}

export class RaydiumAdapter implements QuoteProvider {
  readonly name = "RAYDIUM" as const;
  readonly capabilities: readonly ProviderCapability[] = ["QUOTE"];

  constructor(private readonly options: RaydiumAdapterOptions) {}

  async getQuote(request: QuoteRequest): Promise<ProviderResult<QuoteResult>> {
    const healthContext: Record<string, unknown> = this.createRequestContext(request);

    return this.execute(
      "quote",
      async () => {
        const unsupportedWarnings = buildUnsupportedRequestWarnings(request);
        const preflight = await this.runPreflight(request);
        this.applyPreflightContext(healthContext, preflight);

        if (preflight.status === "NO_POOL") {
          healthContext.raydiumFailureCategory = "NO_ROUTE";
          healthContext.raydiumFailureDetail = "NO_ROUTE";

          return providerFailure({
            provider: this.name,
            error: createProviderError({
              code: "NOT_FOUND",
              message: "Raydium pool preflight found no pools for the mint pair.",
              retryable: false,
            }),
            warnings: [
              ...unsupportedWarnings,
              "Raydium quote compute skipped because pool preflight found no pools.",
            ],
            diagnostics: pickRaydiumQuoteDiagnostics(healthContext),
          });
        }

        if (this.options.mintPriceDiagnosticsEnabled) {
          const mintPriceKnown = await this.checkMintPrice(request.outputMint);

          if (mintPriceKnown !== undefined) {
            healthContext.raydiumMintPriceKnown = mintPriceKnown;
          }
        }

        const httpResult = await this.options.httpClient.getJson<unknown>({
          path: "compute/swap-base-in",
          query: {
            inputMint: request.inputMint,
            outputMint: request.outputMint,
            amount: request.amountRaw,
            slippageBps: request.slippageBps ?? 100,
            txVersion: this.options.txVersion,
          },
          operation: "quote",
          endpointId: "RAYDIUM_COMPUTE_SWAP_BASE_IN",
          allowRawPayloadLogging: this.options.allowRawPayloadLogging,
        });

        if (!httpResult.ok) {
          this.applyFailureContext(healthContext, httpResult);
          return {
            ...httpResult,
            diagnostics: pickRaydiumQuoteDiagnostics(healthContext),
          };
        }

        const envelope = raydiumQuoteEnvelopeSchema.safeParse(httpResult.data);

        if (!envelope.success) {
          healthContext.raydiumFailureCategory = "SCHEMA_INVALID";
          return this.invalidResponse(
            httpResult,
            "Expected Raydium quote response envelope.",
            healthContext,
          );
        }

        if (!envelope.data.success) {
          const message = envelope.data.msg ?? readRaydiumMessage(envelope.data.data);
          const category = classifyRaydiumFailure({
            providerErrorCode: "PROVIDER_UNAVAILABLE",
            ...(message ? { message } : {}),
          });
          const detail = classifyRaydiumFailureDetail({
            providerErrorCode: "PROVIDER_UNAVAILABLE",
            ...(message ? { message } : {}),
          });
          this.applyRaydiumFailureContext(healthContext, category, detail, message, false);

          return providerFailure({
            provider: this.name,
            error: createProviderError({
              code: toProviderErrorCode(category),
              message: message || "Raydium quote response was not successful.",
              retryable: isRetryableRaydiumFailure(category),
            }),
            fetchedAt: httpResult.fetchedAt,
            latencyMs: httpResult.latencyMs,
            warnings: [...httpResult.warnings, ...unsupportedWarnings],
            raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
            ...(httpResult.httpAttempts ? { httpAttempts: httpResult.httpAttempts } : {}),
            diagnostics: pickRaydiumQuoteDiagnostics(healthContext),
          });
        }

        const parsed = raydiumQuoteSuccessResponseSchema.safeParse(httpResult.data);

        if (!parsed.success) {
          healthContext.raydiumFailureCategory = "SCHEMA_INVALID";
          return this.invalidResponse(
            httpResult,
            "Expected Raydium swap-base-in quote data.",
            healthContext,
          );
        }

        try {
          healthContext.raydiumFailureCategory = "NONE";
          healthContext.raydiumFailureDetail = "NONE";

          return providerSuccess({
            provider: this.name,
            data: mapRaydiumQuote(parsed.data, httpResult.fetchedAt),
            fetchedAt: httpResult.fetchedAt,
            latencyMs: httpResult.latencyMs,
            warnings: [...httpResult.warnings, ...unsupportedWarnings],
            raw: this.options.allowRawPayloadLogging ? httpResult.data : undefined,
            ...(httpResult.httpAttempts ? { httpAttempts: httpResult.httpAttempts } : {}),
            diagnostics: pickRaydiumQuoteDiagnostics(healthContext),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid Raydium quote fields.";
          this.applyRaydiumFailureContext(
            healthContext,
            "MAPPER_ERROR",
            "MAPPER_ERROR",
            message,
            true,
          );

          return providerFailure({
            provider: this.name,
            error: createProviderError({
              code: "INVALID_RESPONSE",
              message,
              retryable: false,
            }),
            fetchedAt: httpResult.fetchedAt,
            latencyMs: httpResult.latencyMs,
            warnings: [...httpResult.warnings, ...unsupportedWarnings],
            ...(httpResult.httpAttempts ? { httpAttempts: httpResult.httpAttempts } : {}),
            diagnostics: pickRaydiumQuoteDiagnostics(healthContext),
          });
        }
      },
      healthContext,
    );
  }

  diagnosePreflight(request: QuoteRequest): Promise<RaydiumPreflightResult> {
    return this.runPreflight(request);
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

  private invalidResponse<T>(
    httpResult: ProviderSuccess<unknown>,
    message: string,
    context: Record<string, unknown>,
  ): ProviderResult<T> {
    this.applyRaydiumFailureContext(context, "SCHEMA_INVALID", "SCHEMA_INVALID", message, true);

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
      diagnostics: pickRaydiumQuoteDiagnostics(context),
    });
  }

  private createRequestContext(request: QuoteRequest): Record<string, unknown> {
    return {
      raydiumDiagnosticsEnabled: this.options.diagnosticsEnabled,
      requestInputMint: request.inputMint,
      requestOutputMint: request.outputMint,
      requestAmountRawLength: request.amountRaw.length,
      requestAmountMagnitudeBucket: amountMagnitudeBucket(request.amountRaw),
      slippageBps: request.slippageBps ?? 100,
      txVersion: this.options.txVersion,
    };
  }

  private async runPreflight(request: QuoteRequest): Promise<RaydiumPreflightResult> {
    if (!this.options.poolPreflightService) {
      return {
        status: "DISABLED",
        poolsFound: 0,
        productTypes: [],
        cacheStatus: "BYPASS",
      };
    }

    return this.options.poolPreflightService.check({
      inputMint: request.inputMint,
      outputMint: request.outputMint,
    });
  }

  private applyPreflightContext(
    context: Record<string, unknown>,
    preflight: RaydiumPreflightResult,
  ): void {
    context.raydiumPreflightStatus = preflight.status;
    context.raydiumPreflightCacheStatus = preflight.cacheStatus;
    context.raydiumPreflightPoolType = preflight.poolType;
    context.raydiumPreflightSortField = preflight.sortField;
    context.raydiumPreflightSortType = preflight.sortType;
    context.raydiumPreflightPageSize = preflight.pageSize;
    context.raydiumPreflightPage = preflight.page;
    context.raydiumPoolsFound = preflight.poolsFound;

    if (preflight.failureDetail) {
      context.raydiumPreflightFailureDetail = preflight.failureDetail;
    }

    if (preflight.productTypes.length > 0) {
      context.raydiumPoolProductTypes = preflight.productTypes.join("|");
    }

    if (preflight.message) {
      context.raydiumPreflightMessage = sanitizeRaydiumMessage(
        preflight.message,
        this.options.maxErrorMessageLength,
      );
    }
  }

  private async checkMintPrice(mintAddress: string): Promise<boolean | undefined> {
    if (!this.options.apiV3HttpClient) {
      return undefined;
    }

    const result = await this.options.apiV3HttpClient.getJson<unknown>({
      path: "mint/price",
      query: {
        mints: mintAddress,
      },
      operation: "mint_price",
      endpointId: "RAYDIUM_MINT_PRICE",
      allowRawPayloadLogging: this.options.allowRawPayloadLogging,
    });

    if (!result.ok) {
      return undefined;
    }

    const parsed = raydiumMintPriceResponseSchema.safeParse(result.data);

    return parsed.success ? raydiumMintPriceKnown(parsed.data, mintAddress) : undefined;
  }

  private applyFailureContext(context: Record<string, unknown>, result: ProviderFailure): void {
    const category = classifyRaydiumFailure({
      providerErrorCode: result.error.code,
      message: result.error.message,
      ...(result.error.statusCode !== undefined ? { statusCode: result.error.statusCode } : {}),
    });
    const detail = classifyRaydiumFailureDetail({
      providerErrorCode: result.error.code,
      message: result.error.message,
      ...(result.error.statusCode !== undefined ? { statusCode: result.error.statusCode } : {}),
    });

    this.applyRaydiumFailureContext(
      context,
      category,
      detail,
      result.error.message,
      result.error.code === "INVALID_RESPONSE",
    );

    if (result.error.statusCode !== undefined) {
      context.httpStatus = result.error.statusCode;
    }
  }

  private applyRaydiumFailureContext(
    context: Record<string, unknown>,
    category: RaydiumQuoteFailureCategory,
    detail: RaydiumQuoteFailureDetail,
    message: string | undefined,
    schemaInvalid: boolean,
  ): void {
    context.raydiumFailureCategory = category;
    context.raydiumFailureDetail = detail;
    context.raydiumSuccess = false;

    if (schemaInvalid) {
      context.raydiumSchemaInvalid = true;
    }

    if (this.options.captureSanitizedErrorContext && message) {
      context.raydiumMessage = sanitizeRaydiumMessage(message, this.options.maxErrorMessageLength);
    }
  }
}

function buildUnsupportedRequestWarnings(request: QuoteRequest): readonly string[] {
  const warnings: string[] = [];

  if (request.onlyDirectRoutes !== undefined) {
    warnings.push("Raydium quote adapter ignores onlyDirectRoutes in Phase 9.3.");
  }

  if (request.maxAccounts !== undefined) {
    warnings.push("Raydium quote adapter ignores maxAccounts in Phase 9.3.");
  }

  return warnings;
}

function readRaydiumMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.msg === "string") {
    return record.msg;
  }

  if (typeof record.message === "string") {
    return record.message;
  }

  return undefined;
}

function amountMagnitudeBucket(amountRaw: string): string {
  const length = amountRaw.replace(/^0+/, "").length;

  if (length <= 6) {
    return "SMALL";
  }

  if (length <= 9) {
    return "MEDIUM";
  }

  if (length <= 12) {
    return "LARGE";
  }

  return "VERY_LARGE";
}

function toProviderErrorCode(
  category: RaydiumQuoteFailureCategory,
): ProviderFailure["error"]["code"] {
  switch (category) {
    case "BAD_AMOUNT":
    case "BAD_REQUEST":
      return "BAD_REQUEST";
    case "NO_ROUTE":
    case "UNSUPPORTED_MINT":
    case "UNSUPPORTED_TOKEN_PROGRAM":
      return "NOT_FOUND";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "SCHEMA_INVALID":
    case "MAPPER_ERROR":
    case "RESPONSE_NOT_SUCCESSFUL":
      return "INVALID_RESPONSE";
    case "TIMEOUT":
      return "TIMEOUT";
    case "HTTP_ERROR":
    case "RAYDIUM_UNAVAILABLE":
    case "UNKNOWN":
      return "PROVIDER_UNAVAILABLE";
  }
}

function isRetryableRaydiumFailure(category: RaydiumQuoteFailureCategory): boolean {
  return (
    category === "RATE_LIMITED" ||
    category === "RAYDIUM_UNAVAILABLE" ||
    category === "TIMEOUT" ||
    category === "UNKNOWN"
  );
}

function pickRaydiumQuoteDiagnostics(
  context: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(context).filter(([key]) => key.startsWith("raydium")));
}
