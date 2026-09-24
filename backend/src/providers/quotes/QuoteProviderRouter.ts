import {
  createProviderError,
  providerFailure,
  providerSuccess,
  type ProviderFailure,
  type ProviderName,
  type ProviderResult,
  type ProviderSuccess,
  type QuoteFallbackReason,
  type QuoteRequest,
  type QuoteResult,
  type QuoteSourceType,
} from "@nexustrade/shared";

import type { QuoteProvider } from "../interfaces/index.js";
import type { ProviderHealthService } from "../ProviderHealthService.js";
import type { RaydiumNegativeCache } from "../raydium/RaydiumNegativeCache.js";
import type { RaydiumVenueGuard } from "../raydium/RaydiumVenueGuard.js";
import type { QuoteAttemptJournal, QuoteAttemptJournalSnapshot } from "./QuoteAttemptJournal.js";
import type { QuoteBackoffPolicy } from "./QuoteBackoffPolicy.js";
import type { QuoteCache } from "./QuoteCache.js";
import type { QuoteNegativeCache } from "./QuoteNegativeCache.js";
import {
  canSkipDuringCooldown,
  normalizeQuotePriority,
  type QuoteRequestContext,
} from "./QuotePriority.js";
import type { QuoteScheduler } from "./QuoteScheduler.js";
import type { QuoteSingleFlight } from "./QuoteSingleFlight.js";

type QuoteDemandAction =
  | "SUCCESS_CACHE_HIT"
  | "NEGATIVE_CACHE_HIT"
  | "COOLDOWN_SKIP"
  | "VENUE_GUARD_SKIP"
  | "SINGLE_FLIGHT_JOIN"
  | "SCHEDULED_LIVE_CALL"
  | "LIVE_CALL"
  | "JUPITER_DEMAND_DEFERRED";

export interface QuoteProviderRouterOptions {
  readonly providers: readonly QuoteProvider[];
  readonly cache: QuoteCache;
  readonly negativeCache: QuoteNegativeCache;
  readonly raydiumNegativeCache: RaydiumNegativeCache;
  readonly backoff: QuoteBackoffPolicy;
  readonly scheduler: QuoteScheduler;
  readonly singleFlight: QuoteSingleFlight;
  readonly raydiumVenueGuard: RaydiumVenueGuard;
  readonly attemptJournal?: QuoteAttemptJournal;
  readonly healthService?: ProviderHealthService;
  readonly skipLowPriorityDuringCooldown: boolean;
}

/** Applies process-local demand controls before issuing a live provider quote. */
export class QuoteProviderRouter implements QuoteProvider {
  readonly name: ProviderName;
  readonly capabilities = ["QUOTE"] as const;

  constructor(private readonly options: QuoteProviderRouterOptions) {
    this.name = options.providers[0]?.name ?? "MOCK";
  }

  getQuote(request: QuoteRequest): Promise<ProviderResult<QuoteResult>> {
    return this.getQuoteWithContext(request);
  }

  getDiagnosticSnapshot(request: QuoteRequest): QuoteAttemptJournalSnapshot | undefined {
    return this.options.attemptJournal?.getSnapshot(request);
  }

