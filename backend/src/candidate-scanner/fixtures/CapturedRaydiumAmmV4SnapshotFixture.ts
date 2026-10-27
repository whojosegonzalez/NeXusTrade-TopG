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

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { ScannedPoolRecord } from "../CandidateScannerTypes.js";
import type { SnapshotAcquisitionEvidence } from "../../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import {
  validateRaydiumAmmV4Snapshot,
  type RaydiumAmmV4SnapshotIdentities,
  type RaydiumAmmV4SnapshotValidationSuccess,
} from "../../research/pilot/RaydiumAmmV4SnapshotValidator.js";
import { RAYDIUM_V4_OFFSETS, SPL_VAULT_OFFSETS } from "../../research/pilot/RaydiumAmmParser.js";

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
 * Authentic raw JSON-RPC response body from Request 1 (getAccountInfo for pool)
 * captured during the operator acquisition at 2026-10-27T06:35:09.209Z (slot 461970865).
 * Contains the 752-byte Raydium AMM v4 pool account state.
 */
export const RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE =
  '{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.2","slot":461970865},"value":{"data":["BgAAAAAAAAD+AAAAAAAAAAcAAAAAAAAAAwAAAAAAAAAGAAAAAAAAAAkAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAADh9QUAAAAA9AEAAAAAAAAAAAAAAAAAAKCGAQAAAAAAQEIPAAAAAAABAAAAAAAAAADKmjsAAAAAAMqaOwAAAAAFAAAAAAAAABAnAAAAAAAAGQAAAAAAAAAQJwAAAAAAAAwAAAAAAAAAZAAAAAAAAAAZAAAAAAAAABAnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJhaSWJIPAAAjxiBlGQCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMafnauQpgMAAAAAAAAAAAABjw9ewXRbAAAAAAAAAAAAck+IIuI5AABHNWonL2RaAAAAAAAAAAAAgL2DzTScAwAAAAAAAAAAACXLJUlWAgAAzHQZm0W6z5gtNl5Gv+9qEaF6ncdTHhcqZ+JK5m9xrTgpC+u4fXOeAokTezrBH8HXOQDwoprFtmZgW2UdHz+okTeZjMvy0EWLYVy8xrGjZ8R0np/vcwZiLhsbWJEBILyaBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAFqMv4mOSymgSzqTuW7xGS2KUFu76GQUO/5CQz7TceLMVDs2n3OBDb+pbbsf+iadatphbqjzsmfRgoRiu8VJW2LpPMK+KyZYVVWsVJclPiChTagQVyUjjWUvlWIklITutGFDy1uAqR6+CTQmradxC1wyyjL+iSft+5XudJWwSdi70W4rNNW1x2wUtECxs3PS5jJI1apzZ2OkGDr5PnM+dS9AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOW2K2XLO72m9WiI5m/ujmTcVWAZnA+IsR/ic70Fnoqh6PW7gFQAAADmGxEAAAAAAC0EAAAAAAAAAAAAAAAAAAA=","base64"],"executable":false,"lamports":28329939,"owner":"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8","rentEpoch":18446744073709551615,"space":752}},"id":1}\n';

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
        rawResponseBody: RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE,
        wireResponseSha256: "b4c316f82fc3a48acdcd7394391c3c3d989c08c2e8aa2312a37860bced896719",
        storedResponseSha256: "b4c316f82fc3a48acdcd7394391c3c3d989c08c2e8aa2312a37860bced896719",
        wasRedacted: false,
        parsedJson: JSON.parse(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE),
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
        wireResponseSha256: "621735cd561b0cffe9aa7ff4fc5847c6e026950508fec023869cba5c6277feaf",
        storedResponseSha256: "621735cd561b0cffe9aa7ff4fc5847c6e026950508fec023869cba5c6277feaf",
        wasRedacted: false,
        parsedJson: JSON.parse(RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE),
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
 * Creates a coherent synthetic raw JSON-RPC response payload by writing exact integer
 * byte quantities into the authentic Raydium AMM v4 (752B) and SPL mint (82B) binary buffers.
 */
