import type { QuotePriority } from "../quotes/QuotePriority.js";

export type JupiterDemandOperation = "PRICE" | "QUOTE";

export type JupiterDemandPriority = "HIGH" | "NORMAL" | "LOW";

export type JupiterDemandAction =
  | "LIVE_ALLOWED"
  | "DEFERRED_MIN_INTERVAL"
  | "DEFERRED_WINDOW_BUDGET"
  | "DEFERRED_LOW_PRIORITY_BUDGET"
  | "DEFERRED_ADAPTIVE_BACKOFF";

export interface JupiterDemandControllerConfig {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly maxLiveRequestsPerWindow: number;
  readonly baseMinIntervalMs: number;
  readonly maxIntervalMs: number;
  readonly adaptiveEnabled: boolean;
  readonly rateLimitMultiplier: number;
  readonly successDecayCount: number;
  readonly maxLowPriorityRequestsPerWindow: number;
  readonly deferLowPriorityFirst: boolean;
  readonly respectRetryAfter: boolean;
}

export interface JupiterDemandRequest {
  readonly operation: JupiterDemandOperation;
  readonly priority?: QuotePriority;
}

export interface JupiterDemandDecision {
  readonly allowed: boolean;
  readonly action: JupiterDemandAction;
  readonly operation: JupiterDemandOperation;
  readonly priority: JupiterDemandPriority;
  readonly windowUsage: number;
  readonly windowLimit: number;
  readonly lowPriorityWindowUsage: number;
  readonly lowPriorityWindowLimit: number;
  readonly effectiveIntervalMs: number;
  readonly adaptiveLevel: number;
  readonly retryAfterUntil?: string;
  readonly retryAfterMs?: number;
  readonly waitMs?: number;
}

export interface JupiterDemandOutcome {
  readonly rateLimited: boolean;
  readonly retryAfterMs?: number;
}

export interface JupiterDemandSnapshot {
  readonly effectiveIntervalMs: number;
  readonly adaptiveLevel: number;
  readonly retryAfterUntil?: string;
  readonly retryAfterMs?: number;
  readonly liveRateLimitObserved: boolean;
}

