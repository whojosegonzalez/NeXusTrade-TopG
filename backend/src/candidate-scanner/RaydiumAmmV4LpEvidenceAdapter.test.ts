/**
 * Phase 12.94-D Milestone D.3.3: Raydium AMM v4 LP Evidence Adapter Offline Integration Tests
 *
 * Verifies:
 * 1. Constructor guards enforcing explicit transport and budget manager.
 * 2. Qualifying synthetic evidence passing LP screening and permitting remaining checks to proceed.
 * 3. Captured below-threshold Raydium LP result failing LP gate (0.135682% < 90%).
 * 4. Acquisition failure counting dispatched requests and preserving 2-attempt ceiling.
 * 5. Budget exhaustion preventing dispatch upfront and between Request 1 and Request 2.
 * 6. Shared provider pacing across candidates enforced through GlobalResourceBudgetManager.
 * 7. Identity mismatch failing closed and rejecting malformed public keys upfront.
 */

import { describe, expect, it } from "vitest";
import { RaydiumAmmV4LpEvidenceAdapter } from "./RaydiumAmmV4LpEvidenceAdapter.js";
import { CandidateStreamEngine } from "./CandidateStreamEngine.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import {
  CAPTURED_RAY_WSOL_IDENTITIES,
  RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE,
  RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE,
  SYNTHETIC_QUALIFIED_RAW_PAYLOAD,
  createSyntheticRayCandidatePool,
} from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "./CandidateScannerConfig.js";
import type { LpFreshnessPolicy } from "./LpScreeningBridge.js";
import type { ScannedPoolRecord } from "./CandidateScannerTypes.js";

