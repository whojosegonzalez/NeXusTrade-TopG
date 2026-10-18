/**
 * Phase 12.94-D Milestone D.2.4: Live Read-Only Collector Offline Integration Tests
 *
 * Comprehensive offline verification of D24F-01 through D24F-05:
 * 1. D24F-01: Compiled CLI executable execution, network enablement gate, strict argument parsing.
 * 2. D24F-02: Forward outcomes lifecycle coordination (targetCandidates=1, terminal drain/censor, manifest sealing).
 * 3. D24F-03: Pool outcome classifications (429/timeout -> RPC_UNAVAILABLE, null -> POOL_CLOSED_CONFIRMED, vault-only -> OBSERVED_ACTIVE with isPoolActive=true).
 * 4. D24F-04: Non-destructive archive import (collision rejection, source-first verification, atomic staging, protection of historical paths).
 * 5. D24F-05: Transport-boundary request budgeting (2 RPC calls per observation counted, DexScreener pair bounds, transient 429 retry).
 *
 * ALL tests execute 100% offline with zero outbound network requests and zero Fedora laptop interaction.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
  DexScreenerLiveDiscoveryClient,
  isAllowlistedDexScreenerUrl,
  type ILiveHttpTransport,
} from "./DexScreenerLiveDiscoveryClient.js";
import {
  SolanaRpcLiveObservationClient,
  type ISolanaRpcTransport,
} from "./SolanaRpcLiveObservationClient.js";
import { ForwardOutcomeObservationTracker } from "./ForwardOutcomeObservationTracker.js";
import {
  LiveCollectorRunner,
  parseCliArgs,
  runPilotCollectorCli,
} from "./PilotLiveCollectorCli.js";
import { importAndVerifyPilotSession } from "./PilotArchiveImporter.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "./RaydiumAmmParser.js";
import {
  createAuthoritativeRaydiumAmmV4Buffer,
  createAuthoritativeSplVaultBuffer,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";
import { verifySessionExportManifest } from "./PilotExportManifest.js";
import { toCanonicalCandidateDecision } from "./PilotSchemaBridge.js";
import { isValidCandidateDecisionRecord } from "../shadow/ShadowCollectorEngine.js";
import type { D23ObservationRecord, D23ScreenedCandidate } from "./PilotTypes.js";

describe("Milestone D.2.4: Pilot Live Collector Offline Integration Tests", () => {
  async function makeTestDir(prefix: string): Promise<string> {
    const tmpBase = path.join(os.tmpdir(), "nexustrade-d24-tests");
    await fs.mkdir(tmpBase, { recursive: true });
    return await fs.mkdtemp(path.join(tmpBase, `${prefix}-`));
  }

  // --------------------------------------------------------------------------
  // 1. D24F-01: Compiled CLI Entrypoint & Argument Validation
  // --------------------------------------------------------------------------
  describe("D24F-01: Compiled CLI Entrypoint & Argument Validation", () => {
    const compiledCliPath = path.resolve("backend/dist/research/pilot/PilotLiveCollectorCli.js");

    it("spawns the actual compiled .js binary and exits nonzero without network flag", () => {
      // Ensure compiled dist exists
      expect(fsSync.existsSync(compiledCliPath)).toBe(true);

      const res = spawnSync(process.execPath, [compiledCliPath], {
        encoding: "utf8",
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain("[NETWORK_DISABLED]");
    });

    it("spawns compiled binary with --network=disabled and exits nonzero", () => {
      const res = spawnSync(process.execPath, [compiledCliPath, "--network=disabled"], {
        encoding: "utf8",
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain("[NETWORK_DISABLED]");
    });

    it("spawns compiled binary with invalid numeric flag and exits nonzero with error message", () => {
      const res = spawnSync(
        process.execPath,
        [compiledCliPath, "--network=enabled", "--duration-sec=oops"],
        {
          encoding: "utf8",
        },
      );

      expect(res.status).toBe(1);
      expect(res.stderr).toContain("[INVALID_ARGUMENT]");
      expect(res.stderr).toContain("Option '--duration-sec' must be a positive integer");
    });

    it("spawns compiled binary with unknown CLI flag and fails closed", () => {
      const res = spawnSync(
        process.execPath,
        [compiledCliPath, "--network=enabled", "--unknown-option=foo"],
        {
          encoding: "utf8",
        },
      );

      expect(res.status).toBe(1);
      expect(res.stderr).toContain("[INVALID_ARGUMENT] Unknown CLI option: '--unknown-option=foo'");
    });

    it("parseCliArgs parses all runbook flags correctly", () => {
      const parsed = parseCliArgs([
        "node",
        "cli.js",
        "--network=enabled",
        "--duration-sec=7200",
        "--poll-interval-sec=30",
        "--target-candidates=100",
        "--target-yield=15",
        "--max-mb=256",
        "--max-rss-mb=256",
        "--forward-observations=true",
        "--output-dir=/tmp/test-sessions",
      ]);

      expect(parsed.network).toBe("enabled");
      expect(parsed.durationSec).toBe(7200);
      expect(parsed.pollIntervalSec).toBe(30);
      expect(parsed.targetCandidates).toBe(100);
      expect(parsed.targetDiagnosticYield).toBe(15);
      expect(parsed.maxMb).toBe(256);
      expect(parsed.maxRssMb).toBe(256);
      expect(parsed.enableForwardObservations).toBe(true);
      expect(parsed.outputDir).toBe(path.resolve("/tmp/test-sessions"));
    });

    it("parseCliArgs accepts --target-diagnostic-yield as alias and supports disabling forward observations", () => {
      const parsed = parseCliArgs([
        "node",
        "cli.js",
        "--network=enabled",
        "--target-diagnostic-yield=20",
        "--disable-forward-observations",
      ]);

      expect(parsed.targetDiagnosticYield).toBe(20);
      expect(parsed.enableForwardObservations).toBe(false);
    });

    it("parseCliArgs rejects negative or non-integer values", () => {
      expect(() => parseCliArgs(["node", "cli.js", "--duration-sec=-10"])).toThrow(
        "[INVALID_ARGUMENT]",
      );
      expect(() => parseCliArgs(["node", "cli.js", "--target-candidates=0"])).toThrow(
        "[INVALID_ARGUMENT]",
      );
      expect(() => parseCliArgs(["node", "cli.js", "--max-mb=abc"])).toThrow("[INVALID_ARGUMENT]");
    });

    it("runPilotCollectorCli function returns exit code 1 when network is not enabled", async () => {
      const code = await runPilotCollectorCli(["node", "cli.js"]);
      expect(code).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 2. D24F-02: Forward Outcomes Terminal Lifecycle Coordination
  // --------------------------------------------------------------------------
  describe("D24F-02: Forward Outcomes Terminal Lifecycle Coordination", () => {
    it("synthetic 1-candidate session records forward observations and summary before sealing manifest", async () => {
      const testDir = await makeTestDir("fwd-1cand");

      const mockHttp: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            return new Response(
              JSON.stringify([
                {
                  tokenAddress: FIXTURE_MEME_MINT,
                  chainId: "solana",
                  header: "Bonk",
                  description: "Bonk token",
                },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/latest/dex/tokens/")) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "raydium",
                    pairAddress: FIXTURE_POOL_ADDRESS,
                    baseToken: { address: FIXTURE_MEME_MINT, symbol: "BONK" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                    priceUsd: "0.00001",
                    volume: { m5: 1200 },
                    txns: { m5: { buys: 12, sells: 4 } },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        },
      };

      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      const baseVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 1_000_000_000_000n,
      });
      const quoteVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_WSOL_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 100_000_000_000n,
      });

      const mockRpc: ISolanaRpcTransport = {
        post: async (_url, payload) => {
          const body = payload as { method: string; params: unknown[] };
          if (body.method === "getAccountInfo") {
            return {
              jsonrpc: "2.0",
              id: 1,
              result: {
                context: { slot: 300000001 },
                value: {
                  data: [poolBuffer.toString("base64"), "base64"],
                  executable: false,
                  lamports: 10000000,
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                  rentEpoch: 0,
                },
              },
            };
          }
          if (body.method === "getMultipleAccounts") {
            return {
              jsonrpc: "2.0",
              id: 2,
              result: {
                context: { slot: 300000002 },
                value: [
                  {
                    data: [baseVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 5000000,
                    owner: SPL_TOKEN_PROGRAM_ID,
                    rentEpoch: 0,
                  },
                  {
                    data: [quoteVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 5000000,
                    owner: SPL_TOKEN_PROGRAM_ID,
                    rentEpoch: 0,
                  },
                ],
              },
            };
          }
          return { jsonrpc: "2.0", id: 99, error: { message: "Unknown method" } };
        },
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir: testDir,
        durationSec: 5,
        targetCandidates: 1,
        targetDiagnosticYield: 1,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: true,
        httpTransport: mockHttp,
        rpcTransport: mockRpc,
      });

      const result = await runner.run();
      expect(result.status).toBe("FINALIZED");
      expect(["TARGET_REACHED", "TARGET_YIELD_REACHED"]).toContain(result.stopReason);
      expect(result.totalDecisionsRecorded).toBe(1);
      expect(result.manifestValid).toBe(true);

      // Verify forward-observations.jsonl exists and is accounted for
      const fwdFile = path.join(result.sessionDir, "forward-observations.jsonl");
      expect(fsSync.existsSync(fwdFile)).toBe(true);
      const fwdContent = await fs.readFile(fwdFile, "utf8");
      const fwdLines = fwdContent.split("\n").filter((l) => l.trim().length > 0);
      expect(fwdLines.length).toBe(3); // 3 scheduled targets: +1m, +5m, +15m

      // Each pending target was accounted for before manifest sealing
      for (const line of fwdLines) {
        const parsed = JSON.parse(line);
        expect(parsed.observationStatus).toBe("WINDOW_TRUNCATED");
        expect(parsed.censorReason).toBe("TARGET_REACHED_BEFORE_FORWARD_WINDOW");
        expect(parsed.actualObservationEpochMs).toBeGreaterThan(0);
      }

      // Verify forward-summary.json exists and is sealed in manifest
      const summaryFile = path.join(result.sessionDir, "forward-summary.json");
      expect(fsSync.existsSync(summaryFile)).toBe(true);
      const summaryJson = JSON.parse(await fs.readFile(summaryFile, "utf8"));
      expect(summaryJson.totalScheduled).toBe(3);
      expect(summaryJson.totalRecorded).toBe(3);
      expect(summaryJson.totalTruncated).toBe(3);

      // Verify manifest integrity independently
      const manifestVerification = await verifySessionExportManifest(result.sessionDir);
      expect(manifestVerification.valid).toBe(true);
      expect(manifestVerification.missingFiles).toHaveLength(0);
      expect(manifestVerification.mismatchedFiles).toHaveLength(0);

      // Verify manifest includes forward-observations.jsonl and forward-summary.json
      const manifestPath = path.join(result.sessionDir, "manifest.json");
      const manifestData = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const filenames = manifestData.files.map((f: { filename: string }) => f.filename);
      expect(filenames).toContain("forward-observations.jsonl");
      expect(filenames).toContain("forward-summary.json");
    });

    it("attests actualObservationEpochMs after RPC completion", async () => {
      const testDir = await makeTestDir("fwd-timestamp");
      const tracker = new ForwardOutcomeObservationTracker({ sessionDir: testDir });

      const mockCandidate: D23ScreenedCandidate = {
        compositeId: {
          sessionId: "sess-ts",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-ts-1",
        },
        symbol: "BONK",
        decisionType: "CANDIDATE_DISCOVERY_PROFILE",
        decisionCohort: "WATCHLIST_RADAR",
        selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
        decisionEpochMs: 1000,
        requestEpochMs: 980,
        receiptEpochMs: 990,
        sourceTimestampMs: null,
        passedEligibility: true,
        filterEvaluations: [],
        rejectionReasons: [],
        missingFields: [],
        providerIdentity: "dexscreener_mock",
      };

      const mockObs: D23ObservationRecord = {
        observationId: "obs-ts-1",
        compositeId: mockCandidate.compositeId,
        requestEpochMs: 985,
        receiptEpochMs: 995,
        sourceReportedTimeMs: null,
        hostMonotonicElapsedMs: 10,
        onChainSlot: 1000,
        slotDiscrepancy: false,
        provenance: "D23_OBSERVATIONAL_SCREENING",
        providerIdentity: "solana_rpc_mock",
        actualResponsePoolId: FIXTURE_POOL_ADDRESS,
        isMatchingPool: true,
        reserveAccounting: null,
        flowMetrics: { volume5mUsd: 100, buys5m: 1, sells5m: 0, netBuyerVolumeUsd: null },
        missingFields: [],
      };

      tracker.registerCandidateForForwardObservation(mockCandidate, mockObs);

      let rpcAwaited = false;
      const delayedRpc = {
        observeRaydiumPool: async () => {
          await new Promise((r) => setTimeout(r, 50));
          rpcAwaited = true;
          return {
            ok: true,
            observation: mockObs,
            reserveAccounting: {
              mode: "VAULT_ONLY_PROXY",
              tokenMint: FIXTURE_MEME_MINT,
              solMint: FIXTURE_WSOL_MINT,
              tokenReserveRaw: 1000n,
              solReserveRaw: 100n,
              tokenDecimals: 6,
              solDecimals: 9,
              tokenReserveDecimal: 1000,
              solReserveDecimal: 100,
              spotPriceSol: 0.1,
              orientation: "TOKEN_BASE_SOL_QUOTE",
              effectiveReservesAvailable: false,
              executionFeasible: false,
            },
          };
        },
      } as unknown as SolanaRpcLiveObservationClient;

      const beforeCall = Date.now();
      await tracker.pollDueObservations(delayedRpc, 1000 + 70_000);
      expect(rpcAwaited).toBe(true);

      const fwdFile = path.join(testDir, "forward-observations.jsonl");
      const record = JSON.parse(await fs.readFile(fwdFile, "utf8"));
      expect(record.actualObservationEpochMs).toBeGreaterThanOrEqual(beforeCall + 40);
    });

    it("handles 60-candidate burst with 180 scheduled targets under default capacity without outcome loss (D24R2-01)", async () => {
      const testDir = await makeTestDir("burst-60-default");
      const tracker = new ForwardOutcomeObservationTracker({
        sessionDir: testDir,
      });

      for (let i = 0; i < 60; i++) {
        const mint = `Mint${String(i).padStart(40, "0")}`;
        const pool = `Pool${String(i).padStart(40, "0")}`;
        const candidate: D23ScreenedCandidate = {
          compositeId: {
            sessionId: "sess-burst-60",
            generationId: "gen1",
            poolId: pool,
            mintAddress: mint,
            decisionEventId: `dec-burst-${i}`,
          },
          symbol: `TKN${i}`,
          decisionType: "CANDIDATE_DISCOVERY_PROFILE",
          decisionCohort: "WATCHLIST_RADAR",
          selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
          decisionEpochMs: 1_000_000 + i * 1000,
          requestEpochMs: 1_000_000 + i * 1000 - 10,
          receiptEpochMs: 1_000_000 + i * 1000 - 5,
          sourceTimestampMs: null,
          passedEligibility: true,
          filterEvaluations: [],
          rejectionReasons: [],
          missingFields: [],
          providerIdentity: "dexscreener_mock",
        };
        const obs: D23ObservationRecord = {
          observationId: `obs-burst-${i}`,
          compositeId: candidate.compositeId,
          requestEpochMs: candidate.requestEpochMs,
          receiptEpochMs: candidate.receiptEpochMs,
          sourceReportedTimeMs: null,
          hostMonotonicElapsedMs: 5,
          onChainSlot: 1000 + i,
          slotDiscrepancy: false,
          provenance: "D23_OBSERVATIONAL_SCREENING",
          providerIdentity: "solana_rpc_mock",
          actualResponsePoolId: pool,
          isMatchingPool: true,
          reserveAccounting: null,
          flowMetrics: { volume5mUsd: 100, buys5m: 1, sells5m: 0, netBuyerVolumeUsd: null },
          missingFields: [],
        };
        tracker.registerCandidateForForwardObservation(candidate, obs);
      }

      // Expected: 60 candidates * 3 intervals = 180 targets
      expect(tracker.getTotalScheduledCount()).toBe(180);
      expect(tracker.getPendingTargetsCount()).toBe(180);
      expect(tracker.getTotalRecordedCount()).toBe(0);

      // Censor remaining pending targets upon session stop
      const censored = tracker.censorRemainingPendingTargets(
        "WINDOW_TRUNCATED",
        "session duration elapsed",
      );
      expect(censored).toBe(180);

      const summary = tracker.writeForwardSummary();
      expect(summary.totalScheduled).toBe(180);
      expect(summary.totalRecorded).toBe(180);
      expect(summary.totalTruncated).toBe(180);
      expect(summary.totalCensoredCapacity).toBe(0);
      expect(summary.remainingPending).toBe(0);

      // Verify each interval has exactly 60
      expect(summary.byInterval["60"]?.scheduled).toBe(60);
      expect(summary.byInterval["300"]?.scheduled).toBe(60);
      expect(summary.byInterval["900"]?.scheduled).toBe(60);
    });

    it("handles 60-candidate burst under constrained capacity (150) by explicitly censoring overflowing intervals without silent drops (D24R2-01)", async () => {
      const testDir = await makeTestDir("burst-60-overflow");
      const tracker = new ForwardOutcomeObservationTracker({
        sessionDir: testDir,
        maxPendingTargets: 150, // Constrained capacity
      });

      for (let i = 0; i < 60; i++) {
        const mint = `Mint${String(i).padStart(40, "0")}`;
        const pool = `Pool${String(i).padStart(40, "0")}`;
        const candidate: D23ScreenedCandidate = {
          compositeId: {
            sessionId: "sess-overflow-60",
            generationId: "gen1",
            poolId: pool,
            mintAddress: mint,
            decisionEventId: `dec-overflow-${i}`,
          },
          symbol: `TKN${i}`,
          decisionType: "CANDIDATE_DISCOVERY_PROFILE",
          decisionCohort: "WATCHLIST_RADAR",
          selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
          decisionEpochMs: 1_000_000 + i * 1000,
          requestEpochMs: 1_000_000 + i * 1000 - 10,
          receiptEpochMs: 1_000_000 + i * 1000 - 5,
          sourceTimestampMs: null,
          passedEligibility: true,
          filterEvaluations: [],
          rejectionReasons: [],
          missingFields: [],
          providerIdentity: "dexscreener_mock",
        };
        const obs: D23ObservationRecord = {
          observationId: `obs-overflow-${i}`,
          compositeId: candidate.compositeId,
          requestEpochMs: candidate.requestEpochMs,
          receiptEpochMs: candidate.receiptEpochMs,
          sourceReportedTimeMs: null,
          hostMonotonicElapsedMs: 5,
          onChainSlot: 1000 + i,
          slotDiscrepancy: false,
          provenance: "D23_OBSERVATIONAL_SCREENING",
          providerIdentity: "solana_rpc_mock",
          actualResponsePoolId: pool,
          isMatchingPool: true,
          reserveAccounting: null,
          flowMetrics: { volume5mUsd: 100, buys5m: 1, sells5m: 0, netBuyerVolumeUsd: null },
          missingFields: [],
        };
        tracker.registerCandidateForForwardObservation(candidate, obs);
      }

      // 180 total expected intervals: 150 pending in queue + 30 overflowed and recorded immediately
      expect(tracker.getTotalScheduledCount()).toBe(180);
      expect(tracker.getPendingTargetsCount()).toBe(150);
      expect(tracker.getTotalRecordedCount()).toBe(30);

      // Censor remaining pending targets upon session stop
      const censored = tracker.censorRemainingPendingTargets(
        "WINDOW_TRUNCATED",
        "session duration elapsed",
      );
      expect(censored).toBe(150);

      const summary = tracker.writeForwardSummary();
      expect(summary.totalScheduled).toBe(180);
      expect(summary.totalRecorded).toBe(180);
      expect(summary.totalTruncated).toBe(150);
      expect(summary.totalCensoredCapacity).toBe(30);
      expect(summary.remainingPending).toBe(0);

      // The invariant holds: totalScheduled = totalRecorded = totalTruncated + totalCensoredCapacity
      expect(summary.totalRecorded).toBe(summary.totalTruncated + summary.totalCensoredCapacity);
    });
  });

  // --------------------------------------------------------------------------
  // 3. D24F-03: Pool-Outcome Classifications & Activity Derivation
  // --------------------------------------------------------------------------
  describe("D24F-03: Pool-Outcome Classifications & Activity Derivation", () => {
    it("classifies 429 rate limit or throttling as RPC_UNAVAILABLE, not POOL_DRAINED_OR_CLOSED", async () => {
      const testDir = await makeTestDir("fwd-429");
      const tracker = new ForwardOutcomeObservationTracker({ sessionDir: testDir });

      const mockCandidate: D23ScreenedCandidate = {
        compositeId: {
          sessionId: "sess-429",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-429-1",
        },
        symbol: "BONK",
        decisionType: "CANDIDATE_DISCOVERY_PROFILE",
        decisionCohort: "WATCHLIST_RADAR",
        selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
        decisionEpochMs: 1000,
        requestEpochMs: 980,
        receiptEpochMs: 990,
        sourceTimestampMs: null,
        passedEligibility: true,
        filterEvaluations: [],
        rejectionReasons: [],
        missingFields: [],
        providerIdentity: "dexscreener_mock",
      };

      const mockObs: D23ObservationRecord = {
        observationId: "obs-429-1",
        compositeId: mockCandidate.compositeId,
        requestEpochMs: 985,
        receiptEpochMs: 995,
        sourceReportedTimeMs: null,
        hostMonotonicElapsedMs: 10,
        onChainSlot: 1000,
        slotDiscrepancy: false,
        provenance: "D23_OBSERVATIONAL_SCREENING",
        providerIdentity: "solana_rpc_mock",
        actualResponsePoolId: FIXTURE_POOL_ADDRESS,
        isMatchingPool: true,
        reserveAccounting: null,
        flowMetrics: { volume5mUsd: 100, buys5m: 1, sells5m: 0, netBuyerVolumeUsd: null },
        missingFields: [],
      };

      tracker.registerCandidateForForwardObservation(mockCandidate, mockObs);

      const throttledRpc = {
        observeRaydiumPool: async () => ({
          ok: false,
          observation: null,
          error: "[RPC_THROTTLED] Solana RPC rate-limited until future",
        }),
      } as unknown as SolanaRpcLiveObservationClient;

      await tracker.pollDueObservations(throttledRpc, 1000 + 65_000);

      const fwdFile = path.join(testDir, "forward-observations.jsonl");
      const record = JSON.parse(await fs.readFile(fwdFile, "utf8"));
      expect(record.observationStatus).toBe("RPC_UNAVAILABLE");
      expect(record.isPoolActive).toBe(false);
      expect(record.observationStatus).not.toBe("POOL_DRAINED_OR_CLOSED");
    });

    it("classifies null account response as POOL_CLOSED_CONFIRMED", async () => {
      const testDir = await makeTestDir("fwd-null");
      const tracker = new ForwardOutcomeObservationTracker({ sessionDir: testDir });

      const mockCandidate: D23ScreenedCandidate = {
        compositeId: {
          sessionId: "sess-null",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-null-1",
        },
        symbol: "BONK",
        decisionType: "CANDIDATE_DISCOVERY_PROFILE",
        decisionCohort: "WATCHLIST_RADAR",
        selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
        decisionEpochMs: 1000,
        requestEpochMs: 980,
        receiptEpochMs: 990,
        sourceTimestampMs: null,
        passedEligibility: true,
        filterEvaluations: [],
        rejectionReasons: [],
        missingFields: [],
        providerIdentity: "dexscreener_mock",
      };

      const mockObs: D23ObservationRecord = {
        observationId: "obs-null-1",
        compositeId: mockCandidate.compositeId,
        requestEpochMs: 985,
        receiptEpochMs: 995,
        sourceReportedTimeMs: null,
        hostMonotonicElapsedMs: 10,
        onChainSlot: 1000,
        slotDiscrepancy: false,
        provenance: "D23_OBSERVATIONAL_SCREENING",
        providerIdentity: "solana_rpc_mock",
        actualResponsePoolId: FIXTURE_POOL_ADDRESS,
        isMatchingPool: true,
        reserveAccounting: null,
        flowMetrics: { volume5mUsd: 100, buys5m: 1, sells5m: 0, netBuyerVolumeUsd: null },
        missingFields: [],
      };

      tracker.registerCandidateForForwardObservation(mockCandidate, mockObs);

      const closedRpc = {
        observeRaydiumPool: async () => ({
          ok: false,
          observation: null,
          error: "Pool account not found on-chain (null value)",
        }),
      } as unknown as SolanaRpcLiveObservationClient;

      await tracker.pollDueObservations(closedRpc, 1000 + 65_000);

      const fwdFile = path.join(testDir, "forward-observations.jsonl");
      const record = JSON.parse(await fs.readFile(fwdFile, "utf8"));
      expect(record.observationStatus).toBe("POOL_CLOSED_CONFIRMED");
      expect(record.isPoolActive).toBe(false);
    });

    it("sets isPoolActive=true for OBSERVED_ACTIVE even in VAULT_ONLY_PROXY mode", async () => {
      const testDir = await makeTestDir("fwd-vault-proxy");
      const tracker = new ForwardOutcomeObservationTracker({ sessionDir: testDir });

      const mockCandidate: D23ScreenedCandidate = {
        compositeId: {
          sessionId: "sess-vproxy",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-vproxy-1",
        },
        symbol: "BONK",
        decisionType: "CANDIDATE_DISCOVERY_PROFILE",
        decisionCohort: "WATCHLIST_RADAR",
        selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
        decisionEpochMs: 1000,
        requestEpochMs: 980,
        receiptEpochMs: 990,
        sourceTimestampMs: null,
        passedEligibility: true,
        filterEvaluations: [],
        rejectionReasons: [],
        missingFields: [],
        providerIdentity: "dexscreener_mock",
      };

      const mockObs: D23ObservationRecord = {
        observationId: "obs-vproxy-1",
        compositeId: mockCandidate.compositeId,
        requestEpochMs: 985,
        receiptEpochMs: 995,
        sourceReportedTimeMs: null,
        hostMonotonicElapsedMs: 10,
        onChainSlot: 1000,
        slotDiscrepancy: false,
        provenance: "D23_OBSERVATIONAL_SCREENING",
        providerIdentity: "solana_rpc_mock",
        actualResponsePoolId: FIXTURE_POOL_ADDRESS,
        isMatchingPool: true,
        reserveAccounting: null,
        flowMetrics: { volume5mUsd: 100, buys5m: 1, sells5m: 0, netBuyerVolumeUsd: null },
        missingFields: [],
      };

      tracker.registerCandidateForForwardObservation(mockCandidate, mockObs);

      // VAULT_ONLY_PROXY where effectiveReservesAvailable is false
      const proxyRpc = {
        observeRaydiumPool: async () => ({
          ok: true,
          observation: mockObs,
          reserveAccounting: {
            mode: "VAULT_ONLY_PROXY",
            tokenMint: FIXTURE_MEME_MINT,
            solMint: FIXTURE_WSOL_MINT,
            tokenReserveRaw: 5_000_000_000n,
            solReserveRaw: 50_000_000_000n,
            tokenDecimals: 6,
            solDecimals: 9,
            tokenReserveDecimal: 5000,
            solReserveDecimal: 50,
            spotPriceSol: 0.01,
            orientation: "TOKEN_BASE_SOL_QUOTE",
            effectiveReservesAvailable: false, // Feasibility false in proxy mode
            executionFeasible: false,
          },
        }),
      } as unknown as SolanaRpcLiveObservationClient;

      await tracker.pollDueObservations(proxyRpc, 1000 + 65_000);

      const fwdFile = path.join(testDir, "forward-observations.jsonl");
      const record = JSON.parse(await fs.readFile(fwdFile, "utf8"));
      expect(record.observationStatus).toBe("OBSERVED_ACTIVE");
      expect(record.isPoolActive).toBe(true); // Must be TRUE for active pool
    });
  });

  // --------------------------------------------------------------------------
  // 4. D24F-04: Non-Destructive Archive Import & Safe Staging
  // --------------------------------------------------------------------------
  describe("D24F-04: Non-Destructive Archive Import & Safe Staging", () => {
    it("does not delete existing target files when import fails or source is corrupted", async () => {
      const sourceBase = await makeTestDir("corrupt-source");
      const importBase = await makeTestDir("existing-target");

      // 1. Create a simulated valid source session
      const mockHttp: ILiveHttpTransport = {
        fetch: async () => new Response(JSON.stringify([]), { status: 200 }),
      };
      const mockRpc: ISolanaRpcTransport = {
        post: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir: sourceBase,
        durationSec: 1,
        targetCandidates: 1,
        targetDiagnosticYield: 15,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: false,
        httpTransport: mockHttp,
        rpcTransport: mockRpc,
      });

      const sessionResult = await runner.run();
      const sessionFolderName = path.basename(sessionResult.sessionDir);

      // 2. Pre-create an existing target directory with historical evidence
      const existingTargetDir = path.join(importBase, sessionFolderName);
      await fs.mkdir(existingTargetDir, { recursive: true });
      const evidencePath = path.join(existingTargetDir, "historical-evidence.txt");
      await fs.writeFile(evidencePath, "CRITICAL_HISTORICAL_DATA", "utf8");

      // 3. Corrupt source manifest
      const sourceManifest = path.join(sessionResult.sessionDir, "manifest.json");
      await fs.writeFile(sourceManifest, "{ corrupted: true }", "utf8");

      // 4. Attempt import
      const importResult = await importAndVerifyPilotSession(sessionResult.sessionDir, {
        importRootDir: importBase,
        allowOverwrite: false,
      });

      expect(importResult.ok).toBe(false);

      // 5. Verify the historical file was NOT deleted
      expect(fsSync.existsSync(evidencePath)).toBe(true);
      const remainingContent = await fs.readFile(evidencePath, "utf8");
      expect(remainingContent).toBe("CRITICAL_HISTORICAL_DATA");
    });

    async function createValidFinalizedSession(outputDir: string): Promise<string> {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      const baseVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 1_000_000_000_000n,
      });
      const quoteVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_WSOL_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 100_000_000_000n,
      });

      const mockHttp: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            return new Response(
              JSON.stringify([
                {
                  tokenAddress: FIXTURE_MEME_MINT,
                  chainId: "solana",
                  header: "Bonk",
                  description: "Bonk",
                },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/latest/dex/tokens/")) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "raydium",
                    pairAddress: FIXTURE_POOL_ADDRESS,
                    baseToken: { address: FIXTURE_MEME_MINT, symbol: "BONK" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                    priceUsd: "0.00001",
                    volume: { m5: 100 },
                    txns: { m5: { buys: 1, sells: 0 } },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        },
      };

      const mockRpc: ISolanaRpcTransport = {
        post: async (_url, payload) => {
          const body = payload as { method: string; params: unknown[] };
          if (body.method === "getAccountInfo") {
            return {
              jsonrpc: "2.0",
              id: 1,
              result: {
                context: { slot: 100 },
                value: {
                  data: [poolBuffer.toString("base64"), "base64"],
                  executable: false,
                  lamports: 1000,
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                  rentEpoch: 0,
                },
              },
            };
          }
          if (body.method === "getMultipleAccounts") {
            return {
              jsonrpc: "2.0",
              id: 2,
              result: {
                context: { slot: 101 },
                value: [
                  {
                    data: [baseVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 1000,
                    owner: SPL_TOKEN_PROGRAM_ID,
                    rentEpoch: 0,
                  },
                  {
                    data: [quoteVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 1000,
                    owner: SPL_TOKEN_PROGRAM_ID,
                    rentEpoch: 0,
                  },
                ],
              },
            };
          }
          return { jsonrpc: "2.0", id: 99, error: { message: "Unknown" } };
        },
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir,
        durationSec: 1,
        targetCandidates: 1,
        targetDiagnosticYield: 15,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: false,
        httpTransport: mockHttp,
        rpcTransport: mockRpc,
      });

      const sessionResult = await runner.run();
      return sessionResult.sessionDir;
    }

    it("rejects import when destination directory already exists unless allowOverwrite=true", async () => {
      const sourceBase = await makeTestDir("valid-source");
      const importBase = await makeTestDir("dup-target");

      const sessionDir = await createValidFinalizedSession(sourceBase);
      const sessionFolderName = path.basename(sessionDir);

      // Pre-create target dir
      const existingTargetDir = path.join(importBase, sessionFolderName);
      await fs.mkdir(existingTargetDir, { recursive: true });

      // Attempt import without allowOverwrite
      const importResult1 = await importAndVerifyPilotSession(sessionDir, {
        importRootDir: importBase,
        allowOverwrite: false,
      });
      expect(importResult1.ok).toBe(false);
      expect(importResult1.error).toContain("[IMPORT_DESTINATION_EXISTS]");

      // Attempt import with allowOverwrite=true succeeds
      const importResult2 = await importAndVerifyPilotSession(sessionDir, {
        importRootDir: importBase,
        allowOverwrite: true,
      });
      expect(importResult2.ok).toBe(true);
      expect(importResult2.manifestResult.valid).toBe(true);
    });

    it("prohibits importing into protected historical telemetry paths", async () => {
      const sourceBase = await makeTestDir("prot-source");

      await expect(
        importAndVerifyPilotSession(sourceBase, {
          importRootDir: path.resolve(".tmp/telemetry/sessions"),
        }),
      ).rejects.toThrow("[PROTECTED_PATH_VIOLATION]");
    });

    it("rejects import when canonical manifest digest is missing or corrupted (D24R2-02)", async () => {
      const sourceBase = await makeTestDir("src-bad-digest");
      const importBase = await makeTestDir("import-bad-digest");

      const sessionDir = await createValidFinalizedSession(sourceBase);
      const manifestPath = path.join(sessionDir, "manifest.json");
      const manifestObj = JSON.parse(await fs.readFile(manifestPath, "utf8"));

      // Tamper: remove manifestDigestSha256
      delete manifestObj.manifestDigestSha256;
      await fs.writeFile(manifestPath, JSON.stringify(manifestObj, null, 2), "utf8");

      // Verify canonical verifySessionExportManifest fails
      const checkRes = await verifySessionExportManifest(sessionDir);
      expect(checkRes.valid).toBe(false);
      expect(checkRes.mismatchedFiles).toContain("manifest.json");
      expect(checkRes.errorDetails).toContain("Manifest internal digest mismatch");

      // Verify importAndVerifyPilotSession fails
      const importRes = await importAndVerifyPilotSession(sessionDir, {
        importRootDir: importBase,
      });
      expect(importRes.ok).toBe(false);
      expect(importRes.error).toContain("[SOURCE_MANIFEST_INVALID]");

      // Verify scripts/import-pilot-archive.mjs exits nonzero
      const cliRes = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/import-pilot-archive.mjs"),
          `--source=${sessionDir}`,
          `--target-root=${importBase}`,
        ],
        { encoding: "utf8" },
      );
      expect(cliRes.status).toBe(1);
      expect(cliRes.stderr).toContain("Manifest internal digest mismatch");
    });

    it("safely restores existing destination via rollback if staging publish fails during overwrite (D24R2-02)", async () => {
      const sourceBase = await makeTestDir("src-rollback");
      const importBase = await makeTestDir("import-rollback");

      const sessionDir = await createValidFinalizedSession(sourceBase);
      const sessionFolderName = path.basename(sessionDir);
      const existingTargetDir = path.join(importBase, sessionFolderName);

      // Pre-populate existing destination with DO_NOT_DELETE.txt
      await fs.mkdir(existingTargetDir, { recursive: true });
      const sentinelFile = path.join(existingTargetDir, "DO_NOT_DELETE.txt");
      await fs.writeFile(sentinelFile, "PRESERVE_THIS_CRITICAL_CONTENT", "utf8");

      // Inject failure during staging publish by mocking renameSync to throw and copyFileSync to throw
      const origRenameSync = fsSync.renameSync;
      const origCopyFileSync = fsSync.copyFileSync;

      let injectedFailure = false;
      fsSync.renameSync = (oldPath: fsSync.PathLike, newPath: fsSync.PathLike) => {
        // If renaming stagingDir to targetSessionDir, throw to trigger fallback
        if (String(oldPath).includes(".staging-") && String(newPath) === existingTargetDir) {
          throw new Error("INJECTED_RENAME_FAILURE");
        }
        return origRenameSync(oldPath, newPath);
      };

      fsSync.copyFileSync = (src: fsSync.PathLike, dest: fsSync.PathLike, flags?: number) => {
        // If copying from stagingDir to targetSessionDir, throw to simulate complete publish failure
        if (String(src).includes(".staging-") && String(dest).includes(sessionFolderName)) {
          injectedFailure = true;
          throw new Error("INJECTED_COPY_FAILURE");
        }
        return origCopyFileSync(src, dest, flags);
      };

      try {
        const importRes = await importAndVerifyPilotSession(sessionDir, {
          importRootDir: importBase,
          allowOverwrite: true,
        });

        expect(importRes.ok).toBe(false);
        expect(importRes.error).toContain("[PUBLISH_FAILED_ROLLED_BACK]");
        expect(injectedFailure).toBe(true);

        // Verify DO_NOT_DELETE.txt was rolled back and is completely intact!
        expect(fsSync.existsSync(sentinelFile)).toBe(true);
        const restoredContent = await fs.readFile(sentinelFile, "utf8");
        expect(restoredContent).toBe("PRESERVE_THIS_CRITICAL_CONTENT");
      } finally {
        fsSync.renameSync = origRenameSync;
        fsSync.copyFileSync = origCopyFileSync;
      }
    });

    it("scripts/import-pilot-archive.mjs truthfully reports compatibility audit and skips when flag passed (D24R2-02)", async () => {
      const sourceBase = await makeTestDir("src-compat-cli");
      const importBase = await makeTestDir("import-compat-cli");

      const sessionDir = await createValidFinalizedSession(sourceBase);

      // 1. Run import CLI with --no-compatibility
      const cliResNoCompat = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/import-pilot-archive.mjs"),
          `--source=${sessionDir}`,
          `--target-root=${importBase}`,
          "--no-compatibility",
        ],
        { encoding: "utf8" },
      );
      expect(cliResNoCompat.status).toBe(0);
      expect(cliResNoCompat.stdout).toContain("Compatibility Audit: SKIPPED (--no-compatibility)");
      expect(cliResNoCompat.stdout).toContain("VALID (Canonical SHA-256 Digest Verified)");

      // 2. Run import CLI without --overwrite on existing target -> exits 1
      const cliResDup = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/import-pilot-archive.mjs"),
          `--source=${sessionDir}`,
          `--target-root=${importBase}`,
        ],
        { encoding: "utf8" },
      );
      expect(cliResDup.status).toBe(1);
      expect(cliResDup.stderr).toContain("[IMPORT_DESTINATION_EXISTS]");
      expect(cliResDup.stderr).toContain("already exists");

      // 3. Run import CLI with unknown argument -> exits 1
      const cliResUnknown = spawnSync(
        process.execPath,
        [
          path.resolve("scripts/import-pilot-archive.mjs"),
          `--source=${sessionDir}`,
          "--bogus-argument",
        ],
        { encoding: "utf8" },
      );
      expect(cliResUnknown.status).toBe(1);
      expect(cliResUnknown.stderr).toContain("Unrecognized CLI argument: '--bogus-argument'");
    });
  });

  // --------------------------------------------------------------------------
  // 5. D24F-05: Real Outbound Request Budgeting & Discovery Retry
  // --------------------------------------------------------------------------
  describe("D24F-05: Real Outbound Request Budgeting & Discovery Retry", () => {
    it("enforces rate budget on every RPC call (2 requests per observation counted)", async () => {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      let transportCallCount = 0;

      const mockRpcTransport: ISolanaRpcTransport = {
        post: async () => {
          transportCallCount++;
          return {
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 100 },
              value: {
                data: [poolBuffer.toString("base64"), "base64"],
                executable: false,
                lamports: 1000,
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                rentEpoch: 0,
              },
            },
          };
        },
      };

      // Set budget of exactly 1 request per minute
      const client = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        maxRequestsPerMinute: 1,
        transport: mockRpcTransport,
      });

      // An observation requires 2 calls (getAccountInfo + getMultipleAccounts)
      const res = await client.observeRaydiumPool({
        poolAddress: FIXTURE_POOL_ADDRESS,
        targetMint: FIXTURE_MEME_MINT,
        compositeId: {
          sessionId: "sess-budget",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-budget-1",
        },
      });

      // 2nd call was rejected by transport boundary rate budget
      expect(res.ok).toBe(false);
      expect(res.error).toContain("[RPC_RATE_BUDGET_EXCEEDED]");
      expect(transportCallCount).toBe(1); // 1st succeeded, 2nd blocked before transport
    });

    it("bounds DexScreener pair lookups per poll cycle", async () => {
      let fetchCalls = 0;
      const mockTransport: ILiveHttpTransport = {
        fetch: async (url: string) => {
          fetchCalls++;
          if (url.includes("/token-profiles/latest/v1")) {
            const basePrefix = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7Ya";
            const profiles = Array.from({ length: 25 }, (_, i) => ({
              tokenAddress: `${basePrefix}${String(i + 10).padStart(8, "A")}`,
              chainId: "solana",
              header: `Token ${i}`,
              description: `Desc ${i}`,
            }));
            return new Response(JSON.stringify(profiles), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/latest/dex/tokens/")) {
            return new Response(JSON.stringify({ pairs: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(null, { status: 404 });
        },
      };

      const client = new DexScreenerLiveDiscoveryClient({
        pollIntervalMs: 1,
        maxPairLookupsPerPoll: 5, // Limit to 5 pair lookups per cycle
        transport: mockTransport,
      });

      await client.pollDiscoveredCandidates({
        sessionId: "sess-burst",
        generationId: "gen1",
      });

      // 1 profile request + exactly 5 pair lookup requests = 6 calls total (NOT 26)
      expect(fetchCalls).toBe(6);
    });

    it("retries transient 429 pair lookup on subsequent poll without dropping mint", async () => {
      let pairLookupAttempts = 0;
      const testMint = FIXTURE_MEME_MINT;

      const mockTransport: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            return new Response(
              JSON.stringify([
                {
                  tokenAddress: testMint,
                  chainId: "solana",
                  header: "Bonk",
                  description: "Bonk",
                },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/latest/dex/tokens/")) {
            pairLookupAttempts++;
            if (pairLookupAttempts === 1) {
              // Transient 429 on first attempt
              return new Response("Rate limited", {
                status: 429,
                headers: { "retry-after": "0" },
              });
            }
            // Success on second attempt
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "raydium",
                    pairAddress: FIXTURE_POOL_ADDRESS,
                    baseToken: { address: testMint, symbol: "BONK" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                    priceUsd: "0.00001",
                    volume: { m5: 100 },
                    txns: { m5: { buys: 1, sells: 0 } },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        },
      };

      const client = new DexScreenerLiveDiscoveryClient({
        pollIntervalMs: 1,
        transport: mockTransport,
      });

      // Poll 1: encounters 429 on pair lookup
      const res1 = await client.pollDiscoveredCandidates({
        sessionId: "sess-retry",
        generationId: "gen1",
      });
      expect(res1.length).toBe(0);
      expect(client.isMintSeen(testMint)).toBe(true);
      expect(client.isMintResolved(testMint)).toBe(false); // NOT resolved
      expect(client.getRetryQueueSize()).toBe(1); // In retry queue

      // Wait 10ms
      await new Promise((r) => setTimeout(r, 10));

      // Poll 2: retries and succeeds!
      const res2 = await client.pollDiscoveredCandidates({
        sessionId: "sess-retry",
        generationId: "gen1",
      });
      expect(res2.length).toBe(1);
      expect(res2[0]?.candidate.compositeId.mintAddress).toBe(testMint);
      expect(client.isMintResolved(testMint)).toBe(true); // Now resolved
      expect(client.getRetryQueueSize()).toBe(0); // Retry queue cleared
      expect(pairLookupAttempts).toBe(2);
    });

    it("strictly verifies allowlisted DexScreener URLs and rejects non-allowlisted ones", () => {
      expect(
        isAllowlistedDexScreenerUrl("https://api.dexscreener.com/token-profiles/latest/v1"),
      ).toBe(true);
      expect(
        isAllowlistedDexScreenerUrl(
          "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
        ),
      ).toBe(true);
      expect(
        isAllowlistedDexScreenerUrl("http://api.dexscreener.com/token-profiles/latest/v1"),
      ).toBe(false);
      expect(isAllowlistedDexScreenerUrl("https://malicious.com/token-profiles/latest/v1")).toBe(
        false,
      );
      expect(
        isAllowlistedDexScreenerUrl("https://api.dexscreener.com/latest/dex/search?q=SOL"),
      ).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Operational Observability & Negative Control Persistence
  // --------------------------------------------------------------------------
  describe("Operational Observability & Negative Control Persistence", () => {
    it("records non-Raydium and ineligible candidates honestly as FILTERED_REJECTED without dropping negative controls", async () => {
      const testDir = await makeTestDir("neg-controls");
      const pumpMint = "PumpM111111111111111111111111111111111111111";

      const mockHttp: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            return new Response(
              JSON.stringify([
                {
                  tokenAddress: pumpMint,
                  chainId: "solana",
                  header: "PumpToken",
                  description: "Pump token on PumpSwap",
                },
                {
                  tokenAddress: FIXTURE_MEME_MINT,
                  chainId: "solana",
                  header: "Bonk",
                  description: "Bonk on Raydium AMM",
                },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes(`/latest/dex/tokens/${pumpMint}`)) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "pump",
                    pairAddress: "PumpPair11111111111111111111111111111111111",
                    baseToken: { address: pumpMint, symbol: "PUMP" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                    priceUsd: "0.0001",
                    volume: { m5: 50 },
                    txns: { m5: { buys: 2, sells: 1 } },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes(`/latest/dex/tokens/${FIXTURE_MEME_MINT}`)) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "raydium",
                    pairAddress: FIXTURE_POOL_ADDRESS,
                    baseToken: { address: FIXTURE_MEME_MINT, symbol: "BONK" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                    priceUsd: "0.00001",
                    volume: { m5: 1200 },
                    txns: { m5: { buys: 12, sells: 4 } },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        },
      };

      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      const baseVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 1_000_000_000_000n,
      });
      const quoteVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_WSOL_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 100_000_000_000n,
      });

      const mockRpc: ISolanaRpcTransport = {
        post: async (_url, payload) => {
          const body = payload as { method: string; params: unknown[] };
          if (body.method === "getAccountInfo") {
            return {
              jsonrpc: "2.0",
              id: 1,
              result: {
                context: { slot: 300000001 },
                value: {
                  data: [poolBuffer.toString("base64"), "base64"],
                  executable: false,
                  lamports: 10000000,
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                  rentEpoch: 0,
                },
              },
            };
          }
          if (body.method === "getMultipleAccounts") {
            return {
              jsonrpc: "2.0",
              id: 2,
              result: {
                context: { slot: 300000002 },
                value: [
                  {
                    data: [baseVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 5000000,
                    owner: SPL_TOKEN_PROGRAM_ID,
                    rentEpoch: 0,
                  },
                  {
                    data: [quoteVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 5000000,
                    owner: SPL_TOKEN_PROGRAM_ID,
                    rentEpoch: 0,
                  },
                ],
              },
            };
          }
          return { jsonrpc: "2.0", id: 99, error: { message: "Unknown" } };
        },
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir: testDir,
        durationSec: 5,
        targetCandidates: 2, // Screen both PumpToken and Bonk
        targetDiagnosticYield: 1,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: true,
        httpTransport: mockHttp,
        rpcTransport: mockRpc,
      });

      const result = await runner.run();
      expect(result.status).toBe("FINALIZED");
      expect(result.totalDecisionsRecorded).toBe(2);
      expect(result.manifestValid).toBe(true);

      // Verify candidate-decisions.jsonl has BOTH records
      const decisionsFile = path.join(result.sessionDir, "candidate-decisions.jsonl");
      expect(fsSync.existsSync(decisionsFile)).toBe(true);
      const decisionLines = (await fs.readFile(decisionsFile, "utf8"))
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      expect(decisionLines).toHaveLength(2);

      // PumpToken must be recorded as FILTERED_REJECTED
      const pumpRecord = decisionLines.find((r) => r.mintAddress === pumpMint);
      expect(pumpRecord).toBeDefined();
      expect(pumpRecord.decisionCohort).toBe("FILTERED_REJECTED");
      expect(pumpRecord.primaryRejectionReason).toBe("NO_RAYDIUM_AMM_PAIR_IDENTIFIED");

      // Bonk must be recorded as WATCHLIST_RADAR
      const bonkRecord = decisionLines.find((r) => r.mintAddress === FIXTURE_MEME_MINT);
      expect(bonkRecord).toBeDefined();
      expect(bonkRecord.decisionCohort).toBe("WATCHLIST_RADAR");

      // Verify session-summary.json counts both cohorts truthfully
      const summaryFile = path.join(result.sessionDir, "session-summary.json");
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8"));
      expect(summary.totalCandidatesScreened).toBe(2);
      expect(summary.cohortBreakdown.watchlistRadar).toBe(1);
      expect(summary.cohortBreakdown.filteredRejected).toBe(1);

      // Market observations only recorded for verified Raydium candidate (Bonk)
      const obsFile = path.join(result.sessionDir, "market-observations.jsonl");
      expect(fsSync.existsSync(obsFile)).toBe(true);
      const obsLines = (await fs.readFile(obsFile, "utf8"))
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(obsLines).toHaveLength(1);

      // Forward observations only scheduled for WATCHLIST_RADAR (3 targets)
      const fwdFile = path.join(result.sessionDir, "forward-observations.jsonl");
      expect(fsSync.existsSync(fwdFile)).toBe(true);
      const fwdLines = (await fs.readFile(fwdFile, "utf8"))
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(fwdLines).toHaveLength(3);
    });

    it("converts candidate to FILTERED_REJECTED when on-chain RPC verification fails", async () => {
      const testDir = await makeTestDir("rpc-fail-record");

      const mockHttp: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            return new Response(
              JSON.stringify([
                {
                  tokenAddress: FIXTURE_MEME_MINT,
                  chainId: "solana",
                  header: "Bonk",
                  description: "Bonk token",
                },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/latest/dex/tokens/")) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "raydium",
                    pairAddress: FIXTURE_POOL_ADDRESS,
                    baseToken: { address: FIXTURE_MEME_MINT, symbol: "BONK" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                    priceUsd: "0.00001",
                    volume: { m5: 1200 },
                    txns: { m5: { buys: 12, sells: 4 } },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        },
      };

      // Mock RPC fails with non-Raydium program owner error
      const mockRpc: ISolanaRpcTransport = {
        post: async () => {
          return {
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 100 },
              value: {
                data: [Buffer.alloc(100).toString("base64"), "base64"],
                executable: false,
                lamports: 1000,
                owner: "11111111111111111111111111111111", // Not Raydium AMM v4
                rentEpoch: 0,
              },
            },
          };
        },
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir: testDir,
        durationSec: 5,
        targetCandidates: 1,
        targetDiagnosticYield: 1,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: true,
        httpTransport: mockHttp,
        rpcTransport: mockRpc,
      });

      const result = await runner.run();
      expect(result.status).toBe("FINALIZED");
      expect(result.totalDecisionsRecorded).toBe(1);

      // Verify recorded as FILTERED_REJECTED due to failed on-chain verification
      const decisionsFile = path.join(result.sessionDir, "candidate-decisions.jsonl");
      const lines = (await fs.readFile(decisionsFile, "utf8"))
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));

      expect(lines).toHaveLength(1);
      expect(lines[0].decisionCohort).toBe("FILTERED_REJECTED");
      expect(lines[0].primaryRejectionReason).toContain("UNAUTHORIZED_POOL_OWNER");

      // Session summary reflects 0 radar, 1 rejected
      const summaryFile = path.join(result.sessionDir, "session-summary.json");
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8"));
      expect(summary.cohortBreakdown.watchlistRadar).toBe(0);
      expect(summary.cohortBreakdown.filteredRejected).toBe(1);
    });

    it("captures comprehensive diagnostics from discovery and RPC clients", async () => {
      const mockHttp: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            return new Response(
              JSON.stringify([
                {
                  tokenAddress: FIXTURE_MEME_MINT,
                  chainId: "solana",
                  header: "Bonk",
                  description: "Bonk",
                },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/latest/dex/tokens/")) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "raydium",
                    pairAddress: FIXTURE_POOL_ADDRESS,
                    baseToken: { address: FIXTURE_MEME_MINT, symbol: "BONK" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                    priceUsd: "0.00001",
                    volume: { m5: 100 },
                    txns: { m5: { buys: 1, sells: 0 } },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        },
      };

      const discoveryClient = new DexScreenerLiveDiscoveryClient({
        pollIntervalMs: 1,
        transport: mockHttp,
      });

      await discoveryClient.pollDiscoveredCandidates({
        sessionId: "sess-diag",
        generationId: "gen1",
      });

      const dsDiag = discoveryClient.getDiagnostics();
      expect(dsDiag.totalPolls).toBe(1);
      expect(dsDiag.totalProfilesFetched).toBe(1);
      expect(dsDiag.totalPairLookups).toBe(1);
      expect(dsDiag.raydiumAmmCandidatesFound).toBe(1);
      expect(dsDiag.seenMintsCount).toBe(1);
      expect(dsDiag.resolvedMintsCount).toBe(1);

      const mockRpc: ISolanaRpcTransport = {
        post: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { context: { slot: 100 }, value: null },
        }),
      };

      const rpcClient = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        transport: mockRpc,
      });

      await rpcClient.executeRpcCall("getAccountInfo", ["addr1"]);
      const rpcDiag = rpcClient.getDiagnostics();
      expect(rpcDiag.totalCalls).toBe(1);
      expect(rpcDiag.successfulCalls).toBe(1);
      expect(rpcDiag.methodsCalled.getAccountInfo).toBe(1);
    });

    it("appends operational logs to direct log file specified by --log-file", async () => {
      const testDir = await makeTestDir("log-file-test");
      const logFilePath = path.join(testDir, "operational.log");

      const mockHttp: ILiveHttpTransport = {
        fetch: async () =>
          new Response(
            JSON.stringify([
              {
                tokenAddress: FIXTURE_MEME_MINT,
                chainId: "solana",
                header: "Bonk",
                description: "Bonk",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir: testDir,
        durationSec: 1,
        targetCandidates: 1,
        targetDiagnosticYield: 15,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: false,
        logFilePath,
        httpTransport: mockHttp,
      });

      await runner.run();

      expect(fsSync.existsSync(logFilePath)).toBe(true);
      const logContent = await fs.readFile(logFilePath, "utf8");
      expect(logContent).toContain("[INFO] [STARTUP]");
      expect(logContent).toContain("[INFO] [CONFIG]");
      expect(logContent).toContain("[INFO] [DISCOVERY_POLL]");
      expect(logContent).toContain("[INFO] [FINALIZING]");
    });

    it("handles interrupted session cleanly: manifest skipped, manifestStatus=NOT_APPLICABLE_INTERRUPTED, exit code 0", async () => {
      const testDir = await makeTestDir("interrupted-test");

      // Mock HTTP returns empty profiles -> 0 candidates -> duration expires
      const mockHttp: ILiveHttpTransport = {
        fetch: async () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir: testDir,
        durationSec: 1, // 1 second duration
        targetCandidates: 10,
        targetDiagnosticYield: 15,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: false,
        httpTransport: mockHttp,
      });

      const result = await runner.run();
      expect(result.status).toBe("INTERRUPTED");
      expect(result.stopReason).toBe("DURATION_EXPIRED");
      expect(result.totalDecisionsRecorded).toBe(0);
      expect(result.manifestValid).toBe(false);
      expect(result.manifestStatus).toBe("NOT_APPLICABLE_INTERRUPTED");

      // Verify manifest.json does NOT exist for interrupted session
      const manifestPath = path.join(result.sessionDir, "manifest.json");
      expect(fsSync.existsSync(manifestPath)).toBe(false);

      // Verify session-meta.json reports INTERRUPTED
      const meta = JSON.parse(
        await fs.readFile(path.join(result.sessionDir, "session-meta.json"), "utf8"),
      );
      expect(meta.sessionStatus).toBe("INTERRUPTED");
      expect(meta.isInterruptedSession).toBe(true);

      // Verify runPilotCollectorCli returns exit code 0 for clean interruption
      const exitCode = await runPilotCollectorCli(
        ["node", "cli.js", "--network=enabled", "--duration-sec=1", "--output-dir=" + testDir],
        { httpTransport: mockHttp },
      );
      // Should exit 0 because it was clean stop
      expect(exitCode).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 7. Tasks 2, 3 & 4: Independent Verification, Negative Control Reconciliation, Timestamp Invariance & Stopping Bounds
  // --------------------------------------------------------------------------
  describe("Task 2, 3 & 4: Independent Verification, Rejection Reconciliation, Timestamps & Stopping Bounds", () => {
    it("verifyPoolAccount verifies canonical Raydium AMM v4 pool on-chain independently", async () => {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      const baseVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 1_000_000_000_000n,
      });
      const quoteVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_WSOL_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 100_000_000_000n,
      });

      const mockRpc: ISolanaRpcTransport = {
        post: async (_url, payload) => {
          const body = payload as { method: string; params: unknown[] };
          if (body.method === "getAccountInfo") {
            return {
              jsonrpc: "2.0",
              id: 1,
              result: {
                context: { slot: 300000001 },
                value: {
                  data: [poolBuffer.toString("base64"), "base64"],
                  executable: false,
                  lamports: 10000000,
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                  rentEpoch: 0,
                },
              },
            };
          }
          if (body.method === "getMultipleAccounts") {
            return {
              jsonrpc: "2.0",
              id: 2,
              result: {
                context: { slot: 300000001 },
                value: [
                  {
                    data: [baseVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 2039280,
                    owner: SPL_TOKEN_PROGRAM_ID,
                    rentEpoch: 0,
                  },
                  {
                    data: [quoteVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 2039280,
                    owner: SPL_TOKEN_PROGRAM_ID,
                    rentEpoch: 0,
                  },
                ],
              },
            };
          }
          return { jsonrpc: "2.0", id: 99, error: { message: "Unknown" } };
        },
      };

      const rpcClient = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        transport: mockRpc,
      });

      const report = await rpcClient.verifyPoolAccount(FIXTURE_POOL_ADDRESS);
      expect(report.verified).toBe(true);
      expect(report.verificationStatus).toBe("VERIFIED_RAYDIUM_AMM_V4");
      expect(report.poolAddress).toBe(FIXTURE_POOL_ADDRESS);
      expect(report.programOwner).toBe(RAYDIUM_AMM_V4_PROGRAM_ID);
      expect(report.baseMint).toBe(FIXTURE_MEME_MINT);
      expect(report.quoteMint).toBe(FIXTURE_WSOL_MINT);
      expect(report.slotDiscrepancy).toBe(false);
      expect(report.reserveAccounting).not.toBeNull();
      expect(report.reserveAccounting?.spotPriceSol).toBe(0.0001);
      expect(report.missingFields).toContain("sourceTimestampMs");
    });

    it("verifyPoolAccount classifies unauthorized program owner, null account, and slot discrepancy honestly", async () => {
      // 1. Unauthorized program owner
      const wrongOwnerRpc: ISolanaRpcTransport = {
        post: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 300000001 },
            value: {
              data: [createAuthoritativeRaydiumAmmV4Buffer().toString("base64"), "base64"],
              owner: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // Pump.fun program
            },
          },
        }),
      };
      const client1 = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        transport: wrongOwnerRpc,
      });
      const rep1 = await client1.verifyPoolAccount(FIXTURE_POOL_ADDRESS);
      expect(rep1.verified).toBe(false);
      expect(rep1.verificationStatus).toBe("UNAUTHORIZED_PROGRAM_ID");
      expect(rep1.programOwner).toBe("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

      // 2. Null account
      const nullRpc: ISolanaRpcTransport = {
        post: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 300000001 },
            value: null,
          },
        }),
      };
      const client2 = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        transport: nullRpc,
      });
      const rep2 = await client2.verifyPoolAccount(FIXTURE_POOL_ADDRESS);
      expect(rep2.verified).toBe(false);
      expect(rep2.verificationStatus).toBe("NULL_ACCOUNT");

      // 3. Rate limit 429
      const rateLimitRpc: ISolanaRpcTransport = {
        post: async () => {
          throw new Error("429 Too Many Requests");
        },
      };
      const client3 = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        transport: rateLimitRpc,
      });
      const rep3 = await client3.verifyPoolAccount(FIXTURE_POOL_ADDRESS);
      expect(rep3.verified).toBe(false);
      expect(rep3.verificationStatus).toBe("RATE_LIMITED_429");
    });

    it("CLI --verify-pool validates pool on-chain and exits 0 without creating session archives", async () => {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      const baseVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 1_000_000_000_000n,
      });
      const quoteVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_WSOL_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 100_000_000_000n,
      });

      const mockRpc: ISolanaRpcTransport = {
        post: async (_url, payload) => {
          const body = payload as { method: string; params: unknown[] };
          if (body.method === "getAccountInfo") {
            return {
              jsonrpc: "2.0",
              id: 1,
              result: {
                context: { slot: 300000001 },
                value: {
                  data: [poolBuffer.toString("base64"), "base64"],
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                },
              },
            };
          }
          if (body.method === "getMultipleAccounts") {
            return {
              jsonrpc: "2.0",
              id: 2,
              result: {
                context: { slot: 300000001 },
                value: [
                  {
                    data: [baseVaultBuffer.toString("base64"), "base64"],
                    owner: SPL_TOKEN_PROGRAM_ID,
                  },
                  {
                    data: [quoteVaultBuffer.toString("base64"), "base64"],
                    owner: SPL_TOKEN_PROGRAM_ID,
                  },
                ],
              },
            };
          }
          return { jsonrpc: "2.0", id: 99, error: { message: "Unknown" } };
        },
      };

      const testDir = await makeTestDir("verify-pool-cli");
      const exitCodeSuccess = await runPilotCollectorCli(
        ["node", "cli.js", "--network=enabled", `--verify-pool=${FIXTURE_POOL_ADDRESS}`],
        { rpcTransport: mockRpc },
      );
      expect(exitCodeSuccess).toBe(0);

      // Verify that no session directory was created in testDir
      const files = await fs.readdir(testDir);
      expect(files.length).toBe(0);

      // Verify exit code 1 if network not enabled
      const exitCodeDisabled = await runPilotCollectorCli([
        "node",
        "cli.js",
        `--verify-pool=${FIXTURE_POOL_ADDRESS}`,
      ]);
      expect(exitCodeDisabled).toBe(1);
    });

    it("Task 3A: session-summary.json correctly aggregates topRejectionReasons matching candidate-decisions", async () => {
      const testDir = await makeTestDir("rejection-summary-test");
      const pumpMint1 = "Pump111111111111111111111111111111111111111";
      const pumpMint2 = "Pump222222222222222222222222222222222222222";

      const mockHttp: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            return new Response(
              JSON.stringify([
                { chainId: "solana", tokenAddress: pumpMint1 },
                { chainId: "solana", tokenAddress: pumpMint2 },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes(pumpMint1) || url.includes(pumpMint2)) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "pumpfun",
                    pairAddress: "PumpPair11111111111111111111111111111111111",
                    baseToken: { address: pumpMint1, symbol: "PUMP1" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        },
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir: testDir,
        durationSec: 5,
        targetCandidates: 2,
        targetDiagnosticYield: 15,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: false,
        httpTransport: mockHttp,
      });

      const result = await runner.run();
      expect(result.status).toBe("FINALIZED");
      expect(result.totalDecisionsRecorded).toBe(2);

      // Verify session-summary.json contains topRejectionReasons matching candidate-decisions.jsonl
      const summaryFile = path.join(result.sessionDir, "session-summary.json");
      const summary = JSON.parse(await fs.readFile(summaryFile, "utf8"));
      expect(summary.totalCandidatesScreened).toBe(2);
      expect(summary.cohortBreakdown.filteredRejected).toBe(2);
      expect(summary.cohortBreakdown.watchlistRadar).toBe(0);
      expect(summary.topRejectionReasons).toEqual({
        NO_RAYDIUM_AMM_PAIR_IDENTIFIED: 2,
      });

      // Verify recovery also reconstructs topRejectionReasons faithfully
      const recovery = await import("./PilotCollectorRunner.js").then((m) =>
        m.PilotCollectorRunner.recoverSession(result.sessionDir),
      );
      expect(recovery.recovered).toBe(true);
      const recoveredSummary = JSON.parse(await fs.readFile(summaryFile, "utf8"));
      expect(recoveredSummary.topRejectionReasons).toEqual({
        NO_RAYDIUM_AMM_PAIR_IDENTIFIED: 2,
      });
    });

    it("Task 3B: sourceTimestampMs: 0 is an audited missing-time convention rejected by downstream H2 validation", () => {
      const candidateWithoutTime: D23ScreenedCandidate = {
        compositeId: {
          decisionEventId: "evt-notime-1",
          sessionId: "sess-notime",
          generationId: "gen1",
          mintAddress: FIXTURE_MEME_MINT,
          poolId: FIXTURE_POOL_ADDRESS,
        },
        symbol: "TEST",
        decisionType: "CANDIDATE_DISCOVERY_PROFILE",
        decisionCohort: "FILTERED_REJECTED",
        selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
        decisionEpochMs: 1792000002000,
        requestEpochMs: 1792000000000,
        receiptEpochMs: 1792000001000,
        sourceTimestampMs: null, // DexScreener does not attest source quote timestamps
        passedEligibility: false,
        filterEvaluations: [],
        rejectionReasons: ["NO_RAYDIUM_AMM_PAIR_IDENTIFIED"],
        missingFields: ["sourceTimestampMs"],
        providerIdentity: "dexscreener_public_v1:OBSERVATIONAL",
      };

      const canonical = toCanonicalCandidateDecision(candidateWithoutTime);
      expect(canonical.sourceTimestampMs).toBe(0);
      expect(canonical.missingFields).toContain("sourceTimestampMs");

      // Verify that strict downstream H2 eligibility validator rejects records with sourceTimestampMs <= 0
      const isH2Eligible = isValidCandidateDecisionRecord(canonical);
      expect(isH2Eligible).toBe(false);
    });

    it("Task 4: stops on TARGET_YIELD_REACHED when target diagnostic yield is reached before max candidates", async () => {
      const testDir = await makeTestDir("target-yield-stop");
      const pumpMint = "Pump111111111111111111111111111111111111111";

      const mockHttp: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            return new Response(
              JSON.stringify([
                { chainId: "solana", tokenAddress: pumpMint },
                { chainId: "solana", tokenAddress: FIXTURE_MEME_MINT },
              ]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes(pumpMint)) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "pump",
                    pairAddress: "PumpPair11111111111111111111111111111111111",
                    baseToken: { address: pumpMint, symbol: "PUMP" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes(FIXTURE_MEME_MINT)) {
            return new Response(
              JSON.stringify({
                pairs: [
                  {
                    chainId: "solana",
                    dexId: "raydium",
                    pairAddress: FIXTURE_POOL_ADDRESS,
                    baseToken: { address: FIXTURE_MEME_MINT, symbol: "BONK" },
                    quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(null, { status: 404 });
        },
      };

      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      const baseVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_MEME_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 1_000_000_000_000n,
      });
      const quoteVaultBuffer = createAuthoritativeSplVaultBuffer({
        mintBase58: FIXTURE_WSOL_MINT,
        ownerBase58: FIXTURE_POOL_ADDRESS,
        rawAmount: 100_000_000_000n,
      });

      const mockRpc: ISolanaRpcTransport = {
        post: async (_url, payload) => {
          const body = payload as { method: string; params: unknown[] };
          if (body.method === "getAccountInfo") {
            return {
              jsonrpc: "2.0",
              id: 1,
              result: {
                context: { slot: 300000001 },
                value: {
                  data: [poolBuffer.toString("base64"), "base64"],
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                },
              },
            };
          }
          if (body.method === "getMultipleAccounts") {
            return {
              jsonrpc: "2.0",
              id: 2,
              result: {
                context: { slot: 300000001 },
                value: [
                  {
                    data: [baseVaultBuffer.toString("base64"), "base64"],
                    owner: SPL_TOKEN_PROGRAM_ID,
                  },
                  {
                    data: [quoteVaultBuffer.toString("base64"), "base64"],
                    owner: SPL_TOKEN_PROGRAM_ID,
                  },
                ],
              },
            };
          }
          return { jsonrpc: "2.0", id: 99, error: { message: "Unknown" } };
        },
      };

      const runner = new LiveCollectorRunner({
        network: "enabled",
        outputDir: testDir,
        durationSec: 10,
        targetCandidates: 50, // High ceiling
        targetDiagnosticYield: 1, // Stop when 1 verified radar observation obtained
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: false,
        httpTransport: mockHttp,
        rpcTransport: mockRpc,
      });

      const result = await runner.run();
      expect(result.status).toBe("FINALIZED");
      expect(result.stopReason).toBe("TARGET_YIELD_REACHED");
      expect(result.totalDecisionsRecorded).toBe(2); // 1 pump (rejected) + 1 bonk (radar)
    });
  });
});
