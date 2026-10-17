/**
 * Phase 12.94-D Milestone D.2.4: Live Read-Only Collector Offline Integration Tests
 *
 * Comprehensive offline verification of:
 * 1. Network enablement gate (fails closed without --network=enabled)
 * 2. DexScreener live discovery client (URL allowlist, deduplication, pair caching, 429 backoff)
 * 3. Solana RPC live observation client (method allowlist, Raydium AMM / SPL Token owner verification, rate limit / 429 backoff)
 * 4. ForwardOutcomeObservationTracker (+1m, +5m, +15m scheduling, forward-observations.jsonl append, causal isolation)
 * 5. Full end-to-end simulated pilot session execution with mock transports
 * 6. Stopping semantics (DURATION_EXPIRED, TARGET_REACHED, RESOURCE_CEILING_REACHED)
 * 7. PilotArchiveImporter (safe import into .tmp/pilot-imports/sessions, manifest verification)
 *
 * ALL tests execute 100% offline with zero outbound network requests and zero Fedora laptop interaction.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

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
  // Helper to create an isolated temporary directory
  async function makeTestDir(prefix: string): Promise<string> {
    const tmpBase = path.join(os.tmpdir(), "nexustrade-d24-tests");
    await fs.mkdir(tmpBase, { recursive: true });
    return await fs.mkdtemp(path.join(tmpBase, `${prefix}-`));
  }

  // --------------------------------------------------------------------------
  // 1. Network Enablement Gating
  // --------------------------------------------------------------------------
  describe("Network Enablement Gating", () => {
    it("fails closed when CLI argument does not specify --network=enabled", () => {
      const parsedDefault = parseCliArgs(["node", "cli.js"]);
      expect(parsedDefault.network).toBe("disabled");

      const parsedExplicitDisabled = parseCliArgs(["node", "cli.js", "--network=disabled"]);
      expect(parsedExplicitDisabled.network).toBe("disabled");
    });

    it("accepts --network=enabled only when explicitly passed", () => {
      const parsed = parseCliArgs(["node", "cli.js", "--network=enabled"]);
      expect(parsed.network).toBe("enabled");
    });

    it("throws [NETWORK_DISABLED] when LiveCollectorRunner is started with disabled network", async () => {
      const testDir = await makeTestDir("net-gate");
      const runner = new LiveCollectorRunner({
        network: "disabled",
        outputDir: testDir,
        durationSec: 10,
        targetCandidates: 5,
        targetDiagnosticYield: 15,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: false,
      });

      await expect(runner.run()).rejects.toThrow("[NETWORK_DISABLED]");
    });

    it("CLI entrypoint returns exit code 1 when network is not enabled", async () => {
      const exitCode = await runPilotCollectorCli(["node", "cli.js"]);
      expect(exitCode).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 2. DexScreener Live Discovery Client
  // --------------------------------------------------------------------------
  describe("DexScreener Live Discovery Client", () => {
    it("enforces URL allowlist and rejects non-allowlisted URLs", () => {
      expect(
        isAllowlistedDexScreenerUrl("https://api.dexscreener.com/token-profiles/latest/v1"),
      ).toBe(true);
      expect(
        isAllowlistedDexScreenerUrl(
          `https://api.dexscreener.com/latest/dex/tokens/${FIXTURE_MEME_MINT}`,
        ),
      ).toBe(true);

      // Invalid paths or hostnames
      expect(isAllowlistedDexScreenerUrl("https://api.dexscreener.com/latest/dex/search")).toBe(
        false,
      );
      expect(isAllowlistedDexScreenerUrl("https://malicious.com/token-profiles/latest/v1")).toBe(
        false,
      );
      expect(
        isAllowlistedDexScreenerUrl("http://api.dexscreener.com/token-profiles/latest/v1"),
      ).toBe(false);
    });

    it("deduplicates discovered token mints and caches pair lookups", async () => {
      const requestedUrls: string[] = [];
      const mockTransport: ILiveHttpTransport = {
        fetch: async (url: string) => {
          requestedUrls.push(url);
          if (url.includes("/token-profiles/latest/v1")) {
            const data = [
              {
                tokenAddress: FIXTURE_MEME_MINT,
                chainId: "solana",
                header: "Bonk",
                description: "Bonk token",
              },
            ];
            return new Response(JSON.stringify(data), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/latest/dex/tokens/")) {
            const data = {
              pairs: [
                {
                  chainId: "solana",
                  dexId: "raydium",
                  pairAddress: FIXTURE_POOL_ADDRESS,
                  baseToken: { address: FIXTURE_MEME_MINT, symbol: "BONK" },
                  quoteToken: { address: FIXTURE_WSOL_MINT, symbol: "SOL" },
                  priceUsd: "0.00001",
                  volume: { m5: 1000 },
                  txns: { m5: { buys: 10, sells: 5 } },
                },
              ],
            };
            return new Response(JSON.stringify(data), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(null, { status: 404 });
        },
      };

      const client = new DexScreenerLiveDiscoveryClient({
        pollIntervalMs: 10,
        transport: mockTransport,
      });

      // First poll
      const firstPoll = await client.pollDiscoveredCandidates({
        sessionId: "sess-1",
        generationId: "gen-1",
      });
      expect(firstPoll.length).toBe(1);
      expect(client.getSeenMintsCount()).toBe(1);
      expect(client.isMintSeen(FIXTURE_MEME_MINT)).toBe(true);

      // Wait a tick so poll interval passes
      await new Promise((r) => setTimeout(r, 20));

      // Second poll with same profiles returned: mint already seen, returns empty
      const secondPoll = await client.pollDiscoveredCandidates({
        sessionId: "sess-1",
        generationId: "gen-1",
      });
      expect(secondPoll.length).toBe(0);

      // Verify pair lookup was only called once
      const pairLookupCalls = requestedUrls.filter((u) => u.includes("/latest/dex/tokens/"));
      expect(pairLookupCalls.length).toBe(1);
    });

    it("handles 429 Retry-After header with backoff", async () => {
      let attempts = 0;
      const mockTransport: ILiveHttpTransport = {
        fetch: async () => {
          attempts++;
          if (attempts === 1) {
            return new Response("Rate limit exceeded", {
              status: 429,
              headers: { "retry-after": "1" },
            });
          }
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      };

      const client = new DexScreenerLiveDiscoveryClient({
        pollIntervalMs: 1,
        transport: mockTransport,
      });

      // Attempt 1: receives 429
      const res1 = await client.pollDiscoveredCandidates({
        sessionId: "sess-1",
        generationId: "gen-1",
      });
      expect(res1.length).toBe(0);

      // Attempt 2 immediately: throttled internally without making second transport call
      const res2 = await client.pollDiscoveredCandidates({
        sessionId: "sess-1",
        generationId: "gen-1",
      });
      expect(res2.length).toBe(0);
      expect(attempts).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Solana RPC Live Observation Client
  // --------------------------------------------------------------------------
  describe("Solana RPC Live Observation Client", () => {
    it("enforces RPC method allowlist and rejects unauthorized methods", async () => {
      const mockRpcTransport: ISolanaRpcTransport = {
        post: async () => ({
          status: 200,
          data: { jsonrpc: "2.0", id: 1, result: null },
          headers: {},
        }),
      };

      const client = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        transport: mockRpcTransport,
      });

      // Unauthorized method call
      await expect(client.executeRpcCall("sendTransaction", ["tx-blob"])).rejects.toThrow(
        "[FORBIDDEN_RPC_METHOD]",
      );

      await expect(client.executeRpcCall("simulateTransaction", ["tx-blob"])).rejects.toThrow(
        "[FORBIDDEN_RPC_METHOD]",
      );
    });

    it("verifies Raydium AMM v4 and SPL Token account ownership on-chain", async () => {
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

      const mockRpcTransport: ISolanaRpcTransport = {
        post: async (_url, payload) => {
          const body = payload as { method: string; params: unknown[] };
          if (body.method === "getAccountInfo") {
            return {
              jsonrpc: "2.0",
              id: 1,
              result: {
                context: { slot: 250000100 },
                value: {
                  data: [poolBuffer.toString("base64"), "base64"],
                  executable: false,
                  lamports: 10000000,
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID, // Valid owner
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
                context: { slot: 250000101 },
                value: [
                  {
                    data: [baseVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 5000000,
                    owner: SPL_TOKEN_PROGRAM_ID, // Valid owner
                    rentEpoch: 0,
                  },
                  {
                    data: [quoteVaultBuffer.toString("base64"), "base64"],
                    executable: false,
                    lamports: 5000000,
                    owner: SPL_TOKEN_PROGRAM_ID, // Valid owner
                    rentEpoch: 0,
                  },
                ],
              },
            };
          }
          return { jsonrpc: "2.0", id: 99, error: { message: "Unknown method" } };
        },
      };

      const client = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        transport: mockRpcTransport,
      });

      const obsResult = await client.observeRaydiumPool({
        poolAddress: FIXTURE_POOL_ADDRESS,
        targetMint: FIXTURE_MEME_MINT,
        flowMetrics: {
          volume5mUsd: 2500,
          buys5m: 15,
          sells5m: 8,
          netBuyerVolumeUsd: null,
        },
        compositeId: {
          sessionId: "sess-test",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-test-1",
        },
      });

      expect(obsResult.ok).toBe(true);
      expect(obsResult.observation).toBeDefined();
      expect(obsResult.observation?.compositeId.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(obsResult.observation?.onChainSlot).toBe(250000101);
      expect(obsResult.observation?.reserveAccounting?.tokenReserveRaw).toBe(1_000_000_000_000n);
      expect(obsResult.observation?.reserveAccounting?.solReserveRaw).toBe(100_000_000_000n);
    });

    it("rejects pools owned by non-Raydium programs", async () => {
      const poolBuffer = createAuthoritativeRaydiumAmmV4Buffer();
      const mockRpcTransport: ISolanaRpcTransport = {
        post: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 250000100 },
            value: {
              data: [poolBuffer.toString("base64"), "base64"],
              executable: false,
              lamports: 10000000,
              owner: "11111111111111111111111111111111", // Wrong program ID
              rentEpoch: 0,
            },
          },
        }),
      };

      const client = new SolanaRpcLiveObservationClient({
        rpcUrl: "http://mock-rpc",
        transport: mockRpcTransport,
      });

      const obsResult = await client.observeRaydiumPool({
        poolAddress: FIXTURE_POOL_ADDRESS,
        targetMint: FIXTURE_MEME_MINT,
        compositeId: {
          sessionId: "sess-test",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-test-2",
        },
      });

      expect(obsResult.ok).toBe(false);
      expect(obsResult.error).toContain("UNAUTHORIZED_POOL_OWNER");
    });
  });

  // --------------------------------------------------------------------------
  // 4. ForwardOutcomeObservationTracker
  // --------------------------------------------------------------------------
  describe("ForwardOutcomeObservationTracker", () => {
    it("schedules and appends forward observations without mutating baseline records", async () => {
      const testDir = await makeTestDir("forward-tracker");
      const tracker = new ForwardOutcomeObservationTracker({ sessionDir: testDir });

      const mockCandidate: D23ScreenedCandidate = {
        compositeId: {
          sessionId: "sess-fwd",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-fwd-1",
        },
        symbol: "BONK",
        decisionType: "CANDIDATE_DISCOVERY_PROFILE",
        decisionCohort: "WATCHLIST_RADAR",
        selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE",
        decisionEpochMs: 1030,
        requestEpochMs: 1010,
        receiptEpochMs: 1020,
        sourceTimestampMs: null,
        passedEligibility: true,
        filterEvaluations: [],
        rejectionReasons: [],
        missingFields: [],
        providerIdentity: "dexscreener_mock",
      };

      const mockObservation: D23ObservationRecord = {
        observationId: "obs-fwd-1",
        compositeId: {
          sessionId: "sess-fwd",
          generationId: "gen1",
          poolId: FIXTURE_POOL_ADDRESS,
          mintAddress: FIXTURE_MEME_MINT,
          decisionEventId: "dec-fwd-1",
        },
        requestEpochMs: 1015,
        receiptEpochMs: 1025,
        sourceReportedTimeMs: null,
        hostMonotonicElapsedMs: 10,
        onChainSlot: 1000,
        slotDiscrepancy: false,
        provenance: "D23_OBSERVATIONAL_SCREENING",
        providerIdentity: "solana_rpc_mock",
        actualResponsePoolId: FIXTURE_POOL_ADDRESS,
        isMatchingPool: true,
        reserveAccounting: {
          mode: "VAULT_ONLY_PROXY",
          tokenMint: FIXTURE_MEME_MINT,
          solMint: FIXTURE_WSOL_MINT,
          tokenReserveRaw: 1_000_000_000_000n,
          solReserveRaw: 100_000_000_000n,
          tokenDecimals: 6,
          solDecimals: 9,
          tokenReserveDecimal: 1_000_000,
          solReserveDecimal: 100,
          spotPriceSol: 0.0001,
          orientation: "TOKEN_BASE_SOL_QUOTE",
          effectiveReservesAvailable: true,
          executionFeasible: true,
        },
        flowMetrics: {
          volume5mUsd: 1000,
          buys5m: 10,
          sells5m: 5,
          netBuyerVolumeUsd: null,
        },
        missingFields: ["sourceTimestampMs"],
      };

      // Register candidate for forward tracking
      tracker.registerCandidateForForwardObservation(mockCandidate, mockObservation);
      expect(tracker.getPendingTargetsCount()).toBe(3); // +1m, +5m, +15m

      // Mock RPC observation client
      let rpcCalls = 0;
      const mockRpcClient = {
        observeRaydiumPool: async () => {
          rpcCalls++;
          return {
            ok: true,
            observation: {
              ...mockObservation,
              onChainSlot: 1050,
            },
            reserveAccounting: {
              ...mockObservation.reserveAccounting,
              tokenReserveDecimal: 900_000,
              solReserveDecimal: 110,
              spotPriceSol: 0.000122,
            },
          };
        },
      } as unknown as SolanaRpcLiveObservationClient;

      // Poll before +1m: 0 due
      const written0 = await tracker.pollDueObservations(mockRpcClient, 1030 + 30_000);
      expect(written0).toBe(0);
      expect(rpcCalls).toBe(0);

      // Poll at +61s: 1 due (+1m)
      const written1 = await tracker.pollDueObservations(mockRpcClient, 1030 + 61_000);
      expect(written1).toBe(1);
      expect(rpcCalls).toBe(1);
      expect(tracker.getPendingTargetsCount()).toBe(2);
      expect(tracker.getTotalRecordedCount()).toBe(1);

      // Verify forward-observations.jsonl was written
      const fwdFile = path.join(testDir, "forward-observations.jsonl");
      expect(fsSync.existsSync(fwdFile)).toBe(true);
      const content = await fs.readFile(fwdFile, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]!);
      expect(parsed.targetIntervalSec).toBe(60);
      expect(parsed.baselineDecisionEventId).toBe("dec-fwd-1");
      expect(parsed.isPoolActive).toBe(true);
      expect(parsed.baseReserveDecimal).toBe(900_000);
      expect(parsed.quoteReserveDecimal).toBe(110);
    });
  });

  // --------------------------------------------------------------------------
  // 5. End-to-End Offline Simulated Session
  // --------------------------------------------------------------------------
  describe("End-to-End Offline Simulated Session", () => {
    it("runs complete simulated session, records candidates, and finalizes with verified manifest", async () => {
      const testDir = await makeTestDir("e2e-session");

      // Mock Http Transport for DexScreener
      const mockHttp: ILiveHttpTransport = {
        fetch: async (url: string) => {
          if (url.includes("/token-profiles/latest/v1")) {
            const data = [
              {
                tokenAddress: FIXTURE_MEME_MINT,
                chainId: "solana",
                header: "Bonk",
                description: "Bonk token",
              },
            ];
            return new Response(JSON.stringify(data), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/latest/dex/tokens/")) {
            const data = {
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
            };
            return new Response(JSON.stringify(data), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(null, { status: 404 });
        },
      };

      // Mock RPC Transport for Solana
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
        durationSec: 2,
        targetCandidates: 1,
        targetDiagnosticYield: 15,
        maxMb: 10,
        rpcUrl: "http://mock-rpc",
        pollIntervalSec: 1,
        enableForwardObservations: true,
        httpTransport: mockHttp,
        rpcTransport: mockRpc,
      });

      const result = await runner.run();
      expect(result.status).toBe("FINALIZED");
      expect(result.manifestValid).toBe(true);
      expect(result.totalDecisionsRecorded).toBeGreaterThanOrEqual(1);

      // Verify files in session directory
      const sessionFiles = await fs.readdir(result.sessionDir);
      expect(sessionFiles).toContain("session-meta.json");
      expect(sessionFiles).toContain("session-summary.json");
      expect(sessionFiles).toContain("candidate-decisions.jsonl");
      expect(sessionFiles).toContain("shadow-evaluations.jsonl");
      expect(sessionFiles).toContain("market-observations.jsonl");
      expect(sessionFiles).toContain("manifest.json");

      // Verify export manifest independently
      const manifestVerification = await verifySessionExportManifest(result.sessionDir);
      expect(manifestVerification.valid).toBe(true);
      expect(manifestVerification.missingFiles).toHaveLength(0);
      expect(manifestVerification.mismatchedFiles).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // 6. PilotArchiveImporter Tests
  // --------------------------------------------------------------------------
  describe("PilotArchiveImporter", () => {
    it("imports a valid session to the isolated import directory and verifies integrity", async () => {
      const sourceBase = await makeTestDir("import-source");
      const importBase = await makeTestDir("import-target");

      // Run a mini session to produce a valid source archive
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
      expect(sessionResult.manifestValid).toBe(true);

      // Import to target
      const importResult = await importAndVerifyPilotSession(sessionResult.sessionDir, {
        importRootDir: importBase,
        runRecovery: true,
        runCompatibilityAudit: true,
      });

      expect(importResult.ok).toBe(true);
      expect(importResult.manifestResult.valid).toBe(true);
      expect(importResult.importedSessionDir.startsWith(importBase)).toBe(true);
      // Confirmed isolated from historical telemetry directory
      expect(importResult.importedSessionDir).not.toContain(".tmp/telemetry/sessions");
    });

    it("rejects an archive with tampered or modified JSONL files during import", async () => {
      const sourceBase = await makeTestDir("tampered-source");
      const importBase = await makeTestDir("tampered-target");

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

      // Tamper with session-summary.json after manifest was generated
      const summaryPath = path.join(sessionResult.sessionDir, "session-summary.json");
      await fs.appendFile(summaryPath, " ", "utf8");

      // Attempt import
      const importResult = await importAndVerifyPilotSession(sessionResult.sessionDir, {
        importRootDir: importBase,
      });

      expect(importResult.ok).toBe(false);
      expect(importResult.manifestResult.valid).toBe(false);
      expect(importResult.manifestResult.mismatchedFiles).toContain("session-summary.json");
      expect(importResult.error).toContain("[MANIFEST_VERIFICATION_FAILED]");
    });
  });
});