  async getQuoteWithContext(
    request: QuoteRequest,
    context: QuoteRequestContext = {},
  ): Promise<ProviderResult<QuoteResult>> {
    const priority = normalizeQuotePriority(context.priority);
    const attemptedProviders: ProviderName[] = [];
    const providerOrder = this.options.providers.map((candidate) => candidate.name);
    let fallbackReason: QuoteFallbackReason = "NONE";
    let lastFailure: ProviderFailure | undefined;

    for (const provider of this.options.providers) {
      const successCache = this.options.cache.get(provider.name, request);
      if (successCache.status === "HIT" && successCache.entry) {
        const fallbackUsed = attemptedProviders.length > 0;
        const result = withDiagnostics(
          providerSuccess({
            ...successCache.entry.result,
            data: withQuoteProvenance(successCache.entry.result.data, {
              quoteProvider: provider.name,
              quoteSourceType: "CACHE",
              fallbackReason,
              attemptedProviders,
              providerOrder,
            }),
            warnings: [
              ...successCache.entry.result.warnings,
              `Quote cache hit (${successCache.cacheAgeMs ?? 0}ms old).`,
            ],
            latencyMs: 0,
          }),
          { quoteDemandAction: "SUCCESS_CACHE_HIT" },
        );
        this.options.attemptJournal?.recordLatestAttempt({
          request,
          provider: provider.name,
          sourceType: "CACHE",
          outcome: "SUCCESS",
          fallbackReason,
        });
        this.recordRouterResult(
          "quote",
          result,
          this.buildContext({
            context,
            priority,
            provider: provider.name,
            source: "CACHE",
            sourceType: "CACHE",
            fallbackReason,
            providerOrder,
            attemptedProviders,
            action: "SUCCESS_CACHE_HIT",
            request,
            details: {
              quoteCacheStatus: "HIT",
              quoteCacheAgeMs: successCache.cacheAgeMs,
              quoteCacheTtlMs: successCache.cacheTtlMs,
              quoteFallbackAttempted: fallbackUsed,
              quoteFallbackUsed: fallbackUsed,
            },
          }),
        );
        return result;
      }

      const negativeCache = this.negativeCacheFor(provider.name);
      const negativeLookup = negativeCache.get(provider.name, request);
      if (negativeLookup.status === "HIT" && negativeLookup.entry) {
        const cached = negativeLookup.entry.result;
        const result = withDiagnostics(
          providerFailure({
            provider: provider.name,
            error: cached.error,
            warnings: [
              ...cached.warnings,
              `Negative quote cache hit (${negativeLookup.ageMs ?? 0}ms old).`,
            ],
            fetchedAt: cached.fetchedAt,
            latencyMs: 0,
            ...(cached.diagnostics ? { diagnostics: cached.diagnostics } : {}),
          }),
          {
            quoteDemandAction: "NEGATIVE_CACHE_HIT",
            quoteNegativeCacheReason: negativeLookup.entry.reason,
          },
        );
        lastFailure = result;
        fallbackReason = resolveFailureFallbackReason(provider.name, result, fallbackReason);
        this.options.attemptJournal?.recordLatestAttempt({
          request,
          provider: provider.name,
          sourceType: "NONE",
          outcome: "FAILURE",
          fallbackReason,
          failureCode: result.error.code,
        });
        this.recordRouterResult(
          "quote",
          result,
          this.buildContext({
            context,
            priority,
            provider: provider.name,
            source: "UNAVAILABLE",
            sourceType: "NONE",
            fallbackReason,
            providerOrder,
            attemptedProviders,
            action: "NEGATIVE_CACHE_HIT",
            request,
            details: {
              quoteCacheStatus: successCache.status,
              quoteNegativeCacheStatus: "HIT",
              quoteNegativeCacheReason: negativeLookup.entry.reason,
              quoteNegativeCacheAgeMs: negativeLookup.ageMs,
              quoteNegativeCacheTtlMs: negativeLookup.ttlMs,
              quoteDemandSavedLiveCall: true,
            },
          }),
        );
        continue;
      }

      const backoffDecision = this.options.backoff.getDecision(provider.name, "quote");
      const shouldSkipCooldown =
        backoffDecision.active &&
        (canSkipDuringCooldown(priority) ? this.options.skipLowPriorityDuringCooldown : true);
      if (shouldSkipCooldown) {
        const result = withDiagnostics(
          providerFailure({
            provider: provider.name,
            error: createProviderError({
              code: "RATE_LIMITED",
              message: `${provider.name} quote is cooling down for ${backoffDecision.remainingMs}ms.`,
            }),
            warnings: [`Quote skipped during ${provider.name} cooldown.`],
            rateLimited: true,
          }),
          { quoteDemandAction: "COOLDOWN_SKIP" },
        );
        lastFailure = result;
        fallbackReason = resolveCooldownFallbackReason(provider.name, fallbackReason);
        this.options.attemptJournal?.recordLatestAttempt({
          request,
          provider: provider.name,
          sourceType: "NONE",
          outcome: "COOLDOWN_SKIP",
          fallbackReason,
          failureCode: result.error.code,
        });
        this.recordRouterResult(
          "quote",
          result,
          this.buildContext({
            context,
            priority,
            provider: provider.name,
            source: "SKIPPED_COOLDOWN",
            sourceType: "NONE",
            fallbackReason,
            providerOrder,
            attemptedProviders,
            action: "COOLDOWN_SKIP",
            request,
            details: {
              quoteCacheStatus: successCache.status,
              quoteNegativeCacheStatus: negativeLookup.status,
              quoteBackoffActive: true,
              quoteCooldownRemainingMs: backoffDecision.remainingMs,
              quoteDemandSavedLiveCall: true,
            },
          }),
        );
        continue;
      }

      let raydiumVenueDetails: Record<string, unknown> = {};
      if (provider.name === "RAYDIUM") {
        const venue = this.options.raydiumVenueGuard.evaluate(
          context.raydiumObservedDexIds ? { observedDexIds: context.raydiumObservedDexIds } : {},
        );
        raydiumVenueDetails = {
          raydiumVenueGuardDecision: venue.decision,
          raydiumVenueGuardReason: venue.reason,
          raydiumVenueGuardObservedVenues: venue.observedVenues.join("|"),
          ...(venue.matchedVenue ? { raydiumVenueGuardMatchedVenue: venue.matchedVenue } : {}),
        };
        if (venue.decision === "SKIP_NO_RAYDIUM_VENUE") {
          const result = withDiagnostics(
            providerFailure({
              provider: "RAYDIUM",
              error: createProviderError({
                code: "NOT_FOUND",
                message:
                  "Raydium quote skipped because observed DexScreener venues are incompatible.",
                retryable: false,
              }),
              warnings: ["Raydium quote compute skipped by venue guard."],
              diagnostics: {
                raydiumFailureCategory: "NO_ROUTE",
                raydiumFailureDetail: "VENUE_GUARD_SKIP",
              },
            }),
            { quoteDemandAction: "VENUE_GUARD_SKIP" },
          );
          lastFailure = result;
          this.options.attemptJournal?.recordLatestAttempt({
            request,
            provider: "RAYDIUM",
            sourceType: "NONE",
            outcome: "FAILURE",
            fallbackReason,
            failureCode: result.error.code,
            raydiumFailureCategory: "NO_ROUTE",
            raydiumFailureDetail: "VENUE_GUARD_SKIP",
          });
          this.recordRouterResult(
            "quote",
            result,
            this.buildContext({
              context,
              priority,
              provider: "RAYDIUM",
              source: "UNAVAILABLE",
              sourceType: "NONE",
              fallbackReason,
              providerOrder,
              attemptedProviders,
              action: "VENUE_GUARD_SKIP",
              request,
              details: {
                quoteCacheStatus: successCache.status,
                quoteNegativeCacheStatus: negativeLookup.status,
                quoteDemandSavedLiveCall: true,
                raydiumVenueGuardDecision: venue.decision,
                raydiumVenueGuardReason: venue.reason,
                raydiumVenueGuardObservedVenues: venue.observedVenues.join("|"),
              },
            }),
          );
          continue;
        }
      }

      attemptedProviders.push(provider.name);
      const flight = await this.options.singleFlight.run(provider.name, request, async () =>
        this.options.scheduler.schedule(provider.name, "quote", () =>
          requestQuoteFromProvider(provider, request, context),
        ),
      );
      const scheduled = flight.value;
      const providerResult = scheduled.value;
      const action: QuoteDemandAction = isJupiterDemandDeferred(providerResult)
        ? "JUPITER_DEMAND_DEFERRED"
        : flight.joined
          ? "SINGLE_FLIGHT_JOIN"
          : scheduled.waitMs > 0
            ? "SCHEDULED_LIVE_CALL"
            : "LIVE_CALL";

      if (providerResult.ok) {
        this.options.backoff.recordSuccess(provider.name, "quote");
        const result = withDiagnostics(
          providerSuccess({
            ...providerResult,
            data: withQuoteProvenance(providerResult.data, {
              quoteProvider: provider.name,
              quoteSourceType: "LIVE",
              fallbackReason,
              attemptedProviders,
              providerOrder,
            }),
          }),
          {
            quoteDemandAction: action,
            quoteSchedulerWaitMs: scheduled.waitMs,
            quoteSingleFlightJoined: flight.joined,
            quoteSingleFlightWaiters: flight.waiters,
          },
        );
        this.options.attemptJournal?.recordLatestAttempt({
          request,
          provider: provider.name,
          sourceType: "LIVE",
          outcome: "SUCCESS",
          fallbackReason,
          ...(result.httpAttempts ? { httpAttemptCount: result.httpAttempts.length } : {}),
          ...definedNumber("lastHttpStatus", lastHttpStatus(result)),
        });
        this.options.attemptJournal?.recordLastSuccessfulQuote({
          request,
          provider: provider.name,
          sourceType: "LIVE",
          outputAmountRaw: result.data.outputAmountRaw,
          ...(result.data.estimatedPriceImpactPct !== undefined
            ? { estimatedPriceImpactPct: result.data.estimatedPriceImpactPct }
            : {}),
          fallbackReason,
        });
        this.options.cache.set(provider.name, request, result);
        this.recordRouterResult(
          "quote",
          result,
          this.buildContext({
            context,
            priority,
            provider: provider.name,
            source: "LIVE",
            sourceType: "LIVE",
            fallbackReason,
            providerOrder,
            attemptedProviders,
            action,
            request,
            details: {
              quoteCacheStatus: successCache.status,
              quoteNegativeCacheStatus: negativeLookup.status,
              quoteSchedulerWaitMs: scheduled.waitMs,
              quoteSingleFlightJoined: flight.joined,
              quoteSingleFlightWaiters: flight.waiters,
              quoteFallbackAttempted: fallbackReason !== "NONE",
              quoteFallbackUsed: fallbackReason !== "NONE",
              ...providerResult.diagnostics,
              ...raydiumVenueDetails,
            },
          }),
        );
        return result;
      }

      if (providerResult.rateLimited) {
        this.options.backoff.recordRateLimit(provider.name, "quote");
      }
      const negativeCacheStatus = shouldCacheNegative(provider.name, providerResult)
        ? negativeCache.set(provider.name, request, providerResult, negativeReason(providerResult))
        : "MISS";
      const result = withDiagnostics(providerResult, {
        quoteDemandAction: action,
        quoteNegativeCacheStatus: negativeCacheStatus,
        quoteSchedulerWaitMs: scheduled.waitMs,
        quoteSingleFlightJoined: flight.joined,
        quoteSingleFlightWaiters: flight.waiters,
      });
      lastFailure = result;
      fallbackReason = resolveFailureFallbackReason(provider.name, result, fallbackReason);
      this.options.attemptJournal?.recordLatestAttempt({
        request,
        provider: provider.name,
        sourceType: "NONE",
        outcome: "FAILURE",
        fallbackReason,
        failureCode: result.error.code,
        ...definedString(
          "raydiumFailureCategory",
          readString(result.diagnostics?.raydiumFailureCategory),
        ),
        ...definedString(
          "raydiumFailureDetail",
          readString(result.diagnostics?.raydiumFailureDetail),
        ),
        ...(result.httpAttempts ? { httpAttemptCount: result.httpAttempts.length } : {}),
        ...definedNumber("lastHttpStatus", lastHttpStatus(result)),
      });
      this.recordRouterResult(
        "quote",
        result,
        this.buildContext({
          context,
          priority,
          provider: provider.name,
          source: "LIVE",
          sourceType: "NONE",
          fallbackReason,
          providerOrder,
          attemptedProviders,
          action,
          request,
          details: {
            quoteCacheStatus: successCache.status,
            quoteNegativeCacheStatus: negativeCacheStatus,
            quoteSchedulerWaitMs: scheduled.waitMs,
            quoteSingleFlightJoined: flight.joined,
            quoteSingleFlightWaiters: flight.waiters,
            ...providerResult.diagnostics,
            ...raydiumVenueDetails,
          },
        }),
      );
    }

    return (
      lastFailure ??
      providerFailure({
        provider: this.name,
        error: createProviderError({
          code: "PROVIDER_UNAVAILABLE",
          message: "No quote providers are enabled.",
        }),
        warnings: ["Quote router has no enabled quote providers."],
      })
    );
  }