export function createSyntheticRaydiumAmmV4RawBatchPayload(
  lpReserve: bigint,
  lpSupply: bigint,
  options?: {
    slot?: number | undefined;
    baseMint?: string | undefined;
  },
): Record<string, unknown> {
  const baseParsed = JSON.parse(RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE) as {
    jsonrpc: string;
    result: {
      context: { apiVersion: string; slot: number };
      value: Array<{
        data: [string, string];
        executable: boolean;
        lamports: number;
        owner: string;
        rentEpoch: number;
        space: number;
      }>;
    };
    id: number;
  };

  const slot = options?.slot ?? 461970878;
  baseParsed.result.context.slot = slot;

  // Account 0: Pool account (752 bytes). Write lpReserve at offset 720.
  const poolBuf = Buffer.from(baseParsed.result.value[0]!.data[0], "base64");
  poolBuf.writeBigUInt64LE(lpReserve, RAYDIUM_V4_OFFSETS.LP_RESERVE);
  if (options?.baseMint) {
    const baseMintBytes = Buffer.from(new PublicKey(options.baseMint).toBytes());
    baseMintBytes.copy(poolBuf, RAYDIUM_V4_OFFSETS.BASE_MINT);
  }
  baseParsed.result.value[0]!.data[0] = poolBuf.toString("base64");

  // Account 1: LP Mint account (82 bytes). Write supply at offset 36.
  const lpMintBuf = Buffer.from(baseParsed.result.value[1]!.data[0], "base64");
  lpMintBuf.writeBigUInt64LE(lpSupply, 36);
  baseParsed.result.value[1]!.data[0] = lpMintBuf.toString("base64");

  // Account 2: Base Vault account (165 bytes). Write baseMint at offset 0 if overridden.
  if (options?.baseMint) {
    const baseVaultBuf = Buffer.from(baseParsed.result.value[2]!.data[0], "base64");
    const baseMintBytes = Buffer.from(new PublicKey(options.baseMint).toBytes());
    baseMintBytes.copy(baseVaultBuf, SPL_VAULT_OFFSETS.MINT);
    baseParsed.result.value[2]!.data[0] = baseVaultBuf.toString("base64");
  }

  return baseParsed;
}

/**
 * Validates a coherent synthetic raw accounts batch through the accepted snapshot validator.
 * Derives diagnostics, account digests, authority, and accounting purely from raw accounts.
 */
export async function validateSyntheticRaydiumAmmV4Snapshot(
  lpReserve: bigint,
  lpSupply: bigint,
  options?: {
    slot?: number | undefined;
    baseMint?: string | undefined;
    expectedTokenMint?: string | undefined;
    retrievedAtIso?: string | undefined;
  },
): Promise<RaydiumAmmV4SnapshotValidationSuccess> {
  const payload = createSyntheticRaydiumAmmV4RawBatchPayload(lpReserve, lpSupply, options);
  const identities: RaydiumAmmV4SnapshotIdentities = {
    ...CAPTURED_RAY_WSOL_IDENTITIES,
    ...(options?.expectedTokenMint !== undefined
      ? { expectedTokenMint: options.expectedTokenMint }
      : options?.baseMint !== undefined
        ? { expectedTokenMint: options.baseMint }
        : {}),
  };

  const result = await validateRaydiumAmmV4Snapshot(identities, payload, {
    evidenceOrigin: "SYNTHETIC_FIXTURE",
    isSyntheticFixture: true,
    retrievedAtIso: options?.retrievedAtIso ?? "2026-10-27T06:35:11.779Z",
  });

  if (!result.ok) {
    throw new Error(`Failed to validate synthetic raw snapshot: ${result.message}`);
  }

  return result;
}

/**
 * Helper to build coherent SnapshotAcquisitionEvidence from a verified synthetic validation result
 * and its underlying synthetic raw batch payload.
 */
