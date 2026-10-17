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
      expect(result.stopReason).toBe("TARGET_REACHED");
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

    it("rejects import when destination directory already exists unless allowOverwrite=true", async () => {
      const sourceBase = await makeTestDir("valid-source");
      const importBase = await makeTestDir("dup-target");

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

      // Pre-create target dir
      const existingTargetDir = path.join(importBase, sessionFolderName);
      await fs.mkdir(existingTargetDir, { recursive: true });

      // Attempt import without allowOverwrite
      const importResult1 = await importAndVerifyPilotSession(sessionResult.sessionDir, {
        importRootDir: importBase,
        allowOverwrite: false,
      });
      expect(importResult1.ok).toBe(false);
      expect(importResult1.error).toContain("[IMPORT_DESTINATION_EXISTS]");

      // Attempt import with allowOverwrite=true succeeds
      const importResult2 = await importAndVerifyPilotSession(sessionResult.sessionDir, {
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
});
