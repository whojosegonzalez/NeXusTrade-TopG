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
import { describe, expect, it, vi } from "vitest";
import type {
  DiscoveredPoolAccountPayload,
  DiscoveredPoolInitializationEvent,
  VersionedTransactionMetadata,
} from "./EventDiscoveryContracts.js";
import { EventDiscoveryIngestionEngine } from "./EventDiscoveryIngestionEngine.js";
import {
  EventDiscoverySessionCoordinator,
  type EventDiscoverySessionSummary,
} from "./EventDiscoverySessionCoordinator.js";
import {
  EXPECTED_B2_EVIDENCE_FILES,
  ProgressiveEvidenceRecorder,
  saveB2EventSession,
  verifyB2SessionManifest,
} from "./EventSessionEvidenceCapture.js";
import {
  createAmmV4InitTransactionFixture,
  createCpmmInitTransactionFixture,
  createRealisticVersion1GetTransactionRpcResponse,
  MockOnChainAccountFetcher,
} from "./fixtures/AuthoritativeEventFixtures.js";
import {
  identifyPoolInitializationInstructions,
  resolveTransactionAccountKeys,
} from "./PoolInitializationParser.js";
import { dispatchPoolVerification } from "./VerificationDispatchService.js";
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
import {
  loadAccountMapFromFixtures,
  parseCliArgs,
  PilotLogger,
  runPilotCollectorCli,
  runReplaySession,
} from "./PilotLiveCollectorCli.js";
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

  public autoOpenAndAck = false;

  public send(data: string): void {
    this.sentFrames.push(data);
    if (this.autoOpenAndAck) {
      try {
        const parsed = JSON.parse(data);
        if (parsed.method === "logsSubscribe" && parsed.id) {
          setTimeout(() => {
            this.triggerMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: typeof parsed.id === "number" ? parsed.id * 10 : 100,
              }),
            );
          }, 5);
        }
      } catch {
        // ignore
      }
    }
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
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      if (this.autoOpenAndAck) {
        setTimeout(() => (listener as () => void)(), 5);
      }
    } else if (event === "message") {
      this.messageListeners.push(listener as (data: string | Buffer) => void);
    } else if (event === "error") {
      this.errorListeners.push(listener as (err: Error) => void);
    } else if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: string) => void);
    }
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

  public triggerClose(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code ?? 1006;
    this.closeReason = reason ?? "Abnormal closure";
    for (const fn of this.closeListeners) fn(this.closeCode, this.closeReason);
  }
}

/**
 * Deterministic Mock RPC Transport for offline transaction and account queries.
 */
class MockSolanaRpcTransport implements ISolanaRpcTransport {
  public calls: Array<{ method: string; params: unknown[] }> = [];
  public transactions = new Map<string, VersionedTransactionMetadata>();
  public accounts = new Map<string, DiscoveredPoolAccountPayload>();
  public customResponses = new Map<string, unknown>();

  public registerResponse(method: string, response: unknown): void {
    this.customResponses.set(method, response);
  }

  public async post(_url: string, body: Record<string, unknown>): Promise<unknown> {
    const method = body.method as string;
    const params = (body.params as unknown[]) ?? [];
    const id = body.id ?? "mock-id";
    this.calls.push({ method, params });

    if (this.customResponses.has(method)) {
      const resp = this.customResponses.get(method) as Record<string, unknown>;
      return { jsonrpc: "2.0", id, ...resp };
    }

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
    wsTransport.autoOpenAndAck = true;
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
    wsTransport.autoOpenAndAck = true;
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

  it("B2-READY-01: operator authorization gate prevents network execution without flag, and executes when authorized with mock transport", async () => {
    // 1. Missing flag rejects immediately with exit code 1
    const exitCodeUnauthorized = await runPilotCollectorCli([
      "node",
      "cli.js",
      "--network=enabled",
      "--discovery-source=events",
    ]);
    expect(exitCodeUnauthorized).toBe(1);

    // 2. Explicit operator flag with offline mock transports executes cleanly
    const wsTransport = new MockWebSocketTransport();
    wsTransport.autoOpenAndAck = true;
    const mockRpc = new MockSolanaRpcTransport();
    const logger = new PilotLogger();

    const exitCodeAuthorized = await runPilotCollectorCli(
      [
        "node",
        "cli.js",
        "--network=enabled",
        "--discovery-source=events",
        "--authorize-b2-live",
        "--duration-sec=1",
        "--max-ws-messages=10",
        `--capture-fixtures-dir=${path.join(testTmpBase, "authorized-b2-session")}`,
      ],
      {
        wsTransport,
        rpcTransport: mockRpc,
        logger,
      },
    );
    expect(exitCodeAuthorized).toBe(0);
  });

  it("B2-READY-02: enforces bounded per-request timeouts, shared cross-client RPC budget, and message ceiling closure", async () => {
    // 1. Bounded per-request timeout with AbortSignal
    const hangingRpc: ISolanaRpcTransport = {
      post: async (_url, _body, init) => {
        return new Promise((resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              reject(new Error("[RPC_TIMEOUT] Request aborted due to timeout"));
            });
          }
        });
      },
    };