export class JupiterDemandController {
  private readonly requestTimestamps: number[] = [];
  private readonly lowPriorityRequestTimestamps: number[] = [];
  private nextAllowedAtMs = 0;
  private retryAfterUntilMs = 0;
  private adaptiveLevel = 0;
  private consecutiveSuccesses = 0;
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly config: JupiterDemandControllerConfig) {}

  public tryAcquire(request: JupiterDemandRequest): JupiterDemandDecision {
    const now = Date.now();
    const priority = normalizePriority(request.priority);

    this.prune(now);

    const baseDecision = (): Omit<JupiterDemandDecision, "allowed" | "action"> => ({
      operation: request.operation,
      priority,
      windowUsage: this.requestTimestamps.length,
      windowLimit: this.config.maxLiveRequestsPerWindow,
      lowPriorityWindowUsage: this.lowPriorityRequestTimestamps.length,
      lowPriorityWindowLimit: this.config.maxLowPriorityRequestsPerWindow,
      effectiveIntervalMs: this.effectiveIntervalMs(),
      adaptiveLevel: this.adaptiveLevel,
      ...(this.retryAfterUntilMs > now
        ? {
            retryAfterUntil: new Date(this.retryAfterUntilMs).toISOString(),
            retryAfterMs: this.retryAfterUntilMs - now,
          }
        : {}),
    });

    if (!this.config.enabled) {
      return { ...baseDecision(), allowed: true, action: "LIVE_ALLOWED" };
    }

    if (this.requestTimestamps.length >= this.config.maxLiveRequestsPerWindow) {
      return {
        ...baseDecision(),
        allowed: false,
        action: "DEFERRED_WINDOW_BUDGET",
      };
    }

    if (
      priority === "LOW" &&
      this.config.deferLowPriorityFirst &&
      this.lowPriorityRequestTimestamps.length >= this.config.maxLowPriorityRequestsPerWindow
    ) {
      return {
        ...baseDecision(),
        allowed: false,
        action: "DEFERRED_LOW_PRIORITY_BUDGET",
      };
    }

    if (now < this.nextAllowedAtMs) {
      return {
        ...baseDecision(),
        allowed: false,
        action:
          this.adaptiveLevel > 0 || now < this.retryAfterUntilMs
            ? "DEFERRED_ADAPTIVE_BACKOFF"
            : "DEFERRED_MIN_INTERVAL",
        waitMs: this.nextAllowedAtMs - now,
      };
    }

    this.requestTimestamps.push(now);
    if (priority === "LOW") {
      this.lowPriorityRequestTimestamps.push(now);
    }
    this.nextAllowedAtMs = now + this.effectiveIntervalMs();

    return { ...baseDecision(), allowed: true, action: "LIVE_ALLOWED" };
  }

  /**
   * Serializes normal and high-priority work inside the active process. The queue
   * is not persisted or detached: callers await their own request, and a rolling
   * window exhaustion still returns immediately instead of accumulating work.
   */
  public async acquire(request: JupiterDemandRequest): Promise<JupiterDemandDecision> {
    const priority = normalizePriority(request.priority);
    if (priority === "LOW") {
      return this.tryAcquire(request);
    }

    let releaseQueue: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;

    try {
      let decision = this.tryAcquire(request);
      if (!shouldWaitForDemandSlot(decision, priority)) {
        return decision;
      }

      await sleep(decision.waitMs ?? 0);
      decision = this.tryAcquire(request);
      return decision;
    } finally {
      releaseQueue?.();
    }
  }

  public recordLiveOutcome(outcome: JupiterDemandOutcome): JupiterDemandSnapshot {
    const now = Date.now();

    if (!this.config.enabled) {
      return this.snapshot(false);
    }

    if (outcome.rateLimited) {
      this.consecutiveSuccesses = 0;
      if (this.config.adaptiveEnabled) {
        this.adaptiveLevel += 1;
      }

      if (
        this.config.respectRetryAfter &&
        outcome.retryAfterMs !== undefined &&
        outcome.retryAfterMs > 0
      ) {
        this.retryAfterUntilMs = Math.max(this.retryAfterUntilMs, now + outcome.retryAfterMs);
      }

      this.nextAllowedAtMs = Math.max(
        this.nextAllowedAtMs,
        now + this.effectiveIntervalMs(),
        this.retryAfterUntilMs,
      );
      return this.snapshot(true);
    }

    this.consecutiveSuccesses += 1;
    if (
      this.config.adaptiveEnabled &&
      this.adaptiveLevel > 0 &&
      this.consecutiveSuccesses >= this.config.successDecayCount
    ) {
      this.adaptiveLevel -= 1;
      this.consecutiveSuccesses = 0;
    }

    return this.snapshot(false);
  }

  private effectiveIntervalMs(): number {
    if (!this.config.adaptiveEnabled || this.adaptiveLevel === 0) {
      return this.config.baseMinIntervalMs;
    }

    return Math.min(
      this.config.maxIntervalMs,
      Math.round(
        this.config.baseMinIntervalMs * this.config.rateLimitMultiplier ** this.adaptiveLevel,
      ),
    );
  }

  private snapshot(liveRateLimitObserved: boolean): JupiterDemandSnapshot {
    const now = Date.now();
    return {
      effectiveIntervalMs: this.effectiveIntervalMs(),
      adaptiveLevel: this.adaptiveLevel,
      ...(this.retryAfterUntilMs > now
        ? {
            retryAfterUntil: new Date(this.retryAfterUntilMs).toISOString(),
            retryAfterMs: this.retryAfterUntilMs - now,
          }
        : {}),
      liveRateLimitObserved,
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.config.windowMs;
    pruneTimestamps(this.requestTimestamps, cutoff);
    pruneTimestamps(this.lowPriorityRequestTimestamps, cutoff);
  }
}

function shouldWaitForDemandSlot(
  decision: JupiterDemandDecision,
  priority: JupiterDemandPriority,
): boolean {
  return (
    priority !== "LOW" &&
    (decision.action === "DEFERRED_MIN_INTERVAL" || decision.action === "DEFERRED_ADAPTIVE_BACKOFF")
  );
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, durationMs)));
}

function normalizePriority(priority: QuotePriority | undefined): JupiterDemandPriority {
  if (priority === "LOW") {
    return "LOW";
  }

  if (priority === "HIGH" || priority === "CRITICAL") {
    return "HIGH";
  }

  return "NORMAL";
}

function pruneTimestamps(timestamps: number[], cutoff: number): void {
  while (timestamps.length > 0 && timestamps[0] !== undefined && timestamps[0] < cutoff) {
    timestamps.shift();
  }
}