  private negativeCacheFor(provider: ProviderName): QuoteNegativeCache {
    return provider === "RAYDIUM" ? this.options.raydiumNegativeCache : this.options.negativeCache;
  }

  private buildContext(input: {
    readonly context: QuoteRequestContext;
    readonly priority: string;
    readonly provider: ProviderName;
    readonly source: string;
    readonly sourceType: QuoteSourceType;
    readonly fallbackReason: QuoteFallbackReason;
    readonly providerOrder: readonly ProviderName[];
    readonly attemptedProviders: readonly ProviderName[];
    readonly action: QuoteDemandAction;
    readonly request: QuoteRequest;
    readonly details: Readonly<Record<string, unknown>>;
  }): Record<string, unknown> {
    return {
      ...input.context,
      quotePriority: input.priority,
      quoteSource: input.source,
      quoteProvider: input.provider,
      quoteSourceType: input.sourceType,
      quoteFallbackReason: input.fallbackReason,
      quoteProviderOrder: input.providerOrder,
      quoteAttemptedProviders: input.attemptedProviders,
      quoteDemandAction: input.action,
      ...input.details,
      ...this.readQuoteJournalContext(input.request),
    };
  }

  private recordRouterResult<T>(
    operation: string,
    result: ProviderResult<T>,
    context: Readonly<Record<string, unknown>>,
  ): void {
    this.options.healthService?.recordResult(operation, result, context);
  }

