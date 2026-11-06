import { describe, expect, it } from "vitest";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import {
  parseSolanaTrackerBundlersResponse,
  type SolanaTrackerBundlerParseRequestMetadata,
} from "./SolanaTrackerBundlerParser.js";
import { BuyGateTriggerService } from "./BuyGateTriggerService.js";

// Canonical 32-byte Solana base58 public keys
const CANONICAL_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const CANONICAL_MINT_2 = "So11111111111111111111111111111111111111112";

const validMetadata: SolanaTrackerBundlerParseRequestMetadata = Object.freeze({
  requestedMint: CANONICAL_MINT,
  localRetrievedAtMs: 1700000000000,
});

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
          {
            wallet: "7Xawh9...",
            balance: 3000000,
            percentage: 0.3,
            initialBalance: 10000000,
            initialPercentage: 1.0,
            bundleTime: 1712345678,
          },
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
    });

    it("preserves 100% boundary values correctly normalized to 1.0", () => {
      const maxResponse = {
        total: 1,
        balance: 1000000,
        percentage: 100,
        initialBalance: 1000000,
        initialPercentage: 100,
      };

      const result = parseSolanaTrackerBundlersResponse(maxResponse, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.currentHoldingPct).toBe(1.0);
      expect(result.data.initialPct).toBe(1.0);
      expect(result.data.reportedRawCurrentPct).toBe(100);
      expect(result.data.reportedRawInitialPct).toBe(100);
    });

    it("parses valid response when optional wallets field is omitted", () => {
      const noWalletsResponse = {
        total: 2,
        balance: 5000,
        percentage: 0.5,
        initialBalance: 10000,
        initialPercentage: 1.0,
      };

      const result = parseSolanaTrackerBundlersResponse(noWalletsResponse, validMetadata);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.walletSampleCount).toBe(0);
      expect(result.data.walletSample).toEqual([]);
    });
  });

  describe("Rejection of Malformed Inputs (No Favorable Defaults)", () => {
    it("rejects non-object payloads", () => {
      for (const malformed of [null, undefined, 123, "string", true, [1, 2, 3]]) {
        const result = parseSolanaTrackerBundlersResponse(malformed, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("MALFORMED_PAYLOAD");
        }
      }
    });

    it("rejects missing required top-level fields", () => {
      const base = {
        total: 5,
        balance: 100,
        percentage: 1,
        initialBalance: 100,
        initialPercentage: 1,
      };

      for (const field of [
        "total",
        "balance",
        "percentage",
        "initialBalance",
        "initialPercentage",
      ]) {
        const missing = { ...base };
        delete (missing as Record<string, unknown>)[field];

        const result = parseSolanaTrackerBundlersResponse(missing, validMetadata);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe("MISSING_REQUIRED_FIELD");
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
        };

        const resInitial = parseSolanaTrackerBundlersResponse(payloadInitial, validMetadata);
        expect(resInitial.success).toBe(false);
        if (!resInitial.success) {
          expect(resInitial.error).toBe("INVALID_INITIAL_PERCENTAGE");
        }
      }
    });

    it("rejects malformed wallets field when not an array", () => {
      const payload = {
        total: 5,
        balance: 100,
        percentage: 1.0,
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: "not-an-array",
      };

      const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
      }
    });

    it("rejects non-object elements in wallets array", () => {
      const payload = {
        total: 5,
        balance: 100,
        percentage: 1.0,
        initialBalance: 100,
        initialPercentage: 1.0,
        wallets: ["invalid-string-element"],
      };

      const result = parseSolanaTrackerBundlersResponse(payload, validMetadata);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("INVALID_WALLETS_SAMPLE");
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
          { wallet: "Wallet1111111111111111111111111111111111111", percentage: 0.2 },
          { wallet: "Wallet2222222222222222222222222222222222222", percentage: 0.2 },
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
        wallets: [{ wallet: "W1", bundleTime: 1712345678 }],
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
        wallets: [{ wallet: "W1" }],
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
});
