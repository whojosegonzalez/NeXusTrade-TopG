import type { ProviderName } from "@nexustrade/shared";

export interface QuoteBackoffPolicyOptions {
  readonly enabled: boolean;
  readonly baseCooldownMs: number;
  readonly maxCooldownMs: number;
  readonly multiplier: number;
  readonly jitterPct: number;
  readonly clock?: () => number;
  readonly random?: () => number;
}

export interface QuoteBackoffDecision {
  readonly active: boolean;
  readonly remainingMs: number;
  readonly consecutiveRateLimits: number;
}

interface BackoffState {
  readonly untilMs: number;
  readonly consecutiveRateLimits: number;
}

export class QuoteBackoffPolicy {
  private readonly states = new Map<string, BackoffState>();
  private readonly clock: () => number;
  private readonly random: () => number;

  constructor(private readonly options: QuoteBackoffPolicyOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  getDecision(provider: ProviderName, operation = "quote"): QuoteBackoffDecision {
    if (!this.options.enabled) {
      return {
        active: false,
        remainingMs: 0,
        consecutiveRateLimits: 0,
      };
    }

    const key = this.key(provider, operation);
    const state = this.states.get(key);

    if (!state) {
      return {
        active: false,
        remainingMs: 0,
        consecutiveRateLimits: 0,
      };
    }

    const remainingMs = state.untilMs - this.clock();

    if (remainingMs <= 0) {
      this.states.delete(key);

      return {
        active: false,
        remainingMs: 0,
        consecutiveRateLimits: state.consecutiveRateLimits,
      };
    }

    return {
      active: true,
      remainingMs,
      consecutiveRateLimits: state.consecutiveRateLimits,
    };
  }

  recordRateLimit(provider: ProviderName, operation = "quote"): QuoteBackoffDecision {
    if (!this.options.enabled) {
      return this.getDecision(provider, operation);
    }

    const key = this.key(provider, operation);
    const previous = this.states.get(key);
    const consecutiveRateLimits = (previous?.consecutiveRateLimits ?? 0) + 1;
    const baseDuration = Math.min(
      this.options.maxCooldownMs,
      this.options.baseCooldownMs * this.options.multiplier ** (consecutiveRateLimits - 1),
    );
    const jitter = baseDuration * (this.options.jitterPct / 100) * (this.random() * 2 - 1);
    const cooldownMs = Math.max(0, Math.round(baseDuration + jitter));

    this.states.set(key, {
      untilMs: this.clock() + cooldownMs,
      consecutiveRateLimits,
    });

    return this.getDecision(provider, operation);
  }

  recordSuccess(provider: ProviderName, operation = "quote"): void {
    if (this.options.enabled) {
      this.states.delete(this.key(provider, operation));
    }
  }

  private key(provider: ProviderName, operation: string): string {
    return `${provider}:${operation}`;
  }
}