  private readQuoteJournalContext(request: QuoteRequest): Record<string, unknown> {
    const snapshot = this.options.attemptJournal?.getSnapshot(request);
    if (!snapshot) return {};
    const latest = snapshot.latestAttempt;
    const lastSuccess = snapshot.lastSuccessfulQuote;
    return {
      ...(latest
        ? {
            quoteLatestAttemptOutcome: latest.outcome,
            quoteLatestAttemptProvider: latest.provider,
            quoteLatestAttemptSourceType: latest.sourceType,
            quoteLatestAttemptFallbackReason: latest.fallbackReason,
            quoteLatestAttemptHttpAttemptCount: latest.httpAttemptCount,
            ...(latest.failureCode ? { quoteLatestAttemptFailureCode: latest.failureCode } : {}),
            ...(latest.raydiumFailureCategory
              ? { quoteLatestAttemptRaydiumFailureCategory: latest.raydiumFailureCategory }
              : {}),
            ...(latest.raydiumFailureDetail
              ? { quoteLatestAttemptRaydiumFailureDetail: latest.raydiumFailureDetail }
              : {}),
            ...(latest.lastHttpStatus !== undefined
              ? { quoteLatestAttemptHttpStatus: latest.lastHttpStatus }
              : {}),
          }
        : {}),
      ...(lastSuccess
        ? {
            quoteLastSuccessfulProvider: lastSuccess.provider,
            quoteLastSuccessfulSourceType: lastSuccess.sourceType,
            quoteLastSuccessfulAgeMs: lastSuccess.ageMs,
            quoteLatestVsLastSuccessDivergence:
              latest !== undefined &&
              (latest.outcome !== "SUCCESS" || latest.provider !== lastSuccess.provider),
          }
        : {}),
    };
  }
}

