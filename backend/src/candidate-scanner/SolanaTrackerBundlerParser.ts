/**
 * Phase 12.94-D: Solana Tracker Bundlers Response Parser (Offline Validation)
 *
 * Implements a pure offline response validator and normalizer for the documented
 * Solana Tracker GET /tokens/{token}/bundlers endpoint:
 * https://docs.solanatracker.io/data-api/tokens/get-token-bundlers
 *
 * Strict Architectural Guarantees:
 * 1. Top-Level Field Validation:
 *    Validates documented top-level fields: total, balance, percentage, initialBalance,
 *    initialPercentage, and optional wallets sample array.
 * 2. Distinct Metric Separation:
 *    Preserves current holdings percentage and initial launch percentage separately.
 *    Never substitutes one for the other.
 * 3. Exact Normalization:
 *    Validates finite numbers in [0, 100], then explicitly normalizes to [0.0, 1.0] by dividing by 100.
 * 4. Zero Preservation without Auto-Coercion:
 *    Preserves genuine reported zeros. Rejects numeric strings, non-finite values (NaN, Infinity),
 *    negative values, and out-of-range percentages without manufacturing favorable defaults.
 * 5. Explicit Request-Mint Binding:
 *    Binds the snapshot to the requested token mint via request metadata and canonical Solana
 *    base58 validation. Does NOT claim the response payload self-authenticates the mint.
 * 6. Timestamp Separation:
 *    Records local retrieval timestamp from request metadata. Leaves upstream snapshot as-of
 *    time strictly null (wallet bundleTime represents individual transaction execution, not snapshot time).
 * 7. No Wallet List Aggregation:
 *    Does NOT reconstruct concentration by summing wallet list entries; the endpoint documents
 *    a limited sample, not an exhaustive registry.
 * 8. Strategy Isolation:
 *    Classified as PROVIDER_REPORTED_UNVERIFIED. Does NOT populate strategy bundlerPct,
 *    does NOT alter Gate 11, and does NOT permit candidate admission.
 */

import { isCanonicalSolanaBase58 } from "./LpScreeningBridge.js";

export type SolanaTrackerBundlerParseErrorCode =
  | "INVALID_REQUEST_METADATA"
  | "INVALID_REQUESTED_MINT"
  | "INVALID_LOCAL_TIMESTAMP"
  | "MALFORMED_PAYLOAD"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_TOTAL_COUNT"
  | "INVALID_BALANCE"
  | "INVALID_PERCENTAGE"
  | "INVALID_INITIAL_BALANCE"
  | "INVALID_INITIAL_PERCENTAGE"
  | "INVALID_WALLETS_SAMPLE";

export interface SolanaTrackerBundlerParseRequestMetadata {
  readonly requestedMint: string;
  readonly localRetrievedAtMs: number;
}

export interface SolanaTrackerWalletSampleEntry {
  readonly wallet?: string | undefined;
  readonly balance?: number | undefined;
  readonly percentage?: number | undefined;
  readonly initialBalance?: number | undefined;
  readonly initialPercentage?: number | undefined;
  readonly bundleTime?: number | undefined;
}

export interface SolanaTrackerBundlerSnapshot {
  readonly provider: "SOLANA_TRACKER";
  readonly dataSource: "PROVIDER_REPORTED_UNVERIFIED";
  readonly requestedMint: string;
  readonly totalBundlersCount: number;
  readonly currentHoldingBalance: number;
  readonly currentHoldingPct: number; // Normalized [0.0, 1.0]
  readonly initialBalance: number;
  readonly initialPct: number; // Normalized [0.0, 1.0]
  readonly reportedRawCurrentPct: number; // Raw [0, 100]
  readonly reportedRawInitialPct: number; // Raw [0, 100]
  readonly walletSampleCount: number;
  readonly walletSample: readonly SolanaTrackerWalletSampleEntry[];
  readonly localRetrievedAtMs: number;
  readonly upstreamSnapshotTimeMs: null;
  readonly isProviderAccuracyVerified: false;
  readonly isLaunchHistoryComplete: false;
  readonly isProductionCompletenessEstablished: false;
}

