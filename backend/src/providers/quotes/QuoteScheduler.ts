import type { ProviderName } from "@nexustrade/shared";

export interface QuoteSchedulerOptions {
  readonly enabled: boolean;
  readonly minIntervalMsByProvider: Readonly<Partial<Record<ProviderName, number>>>;
  readonly clock?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}

export interface QuoteScheduleResult<T> {
  readonly value: T;
  readonly waitMs: number;
}

/**
 * Keeps live quote calls within a small local cadence. Cache and router skips do
 * not enter this class, so it cannot delay a request that will not hit a provider.
 */
export class QuoteScheduler {
  private readonly nextAllowedAtMs = new Map<string, number>();
  private readonly clock: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly options: QuoteSchedulerOptions) {
    this.clock = options.clock ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async schedule<T>(
    provider: ProviderName,
    operation: string,
    action: () => Promise<T>,
  ): Promise<QuoteScheduleResult<T>> {
    if (!this.options.enabled) {
      return {
        value: await action(),
        waitMs: 0,
      };
    }

    const intervalMs = this.options.minIntervalMsByProvider[provider] ?? 0;

    if (intervalMs <= 0) {
      return {
        value: await action(),
        waitMs: 0,
      };
    }

    const key = `${provider}:${operation}`;
    const nowMs = this.clock();
    const waitMs = Math.max(0, (this.nextAllowedAtMs.get(key) ?? nowMs) - nowMs);

    if (waitMs > 0) {
      await this.wait(waitMs);
    }

    this.nextAllowedAtMs.set(key, this.clock() + intervalMs);

    return {
      value: await action(),
      waitMs,
    };
  }
}
