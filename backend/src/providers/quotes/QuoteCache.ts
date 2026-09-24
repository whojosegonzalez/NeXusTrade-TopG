import type { ProviderName, ProviderSuccess, QuoteRequest, QuoteResult } from "@nexustrade/shared";

import { buildQuoteRequestKey } from "./QuoteRequestKey.js";

export type QuoteCacheStatus = "DISABLED" | "EXPIRED" | "HIT" | "MISS";

export interface QuoteCacheOptions {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly clock?: () => number;
}

export interface QuoteCacheEntry {
  readonly key: string;
  readonly provider: ProviderName;
  readonly request: QuoteRequest;
  readonly result: ProviderSuccess<QuoteResult>;
  readonly storedAtMs: number;
  readonly expiresAtMs: number;
  readonly hitCount: number;
}

export interface QuoteCacheLookup {
  readonly status: QuoteCacheStatus;
  readonly entry?: QuoteCacheEntry;
  readonly cacheAgeMs?: number;
  readonly cacheTtlMs?: number;
}

export class QuoteCache {
  private readonly entries = new Map<string, QuoteCacheEntry>();
  private readonly clock: () => number;

  constructor(private readonly options: QuoteCacheOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  get(provider: ProviderName, request: QuoteRequest): QuoteCacheLookup {
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

      return {
        status: "EXPIRED",
        cacheAgeMs: nowMs - entry.storedAtMs,
        cacheTtlMs: this.options.ttlMs,
      };
    }

    const hitEntry = {
      ...entry,
      hitCount: entry.hitCount + 1,
    };
    this.entries.set(key, hitEntry);

    return {
      status: "HIT",
      entry: hitEntry,
      cacheAgeMs: nowMs - entry.storedAtMs,
      cacheTtlMs: this.options.ttlMs,
    };
  }

  set(provider: ProviderName, request: QuoteRequest, result: ProviderSuccess<QuoteResult>): void {
    if (!this.options.enabled) {
      return;
    }

    this.purgeExpired();

    const key = buildQuoteRequestKey({ provider, request });
    const storedAtMs = this.clock();

    this.entries.set(key, {
      key,
      provider,
      request,
      result,
      storedAtMs,
      expiresAtMs: storedAtMs + this.options.ttlMs,
      hitCount: 0,
    });

    this.evictOverflow();
  }

  size(): number {
    this.purgeExpired();

    return this.entries.size;
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
      const oldestKey = [...this.entries.values()].sort((a, b) => a.storedAtMs - b.storedAtMs)[0]
        ?.key;

      if (!oldestKey) {
        return;
      }

      this.entries.delete(oldestKey);
    }
  }
}
