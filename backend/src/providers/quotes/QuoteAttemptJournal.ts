import type {
  ProviderName,
  QuoteFallbackReason,
  QuoteRequest,
  QuoteSourceType,
} from "@nexustrade/shared";

export type QuoteAttemptOutcome = "SUCCESS" | "FAILURE" | "COOLDOWN_SKIP";

export interface QuoteLatestAttemptSnapshot {
  readonly attemptedAt: Date;
  readonly provider: ProviderName;
  readonly sourceType: QuoteSourceType;
  readonly outcome: QuoteAttemptOutcome;
  readonly fallbackReason: QuoteFallbackReason;
  readonly failureCode?: string;
  readonly raydiumFailureCategory?: string;
  readonly raydiumFailureDetail?: string;
  readonly httpAttemptCount: number;
  readonly lastHttpStatus?: number;
}

export interface QuoteLastSuccessfulSnapshot {
  readonly succeededAt: Date;
  readonly provider: ProviderName;
  readonly sourceType: Exclude<QuoteSourceType, "NONE">;
  readonly outputAmountRaw: string;
  readonly estimatedPriceImpactPct?: number;
  readonly fallbackReason: QuoteFallbackReason;
  readonly ageMs: number;
}

export interface QuoteAttemptJournalSnapshot {
  readonly requestKey: string;
  readonly latestAttempt?: QuoteLatestAttemptSnapshot;
  readonly lastSuccessfulQuote?: QuoteLastSuccessfulSnapshot;
}

export interface QuoteAttemptJournalOptions {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly clock?: () => number;
}

export class QuoteAttemptJournal {
  private readonly entries = new Map<string, InternalJournalEntry>();
  private readonly clock: () => number;

  constructor(private readonly options: QuoteAttemptJournalOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  recordLatestAttempt(input: {
    readonly request: QuoteRequest;
    readonly provider: ProviderName;
    readonly sourceType: QuoteSourceType;
    readonly outcome: QuoteAttemptOutcome;
    readonly fallbackReason: QuoteFallbackReason;
    readonly failureCode?: string;
    readonly raydiumFailureCategory?: string;
    readonly raydiumFailureDetail?: string;
    readonly httpAttemptCount?: number;
    readonly lastHttpStatus?: number;
  }): void {
    if (!this.options.enabled) {
      return;
    }

    this.evictExpired();
    const requestKey = buildRouterRequestKey(input.request);
    const existing = this.entries.get(requestKey);

    this.entries.set(requestKey, {
      requestKey,
      updatedAtMs: this.clock(),
      latestAttempt: {
        attemptedAt: new Date(this.clock()),
        provider: input.provider,
        sourceType: input.sourceType,
        outcome: input.outcome,
        fallbackReason: input.fallbackReason,
        ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        ...(input.raydiumFailureCategory
          ? { raydiumFailureCategory: input.raydiumFailureCategory }
          : {}),
        ...(input.raydiumFailureDetail ? { raydiumFailureDetail: input.raydiumFailureDetail } : {}),
        httpAttemptCount: input.httpAttemptCount ?? 0,
        ...(input.lastHttpStatus !== undefined ? { lastHttpStatus: input.lastHttpStatus } : {}),
      },
      ...(existing?.lastSuccessfulQuote
        ? { lastSuccessfulQuote: existing.lastSuccessfulQuote }
        : {}),
    });
    this.evictOverflow();
  }

  recordLastSuccessfulQuote(input: {
    readonly request: QuoteRequest;
    readonly provider: ProviderName;
    readonly sourceType: Exclude<QuoteSourceType, "NONE">;
    readonly outputAmountRaw: string;
    readonly estimatedPriceImpactPct?: number;
    readonly fallbackReason: QuoteFallbackReason;
  }): void {
    if (!this.options.enabled) {
      return;
    }

    const requestKey = buildRouterRequestKey(input.request);
    const existing = this.entries.get(requestKey);

    this.entries.set(requestKey, {
      requestKey,
      updatedAtMs: this.clock(),
      ...(existing?.latestAttempt ? { latestAttempt: existing.latestAttempt } : {}),
      lastSuccessfulQuote: {
        succeededAtMs: this.clock(),
        provider: input.provider,
        sourceType: input.sourceType,
        outputAmountRaw: input.outputAmountRaw,
        ...(input.estimatedPriceImpactPct !== undefined
          ? { estimatedPriceImpactPct: input.estimatedPriceImpactPct }
          : {}),
        fallbackReason: input.fallbackReason,
      },
    });
    this.evictOverflow();
  }

  getSnapshot(request: QuoteRequest): QuoteAttemptJournalSnapshot | undefined {
    if (!this.options.enabled) {
      return undefined;
    }

    this.evictExpired();
    const requestKey = buildRouterRequestKey(request);
    const entry = this.entries.get(requestKey);

    return entry ? this.toSnapshot(entry) : undefined;
  }

  private toSnapshot(entry: InternalJournalEntry): QuoteAttemptJournalSnapshot {
    const lastSuccessfulQuote = entry.lastSuccessfulQuote
      ? toLastSuccessfulSnapshot(entry.lastSuccessfulQuote, this.clock())
      : undefined;

    return {
      requestKey: entry.requestKey,
      ...(entry.latestAttempt ? { latestAttempt: entry.latestAttempt } : {}),
      ...(lastSuccessfulQuote ? { lastSuccessfulQuote } : {}),
    };
  }

  private evictExpired(): void {
    const nowMs = this.clock();

    for (const [key, entry] of this.entries.entries()) {
      if (nowMs - entry.updatedAtMs > this.options.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = [...this.entries.entries()].sort(
        ([, left], [, right]) => left.updatedAtMs - right.updatedAtMs,
      )[0]?.[0];

      if (!oldest) {
        return;
      }

      this.entries.delete(oldest);
    }
  }
}

interface InternalLastSuccessfulQuote {
  readonly succeededAtMs: number;
  readonly provider: ProviderName;
  readonly sourceType: Exclude<QuoteSourceType, "NONE">;
  readonly outputAmountRaw: string;
  readonly estimatedPriceImpactPct?: number;
  readonly fallbackReason: QuoteFallbackReason;
}

interface InternalJournalEntry {
  readonly requestKey: string;
  readonly updatedAtMs: number;
  readonly latestAttempt?: QuoteLatestAttemptSnapshot;
  readonly lastSuccessfulQuote?: InternalLastSuccessfulQuote;
}

export function buildRouterRequestKey(request: QuoteRequest): string {
  return JSON.stringify({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amountRaw: request.amountRaw,
    side: request.side,
    slippageBps: request.slippageBps,
    onlyDirectRoutes: request.onlyDirectRoutes,
    maxAccounts: request.maxAccounts,
  });
}

function toLastSuccessfulSnapshot(
  input: InternalLastSuccessfulQuote,
  nowMs: number,
): QuoteLastSuccessfulSnapshot {
  return {
    succeededAt: new Date(input.succeededAtMs),
    provider: input.provider,
    sourceType: input.sourceType,
    outputAmountRaw: input.outputAmountRaw,
    ...(input.estimatedPriceImpactPct !== undefined
      ? { estimatedPriceImpactPct: input.estimatedPriceImpactPct }
      : {}),
    fallbackReason: input.fallbackReason,
    ageMs: Math.max(0, nowMs - input.succeededAtMs),
  };
}
