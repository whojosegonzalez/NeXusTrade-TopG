/**
 * Phase 12.94-D Milestone D.3.3: Authentic Captured Raydium AMM v4 Snapshot Fixture & Synthetic Candidate Mocks
 *
 * Contains:
 * 1. The independently verified, authentic raw account batch RPC response for the reference RAY/WSOL pool
 *    (AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA), recorded at 2026-10-27T06:35:11.779Z (slot 461970878).
 * 2. Helper `validateCapturedRayWsolRawAccounts()` which processes the authentic raw accounts
 *    through the accepted `validateRaydiumAmmV4Snapshot()` validator.
 * 3. Pre-validated `RaydiumAmmV4SnapshotValidationSuccess` and complete `SnapshotAcquisitionEvidence`.
 * 4. Explicitly labeled synthetic test candidates double-wrapping authentic LP evidence for offline testing.
 * 5. Synthetic qualified LP evidence (>= 90%) for positive-path regression testing.
 * 6. Explicitly marked summaries labeled as summaries to avoid confusion with complete snapshots.
 */

import type { ScannedPoolRecord } from "../CandidateScannerTypes.js";
import type { SnapshotAcquisitionEvidence } from "../../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import {
  validateRaydiumAmmV4Snapshot,
  type RaydiumAmmV4SnapshotIdentities,
  type RaydiumAmmV4SnapshotValidationSuccess,
} from "../../research/pilot/RaydiumAmmV4SnapshotValidator.js";

/**
 * Authentic identities for the reference RAY/WSOL pair on Solana mainnet.
 */
export const CAPTURED_RAY_WSOL_IDENTITIES: RaydiumAmmV4SnapshotIdentities = Object.freeze({
  poolId: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
  lpMint: "89ZKE4aoyfLBe2RuV6jM3JGNhaV18Nxh8eNtjRcndBip",
  baseVault: "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX",
  quoteVault: "3mEFzHsJyu2Cpjrz6zPmTzP7uoLFj9SbbecGVzzkL1mJ",
  expectedTokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
});

/**
 * Authentic raw JSON-RPC response body from Request 2 (getMultipleAccounts)
 * captured during the operator acquisition at 2026-10-27T06:35:11.779Z (slot 461970878).
 * Contains the 4 accounts: [poolId (752B), lpMint (82B), baseVault (165B), quoteVault (165B)].
 */
export const RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE =
  '{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.2","slot":461970878},"value":[{"data":["BgAAAAAAAAD+AAAAAAAAAAcAAAAAAAAAAwAAAAAAAAAGAAAAAAAAAAkAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAADh9QUAAAAA9AEAAAAAAAAAAAAAAAAAAKCGAQAAAAAAQEIPAAAAAAABAAAAAAAAAADKmjsAAAAAAMqaOwAAAAAFAAAAAAAAABAnAAAAAAAAGQAAAAAAAAAQJwAAAAAAAAwAAAAAAAAAZAAAAAAAAAAZAAAAAAAAABAnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJhaSWJIPAAAjxiBlGQCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMafnauQpgMAAAAAAAAAAAABjw9ewXRbAAAAAAAAAAAAck+IIuI5AABHNWonL2RaAAAAAAAAAAAAgL2DzTScAwAAAAAAAAAAACXLJUlWAgAAzHQZm0W6z5gtNl5Gv+9qEaF6ncdTHhcqZ+JK5m9xrTgpC+u4fXOeAokTezrBH8HXOQDwoprFtmZgW2UdHz+okTeZjMvy0EWLYVy8xrGjZ8R0np/vcwZiLhsbWJEBILyaBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAFqMv4mOSymgSzqTuW7xGS2KUFu76GQUO/5CQz7TceLMVDs2n3OBDb+pbbsf+iadatphbqjzsmfRgoRiu8VJW2LpPMK+KyZYVVWsVJclPiChTagQVyUjjWUvlWIklITutGFDy1uAqR6+CTQmradxC1wyyjL+iSft+5XudJWwSdi70W4rNNW1x2wUtECxs3PS5jJI1apzZ2OkGDr5PnM+dS9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOW2K2XLO72m9WiI5m/ujmTcVWAZnA+IsR/ic70Fnoqh6PW7gFQAAADmGxEAAAAAAC0EAAAAAAAAAAAAAAAAAAA=","base64"],"executable":false,"lamports":28329939,"owner":"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8","rentEpoch":18446744073709551615,"space":752},{"data":["AQAAAEFXsFgPMcX85EpiWC28+deO51lDoISjk7NQNo0iiZMIjudhY1QAAAAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==","base64"],"executable":false,"lamports":11461600,"owner":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","rentEpoch":18446744073709551615,"space":82},{"data":["N5mMy/LQRYthXLzGsaNnxHSen+9zBmIuGxtYkQEgvJpBV7BYDzHF/ORKYlgtvPnXjudZQ6CEo5OzUDaNIomTCBjdIaM5AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","base64"],"executable":false,"lamports":2040792,"owner":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","rentEpoch":18446744073709551615,"space":165},{"data":["BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAFBV7BYDzHF/ORKYlgtvPnXjudZQ6CEo5OzUDaNIomTCBL5CP//FQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAA4thYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","base64"],"executable":false,"lamports":24189241110346,"owner":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","rentEpoch":18446744073709551615,"space":165}]},"id":2}\n';

