import type { ProviderFailure, ProviderName, QuoteRequest } from "@nexustrade/shared";

import { buildQuoteRequestKey } from "./QuoteRequestKey.js";

export type QuoteNegativeCacheStatus = "DISABLED" | "EXPIRED" | "HIT" | "MISS" | "SET";

export interface QuoteNegativeCacheOptions {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly clock?: () => number;
}

export interface QuoteNegativeCacheEntry {
  readonly provider: ProviderName;
  readonly request: QuoteRequest;
  readonly result: ProviderFailure;
  readonly reason: string;
  readonly storedAtMs: number;
  readonly expiresAtMs: number;
}

export interface QuoteNegativeCacheLookup {
  readonly status: Exclude<QuoteNegativeCacheStatus, "SET">;
  readonly entry?: QuoteNegativeCacheEntry;
  readonly ageMs?: number;
  readonly ttlMs?: number;
}

/** Separate, bounded storage for deterministic quote failures such as no-route. */
export class QuoteNegativeCache {
  private readonly entries = new Map<string, QuoteNegativeCacheEntry>();
  private readonly clock: () => number;

  constructor(private readonly options: QuoteNegativeCacheOptions) {
    this.clock = options.clock ?? Date.now;
  }

  get(provider: ProviderName, request: QuoteRequest): QuoteNegativeCacheLookup {
    if (!this.options.enabled) {
      return { status: "DISABLED" };
    }

    const key = buildQuoteRequestKey({ provider, request });
    const entry = this.entries.get(key);

    if (!entry) {
      return { status: "MISS" };
    }

    const nowMs = this.clock();

    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return { status: "EXPIRED", ageMs: nowMs - entry.storedAtMs, ttlMs: this.options.ttlMs };
    }

    return { status: "HIT", entry, ageMs: nowMs - entry.storedAtMs, ttlMs: this.options.ttlMs };
  }

  set(
    provider: ProviderName,
    request: QuoteRequest,
    result: ProviderFailure,
    reason: string,
  ): QuoteNegativeCacheStatus {
    if (!this.options.enabled) {
      return "DISABLED";
    }

    this.purgeExpired();
    const storedAtMs = this.clock();
    this.entries.set(buildQuoteRequestKey({ provider, request }), {
      provider,
      request,
      result,
      reason,
      storedAtMs,
      expiresAtMs: storedAtMs + this.options.ttlMs,
    });
    this.evictOverflow();
    return "SET";
  }

  private purgeExpired(): void {
    const nowMs = this.clock();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = [...this.entries.entries()].sort(
        ([, left], [, right]) => left.storedAtMs - right.storedAtMs,
      )[0];

      if (!oldest) {
        return;
      }

      this.entries.delete(oldest[0]);
    }
  }
}
