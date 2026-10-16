/**
 * Phase 12.94-D Milestone D.2.3: Dual-Domain Pilot Clock
 *
 * Implements strict separation between UTC epoch milliseconds (for cross-record causality)
 * and host monotonic elapsed milliseconds (for latency and timeout profiling).
 *
 * Authority: Finding D23P-03 (Clock-domain and schema-mapping consistency).
 */

import { performance } from "node:perf_hooks";
import type { DualClockReading } from "./PilotTypes.js";

export interface IPilotClock {
  /**
   * Returns current UTC epoch milliseconds (comparable to decision timestamps).
   */
  getEpochNow(): number;

  /**
   * Returns current host monotonic elapsed milliseconds (comparable only to other monotonic readings).
   */
  getMonotonicNow(): number;

  /**
   * Returns a paired dual-domain clock reading.
   */
  getDualReading(): DualClockReading;
}

/**
 * Standard System Dual-Domain Clock.
 */
export class SystemPilotClock implements IPilotClock {
  getEpochNow(): number {
    return Date.now();
  }

  getMonotonicNow(): number {
    return performance.now();
  }

  getDualReading(): DualClockReading {
    return {
      epochMs: Date.now(),
      monotonicElapsedMs: performance.now(),
    };
  }
}

/**
 * Deterministic Virtual Pilot Clock for offline simulation and reproduction tests.
 */
export class DeterministicPilotClock implements IPilotClock {
  private currentEpochMs: number;
  private currentMonotonicMs: number;

  constructor(initialEpochMs: number = 1791940000000, initialMonotonicMs: number = 1000) {
    this.currentEpochMs = initialEpochMs;
    this.currentMonotonicMs = initialMonotonicMs;
  }

  getEpochNow(): number {
    return this.currentEpochMs;
  }

  getMonotonicNow(): number {
    return this.currentMonotonicMs;
  }

  getDualReading(): DualClockReading {
    return {
      epochMs: this.currentEpochMs,
      monotonicElapsedMs: this.currentMonotonicMs,
    };
  }

  advanceBy(ms: number): void {
    if (ms < 0) {
      throw new Error(`Cannot advance virtual clock by negative duration: ${ms}ms`);
    }
    this.currentEpochMs += ms;
    this.currentMonotonicMs += ms;
  }

  setEpoch(epochMs: number): void {
    this.currentEpochMs = epochMs;
  }
}

export interface CausalOrderingCheck {
  readonly valid: boolean;
  readonly violationReason?: string | undefined;
}

/**
 * Validates causal ordering strictly in the UTC epoch domain:
 * requestEpochMs <= receiptEpochMs <= decisionEpochMs
 *
 * Rejects comparison of monotonic values to epoch values (D23P-03).
 */
export function validateCausalEpochOrdering(
  requestEpochMs: number,
  receiptEpochMs: number,
  decisionEpochMs: number,
): CausalOrderingCheck {
  if (!Number.isFinite(requestEpochMs) || requestEpochMs <= 0) {
    return { valid: false, violationReason: "INVALID_REQUEST_EPOCH_NON_FINITE" };
  }
  if (!Number.isFinite(receiptEpochMs) || receiptEpochMs <= 0) {
    return { valid: false, violationReason: "INVALID_RECEIPT_EPOCH_NON_FINITE" };
  }
  if (!Number.isFinite(decisionEpochMs) || decisionEpochMs <= 0) {
    return { valid: false, violationReason: "INVALID_DECISION_EPOCH_NON_FINITE" };
  }

  if (requestEpochMs > receiptEpochMs) {
    return {
      valid: false,
      violationReason: `REQUEST_AFTER_RECEIPT: requestEpochMs (${requestEpochMs}) > receiptEpochMs (${receiptEpochMs})`,
    };
  }

  if (receiptEpochMs > decisionEpochMs) {
    return {
      valid: false,
      violationReason: `LOOKAHEAD_VIOLATION: receiptEpochMs (${receiptEpochMs}) > decisionEpochMs (${decisionEpochMs})`,
    };
  }

  return { valid: true };
}

/**
 * Computes elapsed duration strictly within the host monotonic domain.
 */
export function computeMonotonicElapsed(startMonotonicMs: number, endMonotonicMs: number): number {
  if (!Number.isFinite(startMonotonicMs) || !Number.isFinite(endMonotonicMs)) {
    return 0;
  }
  return Math.max(0, endMonotonicMs - startMonotonicMs);
}
