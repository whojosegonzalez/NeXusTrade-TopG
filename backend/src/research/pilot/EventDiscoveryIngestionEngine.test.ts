/**
 * Phase 12.94-D Milestone D.2.9-A: Event Discovery Ingestion Engine Tests
 *
 * Verifies the offline event-driven discovery pipeline:
 * 1. Typed WebSocket log-notification envelope processing and idempotent signature deduplication.
 * 2. Bounded queue capacity and backpressure policies (DROP_OLDEST vs DROP_NEWEST).
 * 3. Transaction retrieval retry accounting and failure semantics.
 * 4. WebSocket connection lifecycle, reconnect simulation, gap detection, and backfill tracking.
 * 5. End-to-end queue processing and honest coverage/causality metrics accounting.
 */

import { describe, expect, it } from "vitest";
import type { VersionedTransactionMetadata } from "./EventDiscoveryContracts.js";
import {
  EventDiscoveryIngestionEngine,
  type ITransactionFetcher,
} from "./EventDiscoveryIngestionEngine.js";
import {
  createAmmV4InitTransactionFixture,
  createAuthoritativeCpmmSplVaultBuffer,
  createCpmmInitTransactionFixture,
  createMockLogNotificationEnvelope,
  MockOnChainAccountFetcher,
} from "./fixtures/AuthoritativeEventFixtures.js";
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
  createAuthoritativeRaydiumCpmmBuffer,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_1_MINT,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
} from "./fixtures/AuthoritativeCpmmFixtures.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "./RaydiumAmmParser.js";
import { RAYDIUM_CPMM_PROGRAM_ID } from "./RaydiumCpmmParser.js";

/**
 * Mock transaction fetcher for deterministic testing.
 */
class MockTransactionFetcher implements ITransactionFetcher {
  private readonly txMap = new Map<string, VersionedTransactionMetadata>();
  private readonly failCounts = new Map<string, number>();

  public setTransaction(tx: VersionedTransactionMetadata): void {
    this.txMap.set(tx.signature, tx);
  }

  public setTransientFailures(signature: string, failuresRemaining: number): void {
    this.failCounts.set(signature, failuresRemaining);
  }

  public async fetchTransaction(signature: string): Promise<VersionedTransactionMetadata | null> {
    const remaining = this.failCounts.get(signature) ?? 0;
    if (remaining > 0) {
      this.failCounts.set(signature, remaining - 1);
      return null;
    }
    return this.txMap.get(signature) ?? null;
  }
}