function withQuoteProvenance(
  quote: QuoteResult,
  provenance: {
    readonly quoteProvider: ProviderName;
    readonly quoteSourceType: QuoteSourceType;
    readonly fallbackReason: QuoteFallbackReason;
    readonly attemptedProviders: readonly ProviderName[];
    readonly providerOrder: readonly ProviderName[];
  },
): QuoteResult {
  return { ...quote, provenance: { ...quote.provenance, ...provenance } };
}

function withDiagnostics<T>(
  result: ProviderSuccess<T>,
  diagnostics: Readonly<Record<string, unknown>>,
): ProviderSuccess<T>;
function withDiagnostics(
  result: ProviderFailure,
  diagnostics: Readonly<Record<string, unknown>>,
): ProviderFailure;
function withDiagnostics<T>(
  result: ProviderResult<T>,
  diagnostics: Readonly<Record<string, unknown>>,
): ProviderResult<T> {
  return result.ok
    ? providerSuccess({ ...result, diagnostics: { ...result.diagnostics, ...diagnostics } })
    : providerFailure({ ...result, diagnostics: { ...result.diagnostics, ...diagnostics } });
}

function shouldCacheNegative(provider: ProviderName, result: ProviderFailure): boolean {
  if (
    result.rateLimited ||
    result.error.code === "TIMEOUT" ||
    result.error.code === "PROVIDER_UNAVAILABLE"
  ) {
    return false;
  }
  return provider === "RAYDIUM"
    ? result.error.code === "NOT_FOUND" || result.error.code === "BAD_REQUEST"
    : result.error.code === "NOT_FOUND" || result.error.code === "BAD_REQUEST";
}

