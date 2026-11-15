import { describe, it, expect } from "vitest";
import {
  validateWatchedDiscoveryEvidence,
  evaluateWatchCandidateEvidence,
  executeWatchCandidateValidation,
  precheckExchangeFromEvidence,
  PROVISIONAL_TARGET_DISCLAIMER,
  DEFAULT_WATCH_VALIDATION_LIMITS,
} from "./AmmV4WatchCandidateValidation.js";
import {
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
  PLANNING_START_WINDOW,
  RPC_URL_PLACEHOLDER,
} from "../scripts/fresh-amm-v4-precheck.js";
import { WSOL_MINT } from "../research/pilot/RaydiumAmmParser.js";
import type {
  BoundedAmmV4CreationWatchResult,
  BoundedWatchApplicationFrame,
  BoundedWatchTerminationStatus,
} from "./BoundedAmmV4CreationWatch.js";
import {
  START_MS,
  TEST_RPC_URL,
  VirtualScheduler,
  drive,
  initTransactionResult,
  marketResponse,
  POOL,
  MINT,
} from "../scripts/fresh-amm-v4-precheck.test-support.js";

const VALID_SIG_A =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const VALID_SIG_B =
  "QHREMqhWG7eahNuQ2EzQqSYKLy8WH9jVerfLRJTttyPorHxQJDzMMcB1142poqJHzYyVSsijoS1U9222QBV6AbM";

function makeSyntheticWatchResult(overrides?: {
  status?: BoundedWatchTerminationStatus;
  cleanupSettled?: boolean;
  cleanupFailed?: boolean;
  cleanupFailureReason?: string;
  subscriptionId?: number;
  mismatchedObservationSubId?: number;
  mismatchedNotificationSignature?: string;
  mismatchedNotificationSlot?: number;
  signature?: string;
  slot?: number;
  receivedAtMs?: number;
  frames?: BoundedWatchApplicationFrame[];
  omitNotification?: boolean;
}): BoundedAmmV4CreationWatchResult {
  const subId = overrides?.subscriptionId ?? 42;
  const signature = overrides?.signature ?? VALID_SIG_A;
  const slot = overrides?.slot ?? 250_000;
  const receivedAtMs = overrides?.receivedAtMs ?? START_MS + 10_000;

  const defaultFrames: BoundedWatchApplicationFrame[] = [
    {
      direction: "OUTGOING",
      timestampMs: START_MS + 500,
      byteLength: 145,
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          { mentions: [RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION] },
          { commitment: "confirmed" },
        ],
      }),
      isComplete: true,
    },
    {
      direction: "INCOMING",
      timestampMs: START_MS + 600,
      byteLength: 42,
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: subId,
      }),
      isComplete: true,
    },
    {
      direction: "INCOMING",
      timestampMs: receivedAtMs,
      byteLength: 250,
      payload: JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: subId,
          result: {
            context: { slot },
            value: {
              err: null,
              signature,
              logs: ["Program log: initialize2"],
            },
          },
        },
      }),
      isComplete: true,
    },
  ];

  return {
    status: overrides?.status ?? "NOTIFICATION_CAPTURED",
    reason: "Synthetic test notification captured",
    notification: overrides?.omitNotification
      ? null
      : {
          signature: overrides?.mismatchedNotificationSignature ?? signature,
          slot: overrides?.mismatchedNotificationSlot ?? slot,
          receivedAtMs,
          logs: ["Program log: initialize2"],
          disclaimer:
            "PROVISIONAL: candidate discovered; does not establish pool creation, strategy eligibility, or qualified trading flow",
        },
    observations: {
      startedAtMs: START_MS,
      endedAtMs: receivedAtMs + 500,
      durationMs: receivedAtMs + 500 - START_MS,
      terminationStatus: overrides?.status ?? "NOTIFICATION_CAPTURED",
      terminationReason: "Synthetic",
      subscriptionId: overrides?.mismatchedObservationSubId ?? subId,
      messagesReceivedCount: 2,
      payloadBytesReceived: 292,
      clientPingsSentCount: 0,
      serverPingsReceivedCount: 0,
      pongsReceivedCount: 0,
      matchedPongsCount: 0,
      incomingControlFramesCount: 0,
      failedNotificationsCount: 0,
      rejectedNotificationsCount: 0,
      cleanupSettled: overrides?.cleanupSettled ?? true,
      cleanupFailed: overrides?.cleanupFailed ?? false,
      cleanupFailureReason: overrides?.cleanupFailureReason,
      applicationFrames: overrides?.frames ?? defaultFrames,
      events: [],
    },
  };
}

