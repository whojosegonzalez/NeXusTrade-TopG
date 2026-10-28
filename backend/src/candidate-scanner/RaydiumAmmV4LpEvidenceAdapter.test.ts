/**
 * Phase 12.94-D Milestone D.3.3: Raydium AMM v4 LP Evidence Adapter Offline Integration Tests
 *
 * Verifies:
 * 1. Constructor guards enforcing explicit transport and budget manager.
 * 2. Qualifying synthetic evidence passing LP screening and permitting remaining checks to proceed.
 * 3. Captured below-threshold Raydium LP result failing LP gate (0.135682% < 90%).
 * 4. Acquisition failure counting dispatched requests and preserving 2-attempt ceiling.
 * 5. Budget exhaustion preventing dispatch upfront and reconciling counts on pre-dispatch denial.
 * 6. Respecting unsuccessful acquisition results (storage failure fails closed, preserving diagnostics).
 * 7. Unified effective deadline covering shared pacing waits and cancellation during pacing.
 * 8. Shared provider pacing across candidates enforced through GlobalResourceBudgetManager.
 * 9. Identity mismatch failing closed and rejecting malformed public keys upfront.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      ).toThrow("Explicit transport is required for RaydiumAmmV4LpEvidenceAdapter");
    });

    it("rejects initialization without an explicit GlobalResourceBudgetManager", () => {
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });
      expect(
        () =>
          new RaydiumAmmV4LpEvidenceAdapter({
            rpcUrl: MOCK_RPC_URL,
            budgetManager: undefined as unknown as GlobalResourceBudgetManager,
            transport: mockTransport,
          }),
      ).toThrow("Shared GlobalResourceBudgetManager is required");
    });

    it("rejects initialization without an RPC URL", () => {
      const budgetManager = new GlobalResourceBudgetManager();
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });
      expect(
        () =>
          new RaydiumAmmV4LpEvidenceAdapter({
            rpcUrl: "",
            budgetManager,
            transport: mockTransport,
          }),
      ).toThrow("rpcUrl is required");
    });
  });

  describe("Intake Evaluation with RaydiumAmmV4LpEvidenceAdapter", () => {
    it("admits candidate when qualifying synthetic evidence is returned (98.5% LP burn >= 90%)", async () => {
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
        isSyntheticFixture: true,
      });

      const freshnessPolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: nowMs + 1000,
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
        openTimeSec: Math.floor(nowMs / 1000) - 600,
        liquidityUsd: 125_000,
        txCount5m: 25,
        volume5mUsd: 15_000,
        buys5m: 18,
        sells5m: 7,
      });

      const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

      expect(evalResult.admitted).toBe(true);
      expect(evalResult.primaryRejectionReason).toBeUndefined();
      expect(evalResult.candidate?.lpBurnPct).toBe(98.5);
      expect(evalResult.candidate?.metricProvenance?.lpBurnPct).toBe("DERIVED");
      expect(decisions[0]?.pool.lpBurnPct).toBe(98.5);

      // Exactly 2 outbound calls made to transport and recorded in shared session budget
      expect(transportCallCount).toBe(2);
      expect(budgetManager.getStats().totalRequests).toBe(2);
      expect(budgetManager.getStats().enrichmentRequests).toBe(2);
      expect(adapter.getLastResult()?.ok).toBe(true);
      expect(adapter.getLastResult()?.httpAttempts).toBe(2);
    });

    it("LP pass only satisfies LP filter; remaining screening checks (e.g. freeze authority) are fully enforced", async () => {
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
        clock,
        sleepFn,
        isSyntheticFixture: true,
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

      // Active freeze authority present on pool -> MUST trigger REJECTED_ACTIVE_FREEZE_AUTHORITY
      const poolWithActiveFreeze = createSyntheticRayCandidatePool({
        openTimeSec: Math.floor(nowMs / 1000) - 600,
        freezeAuthority: "FreezeAuthorityPubkey111111111111111111111",
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
          });
        }
        return new Response(RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE, { status: 200 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
        sleepFn,
        evidenceOrigin: "CAPTURED_RPC",
      });

      const decisions: Array<{
        evalResult: unknown;
        pool: ScannedPoolRecord;
      }> = [];

      const engine = new CandidateStreamEngine({
        config: createConfig(),
        requireValidatedLp: true,
        lpEvidenceResolver: adapter,
        lpFreshnessPolicy: {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: nowMs + 1000,
        },
        onDecision: (res, p) => {
          decisions.push({ evalResult: res, pool: p });
        },
      });

      const pool = createSyntheticRayCandidatePool();
      const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      // Successfully acquired below-threshold measurement remains available in pool data
      expect(decisions[0]?.pool.lpBurnPct).toBe(0.135682);
      expect(transportCallCount).toBe(2);
      expect(budgetManager.getStats().totalRequests).toBe(2);
      expect(adapter.getLastResult()?.ok).toBe(true);
      expect(adapter.getLastResult()?.httpAttempts).toBe(2);
      expect(adapter.getLastResult()?.evidence.outcomes.meetsNinetyPercentThreshold).toBe(false);
    });

    it("counts dispatched request in budget when acquisition encounters HTTP failure", async () => {
      const nowMs = 1_700_000_000_000;
      const clock = () => nowMs;

      const budgetManager = new GlobalResourceBudgetManager({
        clock,
        maxTotalRequests: 10,
      });

      let transportCallCount = 0;
      const mockTransport: typeof fetch = async () => {
        transportCallCount++;
        // Request 1 fails with 500 Internal Server Error
        return new Response("Internal Server Error", { status: 500 });
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
        sleepFn: async () => {},
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
      expect(adapter.getLastResult()?.ok).toBe(false);
      expect(adapter.getLastResult()?.httpAttempts).toBe(1);
    });

    it("prevents request dispatch upfront when shared session budget is exhausted", async () => {
      const nowMs = 1_700_000_000_000;
      const clock = () => nowMs;

      // Budget manager with 0 total requests allowed
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
        sleepFn: async () => {},
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

    // =========================================================================
    // AUDIT CORRECTION 3: Reconcile evidence counts with actual dispatches
    // =========================================================================
    it("reconciles evidence counts with actual transport dispatches when Request 2 is denied by shared budget", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;
      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      // Exactly 1-request budget ceiling, 0 reserved forward requests
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

      // Critical reconciliation: underlying transport, shared budget, and acquisition evidence MUST agree on 1!
      expect(transportCallCount).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);

      const lastResult = adapter.getLastResult();
      expect(lastResult).toBeDefined();
      expect(lastResult?.ok).toBe(false);
      expect(lastResult?.httpAttempts).toBe(1);
      expect(lastResult?.evidence.httpAttempts).toBe(1);

      // Pre-dispatch budget denial is recorded separately from dispatched HTTP failures
      const req2 = lastResult?.evidence.requests[1];
      expect(req2).toBeDefined();
      expect(req2?.error).toContain("PRE_DISPATCH_BUDGET_DENIED");
      expect(req2?.httpStatus).toBeNull();
      expect(req2?.rawResponseBody).toBeNull();
      expect(lastResult?.evidence.failureReason).toContain("pre-dispatch budget denial");
    });

    // =========================================================================
    // AUDIT CORRECTION 1: Respect unsuccessful acquisition results (storage failure)
    // =========================================================================
    it("fails closed at adapter boundary when evidence storage fails, preserving diagnostics without qualifying candidate", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-adapter-storage-test-"));
      const impossibleOutDir = path.join(tempDir, "file-blocking-dir");
      // Create a plain file at impossibleOutDir so that mkdir inside snapshot acquisition fails with ENOTDIR or EEXIST
      await fs.writeFile(impossibleOutDir, "blocking file", "utf-8");

      try {
        let nowMs = 1_700_000_000_000;
        const clock = () => nowMs;
        const sleepFn = async (ms: number) => {
          nowMs += ms;
        };

        const budgetManager = new GlobalResourceBudgetManager({ clock, maxTotalRequests: 10 });
        let transportCallCount = 0;
        const mockTransport: typeof fetch = async (_input, init) => {
          transportCallCount++;
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (body.method === "getAccountInfo") {
            return new Response(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE, {
              status: 200,
            });
          }
          // Synthetic qualifying payload (would qualify with 98.5% burn if acquisition succeeded)
          return new Response(JSON.stringify(SYNTHETIC_QUALIFIED_RAW_PAYLOAD), { status: 200 });
        };

        const adapter = new RaydiumAmmV4LpEvidenceAdapter({
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          outDir: impossibleOutDir,
          clock,
          sleepFn,
          isSyntheticFixture: true,
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

        const pool = createSyntheticRayCandidatePool({
          openTimeSec: Math.floor(nowMs / 1000) - 600,
          liquidityUsd: 125_000,
          txCount5m: 25,
          volume5mUsd: 15_000,
          buys5m: 18,
          sells5m: 7,
        });

        const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

        // CRITICAL: Intake MUST NOT admit qualifying synthetic candidate on storage failure!
        expect(evalResult.admitted).toBe(false);
        expect(evalResult.primaryRejectionReason).toBe("REJECTED_INVALID_POOL_METADATA");

        // Diagnostics are preserved on the adapter result
        const lastResult = adapter.getLastResult();
        expect(lastResult).toBeDefined();
        expect(lastResult?.ok).toBe(false);
        expect(lastResult?.evidence.failureReason).toContain("EVIDENCE_STORAGE_FAILED");
        expect(lastResult?.evidence.validationResult).toBeDefined();
        expect(lastResult?.evidence.accounting).toBeDefined();

        expect(transportCallCount).toBe(2);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    // =========================================================================
    // AUDIT CORRECTION 2: Include shared pacing waits within the deadline
    // =========================================================================
    it("enforces unified deadline covering shared provider pacing wait between requests (Auditor Reproduction)", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;

      // Auditor Reproduction:
      // Shared provider spacing: 10,000 ms
      // Overall acquisition timeout: 5,000 ms
      // Request 1 dispatches at 0 ms
      // Request 2 would need to dispatch at 10,000 ms -> MUST be prevented from dispatching and admission!
      const budgetManager = new GlobalResourceBudgetManager({
        clock,
        minProviderSpacingMs: 10_000,
        maxTotalRequests: 10,
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

      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 2500,
        overallTimeoutMs: 5000, // 5,000 ms overall deadline
        clock,
        sleepFn,
        isSyntheticFixture: true,
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

      // CRITICAL: Intake MUST NOT admit candidate when shared pacing exceeds deadline!
      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_INVALID_POOL_METADATA");

      // Request 2 was NOT dispatched (only Request 1 executed)
      expect(transportCallCount).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);

      const lastResult = adapter.getLastResult();
      expect(lastResult?.ok).toBe(false);
      expect(lastResult?.httpAttempts).toBe(1);
      expect(lastResult?.evidence.requests[1]?.error).toContain("DEADLINE_EXCEEDED");
    });

    it("fails closed when initial shared pacing wait exceeds overall acquisition deadline", async () => {
      let nowMs = 1_700_000_000_000;
      const clock = () => nowMs;

      const budgetManager = new GlobalResourceBudgetManager({
        clock,
        minProviderSpacingMs: 10_000,
        maxTotalRequests: 10,
      });

      // Simulate that a prior request occurred at nowMs
      budgetManager.recordRequestAttempt("SOLANA_RPC", "CANDIDATE_ENRICHMENT", nowMs);

      let transportCallCount = 0;
      const mockTransport: typeof fetch = async () => {
        transportCallCount++;
        return new Response("{}", { status: 200 });
      };

      const sleepFn = async (ms: number) => {
        nowMs += ms;
      };

      const adapter = new RaydiumAmmV4LpEvidenceAdapter({
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        overallTimeoutMs: 5000, // 5,000 ms overall deadline < 10,000 ms required pacing wait
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

      // Fails closed immediately without dispatching Request 1
      expect(evalResult.admitted).toBe(false);
      expect(transportCallCount).toBe(0);
      expect(budgetManager.getStats().totalRequests).toBe(1); // Only the initial pre-existing request
    });

    it("fails closed when request is aborted during pacing sleep", async () => {
      const nowMs = 1_700_000_000_000;
      const clock = () => nowMs;

      const budgetManager = new GlobalResourceBudgetManager({
        clock,
        minProviderSpacingMs: 2500,
        maxTotalRequests: 10,
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

      // Sleeper simulates cancellation during sleep by throwing an abort-like error
      const sleepFn = async () => {
        throw new Error("PACING_CANCELLED_BY_SIGNAL");
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
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: nowMs + 1000,
        },
      });

      const pool = createSyntheticRayCandidatePool();
      const evalResult = await engine.evaluatePoolAsync(pool, Math.floor(nowMs / 1000));

      expect(evalResult.admitted).toBe(false);
      expect(evalResult.primaryRejectionReason).toBe("REJECTED_INVALID_POOL_METADATA");
      // Request 2 was interrupted during pacing and never dispatched
      expect(transportCallCount).toBe(1);
      expect(adapter.getLastResult()?.ok).toBe(false);
      expect(adapter.getLastResult()?.evidence.failureReason).toContain("PACING_INTERRUPTED");
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