function negativeReason(result: ProviderFailure): string {
  return readString(result.diagnostics?.raydiumFailureDetail) ?? result.error.code;
}

function resolveCooldownFallbackReason(
  provider: ProviderName,
  current: QuoteFallbackReason,
): QuoteFallbackReason {
  if (current !== "NONE") return current;
  return provider === "JUPITER" ? "JUPITER_COOLDOWN" : "ROUTER_POLICY";
}

function resolveFailureFallbackReason(
  provider: ProviderName,
  result: ProviderFailure,
  current: QuoteFallbackReason,
): QuoteFallbackReason {
  if (current !== "NONE") return current;
  if (provider !== "JUPITER") return "ROUTER_POLICY";
  if (isJupiterDemandDeferred(result)) return "ROUTER_POLICY";
  return result.rateLimited ? "JUPITER_RATE_LIMITED" : "JUPITER_UNAVAILABLE";
}

function requestQuoteFromProvider(
  provider: QuoteProvider,
  request: QuoteRequest,
  context: QuoteRequestContext,
): Promise<ProviderResult<QuoteResult>> {
  if ("getQuoteWithContext" in provider && typeof provider.getQuoteWithContext === "function") {
    return provider.getQuoteWithContext(request, context);
  }

  return provider.getQuote(request);
}

function isJupiterDemandDeferred(result: ProviderResult<unknown>): boolean {
  const action = readString(result.diagnostics?.jupiterDemandAction);
  return action?.startsWith("DEFERRED_") ?? false;
}

function lastHttpStatus(result: ProviderResult<unknown>): number | undefined {
  return result.httpAttempts?.[result.httpAttempts.length - 1]?.statusCode;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function definedString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function definedNumber<K extends string>(
  key: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value !== undefined ? ({ [key]: value } as Record<K, number>) : {};
}
