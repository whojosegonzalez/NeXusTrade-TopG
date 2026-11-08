/**
 * ContinuousQuietIntervalTracker.ts
 *
 * Tracks continuous quiet intervals for a position/pool, establishing verified
 * stagnation coverage from actual interval endpoints covering at least 180 continuous seconds.
 *
 * Offline Verification Rules:
 * 1. Establish quiet coverage from actual interval endpoints covering at least 180 continuous seconds.
 * 2. Merge overlapping intervals without double-counting; repeated snapshots cannot advance coverage.
 * 3. Bind continuity strictly to the same pool, mint, and connection epoch.
 * 4. Collection gaps, outages, stale evidence, and identity/epoch changes break continuity.
 * 5. One quiet 60-second window cannot establish 3-minute stagnation.
 * 6. Raw 5-minute metrics cannot substitute for this evidence.
 */

export interface QuietWindowObservation {
  readonly poolAddress: string;
  readonly tokenMint: string;
  readonly connectionEpoch: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly evaluationTimestampMs: number;
  readonly isQuiet: boolean;
  readonly isCoverageSufficient: boolean;
}

export interface ContinuousQuietSpanState {
  readonly poolAddress: string | null;
  readonly tokenMint: string | null;
  readonly connectionEpoch: number | null;
  readonly continuousStartMs: number | null;
  readonly continuousEndMs: number | null;
  readonly continuousSpanMs: number;
  readonly isStagnant3m: boolean;
  readonly lastResetReason: string | null;
}

export class ContinuousQuietIntervalTracker {
  private poolAddress: string | null = null;
  private tokenMint: string | null = null;
  private connectionEpoch: number | null = null;
  private continuousStartMs: number | null = null;
  private continuousEndMs: number | null = null;
  private lastResetReason: string | null = null;

  public recordQuietWindow(observation: QuietWindowObservation): void {
    // 1. Strict Coordinate Validation
    if (
      !observation ||
      typeof observation !== "object" ||
      typeof observation.poolAddress !== "string" ||
      observation.poolAddress.trim().length === 0 ||
      typeof observation.tokenMint !== "string" ||
      observation.tokenMint.trim().length === 0 ||
      typeof observation.connectionEpoch !== "number" ||
      !Number.isSafeInteger(observation.connectionEpoch) ||
      observation.connectionEpoch < 0
    ) {
      this.reset("INVALID_COORDINATES");
      return;
    }

    // 2. Strict Temporal Endpoint Validation
    if (
      typeof observation.windowStartMs !== "number" ||
      typeof observation.windowEndMs !== "number" ||
      typeof observation.evaluationTimestampMs !== "number" ||
      !Number.isSafeInteger(observation.windowStartMs) ||
      !Number.isSafeInteger(observation.windowEndMs) ||
      !Number.isSafeInteger(observation.evaluationTimestampMs) ||
      observation.windowStartMs <= 0 ||
      observation.windowEndMs <= observation.windowStartMs ||
      observation.evaluationTimestampMs < observation.windowEndMs
    ) {
      this.reset("INVALID_TEMPORAL_ENDPOINTS");
      return;
    }

    // 3. Sufficient Coverage & Quiet Check
    if (!observation.isCoverageSufficient) {
      this.reset("INSUFFICIENT_COVERAGE");
      return;
    }

    if (!observation.isQuiet) {
      this.reset("OBSERVED_TRADE_ACTIVITY");
      return;
    }

    // 4. Identity & Epoch Continuity Binding
    if (this.poolAddress !== null) {
      if (
        this.poolAddress !== observation.poolAddress ||
        this.tokenMint !== observation.tokenMint
      ) {
        this.reset("IDENTITY_CHANGED");
      } else if (this.connectionEpoch !== observation.connectionEpoch) {
        this.reset("EPOCH_CHANGED");
      }
    }

    this.poolAddress = observation.poolAddress;
    this.tokenMint = observation.tokenMint;
    this.connectionEpoch = observation.connectionEpoch;

    // 5. Interval Merging & Gap Detection
    if (this.continuousStartMs === null || this.continuousEndMs === null) {
      // First quiet interval in series
      this.continuousStartMs = observation.windowStartMs;
      this.continuousEndMs = observation.windowEndMs;
      this.lastResetReason = null;
      return;
    }

    // Check for disjoint interval in the future (unobserved forward gap)
    if (observation.windowStartMs > this.continuousEndMs) {
      // Unobserved forward gap breaks continuity
      this.continuousStartMs = observation.windowStartMs;
      this.continuousEndMs = observation.windowEndMs;
      this.lastResetReason = "UNOBSERVED_GAP";
      return;
    }

    // Check for disjoint interval in the past (unobserved backward gap / out-of-order)
    if (observation.windowEndMs < this.continuousStartMs) {
      this.reset("OUT_OF_ORDER_OBSERVATION");
      return;
    }

    // Check for out-of-order backward expansion into unobserved past
    if (observation.windowStartMs < this.continuousStartMs) {
      this.reset("OUT_OF_ORDER_OBSERVATION");
      return;
    }

    // Contiguous or overlapping window (continuousStartMs <= windowStartMs <= continuousEndMs):
    // Advance continuousEndMs only if the new window extends beyond current end
    if (observation.windowEndMs > this.continuousEndMs) {
      this.continuousEndMs = observation.windowEndMs;
    }
    // Note: If observation.windowEndMs <= this.continuousEndMs, it is a repeated snapshot or sub-interval;
    // this.continuousEndMs does not advance, preventing repeated snapshots from inflating coverage.
    this.lastResetReason = null;
  }

  public reset(reason?: string): void {
    this.continuousStartMs = null;
    this.continuousEndMs = null;
    this.lastResetReason = reason ?? "EXPLICIT_RESET";
  }

  public getContinuousSpanMs(): number {
    if (this.continuousStartMs === null || this.continuousEndMs === null) {
      return 0;
    }
    return Math.max(0, this.continuousEndMs - this.continuousStartMs);
  }

  public isStagnant3m(): boolean {
    return this.getContinuousSpanMs() >= 180_000;
  }

  public getState(): ContinuousQuietSpanState {
    const continuousSpanMs = this.getContinuousSpanMs();
    return {
      poolAddress: this.poolAddress,
      tokenMint: this.tokenMint,
      connectionEpoch: this.connectionEpoch,
      continuousStartMs: this.continuousStartMs,
      continuousEndMs: this.continuousEndMs,
      continuousSpanMs,
      isStagnant3m: continuousSpanMs >= 180_000,
      lastResetReason: this.lastResetReason,
    };
  }
}