export interface SolanaTrackerBundlerParseSuccess {
  readonly success: true;
  readonly data: SolanaTrackerBundlerSnapshot;
}

export interface SolanaTrackerBundlerParseFailure {
  readonly success: false;
  readonly error: SolanaTrackerBundlerParseErrorCode;
  readonly message: string;
}

export type SolanaTrackerBundlerParseResult =
  | SolanaTrackerBundlerParseSuccess
  | SolanaTrackerBundlerParseFailure;

/**
 * Validates and normalizes raw JSON response data from Solana Tracker's /tokens/{token}/bundlers endpoint.
 *
 * Operates purely offline without network calls or external state mutation.
 */
export function parseSolanaTrackerBundlersResponse(
  raw: unknown,
  metadata: SolanaTrackerBundlerParseRequestMetadata,
): SolanaTrackerBundlerParseResult {
  // 1. Validate request metadata and requested mint binding
  if (!metadata || typeof metadata !== "object") {
    return {
      success: false,
      error: "INVALID_REQUEST_METADATA",
      message: "Request metadata must be a non-null object.",
    };
  }

  if (
    typeof metadata.requestedMint !== "string" ||
    !isCanonicalSolanaBase58(metadata.requestedMint)
  ) {
    return {
      success: false,
      error: "INVALID_REQUESTED_MINT",
      message: "Requested mint must be a canonical 32-byte Solana base58 public key.",
    };
  }

  if (
    typeof metadata.localRetrievedAtMs !== "number" ||
    !Number.isSafeInteger(metadata.localRetrievedAtMs) ||
    metadata.localRetrievedAtMs <= 0
  ) {
    return {
      success: false,
      error: "INVALID_LOCAL_TIMESTAMP",
      message: "localRetrievedAtMs must be a positive safe integer timestamp.",
    };
  }

  // 2. Validate payload envelope
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      success: false,
      error: "MALFORMED_PAYLOAD",
      message: "Response payload must be a non-null JSON object.",
    };
  }

  const payload = raw as Record<string, unknown>;

  // 3. Validate missing required top-level fields
  const requiredFields = ["total", "balance", "percentage", "initialBalance", "initialPercentage"];
  for (const field of requiredFields) {
    if (!(field in payload) || payload[field] === undefined || payload[field] === null) {
      return {
        success: false,
        error: "MISSING_REQUIRED_FIELD",
        message: `Missing required top-level field: '${field}'.`,
      };
    }
  }

  // 4. Validate total bundlers count (must be non-negative safe integer; no strings, no floats)
  const totalRaw = payload.total;
  if (typeof totalRaw !== "number" || !Number.isSafeInteger(totalRaw) || totalRaw < 0) {
    return {
      success: false,
      error: "INVALID_TOTAL_COUNT",
      message: "Field 'total' must be a finite, non-negative safe integer.",
    };
  }

  // 5. Validate current balance (must be finite non-negative number; no strings, no NaN)
  const balanceRaw = payload.balance;
  if (typeof balanceRaw !== "number" || !Number.isFinite(balanceRaw) || balanceRaw < 0) {
    return {
      success: false,
      error: "INVALID_BALANCE",
      message: "Field 'balance' must be a finite, non-negative number.",
    };
  }

  // 6. Validate initial balance (must be finite non-negative number; no strings, no NaN)
  const initialBalanceRaw = payload.initialBalance;
  if (
    typeof initialBalanceRaw !== "number" ||
    !Number.isFinite(initialBalanceRaw) ||
    initialBalanceRaw < 0
  ) {
    return {
      success: false,
      error: "INVALID_INITIAL_BALANCE",
      message: "Field 'initialBalance' must be a finite, non-negative number.",
    };
  }

  // 7. Validate current holdings percentage (finite number in [0, 100]; no strings, no auto-coercion)
  const percentageRaw = payload.percentage;
  if (
    typeof percentageRaw !== "number" ||
    !Number.isFinite(percentageRaw) ||
    percentageRaw < 0 ||
    percentageRaw > 100
  ) {
    return {
      success: false,
      error: "INVALID_PERCENTAGE",
      message: "Field 'percentage' must be a finite number between 0 and 100 inclusive.",
    };
  }

  // 8. Validate initial holdings percentage (finite number in [0, 100]; no strings, no auto-coercion)
  const initialPercentageRaw = payload.initialPercentage;
  if (
    typeof initialPercentageRaw !== "number" ||
    !Number.isFinite(initialPercentageRaw) ||
    initialPercentageRaw < 0 ||
    initialPercentageRaw > 100
  ) {
    return {
      success: false,
      error: "INVALID_INITIAL_PERCENTAGE",
      message: "Field 'initialPercentage' must be a finite number between 0 and 100 inclusive.",
    };
  }

  // 9. Validate optional wallets sample array
  let frozenWallets: readonly SolanaTrackerWalletSampleEntry[] = Object.freeze([]);
  if ("wallets" in payload && payload.wallets !== undefined && payload.wallets !== null) {
    if (!Array.isArray(payload.wallets)) {
      return {
        success: false,
        error: "INVALID_WALLETS_SAMPLE",
        message: "Field 'wallets', if provided, must be an array.",
      };
    }

    const parsedWallets: SolanaTrackerWalletSampleEntry[] = [];
    for (const w of payload.wallets) {
      if (!w || typeof w !== "object" || Array.isArray(w)) {
        return {
          success: false,
          error: "INVALID_WALLETS_SAMPLE",
          message: "Wallet sample entries must be non-null objects.",
        };
      }
      const wObj = w as Record<string, unknown>;
      const entry: SolanaTrackerWalletSampleEntry = Object.freeze({
        wallet: typeof wObj.wallet === "string" ? wObj.wallet : undefined,
        balance:
          typeof wObj.balance === "number" && Number.isFinite(wObj.balance) && wObj.balance >= 0
            ? wObj.balance
            : undefined,
        percentage:
          typeof wObj.percentage === "number" &&
          Number.isFinite(wObj.percentage) &&
          wObj.percentage >= 0 &&
          wObj.percentage <= 100
            ? wObj.percentage
            : undefined,
        initialBalance:
          typeof wObj.initialBalance === "number" &&
          Number.isFinite(wObj.initialBalance) &&
          wObj.initialBalance >= 0
            ? wObj.initialBalance
            : undefined,
        initialPercentage:
          typeof wObj.initialPercentage === "number" &&
          Number.isFinite(wObj.initialPercentage) &&
          wObj.initialPercentage >= 0 &&
          wObj.initialPercentage <= 100
            ? wObj.initialPercentage
            : undefined,
        bundleTime:
          typeof wObj.bundleTime === "number" &&
          Number.isSafeInteger(wObj.bundleTime) &&
          wObj.bundleTime >= 0
            ? wObj.bundleTime
            : undefined,
      });
      parsedWallets.push(entry);
    }
    frozenWallets = Object.freeze(parsedWallets);
  }

  // 10. Explicit normalization to [0.0, 1.0] by dividing by 100
  // Note: Never substitute currentPercentage for initialPercentage or vice-versa
  const currentHoldingPct = percentageRaw / 100;
  const initialPct = initialPercentageRaw / 100;

  // 11. Construct immutable, deeply frozen snapshot bound to requested mint
  const snapshot: SolanaTrackerBundlerSnapshot = Object.freeze({
    provider: "SOLANA_TRACKER",
    dataSource: "PROVIDER_REPORTED_UNVERIFIED",
    requestedMint: metadata.requestedMint,
    totalBundlersCount: totalRaw,
    currentHoldingBalance: balanceRaw,
    currentHoldingPct,
    initialBalance: initialBalanceRaw,
    initialPct,
    reportedRawCurrentPct: percentageRaw,
    reportedRawInitialPct: initialPercentageRaw,
    walletSampleCount: frozenWallets.length,
    walletSample: frozenWallets,
    localRetrievedAtMs: metadata.localRetrievedAtMs,
    upstreamSnapshotTimeMs: null, // Left strictly null: wallet bundleTime is not the snapshot as-of time
    isProviderAccuracyVerified: false,
    isLaunchHistoryComplete: false,
    isProductionCompletenessEstablished: false,
  });

  return {
    success: true,
    data: snapshot,
  };
}
