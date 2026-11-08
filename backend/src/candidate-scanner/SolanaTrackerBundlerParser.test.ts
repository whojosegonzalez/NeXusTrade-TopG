import { describe, expect, it } from "vitest";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import {
  MAX_SOLANA_TRACKER_WALLETS_SAMPLE_LIMIT,
  parseSolanaTrackerBundlersResponse,
  type SolanaTrackerBundlerParseRequestMetadata,
  type SolanaTrackerBundlerSnapshot,
  type SolanaTrackerWalletSampleEntry,
} from "./SolanaTrackerBundlerParser.js";
import { BuyGateTriggerService } from "./BuyGateTriggerService.js";
import {
  CAPTURED_SOLANA_TRACKER_METADATA,
  CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD,
} from "./fixtures/CapturedSolanaTrackerBundlerFixture.js";

// Canonical 32-byte Solana base58 public keys
const CANONICAL_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const CANONICAL_MINT_2 = "So11111111111111111111111111111111111111112";
const CANONICAL_WALLET_1 = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const CANONICAL_WALLET_2 = "So11111111111111111111111111111111111111112";

const validMetadata: SolanaTrackerBundlerParseRequestMetadata = Object.freeze({
  requestedMint: CANONICAL_MINT,
  localRetrievedAtMs: 1700000000000,
});

function createValidWalletEntry(
  overrides?: Partial<SolanaTrackerWalletSampleEntry>,
): SolanaTrackerWalletSampleEntry {
  return {
    wallet: CANONICAL_WALLET_1,
    balance: 3000000,
    percentage: 0.3,
    initialBalance: 10000000,
    initialPercentage: 1.0,
    bundleTime: 1712345678000,
    ...overrides,
  };
}

