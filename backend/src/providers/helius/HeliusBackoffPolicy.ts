export interface HeliusBackoffDecision {
  readonly active: boolean;
  readonly remainingMs: number;
}

export interface HeliusBackoffPolicyOptions {
  readonly enabled: boolean;
  readonly baseCooldownMs: number;
  readonly maxCooldownMs: number;
  readonly now?: () => number;
}

interface BackoffState {
  readonly failures: number;
  readonly cooldownUntilMs: number;
}

export class HeliusBackoffPolicy {
  private readonly state = new Map<string, BackoffState>();
  private readonly now: () => number;

  constructor(private readonly options: HeliusBackoffPolicyOptions) {
    this.now = options.now ?? Date.now;
  }

  getDecision(operation: string): HeliusBackoffDecision {
    if (!this.options.enabled) {
      return {
        active: false,
        remainingMs: 0,
      };
    }

    const state = this.state.get(operation);

    if (!state) {
      return {
        active: false,
        remainingMs: 0,
      };
    }

    const remainingMs = state.cooldownUntilMs - this.now();

    return {
      active: remainingMs > 0,
      remainingMs: Math.max(0, remainingMs),
    };
  }

  recordRateLimit(operation: string): void {
    if (!this.options.enabled) {
      return;
    }

    const previousFailures = this.state.get(operation)?.failures ?? 0;
    const failures = previousFailures + 1;
    const cooldownMs = Math.min(
      this.options.maxCooldownMs,
      this.options.baseCooldownMs * 2 ** Math.max(0, failures - 1),
    );

    this.state.set(operation, {
      failures,
      cooldownUntilMs: this.now() + cooldownMs,
    });
  }

  recordSuccess(operation: string): void {
    this.state.delete(operation);
  }
}
