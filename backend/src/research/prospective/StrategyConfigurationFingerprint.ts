/**
 * Phase 12.94-D Milestone D.3.3: Canonical Strategy Configuration & Fingerprinting
 *
 * Explicitly binds the active Buy Gate thresholds, safety limits, and cohort
 * classification boundaries into a deterministic cryptographic SHA-256 fingerprint.
 *
 * INVARIANTS:
 * 1. Fingerprint MUST bind actual strategy rules (Buy Gate rules + cohort boundaries),
 *    NOT merely launcher CLI runtime options.
 * 2. Allows independent offline verification that historical strategy thresholds
 *    were strictly preserved during prospective observation.
 */

import crypto from "node:crypto";
import {
  type BuyGateConfig,
  BUY_GATE_DEFAULTS,
} from "../../candidate-scanner/BuyGateTriggerService.js";

export interface CohortBoundaryConfig {
  readonly minLiquidityUsd: number;
  readonly maxLiquidityUsd?: number | undefined;
  readonly minAssetAgeSeconds: number;
  readonly maxAssetAgeSeconds: number;
}

export interface CanonicalStrategyConfig {
  readonly strategyVersion: string;
  readonly cohorts: {
    readonly establishedRunner: CohortBoundaryConfig;
    readonly microCapProbe: CohortBoundaryConfig;
  };
  readonly buyGate: BuyGateConfig;
}

/**
 * The canonical NeXusTrade strategy configuration active during prospective observation.
 * Matches historical production rules:
 * - Established Runner: Liquidity >= $50k, Age between 30m (1800s) and 120m (7200s).
 * - Micro-Cap Probe: Liquidity between $20k and $50k, Age between 5m (300s) and 15m (900s).
 * - Buy Gate: BUY_GATE_DEFAULTS.
 */
export const CANONICAL_STRATEGY_CONFIG: CanonicalStrategyConfig = Object.freeze({
  strategyVersion: "nexustrade-strategy-v1.0",
  cohorts: Object.freeze({
    establishedRunner: Object.freeze({
      minLiquidityUsd: 50_000,
      minAssetAgeSeconds: 1_800,
      maxAssetAgeSeconds: 7_200,
    }),
    microCapProbe: Object.freeze({
      minLiquidityUsd: 20_000,
      maxLiquidityUsd: 50_000,
      minAssetAgeSeconds: 300,
      maxAssetAgeSeconds: 900,
    }),
  }),
  buyGate: Object.freeze({ ...BUY_GATE_DEFAULTS }),
});

/**
 * Computes a deterministic SHA-256 fingerprint for the strategy configuration.
 */
export function computeStrategyConfigFingerprint(
  config: CanonicalStrategyConfig = CANONICAL_STRATEGY_CONFIG,
): string {
  const serialized = JSON.stringify(config);
  return `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
}

export interface CombinedFingerprintResult {
  readonly strategyConfigFingerprint: string;
  readonly launcherConfigFingerprint: string;
  readonly combinedFingerprint: string;
  readonly strategyVersion: string;
}

/**
 * Computes both the strategy-rule fingerprint and the launcher-options fingerprint,
 * combining them into a verifiable session configuration fingerprint.
 */
export function computeCombinedSessionFingerprint(
  launcherOptions: Record<string, unknown>,
  strategyConfig: CanonicalStrategyConfig = CANONICAL_STRATEGY_CONFIG,
): CombinedFingerprintResult {
  const strategyFp = computeStrategyConfigFingerprint(strategyConfig);
  const launcherFp = `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(launcherOptions))
    .digest("hex")}`;
  const combined = `sha256:${crypto
    .createHash("sha256")
    .update(`${strategyFp}:${launcherFp}`)
    .digest("hex")
    .slice(0, 16)}`;

  return {
    strategyConfigFingerprint: strategyFp,
    launcherConfigFingerprint: launcherFp,
    combinedFingerprint: combined,
    strategyVersion: strategyConfig.strategyVersion,
  };
}
