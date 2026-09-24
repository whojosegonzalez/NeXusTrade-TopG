import { FormulationBCollectionError } from "./FormulationBCollectionErrors.js";
import type { FormulationBSafetyCounters } from "./FormulationBCollectionTypes.js";

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_.-]{10,}/i,
  /sk_live_[A-Za-z0-9]{10,}/i,
  /api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}['"]?/i,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
];

const FORBIDDEN_LIQUIDITY_KEYS = [
  "liquidity",
  "liquidityusd",
  "poolreserve",
  "poolreserveusd",
  "quoteimpact",
  "quoteimpactbps",
  "depth",
];

export class FormulationBSafetyMonitor {
  private consecutiveErrors = 0;
  private totalCalls = 0;
  private dailyCalls = new Map<string, number>();
  public readonly safetyCounters: FormulationBSafetyCounters = {
    clockDriftStops: 0,
    schemaIntegrityStops: 0,
    secretLeakageStops: 0,
    budgetExceededStops: 0,
  };

  public checkClockDrift(serverDateHeader: string | undefined, clientTimestampMs: number): void {
    if (!serverDateHeader) return;
    const serverMs = Date.parse(serverDateHeader);
    if (!Number.isFinite(serverMs)) return;

    const driftSec = Math.abs(clientTimestampMs - serverMs) / 1000;
    if (driftSec > 5.0) {
      this.safetyCounters.clockDriftStops++;
      throw new FormulationBCollectionError(
        "FORMULATION_B_CLOCK_DRIFT_STOP",
        `Clock drift exceeded 5.0s: detected ${driftSec.toFixed(2)}s drift`,
      );
    }
  }

  public checkSecretLeakage(payload: string): void {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(payload)) {
        this.safetyCounters.secretLeakageStops++;
        throw new FormulationBCollectionError(
          "FORMULATION_B_SECRET_LEAKAGE_STOP",
          "Potential credential or private key string detected in memory/payload",
        );
      }
    }
  }

  public checkRateLimitResponse(status: number): void {
    if (status === 429 || status === 403) {
      throw new FormulationBCollectionError(
        "FORMULATION_B_RATE_LIMIT_STOP",
        `Provider rate limit response encountered: HTTP ${status}`,
      );
    }
  }

  public recordSlotSuccess(): void {
    this.consecutiveErrors = 0;
  }

  public recordSlotFailure(): void {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= 3) {
      throw new FormulationBCollectionError(
        "FORMULATION_B_CONSECUTIVE_ERROR_STOP",
        `Consecutive slot error threshold breached: ${this.consecutiveErrors} consecutive failures`,
      );
    }
  }

  public checkLiquidityProhibition(payload: Record<string, unknown>): void {
    const keys = Object.keys(payload);
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_LIQUIDITY_KEYS.some((forbidden) => lower.includes(forbidden))) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_LIQUIDITY_PROHIBITION_STOP",
          `Forbidden liquidity field detected in candidate payload: ${key}`,
        );
      }
    }
  }

  public trackProviderCall(utcDate: string): void {
    this.totalCalls++;
    const currentDaily = (this.dailyCalls.get(utcDate) ?? 0) + 1;
    this.dailyCalls.set(utcDate, currentDaily);

    if (currentDaily > 120) {
      this.safetyCounters.budgetExceededStops++;
      throw new FormulationBCollectionError(
        "FORMULATION_B_BUDGET_EXCEEDED_STOP",
        `Daily request budget cap exceeded on ${utcDate}: ${currentDaily} > 120`,
      );
    }

    if (this.totalCalls > 600) {
      this.safetyCounters.budgetExceededStops++;
      throw new FormulationBCollectionError(
        "FORMULATION_B_BUDGET_EXCEEDED_STOP",
        `Total cohort request budget cap exceeded: ${this.totalCalls} > 600`,
      );
    }
  }
}