export function buildSyntheticAcquisitionEvidence(
  validationSuccess: RaydiumAmmV4SnapshotValidationSuccess,
  rawPayload: Record<string, unknown>,
): SnapshotAcquisitionEvidence {
  const rawBodyStr = JSON.stringify(rawPayload);
  const hash = createHash("sha256").update(rawBodyStr).digest("hex");
  const retrievedAtIso = validationSuccess.diagnostics.retrievedAtIso ?? "2026-10-27T06:35:11.779Z";

  return Object.freeze({
    schemaVersion: "1.0",
    command: "RaydiumAmmV4SnapshotAcquisition",
    executionMode: "LIVE_ACQUISITION",
    evidenceOrigin: "SYNTHETIC_FIXTURE",
    isSyntheticFixture: true,
    retrievedAtIso,
    startedAtIso: "2026-10-27T06:35:09.026Z",
    completedAtIso: retrievedAtIso,
    endpoint: Object.freeze({
      sanitizedUrl: "https://synthetic.rpc.provider.internal/",
      host: "synthetic.rpc.provider.internal",
      endpointFingerprint: "sha256:0000000000000000",
    }),
    config: Object.freeze({
      poolId: validationSuccess.diagnostics.requestedIdentities.poolId,
      expectedTokenMint:
        validationSuccess.diagnostics.requestedIdentities.expectedTokenMint ?? null,
      pacingMs: 2500,
      timeoutMs: 10000,
      overallTimeoutMs: 60000,
    }),
    httpAttempts: 2,
    maxHttpAttemptsAllowed: 2,
    pacingEnforcedMs: 2500,
    contextSlots: Object.freeze({
      bootstrapSlot: 461970865,
      batchSlot: validationSuccess.diagnostics.slot,
      minContextSlotEnforced: true,
      staleSlotDetected: false,
    }),
    requests: Object.freeze([
      Object.freeze({
        attempt: 1,
        method: "getAccountInfo" as const,
        params: Object.freeze([
          validationSuccess.diagnostics.requestedIdentities.poolId,
          Object.freeze({ encoding: "base64", commitment: "confirmed" }),
        ]),
        requestTimestampIso: "2026-10-27T06:35:09.026Z",
        responseTimestampIso: "2026-10-27T06:35:09.183Z",
        elapsedMs: 157,
        httpStatus: 200,
        rawResponseBody: RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE,
        wireResponseSha256: "b4c316f82fc3a48acdcd7394391c3c3d989c08c2e8aa2312a37860bced896719",
        storedResponseSha256: "b4c316f82fc3a48acdcd7394391c3c3d989c08c2e8aa2312a37860bced896719",
        wasRedacted: false,
        parsedJson: JSON.parse(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE),
        error: null,
      }),
      Object.freeze({
        attempt: 2,
        method: "getMultipleAccounts" as const,
        params: Object.freeze([
          Object.freeze([
            validationSuccess.diagnostics.requestedIdentities.poolId,
            validationSuccess.diagnostics.requestedIdentities.lpMint,
            validationSuccess.diagnostics.requestedIdentities.baseVault,
            validationSuccess.diagnostics.requestedIdentities.quoteVault,
          ]),
          Object.freeze({
            encoding: "base64",
            commitment: "confirmed",
            minContextSlot: 461970865,
          }),
        ]),
        requestTimestampIso: "2026-10-27T06:35:11.721Z",
        responseTimestampIso: retrievedAtIso,
        elapsedMs: 58,
        httpStatus: 200,
        rawResponseBody: rawBodyStr,
        wireResponseSha256: hash,
        storedResponseSha256: hash,
        wasRedacted: false,
        parsedJson: rawPayload,
        error: null,
      }),
    ]),
    discoveredIdentities: Object.freeze(validationSuccess.diagnostics.requestedIdentities),
    canonicalAmmAuthority: Object.freeze({
      address: validationSuccess.diagnostics.derivedAmmAuthority.address,
      bump: validationSuccess.diagnostics.derivedAmmAuthority.bump,
    }),
    outcomes: Object.freeze({
      retrievalOk: true,
      structuralValidationOk: true,
      meetsNinetyPercentThreshold: validationSuccess.accounting.meetsNinetyPercentThreshold,
    }),
    validationResult: validationSuccess,
    accounting: validationSuccess.accounting,
    failureReason: null,
    evidenceBoundary: Object.freeze({
      bytecodeEquivalenceVerified: false,
      completeExecutableReservesVerified: false,
      generalTokenSafetyVerified: false,
      strategyGateAdmitted: false,
    }),
  });
}

/**
 * [SYNTHETIC TEST CONTEXT]:
 * Authentic raw batch payload for the synthetic 98.5% qualified fixture.
 * 1_000_000_000_000n protocol LP, 15_000_000_000n circulating supply -> 985_000_000_000n inaccessible (98.5%).
 */
export const SYNTHETIC_QUALIFIED_RAW_PAYLOAD = createSyntheticRaydiumAmmV4RawBatchPayload(
  1_000_000_000_000n,
  15_000_000_000n,
);

/**
 * [SYNTHETIC TEST CONTEXT]:
 * Synthetic qualified validation result rebuilt from coherent synthetic raw accounts
 * passed through validateRaydiumAmmV4Snapshot().
 */
export const SYNTHETIC_QUALIFIED_VALIDATION_RESULT: RaydiumAmmV4SnapshotValidationSuccess =
  (await validateRaydiumAmmV4Snapshot(
    CAPTURED_RAY_WSOL_IDENTITIES,
    SYNTHETIC_QUALIFIED_RAW_PAYLOAD,
    {
      evidenceOrigin: "SYNTHETIC_FIXTURE",
      isSyntheticFixture: true,
      retrievedAtIso: "2026-10-27T06:35:11.779Z",
    },
  )) as RaydiumAmmV4SnapshotValidationSuccess;

/**
 * [SYNTHETIC TEST CONTEXT]:
 * Synthetic qualified acquisition evidence wrapping the synthetic qualified validation result
 * and its matching raw batch RPC payload.
 */
export const SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE: SnapshotAcquisitionEvidence =
  buildSyntheticAcquisitionEvidence(
    SYNTHETIC_QUALIFIED_VALIDATION_RESULT,
    SYNTHETIC_QUALIFIED_RAW_PAYLOAD,
  );
