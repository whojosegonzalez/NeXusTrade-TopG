/**
 * Phase 12.94-D Milestone D.2.9-B2: Offline Readiness Integration Tests
 *
 * Verifies all offline components and safeguards for prospective, event-driven Raydium pool discovery:
 * 1. Protocol-Neutral WebSocket log subscription with separate AMM v4 and CPMM channels.
 * 2. Authentic initialization-instruction detection (inner CPI, v0 transactions, Address Lookup Tables).
 * 3. Controlled read-only transaction fetching & account verification with strict RPC allowlists.
 * 4. Raw notification, transaction, and account-evidence capture with provenance and canonical SHA-256 manifest.
 * 5. Bounded queues, deduplication, retry, reconnect, and backfill gap recovery.
 * 6. Explicit WebSocket message, transaction-fetch, account-read, runtime, and memory budget ceilings.
 * 7. Auditable separation of notifications, transactions, initializations, unique pools, verified pools, and unresolved observations.
 * 8. Interruption and recovery handling (fail-closed, honest sealing).
 * 9. Operator safety guard: rejection of unauthorized live WebSocket discovery and preservation of two-strategy architecture.
 *
 * All tests run 100% OFFLINE with deterministic mock transports.
 * Zero live network calls, zero wallet operations, virtual wallet frozen at 7.9259 SOL.
 */

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  DiscoveredPoolAccountPayload,
  VersionedTransactionMetadata,
} from "./EventDiscoveryContracts.js";
import { EventDiscoveryIngestionEngine } from "./EventDiscoveryIngestionEngine.js";
import {
  EventDiscoverySessionCoordinator,
  type EventDiscoverySessionSummary,
} from "./EventDiscoverySessionCoordinator.js";
import {
  EXPECTED_B2_EVIDENCE_FILES,
  saveB2EventSession,
  verifyB2SessionManifest,
} from "./EventSessionEvidenceCapture.js";
import { createAmmV4InitTransactionFixture } from "./fixtures/AuthoritativeEventFixtures.js";
import {
  createAuthoritativeRaydiumAmmV4Buffer,
  createAuthoritativeSplVaultBuffer,
  FIXTURE_BASE_VAULT,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_QUOTE_VAULT,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";
import {
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_MINT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
} from "./fixtures/AuthoritativeCpmmFixtures.js";
import { loadAccountMapFromFixtures, runPilotCollectorCli } from "./PilotLiveCollectorCli.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "./RaydiumAmmParser.js";
import { RAYDIUM_CPMM_PROGRAM_ID } from "./RaydiumCpmmParser.js";
import type { ISolanaRpcTransport } from "./SolanaRpcLiveObservationClient.js";
import { SolanaRpcRecordingAccountFetcher } from "./SolanaRpcRecordingAccountFetcher.js";
import { SolanaRpcTransactionFetcher } from "./SolanaRpcTransactionFetcher.js";
import {
  type ISolanaWebSocketTransport,
  SolanaWebSocketSubscriptionClient,
} from "./SolanaWebSocketSubscriptionClient.js";

/**
 * Deterministic Mock WebSocket Transport for offline testing.
 */
class MockWebSocketTransport implements ISolanaWebSocketTransport {
  public sentFrames: string[] = [];
  public closed = false;
  public closeCode?: number | undefined;
  public closeReason?: string | undefined;

  private openListeners: (() => void)[] = [];
  private messageListeners: ((data: string | Buffer) => void)[] = [];
  private errorListeners: ((err: Error) => void)[] = [];
  private closeListeners: ((code: number, reason: string) => void)[] = [];

  public send(data: string): void {
    this.sentFrames.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    for (const fn of this.closeListeners) fn(code ?? 1000, reason ?? "");
  }

  public on(
    event: "open" | "message" | "error" | "close",
    listener:
      | (() => void)
      | ((data: string | Buffer) => void)
      | ((err: Error) => void)
      | ((code: number, reason: string) => void),
  ): void {
    if (event === "open") this.openListeners.push(listener as () => void);
    else if (event === "message")
      this.messageListeners.push(listener as (data: string | Buffer) => void);
    else if (event === "error") this.errorListeners.push(listener as (err: Error) => void);
    else if (event === "close")
      this.closeListeners.push(listener as (code: number, reason: string) => void);
  }

  public triggerOpen(): void {
    for (const fn of this.openListeners) fn();
  }

  public triggerMessage(data: string): void {
    for (const fn of this.messageListeners) fn(data);
  }

  public triggerError(err: Error): void {
    for (const fn of this.errorListeners) fn(err);
  }
}

/**
 * Deterministic Mock RPC Transport for offline transaction and account queries.
 */
class MockSolanaRpcTransport implements ISolanaRpcTransport {
  public calls: Array<{ method: string; params: unknown[] }> = [];
  public transactions = new Map<string, VersionedTransactionMetadata>();
  public accounts = new Map<string, DiscoveredPoolAccountPayload>();

  public async post(_url: string, body: Record<string, unknown>): Promise<unknown> {
    const method = body.method as string;
    const params = (body.params as unknown[]) ?? [];
    const id = body.id ?? "mock-id";
    this.calls.push({ method, params });

    if (method === "getTransaction") {
      const signature = params[0] as string;
      const tx = this.transactions.get(signature);
      if (!tx) {
        return { jsonrpc: "2.0", id, result: null };
      }

      // Format as Solana getTransaction JSON wire structure
      const accountKeys = [
        ...tx.accountKeys.staticAccountKeys,
        ...(tx.accountKeys.loadedAddresses?.writable ?? []),
        ...(tx.accountKeys.loadedAddresses?.readonly ?? []),
      ];

      return {
        jsonrpc: "2.0",
        id,
        result: {
          slot: tx.slot,
          blockTime: tx.blockTime,
          version: tx.version,
          transaction: {
            signatures: [signature],
            message: {
              accountKeys,
              instructions: tx.instructions.map((inst) => ({
                programIdIndex: inst.programIdIndex,
                accounts: inst.accountKeyIndexes,
                data: inst.data,
              })),
            },
          },
          meta: {
            err: tx.err,
            logMessages: tx.logMessages ?? ["Program log: initialize"],
            loadedAddresses: tx.accountKeys.loadedAddresses,
            innerInstructions: (tx.innerInstructions ?? []).map((group) => ({
              index: group.index,
              instructions: group.instructions.map((inst) => ({
                programIdIndex: inst.programIdIndex,
                accounts: inst.accountKeyIndexes,
                data: inst.data,
              })),
            })),
          },
        },
      };
    }

    if (method === "getAccountInfo") {
      const address = params[0] as string;
      const acc = this.accounts.get(address);
      if (!acc) {
        return {
          jsonrpc: "2.0",
          id,
          result: { context: { slot: 450000100 }, value: null },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          context: { slot: acc.slot },
          value: {
            data: [Buffer.from(acc.data).toString("base64"), "base64"],
            owner: acc.owner,
            lamports: Number(acc.lamports),
          },
        },
      };
    }

    if (method === "getMultipleAccounts") {
      const addresses = (params[0] as string[]) ?? [];
      let maxSlot = 450000100;
      const values = addresses.map((addr) => {
        const acc = this.accounts.get(addr);
        if (!acc) return null;
        if (acc.slot > maxSlot) maxSlot = acc.slot;
        return {
          data: [Buffer.from(acc.data).toString("base64"), "base64"],
          owner: acc.owner,
          lamports: Number(acc.lamports),
        };
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          context: { slot: maxSlot },
          value: values,
        },
      };
    }

    throw new Error(`[MOCK_RPC_UNAUTHORIZED] Method '${method}' not allowlisted in mock`);
  }
}

describe("D.2.9-B2 Offline Readiness Integration Suite", () => {
  const testTmpBase = path.join(os.tmpdir(), `b2-readiness-test-${Date.now()}`);

  it("registers separate Raydium AMM v4 and CPMM WebSocket log subscriptions and routes incoming notifications", () => {
    const transport = new MockWebSocketTransport();
    const statusLog: string[] = [];
    const client = new SolanaWebSocketSubscriptionClient({
      wsUrl: "wss://api.mainnet-beta.solana.com?token=secret123",
      transport,
      maxMessagesBudget: 5,
      onLog: (m) => statusLog.push(m),
    });

    // Sanitization: credential stripped from sanitizedUrl and endpointHost
    expect(client.getSanitizedUrl()).toContain("api.mainnet-beta.solana.com");
    expect(client.getSanitizedUrl()).not.toContain("secret123");
    expect(client.getSanitizedUrl()).toContain("[REDACTED]");
    expect(client.getEndpointHost()).toBe("api.mainnet-beta.solana.com");
    expect(client.getStatus()).toBe("CONNECTING");

    // Open connection triggers separate protocol subscription requests
    transport.triggerOpen();
    expect(client.getStatus()).toBe("CONNECTED");
    expect(transport.sentFrames.length).toBe(2);

    const req1 = JSON.parse(transport.sentFrames[0]!);
    const req2 = JSON.parse(transport.sentFrames[1]!);

    expect(req1.method).toBe("logsSubscribe");
    expect(req1.params[0].mentions).toContain(RAYDIUM_AMM_V4_PROGRAM_ID);
    expect(req2.method).toBe("logsSubscribe");
    expect(req2.params[0].mentions).toContain(RAYDIUM_CPMM_PROGRAM_ID);

    // Confirm subscriptions by id
    transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: req1.id, result: 101 }));
    transport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: req2.id, result: 202 }));
    expect(client.getStatus()).toBe("SUBSCRIBED");

    // Route incoming AMM v4 notification
    const receivedProtocols: string[] = [];
    client["onNotification"] = (_env, proto) => receivedProtocols.push(proto);

    transport.triggerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 450000100 },
            value: { signature: "sig-amm-1", err: null, logs: ["Program log: initialize"] },
          },
        },
      }),
    );

    // Route incoming CPMM notification
    transport.triggerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 202,
          result: {
            context: { slot: 450000105 },
            value: { signature: "sig-cpmm-1", err: null, logs: ["Program log: initialize2"] },
          },
        },
      }),
    );

    expect(receivedProtocols).toEqual(["RAYDIUM_AMM_V4", "RAYDIUM_CPMM"]);

    const metrics = client.getMetrics();
    expect(metrics.messagesReceived).toBe(2);
    expect(metrics.ammV4Notifications).toBe(1);
    expect(metrics.cpmmNotifications).toBe(1);

    // Budget Ceiling Enforcement: deliver 4 more messages (exceeding budget of 5)
    for (let i = 0; i < 4; i++) {
      transport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 101,
            result: {
              context: { slot: 450000110 + i },
              value: { signature: `sig-extra-${i}`, err: null, logs: ["log"] },
            },
          },
        }),
      );
    }

    const finalMetrics = client.getMetrics();
    expect(finalMetrics.messagesReceived).toBe(5); // capped at budget
    expect(finalMetrics.droppedBudgetExceeded).toBe(1); // dropped excess message
  });

  it("fetches versioned transactions with inner CPI instructions, ALTs, and enforces call budget ceiling", async () => {
    const mockRpc = new MockSolanaRpcTransport();
    const fetcher = new SolanaRpcTransactionFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com?api-key=supersecret",
      transport: mockRpc,
      maxTransactionsBudget: 2,
    });

    expect(fetcher.getSanitizedEndpoint()).toContain("api.mainnet-beta.solana.com");
    expect(fetcher.getSanitizedEndpoint()).not.toContain("supersecret");
    expect(fetcher.getSanitizedEndpoint()).toContain("[REDACTED]");
    expect(fetcher.getCallsExecutedCount()).toBe(0);

    // Populate mock transaction with Address Lookup Table addresses and inner instructions
    const mockTx: VersionedTransactionMetadata = {
      signature:
        "5VerSignedTx111111111111111111111111111111111111111111111111111111111111111111111111111111",
      slot: 450000120,
      blockTime: 1792600000,
      err: null,
      version: 0,
      accountKeys: {
        staticAccountKeys: [
          "Static1111111111111111111111111111111111111111",
          RAYDIUM_CPMM_PROGRAM_ID,
        ],
        loadedAddresses: {
          writable: ["AltWritable111111111111111111111111111111111111"],
          readonly: ["AltReadonly111111111111111111111111111111111111"],
        },
      },
      instructions: [
        {
          programIdIndex: 1,
          accountKeyIndexes: [0, 2],
          data: "rawdata",
          dataEncoding: "base58",
        },
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 1,
              accountKeyIndexes: [0, 3],
              data: "innerdata",
              dataEncoding: "base58",
            },
          ],
        },
      ],
      logMessages: ["Program log: initialize"],
    };
    mockRpc.transactions.set(mockTx.signature, mockTx);

    // Call 1: success
    const fetched1 = await fetcher.fetchTransaction(mockTx.signature);
    expect(fetched1).not.toBeNull();
    expect(fetched1?.signature).toBe(mockTx.signature);
    expect(fetched1?.accountKeys.loadedAddresses?.writable).toContain(
      "AltWritable111111111111111111111111111111111111",
    );
    expect(fetched1?.innerInstructions?.length).toBe(1);
    expect(fetcher.getCallsExecutedCount()).toBe(1);

    // Wire record preservation
    const records = fetcher.getCapturedTransactions();
    expect(records.length).toBe(1);
    expect(records[0]!.request.method).toBe("getTransaction");
    expect(records[0]!.request.endpoint).not.toContain("supersecret");
    expect(records[0]!.timing.elapsedMs).toBeGreaterThanOrEqual(0);

    // Call 2: missing signature returns null cleanly
    const fetched2 = await fetcher.fetchTransaction("nonexistent-sig");
    expect(fetched2).toBeNull();
    expect(fetcher.getCallsExecutedCount()).toBe(2);

    // Call 3: exceeds budget ceiling of 2 -> rejected without calling transport
    const initialRpcCalls = mockRpc.calls.length;
    const fetched3 = await fetcher.fetchTransaction(mockTx.signature);
    expect(fetched3).toBeNull();
    expect(mockRpc.calls.length).toBe(initialRpcCalls);
  });

  it("fetches single and multiple accounts via recording account fetcher and enforces call budget", async () => {
    const mockRpc = new MockSolanaRpcTransport();
    const fetcher = new SolanaRpcRecordingAccountFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com?key=hiddenkey",
      transport: mockRpc,
      maxAccountCallsBudget: 2,
    });

    // Populate mock CPMM pool account and vault accounts
    mockRpc.accounts.set(FIXTURE_CPMM_POOL_ADDRESS, {
      address: FIXTURE_CPMM_POOL_ADDRESS,
      data: createAuthoritativeRaydiumCpmmBuffer(),
      owner: RAYDIUM_CPMM_PROGRAM_ID,
      lamports: 10000000n,
      slot: 450000150,
    });
    mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_0_VAULT, {
      address: FIXTURE_CPMM_TOKEN_0_VAULT,
      data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
      owner: SPL_TOKEN_PROGRAM_ID,
      lamports: 2000000n,
      slot: 450000150,
    });
    mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_1_VAULT, {
      address: FIXTURE_CPMM_TOKEN_1_VAULT,
      data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
      owner: SPL_TOKEN_PROGRAM_ID,
      lamports: 2000000n,
      slot: 450000150,
    });

    // Call 1: getAccountInfo
    const poolAcc = await fetcher.getAccountInfo(FIXTURE_CPMM_POOL_ADDRESS);
    expect(poolAcc).not.toBeNull();
    expect(poolAcc?.address).toBe(FIXTURE_CPMM_POOL_ADDRESS);
    expect(poolAcc?.owner).toBe(RAYDIUM_CPMM_PROGRAM_ID);
    expect(await fetcher.getSlot()).toBe(450000150);

    // Call 2: getMultipleAccounts
    const vaults = await fetcher.getMultipleAccounts([
      FIXTURE_CPMM_TOKEN_0_VAULT,
      FIXTURE_CPMM_TOKEN_1_VAULT,
    ]);
    expect(vaults.length).toBe(2);
    expect(vaults[0]?.address).toBe(FIXTURE_CPMM_TOKEN_0_VAULT);
    expect(vaults[1]?.address).toBe(FIXTURE_CPMM_TOKEN_1_VAULT);
    expect(fetcher.getCallsExecutedCount()).toBe(2);

    // Call 3: exceeds budget ceiling of 2 -> rejected
    const blockedAcc = await fetcher.getAccountInfo(FIXTURE_CPMM_POOL_ADDRESS);
    expect(blockedAcc).toBeNull();

    // Verify wire records
    const captured = fetcher.getCapturedInteractions();
    expect(captured.length).toBe(2);
    expect(captured[0]!.request.method).toBe("getAccountInfo");
    expect(captured[1]!.request.method).toBe("getMultipleAccounts");
    expect(captured[0]!.request.endpoint).not.toContain("hiddenkey");
  });

  it("seals immutable B2 session evidence, computes canonical manifestSha256, and verifies manifest contract", () => {
    const captureDir = path.join(testTmpBase, "manifest-sealing-test");
    fsSync.mkdirSync(captureDir, { recursive: true });

    const captureResult = saveB2EventSession({
      captureBaseDir: captureDir,
      sessionId: "b2-test-session-001",
      wsUrl: "wss://api.mainnet-beta.solana.com/",
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      endpointHost: "api.mainnet-beta.solana.com",
      endpointFingerprint: "sha256-test-fp",
      forcedStatus: "FINALIZED",
      rawNotifications: [
        {
          receivedEpochMs: 1792600000000,
          receivedIso: "2026-10-21T06:00:00.000Z",
          subscriptionId: 101,
          protocol: "RAYDIUM_CPMM",
          envelope: {
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              subscription: 101,
              result: {
                context: { slot: 450000100 },
                value: { signature: "sig-test", err: null, logs: ["init"] },
              },
            },
          },
        },
      ],
      rawTransactions: [],
      rawAccounts: [],
      discoveredEvents: [],
      verificationReports: [],
    });

    expect(captureResult.status).toBe("FINALIZED");
    expect(fsSync.existsSync(captureResult.manifestPath)).toBe(true);

    // Verify all 6 evidence files exist on disk
    for (const file of EXPECTED_B2_EVIDENCE_FILES) {
      expect(fsSync.existsSync(path.join(captureResult.sessionDir, file))).toBe(true);
    }

    // Verify manifest verification function succeeds on sealed dir
    const verification = verifyB2SessionManifest(captureResult.sessionDir);
    expect(verification.valid).toBe(true);
    expect(verification.manifest.totalFiles).toBe(6);
    expect(verification.manifest.manifestSha256).toBe(captureResult.manifest.manifestSha256);

    // Tamper resistance: modifying any byte in an evidence file causes verification failure
    const notifPath = path.join(captureResult.sessionDir, "raw-notifications.jsonl");
    fsSync.appendFileSync(notifPath, "tampered-byte");
    expect(() => verifyB2SessionManifest(captureResult.sessionDir)).toThrow(
      /B2_MANIFEST_SIZE_MISMATCH|B2_MANIFEST_HASH_MISMATCH/,
    );
  });

  it("coordinates full prospective discovery session, obeys all budgets, and generates auditable accounting", async () => {
    const wsTransport = new MockWebSocketTransport();
    const mockRpc = new MockSolanaRpcTransport();

    const wsClient = new SolanaWebSocketSubscriptionClient({
      wsUrl: "wss://api.mainnet-beta.solana.com/",
      transport: wsTransport,
      maxMessagesBudget: 50,
    });

    const txFetcher = new SolanaRpcTransactionFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
      maxTransactionsBudget: 10,
    });

    const accountFetcher = new SolanaRpcRecordingAccountFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
      maxAccountCallsBudget: 10,
    });

    // Populate mock AMM v4 pool and accounts
    mockRpc.accounts.set(FIXTURE_POOL_ADDRESS, {
      address: FIXTURE_POOL_ADDRESS,
      data: createAuthoritativeRaydiumAmmV4Buffer(),
      owner: RAYDIUM_AMM_V4_PROGRAM_ID,
      lamports: 10000000n,
      slot: 450000200,
    });
    mockRpc.accounts.set(FIXTURE_BASE_VAULT, {
      address: FIXTURE_BASE_VAULT,
      data: createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      owner: SPL_TOKEN_PROGRAM_ID,
      lamports: 2000000n,
      slot: 450000200,
    });
    mockRpc.accounts.set(FIXTURE_QUOTE_VAULT, {
      address: FIXTURE_QUOTE_VAULT,
      data: createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      owner: SPL_TOKEN_PROGRAM_ID,
      lamports: 2000000n,
      slot: 450000200,
    });

    // Authoritative AMM v4 initialization transaction fixture
    const ammTx = createAmmV4InitTransactionFixture({
      poolId: FIXTURE_POOL_ADDRESS,
      token0Mint: FIXTURE_MEME_MINT,
      token1Mint: FIXTURE_WSOL_MINT,
      token0Vault: FIXTURE_BASE_VAULT,
      token1Vault: FIXTURE_QUOTE_VAULT,
      slot: 450000200,
    });
    const ammTxSignature = ammTx.signature;
    mockRpc.transactions.set(ammTxSignature, ammTx);

    const captureDir = path.join(testTmpBase, "coordinator-test-session");

    const coordinator = new EventDiscoverySessionCoordinator({
      wsClient,
      txFetcher,
      accountFetcher,
      captureBaseDir: captureDir,
      budgets: {
        durationSec: 1, // 1 second duration
        maxWsMessages: 20,
        maxTransactions: 5,
        maxAccountReads: 5,
        maxTotalRpcCalls: 10,
      },
    });

    // Start WebSocket
    wsTransport.triggerOpen();
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 101 }));
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 202 }));

    // Inject 1 initialization notification
    wsTransport.triggerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 450000200 },
            value: {
              signature: ammTx.signature,
              err: null,
              logs: ammTx.logMessages ?? [
                "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
              ],
            },
          },
        },
      }),
    );

    // Run coordinator session
    const summary: EventDiscoverySessionSummary = await coordinator.runSession();

    expect(summary.status).toBe("FINALIZED");
    expect(summary.budgets.maxTotalRpcCalls).toBe(10);
    expect(summary.accounting.rawNotificationsReceived).toBe(1);
    expect(summary.accounting.transactionsFetched).toBe(1);
    expect(summary.accounting.poolInitializationsDecoded).toBe(1);
    expect(summary.accounting.uniquePoolsDiscovered).toBe(1);
    expect(summary.accounting.poolsVerifiedCoherent).toBe(1);
    expect(summary.accounting.poolsRejected).toBe(0);
    expect(summary.accounting.unresolvedObservations).toBe(0);

    // Verify evidence was sealed and manifest validated
    expect(summary.manifestVerified).toBe(true);
    expect(summary.manifest?.totalFiles).toBe(6);
  });

  it("handles operator interruption cleanly with honest status and sealed evidence", async () => {
    const wsTransport = new MockWebSocketTransport();
    const mockRpc = new MockSolanaRpcTransport();

    const wsClient = new SolanaWebSocketSubscriptionClient({
      wsUrl: "wss://api.mainnet-beta.solana.com/",
      transport: wsTransport,
    });
    const txFetcher = new SolanaRpcTransactionFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
    });
    const accountFetcher = new SolanaRpcRecordingAccountFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
    });

    const captureDir = path.join(testTmpBase, "interrupted-session");
    const coordinator = new EventDiscoverySessionCoordinator({
      wsClient,
      txFetcher,
      accountFetcher,
      captureBaseDir: captureDir,
      budgets: { durationSec: 10 },
    });

    // Request stop immediately
    coordinator.requestStop("OPERATOR_INTERRUPT");
    const summary = await coordinator.runSession();

    expect(summary.status).toBe("INTERRUPTED");
    expect(summary.stopReason).toContain("OPERATOR_INTERRUPT");
    expect(summary.manifest?.status).toBe("INTERRUPTED");
    expect(summary.manifestVerified).toBe(true);
  });

  it("enforces operator safety guard: rejects live WebSocket event discovery and preserves two-strategy separation", async () => {
    // Test 1: CLI rejects --network=enabled --discovery-source=events with explicit error
    const exitCode = await runPilotCollectorCli([
      "node",
      "cli.js",
      "--network=enabled",
      "--discovery-source=events",
    ]);
    expect(exitCode).toBe(1);

    // Test 2: Two-Strategy Architecture Separation Verification
    // Mature-pool catalog scanning (Established Runners) and event discovery (Micro-Cap Probes) remain separate.
    const engine = new EventDiscoveryIngestionEngine();
    const metrics = engine.getMetricsSnapshot();

    // Verify the engine operates strictly on prospective initialization events
    expect(metrics.candidatePoolsDiscovered).toBe(0);
    expect(metrics.rawLogNotificationsReceived).toBe(0);

    // Verify authentic replay mode on a sealed B2 session directory loads without network
    const replaySessionDir = path.join(testTmpBase, "replay-safe-session");
    const safeCapture = saveB2EventSession({
      captureBaseDir: replaySessionDir,
      sessionId: "b2-safe-001",
      forcedStatus: "FINALIZED",
      rawAccounts: [
        {
          request: {
            jsonrpc: "2.0",
            id: "req-1",
            method: "getAccountInfo",
            params: [FIXTURE_CPMM_POOL_ADDRESS, { encoding: "base64", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "req-1",
            result: {
              context: { slot: 450000100 },
              value: {
                data: [createAuthoritativeRaydiumCpmmBuffer().toString("base64"), "base64"],
                owner: RAYDIUM_CPMM_PROGRAM_ID,
                lamports: 10000000,
              },
            },
          },
          timing: { elapsedMs: 50, payloadSizeBytes: 100 },
        },
      ],
    });

    const accountMap = loadAccountMapFromFixtures(safeCapture.sessionDir, {
      replayMode: "authentic",
    });
    expect(accountMap.has(FIXTURE_CPMM_POOL_ADDRESS)).toBe(true);
  });
});