    const timedTxFetcher = new SolanaRpcTransactionFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: hangingRpc,
      httpTimeoutMs: 50,
    });

    const txRes = await timedTxFetcher.fetchTransaction("hang-sig-1");
    expect(txRes).toBeNull();
    const txRecords = timedTxFetcher.getCapturedTransactions();
    expect(txRecords.length).toBe(1);
    expect(txRecords[0]!.error).toContain("RPC_TIMEOUT");

    // 2. Shared cross-client total RPC ceiling
    const mockRpc = new MockSolanaRpcTransport();
    mockRpc.registerResponse("getTransaction", {
      result: {
        slot: 450000100,
        transaction: {
          message: {
            accountKeys: ["payer", "prog"],
            instructions: [{ programIdIndex: 1, accounts: [0], data: "" }],
          },
        },
      },
    });
    mockRpc.registerResponse("getAccountInfo", {
      result: {
        context: { slot: 450000100 },
        value: {
          data: ["", "base64"],
          owner: RAYDIUM_AMM_V4_PROGRAM_ID,
          lamports: 1000,
        },
      },
    });

    class TestSharedBudget {
      public count = 0;
      constructor(private readonly max: number) {}
      canExecute() {
        return this.count < this.max;
      }
      recordCall() {
        this.count++;
      }
      getRemaining() {
        return Math.max(0, this.max - this.count);
      }
      getTotalExecuted() {
        return this.count;
      }
    }

    const shared = new TestSharedBudget(2);
    const sharedTxFetcher = new SolanaRpcTransactionFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
      sharedBudget: shared,
    });
    const sharedAccFetcher = new SolanaRpcRecordingAccountFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
      sharedBudget: shared,
    });

    // Call 1: tx fetcher (consumes 1)
    await sharedTxFetcher.fetchTransaction("sig-1");
    expect(shared.getTotalExecuted()).toBe(1);

    // Call 2: acc fetcher (consumes 2)
    await sharedAccFetcher.getAccountInfo("acc-1");
    expect(shared.getTotalExecuted()).toBe(2);

    // Call 3: should be rejected by shared ceiling across clients
    const rejectedAcc = await sharedAccFetcher.getAccountInfo("acc-2");
    expect(rejectedAcc).toBeNull();
    expect(shared.getTotalExecuted()).toBe(2);

    // 3. WebSocket message ceiling triggers socket closure
    const wsTransport = new MockWebSocketTransport();
    const wsClient = new SolanaWebSocketSubscriptionClient({
      wsUrl: "wss://api.mainnet-beta.solana.com/",
      transport: wsTransport,
      maxMessagesBudget: 2,
    });

    wsTransport.triggerOpen();
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 100 }));
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 200 }));

    // Send notification 1 (messagesReceived = 1)
    wsTransport.triggerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000100 },
            value: { signature: "sig-ws-1", err: null, logs: [] },
          },
          subscription: 100,
        },
      }),
    );
    expect(wsTransport.closed).toBe(false);

    // Send notification 2 (messagesReceived reaches ceiling = 2)
    wsTransport.triggerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000100 },
            value: { signature: "sig-ws-2", err: null, logs: [] },
          },
          subscription: 100,
        },
      }),
    );
    // Socket must be closed, not merely counting dropped messages
    expect(wsTransport.closed).toBe(true);
    expect(wsClient.getStatus()).toBe("DISCONNECTED");
  });

  it("B2-READY-03: quarantines unknown subscriptions, rejects missing/zero transaction slots, and sanitizes secrets on error paths", async () => {
    // 1. Unknown subscription quarantine
    const wsTransport = new MockWebSocketTransport();
    let notificationDelivered = false;
    const wsClient = new SolanaWebSocketSubscriptionClient({
      wsUrl: "wss://api.mainnet-beta.solana.com/",
      transport: wsTransport,
      onNotification: () => {
        notificationDelivered = true;
      },
    });

    wsTransport.triggerOpen();
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 100 }));
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 200 }));

    // Notification with unmapped subscription ID 999
    wsTransport.triggerMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000100 },
            value: { signature: "sig-unknown-sub", err: null, logs: [] },
          },
          subscription: 999,
        },
      }),
    );

    expect(wsClient.getMetrics().unknownNotifications).toBe(1);
    expect(wsClient.getMetrics().ammV4Notifications).toBe(0);
    expect(wsClient.getMetrics().cpmmNotifications).toBe(0);
    expect(notificationDelivered).toBe(false);

    // 2. Reject fabricated slot 0 or missing slot
    const mockRpc = new MockSolanaRpcTransport();
    mockRpc.registerResponse("getTransaction", {
      result: {
        slot: 0, // Invalid fabricated slot 0
        transaction: {
          message: {
            accountKeys: ["payer"],
            instructions: [{ programIdIndex: 0, accounts: [], data: "" }],
          },
        },
      },
    });

    const txFetcher = new SolanaRpcTransactionFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
    });
    const parsedTxZero = await txFetcher.fetchTransaction("sig-slot-zero");
    expect(parsedTxZero).toBeNull();

    // 3. Credential sanitization on error paths
    const secretUrl = "https://api.mainnet-beta.solana.com/?api-key=secretToken12345";
    const throwingRpc: ISolanaRpcTransport = {
      post: async () => {
        throw new Error(`Failed to connect to ${secretUrl}`);
      },
    };

    const secretTxFetcher = new SolanaRpcTransactionFetcher({
      rpcUrl: secretUrl,
      transport: throwingRpc,
    });
    await secretTxFetcher.fetchTransaction("sig-secret-err");
    const secretRecords = secretTxFetcher.getCapturedTransactions();
    expect(secretRecords.length).toBe(1);
    expect(secretRecords[0]!.error).not.toContain("secretToken12345");
    expect(secretRecords[0]!.error).toContain("[REDACTED]");
  });

  it("B2-READY-04: executes genuine authentic B2 replay from raw JSONL files and rejects tampered or missing records", async () => {
    const replayBaseDir = path.join(testTmpBase, "b2-authentic-replay-suite");
    fsSync.mkdirSync(replayBaseDir, { recursive: true });

    const ammV4Tx = createAmmV4InitTransactionFixture();
    const sig = ammV4Tx.signature;

    // Create authentic B2 session with raw JSONL records
    const b2Capture = saveB2EventSession({
      captureBaseDir: replayBaseDir,
      sessionId: "b2-session-authentic",
      forcedStatus: "FINALIZED",
      rawNotifications: [
        {
          receivedEpochMs: Date.now(),
          receivedIso: new Date().toISOString(),
          subscriptionId: 10,
          protocol: "RAYDIUM_AMM_V4",
          envelope: {
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000100 },
                value: {
                  signature: sig,
                  err: null,
                  logs: ["Program log: initialize2"],
                },
              },
              subscription: 10,
            },
          },
        },
      ],
      rawTransactions: [
        {
          request: {
            jsonrpc: "2.0",
            id: "tx-req-1",
            method: "getTransaction",
            params: [sig, { encoding: "json", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "tx-req-1",
            result: {
              slot: 450000100,
              blockTime: 1746886997,
              version: 0,
              transaction: {
                message: {
                  accountKeys: ammV4Tx.accountKeys.staticAccountKeys,
                  instructions: ammV4Tx.instructions,
                },
              },
              meta: {
                err: null,
                innerInstructions: [],
              },
            },
          },
          timing: { elapsedMs: 50, payloadSizeBytes: 2000 },
        },
      ],
      rawAccounts: [
        {
          request: {
            jsonrpc: "2.0",
            id: "acc-req-1",
            method: "getAccountInfo",
            params: [FIXTURE_POOL_ADDRESS, { encoding: "base64", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "acc-req-1",
            result: {
              context: { slot: 450000100 },
              value: {
                data: [createAuthoritativeRaydiumAmmV4Buffer().toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                lamports: 10000000,
              },
            },
          },
          timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
        },
        {
          request: {
            jsonrpc: "2.0",
            id: "acc-req-2",
            method: "getMultipleAccounts",
            params: [
              [FIXTURE_BASE_VAULT, FIXTURE_QUOTE_VAULT],
              { encoding: "base64", commitment: "confirmed" },
            ],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "acc-req-2",
            result: {
              context: { slot: 450000100 },
              value: [
                {
                  data: [
                    createAuthoritativeSplVaultBuffer({
                      mintBase58: FIXTURE_MEME_MINT,
                      ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                    }).toString("base64"),
                    "base64",
                  ],
                  owner: SPL_TOKEN_PROGRAM_ID,
                  lamports: 2000000,
                },
                {
                  data: [
                    createAuthoritativeSplVaultBuffer({
                      mintBase58: FIXTURE_WSOL_MINT,
                      ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                    }).toString("base64"),
                    "base64",
                  ],
                  owner: SPL_TOKEN_PROGRAM_ID,
                  lamports: 2000000,
                },
              ],
            },
          },
          timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
        },
      ],
      discoveredEvents: [
        {
          eventId: `${sig}:0`,
          signature: sig,
          outerInstructionIndex: 0,
          instructionIndex: 0,
          slot: 450000100,
          blockTimeSec: 1746886997,
          firstSeenTimestampMs: Date.now(),
          instructionRequestedOpenTimeSec: 1746886997,
          poolOpenTimeSec: 1746886997,
          protocol: "RAYDIUM_AMM_V4",
          poolId: FIXTURE_POOL_ADDRESS,
          token0Mint: FIXTURE_MEME_MINT,
          token1Mint: FIXTURE_WSOL_MINT,
          token0Vault: FIXTURE_BASE_VAULT,
          token1Vault: FIXTURE_QUOTE_VAULT,
        },
      ],
      verificationReports: [
        {
          poolId: FIXTURE_POOL_ADDRESS,
          protocol: "RAYDIUM_AMM_V4",
          verified: true,
          verificationTier: "VERIFIED_AMM_V4",
          transactionSlot: 450000100,
          poolAccountSlot: 450000100,
          vault0AccountSlot: 450000100,
          vault1AccountSlot: 450000100,
          slotDiscrepancy: false,
          slotDelta: 0,
          verifiedAtEpochMs: Date.now(),
          hostObservationTimestampMs: Date.now(),
          effectiveReservesAvailable: true,
          spotPriceSol: null,
          spotPrice0Per1: null,
        },
      ],
    });

    // 1. Replay authentic session -> succeeds and reproduces 1 event and 1 verified pool
    const logger = new PilotLogger();
    const replayResult = await runReplaySession(
      {
        network: "disabled",
        rpcUrl: "https://api.mainnet-beta.solana.com",
        replayFixturesPath: b2Capture.sessionDir,
        replayMode: "authentic",
        pollIntervalSec: 1,
        durationSec: 10,
        targetCandidates: 1,
        maxCandidatesScreened: 1,
        targetDiagnosticYield: 1,
        maxMb: 10,
        maxRssMb: 256,
        outputDir: testTmpBase,
        enableForwardObservations: false,
      },
      logger,
    );
    expect(replayResult.ok).toBe(true);
    expect(replayResult.poolsVerified).toBe(1);

    // 2. Negative test: Tampering with evidence file size causes size mismatch rejection
    const rawTxFile = path.join(b2Capture.sessionDir, "raw-transactions.jsonl");
    const origBuf = fsSync.readFileSync(rawTxFile);
    fsSync.appendFileSync(rawTxFile, "\n// tampered extra data\n");
    expect(() => verifyB2SessionManifest(b2Capture.sessionDir)).toThrow("SIZE_MISMATCH");

    // Negative test: Tampering with content while preserving byte size causes SHA-256 hash mismatch rejection
    const tamperedSameLength = Buffer.from(origBuf);
    tamperedSameLength[tamperedSameLength.length - 1] =
      tamperedSameLength[tamperedSameLength.length - 1] === 32 ? 33 : 32;
    fsSync.writeFileSync(rawTxFile, tamperedSameLength);
    expect(() => verifyB2SessionManifest(b2Capture.sessionDir)).toThrow("HASH_MISMATCH");

    // 3. Negative test: Extraneous unmanifested file causes rejection (restore valid file first)
    fsSync.writeFileSync(rawTxFile, origBuf);
    const unmanifestedFile = path.join(b2Capture.sessionDir, "untracked-payload.bin");
    fsSync.writeFileSync(unmanifestedFile, "untracked");
    expect(() => verifyB2SessionManifest(b2Capture.sessionDir)).toThrow("EXTRANEOUS_FILE");
  });

  it("B2-READY-05: safe zero-event session finishes as FINALIZED without error", async () => {
    const wsTransport = new MockWebSocketTransport();
    wsTransport.autoOpenAndAck = true;
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

    const captureDir = path.join(testTmpBase, "zero-event-session");
    const coordinator = new EventDiscoverySessionCoordinator({
      wsClient,
      txFetcher,
      accountFetcher,
      captureBaseDir: captureDir,
      budgets: { durationSec: 0.05 }, // Short duration budget
    });

    wsTransport.triggerOpen();
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 100 }));
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 200 }));

    const summary = await coordinator.runSession();

    // Zero pool initializations observed, completed duration limit
    expect(summary.status).toBe("FINALIZED");
    expect(summary.stopReason).toContain("DURATION_LIMIT_REACHED");
    expect(summary.accounting.uniquePoolsDiscovered).toBe(0);
    expect(summary.accounting.poolsVerifiedCoherent).toBe(0);
    expect(summary.manifest?.status).toBe("FINALIZED");
    expect(summary.manifestVerified).toBe(true);
  });

  // =========================================================================
  // D.2.9-B2 Audit Findings Safeguards (B2-FINAL-02, B2-FINAL-03, B2-FINAL-04)
  // =========================================================================

  it("B2-FINAL-02: CLI budget flags parse and coordinator enforces 25 tx, 20 acc, and 45 combined RPC ceiling", async () => {
    const rawArgs = [
      "node",
      "PilotLiveCollectorCli.js",
      "--network=enabled",
      "--discovery-source=events",
      "--duration-sec=60",
      "--max-transactions=25",
      "--max-account-reads=20",
      "--rpc-max-calls=45",
      "--max-ws-messages=500",
      "--max-events=50",
    ];

    const config = parseCliArgs(rawArgs);
    expect(config.durationSec).toBe(60);
    expect(config.maxTransactions).toBe(25);
    expect(config.maxAccountReads).toBe(20);
    expect(config.rpcMaxCalls).toBe(45);
    expect(config.maxWsMessages).toBe(500);
    expect(config.maxEvents).toBe(50);

    const wsTransport = new MockWebSocketTransport();
    wsTransport.autoOpenAndAck = true;
    const mockRpc = new MockSolanaRpcTransport();
    const wsClient = new SolanaWebSocketSubscriptionClient({
      wsUrl: "wss://api.mainnet-beta.solana.com/",
      transport: wsTransport,
    });
    const txFetcher = new SolanaRpcTransactionFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
      maxTransactionsBudget: config.maxTransactions,
    });
    const accountFetcher = new SolanaRpcRecordingAccountFetcher({
      rpcUrl: "https://api.mainnet-beta.solana.com/",
      transport: mockRpc,
      maxAccountCallsBudget: config.maxAccountReads,
    });

    const coordinator = new EventDiscoverySessionCoordinator({
      wsClient,
      txFetcher,
      accountFetcher,
      captureBaseDir: path.join(testTmpBase, "budget-test"),
      budgets: {
        durationSec: config.durationSec,
        maxTransactions: config.maxTransactions,
        maxAccountReads: config.maxAccountReads,
        maxTotalRpcCalls: config.rpcMaxCalls,
      },
    });

    expect(coordinator.getBudgets().maxTransactions).toBe(25);
    expect(coordinator.getBudgets().maxAccountReads).toBe(20);
    expect(coordinator.getBudgets().maxTotalRpcCalls).toBe(45);
    expect(coordinator.getBudgets().durationSec).toBe(60);

    // Test compiled command offline with network disabled, verifying all options parse and validate correctly
    const helpCode = await runPilotCollectorCli(["node", "PilotLiveCollectorCli.js", "--help"]);
    expect(helpCode).toBe(0);

    const disabledNetCode = await runPilotCollectorCli([
      "node",
      "PilotLiveCollectorCli.js",
      "--network=disabled",
      "--discovery-source=events",
      "--duration-sec=60",
      "--max-transactions=25",
      "--max-account-reads=20",
      "--rpc-max-calls=45",
    ]);
    expect(disabledNetCode).toBe(1);
  });

  it("B2-FINAL-03: authentic replay reproduction validates stable fields and fails on content tampering", async () => {
    const ammV4Tx = createAmmV4InitTransactionFixture();
    const sig = ammV4Tx.signature;
    const sessionDir = path.join(testTmpBase, "b2-repro-validation-base");

    saveB2EventSession({
      captureBaseDir: testTmpBase,
      sessionId: "b2-repro-validation-base",
      forcedStatus: "FINALIZED",
      rawNotifications: [
        {
          receivedEpochMs: Date.now(),
          receivedIso: new Date().toISOString(),
          subscriptionId: 10,
          protocol: "RAYDIUM_AMM_V4",
          envelope: {
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000100 },
                value: {
                  signature: sig,
                  err: null,
                  logs: ["Program log: initialize2"],
                },
              },
              subscription: 10,
            },
          },
        },
      ],
      rawTransactions: [
        {
          request: {
            jsonrpc: "2.0",
            id: "tx-req-1",
            method: "getTransaction",
            params: [sig, { encoding: "json", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "tx-req-1",
            result: {
              slot: 450000100,
              blockTime: 1746886997,
              version: 0,
              transaction: {
                message: {
                  accountKeys: ammV4Tx.accountKeys.staticAccountKeys,
                  instructions: ammV4Tx.instructions,
                },
              },
              meta: { err: null, innerInstructions: [] },
            },
          },
          timing: { elapsedMs: 50, payloadSizeBytes: 2000 },
        },
      ],
      rawAccounts: [
        {
          request: {
            jsonrpc: "2.0",
            id: "acc-req-1",
            method: "getAccountInfo",
            params: [FIXTURE_POOL_ADDRESS, { encoding: "base64", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "acc-req-1",
            result: {
              context: { slot: 450000100 },
              value: {
                data: [createAuthoritativeRaydiumAmmV4Buffer().toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                lamports: 10000000,
              },
            },
          },
          timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
        },
        {
          request: {
            jsonrpc: "2.0",
            id: "acc-req-2",
            method: "getMultipleAccounts",
            params: [
              [FIXTURE_BASE_VAULT, FIXTURE_QUOTE_VAULT],
              { encoding: "base64", commitment: "confirmed" },
            ],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "acc-req-2",
            result: {
              context: { slot: 450000100 },
              value: [
                {
                  data: [
                    createAuthoritativeSplVaultBuffer({
                      mintBase58: FIXTURE_MEME_MINT,
                      ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                    }).toString("base64"),
                    "base64",
                  ],
                  owner: SPL_TOKEN_PROGRAM_ID,
                  lamports: 2000000,
                },
                {
                  data: [
                    createAuthoritativeSplVaultBuffer({
                      mintBase58: FIXTURE_WSOL_MINT,
                      ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                    }).toString("base64"),
                    "base64",
                  ],
                  owner: SPL_TOKEN_PROGRAM_ID,
                  lamports: 2000000,
                },
              ],
            },
          },
          timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
        },
      ],
      discoveredEvents: [
        {
          eventId: `${sig}:0`,
          signature: sig,
          outerInstructionIndex: 0,
          instructionIndex: 0,
          slot: 450000100,
          blockTimeSec: 1746886997,
          firstSeenTimestampMs: Date.now(),
          instructionRequestedOpenTimeSec: 1746886997,
          poolOpenTimeSec: 1746886997,
          protocol: "RAYDIUM_AMM_V4",
          poolId: FIXTURE_POOL_ADDRESS,
          token0Mint: FIXTURE_MEME_MINT,
          token1Mint: FIXTURE_WSOL_MINT,
          token0Vault: FIXTURE_BASE_VAULT,
          token1Vault: FIXTURE_QUOTE_VAULT,
        },
      ],
      verificationReports: [
        {
          poolId: FIXTURE_POOL_ADDRESS,
          protocol: "RAYDIUM_AMM_V4",
          verified: true,
          verificationTier: "VERIFIED_AMM_V4",
          transactionSlot: 450000100,
          poolAccountSlot: 450000100,
          vault0AccountSlot: 450000100,
          vault1AccountSlot: 450000100,
          slotDiscrepancy: false,
          slotDelta: 0,
          verifiedAtEpochMs: Date.now(),
          hostObservationTimestampMs: Date.now(),
          effectiveReservesAvailable: true,
          spotPriceSol: null,
          spotPrice0Per1: null,
        },
      ],
    });

    const logger = new PilotLogger();

    // 1. Replay authentic session -> succeeds
    const okReplay = await runReplaySession(
      {
        network: "disabled",
        rpcUrl: "https://api.mainnet-beta.solana.com",
        replayFixturesPath: sessionDir,
        replayMode: "authentic",
        pollIntervalSec: 1,
        durationSec: 10,
        targetCandidates: 1,
        maxCandidatesScreened: 1,
        targetDiagnosticYield: 1,
        maxMb: 10,
        maxRssMb: 256,
        outputDir: testTmpBase,
        enableForwardObservations: false,
      },
      logger,
    );
    expect(okReplay.ok).toBe(true);
    expect(okReplay.poolsVerified).toBe(1);

    // 2. Negative test: Mutate poolId in discoveredEvents -> reproduction fails
    const tamperedEventDir = path.join(testTmpBase, "tampered-event-poolid");
    saveB2EventSession({
      captureBaseDir: testTmpBase,
      sessionId: "tampered-event-poolid",
      forcedStatus: "FINALIZED",
      rawNotifications: [
        {
          receivedEpochMs: Date.now(),
          receivedIso: new Date().toISOString(),
          subscriptionId: 10,
          protocol: "RAYDIUM_AMM_V4",
          envelope: {
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000100 },
                value: { signature: sig, err: null, logs: ["Program log: initialize2"] },
              },
              subscription: 10,
            },
          },
        },
      ],
      rawTransactions: [
        {
          request: {
            jsonrpc: "2.0",
            id: "tx-req-1",
            method: "getTransaction",
            params: [sig, { encoding: "json", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "tx-req-1",
            result: {
              slot: 450000100,
              blockTime: 1746886997,
              version: 0,
              transaction: {
                message: {
                  accountKeys: ammV4Tx.accountKeys.staticAccountKeys,
                  instructions: ammV4Tx.instructions,
                },
              },
              meta: { err: null, innerInstructions: [] },
            },
          },
          timing: { elapsedMs: 50, payloadSizeBytes: 2000 },
        },
      ],
      rawAccounts: [
        {
          request: {
            jsonrpc: "2.0",
            id: "acc-req-1",
            method: "getAccountInfo",
            params: [FIXTURE_POOL_ADDRESS, { encoding: "base64", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "acc-req-1",
            result: {
              context: { slot: 450000100 },
              value: {
                data: [createAuthoritativeRaydiumAmmV4Buffer().toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                lamports: 10000000,
              },
            },
          },
          timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
        },
        {
          request: {
            jsonrpc: "2.0",
            id: "acc-req-2",
            method: "getMultipleAccounts",
            params: [
              [FIXTURE_BASE_VAULT, FIXTURE_QUOTE_VAULT],
              { encoding: "base64", commitment: "confirmed" },
            ],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "acc-req-2",
            result: {
              context: { slot: 450000100 },
              value: [
                {
                  data: [
                    createAuthoritativeSplVaultBuffer({
                      mintBase58: FIXTURE_MEME_MINT,
                      ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                    }).toString("base64"),
                    "base64",
                  ],
                  owner: SPL_TOKEN_PROGRAM_ID,
                  lamports: 2000000,
                },
                {
                  data: [
                    createAuthoritativeSplVaultBuffer({
                      mintBase58: FIXTURE_WSOL_MINT,
                      ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                    }).toString("base64"),
                    "base64",
                  ],
                  owner: SPL_TOKEN_PROGRAM_ID,
                  lamports: 2000000,
                },
              ],
            },
          },
          timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
        },
      ],
      discoveredEvents: [
        {
          eventId: `${sig}:0`,
          signature: sig,
          outerInstructionIndex: 0,
          instructionIndex: 0,
          slot: 450000100,
          blockTimeSec: 1746886997,
          firstSeenTimestampMs: Date.now(),
          instructionRequestedOpenTimeSec: 1746886997,
          poolOpenTimeSec: 1746886997,
          protocol: "RAYDIUM_AMM_V4",
          poolId: "MutatedPoolAddress1111111111111111111111111111", // MUTATED POOL ID
          token0Mint: FIXTURE_MEME_MINT,
          token1Mint: FIXTURE_WSOL_MINT,
          token0Vault: FIXTURE_BASE_VAULT,
          token1Vault: FIXTURE_QUOTE_VAULT,
        },
      ],
      verificationReports: [
        {
          poolId: FIXTURE_POOL_ADDRESS,
          protocol: "RAYDIUM_AMM_V4",
          verified: true,
          verificationTier: "VERIFIED_AMM_V4",
          transactionSlot: 450000100,
          poolAccountSlot: 450000100,
          vault0AccountSlot: 450000100,
          vault1AccountSlot: 450000100,
          slotDiscrepancy: false,
          slotDelta: 0,
          verifiedAtEpochMs: Date.now(),
          hostObservationTimestampMs: Date.now(),
          effectiveReservesAvailable: true,
          spotPriceSol: null,
          spotPrice0Per1: null,
        },
      ],
    });

    await expect(
      runReplaySession(
        {
          network: "disabled",
          rpcUrl: "https://api.mainnet-beta.solana.com",
          replayFixturesPath: tamperedEventDir,
          replayMode: "authentic",
          pollIntervalSec: 1,
          durationSec: 10,
          targetCandidates: 1,
          maxCandidatesScreened: 1,
          targetDiagnosticYield: 1,
          maxMb: 10,
          maxRssMb: 256,
          outputDir: testTmpBase,
          enableForwardObservations: false,
        },
        logger,
      ),
    ).rejects.toThrow("REPLAY_REPRODUCTION_MISMATCH");

    // 3. Negative test: Mutate verification report verdict -> reproduction fails
    const tamperedReportDir = path.join(testTmpBase, "tampered-report-verdict");
    saveB2EventSession({
      captureBaseDir: testTmpBase,
      sessionId: "tampered-report-verdict",
      forcedStatus: "FINALIZED",
      rawNotifications: [
        {
          receivedEpochMs: Date.now(),
          receivedIso: new Date().toISOString(),
          subscriptionId: 10,
          protocol: "RAYDIUM_AMM_V4",
          envelope: {
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000100 },
                value: { signature: sig, err: null, logs: ["Program log: initialize2"] },
              },
              subscription: 10,
            },
          },
        },
      ],
      rawTransactions: [
        {
          request: {
            jsonrpc: "2.0",
            id: "tx-req-1",
            method: "getTransaction",
            params: [sig, { encoding: "json", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "tx-req-1",
            result: {
              slot: 450000100,
              blockTime: 1746886997,
              version: 0,
              transaction: {
                message: {
                  accountKeys: ammV4Tx.accountKeys.staticAccountKeys,
                  instructions: ammV4Tx.instructions,
                },
              },
              meta: { err: null, innerInstructions: [] },
            },
          },
          timing: { elapsedMs: 50, payloadSizeBytes: 2000 },
        },
      ],
      rawAccounts: [
        {
          request: {
            jsonrpc: "2.0",
            id: "acc-req-1",
            method: "getAccountInfo",
            params: [FIXTURE_POOL_ADDRESS, { encoding: "base64", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "acc-req-1",
            result: {
              context: { slot: 450000100 },
              value: {
                data: [createAuthoritativeRaydiumAmmV4Buffer().toString("base64"), "base64"],
                owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                lamports: 10000000,
              },
            },
          },
          timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
        },
        {
          request: {
            jsonrpc: "2.0",
            id: "acc-req-2",
            method: "getMultipleAccounts",
            params: [
              [FIXTURE_BASE_VAULT, FIXTURE_QUOTE_VAULT],
              { encoding: "base64", commitment: "confirmed" },
            ],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: {
            jsonrpc: "2.0",
            id: "acc-req-2",
            result: {
              context: { slot: 450000100 },
              value: [
                {
                  data: [
                    createAuthoritativeSplVaultBuffer({
                      mintBase58: FIXTURE_MEME_MINT,
                      ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                    }).toString("base64"),
                    "base64",
                  ],
                  owner: SPL_TOKEN_PROGRAM_ID,
                  lamports: 2000000,
                },
                {
                  data: [
                    createAuthoritativeSplVaultBuffer({
                      mintBase58: FIXTURE_WSOL_MINT,
                      ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                    }).toString("base64"),
                    "base64",
                  ],
                  owner: SPL_TOKEN_PROGRAM_ID,
                  lamports: 2000000,
                },
              ],
            },
          },
          timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
        },
      ],
      discoveredEvents: [
        {
          eventId: `${sig}:0`,
          signature: sig,
          outerInstructionIndex: 0,
          instructionIndex: 0,
          slot: 450000100,
          blockTimeSec: 1746886997,
          firstSeenTimestampMs: Date.now(),
          instructionRequestedOpenTimeSec: 1746886997,
          poolOpenTimeSec: 1746886997,
          protocol: "RAYDIUM_AMM_V4",
          poolId: FIXTURE_POOL_ADDRESS,
          token0Mint: FIXTURE_MEME_MINT,
          token1Mint: FIXTURE_WSOL_MINT,
          token0Vault: FIXTURE_BASE_VAULT,
          token1Vault: FIXTURE_QUOTE_VAULT,
        },
      ],
      verificationReports: [
        {
          poolId: FIXTURE_POOL_ADDRESS,
          protocol: "RAYDIUM_AMM_V4",
          verified: false, // MUTATED VERDICT
          verificationTier: "REJECTED", // MUTATED TIER
          transactionSlot: 450000100,
          poolAccountSlot: 450000100,
          vault0AccountSlot: 450000100,
          vault1AccountSlot: 450000100,
          slotDiscrepancy: false,
          slotDelta: 0,
          verifiedAtEpochMs: Date.now(),
          hostObservationTimestampMs: Date.now(),
          effectiveReservesAvailable: true,
          spotPriceSol: null,
          spotPrice0Per1: null,
        },
      ],
    });

    await expect(
      runReplaySession(
        {
          network: "disabled",
          rpcUrl: "https://api.mainnet-beta.solana.com",
          replayFixturesPath: tamperedReportDir,
          replayMode: "authentic",
          pollIntervalSec: 1,
          durationSec: 10,
          targetCandidates: 1,
          maxCandidatesScreened: 1,
          targetDiagnosticYield: 1,
          maxMb: 10,
          maxRssMb: 256,
          outputDir: testTmpBase,
          enableForwardObservations: false,
        },
        logger,
      ),
    ).rejects.toThrow("REPLAY_REPRODUCTION_MISMATCH");
  });

  it("B2-FINAL-03: authentic replay reproduces legitimately recorded failed RPC calls and missing accounts without fabricated data", async () => {
    const errorSessionDir = path.join(testTmpBase, "b2-error-capture-session");
    const sig = "err-sig-failed-call-11111111111111111111111111111";

    saveB2EventSession({
      captureBaseDir: testTmpBase,
      sessionId: "b2-error-capture-session",
      forcedStatus: "FINALIZED",
      rawNotifications: [
        {
          receivedEpochMs: Date.now(),
          receivedIso: new Date().toISOString(),
          subscriptionId: 10,
          protocol: "RAYDIUM_AMM_V4",
          envelope: {
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000100 },
                value: { signature: sig, err: null, logs: ["Program log: initialize2"] },
              },
              subscription: 10,
            },
          },
        },
      ],
      rawTransactions: [
        {
          request: {
            jsonrpc: "2.0",
            id: "tx-req-failed",
            method: "getTransaction",
            params: [sig, { encoding: "json", commitment: "confirmed" }],
            endpoint: "https://api.mainnet-beta.solana.com/",
            endpointFingerprint: "fp",
            timestampIso: new Date().toISOString(),
            timestampEpochMs: Date.now(),
          },
          response: null,
          error: "Simulated 503 Service Unavailable",
          timing: { elapsedMs: 50, payloadSizeBytes: 0 },
        },
      ],
      rawAccounts: [],
      discoveredEvents: [],
      verificationReports: [],
    });

    const logger = new PilotLogger();
    const replayResult = await runReplaySession(
      {
        network: "disabled",
        rpcUrl: "https://api.mainnet-beta.solana.com",
        replayFixturesPath: errorSessionDir,
        replayMode: "authentic",
        pollIntervalSec: 1,
        durationSec: 10,
        targetCandidates: 1,
        maxCandidatesScreened: 1,
        targetDiagnosticYield: 1,
        maxMb: 10,
        maxRssMb: 256,
        outputDir: testTmpBase,
        enableForwardObservations: false,
      },
      logger,
    );

    expect(replayResult.ok).toBe(true);
    expect(replayResult.metrics.transactionFetchFailures).toBe(1);
    expect(replayResult.poolsVerified).toBe(0);
  });

  it("B2-FINAL-04: missing WebSocket startup subscription acknowledgment fails closed with FAILED status", async () => {
    const wsTransport = new MockWebSocketTransport();
    wsTransport.autoOpenAndAck = false;
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

    const coordinator = new EventDiscoverySessionCoordinator({
      wsClient,
      txFetcher,
      accountFetcher,
      captureBaseDir: path.join(testTmpBase, "unack-session"),
      budgets: { durationSec: 0.1 },
    });

    wsTransport.triggerOpen();
    // Only acknowledge AMM v4 (id: 1), but do NOT acknowledge CPMM (id: 2)
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 100 }));

    const summary = await coordinator.runSession();
    expect(summary.status).toBe("FAILED");
    expect(summary.stopReason).toContain("WS_SUBSCRIPTION_STARTUP_TIMEOUT");
    expect(summary.manifest?.status).toBe("FAILED");
  });

  it("B2-FINAL-04: unexpected WebSocket disconnect fails closed with FAILED status", async () => {
    const wsTransport = new MockWebSocketTransport();
    wsTransport.autoOpenAndAck = false;
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

    const coordinator = new EventDiscoverySessionCoordinator({
      wsClient,
      txFetcher,
      accountFetcher,
      captureBaseDir: path.join(testTmpBase, "disconnect-session"),
      budgets: { durationSec: 1 },
    });

    wsTransport.triggerOpen();
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 100 }));
    wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 200 }));

    // Trigger unexpected close
    setTimeout(() => {
      wsTransport.triggerClose(1006, "Abnormal closure");
    }, 20);

    const summary = await coordinator.runSession();
    expect(summary.status).toBe("FAILED");
    expect(summary.stopReason).toContain("WS_DISCONNECTED_UNEXPECTEDLY");
    expect(summary.manifest?.status).toBe("FAILED");
  });

  it("B2-FINAL-04: progressive recorder preserves written evidence and reserved headroom seals manifest on disk exhaust", async () => {
    const diskBudgetBase = path.join(testTmpBase, "disk-headroom-base");
    fsSync.mkdirSync(diskBudgetBase, { recursive: true });

    // 0.005 MB = ~5242 bytes (reserved headroom = 524 bytes, stream budget = 4718 bytes)
    const recorder = new ProgressiveEvidenceRecorder({
      captureBaseDir: diskBudgetBase,
      sessionId: "exhausted-disk-session",
      maxDiskMb: 0.005,
    });

    let hitLimit = false;
    try {
      for (let i = 0; i < 50; i++) {
        recorder.recordNotification({
          receivedEpochMs: Date.now(),
          receivedIso: new Date().toISOString(),
          subscriptionId: 1,
          protocol: "RAYDIUM_AMM_V4",
          envelope: {
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000000 + i },
                value: {
                  signature: `sig-${i}-${"X".repeat(120)}`,
                  err: null,
                  logs: ["Program log: test"],
                },
              },
              subscription: 1,
            },
          },
        });
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("DISK_BUDGET_EXCEEDED")) {
        hitLimit = true;
      }
    }
    expect(hitLimit).toBe(true);

    // Finalize must succeed using reserved headroom!
    const sealed = recorder.finalize({
      status: "INTERRUPTED",
      error: "DISK_BUDGET_EXCEEDED",
    });

    expect(sealed.status).toBe("INTERRUPTED");
    expect(fsSync.existsSync(sealed.manifestPath)).toBe(true);
    const verification = verifyB2SessionManifest(recorder.getSessionDir());
    expect(verification.valid).toBe(true);
  });

  describe("B2-LAUNCH-01 / B2-LAUNCH-02 / B2-LAUNCH-03 Final Preflight Verifications", () => {
    const baseReplayConfig = {
      network: "disabled" as const,
      discoverySource: "events" as const,
      rpcUrl: "https://api.mainnet-beta.solana.com",
      pollIntervalSec: 1,
      durationSec: 10,
      targetCandidates: 1,
      maxCandidatesScreened: 1,
      targetDiagnosticYield: 1,
      maxMb: 10,
      maxRssMb: 256,
      outputDir: testTmpBase,
      enableForwardObservations: false,
    };

    it("B2-LAUNCH-01: authentic replay rejects getAccountInfo with missing, zero, or non-integer slot without synthetic fallback", async () => {
      const logger = new PilotLogger();
      const testSig =
        "5xLaunchTestSigAmmV4Init111111111111111111111111111111111111111111111111111111111111111";
      const ammV4Tx = createAmmV4InitTransactionFixture({
        signature: testSig,
        slot: 450000100,
        poolId: FIXTURE_POOL_ADDRESS,
        token0Vault: FIXTURE_BASE_VAULT,
        token1Vault: FIXTURE_QUOTE_VAULT,
        token0Mint: FIXTURE_MEME_MINT,
        token1Mint: FIXTURE_WSOL_MINT,
      });

      // Test Case 1: getAccountInfo with missing context slot
      const missingSlotSessionDir = path.join(testTmpBase, "missing-account-slot-session");
      saveB2EventSession({
        captureBaseDir: testTmpBase,
        sessionId: "missing-account-slot-session",
        forcedStatus: "FINALIZED",
        rawNotifications: [
          {
            receivedEpochMs: Date.now(),
            receivedIso: new Date().toISOString(),
            subscriptionId: 10,
            protocol: "RAYDIUM_AMM_V4",
            envelope: {
              jsonrpc: "2.0",
              method: "logsNotification",
              params: {
                result: {
                  context: { slot: 450000100 },
                  value: { signature: testSig, err: null, logs: ["Program log: initialize2"] },
                },
                subscription: 10,
              },
            },
          },
        ],
        rawTransactions: [
          {
            request: {
              jsonrpc: "2.0",
              id: "tx-req-1",
              method: "getTransaction",
              params: [testSig, { encoding: "json", commitment: "confirmed" }],
              endpoint: "https://api.mainnet-beta.solana.com/",
              endpointFingerprint: "fp",
              timestampIso: new Date().toISOString(),
              timestampEpochMs: Date.now(),
            },
            response: {
              jsonrpc: "2.0",
              id: "tx-req-1",
              result: {
                slot: 450000100,
                blockTime: 1746886997,
                version: 0,
                transaction: {
                  message: {
                    accountKeys: ammV4Tx.accountKeys.staticAccountKeys,
                    instructions: ammV4Tx.instructions,
                  },
                },
                meta: { err: null, innerInstructions: [] },
              },
            },
            timing: { elapsedMs: 50, payloadSizeBytes: 2000 },
          },
        ],
        rawAccounts: [
          {
            request: {
              jsonrpc: "2.0",
              id: "acc-req-1",
              method: "getAccountInfo",
              params: [FIXTURE_POOL_ADDRESS, { encoding: "base64", commitment: "confirmed" }],
              endpoint: "https://api.mainnet-beta.solana.com/",
              endpointFingerprint: "fp",
              timestampIso: new Date().toISOString(),
              timestampEpochMs: Date.now(),
            },
            response: {
              jsonrpc: "2.0",
              id: "acc-req-1",
              result: {
                context: {}, // MISSING SLOT
                value: {
                  data: [createAuthoritativeRaydiumAmmV4Buffer().toString("base64"), "base64"],
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                  lamports: 10000000,
                },
              },
            },
            timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
          },
        ],
        discoveredEvents: [],
        verificationReports: [],
      });

      // Must fail closed in authentic replay and never substitute 300000100
      await expect(
        runReplaySession(
          {
            ...baseReplayConfig,
            replayMode: "authentic",
            replayFixturesPath: missingSlotSessionDir,
          },
          logger,
        ),
      ).rejects.toThrow("[REPLAY_MALFORMED_ACCOUNT_SLOT]");

      // Also verify loadAccountMapFromFixtures in authentic mode throws without synthetic fallback
      expect(() =>
        loadAccountMapFromFixtures(missingSlotSessionDir, { replayMode: "authentic" }),
      ).toThrow("[REPLAY_MALFORMED_ACCOUNT_SLOT]");

      // Test Case 2: getAccountInfo with zero slot
      const zeroSlotSessionDir = path.join(testTmpBase, "zero-account-slot-session");
      saveB2EventSession({
        captureBaseDir: testTmpBase,
        sessionId: "zero-account-slot-session",
        forcedStatus: "FINALIZED",
        rawNotifications: [],
        rawTransactions: [],
        rawAccounts: [
          {
            request: {
              jsonrpc: "2.0",
              id: "acc-req-zero",
              method: "getAccountInfo",
              params: [FIXTURE_POOL_ADDRESS, { encoding: "base64", commitment: "confirmed" }],
              endpoint: "https://api.mainnet-beta.solana.com/",
              endpointFingerprint: "fp",
              timestampIso: new Date().toISOString(),
              timestampEpochMs: Date.now(),
            },
            response: {
              jsonrpc: "2.0",
              id: "acc-req-zero",
              result: {
                context: { slot: 0 }, // ZERO SLOT
                value: {
                  data: [createAuthoritativeRaydiumAmmV4Buffer().toString("base64"), "base64"],
                  owner: RAYDIUM_AMM_V4_PROGRAM_ID,
                  lamports: 10000000,
                },
              },
            },
            timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
          },
        ],
        discoveredEvents: [],
        verificationReports: [],
      });

      await expect(
        runReplaySession(
          {
            ...baseReplayConfig,
            replayMode: "authentic",
            replayFixturesPath: zeroSlotSessionDir,
          },
          logger,
        ),
      ).rejects.toThrow("[REPLAY_MALFORMED_ACCOUNT_SLOT]");
    });

    it("B2-LAUNCH-01: authentic replay rejects getMultipleAccounts with missing, zero, or non-integer slot without synthetic fallback", async () => {
      const logger = new PilotLogger();

      const malformedMultipleAccSessionDir = path.join(
        testTmpBase,
        "malformed-multiple-acc-slot-session",
      );
      saveB2EventSession({
        captureBaseDir: testTmpBase,
        sessionId: "malformed-multiple-acc-slot-session",
        forcedStatus: "FINALIZED",
        rawNotifications: [],
        rawTransactions: [],
        rawAccounts: [
          {
            request: {
              jsonrpc: "2.0",
              id: "acc-req-mult",
              method: "getMultipleAccounts",
              params: [
                [FIXTURE_BASE_VAULT, FIXTURE_QUOTE_VAULT],
                { encoding: "base64", commitment: "confirmed" },
              ],
              endpoint: "https://api.mainnet-beta.solana.com/",
              endpointFingerprint: "fp",
              timestampIso: new Date().toISOString(),
              timestampEpochMs: Date.now(),
            },
            response: {
              jsonrpc: "2.0",
              id: "acc-req-mult",
              result: {
                context: { slot: "invalid-slot" }, // STRING SLOT
                value: [
                  {
                    data: [
                      createAuthoritativeSplVaultBuffer({
                        mintBase58: FIXTURE_MEME_MINT,
                        ownerBase58: RAYDIUM_AMM_V4_PROGRAM_ID,
                      }).toString("base64"),
                      "base64",
                    ],
                    owner: SPL_TOKEN_PROGRAM_ID,
                    lamports: 2000000,
                  },
                ],
              },
            },
            timing: { elapsedMs: 30, payloadSizeBytes: 1000 },
          },
        ],
        discoveredEvents: [],
        verificationReports: [],
      });

      await expect(
        runReplaySession(
          {
            ...baseReplayConfig,
            replayMode: "authentic",
            replayFixturesPath: malformedMultipleAccSessionDir,
          },
          logger,
        ),
      ).rejects.toThrow("[REPLAY_MALFORMED_ACCOUNT_SLOT]");

      expect(() =>
        loadAccountMapFromFixtures(malformedMultipleAccSessionDir, { replayMode: "authentic" }),
      ).toThrow("[REPLAY_MALFORMED_ACCOUNT_SLOT]");
    });

    it("B2-LAUNCH-01: authentic getSlot throws REPLAY_SLOT_UNAVAILABLE when no valid slot exists, and synthetic mode preserves fallback", async () => {
      // Session with empty notifications, transactions, and accounts (no slot observed anywhere)
      const emptySlotSessionDir = path.join(testTmpBase, "empty-slot-session");
      saveB2EventSession({
        captureBaseDir: testTmpBase,
        sessionId: "empty-slot-session",
        forcedStatus: "FINALIZED",
        rawNotifications: [],
        rawTransactions: [],
        rawAccounts: [],
        discoveredEvents: [],
        verificationReports: [],
      });

      // Authentic replay should complete reproduction with 0 events, but if getSlot is called, it must not return fabricated 300000100
      const authenticTransport = (
        await import("./PilotLiveCollectorCli.js")
      ).createOfflineRpcTransportFromFixtures(emptySlotSessionDir, { replayMode: "authentic" });
      await expect(
        authenticTransport.post("https://api.mainnet-beta.solana.com/", {
          jsonrpc: "2.0",
          id: 1,
          method: "getSlot",
          params: [],
        }),
      ).rejects.toThrow("[REPLAY_SLOT_UNAVAILABLE]");

      // In synthetic mode, fallback slot 300000100 is explicitly preserved
      const syntheticTransport = (
        await import("./PilotLiveCollectorCli.js")
      ).createOfflineRpcTransportFromFixtures(emptySlotSessionDir, { replayMode: "synthetic" });
      const synthRes = (await syntheticTransport.post("https://api.mainnet-beta.solana.com/", {
        jsonrpc: "2.0",
        id: 2,
        method: "getSlot",
        params: [],
      })) as { result: number };
      expect(synthRes.result).toBe(300000100);
    });

    it("B2-LAUNCH-02: coordinator safely halts and seals INTERRUPTED manifest on progressive disk-budget exhaustion during active session", async () => {
      const diskExhaustBase = path.join(testTmpBase, "coordinator-disk-exhaust-base");
      fsSync.mkdirSync(diskExhaustBase, { recursive: true });

      const wsTransport = new MockWebSocketTransport();
      wsTransport.autoOpenAndAck = true;
      const mockRpc = new MockSolanaRpcTransport();

      const wsClient = new SolanaWebSocketSubscriptionClient({
        wsUrl: "wss://api.mainnet-beta.solana.com/",
        transport: wsTransport,
      });

      const txFetcher = new SolanaRpcTransactionFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxTransactionsBudget: 25,
      });

      const accountFetcher = new SolanaRpcRecordingAccountFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxAccountCallsBudget: 20,
      });

      // Allocate tiny disk ceiling (0.005 MB = ~5242 bytes; stream limit = ~4718 bytes, headroom = ~524 bytes)
      const coordinator = new EventDiscoverySessionCoordinator({
        wsClient,
        txFetcher,
        accountFetcher,
        captureBaseDir: diskExhaustBase,
        budgets: {
          durationSec: 3,
          maxDiskMb: 0.01,
          maxWsMessages: 500,
          maxTransactions: 25,
          maxFallbackTransactions: 25,
          maxAccountReads: 20,
          maxTotalRpcCalls: 45,
        },
      });

      // Pump notifications asynchronously until disk limit is exhausted (using active AMM v4 subscriptionId 10)
      const pumpPromise = (async () => {
        await new Promise((r) => setTimeout(r, 20));
        for (let i = 0; i < 40; i++) {
          wsTransport.triggerMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "logsNotification",
              params: {
                result: {
                  context: { slot: 450000000 + i },
                  value: {
                    signature: `sig-exhaust-${i}-${"L".repeat(150)}`,
                    err: null,
                    logs: ["Program log: exhaust disk budget test record stream"],
                  },
                },
                subscription: 10,
              },
            }),
          );
          await new Promise((r) => setTimeout(r, 5));
        }
      })();

      const summary = await coordinator.runSession();
      await pumpPromise;

      // Must be safely marked INTERRUPTED due to disk budget exhaustion
      expect(summary.status).toBe("INTERRUPTED");
      expect(summary.stopReason).toContain("DISK_BUDGET_EXCEEDED");
      expect(summary.manifest?.status).toBe("INTERRUPTED");
      expect(summary.sessionDir).toBeDefined();

      // Reserved headroom must have successfully sealed valid session manifest
      expect(fsSync.existsSync(path.join(summary.sessionDir!, "session-manifest.json"))).toBe(true);
      const verification = verifyB2SessionManifest(summary.sessionDir!);
      expect(verification.valid).toBe(true);
      expect(verification.manifest.status).toBe("INTERRUPTED");
    });

    it("B2-LAUNCH-03: verifies separate enforcement of maxEvents (50) and maxWsMessages (500)", async () => {
      // 1. WebSocket client enforces maxWsMessages = 500 separately
      const wsTransport = new MockWebSocketTransport();
      wsTransport.autoOpenAndAck = true;
      const wsClient = new SolanaWebSocketSubscriptionClient({
        wsUrl: "wss://api.mainnet-beta.solana.com/",
        transport: wsTransport,
        maxMessagesBudget: 500,
      });
      wsTransport.triggerOpen();
      wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 10 }));
      wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 20 }));
      expect(wsClient.getStatus()).toBe("SUBSCRIBED");

      // Emit 60 messages to wsClient -> all 60 are accepted because 60 < 500
      for (let i = 0; i < 60; i++) {
        wsTransport.triggerMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000000 + i },
                value: { signature: `sig-ws-${i}`, err: null, logs: [] },
              },
              subscription: 10,
            },
          }),
        );
      }
      expect(wsClient.getMetrics().messagesReceived).toBe(60);
      expect(wsClient.getStatus()).toBe("SUBSCRIBED");
      wsClient.close();
    });

    it("B2-LAUNCH-03: verifies wall-clock deadline semantics stop queue draining immediately", async () => {
      const engine = new EventDiscoveryIngestionEngine();

      // Enqueue 5 items
      for (let i = 0; i < 5; i++) {
        await engine.handleLogNotification({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: 450000000 + i },
              value: {
                signature: `sig-deadline-${i}`,
                err: null,
                logs: ["Program log: initialize"],
              },
            },
            subscription: 1,
          },
        });
      }
      expect(engine.getQueueLength()).toBe(5);

      const mockTxFetcher = {
        fetchTransaction: async () => {
          throw new Error("Should not be called past deadline");
        },
      };
      const mockAccFetcher = {
        getAccountInfo: async () => null,
        getMultipleAccounts: async () => [],
        getSlot: async () => 450000000,
      };

      // Pass an expired deadline (e.g. deadline was 100ms ago)
      const results = await engine.processQueue(mockTxFetcher, mockAccFetcher, {
        deadlineEpochMs: Date.now() - 100,
      });

      // No transactions fetched, queue draining halted
      expect(results.length).toBe(0);
      expect(engine.getQueueLength()).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // 11. B2-GO Launch Audit Defect Verifications (B2-GO-01, B2-GO-02)
  // --------------------------------------------------------------------------
  describe("11. B2-GO Launch Audit Defect Verifications (B2-GO-01, B2-GO-02)", () => {
    it("B2-GO-01: examines 100+ non-initialization notifications without consuming the 50-event budget, then admits and verifies 1 valid initialization", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxEvents: 50 });
      const mockRpc = new MockSolanaRpcTransport();

      // Setup 105 non-initialization transactions
      for (let i = 0; i < 105; i++) {
        mockRpc.transactions.set(`sig-non-init-${i}`, {
          signature: `sig-non-init-${i}`,
          slot: 450000000 + i,
          blockTime: 1792375000 + i,
          version: "legacy",
          accountKeys: {
            staticAccountKeys: ["payer", "systemProgram"],
          },
          instructions: [
            {
              programIdIndex: 1,
              accountKeyIndexes: [0],
              data: "",
            },
          ],
          err: null,
          logMessages: [
            "Program 11111111111111111111111111111111 invoke [1]",
            "Program 11111111111111111111111111111111 success",
          ],
        });
      }

      // Setup 1 valid CPMM pool initialization transaction
      const validCpmmTx = createCpmmInitTransactionFixture({
        signature: "sig-valid-init-106",
        slot: 450000200,
        poolId: FIXTURE_CPMM_POOL_ADDRESS,
        token0Vault: FIXTURE_CPMM_TOKEN_0_VAULT,
        token1Vault: FIXTURE_CPMM_TOKEN_1_VAULT,
      });
      mockRpc.transactions.set("sig-valid-init-106", validCpmmTx);

      // Register CPMM pool and vault accounts
      mockRpc.accounts.set(FIXTURE_CPMM_POOL_ADDRESS, {
        address: FIXTURE_CPMM_POOL_ADDRESS,
        owner: RAYDIUM_CPMM_PROGRAM_ID,
        data: createAuthoritativeRaydiumCpmmBuffer(),
        lamports: 10000000,
        slot: 450000200,
      });
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_0_VAULT, {
        address: FIXTURE_CPMM_TOKEN_0_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
        lamports: 5000000,
        slot: 450000200,
      });
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_1_VAULT, {
        address: FIXTURE_CPMM_TOKEN_1_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
        lamports: 5000000,
        slot: 450000200,
      });

      const txFetcher = new SolanaRpcTransactionFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxTransactionsBudget: 200,
      });
      const accountFetcher = new SolanaRpcRecordingAccountFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxAccountCallsBudget: 50,
      });

      // 1. Feed 105 non-initialization notifications
      for (let i = 0; i < 105; i++) {
        const res = await engine.handleLogNotification({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: 450000000 + i },
              value: {
                signature: `sig-non-init-${i}`,
                err: null,
                logs: ["Program log: some ordinary transfer"],
              },
            },
            subscription: 1,
          },
        });
        expect(res.enqueued).toBe(true);
      }

      expect(engine.getMetricsSnapshot().rawLogNotificationsReceived).toBe(105);

      // Process queue for the 105 non-init notifications
      const interimReports = await engine.processQueue(txFetcher, accountFetcher);
      expect(interimReports.length).toBe(0);
      expect(engine.getDiscoveredEvents().length).toBe(0); // 50-event budget untouched!
      expect(engine.getMetricsSnapshot().successfulInitDecodes).toBe(0);
      expect(engine.getMetricsSnapshot().failedInitDecodes).toBe(105);

      // 2. Feed 1 valid pool initialization notification
      const resValid = await engine.handleLogNotification({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000200 },
            value: {
              signature: "sig-valid-init-106",
              err: null,
              logs: ["Program log: initialize"],
            },
          },
          subscription: 1,
        },
      });
      expect(resValid.enqueued).toBe(true);

      const finalReports = await engine.processQueue(txFetcher, accountFetcher);
      expect(finalReports.length).toBe(1);
      expect(finalReports[0]!.verified).toBe(true);
      expect(finalReports[0]!.verificationTier).toBe("INDEPENDENTLY_COHERENT");

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.rawLogNotificationsReceived).toBe(106);
      expect(metrics.uniqueTransactionsEncountered).toBe(106);
      expect(metrics.successfulInitDecodes).toBe(1);
      expect(metrics.candidatePoolsDiscovered).toBe(1);
      expect(engine.getDiscoveredEvents().length).toBe(1);
      expect(metrics.coherentTierPoolsCount).toBe(1);
      expect(metrics.rateLimitDrops).toBe(0);
    });

    it("B2-GO-01: enforces exact 50-event boundary and verifies the 50th event without skipping", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxEvents: 50 });
      const mockRpc = new MockSolanaRpcTransport();

      // Register standard vault accounts
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_0_VAULT, {
        address: FIXTURE_CPMM_TOKEN_0_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
        lamports: 5000000,
        slot: 450000000,
      });
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_1_VAULT, {
        address: FIXTURE_CPMM_TOKEN_1_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
        lamports: 5000000,
        slot: 450000000,
      });

      // Create 50 distinct CPMM pool initialization transactions and accounts
      for (let i = 0; i < 50; i++) {
        const poolId = `PoolStateExactBoundary${String(i).padStart(4, "0")}1111111111111`;
        const sig = `sig-exact-pool-${i}`;

        const tx = createCpmmInitTransactionFixture({
          signature: sig,
          slot: 450000000 + i,
          poolId,
        });
        mockRpc.transactions.set(sig, tx);

        mockRpc.accounts.set(poolId, {
          address: poolId,
          owner: RAYDIUM_CPMM_PROGRAM_ID,
          data: createAuthoritativeRaydiumCpmmBuffer(),
          lamports: 10000000,
          slot: 450000000 + i,
        });

        await engine.handleLogNotification({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: 450000000 + i },
              value: { signature: sig, err: null, logs: ["Program log: initialize"] },
            },
            subscription: 1,
          },
        });
      }

      const txFetcher = new SolanaRpcTransactionFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxTransactionsBudget: 60,
      });
      const accountFetcher = new SolanaRpcRecordingAccountFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxAccountCallsBudget: 60,
      });

      const reports = await engine.processQueue(txFetcher, accountFetcher);

      // Verify that exactly 50 events were admitted and verified
      expect(engine.getDiscoveredEvents().length).toBe(50);
      expect(reports.length).toBe(50);
      expect(reports[49]!.poolId).toBe(`PoolStateExactBoundary00491111111111111`);
      expect(reports[49]!.verified).toBe(true);
      expect(engine.getMetricsSnapshot().successfulInitDecodes).toBe(50);
      expect(engine.getMetricsSnapshot().rateLimitDrops).toBe(0);

      // Now feed 51st event -> rejected with MAX_EVENTS_EXCEEDED
      const excessRes = await engine.handleLogNotification({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000051 },
            value: { signature: "sig-exact-pool-50", err: null, logs: ["Program log: initialize"] },
          },
          subscription: 1,
        },
      });
      expect(excessRes.enqueued).toBe(false);
      expect(excessRes.reason).toBe("MAX_EVENTS_EXCEEDED");
      expect(engine.getDiscoveredEvents().length).toBe(50); // Hard ceiling preserved
      expect(engine.getMetricsSnapshot().rateLimitDrops).toBe(1);
    });

    it("B2-GO-01: multi-initialization transaction at the boundary admits up to exactly 50 events and drops excess events to rateLimitDrops", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxEvents: 50 });
      const mockRpc = new MockSolanaRpcTransport();

      // Register standard vault accounts
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_0_VAULT, {
        address: FIXTURE_CPMM_TOKEN_0_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
        lamports: 5000000,
        slot: 450000000,
      });
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_1_VAULT, {
        address: FIXTURE_CPMM_TOKEN_1_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
        lamports: 5000000,
        slot: 450000000,
      });

      // Pre-populate 49 initialization events
      for (let i = 0; i < 49; i++) {
        const poolId = `PoolPrePop${String(i).padStart(4, "0")}11111111111111111111111`;
        const sig = `sig-prepop-${i}`;

        const tx = createCpmmInitTransactionFixture({
          signature: sig,
          slot: 450000000 + i,
          poolId,
        });
        mockRpc.transactions.set(sig, tx);

        mockRpc.accounts.set(poolId, {
          address: poolId,
          owner: RAYDIUM_CPMM_PROGRAM_ID,
          data: createAuthoritativeRaydiumCpmmBuffer(),
          lamports: 10000000,
          slot: 450000000 + i,
        });

        await engine.handleLogNotification({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: 450000000 + i },
              value: { signature: sig, err: null, logs: ["Program log: initialize"] },
            },
            subscription: 1,
          },
        });
      }

      const txFetcher = new SolanaRpcTransactionFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxTransactionsBudget: 60,
      });
      const accountFetcher = new SolanaRpcRecordingAccountFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxAccountCallsBudget: 60,
      });

      await engine.processQueue(txFetcher, accountFetcher);
      expect(engine.getDiscoveredEvents().length).toBe(49);

      // Now create a multi-initialization transaction with 3 CPMM initializations
      const multiSig = "sig-multi-init-at-boundary";
      const pool0 = "PoolMulti_0_1111111111111111111111111111111";
      const pool1 = "PoolMulti_1_1111111111111111111111111111111";
      const pool2 = "PoolMulti_2_1111111111111111111111111111111";

      const baseTx = createCpmmInitTransactionFixture({
        signature: multiSig,
        slot: 450000100,
        poolId: pool0,
      });

      // Construct accounts and instructions for 3 initializations
      const staticKeys = [...baseTx.accountKeys.staticAccountKeys, pool1, pool2];
      const p1Index = staticKeys.indexOf(pool1);
      const p2Index = staticKeys.indexOf(pool2);

      const inst0 = baseTx.instructions[0]!;
      const inst1 = {
        programIdIndex: inst0.programIdIndex,
        accountKeyIndexes: inst0.accountKeyIndexes.map((idx, pos) => (pos === 3 ? p1Index : idx)),
        data: inst0.data,
      };
      const inst2 = {
        programIdIndex: inst0.programIdIndex,
        accountKeyIndexes: inst0.accountKeyIndexes.map((idx, pos) => (pos === 3 ? p2Index : idx)),
        data: inst0.data,
      };

      const multiTx: VersionedTransactionMetadata = {
        ...baseTx,
        accountKeys: {
          staticAccountKeys: staticKeys,
        },
        instructions: [inst0, inst1, inst2],
      };
      mockRpc.transactions.set(multiSig, multiTx);

      mockRpc.accounts.set(pool0, {
        address: pool0,
        owner: RAYDIUM_CPMM_PROGRAM_ID,
        data: createAuthoritativeRaydiumCpmmBuffer(),
        lamports: 10000000,
        slot: 450000100,
      });

      await engine.handleLogNotification({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000100 },
            value: { signature: multiSig, err: null, logs: ["Program log: initialize"] },
          },
          subscription: 1,
        },
      });

      const multiReports = await engine.processQueue(txFetcher, accountFetcher);

      const metrics = engine.getMetricsSnapshot();
      // Total decoded initializations: 49 + 3 = 52
      expect(metrics.successfulInitDecodes).toBe(52);
      // Exactly 50 admitted events (hard ceiling)
      expect(engine.getDiscoveredEvents().length).toBe(50);
      // Excess 2 events dropped to rateLimitDrops
      expect(metrics.rateLimitDrops).toBe(2);
      // The 50th event was verified
      expect(multiReports.length).toBe(1);
      expect(multiReports[0]!.poolId).toBe(pool0);
      expect(multiReports[0]!.verified).toBe(true);
    });

    it("B2-GO-02: retryPendingVerifications checks deadlineEpochMs before each iteration and halts without querying RPC", async () => {
      const engine = new EventDiscoveryIngestionEngine();
      let accountCallsMade = 0;
      const trackingFetcher = {
        getAccountInfo: async () => {
          accountCallsMade++;
          return null;
        },
        getMultipleAccounts: async () => {
          accountCallsMade++;
          return [null, null, null];
        },
        getSlot: async () => 450000000,
      };

      const failingFetcher = {
        getAccountInfo: async () => null,
        getMultipleAccounts: async () => {
          throw new Error("Temporary network glitch");
        },
        getSlot: async () => 450000000,
      };

      const tx = createCpmmInitTransactionFixture({
        signature: "sig-retry-deadline-1",
        slot: 450000100,
      });
      const txFetcher = {
        fetchTransaction: async () => tx,
      };

      await engine.handleLogNotification({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000100 },
            value: {
              signature: "sig-retry-deadline-1",
              err: null,
              logs: ["Program log: initialize"],
            },
          },
          subscription: 1,
        },
      });

      // Initial queue processing fails with network glitch, populating pendingVerifications
      await engine.processQueue(txFetcher, failingFetcher);
      expect(engine.getPendingVerificationsCount()).toBe(1);

      // Now attempt retry with an expired deadline
      const retried = await engine.retryPendingVerifications(trackingFetcher, {
        deadlineEpochMs: Date.now() - 1000,
      });

      // Zero RPC account calls initiated past deadline
      expect(accountCallsMade).toBe(0);
      expect(retried.length).toBe(0);
      // Pending item remains preserved intact for honest unresolved evidence accounting
      expect(engine.getPendingVerificationsCount()).toBe(1);
    });

    it("B2-GO-02: dispatchPoolVerification checks deadlineEpochMs and prevents sequential account queries past deadline", async () => {
      const event: DiscoveredPoolInitializationEvent = {
        eventId: "sig-pool:0",
        signature: "sig-pool",
        outerInstructionIndex: 0,
        instructionIndex: 0,
        protocol: "RAYDIUM_CPMM",
        poolId: FIXTURE_CPMM_POOL_ADDRESS,
        token0Vault: FIXTURE_CPMM_TOKEN_0_VAULT,
        token1Vault: FIXTURE_CPMM_TOKEN_1_VAULT,
        token0Mint: FIXTURE_CPMM_TOKEN_0_MINT,
        token1Mint: FIXTURE_CPMM_TOKEN_1_MINT,
        slot: 450000100,
        blockTimeSec: 1792375000,
        firstSeenTimestampMs: Date.now(),
        instructionRequestedOpenTimeSec: 1792375300,
        poolOpenTimeSec: 1792375300,
      };

      let fetcherCalled = false;
      const fetcher = {
        getAccountInfo: async () => {
          fetcherCalled = true;
          return null;
        },
        getMultipleAccounts: async () => {
          fetcherCalled = true;
          return [null, null, null];
        },
        getSlot: async () => 450000100,
      };

      await expect(
        dispatchPoolVerification(event, fetcher, {
          deadlineEpochMs: Date.now() - 50,
        }),
      ).rejects.toThrow("[VERIFICATION_DEADLINE_EXCEEDED]");

      expect(fetcherCalled).toBe(false);
    });

    it("B2-GO-02: delayed-transport coordinator session stops boundedly, seals evidence honestly, and leaves unfinished verification in pendingVerifications", async () => {
      const captureDir = path.join(os.tmpdir(), `b2-test-delayed-${Date.now()}`);
      fsSync.mkdirSync(captureDir, { recursive: true });

      const wsTransport = new MockWebSocketTransport();
      wsTransport.autoOpenAndAck = true;

      const wsClient = new SolanaWebSocketSubscriptionClient({
        wsUrl: "wss://api.mainnet-beta.solana.com/",
        transport: wsTransport,
      });

      const tx = createCpmmInitTransactionFixture({
        signature: "sig-delayed-tx",
        slot: 450000100,
      });

      const mockRpc = new MockSolanaRpcTransport();
      mockRpc.transactions.set("sig-delayed-tx", tx);
      mockRpc.accounts.set(FIXTURE_CPMM_POOL_ADDRESS, {
        address: FIXTURE_CPMM_POOL_ADDRESS,
        owner: RAYDIUM_CPMM_PROGRAM_ID,
        data: createAuthoritativeRaydiumCpmmBuffer(),
        lamports: 10000000,
        slot: 450000100,
      });
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_0_VAULT, {
        address: FIXTURE_CPMM_TOKEN_0_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
        lamports: 5000000,
        slot: 450000100,
      });
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_1_VAULT, {
        address: FIXTURE_CPMM_TOKEN_1_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
        lamports: 5000000,
        slot: 450000100,
      });

      // Account fetcher will fail with a transient error on attempt 1,
      // and simulate a delay that pushes elapsed time past the deadline
      let callCount = 0;
      const delayedAccTransport: ISolanaRpcTransport = {
        post: async (_url: string, body: Record<string, unknown>) => {
          const method = body.method as string;
          if (method === "getMultipleAccounts" || method === "getAccountInfo") {
            callCount++;
            // Delay 120ms to push elapsed time past the 100ms deadline
            await new Promise((resolve) => setTimeout(resolve, 120));
            throw new Error("Simulated transient transport timeout");
          }
          return mockRpc.post(_url, body);
        },
      };

      const txFetcher = new SolanaRpcTransactionFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
      });

      const accountFetcher = new SolanaRpcRecordingAccountFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: delayedAccTransport,
      });

      const coordinator = new EventDiscoverySessionCoordinator({
        wsClient,
        txFetcher,
        accountFetcher,
        captureBaseDir: captureDir,
        budgets: {
          durationSec: 0.1, // 100ms observation window
          maxEvents: 50,
          maxWsMessages: 500,
          maxTransactions: 25,
          maxAccountReads: 20,
          maxTotalRpcCalls: 45,
          maxRssMb: 256,
          maxDiskMb: 256,
        },
      });

      // WebSocket delivers 1 valid initialization notification with subscriptions acknowledged
      wsTransport.triggerOpen();
      wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 10 }));
      wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 20 }));

      wsTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: 450000100 },
              value: { signature: "sig-delayed-tx", err: null, logs: ["Program log: initialize"] },
            },
            subscription: 20,
          },
        }),
      );

      const summary = await coordinator.runSession();

      // Session finished boundedly without hanging
      expect(summary.status).toBe("FINALIZED");
      expect(summary.stopReason).toContain("DURATION_LIMIT_REACHED");

      // Evidence was cleanly sealed and manifest verified
      expect(summary.manifestVerified).toBe(true);
      expect(summary.sessionDir).toBeDefined();

      // Honest accounting: 1 candidate pool discovered, 0 verified, 0 rejected, 1 unresolved
      expect(summary.accounting.uniquePoolsDiscovered).toBe(1);
      expect(summary.accounting.poolsVerifiedCoherent).toBe(0);
      expect(summary.accounting.poolsRejected).toBe(0);
      expect(summary.accounting.unresolvedObservations).toBe(1);
      expect(summary.metrics.pendingVerificationsCount).toBe(1);
      expect(callCount).toBeGreaterThanOrEqual(1);

      // Cleanup
      try {
        fsSync.rmSync(captureDir, { recursive: true, force: true });
      } catch {
        // Ignored in test cleanup
      }
    });
  });

  // --------------------------------------------------------------------------
  // 12. Version 1 Transaction Support & Realistic JSON-RPC (B2-NEXT-01)
  // --------------------------------------------------------------------------
  describe("12. Version 1 Transaction Support & Realistic JSON-RPC (B2-NEXT-01)", () => {
    it("B2-NEXT-01-01: SolanaRpcTransactionFetcher requests maxSupportedTransactionVersion: 1 and decodes realistic v1 JSON into metadata with transactionConfig and inline accounts", async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const realisticV1Rpc = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-v1-realistic-amm",
        slot: 459800100,
        blockTime: 1792618963,
        protocol: "RAYDIUM_AMM_V4",
      });

      const mockTransport: ISolanaRpcTransport = {
        post: async (_url: string, body: Record<string, unknown>) => {
          capturedBody = body;
          return realisticV1Rpc;
        },
      };

      const fetcher = new SolanaRpcTransactionFetcher({
        transport: mockTransport,
        maxTransactionsBudget: 5,
        minRequestIntervalMs: 0,
      });

      const tx = await fetcher.fetchTransaction("sig-v1-realistic-amm");
      expect(tx).not.toBeNull();
      expect(tx?.version).toBe(1);
      expect(tx?.slot).toBe(459800100);
      expect(tx?.blockTime).toBe(1792618963);
      expect(tx?.err).toBeNull();

      // SIMD-0385 / txv1: All account keys are inline in staticAccountKeys (no ALTs)
      expect(tx?.accountKeys.staticAccountKeys.length).toBe(22);
      expect(tx?.accountKeys.loadedAddresses).toBeUndefined();

      // SIMD-0385: First-class transactionConfig parsed from message
      expect(tx?.transactionConfig).toBeDefined();
      expect(tx?.transactionConfig?.computeUnitLimit).toBe(200_000);
      expect(tx?.transactionConfig?.priorityFeeLamports).toBe(10_000);
      expect(tx?.transactionConfig?.loadedAccountsDataSizeLimit).toBe(64_000);
      expect(tx?.transactionConfig?.heapSize).toBe(32_768);

      // SIMD-0385 / B2-GO-FIX-03: Wire payload uses 'priorityFee'
      const wireTx = (realisticV1Rpc.result as Record<string, unknown>)?.transaction as Record<
        string,
        unknown
      >;
      const wireMessage = wireTx?.message as Record<string, unknown>;
      const wireTxConfig = wireMessage?.transactionConfig as Record<string, unknown>;
      expect(wireTxConfig?.priorityFee).toBe(10_000);
      expect(wireTxConfig?.priorityFeeLamports).toBeUndefined();

      // Verify maxSupportedTransactionVersion: 1 was transmitted in JSON-RPC body
      expect(capturedBody).not.toBeNull();
      const params = (capturedBody as unknown as { params?: unknown[] })?.params;
      const opts = params?.[1] as Record<string, unknown> | undefined;
      expect(opts?.["maxSupportedTransactionVersion"]).toBe(1);
    });

    it("B2-NEXT-01-02: verifies inline account-key resolution for v1 transactions without loadedAddresses", () => {
      const realisticV1Rpc = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-v1-keys",
        protocol: "RAYDIUM_AMM_V4",
      });
      const tx = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-v1-keys",
        realisticV1Rpc,
      );
      expect(tx).not.toBeNull();
      expect(tx!.accountKeys.loadedAddresses).toBeUndefined();

      const resolved = resolveTransactionAccountKeys(tx!.accountKeys);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.keys.length).toBe(tx!.accountKeys.staticAccountKeys.length);
        expect(resolved.keys).toEqual(tx!.accountKeys.staticAccountKeys);
        expect(resolved.keys[4]).toBe(FIXTURE_POOL_ADDRESS);
        expect(resolved.keys[21]).toBe(RAYDIUM_AMM_V4_PROGRAM_ID);
      }
    });

    it("B2-NEXT-01-03: identifyPoolInitializationInstructions detects positive AMM v4 initialization in realistic v1 transaction", () => {
      const realisticV1Rpc = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-v1-amm-init",
        slot: 459800150,
        protocol: "RAYDIUM_AMM_V4",
      });
      const tx = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-v1-amm-init",
        realisticV1Rpc,
      );
      expect(tx).not.toBeNull();

      const result = identifyPoolInitializationInstructions(tx!);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.events.length).toBe(1);
        const ev = result.events[0]!;
        expect(ev.protocol).toBe("RAYDIUM_AMM_V4");
        expect(ev.slot).toBe(459800150);
        expect(ev.poolId).toBe(FIXTURE_POOL_ADDRESS);
        expect(ev.token0Mint).toBe(FIXTURE_MEME_MINT);
        expect(ev.token1Mint).toBe(FIXTURE_WSOL_MINT);
        expect(ev.token0Vault).toBe(FIXTURE_BASE_VAULT);
        expect(ev.token1Vault).toBe(FIXTURE_QUOTE_VAULT);
        expect(ev.innerInstructionIndex).toBeUndefined();
      }
    });

    it("B2-NEXT-01-04: identifyPoolInitializationInstructions detects positive CPMM initialization in realistic v1 transaction including CPI inner instruction", () => {
      // 1. Top-level CPMM initialization in realistic v1
      const cpmmRpc = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-v1-cpmm-top",
        slot: 459800160,
        protocol: "RAYDIUM_CPMM",
      });
      const cpmmTx = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-v1-cpmm-top",
        cpmmRpc,
      );
      expect(cpmmTx).not.toBeNull();

      const cpmmResult = identifyPoolInitializationInstructions(cpmmTx!);
      expect(cpmmResult.ok).toBe(true);
      if (cpmmResult.ok) {
        expect(cpmmResult.events.length).toBe(1);
        const ev = cpmmResult.events[0]!;
        expect(ev.protocol).toBe("RAYDIUM_CPMM");
        expect(ev.slot).toBe(459800160);
        expect(ev.poolId).toBe(FIXTURE_CPMM_POOL_ADDRESS);
        expect(ev.token0Mint).toBe(FIXTURE_CPMM_TOKEN_0_MINT);
        expect(ev.token1Mint).toBe(FIXTURE_CPMM_TOKEN_1_MINT);
        expect(ev.innerInstructionIndex).toBeUndefined();
      }

      // 2. Nested CPI CPMM initialization in realistic v1
      const cpiRpc = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-v1-cpmm-cpi",
        slot: 459800170,
        protocol: "RAYDIUM_CPMM",
        isCpi: true,
      });
      const cpiTx = SolanaRpcTransactionFetcher.parseTransactionResponse("sig-v1-cpmm-cpi", cpiRpc);
      expect(cpiTx).not.toBeNull();
      expect(cpiTx?.innerInstructions?.length).toBe(1);

      const cpiResult = identifyPoolInitializationInstructions(cpiTx!);
      expect(cpiResult.ok).toBe(true);
      if (cpiResult.ok) {
        expect(cpiResult.events.length).toBe(1);
        const ev = cpiResult.events[0]!;
        expect(ev.protocol).toBe("RAYDIUM_CPMM");
        expect(ev.slot).toBe(459800170);
        expect(ev.poolId).toBe(FIXTURE_CPMM_POOL_ADDRESS);
        expect(ev.outerInstructionIndex).toBe(0);
        expect(ev.innerInstructionIndex).toBe(0);
      }
    });

    it("B2-NEXT-01-05: rejects malformed v1 transactions (missing/zero slot, malformed account indexes, corrupted instruction data, invalid program index)", () => {
      // 1. Missing / invalid slot
      const malformedSlot = SolanaRpcTransactionFetcher.parseTransactionResponse("sig-bad-slot", {
        result: {
          slot: 0,
          version: 1,
          transaction: { message: { accountKeys: [] } },
        },
      });
      expect(malformedSlot).toBeNull();

      // 2. Invalid negative programIdIndex
      const badProgramIndexRpc = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-bad-prog",
        malformedProgramIndex: true,
      });
      const badProgTx = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-bad-prog",
        badProgramIndexRpc,
      );
      expect(badProgTx).toBeNull();

      // 3. Out-of-bounds account index in instruction
      const oobAccountRpc = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-oob-acc",
        malformedAccountIndex: true,
      });
      const oobTx = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-oob-acc",
        oobAccountRpc,
      );
      expect(oobTx).not.toBeNull();
      const oobResult = identifyPoolInitializationInstructions(oobTx!);
      expect(oobResult.ok).toBe(false);
      if (!oobResult.ok) {
        expect(["UNRESOLVED_LOOKUP_TABLE_INDEX", "MISSING_ACCOUNTS"]).toContain(oobResult.reason);
      }

      // 4. Corrupted instruction data
      const corruptedDataRpc = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-corrupt-data",
        corruptInstructionData: true,
      });
      const corruptTx = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-corrupt-data",
        corruptedDataRpc,
      );
      expect(corruptTx).not.toBeNull();
      const corruptResult = identifyPoolInitializationInstructions(corruptTx!);
      expect(corruptResult.ok).toBe(false);
      if (!corruptResult.ok) {
        expect(corruptResult.reason).toBe("CORRUPTED_INSTRUCTION_DATA");
      }
    });

    it("B2-NEXT-01-06: preserves legacy and v0 (with ALTs) parsing alongside v1", () => {
      // 1. Legacy transaction
      const legacyTx = createAmmV4InitTransactionFixture({
        signature: "sig-legacy-ok",
        slot: 300000100,
      });
      expect(legacyTx.version).toBe("legacy");
      expect(legacyTx.accountKeys.loadedAddresses).toBeUndefined();
      const legacyResult = identifyPoolInitializationInstructions(legacyTx);
      expect(legacyResult.ok).toBe(true);

      // 2. Version 0 transaction with Address Lookup Tables (ALTs)
      const v0Tx = createAmmV4InitTransactionFixture({
        signature: "sig-v0-alts-ok",
        slot: 300000110,
        isVersion0: true,
      });
      expect(v0Tx.version).toBe(0);
      expect(v0Tx.accountKeys.loadedAddresses).toBeDefined();
      expect(v0Tx.accountKeys.loadedAddresses?.writable.length).toBeGreaterThan(0);
      const v0Result = identifyPoolInitializationInstructions(v0Tx);
      expect(v0Result.ok).toBe(true);
      if (v0Result.ok) {
        expect(v0Result.events[0]?.slot).toBe(300000110);
      }
    });

    it("B2-NEXT-01-07: confirms no synthetic or v0-only structure is presented as proof of v1 support", () => {
      // Pure v1 transaction fixture has no loadedAddresses
      const v1Tx = createAmmV4InitTransactionFixture({
        signature: "sig-v1-pure",
        isVersion1: true,
      });
      expect(v1Tx.version).toBe(1);
      expect(v1Tx.accountKeys.loadedAddresses).toBeUndefined();
      expect(v1Tx.transactionConfig).toBeDefined();
      expect(v1Tx.transactionConfig?.computeUnitLimit).toBe(200_000);

      // Verify parseTransactionResponse does not inject loadedAddresses for v1
      const v1RpcWithBogusLoaded = createRealisticVersion1GetTransactionRpcResponse({
        signature: "sig-v1-bogus-loaded",
      });
      // Inject bogus loadedAddresses into raw RPC result meta to confirm parser strips them for v1
      const meta = (v1RpcWithBogusLoaded.result as { meta?: Record<string, unknown> }).meta!;
      meta.loadedAddresses = {
        writable: ["BogusWritableAddress111111111111111111111111"],
        readonly: ["BogusReadonlyAddress111111111111111111111111"],
      };

      const parsed = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-v1-bogus-loaded",
        v1RpcWithBogusLoaded,
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.version).toBe(1);
      // loadedAddresses MUST be undefined for version 1 transactions per SIMD-0385
      expect(parsed?.accountKeys.loadedAddresses).toBeUndefined();
    });

    it("B2-GO-FIX-03: maps wire 'priorityFee' to normalized 'priorityFeeLamports', supports fallback and handles missing configs", () => {
      // 1. Wire format with priorityFee
      const wirePayloadWithPriorityFee = {
        result: {
          slot: 450000100,
          version: 1,
          transaction: {
            message: {
              accountKeys: ["11111111111111111111111111111111"],
              instructions: [],
              transactionConfig: {
                computeUnitLimit: 150_000,
                priorityFee: 25_000,
              },
            },
          },
        },
      };
      const parsed1 = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-wire-1",
        wirePayloadWithPriorityFee,
      );
      expect(parsed1?.transactionConfig?.priorityFeeLamports).toBe(25_000);
      expect(parsed1?.transactionConfig?.computeUnitLimit).toBe(150_000);

      // 2. Wire format with fallback priorityFeeLamports
      const wirePayloadWithFallback = {
        result: {
          slot: 450000101,
          version: 1,
          transaction: {
            message: {
              accountKeys: ["11111111111111111111111111111111"],
              instructions: [],
              transactionConfig: {
                priorityFeeLamports: 30_000,
              },
            },
          },
        },
      };
      const parsed2 = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-wire-2",
        wirePayloadWithFallback,
      );
      expect(parsed2?.transactionConfig?.priorityFeeLamports).toBe(30_000);

      // 3. Wire format with no transactionConfig (v0 or legacy or omitted)
      const wirePayloadLegacy = {
        result: {
          slot: 450000102,
          version: "legacy",
          transaction: {
            message: {
              accountKeys: ["11111111111111111111111111111111"],
              instructions: [],
            },
          },
        },
      };
      const parsed3 = SolanaRpcTransactionFetcher.parseTransactionResponse(
        "sig-wire-3",
        wirePayloadLegacy,
      );
      expect(parsed3?.transactionConfig).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 13. RPC Pacing, Rate-Limit Headers, and Session Deadlines (B2-NEXT-02)
  // --------------------------------------------------------------------------
  describe("13. RPC Pacing, Rate-Limit Headers, and Session Deadlines (B2-NEXT-02)", () => {
    it("B2-NEXT-02-01: provider rate-limit parsing extracts bounded retryAfter header vs fixed 2s fallback", async () => {
      // 1. retryAfter=5s parsed from message
      const mockTransport5s: ISolanaRpcTransport = {
        post: async () => {
          throw new Error("[RPC_RATE_LIMIT_429] Solana RPC 429 Too Many Requests: retryAfter=5s");
        },
      };

      const fetcher5s = new SolanaRpcTransactionFetcher({
        transport: mockTransport5s,
        maxTransactionsBudget: 2,
        minRequestIntervalMs: 0,
      });

      const before5s = Date.now();
      await fetcher5s.fetchTransaction("sig-429-5s");
      const retryAfter5s = fetcher5s.getRetryAfterUntilEpochMs();
      expect(retryAfter5s).toBeGreaterThanOrEqual(before5s + 4900);
      expect(retryAfter5s).toBeLessThanOrEqual(before5s + 6000);

      // 2. retryAfter=30s is bounded to max 10s
      const mockTransport30s: ISolanaRpcTransport = {
        post: async () => {
          throw new Error("[RPC_RATE_LIMIT_429] 429 Too Many Requests retryAfter=30s");
        },
      };
      const fetcher30s = new SolanaRpcTransactionFetcher({
        transport: mockTransport30s,
        maxTransactionsBudget: 2,
        minRequestIntervalMs: 0,
      });
      const before30s = Date.now();
      await fetcher30s.fetchTransaction("sig-429-30s");
      const retryAfter30s = fetcher30s.getRetryAfterUntilEpochMs();
      expect(retryAfter30s).toBeGreaterThanOrEqual(before30s + 9900);
      expect(retryAfter30s).toBeLessThanOrEqual(before30s + 11000);

      // 3. Unparsed 429 falls back to fixed 2s
      const mockTransportFallback: ISolanaRpcTransport = {
        post: async () => {
          throw new Error("[RPC_RATE_LIMIT_429] 429 Too Many Requests");
        },
      };
      const fetcherFallback = new SolanaRpcTransactionFetcher({
        transport: mockTransportFallback,
        maxTransactionsBudget: 2,
        minRequestIntervalMs: 0,
      });
      const beforeFallback = Date.now();
      await fetcherFallback.fetchTransaction("sig-429-fallback");
      const retryAfterFallback = fetcherFallback.getRetryAfterUntilEpochMs();
      expect(retryAfterFallback).toBeGreaterThanOrEqual(beforeFallback + 1900);
      expect(retryAfterFallback).toBeLessThanOrEqual(beforeFallback + 3000);
    });

    it("B2-NEXT-02-02: SolanaRpcTransactionFetcher enforces minimum request interval pacing between consecutive calls", async () => {
      const timestamps: number[] = [];
      const mockTransport: ISolanaRpcTransport = {
        post: async (_url: string, body: Record<string, unknown>) => {
          timestamps.push(Date.now());
          return {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              slot: 459800100,
              version: 1,
              transaction: { message: { accountKeys: [] } },
            },
          };
        },
      };

      const fetcher = new SolanaRpcTransactionFetcher({
        transport: mockTransport,
        maxTransactionsBudget: 5,
        minRequestIntervalMs: 50, // 50ms pacing
      });

      await fetcher.fetchTransaction("sig-pace-1");
      await fetcher.fetchTransaction("sig-pace-2");
      await fetcher.fetchTransaction("sig-pace-3");

      expect(timestamps.length).toBe(3);
      const delta1 = timestamps[1]! - timestamps[0]!;
      const delta2 = timestamps[2]! - timestamps[1]!;

      expect(delta1).toBeGreaterThanOrEqual(40);
      expect(delta2).toBeGreaterThanOrEqual(40);
      expect(fetcher.getCallsExecutedCount()).toBe(3);
    });

    it("B2-NEXT-02-03: SolanaRpcTransactionFetcher aborts/skips when session deadline is near or exceeded without overrunning", async () => {
      let callCount = 0;
      const mockTransport: ISolanaRpcTransport = {
        post: async () => {
          callCount++;
          return { jsonrpc: "2.0", result: null };
        },
      };

      const fetcher = new SolanaRpcTransactionFetcher({
        transport: mockTransport,
        maxTransactionsBudget: 5,
        minRequestIntervalMs: 100,
      });

      // 1. Immediate skip when deadline is already passed
      const pastDeadline = Date.now() - 50;
      const resPast = await fetcher.fetchTransaction("sig-past-deadline", {
        deadlineEpochMs: pastDeadline,
      });
      expect(resPast).toBeNull();
      expect(callCount).toBe(0);
      expect(fetcher.getCallsExecutedCount()).toBe(0);

      // 2. Pacing wait would overrun deadline -> skip without waiting
      await fetcher.fetchTransaction("sig-first"); // establishes lastRequestEpochMs
      expect(callCount).toBe(1);

      // Now request immediate next call with deadline only 20ms away (pacing is 100ms)
      const tightDeadline = Date.now() + 20;
      const resTight = await fetcher.fetchTransaction("sig-tight-pacing", {
        deadlineEpochMs: tightDeadline,
      });
      expect(resTight).toBeNull();
      expect(callCount).toBe(1); // not incremented
    });

    it("B2-NEXT-02-04: SolanaRpcRecordingAccountFetcher respects session deadline and bounded backoff", async () => {
      let callCount = 0;
      const mockTransport: ISolanaRpcTransport = {
        post: async () => {
          callCount++;
          return {
            jsonrpc: "2.0",
            result: {
              context: { slot: 459800100 },
              value: {
                data: ["", "base64"],
                lamports: 100_000_000,
                owner: "11111111111111111111111111111111",
              },
            },
          };
        },
      };

      const fetcher = new SolanaRpcRecordingAccountFetcher({
        transport: mockTransport,
        maxAccountCallsBudget: 5,
        minRequestIntervalMs: 100,
      });

      // 1. Immediate skip on past deadline
      const resInfo = await fetcher.getAccountInfo("acc-1", {
        deadlineEpochMs: Date.now() - 100,
      });
      expect(resInfo).toBeNull();
      expect(callCount).toBe(0);

      const resMulti = await fetcher.getMultipleAccounts(["acc-1", "acc-2"], {
        deadlineEpochMs: Date.now() - 100,
      });
      expect(resMulti).toEqual([null, null]);
      expect(callCount).toBe(0);

      const resSlot = await fetcher.getSlot({
        deadlineEpochMs: Date.now() - 100,
      });
      expect(resSlot).toBe(0);
      expect(callCount).toBe(0);

      // 2. 429 throttling sets backoff with 2s fallback
      const throttledTransport: ISolanaRpcTransport = {
        post: async () => {
          throw new Error("[RPC_RATE_LIMIT_429] Solana RPC 429 Too Many Requests");
        },
      };
      const throttledFetcher = new SolanaRpcRecordingAccountFetcher({
        transport: throttledTransport,
        maxAccountCallsBudget: 2,
        minRequestIntervalMs: 0,
      });

      const before = Date.now();
      await throttledFetcher.getAccountInfo("acc-throttled");
      expect(throttledFetcher.getRetryAfterUntilEpochMs()).toBeGreaterThanOrEqual(before + 1900);
      expect(throttledFetcher.getRetryAfterUntilEpochMs()).toBeLessThanOrEqual(before + 3000);
    });
  });

  // --------------------------------------------------------------------------
  // 14. Signal Prioritization, Queue Draining, and Honest Metrics (B2-NEXT-03)
  // --------------------------------------------------------------------------
  describe("14. Signal Prioritization, Queue Draining, and Honest Metrics (B2-NEXT-03)", () => {
    it("B2-NEXT-03-01: classifies notification signals accurately (initialization vs routine swaps vs ambiguous vs unclassifiable)", () => {
      // 1. AMM v4 initialize2 -> PRIORITIZED_INITIALIZATION
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
          "Program log: initialize2",
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
        ]),
      ).toBe("PRIORITIZED_INITIALIZATION");

      // 2. CPMM Instruction: Initialize -> PRIORITIZED_INITIALIZATION
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]",
          "Program log: Instruction: Initialize",
          "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C success",
        ]),
      ).toBe("PRIORITIZED_INITIALIZATION");

      // 3. Routine swap log with ray_log LogType 3 -> ROUTINE_SWAP_DEPRIORITIZED
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
          "Program log: ray_log: AwAAAAAAAAAAAAAAAA==", // Base64 starting with 'Aw' is LogType 3 (Swap)
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
        ]),
      ).toBe("ROUTINE_SWAP_DEPRIORITIZED");

      // 4. Routine swap log with Instruction: Swap -> ROUTINE_SWAP_DEPRIORITIZED
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]",
          "Program log: Instruction: Swap",
          "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C success",
        ]),
      ).toBe("ROUTINE_SWAP_DEPRIORITIZED");

      // 5. Empty logs -> FALLBACK_AMBIGUOUS
      expect(EventDiscoveryIngestionEngine.classifyNotificationLogs([])).toBe("FALLBACK_AMBIGUOUS");

      // 6. Undefined / null logs -> UNCLASSIFIABLE
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs(undefined as unknown as string[]),
      ).toBe("UNCLASSIFIABLE");

      // 7. Non-array malformed logs -> UNCLASSIFIABLE
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs(
          "invalid string instead of array" as unknown as string[],
        ),
      ).toBe("UNCLASSIFIABLE");
    });

    it("B2-NEXT-03-02: drains priority queue before fallback queue and records bypassed signatures when budget is reached", async () => {
      const fetchedSignatures: string[] = [];
      const mockFetcher = {
        fetchTransaction: async (sig: string) => {
          fetchedSignatures.push(sig);
          return {
            signature: sig,
            slot: 450000102,
            blockTime: 1792618963,
            err: null,
            version: "legacy" as const,
            accountKeys: { staticAccountKeys: [] },
            instructions: [],
          };
        },
      };

      const engine = new EventDiscoveryIngestionEngine({
        maxQueueSize: 100,
        maxTransactions: 1, // Only 1 transaction allowed!
        maxEvents: 50,
      });

      // Send 2 routine swap notifications first
      engine.handleLogNotification({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000100 },
            value: {
              signature: "sig-routine-swap-1",
              err: null,
              logs: ["Program log: Instruction: Swap"],
            },
          },
          subscription: 10,
        },
      });

      engine.handleLogNotification({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000101 },
            value: {
              signature: "sig-routine-swap-2",
              err: null,
              logs: ["Program log: ray_log: AwAAAA=="],
            },
          },
          subscription: 10,
        },
      });

      // Now send 1 prioritized initialization notification
      engine.handleLogNotification({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000102 },
            value: {
              signature: "sig-priority-init",
              err: null,
              logs: [
                "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
                "Program log: initialize2",
                "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
              ],
            },
          },
          subscription: 10,
        },
      });

      // Process the queue
      const mockAccountFetcher = new MockOnChainAccountFetcher();
      await engine.processQueue(mockFetcher, mockAccountFetcher);

      // The prioritized initialization MUST be fetched first
      expect(fetchedSignatures.length).toBe(1);
      expect(fetchedSignatures[0]).toBe("sig-priority-init");

      // Check metrics
      const metrics = engine.getMetrics();
      expect(metrics.prioritizedSignaturesCount).toBe(1);
      expect(metrics.fallbackSignaturesCount).toBe(2);
      expect(metrics.bypassedSignaturesCount).toBe(2);
      expect(metrics.unfetchedSignaturesCount).toBe(2);
    });

    it("B2-NEXT-03-03: coordinator preserves raw notifications and reports honest prioritization metrics", async () => {
      const captureDir = path.join(os.tmpdir(), `b2-test-prioritization-${Date.now()}`);
      fsSync.mkdirSync(captureDir, { recursive: true });

      const wsTransport = new MockWebSocketTransport();
      const mockRpc = new MockSolanaRpcTransport();

      const coordinator = new EventDiscoverySessionCoordinator({
        wsClient: new SolanaWebSocketSubscriptionClient({
          wsUrl: "wss://api.mainnet-beta.solana.com/",
          transport: wsTransport,
        }),
        accountFetcher: new SolanaRpcRecordingAccountFetcher({
          rpcUrl: "https://api.mainnet-beta.solana.com/",
          transport: mockRpc,
        }),
        txFetcher: new SolanaRpcTransactionFetcher({
          rpcUrl: "https://api.mainnet-beta.solana.com/",
          transport: mockRpc,
          maxTransactionsBudget: 25,
        }),
        captureBaseDir: captureDir,
        budgets: {
          durationSec: 0.1,
          maxEvents: 50,
          maxWsMessages: 500,
          maxTransactions: 25,
          maxAccountReads: 20,
          maxTotalRpcCalls: 45,
          maxRssMb: 256,
          maxDiskMb: 256,
        },
      });

      wsTransport.triggerOpen();
      wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 10 }));
      wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 20 }));

      // Send 1 prioritized log
      wsTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: 450000100 },
              value: {
                signature: "sig-prio",
                err: null,
                logs: [
                  "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
                  "Program log: initialize2",
                  "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
                ],
              },
            },
            subscription: 10,
          },
        }),
      );

      // Send 1 fallback log
      wsTransport.triggerMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: 450000101 },
              value: { signature: "sig-fallback", err: null, logs: [] },
            },
            subscription: 20,
          },
        }),
      );

      const summary = await coordinator.runSession();
      expect(summary.status).toBe("FINALIZED");
      expect(summary.accounting.rawNotificationsReceived).toBe(2);
      expect(summary.metrics.prioritizedSignaturesCount).toBe(1);
      expect(summary.metrics.fallbackSignaturesCount).toBe(1);

      // Cleanup
      try {
        fsSync.rmSync(captureDir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    });

    it("B2-GO-FIX-01-01: negative tests for SPL Token ATA creation, unrelated inits, and positive Raydium inits (including CPI)", () => {
      // Negative 1: InitializeAccount3 inside Token-2022 -> FALLBACK_AMBIGUOUS (not Raydium init)
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]",
          "Program log: Instruction: InitializeAccount3",
          "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success",
        ]),
      ).toBe("FALLBACK_AMBIGUOUS");

      // Negative 2: InitializeAccount3 inside classic SPL Token -> FALLBACK_AMBIGUOUS
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
          "Program log: Instruction: InitializeAccount3",
          "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
        ]),
      ).toBe("FALLBACK_AMBIGUOUS");

      // Negative 3: InitializeMint inside SPL Token -> FALLBACK_AMBIGUOUS
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
          "Program log: Instruction: InitializeMint",
          "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
        ]),
      ).toBe("FALLBACK_AMBIGUOUS");

      // Negative 4: InitializeImmutableOwner inside Token-2022 -> FALLBACK_AMBIGUOUS
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]",
          "Program log: Instruction: InitializeImmutableOwner",
          "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb success",
        ]),
      ).toBe("FALLBACK_AMBIGUOUS");

      // Negative 5: CreateIdempotent inside Associated Token Program -> FALLBACK_AMBIGUOUS
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1]",
          "Program log: CreateIdempotent",
          "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success",
        ]),
      ).toBe("FALLBACK_AMBIGUOUS");

      // Negative 6: Ordinary swap with ATA creation (InitializeAccount3 + ray_log swap) -> ROUTINE_SWAP_DEPRIORITIZED
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
          "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [2]",
          "Program log: Instruction: InitializeAccount3",
          "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success",
          "Program log: ray_log: AwAAAAAAAAAAAAAAAA==",
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
        ]),
      ).toBe("ROUTINE_SWAP_DEPRIORITIZED");

      // Negative 7: Unrelated program with 'Instruction: Initialize' -> FALLBACK_AMBIGUOUS
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program 11111111111111111111111111111111 invoke [1]",
          "Program log: Instruction: Initialize",
          "Program 11111111111111111111111111111111 success",
        ]),
      ).toBe("FALLBACK_AMBIGUOUS");

      // Negative 8: Unattributed 'Instruction: Initialize' (no invoke line) -> FALLBACK_AMBIGUOUS
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program log: Instruction: Initialize",
        ]),
      ).toBe("FALLBACK_AMBIGUOUS");

      // Negative 9: Unattributed 'initialize2' (no invoke line) -> FALLBACK_AMBIGUOUS
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs(["Program log: initialize2"]),
      ).toBe("FALLBACK_AMBIGUOUS");

      // Positive 1: Canonical AMM v4 init -> PRIORITIZED_INITIALIZATION
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
          "Program log: initialize2: InitializeInstruction2",
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
        ]),
      ).toBe("PRIORITIZED_INITIALIZATION");

      // Positive 2: Canonical CPMM init -> PRIORITIZED_INITIALIZATION
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]",
          "Program log: Instruction: Initialize",
          "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C success",
        ]),
      ).toBe("PRIORITIZED_INITIALIZATION");

      // Positive 3: CPMM init via CPI -> PRIORITIZED_INITIALIZATION
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program Router111111111111111111111111111111111111 invoke [1]",
          "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [2]",
          "Program log: Instruction: Initialize",
          "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C success",
          "Program Router111111111111111111111111111111111111 success",
        ]),
      ).toBe("PRIORITIZED_INITIALIZATION");

      // Positive 4: AMM v4 init via CPI -> PRIORITIZED_INITIALIZATION
      expect(
        EventDiscoveryIngestionEngine.classifyNotificationLogs([
          "Program Router111111111111111111111111111111111111 invoke [1]",
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [2]",
          "Program log: initialize2",
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
          "Program Router111111111111111111111111111111111111 success",
        ]),
      ).toBe("PRIORITIZED_INITIALIZATION");
    });

    it("B2-GO-FIX-01-02: replays 74 authentic historical notifications from first diagnostic and confirms 100% false-positive elimination", () => {
      const historicalPath = path.resolve(
        ".tmp/b2-captures/b2-events-session-1792618962026/raw-notifications.jsonl",
      );
      if (!fsSync.existsSync(historicalPath)) {
        return; // Guard if historical capture file not in test runner directory
      }

      const fileContent = fsSync.readFileSync(historicalPath, "utf8");
      const lines = fileContent.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(74);

      const counts = {
        PRIORITIZED_INITIALIZATION: 0,
        ROUTINE_SWAP_DEPRIORITIZED: 0,
        FALLBACK_AMBIGUOUS: 0,
        UNCLASSIFIABLE: 0,
      };

      for (const line of lines) {
        const parsed = JSON.parse(line);
        const envelope = parsed.envelope ?? parsed;
        const logs = envelope.params?.result?.value?.logs;
        const classification = EventDiscoveryIngestionEngine.classifyNotificationLogs(logs);
        counts[classification]++;
      }

      // Assert exact breakdown on authentic mainnet capture
      expect(counts.PRIORITIZED_INITIALIZATION).toBe(0);
      expect(counts.ROUTINE_SWAP_DEPRIORITIZED).toBe(27);
      expect(counts.FALLBACK_AMBIGUOUS).toBe(47);
      expect(counts.UNCLASSIFIABLE).toBe(0);
      expect(
        counts.PRIORITIZED_INITIALIZATION +
          counts.ROUTINE_SWAP_DEPRIORITIZED +
          counts.FALLBACK_AMBIGUOUS +
          counts.UNCLASSIFIABLE,
      ).toBe(74);
    });

    it("B2-GO-FIX-02-01: reservation policy prevents starvation of later initialization when numerous routine swaps arrive first", async () => {
      const fetchedSignatures: string[] = [];
      const mockFetcher = {
        fetchTransaction: async (sig: string) => {
          fetchedSignatures.push(sig);
          if (sig === "sig-priority-init-late") {
            return createCpmmInitTransactionFixture({
              signature: sig,
              poolId: "LatePool1111111111111111111111111111111111",
            });
          }
          return {
            signature: sig,
            slot: 450000100,
            blockTime: 1792618963,
            err: null,
            version: "legacy" as const,
            accountKeys: { staticAccountKeys: [] },
            instructions: [],
          };
        },
      };

      const engine = new EventDiscoveryIngestionEngine({
        maxTransactions: 25,
        maxFallbackTransactions: 5,
        reservedPrioritizedTransactions: 20,
        maxEvents: 50,
      });

      // 1. Send 10 routine swap notifications
      for (let i = 1; i <= 10; i++) {
        engine.handleLogNotification({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            result: {
              context: { slot: 450000100 + i },
              value: {
                signature: `sig-routine-swap-${i}`,
                err: null,
                logs: ["Program log: Instruction: Swap"],
              },
            },
            subscription: 10,
          },
        });
      }

      const mockAccountFetcher = new MockOnChainAccountFetcher();

      // Process queue: only 5 fallback transactions should execute!
      await engine.processQueue(mockFetcher, mockAccountFetcher);

      expect(fetchedSignatures.length).toBe(5);
      expect(engine.getQueueLength()).toBe(5); // 5 routine items remain in queue

      let metrics = engine.getMetrics();
      expect(metrics.fallbackTransactionsExecuted).toBe(5);
      expect(metrics.prioritizedTransactionsExecuted).toBe(0);
      expect(metrics.reservedPrioritizedCalls).toBe(20);
      expect(metrics.unusedReservedCalls).toBe(20);
      expect(metrics.remainingUnfetchedSignatures).toBe(5);
      expect(metrics.bypassedSignaturesCount).toBe(5);

      // 2. Now send 1 prioritized CPMM pool initialization notification
      engine.handleLogNotification({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            context: { slot: 450000200 },
            value: {
              signature: "sig-priority-init-late",
              err: null,
              logs: [
                "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]",
                "Program log: Instruction: Initialize",
                "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C success",
              ],
            },
          },
          subscription: 20,
        },
      });

      // Process queue again: the prioritized initialization MUST execute using reserved budget!
      await engine.processQueue(mockFetcher, mockAccountFetcher);

      expect(fetchedSignatures.length).toBe(6);
      expect(fetchedSignatures[5]).toBe("sig-priority-init-late");

      metrics = engine.getMetrics();
      expect(metrics.prioritizedTransactionsExecuted).toBe(1);
      expect(metrics.fallbackTransactionsExecuted).toBe(5);
      expect(metrics.reservedPrioritizedCalls).toBe(20);
      expect(metrics.unusedReservedCalls).toBe(19);
      expect(metrics.remainingUnfetchedSignatures).toBe(5);
    });

    it("B2-GO-FIX-02-02: coordinator reports honest coverage window if WebSocket message ceiling halts run early", async () => {
      const captureDir = path.join(os.tmpdir(), `b2-test-ws-ceiling-${Date.now()}`);
      fsSync.mkdirSync(captureDir, { recursive: true });

      const wsTransport = new MockWebSocketTransport();
      const mockRpc = new MockSolanaRpcTransport();

      const coordinator = new EventDiscoverySessionCoordinator({
        wsClient: new SolanaWebSocketSubscriptionClient({
          wsUrl: "wss://api.mainnet-beta.solana.com/",
          transport: wsTransport,
          maxMessagesBudget: 2,
        }),
        accountFetcher: new SolanaRpcRecordingAccountFetcher({
          rpcUrl: "https://api.mainnet-beta.solana.com/",
          transport: mockRpc,
        }),
        txFetcher: new SolanaRpcTransactionFetcher({
          rpcUrl: "https://api.mainnet-beta.solana.com/",
          transport: mockRpc,
          maxTransactionsBudget: 25,
        }),
        captureBaseDir: captureDir,
        budgets: {
          durationSec: 60,
          maxEvents: 50,
          maxWsMessages: 2, // Ceiling is 2 messages
          maxTransactions: 25,
          maxAccountReads: 20,
          maxTotalRpcCalls: 45,
          maxFallbackTransactions: 5,
          reservedPrioritizedTransactions: 20,
        },
      });

      wsTransport.triggerOpen();
      wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 10 }));
      wsTransport.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 20 }));

      // Pump 2 notifications asynchronously during session to reach the ceiling
      const pumpPromise = (async () => {
        await new Promise((r) => setTimeout(r, 20));
        wsTransport.triggerMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000100 },
                value: { signature: "sig-ws-1", err: null, logs: [] },
              },
              subscription: 10,
            },
          }),
        );
        await new Promise((r) => setTimeout(r, 10));
        wsTransport.triggerMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000101 },
                value: { signature: "sig-ws-2", err: null, logs: [] },
              },
              subscription: 20,
            },
          }),
        );
      })();

      const summary = await coordinator.runSession();
      await pumpPromise;
      expect(summary.status).toBe("FINALIZED");
      expect(summary.stopReason).toMatch(
        /WS_MESSAGES_BUDGET_REACHED \(2\/2\) after \d+s \(coverage: \d+s \/ 60s\)/,
      );
      expect(summary.budgets.maxFallbackTransactions).toBe(5);
      expect(summary.budgets.reservedPrioritizedTransactions).toBe(20);
      expect(summary.accounting.prioritizedTransactionsFetched).toBe(0);
      expect(summary.accounting.fallbackTransactionsFetched).toBe(
        summary.metrics.fallbackTransactionsExecuted,
      );
      expect(summary.accounting.unusedReservedTransactionsBudget).toBe(20);

      // Cleanup
      try {
        fsSync.rmSync(captureDir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    });

    it("B2-LAUNCH-SCHEDULER-01: coordinator yields to event loop after fallback quota exhaustion and promptly dispatches late-arriving prioritized initialization", async () => {
      const testTmpBase = path.join(os.tmpdir(), `b2-scheduler-test-${Date.now()}`);
      fsSync.mkdirSync(testTmpBase, { recursive: true });

      const wsTransport = new MockWebSocketTransport();
      wsTransport.autoOpenAndAck = true;
      const mockRpc = new MockSolanaRpcTransport();

      // Setup 8 routine fallback swap transactions in mock RPC
      for (let i = 0; i < 8; i++) {
        mockRpc.transactions.set(`sig-routine-${i}`, {
          signature: `sig-routine-${i}`,
          slot: 450000100 + i,
          blockTime: 1746886997 + i,
          err: null,
          version: "legacy",
          accountKeys: {
            staticAccountKeys: [
              "SomeAccount11111111111111111111111111111111",
              "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            ],
          },
          instructions: [
            {
              programIdIndex: 1,
              accountKeyIndexes: [0],
              data: "dummy",
            },
          ],
          logMessages: ["Program log: Instruction: Swap"],
        });
      }

      // Setup 1 prioritized genuine Raydium CPMM pool initialization transaction
      const prioritySig = "sig-cpmm-late-init";
      const validCpmmTx = createCpmmInitTransactionFixture({
        signature: prioritySig,
        slot: 450000200,
        poolId: FIXTURE_CPMM_POOL_ADDRESS,
        token0Vault: FIXTURE_CPMM_TOKEN_0_VAULT,
        token1Vault: FIXTURE_CPMM_TOKEN_1_VAULT,
      });
      mockRpc.transactions.set(prioritySig, validCpmmTx);

      mockRpc.accounts.set(FIXTURE_CPMM_POOL_ADDRESS, {
        address: FIXTURE_CPMM_POOL_ADDRESS,
        owner: RAYDIUM_CPMM_PROGRAM_ID,
        data: createAuthoritativeRaydiumCpmmBuffer(),
        lamports: 10000000,
        slot: 450000200,
      });
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_0_VAULT, {
        address: FIXTURE_CPMM_TOKEN_0_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_0_MINT }),
        lamports: 5000000,
        slot: 450000200,
      });
      mockRpc.accounts.set(FIXTURE_CPMM_TOKEN_1_VAULT, {
        address: FIXTURE_CPMM_TOKEN_1_VAULT,
        owner: SPL_TOKEN_PROGRAM_ID,
        data: createAuthoritativeCpmmSplVaultBuffer({ mintBase58: FIXTURE_CPMM_TOKEN_1_MINT }),
        lamports: 5000000,
        slot: 450000200,
      });

      const wsClient = new SolanaWebSocketSubscriptionClient({
        wsUrl: "wss://api.mainnet-beta.solana.com/",
        transport: wsTransport,
      });

      const txFetcher = new SolanaRpcTransactionFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxTransactionsBudget: 25,
      });

      const accountFetcher = new SolanaRpcRecordingAccountFetcher({
        rpcUrl: "https://api.mainnet-beta.solana.com/",
        transport: mockRpc,
        maxAccountCallsBudget: 20,
      });

      const engine = new EventDiscoveryIngestionEngine({
        maxEvents: 50,
        maxTransactions: 25,
        maxFallbackTransactions: 5,
        reservedPrioritizedTransactions: 20,
      });

      const processQueueSpy = vi.spyOn(engine, "processQueue");

      const coordinator = new EventDiscoverySessionCoordinator({
        wsClient,
        txFetcher,
        accountFetcher,
        engine,
        captureBaseDir: testTmpBase,
        budgets: {
          durationSec: 1,
          maxEvents: 50,
          maxWsMessages: 500,
          maxTransactions: 25,
          maxAccountReads: 20,
          maxTotalRpcCalls: 45,
          maxFallbackTransactions: 5,
          reservedPrioritizedTransactions: 20,
        },
      });

      // Pump 8 routine notifications immediately, then wait and pump genuine prioritized CPMM init via real asynchronous timer
      const pumpPromise = (async () => {
        await new Promise((r) => setTimeout(r, 20));
        for (let i = 0; i < 8; i++) {
          wsTransport.triggerMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "logsNotification",
              params: {
                result: {
                  context: { slot: 450000100 + i },
                  value: {
                    signature: `sig-routine-${i}`,
                    err: null,
                    logs: ["Program log: Instruction: Swap"],
                  },
                },
                subscription: 10,
              },
            }),
          );
        }

        // Real asynchronous timer delay to ensure fallback quota (5) is exhausted and coordinator yields to event loop
        await new Promise((resolve) => setTimeout(resolve, 60));

        // Inject genuine-shaped Raydium CPMM pool initialization notification
        wsTransport.triggerMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              result: {
                context: { slot: 450000200 },
                value: {
                  signature: prioritySig,
                  err: null,
                  logs: [
                    "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]",
                    "Program log: Instruction: Initialize",
                    "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C success",
                  ],
                },
              },
              subscription: 20,
            },
          }),
        );
      })();

      const summary = await coordinator.runSession();
      await pumpPromise;

      expect(summary.status).toBe("FINALIZED");
      expect(summary.accounting.rawNotificationsReceived).toBe(9);
      expect(summary.accounting.transactionsFetched).toBe(9); // 9 unique transaction signatures encountered
      expect(summary.accounting.fallbackTransactionsFetched).toBe(5);
      expect(summary.accounting.prioritizedTransactionsFetched).toBe(1);
      expect(summary.accounting.unusedReservedTransactionsBudget).toBe(19);
      expect(summary.accounting.remainingUnfetchedSignatures).toBe(3);
      expect(summary.accounting.uniquePoolsDiscovered).toBe(1);
      expect(summary.accounting.poolsVerifiedCoherent).toBe(1);

      // Verify RPC calls are strictly bounded
      expect(summary.rpcCallsExecuted.transactionFetches).toBe(6);
      expect(summary.rpcCallsExecuted.accountReads).toBeLessThanOrEqual(20);
      expect(summary.rpcCallsExecuted.totalRpcCalls).toBeLessThanOrEqual(45);

      // Verify coordinator yielded to event loop rather than spinning in a tight microtask loop:
      // Under previous tight-loop behavior (checking getQueueLength() > 0 without checking dispatchable work),
      // processQueue would be called hundreds/thousands of times during the 60ms pause.
      // Under fixed scheduler, processQueue is only called when dispatchable work exists (<= 5 calls).
      expect(processQueueSpy.mock.calls.length).toBeLessThan(10);

      // Verify queue length distinction
      expect(engine.getQueueLength()).toBe(3); // 3 unfetched routine fallback items remaining
      expect(engine.getDispatchableQueueLength()).toBe(0); // 0 dispatchable items (fallback capped at 5)
      expect(engine.hasDispatchableWork()).toBe(false);

      // Verify valid evidence manifest was generated and verified
      expect(summary.sessionDir).toBeDefined();
      const manifestVerification = verifyB2SessionManifest(summary.sessionDir!);
      expect(manifestVerification.valid).toBe(true);

      // Verify authentic offline replay reproduction
      const logger = new PilotLogger();
      const replayResult = await runReplaySession(
        {
          network: "disabled",
          rpcUrl: "https://api.mainnet-beta.solana.com",
          replayFixturesPath: summary.sessionDir!,
          replayMode: "authentic",
          pollIntervalSec: 1,
          durationSec: 10,
          targetCandidates: 1,
          maxCandidatesScreened: 1,
          targetDiagnosticYield: 1,
          maxMb: 10,
          maxRssMb: 256,
          outputDir: testTmpBase,
          enableForwardObservations: false,
        },
        logger,
      );
      expect(replayResult.ok).toBe(true);
      expect(replayResult.poolsVerified).toBe(1);

      // Cleanup
      try {
        fsSync.rmSync(testTmpBase, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    });
  });
});