describe("Milestone D.2.9-A: Event Discovery Ingestion Engine Tests", () => {
  // --------------------------------------------------------------------------
  // 1. Log Notification Ingestion & Idempotent Deduplication (D29-A1)
  // --------------------------------------------------------------------------
  describe("1. Log Notification Ingestion & Idempotent Deduplication", () => {
    it("enqueues valid notification and ignores duplicate signatures idempotently", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxQueueSize: 10 });
      const envelope1 = createMockLogNotificationEnvelope("sig_canonical_1", 300000100);

      const res1 = await engine.handleLogNotification(envelope1);
      expect(res1.enqueued).toBe(true);
      expect(engine.getQueueLength()).toBe(1);

      // Re-send identical signature
      const res2 = await engine.handleLogNotification(envelope1);
      expect(res2.enqueued).toBe(false);
      expect(res2.reason).toBe("DUPLICATE_SIGNATURE");
      expect(engine.getQueueLength()).toBe(1); // Queue unchanged

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.rawLogNotificationsReceived).toBe(2);
      expect(metrics.uniqueTransactionsEncountered).toBe(1);
      expect(metrics.duplicateNotificationsIgnored).toBe(1);
    });

    it("rejects failed transactions early without enqueueing", async () => {
      const engine = new EventDiscoveryIngestionEngine();
      const failedEnvelope = createMockLogNotificationEnvelope("sig_failed_tx", 300000100, {
        InstructionError: [0, "Custom"],
      });

      const res = await engine.handleLogNotification(failedEnvelope);
      expect(res.enqueued).toBe(false);
      expect(res.reason).toBe("FAILED_TRANSACTION");
      expect(engine.getQueueLength()).toBe(0);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.failedInitDecodes).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Bounded Queue & Backpressure Policies (D29-A1)
  // --------------------------------------------------------------------------
  describe("2. Bounded Queue & Backpressure Policies", () => {
    it("enforces DROP_OLDEST policy when queue capacity is reached", async () => {
      const engine = new EventDiscoveryIngestionEngine({
        maxQueueSize: 2,
        backpressurePolicy: "DROP_OLDEST",
      });

      await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_1"));
      await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_2"));
      expect(engine.getQueueLength()).toBe(2);

      // 3rd notification drops oldest (sig_1)
      const res3 = await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_3"));
      expect(res3.enqueued).toBe(true);
      expect(engine.getQueueLength()).toBe(2);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.queueFullDrops).toBe(1);
    });

    it("enforces DROP_NEWEST policy when queue capacity is reached", async () => {
      const engine = new EventDiscoveryIngestionEngine({
        maxQueueSize: 2,
        backpressurePolicy: "DROP_NEWEST",
      });

      await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_1"));
      await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_2"));
      expect(engine.getQueueLength()).toBe(2);

      // 3rd notification is rejected
      const res3 = await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_3"));
      expect(res3.enqueued).toBe(false);
      expect(res3.reason).toBe("QUEUE_FULL_DROP_NEWEST");
      expect(engine.getQueueLength()).toBe(2);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.queueFullDrops).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Retry Accounting & Transient Failures (D29-A1)
  // --------------------------------------------------------------------------
  describe("3. Retry Accounting & Transient Failures", () => {
    it("retries transient transaction fetch failures and succeeds within retry budget", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxRetriesPerTx: 3 });
      const tx = createAmmV4InitTransactionFixture({ signature: "sig_transient_amm" });
      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx);
      txFetcher.setTransientFailures("sig_transient_amm", 2); // Fails twice, succeeds on 3rd

      const accountFetcher = new MockOnChainAccountFetcher();
      accountFetcher.setAccount(
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
      );
      accountFetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      );
      accountFetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      );

      await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_transient_amm"));

      const results = await engine.processQueue(txFetcher, accountFetcher);
      expect(results.length).toBe(1);
      expect(results[0]!.verified).toBe(true);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.transactionFetchFailures).toBe(0);
      expect(metrics.successfulInitDecodes).toBe(1);
    });

    it("records transactionFetchFailures when exceeding max retry budget", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxRetriesPerTx: 2 });
      const txFetcher = new MockTransactionFetcher();
      // Permanently missing transaction
      const accountFetcher = new MockOnChainAccountFetcher();

      await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_perm_missing"));

      const results = await engine.processQueue(txFetcher, accountFetcher);
      expect(results.length).toBe(0);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.transactionFetchFailures).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Connection Lifecycle & Gap Backfill Simulation (D29-A1, D29-A5)
  // --------------------------------------------------------------------------
  describe("4. Connection Lifecycle & Gap Backfill Simulation", () => {
    it("simulates WebSocket disconnect and reconnect with slot gap detection", () => {
      const engine = new EventDiscoveryIngestionEngine();
      engine.setConnectionStatus("SUBSCRIBED");

      // Simulate network disconnect
      engine.simulateDisconnect();
      expect(engine.getMetricsSnapshot().connectionStatus).toBe("RECONNECTING");
      expect(engine.getMetricsSnapshot().reconnectEvents).toBe(1);

      // Simulate reconnect across a 10-slot gap (slot 300000100 to 300000110)
      engine.simulateReconnect(300000100, 300000110);
      expect(engine.getMetricsSnapshot().connectionStatus).toBe("SUBSCRIBED");
      expect(engine.getMetricsSnapshot().detectedGaps).toBe(1);
      expect(engine.getMetricsSnapshot().boundedBackfillAttempts).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 5. End-to-End Processing & Honest Metrics Accounting (D29-A5)
  // --------------------------------------------------------------------------
  describe("5. End-to-End Processing & Honest Metrics Accounting", () => {
    it("processes heterogeneous AMM v4 and CPMM event stream and produces honest metrics snapshot", async () => {
      let currentMockTime = 1792375300000;
      const engine = new EventDiscoveryIngestionEngine({
        clock: { now: () => currentMockTime },
      });

      const cpmmVault0 = "9UYjh9A2dE1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R87";
      const cpmmVault1 = "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz38";

      const txAmm = createAmmV4InitTransactionFixture({
        signature: "sig_amm_v4_1",
        slot: 300000100,
        blockTime: 1792375290, // 10s prior
      });
      const txCpmm = createCpmmInitTransactionFixture({
        signature: "sig_cpmm_1",
        slot: 300000102,
        blockTime: 1792375295, // 5s prior
        token0Vault: cpmmVault0,
        token1Vault: cpmmVault1,
      });

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(txAmm);
      txFetcher.setTransaction(txCpmm);

      const accountFetcher = new MockOnChainAccountFetcher();
      // Setup AMM v4 accounts
      accountFetcher.setAccount(
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
        300000100,
      );
      accountFetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
        300000100,
      );
      accountFetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
        300000100,
      );

      // Setup CPMM accounts with independent vault addresses
      accountFetcher.setAccount(
        FIXTURE_CPMM_POOL_ADDRESS,
        RAYDIUM_CPMM_PROGRAM_ID,
        createAuthoritativeRaydiumCpmmBuffer({
          token0MintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
          token1MintBase58: FIXTURE_CPMM_TOKEN_1_MINT,
          token0VaultBase58: cpmmVault0,
          token1VaultBase58: cpmmVault1,
        }),
        300000105, // Slot delta = 3
      );
      accountFetcher.setAccount(
        cpmmVault0,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeCpmmSplVaultBuffer({
          mintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
          rawAmount: 10_000_000n,
        }),
        300000105,
      );
      accountFetcher.setAccount(
        cpmmVault1,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeCpmmSplVaultBuffer({
          mintBase58: FIXTURE_CPMM_TOKEN_1_MINT,
          rawAmount: 20_000_000n,
        }),
        300000105,
      );

      // Enqueue both log notifications
      await engine.handleLogNotification(
        createMockLogNotificationEnvelope("sig_amm_v4_1", 300000100),
      );
      await engine.handleLogNotification(
        createMockLogNotificationEnvelope("sig_cpmm_1", 300000102),
      );

      // Advance clock slightly for verification latency
      currentMockTime += 250;

      const results = await engine.processQueue(txFetcher, accountFetcher);

      expect(results.length).toBe(2);
      expect(results[0]!.verified).toBe(true);
      expect(results[0]!.protocol).toBe("RAYDIUM_AMM_V4");
      expect(results[1]!.verified).toBe(true);
      expect(results[1]!.protocol).toBe("RAYDIUM_CPMM");

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.rawLogNotificationsReceived).toBe(2);
      expect(metrics.uniqueTransactionsEncountered).toBe(2);
      expect(metrics.successfulInitDecodes).toBe(2);
      expect(metrics.candidatePoolsDiscovered).toBe(2);
      expect(metrics.duplicatePoolIdsIgnored).toBe(0);
      expect(metrics.coherentTierPoolsCount).toBe(2);
      expect(metrics.maxSlotDeltaObserved).toBe(3); // 300000105 - 300000102
      expect(metrics.slotDiscrepancyIncidents).toBe(0);
      expect(metrics.averageDetectionLatencyMs).toBeGreaterThan(0);
    });

    it("idempotently ignores duplicate pool IDs even across different transaction signatures", async () => {
      const engine = new EventDiscoveryIngestionEngine();

      // Two different tx signatures trying to initialize the SAME pool ID
      const tx1 = createAmmV4InitTransactionFixture({ signature: "sig_first" });
      const tx2 = createAmmV4InitTransactionFixture({ signature: "sig_second_same_pool" });

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx1);
      txFetcher.setTransaction(tx2);

      const accountFetcher = new MockOnChainAccountFetcher();
      accountFetcher.setAccount(
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
      );
      accountFetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      );
      accountFetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      );

      await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_first"));
      await engine.handleLogNotification(createMockLogNotificationEnvelope("sig_second_same_pool"));

      const results = await engine.processQueue(txFetcher, accountFetcher);

      // Only first pool is admitted and verified; second is dropped as duplicate pool ID
      expect(results.length).toBe(1);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.candidatePoolsDiscovered).toBe(1);
      expect(metrics.duplicatePoolIdsIgnored).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Lifecycle, Retry & Deduplication Invariants (D29-F5)
  // --------------------------------------------------------------------------
  describe("6. Lifecycle, Retry & Deduplication Invariants (D29-F5)", () => {
    it("admits and processes previously dropped event when re-observed after queue drain (D29-F5)", async () => {
      // Small queue with DROP_NEWEST backpressure
      const engine = new EventDiscoveryIngestionEngine({
        maxQueueSize: 1,
        backpressurePolicy: "DROP_NEWEST",
      });

      const env1 = createMockLogNotificationEnvelope("sig_first", 300000100);
      const env2 = createMockLogNotificationEnvelope("sig_dropped_then_reobserved", 300000101);

      // Enqueue first item (queue now full)
      const res1 = await engine.handleLogNotification(env1);
      expect(res1.enqueued).toBe(true);

      // Enqueue second item (dropped due to DROP_NEWEST)
      const res2 = await engine.handleLogNotification(env2);
      expect(res2.enqueued).toBe(false);
      expect(res2.reason).toBe("QUEUE_FULL_DROP_NEWEST");

      // Setup fixtures
      const tx1 = createAmmV4InitTransactionFixture({ signature: "sig_first" });
      const tx2 = createAmmV4InitTransactionFixture({
        signature: "sig_dropped_then_reobserved",
        poolId: "PoolReobserved111111111111111111111111111",
      });
      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx1);
      txFetcher.setTransaction(tx2);

      const accountFetcher = new MockOnChainAccountFetcher();
      accountFetcher.setAccount(
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
      );
      accountFetcher.setAccount(
        "PoolReobserved111111111111111111111111111",
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer({
          baseVaultBase58: FIXTURE_BASE_VAULT,
          quoteVaultBase58: FIXTURE_QUOTE_VAULT,
        }),
      );
      accountFetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      );
      accountFetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      );

      // Process queue to drain item 1
      const results1 = await engine.processQueue(txFetcher, accountFetcher);
      expect(results1.length).toBe(1);
      expect(engine.getQueueLength()).toBe(0);

      // Re-observe env2 (now that queue has space)
      const res3 = await engine.handleLogNotification(env2);
      expect(res3.enqueued).toBe(true); // NOT permanently suppressed!
      expect(engine.getQueueLength()).toBe(1);

      // Process queue to verify item 2
      const results2 = await engine.processQueue(txFetcher, accountFetcher);
      expect(results2.length).toBe(1);
      expect(results2[0]!.poolId).toBe("PoolReobserved111111111111111111111111111");
      expect(results2[0]!.verified).toBe(true);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.queueFullDrops).toBe(1);
      expect(metrics.candidatePoolsDiscovered).toBe(2);
      expect(metrics.coherentTierPoolsCount).toBe(2);
    });

    it("recovers from transient tx-fetch failures via retry accounting (D29-F5)", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxRetriesPerTx: 3 });
      const signature = "sig_transient_recovery";
      const tx = createAmmV4InitTransactionFixture({ signature });

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx);
      txFetcher.setTransientFailures(signature, 2); // Fails 2 times before success

      const accountFetcher = new MockOnChainAccountFetcher();
      accountFetcher.setAccount(
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
      );
      accountFetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      );
      accountFetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      );

      await engine.handleLogNotification(createMockLogNotificationEnvelope(signature));

      const results = await engine.processQueue(txFetcher, accountFetcher);
      expect(results.length).toBe(1);
      expect(results[0]!.verified).toBe(true);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.transactionFetchRetries).toBe(2);
      expect(metrics.transactionFetchFailures).toBe(0);
      expect(metrics.exhaustedRetriesCount).toBe(0);
      expect(metrics.coherentTierPoolsCount).toBe(1);
    });

    it("fails closed when fetched transaction signature mismatches notification signature (D29-F5)", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxRetriesPerTx: 1 });
      const expectedSig = "sig_expected_notification";
      // txFetcher returns a transaction with a rogue signature
      const rogueTx = createAmmV4InitTransactionFixture({ signature: "sig_rogue_different" });

      const txFetcher: ITransactionFetcher = {
        fetchTransaction: async () => rogueTx,
      };
      const accountFetcher = new MockOnChainAccountFetcher();

      await engine.handleLogNotification(createMockLogNotificationEnvelope(expectedSig));

      const results = await engine.processQueue(txFetcher, accountFetcher);
      expect(results.length).toBe(0); // Failed closed!

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.failedInitDecodes).toBe(1);
      expect(metrics.coherentTierPoolsCount).toBe(0);
    });

    it("halts processing and fails closed when transaction slot delta exceeds maxSlotDelta (D29-H2)", async () => {
      const engine = new EventDiscoveryIngestionEngine({
        maxRetriesPerTx: 1,
        maxSlotDelta: 100, // Maximum allowed slot delta is 100
      });
      const signature = "sig_slot_discrepant_tx";
      // Notification says slot 300000000
      const notificationSlot = 300000000;
      // Returned transaction has slot 300000500 (delta = 500 > 100)
      const tx = createAmmV4InitTransactionFixture({
        signature,
        slot: 300000500,
      });

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx);

      const accountFetcher = new MockOnChainAccountFetcher();
      accountFetcher.setAccount(
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
      );

      await engine.handleLogNotification(
        createMockLogNotificationEnvelope(signature, notificationSlot),
      );

      const results = await engine.processQueue(txFetcher, accountFetcher);

      // Ingestion must halt immediately: no pool verification dispatched or emitted
      expect(results.length).toBe(0);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.slotDiscrepancyIncidents).toBe(1);
      expect(metrics.slotDiscrepantTierCount).toBe(1);
      expect(metrics.candidatePoolsDiscovered).toBe(0);
      expect(metrics.successfulInitDecodes).toBe(0);
      expect(metrics.coherentTierPoolsCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Bounded Per-Event Verification Recovery (BREADY-04)
  // --------------------------------------------------------------------------
  describe("6. Bounded Per-Event Verification Recovery (BREADY-04)", () => {
    it("recovers transient verification failure on retry without duplicate counting", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxVerificationRetries: 3 });
      const signature = "sig_cpmm_transient_verify_fail";
      const tx = createCpmmInitTransactionFixture({ signature });

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx);

      // Flaky account fetcher: throws on first attempt, succeeds on second
      let attempts = 0;
      const cpmmPoolBuffer = createAuthoritativeRaydiumCpmmBuffer();
      const v0Buffer = createAuthoritativeCpmmSplVaultBuffer({
        mintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
      });
      const v1Buffer = createAuthoritativeCpmmSplVaultBuffer({
        mintBase58: FIXTURE_CPMM_TOKEN_1_MINT,
      });

      const flakyFetcher: MockOnChainAccountFetcher = new MockOnChainAccountFetcher(300000100);
      flakyFetcher.setAccount(FIXTURE_CPMM_POOL_ADDRESS, RAYDIUM_CPMM_PROGRAM_ID, cpmmPoolBuffer);
      flakyFetcher.setAccount(FIXTURE_CPMM_TOKEN_0_VAULT, SPL_TOKEN_PROGRAM_ID, v0Buffer);
      flakyFetcher.setAccount(FIXTURE_CPMM_TOKEN_1_VAULT, SPL_TOKEN_PROGRAM_ID, v1Buffer);

      const interceptingFetcher = {
        getAccountInfo: (a: string) => flakyFetcher.getAccountInfo(a),
        getMultipleAccounts: async (addrs: readonly string[]) => {
          attempts++;
          if (attempts === 1) {
            throw new Error("RPC 429 Too Many Requests");
          }
          return flakyFetcher.getMultipleAccounts(addrs);
        },
        getSlot: () => flakyFetcher.getSlot(),
      };

      await engine.handleLogNotification(createMockLogNotificationEnvelope(signature, 300000100));

      // Attempt 1: encounters transient RPC failure
      const results1 = await engine.processQueue(txFetcher, interceptingFetcher);
      expect(results1.length).toBe(0); // Event was not permanently dropped; placed in pending

      let metrics = engine.getMetricsSnapshot();
      expect(metrics.verificationRetries).toBe(1);
      expect(metrics.pendingVerificationsCount).toBe(1);
      expect(metrics.rpcVerificationFailures).toBe(0); // Not exhausted yet!

      // Attempt 2: recovery via retryPendingVerifications
      const recovered = await engine.retryPendingVerifications(interceptingFetcher);
      expect(recovered.length).toBe(1);
      expect(recovered[0]!.verified).toBe(true);
      expect(recovered[0]!.verificationTier).toBe("INDEPENDENTLY_COHERENT");

      metrics = engine.getMetricsSnapshot();
      expect(metrics.pendingVerificationsCount).toBe(0);
      expect(metrics.coherentTierPoolsCount).toBe(1);
      expect(metrics.candidatePoolsDiscovered).toBe(1); // Denominator not inflated!
    });

    it("exhausts retries and fails closed when verification failure persists", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxVerificationRetries: 2 });
      const signature = "sig_cpmm_permanent_fail";
      const tx = createCpmmInitTransactionFixture({ signature });

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx);

      const failingFetcher = {
        getAccountInfo: async () => null,
        getMultipleAccounts: async () => {
          throw new Error("Persistent network disconnect");
        },
        getSlot: async () => 300000100,
      };

      await engine.handleLogNotification(createMockLogNotificationEnvelope(signature, 300000100));

      // Attempt 1 (initial: retryCount=1 <= 2)
      await engine.processQueue(txFetcher, failingFetcher);
      expect(engine.getMetricsSnapshot().pendingVerificationsCount).toBe(1);

      // Attempt 2 (retry 1: retryCount=2 <= 2)
      await engine.retryPendingVerifications(failingFetcher);
      expect(engine.getMetricsSnapshot().pendingVerificationsCount).toBe(1);

      // Attempt 3 (retry 2: retryCount=3 > 2 => retries exhausted)
      const failedResults = await engine.retryPendingVerifications(failingFetcher);
      expect(failedResults.length).toBe(1);
      expect(failedResults[0]!.verified).toBe(false);
      expect(failedResults[0]!.rejectionReason).toContain("Verification retries exhausted (2)");

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.pendingVerificationsCount).toBe(0);
      expect(metrics.exhaustedVerificationRetriesCount).toBe(1);
      expect(metrics.rpcVerificationFailures).toBe(1);
      expect(metrics.coherentTierPoolsCount).toBe(0);
    });

    it("preserves successful events from multi-event transaction while recovering failing event", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxVerificationRetries: 3 });
      const signature = "sig_multi_event_tx";

      // Create transaction with 2 instructions
      const tx1 = createAmmV4InitTransactionFixture({
        signature,
        poolId: "PoolAMM111111111111111111111111111111111111",
      });
      const tx2 = createCpmmInitTransactionFixture({
        signature,
        poolId: "PoolCPMM22222222222222222222222222222222222",
      });

      // Merge into a multi-instruction transaction
      const keys = [
        ...Array.from(
          new Set([...tx1.accountKeys.staticAccountKeys, ...tx2.accountKeys.staticAccountKeys]),
        ),
      ];
      const inst0 = {
        ...tx1.instructions[0]!,
        programIdIndex: keys.indexOf(RAYDIUM_AMM_V4_PROGRAM_ID),
        accountKeyIndexes: tx1.instructions[0]!.accountKeyIndexes.map((i) =>
          keys.indexOf(tx1.accountKeys.staticAccountKeys[i]!),
        ),
      };
      const inst1 = {
        ...tx2.instructions[0]!,
        programIdIndex: keys.indexOf(RAYDIUM_CPMM_PROGRAM_ID),
        accountKeyIndexes: tx2.instructions[0]!.accountKeyIndexes.map((i) =>
          keys.indexOf(tx2.accountKeys.staticAccountKeys[i]!),
        ),
      };
      const mergedTx: VersionedTransactionMetadata = {
        ...tx1,
        instructions: [inst0, inst1],
        accountKeys: {
          staticAccountKeys: keys,
        },
      };

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(mergedTx);

      // Account fetcher: succeeds for AMM pool, throws for CPMM pool on first pass
      let cpmmAttempts = 0;
      const selectiveFetcher = {
        getAccountInfo: async () => null,
        getMultipleAccounts: async (addrs: readonly string[]) => {
          if (addrs.includes("PoolCPMM22222222222222222222222222222222222")) {
            cpmmAttempts++;
            if (cpmmAttempts === 1) {
              throw new Error("Transient RPC 503 for CPMM pool");
            }
            // Second attempt: succeeds
            return [
              {
                address: "PoolCPMM22222222222222222222222222222222222",
                data: createAuthoritativeRaydiumCpmmBuffer(),
                owner: RAYDIUM_CPMM_PROGRAM_ID,
                lamports: 10000000,
                slot: 300000100,
              },
              {
                address: FIXTURE_CPMM_TOKEN_0_VAULT,
                data: createAuthoritativeCpmmSplVaultBuffer({
                  mintBase58: FIXTURE_CPMM_TOKEN_0_MINT,
                }),
                owner: SPL_TOKEN_PROGRAM_ID,
                lamports: 2000000,
                slot: 300000100,
              },
              {
                address: FIXTURE_CPMM_TOKEN_1_VAULT,
                data: createAuthoritativeCpmmSplVaultBuffer({
                  mintBase58: FIXTURE_CPMM_TOKEN_1_MINT,
                }),
                owner: SPL_TOKEN_PROGRAM_ID,
                lamports: 2000000,
                slot: 300000100,
              },
            ];
          }
          // AMM pool accounts
          return [
            {
              address: "PoolAMM111111111111111111111111111111111111",
              data: createAuthoritativeRaydiumAmmV4Buffer(),
              owner: RAYDIUM_AMM_V4_PROGRAM_ID,
              lamports: 10000000,
              slot: 300000100,
            },
            {
              address: FIXTURE_BASE_VAULT,
              data: createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
              owner: SPL_TOKEN_PROGRAM_ID,
              lamports: 2000000,
              slot: 300000100,
            },
            {
              address: FIXTURE_QUOTE_VAULT,
              data: createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
              owner: SPL_TOKEN_PROGRAM_ID,
              lamports: 2000000,
              slot: 300000100,
            },
          ];
        },
        getSlot: async () => 300000100,
      };

      await engine.handleLogNotification(createMockLogNotificationEnvelope(signature, 300000100));

      // First pass: AMM succeeds immediately; CPMM is placed in pending
      const results1 = await engine.processQueue(txFetcher, selectiveFetcher);
      expect(results1.length).toBe(1);
      expect(results1[0]!.poolId).toBe("PoolAMM111111111111111111111111111111111111");
      expect(results1[0]!.verified).toBe(true);
      expect(engine.getMetricsSnapshot().pendingVerificationsCount).toBe(1);

      // Second pass: CPMM recovered without duplicating AMM
      const results2 = await engine.retryPendingVerifications(selectiveFetcher);
      expect(results2.length).toBe(1);
      expect(results2[0]!.poolId).toBe("PoolCPMM22222222222222222222222222222222222");
      expect(results2[0]!.verified).toBe(true);

      const metrics = engine.getMetricsSnapshot();
      expect(metrics.pendingVerificationsCount).toBe(0);
      expect(metrics.coherentTierPoolsCount).toBe(2);
      expect(metrics.candidatePoolsDiscovered).toBe(2);
    });
  });

  describe("7. Session Usage Ceilings (BREADY-05)", () => {
    it("enforces maxEvents session ceiling and rejects excess log notifications", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxEvents: 2 });

      const tx1 = createAmmV4InitTransactionFixture({
        signature: "sig_ceil_1",
        poolId: "PoolCeil11111111111111111111111111111111111",
      });
      const tx2 = createAmmV4InitTransactionFixture({
        signature: "sig_ceil_2",
        poolId: "PoolCeil22222222222222222222222222222222222",
      });

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx1);
      txFetcher.setTransaction(tx2);

      const accountFetcher = new MockOnChainAccountFetcher(300000100);
      accountFetcher.setAccount(
        "PoolCeil11111111111111111111111111111111111",
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
      );
      accountFetcher.setAccount(
        "PoolCeil22222222222222222222222222222222222",
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
      );
      accountFetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      );
      accountFetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      );

      const res1 = await engine.handleLogNotification(
        createMockLogNotificationEnvelope("sig_ceil_1", 300000100),
      );
      expect(res1.enqueued).toBe(true);

      const res2 = await engine.handleLogNotification(
        createMockLogNotificationEnvelope("sig_ceil_2", 300000100),
      );
      expect(res2.enqueued).toBe(true);

      // Process queue so that both initialization events are admitted and verified
      await engine.processQueue(txFetcher, accountFetcher);
      expect(engine.getDiscoveredEvents().length).toBe(2);

      // Third notification exceeds maxEvents ceiling because 2 events are already admitted
      const res3 = await engine.handleLogNotification(
        createMockLogNotificationEnvelope("sig_ceil_3", 300000100),
      );
      expect(res3.enqueued).toBe(false);
      expect(res3.reason).toBe("MAX_EVENTS_EXCEEDED");
    });

    it("enforces maxTransactions session ceiling and halts processing when budget exhausted", async () => {
      const engine = new EventDiscoveryIngestionEngine({ maxTransactions: 1 });

      const tx1 = createAmmV4InitTransactionFixture({ signature: "sig_tx_ceil_1" });
      const tx2 = createAmmV4InitTransactionFixture({ signature: "sig_tx_ceil_2" });

      const txFetcher = new MockTransactionFetcher();
      txFetcher.setTransaction(tx1);
      txFetcher.setTransaction(tx2);

      const accountFetcher = new MockOnChainAccountFetcher(300000100);
      accountFetcher.setAccount(
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
        createAuthoritativeRaydiumAmmV4Buffer(),
      );
      accountFetcher.setAccount(
        FIXTURE_BASE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_MEME_MINT }),
      );
      accountFetcher.setAccount(
        FIXTURE_QUOTE_VAULT,
        SPL_TOKEN_PROGRAM_ID,
        createAuthoritativeSplVaultBuffer({ mintBase58: FIXTURE_WSOL_MINT }),
      );

      await engine.handleLogNotification(
        createMockLogNotificationEnvelope("sig_tx_ceil_1", 300000100),
      );
      await engine.handleLogNotification(
        createMockLogNotificationEnvelope("sig_tx_ceil_2", 300000100),
      );

      const results = await engine.processQueue(txFetcher, accountFetcher);
      // Only 1 transaction fetched and processed
      expect(results.length).toBe(1);
      expect(results[0]!.poolId).toBe(FIXTURE_POOL_ADDRESS);
    });
  });
});