function makeMockFetch(
  sched: VirtualScheduler,
  options?: {
    rpcStatus?: number;
    rpcResponse?: unknown;
    marketStatus?: number;
    marketResponse?: unknown;
    delayMs?: number;
    onCall?: (info: { url: string; method: string; body: unknown }) => void;
  },
) {
  const delay = (signal?: AbortSignal | null) =>
    new Promise<void>((resolve, reject) => {
      const ms = options?.delayMs ?? 100;
      const id = sched.add(() => resolve(), ms, "harness");
      signal?.addEventListener(
        "abort",
        () => {
          sched.clear(id);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const isRpc = url.startsWith(TEST_RPC_URL);
    let parsedBody: unknown = null;
    if (init?.body) {
      try {
        parsedBody = JSON.parse(String(init.body));
      } catch {
        parsedBody = String(init.body);
      }
    }
    options?.onCall?.({ url, method: init?.method ?? "GET", body: parsedBody });
    await delay(init?.signal);

    if (isRpc) {
      const status = options?.rpcStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "RPC error" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      const reqId =
        parsedBody !== null &&
        typeof parsedBody === "object" &&
        "id" in parsedBody &&
        typeof (parsedBody as { id: unknown }).id === "number"
          ? (parsedBody as { id: number }).id
          : 1;

      const resp = options?.rpcResponse ?? {
        jsonrpc: "2.0",
        id: reqId,
        result: initTransactionResult({
          signature: VALID_SIG_A,
          slot: 250_000,
          blockTime: Math.floor(START_MS / 1000) - 300,
          openTime: Math.floor(START_MS / 1000) - 290,
        }),
      };
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } else {
      const status = options?.marketStatus ?? 200;
      if (status !== 200) {
        return new Response("Market error", { status });
      }
      const resp = options?.marketResponse ?? marketResponse(START_MS - 300_000);
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  }) as unknown as typeof fetch;
}

describe("AmmV4WatchCandidateValidation", () => {
  it("TC-V01: Happy path validation and target selection with distinct timestamps and exactly 2 HTTP requests", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const calls: { url: string; method: string }[] = [];
    const fetchFn = makeMockFetch(sched, {
      onCall: (c) => calls.push({ url: c.url, method: c.method }),
    });

    const watchResult = makeSyntheticWatchResult();
    const result = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: `${TEST_RPC_URL}/?key=secret-key-123`,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("TARGET_SELECTED");
    expect(result.httpAttempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain(TEST_RPC_URL);
    expect(calls[1]!.url).toContain("https://api.dexscreener.com/latest/dex/tokens/");

    // Check distinct timestamps
    expect(result.target).not.toBeNull();
    const target = result.target!;
    expect(target.poolId).toBe(POOL);
    expect(target.mintAddress).toBe(MINT);
    expect(target.quoteMint).toBe(WSOL_MINT);
    expect(target.orientation).toBe("CANDIDATE_BASE_WSOL_QUOTE");

    expect(target.initialization.signature).toBe(VALID_SIG_A);
    expect(target.initialization.slot).toBe(250_000);
    expect(target.initialization.transactionBlockTimeSec).toBe(Math.floor(START_MS / 1000) - 300);
    expect(target.initialization.instructionRequestedOpenTimeSec).toBe(
      Math.floor(START_MS / 1000) - 290,
    );
    expect(target.market.pairCreatedAtMs).toBe(START_MS - 300_000);
    expect(target.market.runnerOpenTimeSec).toBe(Math.floor((START_MS - 300_000) / 1000));

    // Timestamps must remain distinct and not overwritten
    expect(target.initialization.transactionBlockTimeSec).not.toBe(
      target.initialization.instructionRequestedOpenTimeSec,
    );

    // Defaults & limits verification
    expect(DEFAULT_WATCH_VALIDATION_LIMITS.validationWindowMs).toBe(30_000);
    expect(DEFAULT_WATCH_VALIDATION_LIMITS.maxHttpAttempts).toBe(2);

    // Pure discovery verification test
    const directDiscovery = validateWatchedDiscoveryEvidence(watchResult);
    expect(directDiscovery.ok).toBe(true);
    if (directDiscovery.ok) {
      expect(directDiscovery.discovery.signature).toBe(VALID_SIG_A);
      expect(directDiscovery.discovery.subscriptionId).toBe(42);
    }

    // Exchange evidence transformation helper test
    const mockEvidence = {
      entry: {
        seq: 1,
        lane: "SOLANA_RPC" as const,
        owner: "SECURITY" as const,
        purpose: "PRECHECK_TRANSACTION",
        requestedIdentity: VALID_SIG_A,
        jsonRpcId: 1,
        dispatchedAtMs: START_MS,
        completedAtMs: START_MS + 50,
        httpStatus: 200,
        bodyComplete: true,
        error: null,
      },
      method: "POST" as const,
      url: "http://secret-url.com",
      requestBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [VALID_SIG_A],
      }),
      responseHeaders: { "content-type": "application/json" },
      bodyState: "COMPLETE" as const,
      body: Buffer.from("{}"),
      observedBodyBytes: 2,
      maxResponseBytes: 1_048_576,
    };
    const transformed = precheckExchangeFromEvidence(mockEvidence);
    expect(transformed.request.url).toBe(RPC_URL_PLACEHOLDER);
    expect(transformed.request.rpcMethod).toBe("getTransaction");

    // Start window verification
    expect(target.startWindow.basis).toBe(PLANNING_START_WINDOW.basis);
    expect(target.startWindow.minAgeSec).toBe(PLANNING_START_WINDOW.minAgeSec);
    expect(target.startWindow.maxAgeSec).toBe(PLANNING_START_WINDOW.maxAgeSec);

    // Disclaimer
    expect(target.eligibility).toBe(PROVISIONAL_TARGET_DISCLAIMER);
    expect(result.disclaimer).toBe(PROVISIONAL_TARGET_DISCLAIMER);

    // Exchange evidence records
    expect(result.exchanges).toHaveLength(2);
    expect(result.exchanges[0]!.purpose).toBe("PRECHECK_TRANSACTION");
    expect(result.exchanges[0]!.request.url).toBe(RPC_URL_PLACEHOLDER); // Redacted!
    expect(result.exchanges[0]!.response.bodyRedacted).toBe(false);
    expect(result.exchanges[1]!.purpose).toBe("PRECHECK_MARKET");
  });

  it("TC-V02: Pre-send rejection on unsuitable watch status or null notification with zero HTTP sends", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const calls: unknown[] = [];
    const fetchFn = makeMockFetch(sched, { onCall: (c) => calls.push(c) });

    // Subcase A: Status is KEEPALIVE_TIMEOUT
    const watchResultA = makeSyntheticWatchResult({ status: "KEEPALIVE_TIMEOUT" });
    const resultA = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: watchResultA,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultA.ok).toBe(false);
    expect(resultA.outcome).toBe("DISCOVERY_EVIDENCE_INVALID");
    expect(resultA.httpAttempts).toBe(0);
    expect(calls).toHaveLength(0);

    // Subcase B: notification is null
    const watchResultB = makeSyntheticWatchResult({ omitNotification: true });
    const resultB = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: watchResultB,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultB.ok).toBe(false);
    expect(resultB.outcome).toBe("DISCOVERY_EVIDENCE_INVALID");
    expect(resultB.httpAttempts).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("TC-V03: Pre-send rejection on tampered discovery frames with zero HTTP sends", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const calls: unknown[] = [];
    const fetchFn = makeMockFetch(sched, { onCall: (c) => calls.push(c) });

    // Subcase A: Outgoing frame mentions invalid fee destination
    const badFeeFrames: BoundedWatchApplicationFrame[] = [
      {
        direction: "OUTGOING",
        timestampMs: START_MS + 500,
        byteLength: 100,
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: ["11111111111111111111111111111111"] }],
        }),
        isComplete: true,
      },
      {
        direction: "INCOMING",
        timestampMs: START_MS + 600,
        byteLength: 42,
        payload: JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }),
        isComplete: true,
      },
      {
        direction: "INCOMING",
        timestampMs: START_MS + 10_000,
        byteLength: 200,
        payload: JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 42,
            result: {
              context: { slot: 250_000 },
              value: { err: null, signature: VALID_SIG_A },
            },
          },
        }),
        isComplete: true,
      },
    ];

    const resultA = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: makeSyntheticWatchResult({ frames: badFeeFrames }),
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultA.ok).toBe(false);
    expect(resultA.outcome).toBe("DISCOVERY_TAMPERED");
    expect(resultA.httpAttempts).toBe(0);
    expect(calls).toHaveLength(0);

    // Subcase B: Ack subscription ID mismatch with observations
    const resultB = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: makeSyntheticWatchResult({ mismatchedObservationSubId: 999 }), // Frame has 42, observation has 999
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultB.ok).toBe(false);
    expect(resultB.outcome).toBe("DISCOVERY_TAMPERED");
    expect(resultB.httpAttempts).toBe(0);

    // Subcase C: Notification has err !== null
    const failedTxFrames: BoundedWatchApplicationFrame[] = [
      {
        direction: "OUTGOING",
        timestampMs: START_MS + 500,
        byteLength: 145,
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION] }],
        }),
        isComplete: true,
      },
      {
        direction: "INCOMING",
        timestampMs: START_MS + 600,
        byteLength: 42,
        payload: JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }),
        isComplete: true,
      },
      {
        direction: "INCOMING",
        timestampMs: START_MS + 10_000,
        byteLength: 200,
        payload: JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 42,
            result: {
              context: { slot: 250_000 },
              value: { err: { InstructionError: [0, "Custom"] }, signature: VALID_SIG_A },
            },
          },
        }),
        isComplete: true,
      },
    ];

    const resultC = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: makeSyntheticWatchResult({ frames: failedTxFrames }),
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultC.ok).toBe(false);
    expect(resultC.outcome).toBe("DISCOVERY_EVIDENCE_INVALID");
    expect(resultC.httpAttempts).toBe(0);

    // Subcase D: Notification signature mismatch with metadata
    const resultD = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: makeSyntheticWatchResult({ mismatchedNotificationSignature: VALID_SIG_B }), // Frame has VALID_SIG_A, metadata has VALID_SIG_B
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultD.ok).toBe(false);
    expect(resultD.outcome).toBe("DISCOVERY_TAMPERED");
    expect(resultD.httpAttempts).toBe(0);

    // Subcase E: Notification slot mismatch with metadata
    const resultE = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: makeSyntheticWatchResult({ mismatchedNotificationSlot: 999_999 }), // Frame has 250_000, metadata has 999_999
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultE.ok).toBe(false);
    expect(resultE.outcome).toBe("DISCOVERY_TAMPERED");
    expect(resultE.httpAttempts).toBe(0);
  });

  it("TC-V04: Pre-send rejection on collector cleanup failure with zero HTTP sends", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const calls: unknown[] = [];
    const fetchFn = makeMockFetch(sched, { onCall: (c) => calls.push(c) });

    const watchResult = makeSyntheticWatchResult({
      cleanupSettled: true,
      cleanupFailed: true,
      cleanupFailureReason: "Timed out waiting for socket close",
    });

    const result = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("DISCOVERY_EVIDENCE_INVALID");
    expect(result.reason).toContain("Collector teardown failed");
    expect(result.httpAttempts).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("TC-V05: Pre-send rejection on expired validation deadline with zero HTTP sends", async () => {
    // Notification received at START_MS + 10_000.
    // Validation window is 30,000 ms.
    // Deadline = START_MS + 40_000.
    // Set current scheduler time to START_MS + 40_001.
    const sched = new VirtualScheduler(START_MS + 40_001);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const calls: unknown[] = [];
    const fetchFn = makeMockFetch(sched, { onCall: (c) => calls.push(c) });

    const watchResult = makeSyntheticWatchResult({ receivedAtMs: START_MS + 10_000 });
    const result = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("VALIDATION_DEADLINE_EXPIRED");
    expect(result.httpAttempts).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("TC-V06: Solana RPC failure halts pipeline with exactly 1 attempt and zero DexScreener calls", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const calls: { url: string }[] = [];
    const fetchFn = makeMockFetch(sched, {
      rpcStatus: 500,
      onCall: (c) => calls.push({ url: c.url }),
    });

    const watchResult = makeSyntheticWatchResult();
    const result = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("TRANSACTION_REQUEST_FAILED");
    expect(result.httpAttempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(TEST_RPC_URL);
  });

  it("TC-V07: Non-AMM v4 transaction halts pipeline with exactly 1 attempt and zero DexScreener calls", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const calls: { url: string }[] = [];
    const fetchFn = makeMockFetch(sched, {
      rpcResponse: {
        jsonrpc: "2.0",
        id: 1,
        // Transaction with wrong fee destination (not Raydium fee destination)
        result: initTransactionResult({
          signature: VALID_SIG_A,
          slot: 250_000,
          blockTime: Math.floor(START_MS / 1000) - 300,
          feeDestination: "11111111111111111111111111111111",
        }),
      },
      onCall: (c) => calls.push({ url: c.url }),
    });

    const watchResult = makeSyntheticWatchResult();
    const result = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("TRANSACTION_NONMATCH");
    expect(result.reason).toContain("FEE_DESTINATION_MISMATCH");
    expect(result.httpAttempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("TC-V08: Market request failure or non-match halts with 2 attempts", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    // Subcase A: Market returns HTTP 500
    const fetchFnA = makeMockFetch(sched, { marketStatus: 500 });
    const resultA = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: makeSyntheticWatchResult(),
        rpcUrl: TEST_RPC_URL,
        fetchFn: fetchFnA,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultA.ok).toBe(false);
    expect(resultA.outcome).toBe("MARKET_REQUEST_FAILED");
    expect(resultA.httpAttempts).toBe(2);

    // Subcase B: Market returns zero pairs
    const fetchFnB = makeMockFetch(sched, {
      marketResponse: { schemaVersion: "1.0.0", pairs: [] },
    });
    const resultB = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult: makeSyntheticWatchResult(),
        rpcUrl: TEST_RPC_URL,
        fetchFn: fetchFnB,
        clock: () => sched.now,
        timers,
      }),
    );
    expect(resultB.ok).toBe(false);
    expect(resultB.outcome).toBe("MARKET_NONMATCH");
    expect(resultB.reason).toBe("NO_PAIRS");
    expect(resultB.httpAttempts).toBe(2);
  });

  it("TC-V09: Start window already closed preserves candidate target with false outcome", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    // Pair created 800 seconds ago (older than 760s max age)
    const oldPairCreatedAtMs = START_MS - 800_000;
    const fetchFn = makeMockFetch(sched, {
      marketResponse: marketResponse(oldPairCreatedAtMs),
    });

    const watchResult = makeSyntheticWatchResult();
    const result = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("START_WINDOW_ALREADY_CLOSED");
    expect(result.reason).toBe("PAIR_CREATED_AT_AGE_BEYOND_WINDOW");
    expect(result.target).not.toBeNull();
    expect(result.target!.market.pairCreatedAtMs).toBe(oldPairCreatedAtMs);
    expect(result.httpAttempts).toBe(2);
  });

  it("TC-V10: First-429 stop behavior halts dispatch immediately", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const delay = () =>
      new Promise<void>((resolve) => {
        sched.add(() => resolve(), 100, "harness");
      });

    const calls: string[] = [];
    const fetchFn = (async (input: unknown): Promise<Response> => {
      calls.push(String(input));
      await delay();
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "5" },
      });
    }) as unknown as typeof fetch;

    const watchResult = makeSyntheticWatchResult();
    const result = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("TRANSACTION_REQUEST_FAILED");
    expect(result.httpAttempts).toBe(1);
    expect(calls).toHaveLength(1); // DexScreener was NOT called
  });

  it("TC-V11: Operator cancellation halts validation cleanly", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const calls: string[] = [];
    const fetchFn = makeMockFetch(sched, { onCall: (c) => calls.push(c.url) });

    const watchResult = makeSyntheticWatchResult();
    const result = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
        abortSignal: controller.signal,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("OPERATOR_CANCELLED");
    expect(result.httpAttempts).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("TC-V12: Pure derivation offline re-execution matches identical result from recorded evidence", async () => {
    const sched = new VirtualScheduler(START_MS + 10_500);
    const timers = {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    };

    const fetchFn = makeMockFetch(sched);
    const watchResult = makeSyntheticWatchResult();

    const liveResult = await drive(
      sched,
      executeWatchCandidateValidation({
        watchResult,
        rpcUrl: TEST_RPC_URL,
        fetchFn,
        clock: () => sched.now,
        timers,
      }),
    );

    expect(liveResult.ok).toBe(true);
    expect(liveResult.discovery).not.toBeNull();
    expect(liveResult.exchanges).toHaveLength(2);

    // Now re-run pure derivation completely offline without session, clock, or network:
    const pureEval = evaluateWatchCandidateEvidence(liveResult.discovery!, liveResult.exchanges);

    expect(pureEval.ok).toBe(true);
    expect(pureEval.outcome).toBe(liveResult.outcome);
    expect(pureEval.target).toEqual(liveResult.target);
  });
});