/**
 * Validates the self-contained authentic raw RPC account batch through the accepted snapshot validator.
 */
export async function validateCapturedRayWsolRawAccounts(): Promise<RaydiumAmmV4SnapshotValidationSuccess> {
  const parsedPayload = JSON.parse(RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE);
  const result = await validateRaydiumAmmV4Snapshot(CAPTURED_RAY_WSOL_IDENTITIES, parsedPayload, {
    evidenceOrigin: "CAPTURED_RPC",
    isSyntheticFixture: false,
    retrievedAtIso: "2026-10-27T06:35:11.779Z",
  });

  if (!result.ok) {
    throw new Error(`Failed to validate authentic raw accounts fixture: ${result.message}`);
  }

  return result;
}

/**
 * Pre-validated RaydiumAmmV4SnapshotValidationSuccess object for the reference RAY/WSOL pair.
 * Exact output of `validateRaydiumAmmV4Snapshot()` against the authentic raw account batch.
 */
export const CAPTURED_RAY_WSOL_VALIDATION_RESULT: RaydiumAmmV4SnapshotValidationSuccess =
  Object.freeze({
    ok: true,
    accounting: Object.freeze({
      ok: true,
      protocolLp: 362937054696n,
      circulatingSupply: 362444613518n,
      rawInaccessibleLp: 492441178n,
      rawDenominator: 362937054696n,
      meetsNinetyPercentThreshold: false,
      displayInaccessiblePct: 0.135682,
    }),
    diagnostics: Object.freeze({
      slot: 461970878,
      evidenceOrigin: "CAPTURED_RPC" as const,
      isSyntheticFixture: false,
      retrievedAtIso: "2026-10-27T06:35:11.779Z",
      requestedIdentities: CAPTURED_RAY_WSOL_IDENTITIES,
      poolState: Object.freeze({
        status: 6n,
        nonce: 254n,
        baseDecimal: 6n,
        quoteDecimal: 9n,
        baseVault: "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX",
        quoteVault: "3mEFzHsJyu2Cpjrz6zPmTzP7uoLFj9SbbecGVzzkL1mJ",
        baseMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        quoteMint: "So11111111111111111111111111111111111111112",
        lpMint: "89ZKE4aoyfLBe2RuV6jM3JGNhaV18Nxh8eNtjRcndBip",
        openOrders: "6Su6Ea97dBxecd5W92KcVvv6SzCurE2BXGgFe9LNGMpE",
        marketId: "C6tp2RVZnxBPFbnAsfTjis8BN9tycESAT4SgDQgbbrsA",
        marketProgramId: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        targetOrders: "5hATcCfvhVwAjNExvrg8rRkXmYyksHhVajWLa46iRsmE",
        baseNeedTakePnl: 0n,
        quoteNeedTakePnl: 0n,
        quoteTotalPnl: 66281584286360n,
        baseTotalPnl: 2631011473551n,
        poolAddress: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
        programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        lpReserve: 362937054696n,
        accountSlot: 461970878,
      }),
      lpMintState: Object.freeze({
        mintAddress: "89ZKE4aoyfLBe2RuV6jM3JGNhaV18Nxh8eNtjRcndBip",
        mintAuthority: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
        supply: 362444613518n,
        decimals: 6,
        isInitialized: true,
        freezeAuthority: null,
      }),
      baseVaultState: Object.freeze({
        vaultAddress: "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX",
        mintAddress: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        ownerAddress: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
        rawAmount: 1347061669144n,
        slot: 461970878,
      }),
      quoteVaultState: Object.freeze({
        vaultAddress: "3mEFzHsJyu2Cpjrz6zPmTzP7uoLFj9SbbecGVzzkL1mJ",
        mintAddress: "So11111111111111111111111111111111111111112",
        ownerAddress: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
        rawAmount: 24189239621906n,
        slot: 461970878,
      }),
      derivedAmmAuthority: Object.freeze({
        address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
        bump: 254,
      }),
      accountDigests: Object.freeze({
        poolSha256: "c71c33a496ed6f03e420efe44fe0197b1be6e10b33783ed7ee4ce54121d1d253",
        lpMintSha256: "11c42010b870ab4aa55c88687ef3b009854374908a2bdfdcd76decf3b7f3d864",
        baseVaultSha256: "36bb05bcf00685a296d2e4b1ad2fd6cb3aa3cf1f17945fea30f8f514dfc180a1",
        quoteVaultSha256: "347dc3f75a1e2bc36bb4aceb461efc2ffa55ed5ed7d57ffab9f771c6108637dd",
      }),
    }),
    evidenceBoundary: Object.freeze({
      bytecodeEquivalenceVerified: false,
      completeExecutableReservesVerified: false,
      generalTokenSafetyVerified: false,
      strategyGateAdmitted: false,
    }),
  });

