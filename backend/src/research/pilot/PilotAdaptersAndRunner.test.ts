/**
 * Phase 12.94-D Milestone D.2.3: Pilot Adapters, Clock, Schema Bridge, Manifest & Runner Tests
 *
 * Verifies DexScreener parsing, Solana RPC slot coherence, dual-domain clock causality (D23P-03),
 * canonical 5-tuple schema bridging, SHA-256 export manifest verification (D23P-04),
 * and runner lifecycle state transitions (ACTIVE, FINALIZED, INTERRUPTED).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseDexScreenerPairsResponse,
  parseDexScreenerTokenProfiles,
} from "./DexScreenerResponseAdapter.js";
import {
  detectSlotDiscrepancy,
  parseSolanaRpcMultipleVaultsResponse,
  parseSolanaRpcPoolAccountResponse,
} from "./SolanaRpcResponseAdapter.js";
import {
  computeMonotonicElapsed,
  DeterministicPilotClock,
  validateCausalEpochOrdering,
} from "./PilotClock.js";
import {
  D23_OBSERVATIONAL_PROVIDER,
  D23_STRATEGY_REVISION,
  SYNTHETIC_UNAVAILABLE_SOURCE_TIMESTAMP_MS,
  toCanonicalCandidateDecision,
  toCanonicalMarketObservation,
  toCanonicalShadowEvaluation,
} from "./PilotSchemaBridge.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "./RaydiumAmmParser.js";
import {
  generateSessionExportManifest,
  verifySessionExportManifest,
} from "./PilotExportManifest.js";
import {
  PilotCollectorRunner,
  validateCandidateCausality,
  validatePathConfinement,
} from "./PilotCollectorRunner.js";
// @ts-expect-error D.1 readiness audit script is authored as .mjs with sibling .d.ts
import { runReadinessAudit } from "../../../../scripts/audit-research-readiness.mjs";
import {
  createAuthoritativeRaydiumAmmV4Buffer,
  createAuthoritativeSplVaultBuffer,
  FIXTURE_BASE_VAULT,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_QUOTE_VAULT,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";
import type { D23ObservationRecord, D23ScreenedCandidate } from "./PilotTypes.js";

describe("Pilot Adapters and Runner - Milestone D.2.3", () => {
  const mockCompositeId = {
    decisionEventId: "evt-test-001",
    sessionId: "session-pilot-test-01",
    generationId: "gen1-pilot",
    mintAddress: FIXTURE_MEME_MINT,
    poolId: FIXTURE_POOL_ADDRESS,
  };

  const mockCandidate: D23ScreenedCandidate = {
    compositeId: mockCompositeId,
    symbol: "MEME",
    decisionType: "CANDIDATE_DISCOVERY_PROFILE",
    decisionCohort: "WATCHLIST_RADAR",
    selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
    decisionEpochMs: 1791940001250,
    requestEpochMs: 1791940001000,
    receiptEpochMs: 1791940001200,
    sourceTimestampMs: null,
    passedEligibility: true,
    filterEvaluations: [
      { filterName: "MIN_LIQUIDITY_USD", passed: true, observed: 25000, threshold: 5000 },
    ],
    rejectionReasons: [],
    missingFields: ["sourceTimestampMs"],
    providerIdentity: D23_OBSERVATIONAL_PROVIDER,
  };

  const mockObservation: D23ObservationRecord = {
    observationId: "obs-test-001",
    compositeId: mockCompositeId,
    requestEpochMs: 1791940001000,
    receiptEpochMs: 1791940001200,
    sourceReportedTimeMs: null,
    hostMonotonicElapsedMs: 200,
    onChainSlot: 290001125,
    slotDiscrepancy: false,
    provenance: "D23_OBSERVATIONAL_SCREENING",
    providerIdentity: "solana_rpc_public_v1",
    actualResponsePoolId: FIXTURE_POOL_ADDRESS,
    isMatchingPool: true,
    reserveAccounting: {
      mode: "VAULT_ONLY_PROXY",
      tokenMint: FIXTURE_MEME_MINT,
      solMint: FIXTURE_WSOL_MINT,
      tokenReserveRaw: 75_000_000_000_000n,
      solReserveRaw: 100_000_000_000n,
      tokenDecimals: 6,
      solDecimals: 9,
      tokenReserveDecimal: 75_000_000,
      solReserveDecimal: 100,
      spotPriceSol: 100 / 75_000_000,
      orientation: "TOKEN_BASE_SOL_QUOTE",
      effectiveReservesAvailable: false,
      executionFeasible: false,
      unavailabilityReason: "VAULT_ONLY_RESERVES_INSUFFICIENT_FOR_FEASIBILITY",
    },
    flowMetrics: {
      volume5mUsd: 1250,
      buys5m: 15,
      sells5m: 8,
      netBuyerVolumeUsd: 350,
    },
    missingFields: ["sourceTimestampMs"],
  };

  describe("DexScreener Response Adapter", () => {
    it("parses latest token profiles and filters for valid Solana base58 mints", () => {
      const mockProfiles = [
        {
          chainId: "solana",
          tokenAddress: FIXTURE_MEME_MINT,
          url: "https://dexscreener.com/solana/" + FIXTURE_MEME_MINT,
          description: "Meme token profile",
        },
        {
          chainId: "ethereum",
          tokenAddress: "0x1234567890abcdef1234567890abcdef12345678",
        },
        {
          chainId: "solana",
          tokenAddress: "InvalidNonBase58O0Il",
        },
      ];

      const result = parseDexScreenerTokenProfiles(mockProfiles);
      expect(result.ok).toBe(true);
      expect(result.candidates.length).toBe(1);
      const candidate0 = result.candidates[0];
      expect(candidate0).toBeDefined();
      if (!candidate0) return;
      expect(candidate0.tokenAddress).toBe(FIXTURE_MEME_MINT);
      expect(candidate0.selectionBias).toBe("DEXSCREENER_PROMOTIONAL_PROFILE");
      expect(result.nonSolanaProfilesSkipped).toBe(1);
      expect(result.invalidAddressProfilesSkipped).toBe(1);
    });

    it("parses pairs response and matches primary Raydium AMM candidate", () => {
      const mockPairsResponse = {
        pairs: [
          {
            chainId: "solana",
            dexId: "raydium",
            pairAddress: FIXTURE_POOL_ADDRESS,
            baseToken: { address: FIXTURE_MEME_MINT, symbol: "MEME" },
            quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
            priceUsd: "0.000015",
            priceNative: "0.0000001",
            liquidity: { usd: 25000 },
            volume: { m5: 1250 },
            txns: { m5: { buys: 15, sells: 8 } },
            pairCreatedAt: 1791000000000,
          },
        ],
      };

      const result = parseDexScreenerPairsResponse(mockPairsResponse, FIXTURE_MEME_MINT);
      expect(result.ok).toBe(true);
      expect(result.matchingRaydiumPair).not.toBeNull();
      if (!result.matchingRaydiumPair) return;

      expect(result.matchingRaydiumPair.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(result.matchingRaydiumPair.isRaydiumAmmCandidate).toBe(true);
      expect(result.matchingRaydiumPair.buys5m).toBe(15);
      expect(result.matchingRaydiumPair.sells5m).toBe(8);
      expect(result.matchingRaydiumPair.volume5mUsd).toBe(1250);
      // pairCreatedAt is preserved as historical birth time, never as current source timestamp (D23-A02)
      expect(result.matchingRaydiumPair.pairCreatedAtMs).toBe(1791000000000);
      expect(result.matchingRaydiumPair.sourceReportedTimeMs).toBeNull();
      expect(result.matchingRaydiumPair.missingFields).toContain("baseReserve");
      expect(result.matchingRaydiumPair.missingFields).toContain("quoteReserve");
    });
  });

  describe("Solana RPC Response Adapter", () => {
    it("parses getAccountInfo response with context slot and Raydium pool state", () => {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer({
        baseMintBase58: FIXTURE_MEME_MINT,
        quoteMintBase58: FIXTURE_WSOL_MINT,
      });

      const mockRpcResponse = {
        jsonrpc: "2.0",
        result: {
          context: { slot: 290001122 },
          value: {
            data: [poolBuffer.toString("base64"), "base64"],
            owner: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
            lamports: 5000000,
          },
        },
        id: 1,
      };

      const result = parseSolanaRpcPoolAccountResponse(mockRpcResponse, FIXTURE_POOL_ADDRESS);
      expect(result.ok).toBe(true);
      expect(result.slot).toBe(290001122);
      expect(result.poolState?.baseMint).toBe(FIXTURE_MEME_MINT);
      expect(result.poolState?.quoteMint).toBe(FIXTURE_WSOL_MINT);
    });

    it("parses getMultipleAccounts response verifying shared slot coherence (D23P-02)", () => {
      const baseBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        rawAmount: 75_000_000_000_000n,
      });
      const quoteBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_WSOL_MINT,
        rawAmount: 100_000_000_000n,
      });

      const mockRpcResponse = {
        jsonrpc: "2.0",
        result: {
          context: { slot: 290001125 },
          value: [
            {
              data: [baseBuffer.toString("base64"), "base64"],
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            },
            {
              data: [quoteBuffer.toString("base64"), "base64"],
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            },
          ],
        },
        id: 2,
      };

      const result = parseSolanaRpcMultipleVaultsResponse(
        mockRpcResponse,
        [FIXTURE_BASE_VAULT, FIXTURE_QUOTE_VAULT],
        [FIXTURE_MEME_MINT, FIXTURE_WSOL_MINT],
      );

      expect(result.ok).toBe(true);
      expect(result.slot).toBe(290001125);
      expect(result.balances?.baseVaultRaw).toBe(75_000_000_000_000n);
      expect(result.balances?.quoteVaultRaw).toBe(100_000_000_000n);
      expect(result.balances?.slotDiscrepancy).toBe(false);
      expect(result.balances?.slotDelta).toBe(0);
    });

    it("detects cross-request slot discrepancies accurately (D23P-02)", () => {
      const check1 = detectSlotDiscrepancy(290001120, 290001125);
      expect(check1.slotDiscrepancy).toBe(true);
      expect(check1.slotDelta).toBe(5);

      const check2 = detectSlotDiscrepancy(290001120, 290001120);
      expect(check2.slotDiscrepancy).toBe(false);
      expect(check2.slotDelta).toBe(0);
    });

    it("rejects RPC pool responses missing owner or with non-matching owner (D23F-01)", () => {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();

      // Missing owner property
      const responseMissingOwner = {
        jsonrpc: "2.0",
        result: {
          context: { slot: 290001122 },
          value: {
            data: [poolBuffer.toString("base64"), "base64"],
            lamports: 5000000,
          },
        },
        id: 1,
      };
      const res1 = parseSolanaRpcPoolAccountResponse(responseMissingOwner, FIXTURE_POOL_ADDRESS);
      expect(res1.ok).toBe(false);
      expect(res1.error).toContain("UNAUTHORIZED_POOL_OWNER");

      // Non-matching owner program
      const responseWrongOwner = {
        jsonrpc: "2.0",
        result: {
          context: { slot: 290001122 },
          value: {
            data: [poolBuffer.toString("base64"), "base64"],
            owner: SPL_TOKEN_PROGRAM_ID, // wrong program
            lamports: 5000000,
          },
        },
        id: 1,
      };
      const res2 = parseSolanaRpcPoolAccountResponse(responseWrongOwner, FIXTURE_POOL_ADDRESS);
      expect(res2.ok).toBe(false);
      expect(res2.error).toContain("UNAUTHORIZED_POOL_OWNER");
    });

    it("rejects RPC multiple vaults responses with non-matching owner (D23F-01)", () => {
      const baseBuffer = createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT });
      const quoteBuffer = createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT });

      const mockRpcResponseWrongOwner = {
        jsonrpc: "2.0",
        result: {
          context: { slot: 290001125 },
          value: [
            {
              data: [baseBuffer.toString("base64"), "base64"],
              owner: RAYDIUM_AMM_V4_PROGRAM_ID, // Raydium instead of SPL Token
            },
            {
              data: [quoteBuffer.toString("base64"), "base64"],
              owner: SPL_TOKEN_PROGRAM_ID,
            },
          ],
        },
        id: 2,
      };

      const result = parseSolanaRpcMultipleVaultsResponse(
        mockRpcResponseWrongOwner,
        [FIXTURE_BASE_VAULT, FIXTURE_QUOTE_VAULT],
        [FIXTURE_MEME_MINT, FIXTURE_WSOL_MINT],
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("UNAUTHORIZED_VAULT_OWNER");
    });
  });

  describe("Dual-Domain Clock & Causal Monotonicity (D23P-03)", () => {
    it("enforces causal epoch sequence: requestEpoch <= receiptEpoch <= decisionEpoch", () => {
      const valid = validateCausalEpochOrdering(1791940001000, 1791940001200, 1791940001250);
      expect(valid.valid).toBe(true);

      const lookahead = validateCausalEpochOrdering(1791940001000, 1791940001300, 1791940001200);
      expect(lookahead.valid).toBe(false);
      expect(lookahead.violationReason).toContain("LOOKAHEAD_VIOLATION");

      const invertedReq = validateCausalEpochOrdering(1791940001500, 1791940001200, 1791940001600);
      expect(invertedReq.valid).toBe(false);
      expect(invertedReq.violationReason).toContain("REQUEST_AFTER_RECEIPT");
    });

    it("computes elapsed time strictly in the host monotonic domain", () => {
      const elapsed = computeMonotonicElapsed(1234.5, 1250.7);
      expect(elapsed).toBeCloseTo(16.2);
    });

    it("operates deterministically with DeterministicPilotClock", () => {
      const clock = new DeterministicPilotClock(1791940000000, 500);
      expect(clock.getEpochNow()).toBe(1791940000000);
      expect(clock.getMonotonicNow()).toBe(500);

      clock.advanceBy(250);
      expect(clock.getEpochNow()).toBe(1791940000250);
      expect(clock.getMonotonicNow()).toBe(750);
    });
  });

  describe("Pilot Schema Bridge (D23P-03)", () => {
    it("translates candidate to CandidateDecisionRecord with accepted 5-tuple", () => {
      const canonical = toCanonicalCandidateDecision(mockCandidate, mockObservation);
      expect(canonical.eventId).toBe("evt-test-001");
      expect(canonical.sessionId).toBe("session-pilot-test-01");
      expect(canonical.generationId).toBe("gen1-pilot");
      expect(canonical.mintAddress).toBe(FIXTURE_MEME_MINT);
      expect(canonical.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(canonical.decisionCohort).toBe("WATCHLIST_RADAR");
      expect(canonical.strategyRevision).toBe(D23_STRATEGY_REVISION);
      expect(canonical.providerIdentity).toBe(D23_OBSERVATIONAL_PROVIDER);
      expect(canonical.missingFields).toContain("sourceTimestampMs");
    });

    it("translates to ShadowEvaluationRecord with 5-tuple and observational qualification", () => {
      const shadow = toCanonicalShadowEvaluation(mockCandidate, mockObservation);
      expect(shadow.decisionEventId).toBe("evt-test-001");
      expect(shadow.sessionId).toBe("session-pilot-test-01");
      expect(shadow.generationId).toBe("gen1-pilot");
      expect(shadow.mintAddress).toBe(FIXTURE_MEME_MINT);
      expect(shadow.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(shadow.qualificationResult.shadowTriggerQualified).toBe(false); // Observational only
      expect(shadow.qualificationResult.qualificationReason).toBe(
        "PASSED_PASSIVE_OBSERVATIONAL_CRITERIA",
      );
      expect(shadow.qualificationResult.executionFeasible).toBe(false); // Vault-only proxy is false
      expect(shadow.observedReserveSnapshot).toBeUndefined(); // null source time = no snapshot
    });

    it("translates to MarketObservationRecord", () => {
      const obs = toCanonicalMarketObservation(mockObservation);
      expect(obs.observationId).toBe("obs-test-001");
      expect(obs.sessionId).toBe("session-pilot-test-01");
      expect(obs.liquidityMetrics.baseReserve).toBe(75_000_000);
      expect(obs.liquidityMetrics.quoteReserve).toBe(100);
      expect(obs.flowMetrics.volumeUsd).toBe(1250);
      expect(obs.flowMetrics.buys).toBe(15);
      expect(obs.flowMetrics.sells).toBe(8);
    });

    it("truthfully handles unavailable sourceTimestampMs with sentinel 0 and missingFields (D23F-04)", () => {
      const candidateWithoutTime: D23ScreenedCandidate = {
        ...mockCandidate,
        sourceTimestampMs: null,
      };
      const canonical = toCanonicalCandidateDecision(candidateWithoutTime, mockObservation);
      expect(canonical.sourceTimestampMs).toBe(SYNTHETIC_UNAVAILABLE_SOURCE_TIMESTAMP_MS);
      expect(canonical.sourceTimestampMs).toBe(0);
      expect(canonical.missingFields).toContain("sourceTimestampMs");

      const observationWithoutTime: D23ObservationRecord = {
        ...mockObservation,
        sourceReportedTimeMs: null,
      };
      const canonicalObs = toCanonicalMarketObservation(observationWithoutTime);
      expect(canonicalObs.sourceTimestampMs).toBe(SYNTHETIC_UNAVAILABLE_SOURCE_TIMESTAMP_MS);
      expect(canonicalObs.sourceTimestampMs).toBe(0);
      expect(canonicalObs.dataFreshnessMs).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("marks all absent or non-finite metrics as UNAVAILABLE in metricProvenance (D23F-04)", () => {
      const observationWithNan: D23ObservationRecord = {
        ...mockObservation,
        reserveAccounting: {
          ...mockObservation.reserveAccounting!,
          tokenReserveDecimal: NaN,
          solReserveDecimal: undefined as unknown as number,
          spotPriceSol: NaN,
        },
        flowMetrics: {
          volume5mUsd: NaN,
          buys5m: 0,
          sells5m: 0,
          netBuyerVolumeUsd: 0,
        },
      };

      const canonical = toCanonicalCandidateDecision(mockCandidate, observationWithNan);
      expect(canonical.metricsSnapshot.metricProvenance?.spotPriceSol).toBe("UNAVAILABLE");
      expect(canonical.metricsSnapshot.metricProvenance?.volume5mUsd).toBe("UNAVAILABLE");
      expect(canonical.metricsSnapshot.metricProvenance?.tokenAgeSec).toBe("UNAVAILABLE");
      expect(canonical.metricsSnapshot.metricProvenance?.liquidityUsd).toBe("UNAVAILABLE");

      const canonicalObs = toCanonicalMarketObservation(observationWithNan);
      expect(canonicalObs.priceMetrics.spotPriceSol).toBeNull();
      expect(canonicalObs.flowMetrics.volumeUsd).toBeNull();
    });
  });

  describe("Dataset Export Manifest (D23P-04)", () => {
    it("generates and verifies SHA-256 export manifest successfully", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-manifest-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        await fs.writeFile(path.join(testDir, "session-meta.json"), '{"status":"FINALIZED"}\n');
        await fs.writeFile(
          path.join(testDir, "candidate-decisions.jsonl"),
          '{"eventId":"e1"}\n{"eventId":"e2"}\n',
        );

        const manifest = await generateSessionExportManifest(
          testDir,
          "session-manifest-01",
          "gen1-test",
        );

        expect(manifest.files.length).toBe(2);
        expect(manifest.manifestDigestSha256.length).toBe(64);

        const verifyResult = await verifySessionExportManifest(testDir);
        expect(verifyResult.valid).toBe(true);
        expect(verifyResult.mismatchedFiles.length).toBe(0);
        expect(verifyResult.missingFiles.length).toBe(0);
        expect(verifyResult.extraFiles.length).toBe(0);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("detects corrupted file contents during manifest verification", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-manifest-corrupt-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        await fs.writeFile(path.join(testDir, "session-meta.json"), '{"status":"FINALIZED"}\n');
        await generateSessionExportManifest(testDir, "session-01", "gen1");

        // Tamper with file content post-export
        await fs.writeFile(path.join(testDir, "session-meta.json"), '{"status":"TAMPERED"}\n');

        const verifyResult = await verifySessionExportManifest(testDir);
        expect(verifyResult.valid).toBe(false);
        expect(verifyResult.mismatchedFiles).toContain("session-meta.json");
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });
  });

  describe("Pilot Collector Runner Lifecycle & Recovery", () => {
    it("executes lifecycle, enforces quotas, and finalizes with dual-file consensus", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-runner-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        const runner = new PilotCollectorRunner({
          sessionId: "test-session-runner-01",
          generationId: "gen1-runner",
          strategyRevision: D23_STRATEGY_REVISION,
          outputRootDir: testDir,
          targetCandidates: 2,
          targetPools: 1,
        });

        await runner.initialize();
        expect(runner.getStatus()).toBe("ACTIVE");

        const mockCandidate: D23ScreenedCandidate = {
          compositeId: {
            decisionEventId: "evt-01",
            sessionId: "test-session-runner-01",
            generationId: "gen1-runner",
            mintAddress: FIXTURE_MEME_MINT,
            poolId: FIXTURE_POOL_ADDRESS,
          },
          symbol: "MEME",
          decisionType: "CANDIDATE_DISCOVERY_PROFILE",
          decisionCohort: "WATCHLIST_RADAR",
          selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
          decisionEpochMs: 1791940001000,
          requestEpochMs: 1791940000800,
          receiptEpochMs: 1791940000950,
          sourceTimestampMs: null,
          passedEligibility: true,
          filterEvaluations: [],
          rejectionReasons: [],
          missingFields: ["sourceTimestampMs"],
          providerIdentity: D23_OBSERVATIONAL_PROVIDER,
        };

        await runner.recordScreenedCandidate(mockCandidate);
        expect(runner.getStatus()).toBe("ACTIVE");

        // Second candidate reaches target (targetCandidates = 2, uniquePools = 1)
        const mockCandidate2: D23ScreenedCandidate = {
          ...mockCandidate,
          compositeId: { ...mockCandidate.compositeId, decisionEventId: "evt-02" },
        };
        await runner.recordScreenedCandidate(mockCandidate2);

        expect(runner.getStatus()).toBe("FINALIZED");
        const stats = runner.getStats();
        expect(stats.candidates).toBe(2);
        expect(stats.radar).toBe(2);
        expect(stats.pools).toBe(1);

        // Verify manifest was automatically generated upon finalization
        const sessionPath = runner.getSessionDirectory();
        const manifestVerify = await verifySessionExportManifest(sessionPath);
        expect(manifestVerify.valid).toBe(true);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("recovers an unfinalized session by repairing status to INTERRUPTED (D23P-04)", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-recovery-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        const sessionPath = path.join(testDir, "test-session-unfinalized");
        await fs.mkdir(sessionPath, { recursive: true });

        // Simulate active unfinalized session meta and torn jsonl line
        await fs.writeFile(
          path.join(sessionPath, "session-meta.json"),
          JSON.stringify({ sessionId: "test-session-unfinalized", status: "ACTIVE" }, null, 2),
        );
        await fs.writeFile(
          path.join(sessionPath, "candidate-decisions.jsonl"),
          '{"eventId":"valid-01"}\n{"incomplete-torn-line\n',
        );

        const recovery = await PilotCollectorRunner.recoverSession(sessionPath);
        expect(recovery.recovered).toBe(true);
        expect(recovery.status).toBe("INTERRUPTED");
        expect(recovery.tornLinesIsolated).toBe(1);

        // Re-read meta
        const metaContent = await fs.readFile(path.join(sessionPath, "session-meta.json"), "utf8");
        const meta = JSON.parse(metaContent);
        expect(meta.status).toBe("INTERRUPTED");
        expect(meta.interruptionReason).toBe("RECOVERED_FROM_UNGRACEFUL_PROCESS_INTERRUPTION");
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("rejects relative path traversal and invalid characters in sessionId (D23F-02)", () => {
      expect(() => {
        new PilotCollectorRunner({
          sessionId: "../traversal-attempt",
          generationId: "gen1",
          strategyRevision: D23_STRATEGY_REVISION,
          outputRootDir: os.tmpdir(),
        });
      }).toThrow(/SESSION_ID_CONTAINS_PATH_SEPARATORS_OR_TRAVERSAL/);

      expect(() => {
        new PilotCollectorRunner({
          sessionId: "invalid/slash",
          generationId: "gen1",
          strategyRevision: D23_STRATEGY_REVISION,
          outputRootDir: os.tmpdir(),
        });
      }).toThrow(/SESSION_ID_CONTAINS_PATH_SEPARATORS_OR_TRAVERSAL/);

      expect(() => {
        new PilotCollectorRunner({
          sessionId: "invalid*chars!",
          generationId: "gen1",
          strategyRevision: D23_STRATEGY_REVISION,
          outputRootDir: os.tmpdir(),
        });
      }).toThrow(/SESSION_ID_INVALID_CHARACTERS/);
    });

    it("enforces path confinement to allowed root directory (D23F-02)", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-confinement-${Date.now()}`);
      const allowedDir = path.join(testDir, "allowed");
      const outsideDir = path.join(testDir, "outside");
      await fs.mkdir(allowedDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });

      try {
        expect(() => {
          new PilotCollectorRunner({
            sessionId: "test-confined-01",
            generationId: "gen1",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: outsideDir,
            allowedRootDir: allowedDir,
          });
        }).toThrow(/PATH_CONFINEMENT_VIOLATION/);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("enforces prospective file admission and bounds quota breach with emergency metadata (D23F-02)", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-quota-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        const runner = new PilotCollectorRunner({
          sessionId: "test-quota-01",
          generationId: "gen1-runner",
          strategyRevision: D23_STRATEGY_REVISION,
          outputRootDir: testDir,
          maxDiskBytes: 500, // Very small quota to trigger breach
          maxEmergencyDiskBytes: 4096,
        });

        await runner.initialize();
        expect(runner.getStatus()).toBe("ACTIVE");

        const sampleCandidate: D23ScreenedCandidate = {
          ...mockCandidate,
          compositeId: {
            ...mockCandidate.compositeId,
            sessionId: "test-quota-01",
            generationId: "gen1-runner",
          },
        };

        // Recording a candidate will write ~1-2 KB to jsonl, which exceeds 500 bytes prospective quota
        await expect(runner.recordScreenedCandidate(sampleCandidate)).rejects.toThrow(
          /STORAGE_QUOTA_EXCEEDED/,
        );

        expect(runner.getStatus()).toBe("INTERRUPTED");
        expect(runner.getInterruptionReason()).toContain("STORAGE_QUOTA_EXCEEDED");

        // Verify emergency metadata was written and total session directory size is within bounds
        const sessionPath = runner.getSessionDirectory();
        const metaPath = path.join(sessionPath, "session-meta.json");
        const metaStats = await fs.stat(metaPath);
        expect(metaStats.size).toBeLessThanOrEqual(4096);

        const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
        expect(meta.sessionStatus).toBe("INTERRUPTED");
        expect(meta.isInterruptedSession).toBe(true);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("rejects duplicate decisionEventId before writing to disk (D23F-03)", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-dup-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        const runner = new PilotCollectorRunner({
          sessionId: "session-dup-test-01",
          generationId: "gen1-pilot",
          strategyRevision: D23_STRATEGY_REVISION,
          outputRootDir: testDir,
          targetCandidates: 10,
        });
        await runner.initialize();

        const candidateToRecord: D23ScreenedCandidate = {
          ...mockCandidate,
          compositeId: {
            ...mockCandidate.compositeId,
            sessionId: "session-dup-test-01",
            generationId: "gen1-pilot",
            decisionEventId: "evt-dup-01",
          },
        };

        await runner.recordScreenedCandidate(candidateToRecord);

        // Attempting to record same decisionEventId must be rejected
        await expect(runner.recordScreenedCandidate(candidateToRecord)).rejects.toThrow(
          /DUPLICATE_DECISION_ID/,
        );
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("rejects foreign session and generation attribution before writing to disk (D23F-03)", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-foreign-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        const runner = new PilotCollectorRunner({
          sessionId: "session-local-01",
          generationId: "gen1-local",
          strategyRevision: D23_STRATEGY_REVISION,
          outputRootDir: testDir,
        });
        await runner.initialize();

        // Foreign sessionId candidate
        const foreignCandidate: D23ScreenedCandidate = {
          ...mockCandidate,
          compositeId: {
            ...mockCandidate.compositeId,
            sessionId: "session-foreign-99",
            generationId: "gen1-local",
          },
        };
        await expect(runner.recordScreenedCandidate(foreignCandidate)).rejects.toThrow(
          /FOREIGN_SESSION_ATTRIBUTION/,
        );

        // Foreign generationId candidate
        const foreignGenCandidate: D23ScreenedCandidate = {
          ...mockCandidate,
          compositeId: {
            ...mockCandidate.compositeId,
            sessionId: "session-local-01",
            generationId: "gen2-foreign",
          },
        };
        await expect(runner.recordScreenedCandidate(foreignGenCandidate)).rejects.toThrow(
          /FOREIGN_GENERATION_ATTRIBUTION/,
        );

        // Valid local candidate
        const localCandidate: D23ScreenedCandidate = {
          ...mockCandidate,
          compositeId: {
            ...mockCandidate.compositeId,
            sessionId: "session-local-01",
            generationId: "gen1-local",
          },
        };

        // Foreign sessionId observation
        const foreignSessionObservation: D23ObservationRecord = {
          ...mockObservation,
          compositeId: {
            ...mockObservation.compositeId,
            sessionId: "session-foreign-99",
            generationId: "gen1-local",
          },
        };
        await expect(
          runner.recordScreenedCandidate(localCandidate, foreignSessionObservation),
        ).rejects.toThrow(/FOREIGN_SESSION_ATTRIBUTION/);

        // Foreign generationId observation
        const foreignGenObservation: D23ObservationRecord = {
          ...mockObservation,
          compositeId: {
            ...mockObservation.compositeId,
            sessionId: "session-local-01",
            generationId: "gen2-foreign",
          },
        };
        await expect(
          runner.recordScreenedCandidate(localCandidate, foreignGenObservation),
        ).rejects.toThrow(/FOREIGN_GENERATION_ATTRIBUTION/);
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("fails closed and marks INTERRUPTED when on-disk metric is modified before finalization (D23F-03)", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-tamper-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        const runner = new PilotCollectorRunner({
          sessionId: "session-tamper-01",
          generationId: "gen1-pilot",
          strategyRevision: D23_STRATEGY_REVISION,
          outputRootDir: testDir,
          targetCandidates: 10,
        });
        await runner.initialize();

        const candidateToRecord: D23ScreenedCandidate = {
          ...mockCandidate,
          compositeId: {
            ...mockCandidate.compositeId,
            sessionId: "session-tamper-01",
            generationId: "gen1-pilot",
            decisionEventId: "evt-tamper-01",
          },
        };

        await runner.recordScreenedCandidate(candidateToRecord);

        // Tamper with the persisted decision record on disk before finalization
        const decisionsPath = path.join(runner.getSessionDirectory(), "candidate-decisions.jsonl");
        const originalContent = await fs.readFile(decisionsPath, "utf8");
        const tamperedContent = originalContent.replace('"WATCHLIST_RADAR"', '"EXECUTE_BUY"');
        await fs.writeFile(decisionsPath, tamperedContent, "utf8");

        // Attempting to finalize must fail reconciliation and switch to INTERRUPTED
        await expect(runner.finalize("FINALIZED")).rejects.toThrow(
          /RECONCILIATION_IDENTITY_MISMATCH/,
        );

        expect(runner.getStatus()).toBe("INTERRUPTED");
        expect(runner.getInterruptionReason()).toContain("RECONCILIATION_IDENTITY_MISMATCH");
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    it("downgrades an already FINALIZED session to INTERRUPTED when recovering a corrupted archive (D23F-03)", async () => {
      const testDir = path.join(os.tmpdir(), `nexustrade-test-downgrade-${Date.now()}`);
      await fs.mkdir(testDir, { recursive: true });

      try {
        const sessionPath = path.join(testDir, "test-session-corrupt-finalized");
        await fs.mkdir(sessionPath, { recursive: true });

        // Session was previously marked FINALIZED
        await fs.writeFile(
          path.join(sessionPath, "session-meta.json"),
          JSON.stringify(
            { sessionId: "test-session-corrupt-finalized", sessionStatus: "FINALIZED" },
            null,
            2,
          ),
        );
        await fs.writeFile(
          path.join(sessionPath, "session-summary.json"),
          JSON.stringify(
            { sessionId: "test-session-corrupt-finalized", isCompleteSession: true },
            null,
            2,
          ),
        );
        // But jsonl archive has a torn line
        await fs.writeFile(
          path.join(sessionPath, "candidate-decisions.jsonl"),
          '{"eventId":"valid-01"}\n{"corrupt_torn_chunk\n',
        );

        const recovery = await PilotCollectorRunner.recoverSession(sessionPath);
        expect(recovery.recovered).toBe(true);
        expect(recovery.status).toBe("INTERRUPTED");
        expect(recovery.tornLinesIsolated).toBe(1);

        const metaContent = await fs.readFile(path.join(sessionPath, "session-meta.json"), "utf8");
        const meta = JSON.parse(metaContent);
        expect(meta.sessionStatus).toBe("INTERRUPTED");
        expect(meta.status).toBe("INTERRUPTED");
        expect(meta.interruptionReason).toBe("CORRUPTED_FINALIZED_ARCHIVE_QUARANTINED");
      } finally {
        await fs.rm(testDir, { recursive: true, force: true });
      }
    });

    // =========================================================================
    // Focused Re-audit v2 Targeted Adversarial Tests (D23R-01 through D23R-04)
    // =========================================================================

    describe("Temporal Causality, Source Timestamp & Eligibility Enforcement (D23R-01)", () => {
      it("directly validates candidate causality helper (D23R-01)", () => {
        const validResult = validateCandidateCausality(mockCandidate, mockObservation);
        expect(validResult.valid).toBe(true);

        const invalidResult = validateCandidateCausality({
          ...mockCandidate,
          requestEpochMs: mockCandidate.receiptEpochMs + 100,
        });
        expect(invalidResult.valid).toBe(false);
        expect(invalidResult.error).toContain("REQUEST_AFTER_RECEIPT");
      });

      it("rejects candidate when receiptEpochMs > decisionEpochMs (lookahead violation)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-causal-lookahead-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          const runner = new PilotCollectorRunner({
            sessionId: "session-causal-01",
            generationId: "gen1-pilot",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: testDir,
            targetCandidates: 1,
          });
          await runner.initialize();

          const lookaheadCandidate: D23ScreenedCandidate = {
            ...mockCandidate,
            compositeId: {
              ...mockCandidate.compositeId,
              sessionId: "session-causal-01",
              decisionEventId: "evt-lookahead-01",
            },
            requestEpochMs: 1791940001000,
            receiptEpochMs: 1791940001300, // Response after decision!
            decisionEpochMs: 1791940001200,
          };

          await expect(runner.recordScreenedCandidate(lookaheadCandidate)).rejects.toThrow(
            /LOOKAHEAD_VIOLATION/,
          );
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });

      it("rejects candidate when sourceTimestampMs > decisionEpochMs (future source time)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-causal-source-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          const runner = new PilotCollectorRunner({
            sessionId: "session-causal-02",
            generationId: "gen1-pilot",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: testDir,
            targetCandidates: 1,
          });
          await runner.initialize();

          const futureSourceCandidate: D23ScreenedCandidate = {
            ...mockCandidate,
            compositeId: {
              ...mockCandidate.compositeId,
              sessionId: "session-causal-02",
              decisionEventId: "evt-source-future-01",
            },
            requestEpochMs: 1791940001000,
            receiptEpochMs: 1791940001200,
            decisionEpochMs: 1791940001250,
            sourceTimestampMs: 1791940001300, // Future provider source time!
          };

          await expect(runner.recordScreenedCandidate(futureSourceCandidate)).rejects.toThrow(
            /FUTURE_SOURCE_TIMESTAMP_LOOKAHEAD/,
          );
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });

      it("rejects candidate when requestEpochMs > receiptEpochMs (inverted causality)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-causal-inverted-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          const runner = new PilotCollectorRunner({
            sessionId: "session-causal-03",
            generationId: "gen1-pilot",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: testDir,
            targetCandidates: 1,
          });
          await runner.initialize();

          const invertedReqCandidate: D23ScreenedCandidate = {
            ...mockCandidate,
            compositeId: {
              ...mockCandidate.compositeId,
              sessionId: "session-causal-03",
              decisionEventId: "evt-inverted-req-01",
            },
            requestEpochMs: 1791940001500, // Request after receipt!
            receiptEpochMs: 1791940001200,
            decisionEpochMs: 1791940001600,
          };

          await expect(runner.recordScreenedCandidate(invertedReqCandidate)).rejects.toThrow(
            /REQUEST_AFTER_RECEIPT/,
          );
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });

      it("rejects observation with mismatched mint address or late observation receipt (D23R-01)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-obs-mismatch-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          const runner = new PilotCollectorRunner({
            sessionId: "session-causal-04",
            generationId: "gen1-pilot",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: testDir,
            targetCandidates: 1,
          });
          await runner.initialize();

          const validCandidate: D23ScreenedCandidate = {
            ...mockCandidate,
            compositeId: {
              ...mockCandidate.compositeId,
              sessionId: "session-causal-04",
              decisionEventId: "evt-obs-mismatch-01",
            },
          };

          // Mismatched mint address
          const mismatchedMintObs: D23ObservationRecord = {
            ...mockObservation,
            compositeId: {
              ...mockObservation.compositeId,
              sessionId: "session-causal-04",
              decisionEventId: "evt-obs-mismatch-01",
              mintAddress: "So11111111111111111111111111111111111111112", // Mismatched!
            },
          };

          await expect(
            runner.recordScreenedCandidate(validCandidate, mismatchedMintObs),
          ).rejects.toThrow(/COMPOSITE_FOREIGN_KEY_MISMATCH/);

          // Observation receipt after candidate decision
          const lateObs: D23ObservationRecord = {
            ...mockObservation,
            compositeId: {
              ...mockObservation.compositeId,
              sessionId: "session-causal-04",
              decisionEventId: "evt-obs-mismatch-01",
            },
            receiptEpochMs: validCandidate.decisionEpochMs + 100, // After decision!
          };

          await expect(runner.recordScreenedCandidate(validCandidate, lateObs)).rejects.toThrow(
            /OBSERVATION_LOOKAHEAD/,
          );
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });
    });

    describe("Recovery Cross-File Identity Consensus & Record Counts (D23R-02)", () => {
      it("downgrades FINALIZED session to INTERRUPTED on generationId contradiction even with valid manifest (D23R-02)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-rec-contra-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          const sessionPath = path.join(testDir, "test-session-consensus-contra");
          await fs.mkdir(sessionPath, { recursive: true });

          // 1. Create a valid finalized session
          const runner = new PilotCollectorRunner({
            sessionId: "test-session-consensus-contra",
            generationId: "gen1-pilot",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: testDir,
            targetCandidates: 1,
            targetPools: 1,
          });
          await runner.initialize();
          await runner.recordScreenedCandidate(
            {
              ...mockCandidate,
              compositeId: {
                ...mockCandidate.compositeId,
                sessionId: "test-session-consensus-contra",
                generationId: "gen1-pilot",
                decisionEventId: "evt-consensus-01",
              },
            },
            {
              ...mockObservation,
              compositeId: {
                ...mockObservation.compositeId,
                sessionId: "test-session-consensus-contra",
                generationId: "gen1-pilot",
                decisionEventId: "evt-consensus-01",
              },
            },
          );
          await runner.finalize("FINALIZED");
          expect(runner.getStatus()).toBe("FINALIZED");

          // 2. Tamper session-summary.json generationId to "gen2-contradiction"
          const summaryPath = path.join(sessionPath, "session-summary.json");
          const summaryContent = await fs.readFile(summaryPath, "utf8");
          const summaryJson = JSON.parse(summaryContent);
          summaryJson.generationId = "gen2-contradiction";
          await fs.writeFile(summaryPath, JSON.stringify(summaryJson, null, 2), "utf8");

          // 3. Regenerate export manifest so file hashes match
          await generateSessionExportManifest(
            sessionPath,
            "test-session-consensus-contra",
            "gen1-pilot",
            Date.now(),
          );

          // 4. Recover session - must detect identity contradiction and fail closed to INTERRUPTED
          const recovery = await PilotCollectorRunner.recoverSession(sessionPath);
          expect(recovery.recovered).toBe(true);
          expect(recovery.status).toBe("INTERRUPTED");

          const repairedMeta = JSON.parse(
            await fs.readFile(path.join(sessionPath, "session-meta.json"), "utf8"),
          );
          expect(repairedMeta.sessionStatus).toBe("INTERRUPTED");
          expect(repairedMeta.status).toBe("INTERRUPTED");
          expect(repairedMeta.interruptionReason).toBe("METADATA_SUMMARY_IDENTITY_CONTRADICTION");

          const repairedSummary = JSON.parse(
            await fs.readFile(path.join(sessionPath, "session-summary.json"), "utf8"),
          );
          expect(repairedSummary.status).toBe("INTERRUPTED");
          expect(repairedSummary.isCompleteSession).toBe(false);
          expect(repairedSummary.isInterruptedSession).toBe(true);
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });

      it("downgrades FINALIZED session to INTERRUPTED when decision count contradicts summary (D23R-02)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-rec-count-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          const sessionPath = path.join(testDir, "test-session-count-contra");
          await fs.mkdir(sessionPath, { recursive: true });

          const runner = new PilotCollectorRunner({
            sessionId: "test-session-count-contra",
            generationId: "gen1-pilot",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: testDir,
            targetCandidates: 1,
            targetPools: 1,
          });
          await runner.initialize();
          await runner.recordScreenedCandidate({
            ...mockCandidate,
            compositeId: {
              ...mockCandidate.compositeId,
              sessionId: "test-session-count-contra",
              generationId: "gen1-pilot",
              decisionEventId: "evt-count-01",
            },
          });
          await runner.finalize("FINALIZED");

          // Tamper summary to claim 5 decisions instead of 1
          const summaryPath = path.join(sessionPath, "session-summary.json");
          const summaryJson = JSON.parse(await fs.readFile(summaryPath, "utf8"));
          summaryJson.totalCandidatesScreened = 5;
          summaryJson.totalDecisionsRecorded = 5;
          await fs.writeFile(summaryPath, JSON.stringify(summaryJson, null, 2), "utf8");

          const recovery = await PilotCollectorRunner.recoverSession(sessionPath);
          expect(recovery.status).toBe("INTERRUPTED");
          expect(
            recovery.diagnostics.some(
              (d) =>
                d.includes("RECORD_COUNT_SUMMARY_CONTRADICTION") ||
                d.includes("Candidate decisions count"),
            ),
          ).toBe(true);
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });
    });

    describe("Concurrent Duplicate Admission & Drain Synchronization (D23R-03)", () => {
      it("prevents concurrent duplicate event IDs: exactly one write succeeds, exactly one duplicate rejected (D23R-03)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-concurrent-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          const runner = new PilotCollectorRunner({
            sessionId: "session-concurrent-01",
            generationId: "gen1-pilot",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: testDir,
            targetCandidates: 10,
          });
          await runner.initialize();

          const candidateE1: D23ScreenedCandidate = {
            ...mockCandidate,
            compositeId: {
              ...mockCandidate.compositeId,
              sessionId: "session-concurrent-01",
              generationId: "gen1-pilot",
              decisionEventId: "evt-concurrent-duplicate-e1",
            },
          };

          // Concurrent execution of identical candidate event ID
          const results = await Promise.allSettled([
            runner.recordScreenedCandidate(candidateE1),
            runner.recordScreenedCandidate(candidateE1),
          ]);

          const fulfilled = results.filter((r) => r.status === "fulfilled");
          const rejected = results.filter((r) => r.status === "rejected");

          expect(fulfilled.length).toBe(1);
          expect(rejected.length).toBe(1);

          const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
          expect(String(rejectionReason)).toContain("DUPLICATE_DECISION_ID");

          // Verify exactly 1 line written to candidate-decisions.jsonl
          const decisionsPath = path.join(
            runner.getSessionDirectory(),
            "candidate-decisions.jsonl",
          );
          const content = await fs.readFile(decisionsPath, "utf8");
          const lines = content.split("\n").filter((l) => l.trim().length > 0);
          expect(lines.length).toBe(1);

          // Verify finalization succeeds cleanly without duplicate mismatch
          await runner.finalize("FINALIZED");
          expect(runner.getStatus()).toBe("FINALIZED");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });
    });

    describe("Symlink & Path Confinement Protection (D23R-04)", () => {
      it("rejects outputRootDir symlink redirecting into protected telemetry directory (D23R-04)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-symlink-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          // Create simulated protected repository structure in disposable test directory
          const fakeProtectedDir = path.join(
            testDir,
            "fake-project",
            ".tmp",
            "telemetry",
            "sessions",
          );
          await fs.mkdir(fakeProtectedDir, { recursive: true });

          const redirectedSymlink = path.join(testDir, "redirected");
          await fs.symlink(
            fakeProtectedDir,
            redirectedSymlink,
            process.platform === "win32" ? "junction" : "dir",
          );

          // Attempting to configure redirected output root must be rejected
          expect(() => {
            validatePathConfinement(path.join(redirectedSymlink, "new-session"), redirectedSymlink);
          }).toThrow(/PATH_CONFINEMENT_VIOLATION/);
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });

      it("enforces allowedRootDir when configured (D23R-04)", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-allowed-root-${Date.now()}`);
        await fs.mkdir(testDir, { recursive: true });
        try {
          const allowedRoot = path.join(testDir, "allowed-pilot-root");
          const outsideRoot = path.join(testDir, "outside-pilot-root");
          await fs.mkdir(allowedRoot, { recursive: true });
          await fs.mkdir(outsideRoot, { recursive: true });

          // Inside allowed root -> succeeds
          expect(() => {
            validatePathConfinement(path.join(allowedRoot, "session-01"), allowedRoot, allowedRoot);
          }).not.toThrow();

          // Outside allowed root -> throws
          expect(() => {
            validatePathConfinement(path.join(outsideRoot, "session-01"), outsideRoot, allowedRoot);
          }).toThrow(/PATH_CONFINEMENT_VIOLATION/);
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });
    });

    describe("D.1 Research Readiness Read-Only Interoperability", () => {
      it("successfully reads and verifies an exported pilot session with runReadinessAudit", async () => {
        const testDir = path.join(os.tmpdir(), `nexustrade-test-d1-interop-${Date.now()}`);
        const sessionsParentDir = path.join(testDir, "telemetry-sessions");
        const emptyLegacyDir = path.join(testDir, "empty-legacy-sessions");
        const reportOutputDir = path.join(testDir, "audit-report.md");
        await fs.mkdir(sessionsParentDir, { recursive: true });
        await fs.mkdir(emptyLegacyDir, { recursive: true });

        try {
          const runner = new PilotCollectorRunner({
            sessionId: "session-d1-interop-01",
            generationId: "gen1-pilot",
            strategyRevision: D23_STRATEGY_REVISION,
            outputRootDir: sessionsParentDir,
            targetCandidates: 1,
            targetPools: 1,
          });
          await runner.initialize();

          await runner.recordScreenedCandidate(
            {
              ...mockCandidate,
              compositeId: {
                ...mockCandidate.compositeId,
                sessionId: "session-d1-interop-01",
                generationId: "gen1-pilot",
                decisionEventId: "evt-d1-interop-01",
              },
            },
            {
              ...mockObservation,
              compositeId: {
                ...mockObservation.compositeId,
                sessionId: "session-d1-interop-01",
                generationId: "gen1-pilot",
                decisionEventId: "evt-d1-interop-01",
              },
            },
          );

          await runner.finalize("FINALIZED");
          expect(runner.getStatus()).toBe("FINALIZED");

          // Execute D.1 runReadinessAudit pointing to isolated test directories
          const auditResult = runReadinessAudit({
            rootDir: testDir,
            telemetrySessionsDir: sessionsParentDir,
            legacySessionsDir: emptyLegacyDir,
            reportOutputPath: reportOutputDir,
          });

          expect(auditResult.totalSessionsFound).toBe(1);
          expect(auditResult.finalizedSessionsCount).toBe(1);
          expect(auditResult.interruptedSessionsCount).toBe(0);
          expect(auditResult.unfinalizedSessionsCount).toBe(0);
          expect(auditResult.totalDecisions).toBe(1);
          expect(auditResult.totalObservations).toBe(1);
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      });
    });
  });
});