describe("SolanaTrackerBundlerParser", () => {
  describe("Documented Payload Validation", () => {
    it("parses valid documented Solana Tracker response with distinct initial and current values", () => {
      // Documented response example from https://docs.solanatracker.io/data-api/tokens/get-token-bundlers
      const documentedResponse = {
        total: 5,
        balance: 15000000,
        percentage: 1.5,
        initialBalance: 50000000,
        initialPercentage: 5.0,
        wallets: [
          createValidWalletEntry({
            wallet: CANONICAL_WALLET_1,
            balance: 3000000,
            percentage: 0.3,
            initialBalance: 10000000,
            initialPercentage: 1.0,
            bundleTime: 1712345678000,
          }),
        ],
      };

      const result = parseSolanaTrackerBundlersResponse(documentedResponse, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { data } = result;
      expect(data.provider).toBe("SOLANA_TRACKER");
      expect(data.dataSource).toBe("PROVIDER_REPORTED_UNVERIFIED");
      expect(data.requestedMint).toBe(CANONICAL_MINT);
      expect(data.totalBundlersCount).toBe(5);
      expect(data.currentHoldingBalance).toBe(15000000);
      expect(data.currentHoldingPct).toBe(0.015); // 1.5% normalized to 0.015
      expect(data.initialBalance).toBe(50000000);
      expect(data.initialPct).toBe(0.05); // 5.0% normalized to 0.05
      expect(data.reportedRawCurrentPct).toBe(1.5);
      expect(data.reportedRawInitialPct).toBe(5.0);
      expect(data.walletSampleCount).toBe(1);
      expect(data.walletSample[0]).toEqual({
        wallet: CANONICAL_WALLET_1,
        balance: 3000000,
        percentage: 0.3,
        initialBalance: 10000000,
        initialPercentage: 1.0,
        bundleTime: 1712345678000,
      });
      expect(data.localRetrievedAtMs).toBe(1700000000000);
      expect(data.upstreamSnapshotTimeMs).toBeNull();
      expect(data.isProviderAccuracyVerified).toBe(false);
      expect(data.isLaunchHistoryComplete).toBe(false);
      expect(data.isProductionCompletenessEstablished).toBe(false);
    });

    it("strictly preserves initial vs current percentage separation without cross-substitution", () => {
      const response = {
        total: 10,
        balance: 500000,
        percentage: 0.85, // 0.85%
        initialBalance: 50000000,
        initialPercentage: 85.0, // 85% at launch
        wallets: [],
      };

      const result = parseSolanaTrackerBundlersResponse(response, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Current holding is 0.0085, initial launch is 0.85
      expect(result.data.currentHoldingPct).toBe(0.0085);
      expect(result.data.initialPct).toBe(0.85);
      expect(result.data.currentHoldingPct).not.toBe(result.data.initialPct);
    });

    it("preserves genuine reported zero boundaries without converting to null or undefined", () => {
      const zeroResponse = {
        total: 0,
        balance: 0,
        percentage: 0,
        initialBalance: 0,
        initialPercentage: 0,
        wallets: [],
      };

      const result = parseSolanaTrackerBundlersResponse(zeroResponse, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.totalBundlersCount).toBe(0);
      expect(result.data.currentHoldingBalance).toBe(0);
      expect(result.data.currentHoldingPct).toBe(0);
      expect(result.data.initialBalance).toBe(0);
      expect(result.data.initialPct).toBe(0);
      expect(result.data.reportedRawCurrentPct).toBe(0);
      expect(result.data.reportedRawInitialPct).toBe(0);
      expect(result.data.walletSampleCount).toBe(0);
      expect(result.data.walletSample).toEqual([]);
    });

    it("preserves 100% boundary values correctly normalized to 1.0", () => {
      const maxResponse = {
        total: 1,
        balance: 1000000,
        percentage: 100,
        initialBalance: 1000000,
        initialPercentage: 100,
        wallets: [],
      };

      const result = parseSolanaTrackerBundlersResponse(maxResponse, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.currentHoldingPct).toBe(1.0);
      expect(result.data.initialPct).toBe(1.0);
      expect(result.data.reportedRawCurrentPct).toBe(100);
      expect(result.data.reportedRawInitialPct).toBe(100);
    });

    it("preserves a genuinely supplied empty array (wallets: []) without manufacturing from null", () => {
      const emptyWalletsResponse = {
        total: 2,
        balance: 5000,
        percentage: 0.5,
        initialBalance: 10000,
        initialPercentage: 1.0,
        wallets: [],
      };

      const result = parseSolanaTrackerBundlersResponse(emptyWalletsResponse, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.walletSampleCount).toBe(0);
      expect(result.data.walletSample).toEqual([]);
    });
  });

  describe("Rejection of Malformed Top-Level Inputs (No Favorable Defaults)", () => {
    it("rejects non-object payloads", () => {
      for (const malformed of [null, undefined, 123, "string", true, [1, 2, 3]]) {
        const result = parseSolanaTrackerBundlersResponse(malformed, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("MALFORMED_PAYLOAD");
        }
      }
    });

    it("rejects missing required top-level fields (including wallets)", () => {
      const base = {
        total: 5,
        balance: 100,
        percentage: 1,
        initialBalance: 100,
        initialPercentage: 1,
        wallets: [],
      };

      for (const field of [
        "total",
        "balance",
        "percentage",
        "initialBalance",
        "initialPercentage",
        "wallets",
      ]) {
        const missing = { ...base };
        delete (missing as Record<string, unknown>)[field];

        const result = parseSolanaTrackerBundlersResponse(missing, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("MISSING_REQUIRED_FIELD");
          expect(result.message).toContain(field);
        }
      }
    });

    it("rejects omitted or null wallets field without manufacturing empty arrays", () => {
      const base = {
        total: 5,
        balance: 100,
        percentage: 1,
        initialBalance: 100,
        initialPercentage: 1,
      };

      // 1. Omitted wallets
      const omittedResult = parseSolanaTrackerBundlersResponse(base, validMetadata);
      expect(omittedResult.success).toBe(false);
      if (!omittedResult.success) {
        expect(omittedResult.error).toBe("MISSING_REQUIRED_FIELD");
        expect(omittedResult.message).toContain("wallets");
      }

      // 2. wallets: null
      const nullResult = parseSolanaTrackerBundlersResponse(
        { ...base, wallets: null },
        validMetadata,
      );
      expect(nullResult.success).toBe(false);
      if (!nullResult.success) {
        expect(nullResult.error).toBe("MISSING_REQUIRED_FIELD");
        expect(nullResult.message).toContain("wallets");
      }
    });

    it("rejects non-array wallets field", () => {
      const base = {
        total: 5,
        balance: 100,
        percentage: 1,
        initialBalance: 100,
        initialPercentage: 1,
      };

      for (const invalidWallets of ["not-an-array", 123, true, { wallet: CANONICAL_WALLET_1 }]) {
        const result = parseSolanaTrackerBundlersResponse(
          { ...base, wallets: invalidWallets },
          validMetadata,
        );
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(result.message).toContain("must be an array");
        }
      }
    });

    it("rejects numeric strings without auto-coercion", () => {
      const responseWithStringPct = {
        total: 5,
        balance: 100,
        percentage: "1.5", // Numeric string must NOT be coerced via parseFloat
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: [],
      };

      const result = parseSolanaTrackerBundlersResponse(responseWithStringPct, validMetadata);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("INVALID_PERCENTAGE");
      }
    });

    it("rejects string total counts and string balances", () => {
      const responseWithStringTotal = {
        total: "5", // String total must NOT be coerced
        balance: 100,
        percentage: 1.0,
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: [],
      };

      const resultTotal = parseSolanaTrackerBundlersResponse(
        responseWithStringTotal,
        validMetadata,
      );
      expect(resultTotal.success).toBe(false);
      if (!resultTotal.success) {
        expect(resultTotal.error).toBe("INVALID_TOTAL_COUNT");
      }

      const responseWithStringBalance = {
        total: 5,
        balance: "100", // String balance must NOT be coerced
        percentage: 1.0,
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: [],
      };

      const resultBalance = parseSolanaTrackerBundlersResponse(
        responseWithStringBalance,
        validMetadata,
      );
      expect(resultBalance.success).toBe(false);
      if (!resultBalance.success) {
        expect(resultBalance.error).toBe("INVALID_BALANCE");
      }
    });

    it("rejects non-integer and negative total counts", () => {
      for (const invalidTotal of [
        -1,
        1.5,
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 10,
      ]) {
        const payload = {
          total: invalidTotal,
          balance: 100,
          percentage: 1.0,
          initialBalance: 100,
          initialPercentage: 1.0,
          wallets: [],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_TOTAL_COUNT");
        }
      }
    });

    it("rejects negative or non-finite balances", () => {
      for (const invalidBalance of [-1, -0.01, NaN, Infinity, -Infinity]) {
        const payload = {
          total: 5,
          balance: invalidBalance,
          percentage: 1.0,
          initialBalance: 100,
          initialPercentage: 1.0,
          wallets: [],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_BALANCE");
        }
      }
    });

    it("rejects out-of-range or non-finite percentages (<0, >100, NaN, Infinity)", () => {
      for (const invalidPct of [-0.01, -1, 100.01, 150, NaN, Infinity, -Infinity]) {
        const payloadCurrent = {
          total: 5,
          balance: 100,
          percentage: invalidPct,
          initialBalance: 100,
          initialPercentage: 1.0,
          wallets: [],
        };

        const resCurrent = parseSolanaTrackerBundlersResponse(payloadCurrent, validMetadata);
        expect(resCurrent.success).toBe(false);
        if (!resCurrent.success) {
          expect(resCurrent.error).toBe("INVALID_PERCENTAGE");
        }

        const payloadInitial = {
          total: 5,
          balance: 100,
          percentage: 1.0,
          initialBalance: 100,
          initialPercentage: invalidPct,
          wallets: [],
        };

        const resInitial = parseSolanaTrackerBundlersResponse(payloadInitial, validMetadata);
        expect(resInitial.success).toBe(false);
        if (!resInitial.success) {
          expect(resInitial.error).toBe("INVALID_INITIAL_PERCENTAGE");
        }
      }
    });
  });

  describe("Wallet Sample Validation & Bound Enforcement", () => {
    const basePayload = {
      total: 5,
      balance: 100,
      percentage: 1.0,
      initialBalance: 100,
      initialPercentage: 1.0,
    };

    it("rejects non-object elements in wallets array", () => {
      for (const invalidItem of [null, undefined, "not-an-object", 123, true, [1, 2]]) {
        const payload = {
          ...basePayload,
          wallets: [invalidItem],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(result.message).toContain("must be a non-null object");
        }
      }
    });

    it("rejects empty wallet objects and missing required entry fields", () => {
      // 1. Completely empty object: wallets: [{}]
      const emptyObjPayload = {
        ...basePayload,
        wallets: [{}],
      };
      const emptyResult = parseSolanaTrackerBundlersResponse(emptyObjPayload, validMetadata);
      expect(emptyResult.success).toBe(false);
      if (!emptyResult.success) {
        expect(emptyResult.error).toBe("INVALID_WALLETS_SAMPLE");
      }

      // 2. Missing each documented property individually
      const fullEntry = createValidWalletEntry();
      const requiredWalletFields: (keyof SolanaTrackerWalletSampleEntry)[] = [
        "wallet",
        "balance",
        "percentage",
        "initialBalance",
        "initialPercentage",
        "bundleTime",
      ];

      for (const field of requiredWalletFields) {
        const partialEntry = { ...fullEntry };
        delete (partialEntry as Record<string, unknown>)[field];

        const payload = {
          ...basePayload,
          wallets: [partialEntry],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(result.message).toContain(field);
        }
      }
    });

    it("rejects invalid wallet addresses with canonical base58 enforcement", () => {
      const invalidAddresses = [
        "7Xawh9...", // Truncated sample address from docs
        "",
        "short",
        "invalid-char-0OIl",
        "11111111111111111111111111111111111111111111111111111111", // Too long
        123 as unknown as string,
        null as unknown as string,
      ];

      for (const invalidAddr of invalidAddresses) {
        const payload = {
          ...basePayload,
          wallets: [createValidWalletEntry({ wallet: invalidAddr })],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(result.message).toContain("'wallet' address");
        }
      }
    });

    it("rejects invalid entry balance values (negative, non-finite, strings)", () => {
      for (const invalidBal of [-1, -0.01, NaN, Infinity, -Infinity, "100" as unknown as number]) {
        const payload = {
          ...basePayload,
          wallets: [createValidWalletEntry({ balance: invalidBal })],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(result.message).toContain("'balance'");
        }
      }
    });

    it("rejects invalid entry percentage values (<0, >100, non-finite, strings)", () => {
      for (const invalidPct of [-0.01, 100.01, 150, NaN, Infinity, "1.5" as unknown as number]) {
        const payloadCurrent = {
          ...basePayload,
          wallets: [createValidWalletEntry({ percentage: invalidPct })],
        };

        const resCurrent = parseSolanaTrackerBundlersResponse(payloadCurrent, validMetadata);
        expect(resCurrent.success).toBe(false);
        if (!resCurrent.success) {
          expect(resCurrent.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(resCurrent.message).toContain("'percentage'");
        }

        const payloadInitial = {
          ...basePayload,
          wallets: [createValidWalletEntry({ initialPercentage: invalidPct })],
        };

        const resInitial = parseSolanaTrackerBundlersResponse(payloadInitial, validMetadata);
        expect(resInitial.success).toBe(false);
        if (!resInitial.success) {
          expect(resInitial.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(resInitial.message).toContain("'initialPercentage'");
        }
      }
    });

    it("rejects invalid entry initialBalance values (negative, non-finite, strings)", () => {
      for (const invalidBal of [-1, -0.01, NaN, Infinity, -Infinity, "50" as unknown as number]) {
        const payload = {
          ...basePayload,
          wallets: [createValidWalletEntry({ initialBalance: invalidBal })],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(result.message).toContain("'initialBalance'");
        }
      }
    });

    it("rejects invalid entry bundleTime values (negative, non-integer, non-finite, strings)", () => {
      for (const invalidTime of [
        -1,
        1712345678.5, // Non-integer
        NaN,
        Infinity,
        -Infinity,
        Number.MAX_SAFE_INTEGER + 10,
        "1712345678000" as unknown as number,
      ]) {
        const payload = {
          ...basePayload,
          wallets: [createValidWalletEntry({ bundleTime: invalidTime })],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
          expect(result.message).toContain("'bundleTime'");
        }
      }
    });

    it("enforces 500-wallet sample bound: accepts exactly 500 entries, rejects 501 without truncation", () => {
      // 1. Boundary: exactly 500 entries (MAX_SOLANA_TRACKER_WALLETS_SAMPLE_LIMIT)
      const valid500Wallets: SolanaTrackerWalletSampleEntry[] = Array.from(
        { length: MAX_SOLANA_TRACKER_WALLETS_SAMPLE_LIMIT },
        (_, idx) =>
          createValidWalletEntry({
            balance: idx * 10,
            bundleTime: 1712345678000 + idx,
          }),
      );

      const payload500 = {
        ...basePayload,
        wallets: valid500Wallets,
      };

      const result500 = parseSolanaTrackerBundlersResponse(payload500, validMetadata);
      expect(result500.success).toBe(true);
      if (result500.success) {
        expect(result500.data.walletSampleCount).toBe(500);
        expect(result500.data.walletSample.length).toBe(500);
      }

      // 2. Boundary: 501 entries (oversized)
      const invalid501Wallets: SolanaTrackerWalletSampleEntry[] = Array.from(
        { length: MAX_SOLANA_TRACKER_WALLETS_SAMPLE_LIMIT + 1 },
        (_, idx) =>
          createValidWalletEntry({
            balance: idx * 10,
            bundleTime: 1712345678000 + idx,
          }),
      );

      const payload501 = {
        ...basePayload,
        wallets: invalid501Wallets,
      };

      const result501 = parseSolanaTrackerBundlersResponse(payload501, validMetadata);
      expect(result501.success).toBe(false);
      if (!result501.success) {
        expect(result501.error).toBe("INVALID_WALLETS_SAMPLE");
        expect(result501.message).toContain("exceeds maximum documented sample limit of 500");
      }
    });
  });

  describe("Request Metadata & Mint Binding", () => {
    it("rejects malformed or invalid Solana base58 mint addresses", () => {
      for (const invalidMint of [
        "",
        "not-a-mint",
        "short",
        "invalid-char-0OIl",
        123 as unknown as string,
      ]) {
        const metadata: SolanaTrackerBundlerParseRequestMetadata = {
          requestedMint: invalidMint,
          localRetrievedAtMs: 1700000000000,
        };

        const payload = {
          total: 5,
          balance: 100,
          percentage: 1.0,
          initialBalance: 100,
          initialPercentage: 1.0,
          wallets: [],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, metadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_REQUESTED_MINT");
        }
      }
    });

    it("rejects invalid local retrieval timestamps", () => {
      for (const invalidTs of [0, -1, NaN, Infinity, 1.5, "1700000000000" as unknown as number]) {
        const metadata: SolanaTrackerBundlerParseRequestMetadata = {
          requestedMint: CANONICAL_MINT,
          localRetrievedAtMs: invalidTs,
        };

        const payload = {
          total: 5,
          balance: 100,
          percentage: 1.0,
          initialBalance: 100,
          initialPercentage: 1.0,
          wallets: [],
        };

        const result = parseSolanaTrackerBundlersResponse(payload, metadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("INVALID_LOCAL_TIMESTAMP");
        }
      }
    });

    it("binds output strictly to the requested mint without claiming response self-authentication", () => {
      const payload = {
        total: 3,
        balance: 50,
        percentage: 0.5,
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: [],
      };

      const result1 = parseSolanaTrackerBundlersResponse(payload, {
        requestedMint: CANONICAL_MINT,
        localRetrievedAtMs: 1700000000000,
      });
      const result2 = parseSolanaTrackerBundlersResponse(payload, {
        requestedMint: CANONICAL_MINT_2,
        localRetrievedAtMs: 1700000000000,
      });

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      if (result1.success && result2.success) {
        expect(result1.data.requestedMint).toBe(CANONICAL_MINT);
        expect(result2.data.requestedMint).toBe(CANONICAL_MINT_2);
      }
    });
  });

  describe("Structural and Architectural Invariants", () => {
    it("does not reconstruct aggregate concentration by summing wallet sample entries", () => {
      // The endpoint returns a limited sample of wallets, not the complete registry.
      // Top-level percentage is 5.0, while wallet sample only lists 2 wallets summing to 0.4.
      const payload = {
        total: 25,
        balance: 500000,
        percentage: 5.0,
        initialBalance: 1000000,
        initialPercentage: 10.0,
        wallets: [
          createValidWalletEntry({
            wallet: CANONICAL_WALLET_1,
            balance: 20000,
            percentage: 0.2,
            initialBalance: 50000,
            initialPercentage: 0.5,
            bundleTime: 1712345678000,
          }),
          createValidWalletEntry({
            wallet: CANONICAL_WALLET_2,
            balance: 20000,
            percentage: 0.2,
            initialBalance: 50000,
            initialPercentage: 0.5,
            bundleTime: 1712345679000,
          }),
        ],
      };

      const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Must strictly preserve the top-level reported percentage (5.0% -> 0.05), NOT the sample sum (0.4%)
      expect(result.data.currentHoldingPct).toBe(0.05);
      expect(result.data.initialPct).toBe(0.1);
      expect(result.data.walletSampleCount).toBe(2);
    });

    it("leaves upstreamSnapshotTimeMs strictly null regardless of wallet bundleTime", () => {
      const payload = {
        total: 1,
        balance: 100,
        percentage: 1.0,
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: [createValidWalletEntry({ bundleTime: 1712345678000 })],
      };

      const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.upstreamSnapshotTimeMs).toBeNull();
    });

    it("returns deeply frozen, immutable snapshot objects", () => {
      const payload = {
        total: 1,
        balance: 100,
        percentage: 1.0,
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: [createValidWalletEntry()],
      };

      const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(Object.isFrozen(result.data)).toBe(true);
      expect(Object.isFrozen(result.data.walletSample)).toBe(true);
      expect(Object.isFrozen(result.data.walletSample[0])).toBe(true);
    });

    it("preserves strategy isolation: parsed snapshot does not alter Gate 11 or admit candidate", () => {
      const payload = {
        total: 1,
        balance: 100,
        percentage: 1.0,
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: [],
      };

      const parseResult = parseSolanaTrackerBundlersResponse(payload, validMetadata);
      expect(parseResult.success).toBe(true);
      if (!parseResult.success) return;

      // Verify that parsed snapshot remains unverified
      expect(parseResult.data.isProviderAccuracyVerified).toBe(false);
      expect(parseResult.data.isLaunchHistoryComplete).toBe(false);
      expect(parseResult.data.isProductionCompletenessEstablished).toBe(false);

      // Verify that the strategy BuyGateTriggerService evaluateCandidate continues to fail closed
      // when relying on standard marketContext without manual synthetic injection
      const service = new BuyGateTriggerService();
      const mockCandidate: WatchlistCandidateItem = {
        poolId: "PoolAddress111111111111111111111111111111111",
        mintAddress: CANONICAL_MINT,
        symbol: "CAND",
        liquidityUsd: 20_000,
        marketCapUsd: 80_000,
        lmcRatio: 0.25,
        lpBurnPct: 99.0,
        assetAgeSeconds: 450,
        volume5mUsd: 6_000,
        buys5m: 40,
        sells5m: 15,
        buyToSellRatio: 2.67,
        status: "WATCHING",
        discoveredAt: new Date().toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
      };

      // Under requireVerifiedHolders: true with bundlerPct undefined, candidate strictly fails closed
      const evalResult = service.evaluateCandidate(mockCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: undefined, // Provider reported data is NOT auto-populated into strategy
        requireVerifiedHolders: true,
      });

      expect(evalResult.triggered).toBe(false);
      expect(evalResult.rejectionReason).toBe("BUNDLER_CONCENTRATION_UNKNOWN");
    });
  });

  describe("Isolated Bundler Mapping to Gate 11 (Offline Test Fixtures Only)", () => {
    /**
     * Isolated test fixture mapping: connects pure parsed Solana Tracker output to Gate 11 context.
     *
     * STRICT TEST-FIXTURE SCOPE GUARANTEES:
     * 1. Test-only helper: NOT a production adapter; does not alter runtime evaluation or CandidateScanner.
     * 2. Separate dimensions: Preserves initialPct and currentHoldingPct as distinct fields.
     * 3. Strategy intent: Maps initialPct to bundlerPctForGate11 to enforce launch-allocation thresholds.
     * 4. No fallback / substitution: If initialPct is missing, non-finite, negative, or > 1.0, bundlerPctForGate11
     *    remains strictly undefined. currentHoldingPct MUST NEVER substitute for initialPct.
     */
    interface IsolatedBundlerGate11Mapping {
      readonly initialPct?: number | undefined;
      readonly currentHoldingPct?: number | undefined;
      readonly bundlerPctForGate11?: number | undefined;
    }

    function mapBundlerSnapshotForGate11TestFixture(
      snapshot: SolanaTrackerBundlerSnapshot | null | undefined,
    ): IsolatedBundlerGate11Mapping {
      if (!snapshot) {
        return {
          initialPct: undefined,
          currentHoldingPct: undefined,
          bundlerPctForGate11: undefined,
        };
      }

      // Preserve initialPct and currentHoldingPct separately
      const initialPct =
        typeof snapshot.initialPct === "number" &&
        Number.isFinite(snapshot.initialPct) &&
        snapshot.initialPct >= 0 &&
        snapshot.initialPct <= 1
          ? snapshot.initialPct
          : undefined;

      const currentHoldingPct =
        typeof snapshot.currentHoldingPct === "number" &&
        Number.isFinite(snapshot.currentHoldingPct) &&
        snapshot.currentHoldingPct >= 0 &&
        snapshot.currentHoldingPct <= 1
          ? snapshot.currentHoldingPct
          : undefined;

      // Strategy launch-allocation intent: Gate 11 maps exclusively to initialPct.
      // Missing or invalid initial allocation must remain unavailable; current holdings cannot substitute!
      const bundlerPctForGate11 = initialPct;

      return {
        initialPct,
        currentHoldingPct,
        bundlerPctForGate11,
      };
    }

    function createSyntheticCandidate(
      overrides?: Partial<WatchlistCandidateItem>,
    ): WatchlistCandidateItem {
      return {
        poolId: "PoolAddress111111111111111111111111111111111",
        mintAddress: CANONICAL_MINT,
        symbol: "SYNTH",
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        lmcRatio: 0.25,
        lpBurnPct: 99.0,
        assetAgeSeconds: 450,
        volume5mUsd: 6_000,
        buys5m: 40,
        sells5m: 15,
        buyToSellRatio: 2.67,
        status: "WATCHING",
        discoveredAt: new Date().toISOString(),
        lastEvaluatedAt: new Date().toISOString(),
        ...overrides,
      };
    }

    it("preserves initialPct and currentHoldingPct separately without conflating them", () => {
      const payload = {
        total: 3,
        balance: 50_000,
        percentage: 5.0, // 5% current holdings
        initialBalance: 250_000,
        initialPercentage: 25.0, // 25% initial launch allocation
        wallets: [],
      };

      const parseResult = parseSolanaTrackerBundlersResponse(payload, validMetadata);
      expect(parseResult.success).toBe(true);
      if (!parseResult.success) return;

      const mapped = mapBundlerSnapshotForGate11TestFixture(parseResult.data);
      expect(mapped.initialPct).toBeCloseTo(0.25, 4);
      expect(mapped.currentHoldingPct).toBeCloseTo(0.05, 4);
      expect(mapped.bundlerPctForGate11).toBeCloseTo(0.25, 4);
      expect(mapped.initialPct).not.toEqual(mapped.currentHoldingPct);
    });

    it("fails Gate 11 when synthetic initial allocation exceeds cohort threshold even if current holdings are low", () => {
      const service = new BuyGateTriggerService();

      // Case A: Micro-cap candidate (ceiling is 50% / 0.50)
      // Initial allocation is 55% (violating 50% ceiling), but current holdings have dumped to 2%
      const microPayload = {
        total: 10,
        balance: 20_000,
        percentage: 2.0, // Low current holdings (2%)
        initialBalance: 550_000,
        initialPercentage: 55.0, // High launch allocation (55%)
        wallets: [],
      };
      const microParse = parseSolanaTrackerBundlersResponse(microPayload, validMetadata);
      expect(microParse.success).toBe(true);
      if (!microParse.success) return;

      const microMapped = mapBundlerSnapshotForGate11TestFixture(microParse.data);
      expect(microMapped.initialPct).toBeCloseTo(0.55, 4);
      expect(microMapped.currentHoldingPct).toBeCloseTo(0.02, 4);
      expect(microMapped.bundlerPctForGate11).toBeCloseTo(0.55, 4);

      const microCandidate = createSyntheticCandidate({
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        assetAgeSeconds: 450,
      });

      const microResult = service.evaluateCandidate(microCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: microMapped.bundlerPctForGate11,
        requireVerifiedHolders: true,
      });

      expect(microResult.triggered).toBe(false);
      expect(microResult.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");

      // Counterfactual check: if currentHoldingPct (0.02) had been substituted, Gate 11 would have erroneously passed
      const counterfactualResult = service.evaluateCandidate(microCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: microMapped.currentHoldingPct, // Invalid substitution
        requireVerifiedHolders: true,
      });
      const bundlerGateCheck = counterfactualResult.gates.find(
        (g) => g.name === "BUNDLER_CONCENTRATION_GATE",
      );
      expect(bundlerGateCheck?.passed).toBe(true); // Demonstrates why substitution is prohibited!

      // Case B: Established runner candidate (ceiling is 85% / 0.85)
      // Initial allocation is 88% (violating 85% ceiling), current holdings dumped to 5%
      const estPayload = {
        total: 12,
        balance: 50_000,
        percentage: 5.0, // Low current holdings (5%)
        initialBalance: 880_000,
        initialPercentage: 88.0, // High launch allocation (88%)
        wallets: [],
      };
      const estParse = parseSolanaTrackerBundlersResponse(estPayload, validMetadata);
      expect(estParse.success).toBe(true);
      if (!estParse.success) return;

      const estMapped = mapBundlerSnapshotForGate11TestFixture(estParse.data);
      expect(estMapped.initialPct).toBeCloseTo(0.88, 4);
      expect(estMapped.bundlerPctForGate11).toBeCloseTo(0.88, 4);

      const estCandidate = createSyntheticCandidate({
        liquidityUsd: 60_000,
        marketCapUsd: 250_000,
        lmcRatio: 60_000 / 250_000,
        assetAgeSeconds: 2400, // Qualifying Established age (1800s <= Age <= 7200s)
        volume5mUsd: 20_000,
        buys5m: 50,
        sells5m: 20,
        buyToSellRatio: 2.5,
      });

      const estResult = service.evaluateCandidate(estCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300, // >= 250 minEstablishedHolders
        top10HolderPct: 0.15,
        bundlerPct: estMapped.bundlerPctForGate11,
        requireVerifiedHolders: true,
      });

      expect(estResult.triggered).toBe(false);
      expect(estResult.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");
      const bundlerGate = estResult.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.requirement).toContain("Bundler <= 85%");
    });

    it("leaves bundler concentration unavailable when initial allocation is missing or invalid; current holdings cannot substitute", () => {
      const service = new BuyGateTriggerService();
      const candidate = createSyntheticCandidate();

      // Case A: Missing / undefined snapshot
      const mappedNull = mapBundlerSnapshotForGate11TestFixture(null);
      expect(mappedNull.bundlerPctForGate11).toBeUndefined();

      const resultNull = service.evaluateCandidate(candidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: mappedNull.bundlerPctForGate11,
        requireVerifiedHolders: true,
      });
      expect(resultNull.triggered).toBe(false);
      expect(resultNull.rejectionReason).toBe("BUNDLER_CONCENTRATION_UNKNOWN");

      // Case B: Snapshot with invalid initialPct (e.g. NaN) but valid currentHoldingPct
      const invalidInitialSnapshot = {
        initialPct: NaN as unknown as number,
        currentHoldingPct: 0.04,
      } as unknown as SolanaTrackerBundlerSnapshot;

      const mappedInvalid = mapBundlerSnapshotForGate11TestFixture(invalidInitialSnapshot);
      expect(mappedInvalid.initialPct).toBeUndefined();
      expect(mappedInvalid.currentHoldingPct).toBe(0.04);
      expect(mappedInvalid.bundlerPctForGate11).toBeUndefined(); // Current holdings cannot substitute!

      const resultInvalid = service.evaluateCandidate(candidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: mappedInvalid.bundlerPctForGate11,
        requireVerifiedHolders: true,
      });
      expect(resultInvalid.triggered).toBe(false);
      expect(resultInvalid.rejectionReason).toBe("BUNDLER_CONCENTRATION_UNKNOWN");
    });

    it("verifies captured initialPercentage normalization against portable capture fixture without treating favorable Gate 11 as full admission", () => {
      const parseResult = parseSolanaTrackerBundlersResponse(
        CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD,
        CAPTURED_SOLANA_TRACKER_METADATA,
      );
      expect(parseResult.success).toBe(true);
      if (!parseResult.success) return;

      // Verify exact raw values and normalization from sealed reference capture
      expect(parseResult.data.totalBundlersCount).toBe(1349);
      expect(parseResult.data.reportedRawInitialPct).toBe(0.00756); // 0.00756%
      expect(parseResult.data.initialPct).toBeCloseTo(0.0000756, 7); // Normalized to [0.0, 1.0]
      expect(parseResult.data.reportedRawCurrentPct).toBe(0.05904); // 0.05904%
      expect(parseResult.data.currentHoldingPct).toBeCloseTo(0.0005904, 7);

      const mapped = mapBundlerSnapshotForGate11TestFixture(parseResult.data);
      expect(mapped.bundlerPctForGate11).toBeCloseTo(0.0000756, 7);

      const service = new BuyGateTriggerService();

      // Part A: Gate 11 alone passes because 0.0000756 <= 0.50 (micro-cap)
      const syntheticPassingCandidate = createSyntheticCandidate();
      const passingEval = service.evaluateCandidate(syntheticPassingCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: mapped.bundlerPctForGate11,
        requireVerifiedHolders: true,
      });
      const gate11Check = passingEval.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(gate11Check?.passed).toBe(true);

      // Part B: Crucial requirement - Favorable Gate 11 does NOT admit candidate when another gate fails
      const syntheticFailingCandidate = createSyntheticCandidate({
        volume5mUsd: 1_000, // Failing: $1,000 < $2,500 min volume
      });
      const failingEval = service.evaluateCandidate(syntheticFailingCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: mapped.bundlerPctForGate11,
        requireVerifiedHolders: true,
      });
      // Gate 11 passed, but candidate was NOT admitted due to Gate 7 (volume)
      const gate11InFailing = failingEval.gates.find(
        (g) => g.name === "BUNDLER_CONCENTRATION_GATE",
      );
      expect(gate11InFailing?.passed).toBe(true);
      expect(failingEval.triggered).toBe(false);
      expect(failingEval.rejectionReason).toBe("VOLUME_SURGE_GATE_FAILED");
    });

    it("confirms normal runtime path still leaves bundlerPct unavailable and Gate 11 fail-closed", async () => {
      // Mock RugCheck response returning valid healthy security metrics
      const mockRugCheckFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            score: 50,
            totalHolders: 350,
            topHolders: [{ pct: 2.5 }, { pct: 1.5 }],
            risks: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const metrics = await BuyGateTriggerService.fetchRugCheckMetrics(
        CANONICAL_MINT,
        mockRugCheckFetch,
      );
      expect(metrics).not.toBeNull();
      // Normal runtime path strictly leaves bundlerPct undefined
      expect(metrics?.bundlerPct).toBeUndefined();

      const service = new BuyGateTriggerService();
      const candidate = createSyntheticCandidate();

      const runtimeEval = service.evaluateCandidate(candidate, {
        rugScore: metrics?.rugScore,
        hasDangerRisk: metrics?.hasDangerRisk,
        holdersCount: metrics?.holdersCount,
        top10HolderPct: metrics?.top10HolderPct,
        bundlerPct: metrics?.bundlerPct, // undefined in runtime
        requireVerifiedHolders: true,
      });

      // Under requireVerifiedHolders: true, missing bundlerPct fails closed
      expect(runtimeEval.triggered).toBe(false);
      expect(runtimeEval.rejectionReason).toBe("BUNDLER_CONCENTRATION_UNKNOWN");
    });
  });
});