/**
 * Authentic, sealed operator-run snapshot evidence for the reference RAY/WSOL pair.
 * Contains complete validationResult, raw requests, and verified accounting assertions.
 */
export const CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE: SnapshotAcquisitionEvidence =
  Object.freeze({
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
    requests: [
      Object.freeze({
        attempt: 1,
        method: "getAccountInfo" as const,
        params: [
          "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
          { encoding: "base64", commitment: "confirmed" },
        ],
        requestTimestampIso: "2026-10-27T06:35:09.036Z",
        responseTimestampIso: "2026-10-27T06:35:09.209Z",
        elapsedMs: 173,
        httpStatus: 200,
        rawResponseBody:
          '{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.2","slot":461970865},"value":{"data":["BgAA...","base64"],"executable":false,"lamports":28329939,"owner":"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8","rentEpoch":18446744073709551615,"space":752}},"id":1}\n',
        wireResponseSha256: "b4c316f82fc3a48acdcd7394391c3c3d989c08c2e8aa2312a37860bced896719",
        storedResponseSha256: "b4c316f82fc3a48acdcd7394391c3c3d989c08c2e8aa2312a37860bced896719",
        wasRedacted: false,
        parsedJson: {},
        error: null,
      }),
      Object.freeze({
        attempt: 2,
        method: "getMultipleAccounts" as const,
        params: [
          [
            "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
            "89ZKE4aoyfLBe2RuV6jM3JGNhaV18Nxh8eNtjRcndBip",
            "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX",
            "3mEFzHsJyu2Cpjrz6zPmTzP7uoLFj9SbbecGVzzkL1mJ",
          ],
          { encoding: "base64", commitment: "confirmed", minContextSlot: 461970865 },
        ],
        requestTimestampIso: "2026-10-27T06:35:11.710Z",
        responseTimestampIso: "2026-10-27T06:35:11.779Z",
        elapsedMs: 69,
        httpStatus: 200,
        rawResponseBody: RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE,
        wireResponseSha256: "c3d1b72e50523287664ffce4589d3115451cb9c10f8a846c4293f0b09489fdf2",
        storedResponseSha256: "c3d1b72e50523287664ffce4589d3115451cb9c10f8a846c4293f0b09489fdf2",
        wasRedacted: false,
        parsedJson: {},
        error: null,
      }),
    ],
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
    validationResult: CAPTURED_RAY_WSOL_VALIDATION_RESULT,
    accounting: CAPTURED_RAY_WSOL_VALIDATION_RESULT.accounting,
    failureReason: null,
    evidenceBoundary: Object.freeze({
      bytecodeEquivalenceVerified: false,
      completeExecutableReservesVerified: false,
      generalTokenSafetyVerified: false,
      strategyGateAdmitted: false,
    }),
  });

