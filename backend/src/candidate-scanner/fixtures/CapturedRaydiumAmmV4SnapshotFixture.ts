/**
 * Phase 12.94-D Milestone D.3.3: Authentic Captured Raydium AMM v4 Snapshot Fixture & Synthetic Candidate Mocks
 *
 * Contains:
 * 1. The independently verified, authentic operator snapshot for the reference RAY/WSOL pool
 *    (AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA), recorded at 2026-10-27T06:35:11.779Z (slot 461970878).
 * 2. Explicitly labeled synthetic candidate test double wrapping authentic LP evidence for offline testing.
 * 3. Synthetic qualified LP evidence (>= 90%) for positive-path regression testing.
 */

import type { ScannedPoolRecord } from "../CandidateScannerTypes.js";
import type { SnapshotAcquisitionEvidence } from "../../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";

/**
 * Authentic, sealed operator-run snapshot evidence for the reference RAY/WSOL pair.
 * Independently verified:
 * - Acquisition duration: 2,753 ms
 * - Exactly two HTTP requests, both HTTP 200
 * - Bootstrap slot: 461970865
 * - Final batch slot: 461970878
 * - Protocol LP (L): 362937054696n
 * - Circulating Supply (S): 362444613518n
 * - Inaccessible claims (L - S): 492441178n
 * - Derived percentage: 0.135682%
 * - Mathematical 90% threshold: false
 */
export const CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE: SnapshotAcquisitionEvidence = Object.freeze({
  schemaVersion: "1.0",
  command: "RaydiumAmmV4SnapshotAcquisition",
  executionMode: "LIVE_ACQUISITION",
  evidenceOrigin: "CAPTURED_RPC",
  isSyntheticFixture: false,
  retrievedAtIso: "2026-10-27T06:35:11.779Z",
  startedAtIso: "2026-10-27T06:35:09.029Z",
  completedAtIso: "2026-10-27T06:35:11.782Z",
  endpoint: Object.freeze({
    sanitizedUrl: "https://api.mainnet.solana.com",
    host: "api.mainnet.solana.com",
    endpointFingerprint: "sha256:df2f872946a6a34c",
  }),
  config: Object.freeze({
    poolId: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
    expectedTokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    pacingMs: 2500,
    timeoutMs: 10000,
    overallTimeoutMs: 60000,
  }),
  httpAttempts: 2,
  maxHttpAttemptsAllowed: 2,
  pacingEnforcedMs: 2500,
  contextSlots: Object.freeze({
    bootstrapSlot: 461970865,
    batchSlot: 461970878,
    minContextSlotEnforced: true,
    staleSlotDetected: false,
  }),
  requests: [],
  discoveredIdentities: Object.freeze({
    poolId: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
    lpMint: "89ZKE4aoyfLBe2RuV6jM3JGNhaV18Nxh8eNtjRcndBip",
    baseVault: "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX",
    quoteVault: "3mEFzHsJyu2Cpjrz6zPmTzP7uoLFj9SbbecGVzzkL1mJ",
    expectedTokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  }),
  canonicalAmmAuthority: Object.freeze({
    address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
    bump: 254,
  }),
  outcomes: Object.freeze({
    retrievalOk: true,
    structuralValidationOk: true,
    meetsNinetyPercentThreshold: false,
  }),
  validationResult: null,
  accounting: Object.freeze({
    ok: true,
    protocolLp: 362937054696n,
    circulatingSupply: 362444613518n,
    rawInaccessibleLp: 492441178n,
    rawDenominator: 362937054696n,
    meetsNinetyPercentThreshold: false,
    displayInaccessiblePct: 0.135682,
  }),
  failureReason: null,
  evidenceBoundary: Object.freeze({
    bytecodeEquivalenceVerified: false,
    completeExecutableReservesVerified: false,
    generalTokenSafetyVerified: false,
    strategyGateAdmitted: false,
  }),
});

/**
 * [SYNTHETIC TEST CONTEXT]:
 * Creates a synthetic candidate pool record wrapping the authentic RAY/WSOL identities.
 * All non-LP market fields (liquidity, market cap, volume, trades) are synthetic mocks
 * constructed strictly for candidate scanner offline tests.
 */
export function createSyntheticRayCandidatePool(
  overrides?: Partial<ScannedPoolRecord>,
): ScannedPoolRecord {
  return {
    poolId: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
    mintAddress: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    symbol: "RAY",
    decimals: 6,
    baseMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    // [SYNTHETIC TEST CONTEXT]: Mock market metrics for offline testing
    liquidityUsd: 125_000,
    marketCapUsd: 500_000,
    openTimeSec: 1_700_000_000,
    lpBurnPct: 0, // Unset before bridge evaluation
    mintAuthority: null, // Renounced
    freezeAuthority: null, // Renounced
    volume5mUsd: 25_000,
    txCount5m: 50,
    buys5m: 30,
    sells5m: 20,
    spotPriceUsd: 1.75,
    spotPriceSol: 0.012,
    fetchedAt: "2026-10-27T06:35:11.779Z",
    metricProvenance: {
      liquidityUsd: "OBSERVED",
      marketCapUsd: "OBSERVED",
      lpBurnPct: "UNAVAILABLE",
    },
    ...overrides,
  };
}

/**
 * [SYNTHETIC TEST CONTEXT]:
 * Synthetic qualified snapshot fixture representing an AMM v4 pool where 98.5% of LP tokens
 * are locked or burned (100n * (L - S) >= 90n * L).
 */
export const SYNTHETIC_QUALIFIED_LP_EVIDENCE: SnapshotAcquisitionEvidence = Object.freeze({
  ...CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
  evidenceOrigin: "SYNTHETIC_FIXTURE",
  isSyntheticFixture: true,
  outcomes: Object.freeze({
    retrievalOk: true,
    structuralValidationOk: true,
    meetsNinetyPercentThreshold: true,
  }),
  accounting: Object.freeze({
    ok: true,
    protocolLp: 1_000_000_000_000n,
    circulatingSupply: 15_000_000_000n, // 1.5% circulating -> 98.5% inaccessible
    rawInaccessibleLp: 985_000_000_000n,
    rawDenominator: 1_000_000_000_000n,
    meetsNinetyPercentThreshold: true,
    displayInaccessiblePct: 98.5,
  }),
});
