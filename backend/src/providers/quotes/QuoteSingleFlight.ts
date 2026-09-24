import type { ProviderName, QuoteRequest } from "@nexustrade/shared";

import { buildQuoteRequestKey } from "./QuoteRequestKey.js";

export interface QuoteSingleFlightOptions {
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly clock?: () => number;
}

export interface QuoteSingleFlightResult<T> {
  readonly value: T;
  readonly joined: boolean;
  readonly waiters: number;
}

interface InFlightEntry<T> {
  readonly createdAtMs: number;
  readonly promise: Promise<T>;
  waiters: number;
}

/** Shares only currently in-flight identical quote calls; completed failures are never reused. */
export class QuoteSingleFlight {
  private readonly entries = new Map<string, InFlightEntry<unknown>>();
  private readonly clock: () => number;

  constructor(private readonly options: QuoteSingleFlightOptions) {
    this.clock = options.clock ?? Date.now;
  }

  async run<T>(
    provider: ProviderName,
    request: QuoteRequest,
    action: () => Promise<T>,
  ): Promise<QuoteSingleFlightResult<T>> {
    if (!this.options.enabled) {
      return { value: await action(), joined: false, waiters: 0 };
    }

    this.purgeExpired();
    const key = buildQuoteRequestKey({ provider, request });
    const existing = this.entries.get(key) as InFlightEntry<T> | undefined;

    if (existing) {
      existing.waiters += 1;
      return {
        value: await existing.promise,
        joined: true,
        waiters: existing.waiters,
      };
    }

    const entry: InFlightEntry<T> = {
      createdAtMs: this.clock(),
      promise: Promise.resolve().then(action),
      waiters: 0,
    };
    this.entries.set(key, entry);

    try {
      return {
        value: await entry.promise,
        joined: false,
        waiters: entry.waiters,
      };
    } finally {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    }
  }

  private purgeExpired(): void {
    const nowMs = this.clock();

    for (const [key, entry] of this.entries) {
      if (nowMs - entry.createdAtMs >= this.options.ttlMs) {
        this.entries.delete(key);
      }
    }
  }
}