describe("RaydiumAmmV4LpEvidenceAdapter", () => {
  const MOCK_RPC_URL = "https://mock-solana-rpc.internal";

  const createConfig = () => ({
    ...CANDIDATE_SCANNER_DEFAULTS,
    minLiquidityUsd: 2500,
    maxLiquidityUsd: 1_000_000,
    minLmcRatio: 0.15,
    maxLmcRatio: 0.55,
    minTxCount5m: 10,
    minVolume5mUsd: 2500,
    minMaturityAgeSec: 300,
    maxMaturityAgeSec: 1200,
    minBuyToSellRatio: 1.5,
  });

  describe("Constructor & Configuration Guards", () => {
    it("rejects initialization without an explicit transport implementation", () => {
      const budgetManager = new GlobalResourceBudgetManager();
      expect(
        () =>
          new RaydiumAmmV4LpEvidenceAdapter({
            rpcUrl: MOCK_RPC_URL,
            budgetManager,
            transport: undefined as unknown as typeof fetch,
          }),
      ).toThrowError("Explicit transport is required");
    });

    it("rejects initialization without a shared budget manager", () => {
      expect(
        () =>
          new RaydiumAmmV4LpEvidenceAdapter({
            rpcUrl: MOCK_RPC_URL,
            budgetManager: undefined as unknown as GlobalResourceBudgetManager,
            transport: async () => new Response("{}"),
          }),
      ).toThrowError("Shared GlobalResourceBudgetManager is required");
    });

    it("rejects initialization without an rpcUrl", () => {
      const budgetManager = new GlobalResourceBudgetManager();
      expect(
        () =>
          new RaydiumAmmV4LpEvidenceAdapter({
            rpcUrl: "",
            budgetManager,
            transport: async () => new Response("{}"),
          }),
      ).toThrowError("rpcUrl is required");
    });
  });

  describe("Offline Intake Integration", () => {
    it("qualifies candidate when synthetic LP evidence is qualifying (98.5% >= 90%) and meters exactly 2 requests", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;
      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      const budgetManager = new GlobalResourceBudgetManager({
        clock,
        maxTotalRequests: 10,
      });

      let transportCallCount = 0;
      const mockTransport: typeof fetch = async (_input, init) => {
        transportCallCount++;
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getAccountInfo") {
          return new Response(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (body.method === "getMultipleAccounts") {
          return new Response(JSON.stringify(SYNTHETIC_QUALIFIED_RAW_PAYLOAD), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        evidenceOrigin: "SYNTHETIC_FIXTURE",
        isSyntheticFixture: true,
        clock,
        sleepFn,
      });

      const freshnessPolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: nowMs + 1000,
        clockSkewToleranceMs: 5000,
      };

      const decisions: Array<{
        evalResult: unknown;
        pool: ScannedPoolRecord;
      }> = [];

      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: freshnessPolicy,
        onDecision: (res, p) => {
          decisions.push({ evalResult: res, pool: p });
        },
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: Math.floor((nowMs - 600_000) / 1000), // 10m age
        liquidityUsd: 50_000,
        marketCapUsd: 200_000, // LMC 0.25 (valid)
        volume5mUsd: 10_000,
        txCount5m: 30,
        buys5m: 20,
        sells5m: 10, // Ratio 2.0 (valid)
      });

      const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

      expect(evalResult.admitted).toBe(true);
      expect(evalResult.primaryRejectionReason).toBeUndefined();
      expect(evalResult.candidate?.lpBurnPct).toBe(98.5);
      expect(evalResult.candidate?.metricProvenance?.lpBurnPct).toBe("DERIVED");
      expect(decisions[0]?.pool.lpBurnPct).toBe(98.5);

      // Verify request accounting: exactly 2 requests dispatched and counted
      expect(transportCallCount).toBe(2);
      expect(budgetManager.getStats().totalRequests).toBe(2);
      expect(budgetManager.getStats().enrichmentRequests).toBe(2);
    });

    it("verifies that an LP pass only permits remaining screening checks to proceed", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;
      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      const budgetManager = new GlobalResourceBudgetManager({ clock });
      const mockTransport: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getAccountInfo") {
          return new Response(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE, {
            status: 200,
          });
        }
        return new Response(JSON.stringify(SYNTHETIC_QUALIFIED_RAW_PAYLOAD), { status: 200 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        evidenceOrigin: "SYNTHETIC_FIXTURE",
        isSyntheticFixture: true,
        clock,
        sleepFn,
      });

      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: nowMs + 1000,
        },
      });

      // Qualifying LP (98.5%), but active freeze authority -> must reject on freeze authority gate
      const poolWithActiveFreeze = createSyntheticRayCandidatePool({
        openTimeSec: Math.floor((nowMs - 600_000) / 1000),
        freezeAuthority: "ActiveFreezeAuthorityDevKey1111111111111111",
      });

      const evalResult = await engine.evaluatePoolAsync(
        poolWithActiveFreeze,
        Math.floor(nowMs / 1000),
      );

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_ACTIVE_FREEZE_AUTHORITY");
      // LP filter itself passed
      const lpFilter = evalResult.filterEvaluations.find(
        (f) => f.filterName === "ANTI_RUG_LP_SECURITY",
      );
      expect(lpFilter?.passed).toBe(true);
    });

    it("rejects candidate when captured below-threshold Raydium LP result is returned (0.135682% < 90%)", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;
      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      const budgetManager = new GlobalResourceBudgetManager({ clock });
      let transportCallCount = 0;
      const mockTransport: typeof fetch = async (_input, init) => {
        transportCallCount++;
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getAccountInfo") {
          return new Response(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE, {
            status: 200,
          });
        }
        if (body.method === "getMultipleAccounts") {
          return new Response(RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE, { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        evidenceOrigin: "CAPTURED_RPC",
        isSyntheticFixture: false,
        clock,
        sleepFn,
      });

      const decisions: Array<{ pool: ScannedPoolRecord }> = [];
      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: nowMs + 1000,
        },
        onDecision: (_res, p) => decisions.push({ pool: p }),
      });

      const pool = createSyntheticRayCandidatePool({
        openTimeSec: Math.floor((nowMs - 600_000) / 1000),
      });

      const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(decisions[0]?.pool.lpBurnPct).toBe(0.135682);
      expect(transportCallCount).toBe(2);
      expect(budgetManager.getStats().totalRequests).toBe(2);
    });

    it("counts failed dispatched requests in budget and halts after attempt 1 on network error", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;
      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      const budgetManager = new GlobalResourceBudgetManager({ clock });
      let transportCallCount = 0;
      const mockTransport: typeof fetch = async () => {
        transportCallCount++;
        return new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), {
          status: 500,
        });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
        sleepFn,
      });

      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: nowMs + 1000,
        },
      });

      const pool = createSyntheticRayCandidatePool();
      const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_INVALID_POOL_METADATA");

      // Failed dispatched request is recorded in budgetManager
      expect(transportCallCount).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);
      expect(budgetManager.getStats().enrichmentRequests).toBe(1);
    });

    it("prevents dispatch entirely when budget is exhausted pre-flight", async () => {
      const nowMs = 1_700_000_000_000;
      const clock = () => nowMs;

      // Budget manager with 0 total requests available
      const budgetManager = new GlobalResourceBudgetManager({
        clock,
        maxTotalRequests: 0,
      });

      let transportCallCount = 0;
      const mockTransport: typeof fetch = async () => {
        transportCallCount++;
        return new Response("{}", { status: 200 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
      });

      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: nowMs + 1000,
        },
      });

      const pool = createSyntheticRayCandidatePool();
      const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      // Zero calls made to transport and zero requests added to budget
      expect(transportCallCount).toBe(0);
      expect(budgetManager.getStats().totalRequests).toBe(0);
    });

    it("prevents Request 2 dispatch when budget is exhausted between Request 1 and Request 2", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;
      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      // Budget manager with exactly 1 request capacity
      const budgetManager = new GlobalResourceBudgetManager({
        clock,
        maxTotalRequests: 1,
        minReservedForwardRequests: 0,
      });

      let transportCallCount = 0;
      const mockTransport: typeof fetch = async (_input, init) => {
        transportCallCount++;
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getAccountInfo") {
          return new Response(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE, {
            status: 200,
          });
        }
        return new Response(JSON.stringify(SYNTHETIC_QUALIFIED_RAW_PAYLOAD), { status: 200 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
        sleepFn,
      });

      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: nowMs + 1000,
        },
      });

      const pool = createSyntheticRayCandidatePool();
      const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_INVALID_POOL_METADATA");

      // Exactly 1 request dispatched to transport; Request 2 was blocked by budget denial
      expect(transportCallCount).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);
    });

    it("enforces shared host pacing across consecutive candidates on the same provider", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;
      const sleepLog: number[] = [];
      const sleepFn = async (ms: number) => {
        sleepLog.push(ms);
        nowMs += ms;
      };

      const budgetManager = new GlobalResourceBudgetManager({
        clock,
        minProviderSpacingMs: 2500,
        maxTotalRequests: 20,
      });

      const callTimestamps: number[] = [];
      const mockTransport: typeof fetch = async (_input, init) => {
        callTimestamps.push(nowMs);
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getAccountInfo") {
          return new Response(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE, {
            status: 200,
          });
        }
        return new Response(JSON.stringify(SYNTHETIC_QUALIFIED_RAW_PAYLOAD), { status: 200 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 2500,
        clock,
        sleepFn,
      });

      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 120_000,
          currentTimestampMs: nowMs + 10_000,
        },
      });

      const pool1 = createSyntheticRayCandidatePool();
      const pool2 = createSyntheticRayCandidatePool();

      // Candidate 1 executes
      await engine.evaluatePoolAsync(pool1, Math.floor(nowMs / 1000));

      // Candidate 2 executes immediately
      await engine.evaluatePoolAsync(pool2, Math.floor(nowMs / 1000));

      // 4 total requests dispatched across the 2 candidates
      expect(callTimestamps.length).toBe(4);
      expect(budgetManager.getStats().totalRequests).toBe(4);

      // Verify that every consecutive request was spaced by at least 2,500 ms
      for (let i = 1; i < callTimestamps.length; i++) {
        const interval = callTimestamps[i]! - callTimestamps[i - 1]!;
        expect(interval).toBeGreaterThanOrEqual(2500);
      }
    });

    it("fails closed without dispatching Request 2 when candidate token mint does not match pool", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;
      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      const budgetManager = new GlobalResourceBudgetManager({ clock });
      let transportCallCount = 0;
      const mockTransport: typeof fetch = async (_input, init) => {
        transportCallCount++;
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "getAccountInfo") {
          return new Response(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE, {
            status: 200,
          });
        }
        return new Response(JSON.stringify(SYNTHETIC_QUALIFIED_RAW_PAYLOAD), { status: 200 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
        sleepFn,
      });

      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: nowMs + 1000,
        },
      });

      // Valid 32-byte base58 token address (USDC), but the pool contains RAY and WSOL
      const mismatchedCandidate = createSyntheticRayCandidatePool({
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      });

      const evalResult = await engine.evaluatePoolAsync(
        mismatchedCandidate,
        Math.floor(nowMs / 1000),
      );

      expect(evalResult.admitted).toBe(false);
      // Fails on Request 1 with TOKEN_MINT_MISMATCH -> Request 2 is NOT called
      expect(transportCallCount).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);
    });

    it("fails closed immediately with zero transport dispatches when pool address is malformed", async () => {
      const budgetManager = new GlobalResourceBudgetManager();
      let transportCallCount = 0;
      const mockTransport: typeof fetch = async () => {
        transportCallCount++;
        return new Response("{}", { status: 200 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      const malformedCandidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress"> = {
        poolId: "not-a-valid-solana-base58-key",
        mintAddress: CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!,
      };

      const evidence = await adapter.resolveLpEvidence(malformedCandidate);

      expect(evidence).toBeNull();
      expect(transportCallCount).toBe(0);
      expect(budgetManager.getStats().totalRequests).toBe(0);
    });
  });
});