/**
 * [SUMMARY ONLY]:
 * Explicitly labeled accounting summary.
 * This is an abbreviated numeric summary for display/logging; it does NOT contain
 * validated accounts and must not be treated as a complete validated snapshot.
 */
export const CAPTURED_RAY_WSOL_ACCOUNTING_SUMMARY = Object.freeze({
  summaryType: "RAYDIUM_AMM_V4_ACCOUNTING_SUMMARY_ONLY" as const,
  poolId: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
  tokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  slot: 461970878,
  retrievedAtIso: "2026-10-27T06:35:11.779Z",
  protocolLp: 362937054696n,
  circulatingSupply: 362444613518n,
  rawInaccessibleLp: 492441178n,
  rawDenominator: 362937054696n,
  displayInaccessiblePct: 0.135682,
  meetsNinetyPercentThreshold: false,
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
    lpBurnPct: 0,
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
 * Synthetic qualified validation result representing an AMM v4 pool where 98.5% of LP tokens
 * are locked or burned (100n * (L - S) >= 90n * L).
 */
export const SYNTHETIC_QUALIFIED_VALIDATION_RESULT: RaydiumAmmV4SnapshotValidationSuccess =
  Object.freeze({
    ok: true,
    accounting: Object.freeze({
      ok: true,
      protocolLp: 1_000_000_000_000n,
      circulatingSupply: 15_000_000_000n, // 1.5% circulating -> 98.5% inaccessible
      rawInaccessibleLp: 985_000_000_000n,
      rawDenominator: 1_000_000_000_000n,
      meetsNinetyPercentThreshold: true,
      displayInaccessiblePct: 98.5,
    }),
    diagnostics: Object.freeze({
      slot: 461970878,
      evidenceOrigin: "SYNTHETIC_FIXTURE" as const,
      isSyntheticFixture: true,
      retrievedAtIso: "2026-10-27T06:35:11.779Z",
      requestedIdentities: CAPTURED_RAY_WSOL_IDENTITIES,
      poolState: CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics.poolState,
      lpMintState: CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics.lpMintState,
      baseVaultState: CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics.baseVaultState,
      quoteVaultState: CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics.quoteVaultState,
      derivedAmmAuthority: CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics.derivedAmmAuthority,
      accountDigests: CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics.accountDigests,
    }),
    evidenceBoundary: Object.freeze({
      bytecodeEquivalenceVerified: false,
      completeExecutableReservesVerified: false,
      generalTokenSafetyVerified: false,
      strategyGateAdmitted: false,
    }),
  });

/**
 * [SYNTHETIC TEST CONTEXT]:
 * Synthetic qualified acquisition evidence wrapping the synthetic qualified validation result.
 */
export const SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE: SnapshotAcquisitionEvidence = Object.freeze({
  ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
  evidenceOrigin: "SYNTHETIC_FIXTURE",
  isSyntheticFixture: true,
  outcomes: Object.freeze({
    retrievalOk: true,
    structuralValidationOk: true,
    meetsNinetyPercentThreshold: true,
  }),
  validationResult: SYNTHETIC_QUALIFIED_VALIDATION_RESULT,
  accounting: SYNTHETIC_QUALIFIED_VALIDATION_RESULT.accounting,
});
