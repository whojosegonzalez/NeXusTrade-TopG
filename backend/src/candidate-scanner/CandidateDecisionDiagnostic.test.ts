import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CandidateDecisionDiagnostic,
  replayCandidateDecisionFromSealedEvidence,
  evaluateAuthorityEvidence,
  CANONICAL_ZERO_ADDRESS,
  DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES,
  DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES,
  type CandidateDecisionDiagnosticResult,
  type DiagnosticRequestRecord,
} from "./CandidateDecisionDiagnostic.js";
import { runCandidateDecisionDiagnosticCli } from "../scripts/candidate-decision-diagnostic.js";
import {
  buildSyntheticFailedTransactionResult,
  buildSyntheticSwapTransactionResult,
  SYNTHETIC_FAILED_TRANSACTION_ERROR,
} from "./fixtures/SyntheticRaydiumSwapTransactionFixture.js";
import { PAPER_FAILED_TRANSACTION_POLICY } from "./ValidatedFailedTransactionEvidence.js";
import { encodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import {
  CAPTURED_RAY_WSOL_IDENTITIES,
  RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE,
  RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE,
  SYNTHETIC_QUALIFIED_RAW_PAYLOAD,
} from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import { CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD } from "./fixtures/CapturedSolanaTrackerBundlerFixture.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import type { ISolanaKeepaliveWebSocketTransport } from "./RaydiumTransportObservationProbe.js";

const TEST_POOL_ID = CAPTURED_RAY_WSOL_IDENTITIES.poolId;
const TEST_MINT = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!;
const TEST_RPC_URL = "http://127.0.0.1:8899";

const TEST_SIG_A =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const TEST_SIG_B =
  "QHREMqhWG7eahNuQ2EzQqSYKLy8WH9jVerfLRJTttyPorHxQJDzMMcB1142poqJHzYyVSsijoS1U9222QBV6AbM";

export interface MockWebSocketTransportOptions {
  immediateAck?: boolean;
  onSend?: (data: string) => void;
  messagesToSend?: string[];
  readyState?: number; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
  autoPong?: boolean; // default true
  pongPayload?: Buffer;
  pongDelayMs?: number;
  onPing?: (data?: Buffer) => void;
}

export type MockSolanaWebSocketTransport = ISolanaWebSocketTransport & {
  ping: (data?: Buffer) => void;
  getPingsReceived: () => Buffer[];
  emitPong: (data: Buffer) => void;
  emitOpen: () => void;
  emitError: (err: Error) => void;
  emitMessage: (data: string | Buffer) => void;
  readyState: number;
};

function createMockWebSocketTransport(
  options?: MockWebSocketTransportOptions,
): MockSolanaWebSocketTransport {
  const listeners: {
    open: (() => void)[];
    message: ((data: string | Buffer) => void)[];
    error: ((err: Error) => void)[];
    close: ((code: number, reason: string) => void)[];
    pong: ((data: Buffer) => void)[];
    ping: ((data: Buffer) => void)[];
  } = {
    open: [],
    message: [],
    error: [],
    close: [],
    pong: [],
    ping: [],
  };
  let isClosed = false;
  let readyState = options?.readyState ?? 1; // default OPEN
  const pingsReceived: Buffer[] = [];

  const transport: MockSolanaWebSocketTransport = {
    get readyState() {
      return readyState;
    },
    set readyState(val: number) {
      readyState = val;
    },
    getPingsReceived: () => pingsReceived,
    emitOpen: () => {
      readyState = 1;
      for (const fn of listeners.open) fn();
    },
    emitError: (err: Error) => {
      for (const fn of listeners.error) fn(err);
    },
    emitMessage: (data: string | Buffer) => {
      for (const fn of listeners.message) fn(data);
    },
    emitPong: (data: Buffer) => {
      for (const fn of listeners.pong) fn(data);
    },
    ping: (data?: Buffer) => {
      if (data) pingsReceived.push(data);
      options?.onPing?.(data);
      if (options?.autoPong !== false && data) {
        const replyPayload = options?.pongPayload ?? data;
        const delay = options?.pongDelayMs ?? 0;
        if (delay > 0) {
          setTimeout(() => {
            for (const fn of listeners.pong) fn(replyPayload);
          }, delay);
        } else {
          queueMicrotask(() => {
            for (const fn of listeners.pong) fn(replyPayload);
          });
        }
      }
    },
    send: (data: string) => {
      options?.onSend?.(data);
      const parsed = JSON.parse(data) as { id?: number; method?: string };
      if (parsed.method === "logsSubscribe" && options?.immediateAck !== false) {
        queueMicrotask(() => {
          if (!isClosed) {
            const ack = JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? 1, result: 101 });
            for (const fn of listeners.message) {
              fn(ack);
            }
            if (options?.messagesToSend) {
              for (const msg of options.messagesToSend) {
                for (const fn of listeners.message) {
                  fn(msg);
                }
              }
            }
          }
        });
      }
    },
    close: (code?: number, reason?: string) => {
      isClosed = true;
      readyState = 3;
      for (const fn of listeners.close) {
        fn(code ?? 1000, reason ?? "");
      }
    },
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "open") {
        listeners.open.push(listener as () => void);
        if (readyState === 1) {
          queueMicrotask(() => {
            if (!isClosed) (listener as () => void)();
          });
        }
      } else if (event === "message") {
        listeners.message.push(listener as (data: string | Buffer) => void);
      } else if (event === "error") {
        listeners.error.push(listener as (err: Error) => void);
      } else if (event === "close") {
        listeners.close.push(listener as (code: number, reason: string) => void);
      } else if (event === "pong") {
        listeners.pong.push(listener as (data: Buffer) => void);
      } else if (event === "ping") {
        listeners.ping.push(listener as (data: Buffer) => void);
      }
    }) as ISolanaKeepaliveWebSocketTransport["on"],
  };

  return transport;
}

function createRealInterfaceMockWebSocketTransport(options?: {
  immediateAck?: boolean;
  onSend?: (data: string) => void;
}): ISolanaKeepaliveWebSocketTransport & {
  getUnderlyingSocket: () => { readyState: number };
  getPingsReceived: () => Buffer[];
  isClosed: () => boolean;
  emitServerPing: (payload: Buffer) => void;
} {
  const listeners: {
    open: (() => void)[];
    message: ((data: string | Buffer) => void)[];
    error: ((err: Error) => void)[];
    close: ((code: number, reason: string) => void)[];
    pong: ((data: Buffer) => void)[];
    ping: ((data: Buffer) => void)[];
  } = {
    open: [],
    message: [],
    error: [],
    close: [],
    pong: [],
    ping: [],
  };
  let closed = false;
  const underlyingSocket = { readyState: 1 /* OPEN */ };
  const pingsReceived: Buffer[] = [];

  return {
    // Strictly omit direct readyState property on the wrapper
    getUnderlyingSocket: () => underlyingSocket,
    getPingsReceived: () => pingsReceived,
    isClosed: () => closed,
    emitServerPing: (payload: Buffer) => {
      for (const fn of listeners.ping) fn(payload);
    },
    on: ((event: string, listener: unknown) => {
      if (event === "open") {
        listeners.open.push(listener as () => void);
        // Strictly does NOT replay earlier open event
      } else if (event === "message") {
        listeners.message.push(listener as (data: string | Buffer) => void);
      } else if (event === "error") {
        listeners.error.push(listener as (err: Error) => void);
      } else if (event === "close") {
        listeners.close.push(listener as (code: number, reason: string) => void);
      } else if (event === "pong") {
        listeners.pong.push(listener as (data: Buffer) => void);
      } else if (event === "ping") {
        listeners.ping.push(listener as (data: Buffer) => void);
      }
    }) as ISolanaKeepaliveWebSocketTransport["on"],
    send: (data: string) => {
      options?.onSend?.(data);
      const parsed = JSON.parse(data) as { id?: number; method?: string };
      if (options?.immediateAck && parsed.id !== undefined) {
        queueMicrotask(() => {
          for (const fn of listeners.message) {
            fn(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: 1 }));
          }
        });
      }
    },
    ping: (data?: Buffer) => {
      if (data) pingsReceived.push(data);
      if (data) {
        queueMicrotask(() => {
          for (const fn of listeners.pong) fn(data);
        });
      }
    },
    close: () => {
      closed = true;
      underlyingSocket.readyState = 3 /* CLOSED */;
      for (const fn of listeners.close) fn(1000, "Normal Closure");
    },
    terminate: () => {
      closed = true;
      underlyingSocket.readyState = 3 /* CLOSED */;
    },
  };
}

interface MockFetchScenario {
  marketCap?: number;
  fdv?: number;
  missingLiquidity?: boolean;
  missingCreatedAt?: boolean;
  freezeAuthority?: string | null;
  mintAuthority?: string | null;
  omitAuthorities?: boolean;
  active429OnProvider?: string;
  hangingRequest?: boolean;
  hangingMethod?: string;
  rugScore?: number;
  hasDanger?: boolean;
  missingRisks?: boolean;
  emptyTopHolders?: boolean;
  delayMs?: number;
  getClock?: () => number;
  blockTimeSec?: number;
  unqualifiedLp?: boolean;
  ageSeconds?: number;
  h1PriceChange?: number;
  missingVolume?: boolean;
  missingBuysSells?: boolean;
  quoteIsCandidate?: boolean;
  includeBomInGetSlot?: boolean;
}

function createDiagnosticMockFetch(scenario: MockFetchScenario = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (scenario.hangingRequest) {
      // Return a promise that never resolves within timeout
      return new Promise(() => {});
    }

    if (
      scenario.hangingMethod &&
      init?.body &&
      typeof init.body === "string" &&
      init.body.includes(scenario.hangingMethod)
    ) {
      return new Promise(() => {});
    }

    if (scenario.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
    }

    // HTTP 429 injection check
    if (scenario.active429OnProvider && urlStr.includes(scenario.active429OnProvider)) {
      return new Response("Too Many Requests", { status: 429 });
    }

    // DexScreener Pair Request
    if (urlStr.includes("api.dexscreener.com/latest/dex/pairs")) {
      const currentMs = scenario.getClock
        ? scenario.getClock()
        : scenario.blockTimeSec
          ? scenario.blockTimeSec * 1000
          : 1791931000 * 1000;
      const ageSec = scenario.ageSeconds !== undefined ? scenario.ageSeconds : 600;
      const h1Val = scenario.h1PriceChange !== undefined ? scenario.h1PriceChange : 4.2;
      const isQuoteCand = scenario.quoteIsCandidate === true;
      const baseToken = isQuoteCand
        ? {
            address: "So11111111111111111111111111111111111111112",
            name: "Wrapped SOL",
            symbol: "SOL",
          }
        : { address: TEST_MINT, name: "Raydium", symbol: "RAY" };
      const quoteToken = isQuoteCand
        ? { address: TEST_MINT, name: "Raydium", symbol: "RAY" }
        : {
            address: "So11111111111111111111111111111111111111112",
            name: "Wrapped SOL",
            symbol: "SOL",
          };

      const pairPayload = {
        schemaVersion: "1.0.0",
        pairs: [
          {
            chainId: "solana",
            dexId: "raydium",
            url: `https://dexscreener.com/solana/${TEST_POOL_ID}`,
            pairAddress: TEST_POOL_ID,
            baseToken,
            quoteToken,
            priceNative: isQuoteCand ? "66.66666666666667" : "0.015",
            priceUsd: isQuoteCand ? "150.00" : "2.50",
            liquidity: scenario.missingLiquidity ? undefined : { usd: 65000 },
            marketCap: scenario.marketCap !== undefined ? scenario.marketCap : 250000,
            fdv: scenario.fdv !== undefined ? scenario.fdv : 300000,
            volume: scenario.missingVolume ? undefined : { m5: 15000 },
            txns: scenario.missingBuysSells ? undefined : { m5: { buys: 40, sells: 15 } },
            pairCreatedAt: scenario.missingCreatedAt ? undefined : currentMs - ageSec * 1000,
            priceChange: { m5: 1.5, h1: h1Val },
          },
        ],
      };
      return new Response(JSON.stringify(pairPayload), { status: 200 });
    }

    // RugCheck Report Request
    if (urlStr.includes("api.rugcheck.xyz/v1/tokens/")) {
      const rcPayload: Record<string, unknown> = {
        score: scenario.rugScore !== undefined ? scenario.rugScore : 150,
        tokenMeta: { mutable: false },
        topHolders: scenario.emptyTopHolders
          ? []
          : [
              { address: "Holder1", pct: 5.0 },
              { address: "Holder2", pct: 4.0 },
            ],
        totalHolders: 450,
      };
      if (!scenario.missingRisks) {
        rcPayload.risks = scenario.hasDanger
          ? [{ name: "High Risk", level: "danger" }]
          : [{ name: "Info", level: "info" }];
      }
      return new Response(JSON.stringify(rcPayload), { status: 200 });
    }

    // Solana Tracker Bundler Request
    if (urlStr.includes("data.solanatracker.io/tokens/")) {
      return new Response(JSON.stringify(CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD), {
        status: 200,
      });
    }

    // Solana JSON-RPC Requests
    if (urlStr.includes("8899") || init?.method === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const method = body.method;
      const id = body.id ?? 1;

      if (method === "getAccountInfo") {
        const address = body.params?.[0];
        if (address === TEST_POOL_ID) {
          // Return authentic bootstrap pool account
          return new Response(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE, {
            status: 200,
          });
        } else if (address === TEST_MINT) {
          // Return candidate token mint account
          const infoObj: Record<string, unknown> = {
            decimals: 6,
            isInitialized: true,
            supply: "555000000000000",
          };
          if (!scenario.omitAuthorities) {
            infoObj.freezeAuthority =
              scenario.freezeAuthority !== undefined ? scenario.freezeAuthority : null;
            infoObj.mintAuthority =
              scenario.mintAuthority !== undefined ? scenario.mintAuthority : null;
          }
          const mintAccountRpc = {
            jsonrpc: "2.0",
            result: {
              context: { slot: 461970878 },
              value: {
                data: {
                  program: "spl-token",
                  parsed: {
                    info: infoObj,
                    type: "mint",
                  },
                  space: 82,
                },
                executable: false,
                lamports: 11461600,
                owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                rentEpoch: 0,
              },
            },
            id,
          };
          return new Response(JSON.stringify(mintAccountRpc), { status: 200 });
        }
      }

      if (method === "getMultipleAccounts") {
        const payload = scenario.unqualifiedLp
          ? RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE
          : JSON.stringify(SYNTHETIC_QUALIFIED_RAW_PAYLOAD);
        return new Response(payload, { status: 200 });
      }

      if (method === "getSignaturesForAddress") {
        const limit = body.params?.[1]?.limit ?? 1;
        const currentMs = scenario.getClock
          ? scenario.getClock()
          : scenario.blockTimeSec
            ? scenario.blockTimeSec * 1000
            : 1791931000 * 1000;
        const anchorBlockTimeSec = Math.floor((currentMs - 75_000) / 1000);
        if (limit === 1) {
          // Prior anchor or cutoff
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              result: [
                {
                  signature: TEST_SIG_A,
                  slot: 461970800,
                  err: null,
                  blockTime: anchorBlockTimeSec,
                },
              ],
              id,
            }),
            { status: 200 },
          );
        } else {
          // History enumeration page
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              result: [
                {
                  signature: TEST_SIG_A,
                  slot: 461970800,
                  err: null,
                  blockTime: anchorBlockTimeSec,
                },
              ],
              id,
            }),
            { status: 200 },
          );
        }
      }

      if (method === "getSlot") {
        const slot = 461970880;
        const resObj = { jsonrpc: "2.0", result: slot, id };
        if (scenario.includeBomInGetSlot) {
          const bomBuffer = Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(JSON.stringify(resObj), "utf8"),
          ]);
          return new Response(bomBuffer, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(resObj), {
          status: 200,
        });
      }

      if (method === "getBlockTime") {
        // Return blockTime aligned with current synthetic time
        const blockSec =
          scenario.blockTimeSec !== undefined
            ? scenario.blockTimeSec
            : scenario.getClock
              ? Math.floor(scenario.getClock() / 1000)
              : 1791931000;
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: blockSec, id }), {
          status: 200,
        });
      }

      if (method === "getTransaction") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              slot: 461970850,
              transaction: { signatures: [body.params?.[0]] },
              meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
            },
            id,
          }),
          { status: 200 },
        );
      }
    }

    return new Response(JSON.stringify({ error: "Unhandled endpoint in mock fetch" }), {
      status: 404,
    });
  };
}

describe("CandidateDecisionDiagnostic Offline Test Suite", () => {
  const testOutDir = path.resolve(
    process.cwd(),
    ".tmp",
    "test-diagnostics",
    `diag-test-${Date.now()}`,
  );

  beforeEach(() => {
    if (existsSync(testOutDir)) {
      rmSync(testOutDir, { recursive: true, force: true });
    }
  });

  it("1. Quiet Path: verifies quiet window under PAPER_SIMULATION with <= 11 requests", async () => {
    const now = 1791931000 * 1000;
    const observationDurationMs = 65_000;
    let clockTime = now - 70_000;

    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs,
    });

    const result = await diagnostic.run();

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ARMED_FIRST_TICK");
    expect(result.decisionResult?.outcome).toBe("ARMED_FIRST_TICK");
    expect(result.flowEvaluation?.isPaperQualified).toBe(true);
    expect(result.flowEvaluation?.flowCoverage).toBe("SUFFICIENT");
    expect(result.flowEvaluation?.recentBuys60s).toBe(0);
    expect(result.flowEvaluation?.recentSells60s).toBe(0);

    // Ledger checks: quiet path consumes at most 11 requests
    const ledger = diagnostic.getLedger();
    expect(ledger.totalAttempts).toBeLessThanOrEqual(11);
    expect(ledger.poolLayoutAttempts).toBe(1);
    expect(ledger.priorAnchorAttempts).toBe(1);
    expect(ledger.transactionDecodeAttempts).toBe(0); // 0 in quiet path
    expect(ledger.getSlotAttempts).toBe(1);
    expect(ledger.getBlockTimeAttempts).toBe(1);
    expect(ledger.historyEnumerationAttempts).toBe(1);
    expect(ledger.exactPairAttempts).toBe(1);
    expect(ledger.lpRefreshAttempts).toBe(2);
    expect(ledger.candidateMintAttempts).toBe(1);
    expect(ledger.rugCheckAttempts).toBe(1);
    expect(ledger.solanaTrackerAttempts).toBe(1);
  });

  it("2. Active/Incomplete Path: decodes incoming notifications and marks flow non-quiet", async () => {
    const now = 1791931000 * 1000;
    const observationDurationMs = 65_000;
    let clockTime = now - 70_000;

    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    // Notification message to deliver over socket
    const notificationMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 101,
        result: {
          context: { slot: 461970850 },
          value: {
            signature: TEST_SIG_B,
            err: null,
            logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
          },
        },
      },
    });

    const wsTransport = createMockWebSocketTransport({
      immediateAck: true,
      messagesToSend: [notificationMsg],
    });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);

    // Active transactions prevent quiet qualification; flow remains COLLECTION_GAP
    expect(result.flowEvaluation?.isPaperQualified).toBeUndefined();
    expect(result.flowEvaluation?.flowCoverage).toBe("COLLECTION_GAP");
    // Buy Gate fails on Short Horizon Flow Gate
    expect(result.decisionResult?.outcome).toBe("BUY_GATE_REJECTED");
    expect(result.decisionResult?.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");

    const ledger = diagnostic.getLedger();
    expect(ledger.transactionDecodeAttempts).toBe(1); // Decoded 1 transaction
  });

  it("3. HTTP 429 Immediate Fail-Closed Abort", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    // Inject 429 on RugCheck
    const transport = createDiagnosticMockFetch({
      active429OnProvider: "api.rugcheck.xyz",
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();

    expect(result.ok).toBe(false);
    expect(result.status).toBe("UNHANDLED_EXCEPTION");
    expect(result.message).toContain("HTTP_429_RATE_LIMITED");
  });

  it("4. Missing Actual marketCap (FDV present) strictly fails with INCOMPLETE_MARKET_INPUTS", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    // FDV present (300,000), but actual marketCap is missing
    const transport = createDiagnosticMockFetch({ marketCap: 0, fdv: 300000, getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();

    expect(result.ok).toBe(false);
    expect(result.status).toBe("INCOMPLETE_MARKET_INPUTS");
    expect(result.message).toContain("Actual marketCap is missing or invalid");
    expect(result.message).toContain("FDV (300000) cannot substitute");
  });

  it("5. Active Freeze Authority fails pre-admission screening", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    // Candidate token has active unrenounced freeze authority
    const transport = createDiagnosticMockFetch({
      freezeAuthority: TEST_MINT,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();

    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.preAdmissionScreening?.freezeAuthorityPassed).toBe(false);
    expect(result.preAdmissionScreening?.rejectionReason).toBe("REJECTED_ACTIVE_FREEZE_AUTHORITY");
    expect(result.decisionResult).toBeUndefined(); // Buy Gates never evaluated
  });

  it("6. Default PRODUCTION mode rejects PAPER quiet-window qualification fail-closed", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    // executionContext defaulted to "PRODUCTION"
    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PRODUCTION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();

    expect(result.ok).toBe(true);
    expect(result.flowEvaluation?.diagnosticReason).toBe(
      "PAPER_QUALIFIED_EVIDENCE_REJECTED_IN_PRODUCTION",
    );
    expect(result.flowEvaluation?.flowCoverage).toBe("COLLECTION_GAP");
    // Fails Gate 9 because flow is unverified in production
    expect(result.decisionResult?.outcome).toBe("BUY_GATE_REJECTED");
    expect(result.decisionResult?.rejectionReason).toBe("REJECTED_UNAVAILABLE_FLOW_COVERAGE");
  });

  it("7. Output Isolation: writes only to outDir with zero canonical state file mutations", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 65_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const transport = createDiagnosticMockFetch({ getClock: clock });
    const wsTransport = createMockWebSocketTransport({ immediateAck: true });

    const walletPath = path.resolve(process.cwd(), ".tmp", "virtual-wallet.json");
    const walletBefore = existsSync(walletPath) ? readFileSync(walletPath, "utf8") : null;

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);

    // Verify diagnostic artifacts exist in testOutDir
    expect(existsSync(path.join(testOutDir, "diagnostic-report.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence-manifest.json"))).toBe(true);

    const reportContent = JSON.parse(
      readFileSync(path.join(testOutDir, "diagnostic-report.json"), "utf8"),
    );
    expect(reportContent.poolId).toBe(TEST_POOL_ID);
    expect(reportContent.ledger.totalAttempts).toBeLessThanOrEqual(14);

    // Verify canonical state files under .tmp were NEVER modified
    const walletAfter = existsSync(walletPath) ? readFileSync(walletPath, "utf8") : null;
    expect(walletAfter).toBe(walletBefore);
  });

  it("8. Missing transport in offline mode throws [DIAGNOSTIC_INVALID_ARG]", () => {
    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch();

    expect(
      () =>
        new CandidateDecisionDiagnostic({
          poolId: TEST_POOL_ID,
          mintAddress: TEST_MINT,
          rpcUrl: TEST_RPC_URL,
          outDir: testOutDir,
          wsTransport,
        }),
    ).toThrow(/Offline mode requires injected transport/);

    expect(
      () =>
        new CandidateDecisionDiagnostic({
          poolId: TEST_POOL_ID,
          mintAddress: TEST_MINT,
          rpcUrl: TEST_RPC_URL,
          outDir: testOutDir,
          transport,
        }),
    ).toThrow(/Offline mode requires injected wsTransport/);
  });

  it("9. Injected transport hanging request terminates within timeout without hanging process", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    // Hang on requests
    const transport = createDiagnosticMockFetch({ hangingRequest: true, getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      requestTimeoutMs: 50,
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("OVERALL_DIAGNOSTIC_TIMEOUT");
    expect(result.message).toContain("OPERATION_TIMEOUT");
  });

  it("10. Overall deadline timeout terminates work and returns OVERALL_DIAGNOSTIC_TIMEOUT", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async () => {
      // Simulate wall clock time advancing past 30s deadline
      clockTime += 40_000;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      overallTimeoutMs: 30_000,
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("OVERALL_DIAGNOSTIC_TIMEOUT");
  });

  it("11. Candidate mint account info with omitted authorities fails with PRE_ADMISSION_REJECTED", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ omitAuthorities: true, getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.message).toContain("REJECTED_UNKNOWN_FREEZE_AUTHORITY");
  });

  it("12. RugCheck report with missing risks or empty topHolders fails Gate 11", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    // Sub-case A: missing risks
    {
      const wsTransport = createMockWebSocketTransport({ immediateAck: true });
      const transport = createDiagnosticMockFetch({ missingRisks: true, getClock: clock });

      const diagnostic = new CandidateDecisionDiagnostic({
        poolId: TEST_POOL_ID,
        mintAddress: TEST_MINT,
        rpcUrl: TEST_RPC_URL,
        outDir: path.join(testOutDir, "subcase-a"),
        transport,
        wsTransport,
        clock,
        sleeper,
        executionContext: "PAPER_SIMULATION",
        observationDurationMs: 65_000,
      });

      const result = await diagnostic.run();
      expect(result.ok).toBe(true);
      expect(result.status).toBe("BUY_GATE_REJECTED");
      expect(result.decisionResult?.buyGateResult?.rejectionReason).toBe(
        "REJECTED_RUGCHECK_UNINDEXED_OR_HOLDERS_UNKNOWN",
      );
    }

    // Sub-case B: empty topHolders
    {
      const wsTransport = createMockWebSocketTransport({ immediateAck: true });
      const transport = createDiagnosticMockFetch({ emptyTopHolders: true, getClock: clock });

      const diagnostic = new CandidateDecisionDiagnostic({
        poolId: TEST_POOL_ID,
        mintAddress: TEST_MINT,
        rpcUrl: TEST_RPC_URL,
        outDir: path.join(testOutDir, "subcase-b"),
        transport,
        wsTransport,
        clock,
        sleeper,
        executionContext: "PAPER_SIMULATION",
        observationDurationMs: 65_000,
      });

      const result = await diagnostic.run();
      expect(result.ok).toBe(true);
      expect(result.status).toBe("BUY_GATE_REJECTED");
      expect(result.decisionResult?.buyGateResult?.rejectionReason).toBe(
        "TOP_10_CONCENTRATION_UNKNOWN",
      );
    }
  });

  it("13. Established candidate with priceChange.h1 = -99 fails Gate 12", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    // ageSeconds: 2400 (between 1800 and 7200), liquidity >= 50000, h1PriceChange: -99
    const transport = createDiagnosticMockFetch({
      ageSeconds: 2400,
      h1PriceChange: -99,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);
    expect(result.status).toBe("BUY_GATE_REJECTED");
    expect(result.decisionResult?.outcome).toBe("BUY_GATE_REJECTED");
    expect(result.decisionResult?.buyGateResult?.rejectionReason).toBe(
      "REJECTED_ESTABLISHED_MACRO_DOWNTREND",
    );
    const macroGate = result.decisionResult?.buyGateResult?.gates.find(
      (g) => g.name === "ESTABLISHED_MACRO_TREND_GATE",
    );
    expect(macroGate?.passed).toBe(false);
    expect(macroGate?.value).toBe(-99);
  });

  it("14. Reverse orientation USD price computation: quotes candidate token correctly", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    // quoteIsCandidate: true where priceUsd = 150.00 and priceNative = 66.66666666666667
    const transport = createDiagnosticMockFetch({
      quoteIsCandidate: true,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);
    // priceUsd / priceNative: 150.00 / 66.66666666666667 = 2.25
    expect(result.candidateMarketData?.spotPriceUsd).toBeCloseTo(2.25, 2);
    expect(result.candidateMarketData?.spotPriceSol).toBeCloseTo(1 / 66.66666666666667, 4);
  });

  it("15. Missing volume or transaction counts fails with INCOMPLETE_MARKET_INPUTS (does not default to 0)", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    // Sub-case A: missing volume
    {
      const wsTransport = createMockWebSocketTransport({ immediateAck: true });
      const transport = createDiagnosticMockFetch({ missingVolume: true, getClock: clock });

      const diagnostic = new CandidateDecisionDiagnostic({
        poolId: TEST_POOL_ID,
        mintAddress: TEST_MINT,
        rpcUrl: TEST_RPC_URL,
        outDir: path.join(testOutDir, "subcase-vol"),
        transport,
        wsTransport,
        clock,
        sleeper,
        executionContext: "PAPER_SIMULATION",
        observationDurationMs: 65_000,
      });

      const result = await diagnostic.run();
      expect(result.ok).toBe(false);
      expect(result.status).toBe("INCOMPLETE_MARKET_INPUTS");
      expect(result.message).toContain("Missing or non-finite volume.m5");
    }

    // Sub-case B: missing buys/sells
    {
      const wsTransport = createMockWebSocketTransport({ immediateAck: true });
      const transport = createDiagnosticMockFetch({ missingBuysSells: true, getClock: clock });

      const diagnostic = new CandidateDecisionDiagnostic({
        poolId: TEST_POOL_ID,
        mintAddress: TEST_MINT,
        rpcUrl: TEST_RPC_URL,
        outDir: path.join(testOutDir, "subcase-txns"),
        transport,
        wsTransport,
        clock,
        sleeper,
        executionContext: "PAPER_SIMULATION",
        observationDurationMs: 65_000,
      });

      const result = await diagnostic.run();
      expect(result.ok).toBe(false);
      expect(result.status).toBe("INCOMPLETE_MARKET_INPUTS");
      expect(result.message).toContain("Missing or invalid txns.m5");
    }
  });

  it("16. Unwritable output destination fails closed with ARTIFACT_WRITE_FAILED", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    // Portable obstruction inside the test-owned directory: the destination lies beneath a regular
    // file, where a directory is required, so creating the capture directory fails on every platform.
    mkdirSync(testOutDir, { recursive: true });
    const blockingFile = path.join(testOutDir, "blocking-file");
    const blockingContent = "SYNTHETIC blocking file; must remain intact";
    writeFileSync(blockingFile, blockingContent, "utf8");
    const unwritableDir = path.join(blockingFile, "capture");

    try {
      const diagnostic = new CandidateDecisionDiagnostic({
        poolId: TEST_POOL_ID,
        mintAddress: TEST_MINT,
        rpcUrl: TEST_RPC_URL,
        outDir: unwritableDir,
        transport,
        wsTransport,
        clock,
        sleeper,
        executionContext: "PAPER_SIMULATION",
        observationDurationMs: 65_000,
      });

      const result = await diagnostic.run();
      expect(result.ok).toBe(false);
      expect(result.status).toBe("ARTIFACT_WRITE_FAILED");
      expect(statSync(blockingFile).isFile()).toBe(true);
      expect(readFileSync(blockingFile, "utf8")).toBe(blockingContent);
      expect(existsSync(unwritableDir)).toBe(false);
      expect(readdirSync(testOutDir)).toEqual(["blocking-file"]);
    } finally {
      rmSync(testOutDir, { recursive: true, force: true });
    }
  });

  it("17. Existing diagnostic destination refuses overwrite with DIAGNOSTIC_OUTPUT_EXISTS", () => {
    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch();

    // Create a mock report file in target directory
    mkdirSync(testOutDir, { recursive: true });
    writeFileSync(path.join(testOutDir, "diagnostic-report.json"), "{}", "utf8");

    expect(
      () =>
        new CandidateDecisionDiagnostic({
          poolId: TEST_POOL_ID,
          mintAddress: TEST_MINT,
          rpcUrl: TEST_RPC_URL,
          outDir: testOutDir,
          transport,
          wsTransport,
        }),
    ).toThrow(/DIAGNOSTIC_OUTPUT_EXISTS/);
  });

  it("18. Redacts RPC URL path and query credentials in diagnostic report and manifest", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const credentialRpcUrl = "https://solana-mainnet.g.alchemy.com/v2/secret-api-key-alchemy-98765";
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: credentialRpcUrl,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);

    const reportRaw = readFileSync(path.join(testOutDir, "diagnostic-report.json"), "utf8");
    const manifestRaw = readFileSync(path.join(testOutDir, "evidence-manifest.json"), "utf8");

    expect(reportRaw).not.toContain("secret-api-key-alchemy-98765");
    expect(manifestRaw).not.toContain("secret-api-key-alchemy-98765");
    expect(manifestRaw).toContain("[REDACTED]");
  });

  it("19. Pre-admission screening: rejects textual placeholder mintAuthority 'none' with REJECTED_MALFORMED_MINT_AUTHORITY", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({
      mintAuthority: "none",
      freezeAuthority: null,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "mint-auth-none"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.preAdmissionScreening?.mintAuthorityPassed).toBe(false);
    expect(result.preAdmissionScreening?.rejectionReason).toBe("REJECTED_MALFORMED_MINT_AUTHORITY");
    expect(result.candidateMintAccount?.mintAuthorityStatus).toBe("MALFORMED");
  });

  it("20. Pre-admission screening: rejects textual placeholder freezeAuthority 'none' with REJECTED_MALFORMED_FREEZE_AUTHORITY", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({
      mintAuthority: null,
      freezeAuthority: "none",
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "freeze-auth-none"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.preAdmissionScreening?.freezeAuthorityPassed).toBe(false);
    expect(result.preAdmissionScreening?.rejectionReason).toBe(
      "REJECTED_MALFORMED_FREEZE_AUTHORITY",
    );
    expect(result.candidateMintAccount?.freezeAuthorityStatus).toBe("MALFORMED");
  });

  it("21. Pre-admission screening: rejects literal string mintAuthority 'null' with REJECTED_MALFORMED_MINT_AUTHORITY", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({
      mintAuthority: "null",
      freezeAuthority: null,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "mint-auth-str-null"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.preAdmissionScreening?.mintAuthorityPassed).toBe(false);
    expect(result.preAdmissionScreening?.rejectionReason).toBe("REJECTED_MALFORMED_MINT_AUTHORITY");
  });

  it("22. Pre-admission screening: rejects literal string freezeAuthority 'null' with REJECTED_MALFORMED_FREEZE_AUTHORITY", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({
      mintAuthority: null,
      freezeAuthority: "null",
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "freeze-auth-str-null"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.preAdmissionScreening?.freezeAuthorityPassed).toBe(false);
    expect(result.preAdmissionScreening?.rejectionReason).toBe(
      "REJECTED_MALFORMED_FREEZE_AUTHORITY",
    );
  });

  it("23. Pre-admission screening: rejects invalid non-Base58 mintAuthority with REJECTED_MALFORMED_MINT_AUTHORITY", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({
      mintAuthority: "invalid_address_with_0_and_O_and_I",
      freezeAuthority: null,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "mint-auth-invalid-base58"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.preAdmissionScreening?.rejectionReason).toBe("REJECTED_MALFORMED_MINT_AUTHORITY");
  });

  it("24. Pre-admission screening: rejects active valid Base58 mintAuthority with REJECTED_ACTIVE_MINT_AUTHORITY", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({
      mintAuthority: TEST_MINT,
      freezeAuthority: null,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "mint-auth-active"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.preAdmissionScreening?.mintAuthorityPassed).toBe(false);
    expect(result.preAdmissionScreening?.rejectionReason).toBe("REJECTED_ACTIVE_MINT_AUTHORITY");
    expect(result.candidateMintAccount?.mintAuthorityStatus).toBe("ACTIVE");
  });

  it("25. Pre-admission screening: rejects canonical 32-byte zero address as active authority", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({
      mintAuthority: null,
      freezeAuthority: CANONICAL_ZERO_ADDRESS,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "zero-addr-auth"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(result.message).toContain("REJECTED_ACTIVE_FREEZE_AUTHORITY");
    expect(result.candidateMintAccount?.freezeAuthorityStatus).toBe("ACTIVE");
    expect(result.candidateMintAccount?.freezeAuthorityRenounced).toBe(false);
  });

  it("26. evaluateAuthorityEvidence helper correctly classifies all states", () => {
    // 1. OMITTED: undefined or missing key
    expect(evaluateAuthorityEvidence({}, "mintAuthority").status).toBe("OMITTED");
    expect(evaluateAuthorityEvidence({ mintAuthority: undefined }, "mintAuthority").status).toBe(
      "OMITTED",
    );
    expect(evaluateAuthorityEvidence(null, "mintAuthority").status).toBe("OMITTED");

    // 2. DISABLED: only literal null
    const nullEval = evaluateAuthorityEvidence({ mintAuthority: null }, "mintAuthority");
    expect(nullEval.status).toBe("DISABLED");
    expect(nullEval.isRenounced).toBe(true);
    expect(nullEval.isExplicitlyObserved).toBe(true);

    // 3. ACTIVE: valid Base58 public key (zero address is a present public key, not disabled)
    const zeroEval = evaluateAuthorityEvidence(
      { mintAuthority: CANONICAL_ZERO_ADDRESS },
      "mintAuthority",
    );
    expect(zeroEval.status).toBe("ACTIVE");
    expect(zeroEval.isRenounced).toBe(false);
    expect(zeroEval.address).toBe(CANONICAL_ZERO_ADDRESS);

    const activeEval = evaluateAuthorityEvidence({ mintAuthority: TEST_MINT }, "mintAuthority");
    expect(activeEval.status).toBe("ACTIVE");
    expect(activeEval.isRenounced).toBe(false);
    expect(activeEval.isExplicitlyObserved).toBe(true);
    expect(activeEval.address).toBe(TEST_MINT);

    // 4. MALFORMED: placeholders, empty strings, invalid characters
    expect(evaluateAuthorityEvidence({ mintAuthority: "none" }, "mintAuthority").status).toBe(
      "MALFORMED",
    );
    expect(evaluateAuthorityEvidence({ mintAuthority: "null" }, "mintAuthority").status).toBe(
      "MALFORMED",
    );
    expect(evaluateAuthorityEvidence({ mintAuthority: "undefined" }, "mintAuthority").status).toBe(
      "MALFORMED",
    );
    expect(evaluateAuthorityEvidence({ mintAuthority: "" }, "mintAuthority").status).toBe(
      "MALFORMED",
    );
    expect(evaluateAuthorityEvidence({ mintAuthority: 12345 }, "mintAuthority").status).toBe(
      "MALFORMED",
    );
    expect(evaluateAuthorityEvidence({ mintAuthority: true }, "mintAuthority").status).toBe(
      "MALFORMED",
    );
  });

  it("27. WebSocket lifecycle: waits for transport to reach OPEN from initial CONNECTING state", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    // Transport begins in readyState 0 (CONNECTING)
    const wsTransport = createMockWebSocketTransport({
      readyState: 0,
      immediateAck: true,
    });

    const transport = createDiagnosticMockFetch({ getClock: clock });

    // Simulate transition to readyState 1 (OPEN)
    setImmediate(() => {
      wsTransport.emitOpen();
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "ws-connecting"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ARMED_FIRST_TICK");
  });

  it("28. WebSocket lifecycle: fails closed if transport starts in CLOSED readyState", async () => {
    const now = 1791931000 * 1000;
    const clock = () => now;

    // Transport already in CLOSED readyState (3)
    const wsTransport = createMockWebSocketTransport({ readyState: 3 });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "ws-closed"),
      transport,
      wsTransport,
      clock,
      executionContext: "PAPER_SIMULATION",
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("WEBSOCKET_CONNECTION_CLOSED");
  });

  it("29. WebSocket lifecycle: fails closed if transport emits error before OPEN", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ readyState: 0 });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    setImmediate(() => {
      wsTransport.emitError(new Error("ECONNREFUSED"));
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "ws-error-before-open"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("WEBSOCKET_CONNECTION_FAILED");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("30. Keepalive: dispatches pings with 8-byte epoch payload and records matched pongs", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({
      immediateAck: true,
      autoPong: true,
    });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "keepalive-matched"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      pingIntervalMs: 20_000,
      maxPings: 4,
      pongTimeoutMs: 10_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ARMED_FIRST_TICK");

    const pings = wsTransport.getPingsReceived();
    expect(pings.length).toBeGreaterThanOrEqual(1);
    expect(pings[0]?.length).toBe(8); // 8-byte BigInt timestamp payload
  });

  it("31. Keepalive: missing pong terminates promptly with KEEPALIVE_PONG_TIMEOUT and halts before cutoff RPCs", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    // autoPong: false simulates server not returning PONG
    const wsTransport = createMockWebSocketTransport({
      immediateAck: true,
      autoPong: false,
    });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "keepalive-timeout"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      pingIntervalMs: 20,
      pongTimeoutMs: 30,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("KEEPALIVE_PONG_TIMEOUT");
    expect(result.message).toContain("Missing WebSocket keepalive PONG");

    // Must NOT proceed to cutoff requests (getSlot/getBlockTime attempts must be 0)
    expect(result.ledger.getSlotAttempts).toBe(0);
    expect(result.ledger.getBlockTimeAttempts).toBe(0);
    expect(result.ledger.totalAttempts).toBe(2); // Only pool layout and prior anchor
  });

  it("32. Keepalive: control frame traffic ceiling aborts promptly with CONTROL_FRAME_LIMIT_EXCEEDED", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({
      immediateAck: true,
      autoPong: true,
    });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    // maxControlFrames set to 1 so the very first ping reaches the ceiling
    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "control-limit"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      pingIntervalMs: 10,
      maxControlFrames: 1,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("CONTROL_FRAME_LIMIT_EXCEEDED");
    expect(result.ledger.getSlotAttempts).toBe(0);
  });

  it("33. Stream limits: queue ceiling of 10 enforced at ingress stops promptly with STREAM_QUEUE_LIMIT_EXCEEDED without calling cutoff RPCs", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    // Inject 15 notifications exceeding queue limit of 10
    const burstNotifications = Array.from({ length: 15 }, (_, i) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 461970850 },
            value: {
              signature: `BurstSig${i}111111111111111111111111111111111111111111`,
              err: null,
              logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
            },
          },
        },
      }),
    );

    const wsTransport = createMockWebSocketTransport({
      immediateAck: true,
      messagesToSend: burstNotifications,
    });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "queue-limit"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("STREAM_QUEUE_LIMIT_EXCEEDED");
    expect(result.message).toContain("ceiling of 10 notifications");

    // Prompt stop: zero cutoff attempts dispatched
    expect(result.ledger.getSlotAttempts).toBe(0);
    expect(result.ledger.getBlockTimeAttempts).toBe(0);
  });

  it("34. Stream limits: payload byte ceiling of 1MB stops promptly with STREAM_BYTE_LIMIT_EXCEEDED without calling cutoff RPCs", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    // Create oversized notification payload (> 1MB)
    const largeLogs = ["x".repeat(1024 * 1024 + 100)];
    const oversizedMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        result: {
          value: {
            signature: TEST_SIG_A,
            err: null,
            logs: largeLogs,
          },
        },
        subscription: 101,
      },
    });

    const wsTransport = createMockWebSocketTransport({
      immediateAck: true,
      messagesToSend: [oversizedMsg],
    });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "byte-limit"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("STREAM_BYTE_LIMIT_EXCEEDED");
    expect(result.ledger.getSlotAttempts).toBe(0);
  });

  it("35. Stream limits: message ceiling of 50 stops promptly with STREAM_MESSAGE_LIMIT_EXCEEDED without calling cutoff RPCs", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const messages = Array.from({ length: 55 }, (_, i) =>
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          result: {
            value: {
              signature: `MsgCeilingSig${i}1111111111111111111111111111111111111`,
              err: null,
              logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
            },
          },
          subscription: 101,
        },
      }),
    );

    const wsTransport = createMockWebSocketTransport({
      immediateAck: true,
      messagesToSend: messages,
    });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: path.join(testOutDir, "msg-limit"),
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(false);
    expect(
      result.status === "STREAM_MESSAGE_LIMIT_EXCEEDED" ||
        result.status === "STREAM_QUEUE_LIMIT_EXCEEDED",
    ).toBe(true);
    expect(result.ledger.getSlotAttempts).toBe(0);
  });

  it("36. Evidence sealing: saves responses, evidence files, and manifest with verified hashes and byte sizes", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);

    // Verify manifest exists and is parseable
    const manifestPath = path.join(testOutDir, "evidence-manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest.poolId).toBe(TEST_POOL_ID);
    expect(manifest.files.length).toBeGreaterThanOrEqual(15);
    expect(manifest.requests.length).toBe(11);

    // Verify every file listed in manifest matches its recorded bytes and SHA-256
    for (const f of manifest.files) {
      const fullPath = path.join(testOutDir, f.path);
      expect(existsSync(fullPath)).toBe(true);
      const bytes = readFileSync(fullPath);
      expect(bytes.length).toBe(f.bytes);
      const computedSha256 = createHash("sha256").update(bytes).digest("hex");
      expect(computedSha256).toBe(f.sha256);
    }

    // Verify evidence directory contains all required derivation artifacts
    expect(existsSync(path.join(testOutDir, "evidence", "lp-evidence.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "cutoff-evidence.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "history-evidence.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "market-data.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "mint-account.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "pre-admission.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "bundler-provenance.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "rugcheck-report.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "flow-evaluation.json"))).toBe(true);
    expect(existsSync(path.join(testOutDir, "evidence", "decision-result.json"))).toBe(true);

    // Verify response directory contains 11 sealed response files
    for (let i = 1; i <= 11; i++) {
      const prefix = String(i).padStart(2, "0");
      const matched = manifest.files.find((f: { path: string }) =>
        f.path.startsWith(`responses/${prefix}`),
      );
      expect(matched).toBeDefined();
    }
  });

  it("37. Wire digest: hashes raw wire bytes before decoding, preserving distinct wireDigestSha256 on UTF-8 BOM", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    // Injects UTF-8 BOM (0xEF, 0xBB, 0xBF) into getSlot response
    const transport = createDiagnosticMockFetch({
      includeBomInGetSlot: true,
      getClock: clock,
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const result = await diagnostic.run();
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ARMED_FIRST_TICK");

    const manifest = JSON.parse(
      readFileSync(path.join(testOutDir, "evidence-manifest.json"), "utf8"),
    );
    const slotReq = manifest.requests.find((r: { purpose: string }) => r.purpose === "GET_SLOT");
    expect(slotReq).toBeDefined();
    expect(slotReq.wireDigestSha256).toBeDefined();

    // The wire digest was computed on raw bytes with BOM
    const expectedBomBuffer = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", result: 461970880, id: "diag-3" }), "utf8"),
    ]);
    const expectedWireHash = createHash("sha256").update(expectedBomBuffer).digest("hex");
    expect(slotReq.wireDigestSha256).toBe(expectedWireHash);

    // The saved response file was sanitized and written without BOM
    const slotFileEntry = manifest.files.find(
      (f: { path: string }) => f.path === slotReq.responseFile,
    );
    expect(slotFileEntry).toBeDefined();
    // Saved artifact hash is distinct from wire digest
    expect(slotFileEntry.sha256).not.toBe(slotReq.wireDigestSha256);
  });

  it("38. Offline replay: replayCandidateDecisionFromSealedEvidence verifies manifest and reconstructs candidate decision without network or RPC calls", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(true);
    expect(diagResult.status).toBe("ARMED_FIRST_TICK");

    // Replay solely from testOutDir without network, mocks, or daemons
    const replay = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.status).toBe("ARMED_FIRST_TICK");
    expect(replay.decisionResult?.outcome).toBe("ARMED_FIRST_TICK");
    expect(replay.poolId).toBe(TEST_POOL_ID);
    expect(replay.mintAddress).toBe(TEST_MINT);
    expect(replay.verifiedFilesCount).toBeGreaterThanOrEqual(15);
    expect(replay.fileVerifications.every((v) => v.valid)).toBe(true);
  });

  it("39. Offline replay: detects tampering in sealed files fail-closed", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(true);

    // Tamper with one sealed evidence file
    const lpEvidencePath = path.join(testOutDir, "evidence", "lp-evidence.json");
    const lpContent = JSON.parse(readFileSync(lpEvidencePath, "utf8"));
    lpContent.tampered = true;
    writeFileSync(lpEvidencePath, JSON.stringify(lpContent), "utf8");

    // Replay must fail with EVIDENCE_INTEGRITY_MISMATCH
    const replay = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe("EVIDENCE_INTEGRITY_MISMATCH");
    expect(replay.message).toContain("evidence/lp-evidence.json");
  });

  it("40. WebSocket keepalive: initializes reliably with real WsWebSocketTransport wrapper contract (getUnderlyingSocket with readyState: 1 and no replayed open event)", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createRealInterfaceMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      pingIntervalMs: 25_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(true);
    expect(diagResult.status).toBe("ARMED_FIRST_TICK");
    expect(diagResult.keepaliveMetrics?.clientPingsSentCount).toBeGreaterThanOrEqual(1);
    expect(diagResult.keepaliveMetrics?.matchedClientPongsCount).toBe(
      diagResult.keepaliveMetrics?.clientPingsSentCount,
    );
    expect(wsTransport.isClosed()).toBe(true);
  });

  it("41. WebSocket keepalive: quiet qualification strictly requires keepalive scheduler started and matched pongs", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    // Socket that drops pongs
    const wsTransport = createMockWebSocketTransport({ immediateAck: true, autoPong: false });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      pingIntervalMs: 25_000,
      pongTimeoutMs: 5_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(false);
    expect(diagResult.status).toBe("KEEPALIVE_PONG_TIMEOUT");
    expect(diagResult.ledger.getSlotAttempts).toBe(0);
    expect(diagResult.ledger.getBlockTimeAttempts).toBe(0);
  });

  it("42. Control frame ceiling: counts inbound server PING frames and automatic PONG responses, stopping promptly with CONTROL_FRAME_LIMIT_EXCEEDED", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createRealInterfaceMockWebSocketTransport({
      immediateAck: true,
      onSend: () => {
        // Send 30 server PING frames (30 inbound pings + 30 auto pongs = 60 control frames > 50 limit)
        for (let i = 0; i < 30; i++) {
          wsTransport.emitServerPing(Buffer.alloc(100));
        }
      },
    });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      pingIntervalMs: 25_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(false);
    expect(diagResult.status).toBe("CONTROL_FRAME_LIMIT_EXCEEDED");
    expect(diagResult.ledger.getSlotAttempts).toBe(0);
    expect(diagResult.ledger.getBlockTimeAttempts).toBe(0);
  });

  it("43. Timer lifecycle: unhandled exception in observation immediately disposes keepalive timers in finally and terminates transport", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createRealInterfaceMockWebSocketTransport({ immediateAck: true });
    // Injected transport that fails during cutoff acquisition
    const transport = createDiagnosticMockFetch({
      getClock: clock,
      hangingRequest: true,
      hangingMethod: "getSlot",
    });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      pingIntervalMs: 25_000,
      requestTimeoutMs: 1_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(false);
    expect(wsTransport.isClosed()).toBe(true);
  });

  it("44. Manifest schema validation: rejects empty manifest.files, missing required files, or duplicate paths fail-closed", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(true);

    const manifestPath = path.join(testOutDir, "evidence-manifest.json");
    const originalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    // Case A: empty manifest.files
    const emptyFilesManifest = { ...originalManifest, files: [] };
    writeFileSync(manifestPath, JSON.stringify(emptyFilesManifest), "utf8");
    const replayEmpty = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayEmpty.ok).toBe(false);
    expect(replayEmpty.status).toBe("INVALID_MANIFEST_SCHEMA");

    // Case B: duplicate path in manifest.files
    const duplicateManifest = {
      ...originalManifest,
      files: [...originalManifest.files, originalManifest.files[0]],
    };
    writeFileSync(manifestPath, JSON.stringify(duplicateManifest), "utf8");
    const replayDuplicate = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayDuplicate.ok).toBe(false);
    expect(replayDuplicate.status).toBe("DUPLICATE_MANIFEST_ENTRY");

    // Case C: missing required evidence file in manifest.files
    const missingFileManifest = {
      ...originalManifest,
      files: originalManifest.files.filter(
        (f: { path: string }) => f.path !== "evidence/mint-account.json",
      ),
    };
    writeFileSync(manifestPath, JSON.stringify(missingFileManifest), "utf8");
    const replayMissing = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayMissing.ok).toBe(false);
    expect(replayMissing.status).toBe("INCOMPLETE_MANIFEST_COVERAGE");
  });

  it("45. Offline replay pre-admission recomputation: recomputes LP claims and authority evaluations from raw evidence without relying on derived flags", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(true);

    const manifestPath = path.join(testOutDir, "evidence-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const updateManifestFile = (relPath: string, newContent: string) => {
      const fullPath = path.join(testOutDir, relPath);
      writeFileSync(fullPath, newContent, "utf8");
      const buf = Buffer.from(newContent, "utf8");
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const entry = manifest.files.find((f: { path: string }) => f.path === relPath) as
        | { sha256: string; bytes: number }
        | undefined;
      if (entry) {
        entry.sha256 = sha256;
        entry.bytes = buf.length;
      }
      writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    };

    // Sub-case A: Tamper with derived flag meetsNinetyPercentThreshold = false in lp-evidence.json
    // Replay should STILL PASS because it recomputes from raw poolState and lpMintState using calculateAmmV4LpInaccessibleClaims
    const lpEvidencePath = path.join(testOutDir, "evidence", "lp-evidence.json");
    const lpEvidence = JSON.parse(readFileSync(lpEvidencePath, "utf8"));
    lpEvidence.validationResult.accounting.meetsNinetyPercentThreshold = false;
    lpEvidence.validationResult.accounting.displayInaccessiblePct = 0;
    updateManifestFile("evidence/lp-evidence.json", JSON.stringify(lpEvidence));

    const replayRecomputedPass = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayRecomputedPass.ok).toBe(true);
    expect(replayRecomputedPass.status).toBe("ARMED_FIRST_TICK");
    expect(replayRecomputedPass.auditMetadata).toBeDefined();
    expect(replayRecomputedPass.auditMetadata?.requests?.length).toBeGreaterThan(0);

    // Sub-case B: Tamper with raw lpMintState.supply to make it unlocked (< 90%), while keeping derived flag meetsNinetyPercentThreshold = true
    lpEvidence.validationResult.diagnostics.lpMintState.supply = "500000000000";
    lpEvidence.validationResult.accounting.meetsNinetyPercentThreshold = true;
    lpEvidence.validationResult.accounting.displayInaccessiblePct = 99.9;
    updateManifestFile("evidence/lp-evidence.json", JSON.stringify(lpEvidence));

    const replayUnlockedLp = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayUnlockedLp.ok).toBe(false);
    expect(replayUnlockedLp.status).toBe("REPLAY_PRE_ADMISSION_FAILED");
    expect(replayUnlockedLp.message).toContain("REJECTED_UNLOCKED_LP_RISK");

    // Restore lp-evidence
    lpEvidence.validationResult.diagnostics.lpMintState.supply = "0";
    updateManifestFile("evidence/lp-evidence.json", JSON.stringify(lpEvidence));

    // Sub-case C: Tamper with rawMintResponse to have active freeze authority, while keeping derived freezeAuthorityRenounced = true
    const mintAccountPath = path.join(testOutDir, "evidence", "mint-account.json");
    const mintAccountEvidence = JSON.parse(readFileSync(mintAccountPath, "utf8"));
    mintAccountEvidence.rawMintResponse.result.value.data.parsed.info.freezeAuthority =
      "So11111111111111111111111111111111111111112";
    mintAccountEvidence.candidateMintAccount.freezeAuthorityRenounced = true;
    updateManifestFile("evidence/mint-account.json", JSON.stringify(mintAccountEvidence));

    const replayActiveFreeze = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayActiveFreeze.ok).toBe(false);
    expect(replayActiveFreeze.status).toBe("REPLAY_PRE_ADMISSION_FAILED");
    expect(replayActiveFreeze.message).toContain("REJECTED_ACTIVE_FREEZE_AUTHORITY");
  });

  it("46. Replay manifest coverage: unverified files present on disk cause replay to fail before decision evaluation, and optional absent evidence is handled safely", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock });

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });

    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(true);

    const manifestPath = path.join(testOutDir, "evidence-manifest.json");
    const baselineManifestRaw = readFileSync(manifestPath, "utf8");
    const baselineManifest = JSON.parse(baselineManifestRaw);
    expect(baselineManifest.files.length).toBe(23);

    // Verify baseline replay succeeds with 23 verified files and outcome ARMED_FIRST_TICK
    const baselineReplay = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(baselineReplay.ok).toBe(true);
    expect(baselineReplay.status).toBe("ARMED_FIRST_TICK");
    expect(baselineReplay.verifiedFilesCount).toBe(23);

    // Sub-case A: Remove bundler-provenance entry from manifest.files and modify that file on disk to 0.9 bundlerPct
    const bundlerFilePath = path.join(testOutDir, "evidence", "bundler-provenance.json");
    const bundlerOriginalContent = readFileSync(bundlerFilePath, "utf8");
    const bundlerData = JSON.parse(bundlerOriginalContent);
    bundlerData.adaptedBundler.bundlerPct = 0.9;
    writeFileSync(bundlerFilePath, JSON.stringify(bundlerData), "utf8");

    const manifestNoBundler = {
      ...baselineManifest,
      files: baselineManifest.files.filter(
        (f: { path: string }) => f.path !== "evidence/bundler-provenance.json",
      ),
    };
    writeFileSync(manifestPath, JSON.stringify(manifestNoBundler), "utf8");

    // Replay must fail before decision evaluation (NOT return BUY_GATE_REJECTED or ok: true)
    const replayBundlerUnverified = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayBundlerUnverified.ok).toBe(false);
    expect(replayBundlerUnverified.status).toBe("INCOMPLETE_MANIFEST_COVERAGE");
    expect(replayBundlerUnverified.message).toContain("evidence/bundler-provenance.json");
    expect(replayBundlerUnverified.decisionResult).toBeUndefined();

    // Restore bundler file and manifest
    writeFileSync(bundlerFilePath, bundlerOriginalContent, "utf8");
    writeFileSync(manifestPath, baselineManifestRaw, "utf8");

    // Sub-case B: Remove flow-evaluation entry from manifest.files and modify that file on disk
    const flowFilePath = path.join(testOutDir, "evidence", "flow-evaluation.json");
    const flowOriginalContent = readFileSync(flowFilePath, "utf8");
    const flowData = JSON.parse(flowOriginalContent);
    flowData.isCoverageSufficient = false;
    writeFileSync(flowFilePath, JSON.stringify(flowData), "utf8");

    const manifestNoFlow = {
      ...baselineManifest,
      files: baselineManifest.files.filter(
        (f: { path: string }) => f.path !== "evidence/flow-evaluation.json",
      ),
    };
    writeFileSync(manifestPath, JSON.stringify(manifestNoFlow), "utf8");

    const replayFlowUnverified = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayFlowUnverified.ok).toBe(false);
    expect(replayFlowUnverified.status).toBe("INCOMPLETE_MANIFEST_COVERAGE");
    expect(replayFlowUnverified.message).toContain("evidence/flow-evaluation.json");
    expect(replayFlowUnverified.decisionResult).toBeUndefined();

    // Restore flow file and manifest
    writeFileSync(flowFilePath, flowOriginalContent, "utf8");
    writeFileSync(manifestPath, baselineManifestRaw, "utf8");

    // Sub-case C: Remove rugcheck-report entry from manifest.files and modify that file on disk
    const rugCheckFilePath = path.join(testOutDir, "evidence", "rugcheck-report.json");
    const rugCheckOriginalContent = readFileSync(rugCheckFilePath, "utf8");
    const rugCheckData = JSON.parse(rugCheckOriginalContent);
    rugCheckData.rugMetrics = {
      ...(rugCheckData.rugMetrics ?? {}),
      hasDangerRisk: true,
      rugScore: 900,
    };
    writeFileSync(rugCheckFilePath, JSON.stringify(rugCheckData), "utf8");

    const manifestNoRugCheck = {
      ...baselineManifest,
      files: baselineManifest.files.filter(
        (f: { path: string }) => f.path !== "evidence/rugcheck-report.json",
      ),
    };
    writeFileSync(manifestPath, JSON.stringify(manifestNoRugCheck), "utf8");

    const replayRugCheckUnverified = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayRugCheckUnverified.ok).toBe(false);
    expect(replayRugCheckUnverified.status).toBe("INCOMPLETE_MANIFEST_COVERAGE");
    expect(replayRugCheckUnverified.message).toContain("evidence/rugcheck-report.json");
    expect(replayRugCheckUnverified.decisionResult).toBeUndefined();

    // Restore rugcheck file and manifest
    writeFileSync(rugCheckFilePath, rugCheckOriginalContent, "utf8");
    writeFileSync(manifestPath, baselineManifestRaw, "utf8");

    // Sub-case D: Optional evidence absent and unavailable: deleted from disk AND excluded from manifest
    // Replay must succeed verification with 22 verified files and evaluate with bundler unavailable (BUY_GATE_REJECTED)
    unlinkSync(bundlerFilePath);
    writeFileSync(manifestPath, JSON.stringify(manifestNoBundler), "utf8");

    const replayAbsentOptional = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayAbsentOptional.ok).toBe(true);
    expect(replayAbsentOptional.status).toBe("BUY_GATE_REJECTED");
    expect(replayAbsentOptional.verifiedFilesCount).toBe(22);
    expect(replayAbsentOptional.decisionResult?.outcome).toBe("BUY_GATE_REJECTED");
    expect(replayAbsentOptional.decisionResult?.rejectionReason).toBe(
      "BUNDLER_CONCENTRATION_UNKNOWN",
    );

    // Sub-case D2: Optional flow-evaluation absent on disk and excluded from manifest:
    // Replay succeeds with 22 verified files and falls back to report.flowEvaluation, outcome ARMED_FIRST_TICK
    writeFileSync(bundlerFilePath, bundlerOriginalContent, "utf8");
    unlinkSync(flowFilePath);
    writeFileSync(manifestPath, JSON.stringify(manifestNoFlow), "utf8");

    const replayAbsentFlow = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayAbsentFlow.ok).toBe(true);
    expect(replayAbsentFlow.status).toBe("ARMED_FIRST_TICK");
    expect(replayAbsentFlow.verifiedFilesCount).toBe(22);
    expect(replayAbsentFlow.decisionResult?.outcome).toBe("ARMED_FIRST_TICK");

    writeFileSync(flowFilePath, flowOriginalContent, "utf8");

    // Sub-case E: Unlisted extra file in responses/ directory fails before decision evaluation
    writeFileSync(bundlerFilePath, bundlerOriginalContent, "utf8");
    writeFileSync(manifestPath, baselineManifestRaw, "utf8");
    const extraResponsePath = path.join(testOutDir, "responses", "99-unlisted-response.json");
    writeFileSync(extraResponsePath, "{}", "utf8");

    const replayUnlistedResponse = replayCandidateDecisionFromSealedEvidence(testOutDir);
    expect(replayUnlistedResponse.ok).toBe(false);
    expect(replayUnlistedResponse.status).toBe("INCOMPLETE_MANIFEST_COVERAGE");
    expect(replayUnlistedResponse.message).toContain("responses/99-unlisted-response.json");
    expect(replayUnlistedResponse.decisionResult).toBeUndefined();

    unlinkSync(extraResponsePath);
  });
});

/**
 * SYNTHETIC TEST HELPER — re-seals a capture that this test suite generated locally (mock transports,
 * synthetic clock) after deliberate edits, so replay *semantics* are exercised rather than integrity
 * rejection. Never applied to operator captures under data/research.
 */
function resealSyntheticCapture(dir: string): void {
  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
  const manifestPath = path.join(dir, "evidence-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
    reportFile: { path: string; bytes: number; sha256: string };
  };
  manifest.files = manifest.files
    .filter((f) => existsSync(path.join(dir, f.path)))
    .map((f) => {
      const buf = readFileSync(path.join(dir, f.path));
      return { ...f, bytes: buf.length, sha256: sha(buf) };
    });
  const reportBuf = readFileSync(path.join(dir, manifest.reportFile.path));
  manifest.reportFile = { ...manifest.reportFile, bytes: reportBuf.length, sha256: sha(reportBuf) };
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
}

interface SealedCutoffJson {
  cutoffTimestampMs: number;
}
interface SealedFlowJson {
  evaluationTimestampMs: number;
}
interface SealedHistoryJson {
  outcome: string;
  connectionEpoch: number;
  records?: unknown;
  discoveredSignatures: unknown[];
}
interface SealedReportJson {
  observationMetadata?: unknown;
  keepaliveMetrics?: unknown;
}
interface SealedRpcPageJson {
  result: unknown[];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

describe("CandidateDecisionDiagnostic replay: recorded outcomes and unknown metadata (synthetic captures)", () => {
  const replayOutDir = path.resolve(
    process.cwd(),
    ".tmp",
    "test-diagnostics",
    `replay-semantics-${Date.now()}`,
  );

  beforeEach(() => {
    if (existsSync(replayOutDir)) {
      rmSync(replayOutDir, { recursive: true, force: true });
    }
  });

  /** Synthetic non-quiet capture that terminates with STALE_DATA at the final decision freshness recheck. */
  async function runSyntheticStaleCapture() {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };
    const notificationMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 101,
        result: {
          context: { slot: 461970850 },
          value: {
            signature: TEST_SIG_B,
            err: null,
            logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
          },
        },
      },
    });
    const wsTransport = createMockWebSocketTransport({
      immediateAck: true,
      messagesToSend: [notificationMsg],
    });
    const baseFetch = createDiagnosticMockFetch({ getClock: clock });
    // Synthetic delay: the RugCheck response consumes 15.5 s of synthetic time, so the source cutoff
    // is older than 15,000 ms by the Phase 6 decision recheck (mirrors a late-stage STALE_DATA failure).
    const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.includes("api.rugcheck.xyz/v1/tokens/")) {
        clockTime += 15_500;
      }
      return baseFetch(input, init);
    };
    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: replayOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      overallTimeoutMs: 180_000,
    });
    return diagnostic.run();
  }

  /** Synthetic quiet capture that completes with a Buy Gate rejection on the maturity window. */
  async function runSyntheticMatureRejectionCapture() {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };
    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({ getClock: clock, ageSeconds: 64_972_286 });
    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: replayOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });
    return diagnostic.run();
  }

  it("R1. STALE_DATA capture: replay preserves recorded termination and evaluates no Buy Gate decision", async () => {
    const diagResult = await runSyntheticStaleCapture();
    expect(diagResult.ok).toBe(false);
    expect(diagResult.status).toBe("STALE_DATA");
    expect(diagResult.message).toContain("at decision timestamp");
    expect(diagResult.decisionResult).toBeUndefined();
    expect(diagResult.flowEvaluation?.flowCoverage).toBe("COLLECTION_GAP");

    // The earlier flow snapshot was still within 15 s of the cutoff; using its timestamp would
    // bypass the later recorded freshness failure.
    const flowSnapshot = readJson<SealedFlowJson>(
      path.join(replayOutDir, "evidence", "flow-evaluation.json"),
    );
    const cutoff = readJson<SealedCutoffJson>(
      path.join(replayOutDir, "evidence", "cutoff-evidence.json"),
    );
    expect(flowSnapshot.evaluationTimestampMs - cutoff.cutoffTimestampMs).toBeLessThanOrEqual(
      15_000,
    );

    const replay = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(replay.integrityVerified).toBe(true);
    expect(replay.fileVerifications.every((v) => v.valid)).toBe(true);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe("STALE_DATA");
    expect(replay.replayMode).toBe("RECORDED_TERMINATION_PRESERVED");
    expect(replay.recordedTermination?.status).toBe("STALE_DATA");
    expect(replay.recordedTermination?.message).toBe(diagResult.message);
    expect(replay.decisionResult).toBeUndefined();
    expect(replay.recordedDecision).toBeUndefined();
    expect(replay.matchesRecordedDecision).toBeUndefined();
    expect(replay.auditMetadata?.gapMetadata?.flowCoverage).toBe("COLLECTION_GAP");
    expect(replay.auditMetadata?.gapMetadata?.isCoverageSufficient).toBe(false);
  });

  it("R2. Missing observation/keepalive metadata stays unknown (null), never synthesized from cutoff or defaults", async () => {
    const diagResult = await runSyntheticStaleCapture();
    expect(diagResult.status).toBe("STALE_DATA");
    // New failure reports record the actual observation and keepalive state.
    expect(diagResult.observationMetadata?.notificationsReceived).toBe(1);
    expect(diagResult.keepaliveMetrics).toBeDefined();

    // SYNTHETIC edit + reseal emulating a historical failure report that never recorded them.
    const staleReportPath = path.join(replayOutDir, "diagnostic-report.json");
    const historicalLike = readJson<SealedReportJson>(staleReportPath);
    delete historicalLike.observationMetadata;
    delete historicalLike.keepaliveMetrics;
    writeFileSync(staleReportPath, JSON.stringify(historicalLike), "utf8");
    resealSyntheticCapture(replayOutDir);

    const replay = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    const obs = replay.auditMetadata?.observation;
    expect(obs?.observationMetadataStatus).toBe("NOT_RECORDED_IN_SEALED_REPORT");
    expect(obs?.observationStartMs).toBeNull();
    expect(obs?.observationEndMs).toBeNull();
    expect(obs?.observationDurationMs).toBeNull();
    expect(obs?.notificationsReceived).toBeNull();
    expect(obs?.keepaliveMetricsStatus).toBe("NOT_RECORDED_IN_SEALED_REPORT");
    expect(obs?.keepaliveStats).toBeNull();
    // The flow snapshot carries no epoch; it is not defaulted to 0.
    expect(obs?.flowConnectionEpoch).toBeNull();
    // Recorded values are still reported from verified evidence.
    const cutoff = readJson<SealedCutoffJson>(
      path.join(replayOutDir, "evidence", "cutoff-evidence.json"),
    );
    const history = readJson<SealedHistoryJson>(
      path.join(replayOutDir, "evidence", "history-evidence.json"),
    );
    expect(obs?.cutoffTimestampMs).toBe(cutoff.cutoffTimestampMs);
    expect(obs?.historyConnectionEpoch).toBe(history.connectionEpoch);

    // Synthetic edit + reseal: a completed report without observation/keepalive metadata also stays unknown.
    rmSync(replayOutDir, { recursive: true, force: true });
    const completed = await runSyntheticMatureRejectionCapture();
    expect(completed.ok).toBe(true);
    const reportPath = path.join(replayOutDir, "diagnostic-report.json");
    const completedReport = readJson<SealedReportJson>(reportPath);
    delete completedReport.observationMetadata;
    delete completedReport.keepaliveMetrics;
    writeFileSync(reportPath, JSON.stringify(completedReport), "utf8");
    resealSyntheticCapture(replayOutDir);

    const completedReplay = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(completedReplay.ok).toBe(true);
    expect(completedReplay.auditMetadata?.observation?.observationMetadataStatus).toBe(
      "NOT_RECORDED_IN_SEALED_REPORT",
    );
    expect(completedReplay.auditMetadata?.observation?.observationStartMs).toBeNull();
    expect(completedReplay.auditMetadata?.observation?.observationEndMs).toBeNull();
    expect(completedReplay.auditMetadata?.observation?.notificationsReceived).toBeNull();
    expect(completedReplay.auditMetadata?.observation?.keepaliveStats).toBeNull();
  });

  it("R3. History counts: returned enumeration rows come from verified responses and are distinct from new signatures since anchor", async () => {
    const diagResult = await runSyntheticStaleCapture();
    expect(diagResult.status).toBe("STALE_DATA");
    const history = readJson<SealedHistoryJson>(
      path.join(replayOutDir, "evidence", "history-evidence.json"),
    );
    expect(history.records).toBeUndefined(); // sealed summary has no records field
    expect(history.outcome).toBe("ANCHOR_WITNESSED");

    const enumRecord = diagResult.ledger.records.find((r) => r.purpose === "HISTORY_ENUMERATION");
    expect(enumRecord?.responseFile).toBeDefined();
    const enumResponse = readJson<SealedRpcPageJson>(
      path.join(replayOutDir, enumRecord!.responseFile!),
    );
    const returnedRows = enumResponse.result.length;

    const replay = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    const gap = replay.auditMetadata?.gapMetadata;
    expect(gap?.historyOutcome).toBe("ANCHOR_WITNESSED");
    expect(gap?.historyEnumerationRowsReturned).toBe(returnedRows);
    expect(gap?.historyEnumerationRowsBasis).toContain("VERIFIED_RESPONSE_FILES");
    expect(gap?.newSignaturesSinceAnchor).toBe(history.discoveredSignatures.length);
    expect(returnedRows).toBeGreaterThan(0);
    // Returned rows include the anchor and older rows, so they exceed newly discovered signatures.
    expect(returnedRows).toBeGreaterThan(gap!.newSignaturesSinceAnchor!);
    expect(gap).not.toHaveProperty("historyRecordsCount");

    // Synthetic removal + reseal: without a verified enumeration response, returned rows are unknown.
    unlinkSync(path.join(replayOutDir, enumRecord!.responseFile!));
    resealSyntheticCapture(replayOutDir);
    const replayNoResponse = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(replayNoResponse.integrityVerified).toBe(true);
    expect(replayNoResponse.auditMetadata?.gapMetadata?.historyEnumerationRowsReturned).toBeNull();
    expect(replayNoResponse.auditMetadata?.gapMetadata?.historyEnumerationRowsBasis).toContain(
      "UNAVAILABLE",
    );
    expect(replayNoResponse.auditMetadata?.gapMetadata?.newSignaturesSinceAnchor).toBe(
      history.discoveredSignatures.length,
    );
  });

  it("R4. Completed rejection: replay re-evaluates at the recorded decision time and reproduces MATURITY_WINDOW_GATE_FAILED", async () => {
    const diagResult = await runSyntheticMatureRejectionCapture();
    expect(diagResult.ok).toBe(true);
    expect(diagResult.status).toBe("BUY_GATE_REJECTED");
    expect(diagResult.decisionResult?.rejectionReason).toBe("MATURITY_WINDOW_GATE_FAILED");
    const recordedDecisionTimeMs = diagResult.decisionResult!.flowResult.evaluationTimestampMs;

    const replay = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.integrityVerified).toBe(true);
    expect(replay.replayMode).toBe("DECISION_REEVALUATED");
    expect(replay.status).toBe("BUY_GATE_REJECTED");
    expect(replay.decisionResult?.rejectionReason).toBe("MATURITY_WINDOW_GATE_FAILED");
    expect(replay.recordedDecision).toEqual({
      outcome: "BUY_GATE_REJECTED",
      rejectionReason: "MATURITY_WINDOW_GATE_FAILED",
      decisionTimestampMs: recordedDecisionTimeMs,
    });
    expect(replay.matchesRecordedDecision).toBe(true);
    expect(replay.decisionResult?.flowResult.evaluationTimestampMs).toBe(recordedDecisionTimeMs);

    // Recorded observation metadata is passed through unchanged.
    const obs = replay.auditMetadata?.observation;
    expect(obs?.observationMetadataStatus).toBe("RECORDED");
    expect(obs?.observationStartMs).toBe(diagResult.observationMetadata?.observationStartMs);
    expect(obs?.observationEndMs).toBe(diagResult.observationMetadata?.observationEndMs);
    expect(obs?.notificationsReceived).toBe(diagResult.observationMetadata?.notificationsReceived);
    expect(obs?.keepaliveMetricsStatus).toBe("RECORDED");
    expect(obs?.keepaliveStats).toEqual(diagResult.keepaliveMetrics);

    // The substituted discoveredAt is explicitly labeled synthetic and non-semantic.
    const synthetic = replay.auditMetadata?.syntheticReplayContext?.discoveredAt;
    expect(synthetic?.value).toBe(new Date(recordedDecisionTimeMs).toISOString());
    expect(synthetic?.reason).toContain("NON_SEMANTIC_SYNTHETIC");
  });

  it("R5. Completed capture: an earlier flow timestamp or stale recorded decision time fails closed without a decision", async () => {
    const diagResult = await runSyntheticMatureRejectionCapture();
    expect(diagResult.ok).toBe(true);
    const flowPath = path.join(replayOutDir, "evidence", "flow-evaluation.json");
    const reportPath = path.join(replayOutDir, "diagnostic-report.json");
    const originalFlow = readFileSync(flowPath, "utf8");
    const originalReport = readFileSync(reportPath, "utf8");
    const originalManifest = readFileSync(
      path.join(replayOutDir, "evidence-manifest.json"),
      "utf8",
    );

    // Synthetic edit: the flow snapshot claims an earlier evaluation time than the recorded decision.
    const flow = JSON.parse(originalFlow);
    flow.evaluationTimestampMs -= 5_000;
    writeFileSync(flowPath, JSON.stringify(flow), "utf8");
    resealSyntheticCapture(replayOutDir);
    const mismatch = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.status).toBe("REPLAY_DECISION_TIME_MISMATCH");
    expect(mismatch.decisionResult).toBeUndefined();

    // Synthetic edit: recorded decision time 20 s after cutoff exceeds the unchanged 15,000 ms ceiling.
    writeFileSync(flowPath, originalFlow, "utf8");
    writeFileSync(reportPath, originalReport, "utf8");
    writeFileSync(path.join(replayOutDir, "evidence-manifest.json"), originalManifest, "utf8");
    const cutoff = readJson<SealedCutoffJson>(
      path.join(replayOutDir, "evidence", "cutoff-evidence.json"),
    );
    const staleDecisionMs = cutoff.cutoffTimestampMs + 20_000;
    const staleFlow = JSON.parse(originalFlow);
    staleFlow.evaluationTimestampMs = staleDecisionMs;
    writeFileSync(flowPath, JSON.stringify(staleFlow), "utf8");
    const staleReport = JSON.parse(originalReport);
    staleReport.decisionResult.flowResult.evaluationTimestampMs = staleDecisionMs;
    writeFileSync(reportPath, JSON.stringify(staleReport), "utf8");
    resealSyntheticCapture(replayOutDir);
    const stale = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(stale.ok).toBe(false);
    expect(stale.status).toBe("REPLAY_STALE_DATA");
    expect(stale.decisionResult).toBeUndefined();
  });

  it("R6. Correctly sealed below-threshold pre-admission rejection: replay preserves PRE_ADMISSION_REJECTED after raw revalidation", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };
    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: replayOutDir,
      // SYNTHETIC: captured RAY/WSOL accounts whose protocol-derived LP inaccessibility is far below 90%.
      transport: createDiagnosticMockFetch({ getClock: clock, unqualifiedLp: true }),
      wsTransport: createMockWebSocketTransport({ immediateAck: true }),
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
    });
    const diagResult = await diagnostic.run();
    expect(diagResult.ok).toBe(false);
    expect(diagResult.status).toBe("PRE_ADMISSION_REJECTED");
    expect(diagResult.preAdmissionScreening?.rejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
    expect(diagResult.ledger.rugCheckAttempts).toBe(0);

    const replay = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(replay.integrityVerified).toBe(true);
    expect(replay.fileVerifications.every((v) => v.valid)).toBe(true);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe("PRE_ADMISSION_REJECTED");
    expect(replay.replayMode).toBe("RECORDED_TERMINATION_PRESERVED");
    expect(replay.recordedTermination?.message).toBe(diagResult.message);
    expect(replay.recomputedPreAdmission?.passed).toBe(false);
    expect(replay.recomputedPreAdmission?.lpSecurityPassed).toBe(false);
    expect(replay.recomputedPreAdmission?.rejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
    expect(replay.decisionResult).toBeUndefined();

    // Tamper safeguard retained: raw LP edited to pass, without resealing, fails integrity.
    const lpPath = path.join(replayOutDir, "evidence", "lp-evidence.json");
    const originalLp = readFileSync(lpPath, "utf8");
    const lp = JSON.parse(originalLp);
    lp.validationResult.diagnostics.lpMintState.supply = "0";
    writeFileSync(lpPath, JSON.stringify(lp), "utf8");
    const tampered = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(tampered.status).toBe("EVIDENCE_INTEGRITY_MISMATCH");
    expect(tampered.integrityVerified).toBeUndefined();

    // Synthetic edit + reseal: raw evidence that now passes contradicts the recorded rejection.
    resealSyntheticCapture(replayOutDir);
    const contradicted = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(contradicted.ok).toBe(false);
    expect(contradicted.status).toBe("REPLAY_PRE_ADMISSION_MISMATCH");
    expect(contradicted.replayMode).toBeUndefined();
    expect(contradicted.decisionResult).toBeUndefined();

    // Structural corruption (missing raw LP state) remains distinct from qualification failure.
    delete lp.validationResult.diagnostics.lpMintState;
    writeFileSync(lpPath, JSON.stringify(lp), "utf8");
    resealSyntheticCapture(replayOutDir);
    const structural = replayCandidateDecisionFromSealedEvidence(replayOutDir);
    expect(structural.status).toBe("REPLAY_LP_EVIDENCE_INVALID");
    expect(structural.replayMode).toBeUndefined();
  });
});

describe("CandidateDecisionDiagnostic RugCheck opt-ins (synthetic, offline)", () => {
  const optOutDir = path.resolve(
    process.cwd(),
    ".tmp",
    "test-diagnostics",
    `rugcheck-optins-${Date.now()}`,
  );
  const MIB = 1024 * 1024;
  const sha256Hex = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

  const resetOutDir = () => {
    if (existsSync(optOutDir)) {
      rmSync(optOutDir, { recursive: true, force: true });
    }
  };
  beforeEach(resetOutDir);

  /** SYNTHETIC RugCheck report that passes strict validation, padded to approximately targetBytes. */
  function syntheticRugCheckBody(targetBytes: number, overrides: Record<string, unknown> = {}) {
    const base: Record<string, unknown> = {
      score: 150,
      tokenMeta: { mutable: false },
      topHolders: [
        { address: "Holder1", pct: 5.0 },
        { address: "Holder2", pct: 4.0 },
      ],
      totalHolders: 450,
      risks: [{ name: "Info", level: "info" }],
      syntheticPadding: "",
      ...overrides,
    };
    const baseLen = Buffer.byteLength(JSON.stringify(base));
    return JSON.stringify({
      ...base,
      syntheticPadding: "x".repeat(Math.max(0, targetBytes - baseLen)),
    });
  }

  interface RugCheckCtx {
    readonly init?: RequestInit | undefined;
    readonly advanceClock: (ms: number) => void;
  }

  async function runOptIn(params: {
    rugCheck?: (ctx: RugCheckCtx) => Promise<Response> | Response;
    pairOverride?: () => Response;
    scenario?: MockFetchScenario;
    rugCheckMaxResponseBytes?: number;
    overlapRugCheckWithMintPacing?: boolean;
    requestTimeoutMs?: number;
    overallTimeoutMs?: number;
    /** SYNTHETIC: once RugCheck is requested, each pacing sleep also takes this much real time. */
    realPacingDelayAfterRugCheckMs?: number;
    hangCandidateMint?: boolean;
  }) {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    let rugCheckRequested = false;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      if (rugCheckRequested && params.realPacingDelayAfterRugCheckMs) {
        await new Promise((resolve) => setTimeout(resolve, params.realPacingDelayAfterRugCheckMs));
      } else {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    // Transport call log: every request that reached the (mock) network, in order.
    const transportCalls: string[] = [];
    let callsAfterRateLimit = 0;
    let rateLimitServed = false;
    const baseFetch = createDiagnosticMockFetch({ getClock: clock, ...(params.scenario ?? {}) });
    const rugCheckSignals: AbortSignal[] = [];
    const candidateMintSignals: AbortSignal[] = [];
    const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const rpcMethod =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { method?: string }).method
          : undefined;
      transportCalls.push(rpcMethod ?? urlStr);
      if (rateLimitServed) callsAfterRateLimit++;
      if (urlStr.includes("api.rugcheck.xyz/v1/tokens/")) {
        rugCheckRequested = true;
        if (init?.signal) rugCheckSignals.push(init.signal);
        if (params.rugCheck) {
          const res = await params.rugCheck({
            init,
            advanceClock: (ms) => {
              clockTime += ms;
            },
          });
          if (res.status === 429) rateLimitServed = true;
          return res;
        }
      }
      if (
        params.hangCandidateMint &&
        typeof init?.body === "string" &&
        init.body.includes('"jsonParsed"')
      ) {
        // SYNTHETIC: CANDIDATE_MINT in flight until aborted.
        candidateMintSignals.push(init.signal!);
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      if (params.pairOverride && urlStr.includes("api.dexscreener.com/latest/dex/pairs")) {
        return params.pairOverride();
      }
      return baseFetch(input, init);
    };
    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: optOutDir,
      transport,
      wsTransport: createMockWebSocketTransport({ immediateAck: true }),
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      ...(params.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: params.requestTimeoutMs }
        : {}),
      ...(params.overallTimeoutMs !== undefined
        ? { overallTimeoutMs: params.overallTimeoutMs }
        : {}),
      ...(params.rugCheckMaxResponseBytes !== undefined
        ? { rugCheckMaxResponseBytes: params.rugCheckMaxResponseBytes }
        : {}),
      ...(params.overlapRugCheckWithMintPacing !== undefined
        ? { overlapRugCheckWithMintPacing: params.overlapRugCheckWithMintPacing }
        : {}),
    });
    const result = await diagnostic.run();
    return {
      result,
      rugCheckSignals,
      candidateMintSignals,
      transportCalls,
      callsAfterRateLimit: () => callsAfterRateLimit,
    };
  }

  const recordOf = (result: CandidateDecisionDiagnosticResult, purpose: string) =>
    result.ledger.records.filter((r) => r.purpose === purpose);
  const rugCheckRecord = (result: CandidateDecisionDiagnosticResult): DiagnosticRequestRecord => {
    const recs = recordOf(result, "RUGCHECK_REPORT");
    expect(recs).toHaveLength(1);
    return recs[0]!;
  };

  /** Every dispatched attempt recorded once, linked to a unique sealed response, within budgets and pacing. */
  function expectLedgerConsistent(result: CandidateDecisionDiagnosticResult) {
    const { ledger } = result;
    expect(ledger.records).toHaveLength(ledger.totalAttempts);
    expect(ledger.totalAttempts).toBeLessThanOrEqual(14);
    expect(ledger.transactionDecodeAttempts).toBeLessThanOrEqual(3);
    expect(ledger.rugCheckAttempts).toBeLessThanOrEqual(1);
    expect(recordOf(result, "RUGCHECK_REPORT")).toHaveLength(ledger.rugCheckAttempts);
    const files = ledger.records.map((r) => r.responseFile);
    expect(new Set(files).size).toBe(files.length);
    const manifest = readJson<{ files: Array<{ path: string }> }>(
      path.join(optOutDir, "evidence-manifest.json"),
    );
    const listed = new Set(manifest.files.map((f) => f.path));
    for (const file of files) {
      expect(listed.has(file!)).toBe(true);
    }
    const rpcDispatches = ledger.records
      .filter((r) => r.provider === "SOLANA_RPC")
      .map((r) => r.dispatchedAtMs)
      .sort((a, b) => a - b);
    for (let i = 1; i < rpcDispatches.length; i++) {
      expect(rpcDispatches[i]! - rpcDispatches[i - 1]!).toBeGreaterThanOrEqual(2_500);
    }
  }

  const rugCheckEvidence = () =>
    readJson<Record<string, unknown>>(path.join(optOutDir, "evidence", "rugcheck-report.json"));

  it("O1. Default: shared 1 MiB ceiling and serial retrieval; a complete >1 MiB report stays unavailable", async () => {
    const body = syntheticRugCheckBody(1.5 * MIB);
    const { result } = await runOptIn({ rugCheck: () => new Response(body, { status: 200 }) });
    expect(result.ok).toBe(true);
    expect(result.decisionResult?.outcome).toBe("BUY_GATE_REJECTED");

    const rc = rugCheckRecord(result);
    expect(rc.ok).toBe(false);
    expect(rc.error).toContain(`maximum allowed limit of ${DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES}`);
    expect(rc.responseBodyMetadata?.bodyStatus).toBe("OVER_LIMIT");
    expect(rc.responseBodyMetadata?.ceilingBytes).toBe(MIB);
    expect(rc.responseBodyMetadata?.retainedBytes).toBe(MIB);
    expect(rc.responseBodyMetadata?.retainedSha256).toBe(
      sha256Hex(Buffer.from(body, "utf8").subarray(0, MIB)),
    );
    expect(rc.responseBodyMetadata?.observedBytesAtStopLowerBound).toBeGreaterThan(MIB);
    // No truncated prefix is sealed.
    expect(readFileSync(path.join(optOutDir, rc.responseFile!)).length).toBe(0);

    // Serial default: RugCheck dispatched only after CANDIDATE_MINT completed.
    const mint = recordOf(result, "CANDIDATE_MINT")[0]!;
    expect(rc.dispatchedAtMs).toBeGreaterThanOrEqual(mint.completedAtMs);

    const evidence = rugCheckEvidence();
    expect(evidence.rugMetrics).toBeNull();
    expect(evidence.validationStatus).toBe("REQUEST_NOT_OK");
    expect(evidence.retrievalMode).toBe("SERIAL_AFTER_PRE_ADMISSION");
    expect(evidence).not.toHaveProperty("rawRugCheck");
    expectLedgerConsistent(result);

    const replay = replayCandidateDecisionFromSealedEvidence(optOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.matchesRecordedDecision).toBe(true);
    expect(replay.recomputedRugCheck?.status).toBe("REQUEST_NOT_OK");
    expect(replay.recomputedRugCheck?.metrics).toBeNull();
  });

  it("O2. Explicit 4 MiB RugCheck ceiling: complete valid reports above 1 MiB and below 4 MiB succeed and replay", async () => {
    for (const size of [1.5 * MIB, 3.9 * MIB]) {
      resetOutDir();
      const body = syntheticRugCheckBody(size);
      expect(Buffer.byteLength(body)).toBeGreaterThan(MIB);
      expect(Buffer.byteLength(body)).toBeLessThan(4 * MIB);
      const { result } = await runOptIn({
        rugCheck: () => new Response(body, { status: 200 }),
        rugCheckMaxResponseBytes: DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES,
      });
      expect(result.status).toBe("ARMED_FIRST_TICK");

      const rc = rugCheckRecord(result);
      expect(rc.ok).toBe(true);
      expect(rc.responseBodyMetadata?.bodyStatus).toBe("COMPLETE");
      expect(rc.responseBodyMetadata?.ceilingBytes).toBe(4 * MIB);
      expect(rc.responseBodyMetadata?.retainedBytes).toBe(Buffer.byteLength(body));
      expect(rc.responseBodyMetadata?.retainedSha256).toBe(sha256Hex(Buffer.from(body, "utf8")));
      expect(rc.responseBodyMetadata?.retainedSha256).toBe(rc.wireDigestSha256);
      expect(rc.responseBodyMetadata?.observedBytesAtStopLowerBound).toBeNull();

      // Full sanitized response sealed once; derived evidence references it without duplicating it.
      const sealed = JSON.parse(readFileSync(path.join(optOutDir, rc.responseFile!), "utf8"));
      expect(sealed).toEqual(JSON.parse(body));
      const evidencePath = path.join(optOutDir, "evidence", "rugcheck-report.json");
      expect(readFileSync(evidencePath).length).toBeLessThan(8_192);
      const evidence = rugCheckEvidence();
      expect(evidence.validationStatus).toBe("AVAILABLE");
      expect(evidence.responseFile).toBe(rc.responseFile);
      expect(evidence.rugMetrics).toEqual({
        rugScore: 150,
        hasDangerRisk: false,
        top10HolderPct: 0.09,
        holdersCount: 450,
      });
      expectLedgerConsistent(result);

      const replay = replayCandidateDecisionFromSealedEvidence(optOutDir);
      expect(replay.ok).toBe(true);
      expect(replay.status).toBe("ARMED_FIRST_TICK");
      expect(replay.matchesRecordedDecision).toBe(true);
      expect(replay.recomputedRugCheck?.status).toBe("AVAILABLE");
      expect(replay.recomputedRugCheck?.metrics?.holdersCount).toBe(450);
    }
  });

  it("O3. Over-limit, truncated, malformed, and stalled RugCheck responses remain unavailable under the opt-in", async () => {
    const opt = { rugCheckMaxResponseBytes: DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES };

    // Over-limit: never parsed; retained prefix and lower bound recorded separately.
    resetOutDir();
    const overBody = syntheticRugCheckBody(4 * MIB + 1);
    expect(Buffer.byteLength(overBody)).toBeGreaterThan(4 * MIB);
    const over = await runOptIn({
      ...opt,
      rugCheck: () => new Response(overBody, { status: 200 }),
    });
    expect(over.result.status).not.toBe("ARMED_FIRST_TICK");
    const overRc = rugCheckRecord(over.result);
    expect(overRc.ok).toBe(false);
    expect(overRc.responseBodyMetadata?.bodyStatus).toBe("OVER_LIMIT");
    expect(overRc.responseBodyMetadata?.retainedBytes).toBe(4 * MIB);
    expect(overRc.responseBodyMetadata?.observedBytesAtStopLowerBound).toBeGreaterThan(4 * MIB);
    expect(rugCheckEvidence().rugMetrics).toBeNull();

    // Truncated document (complete transfer of an incomplete JSON body): unavailable.
    resetOutDir();
    const truncatedBody = syntheticRugCheckBody(2 * MIB).slice(0, 1.5 * MIB);
    const truncated = await runOptIn({
      ...opt,
      rugCheck: () => new Response(truncatedBody, { status: 200 }),
    });
    expect(truncated.result.status).not.toBe("ARMED_FIRST_TICK");
    expect(rugCheckEvidence().validationStatus).toBe("RESPONSE_NOT_JSON");
    expect(rugCheckEvidence().rugMetrics).toBeNull();
    const truncatedReplay = replayCandidateDecisionFromSealedEvidence(optOutDir);
    expect(truncatedReplay.recomputedRugCheck?.metrics).toBeNull();
    expect(truncatedReplay.matchesRecordedDecision).toBe(true);

    // Malformed (valid JSON, missing risk list): strict validator rejects.
    resetOutDir();
    const malformedBody = syntheticRugCheckBody(1.2 * MIB, { risks: undefined });
    const malformed = await runOptIn({
      ...opt,
      rugCheck: () => new Response(malformedBody, { status: 200 }),
    });
    expect(malformed.result.status).not.toBe("ARMED_FIRST_TICK");
    expect(rugCheckEvidence().validationStatus).toBe("VALIDATION_REJECTED");
    expect(replayCandidateDecisionFromSealedEvidence(optOutDir).recomputedRugCheck?.status).toBe(
      "VALIDATION_REJECTED",
    );

    // Stalled body: per-request timeout aborts and cancels the stream; nothing is derived.
    for (const overlap of [false, true]) {
      resetOutDir();
      let streamCancelled = false;
      const stalled = await runOptIn({
        ...opt,
        overlapRugCheckWithMintPacing: overlap,
        requestTimeoutMs: 300,
        rugCheck: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"score":150,'));
              },
              cancel() {
                streamCancelled = true;
              },
            }),
            { status: 200 },
          ),
      });
      expect(stalled.result.ok).toBe(false);
      expect(stalled.result.status).toBe("OVERALL_DIAGNOSTIC_TIMEOUT");
      const stalledRc = rugCheckRecord(stalled.result);
      expect(stalledRc.ok).toBe(false);
      expect(stalledRc.responseBodyMetadata?.bodyStatus).toBe("INCOMPLETE");
      expect(stalledRc.responseBodyMetadata?.retainedBytes).toBeNull();
      expect(streamCancelled).toBe(true);
      expect(stalled.rugCheckSignals[0]?.aborted).toBe(true);
      expect(existsSync(path.join(optOutDir, "evidence", "rugcheck-report.json"))).toBe(false);
      expectLedgerConsistent(stalled.result);
    }
  });

  it("O4. Non-RugCheck purposes keep the 1 MiB ceiling under the RugCheck opt-in", async () => {
    const pad = "y".repeat(1.5 * MIB);
    const { result } = await runOptIn({
      rugCheckMaxResponseBytes: DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES,
      overlapRugCheckWithMintPacing: true,
      pairOverride: () =>
        new Response(JSON.stringify({ schemaVersion: "1.0.0", pairs: [], pad }), { status: 200 }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("EXACT_PAIR_FETCH_FAILED");
    const pair = recordOf(result, "EXACT_PAIR")[0]!;
    expect(pair.error).toContain(
      `maximum allowed limit of ${DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES}`,
    );
    expect(pair.responseBodyMetadata).toBeUndefined();
    expect(result.ledger.rugCheckAttempts).toBe(0);
    expectLedgerConsistent(result);
  });

  it("O5. Overlap: RugCheck dispatched during CANDIDATE_MINT pacing with unchanged accounting, pacing, and replay", async () => {
    const { result, rugCheckSignals } = await runOptIn({ overlapRugCheckWithMintPacing: true });
    expect(result.status).toBe("ARMED_FIRST_TICK");
    expect(result.ledger.totalAttempts).toBe(11);
    expect(result.ledger.rugCheckAttempts).toBe(1);

    const rc = rugCheckRecord(result);
    const lpRefreshes = recordOf(result, "LP_REFRESH");
    const mint = recordOf(result, "CANDIDATE_MINT")[0]!;
    expect(rc.dispatchedAtMs).toBeGreaterThanOrEqual(lpRefreshes[1]!.completedAtMs);
    expect(rc.dispatchedAtMs).toBeLessThan(mint.dispatchedAtMs);
    expect(mint.dispatchedAtMs - lpRefreshes[1]!.dispatchedAtMs).toBeGreaterThanOrEqual(2_500);
    expect(rugCheckSignals[0]?.aborted).toBe(false);
    expect(rugCheckEvidence().retrievalMode).toBe("OVERLAPPED_WITH_CANDIDATE_MINT_PACING");
    expectLedgerConsistent(result);

    const replay = replayCandidateDecisionFromSealedEvidence(optOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.status).toBe("ARMED_FIRST_TICK");
    expect(replay.matchesRecordedDecision).toBe(true);
    expect(replay.recomputedRugCheck?.status).toBe("AVAILABLE");
  });

  it("O6. Overlap + authority rejection: started RugCheck is cancelled, settled, and recorded exactly once before sealing", async () => {
    const activeFreeze = { freezeAuthority: TEST_MINT };

    // RugCheck still in flight at the authority rejection: aborted and settled before sealing.
    const pending = await runOptIn({
      overlapRugCheckWithMintPacing: true,
      scenario: activeFreeze,
      rugCheck: ({ init }) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    expect(pending.result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(pending.result.preAdmissionScreening?.rejectionReason).toBe(
      "REJECTED_ACTIVE_FREEZE_AUTHORITY",
    );
    expect(pending.rugCheckSignals).toHaveLength(1);
    expect(pending.rugCheckSignals[0]!.aborted).toBe(true);
    const abortedRc = rugCheckRecord(pending.result);
    expect(abortedRc.ok).toBe(false);
    expect(abortedRc.error).toContain("TERMINATED_PRE_ADMISSION_REJECTED");
    expect(abortedRc.responseBodyMetadata?.bodyStatus).toBe("INCOMPLETE");
    expect(existsSync(path.join(optOutDir, "evidence", "rugcheck-report.json"))).toBe(false);
    expectLedgerConsistent(pending.result);
    const pendingReplay = replayCandidateDecisionFromSealedEvidence(optOutDir);
    expect(pendingReplay.status).toBe("PRE_ADMISSION_REJECTED");
    expect(pendingReplay.replayMode).toBe("RECORDED_TERMINATION_PRESERVED");

    // RugCheck already completed before the rejection: one spent request, recorded, never consumed.
    resetOutDir();
    const completed = await runOptIn({
      overlapRugCheckWithMintPacing: true,
      scenario: activeFreeze,
    });
    expect(completed.result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(rugCheckRecord(completed.result).ok).toBe(true);
    expect(completed.result.decisionResult).toBeUndefined();
    expect(existsSync(path.join(optOutDir, "evidence", "rugcheck-report.json"))).toBe(false);
    expectLedgerConsistent(completed.result);

    // Default serial mode spends no RugCheck request on the same rejection.
    resetOutDir();
    const serial = await runOptIn({ scenario: activeFreeze });
    expect(serial.result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(serial.result.ledger.rugCheckAttempts).toBe(0);

    // LP below 90%: overlap never starts RugCheck.
    resetOutDir();
    const lowLp = await runOptIn({
      overlapRugCheckWithMintPacing: true,
      scenario: { unqualifiedLp: true },
    });
    expect(lowLp.result.status).toBe("PRE_ADMISSION_REJECTED");
    expect(lowLp.result.ledger.rugCheckAttempts).toBe(0);
  });

  it("O7. Stale evidence still fails at the unchanged 15,000 ms ceiling with both opt-ins", async () => {
    const { result } = await runOptIn({
      rugCheckMaxResponseBytes: DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES,
      overlapRugCheckWithMintPacing: true,
      overallTimeoutMs: 180_000,
      rugCheck: ({ advanceClock }) => {
        advanceClock(15_500); // SYNTHETIC slow response consuming the freshness budget
        return new Response(syntheticRugCheckBody(1.5 * MIB), { status: 200 });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("STALE_DATA");
    expect(result.decisionResult).toBeUndefined();
    expectLedgerConsistent(result);
    const replay = replayCandidateDecisionFromSealedEvidence(optOutDir);
    expect(replay.status).toBe("STALE_DATA");
    expect(replay.replayMode).toBe("RECORDED_TERMINATION_PRESERVED");
  });

  it("O10. Overlap + RugCheck HTTP 429 during CANDIDATE_MINT pacing: run stops; no request dispatched after the 429", async () => {
    const run = await runOptIn({
      overlapRugCheckWithMintPacing: true,
      // SYNTHETIC: the mint pacing wait takes real time, so without propagation the mint would dispatch.
      realPacingDelayAfterRugCheckMs: 300,
      rugCheck: () => new Response("Too Many Requests", { status: 429 }),
    });
    const { result } = run;
    expect(result.ok).toBe(false);
    // Same status mapping as a serial RugCheck 429 (test 3); original cause preserved first.
    expect(result.status).toBe("UNHANDLED_EXCEPTION");
    expect(result.message.startsWith("[HTTP_429_RATE_LIMITED] RUGCHECK_REPORT")).toBe(true);

    expect(run.callsAfterRateLimit()).toBe(0);
    expect(run.transportCalls[run.transportCalls.length - 1]).toContain("api.rugcheck.xyz");
    expect(result.ledger.candidateMintAttempts).toBe(0);
    expect(recordOf(result, "CANDIDATE_MINT")).toHaveLength(0);
    expect(result.ledger.solanaTrackerAttempts).toBe(0);

    const rc = rugCheckRecord(result);
    expect(rc.ok).toBe(false);
    expect(rc.httpStatus).toBe(429);
    for (const r of result.ledger.records) {
      expect(r.dispatchedAtMs).toBeLessThanOrEqual(rc.completedAtMs);
    }
    expect(existsSync(path.join(optOutDir, "evidence", "rugcheck-report.json"))).toBe(false);
    expectLedgerConsistent(result);

    // Stopped before mint-account evidence existed: replay fails closed on the unchanged
    // required-evidence rule rather than inventing the missing evidence or a decision.
    const replay = replayCandidateDecisionFromSealedEvidence(optOutDir);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe("INCOMPLETE_MANIFEST_COVERAGE");
    expect(replay.message).toContain("evidence/mint-account.json");
    expect(replay.decisionResult).toBeUndefined();
  });

  it("O11. Overlap + RugCheck HTTP 429 while CANDIDATE_MINT is in flight: mint is cancelled, settled, and recorded once", async () => {
    const run = await runOptIn({
      overlapRugCheckWithMintPacing: true,
      hangCandidateMint: true,
      rugCheck: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100)); // SYNTHETIC: 429 after mint dispatch
        return new Response("Too Many Requests", { status: 429 });
      },
    });
    const { result } = run;
    expect(result.status).toBe("UNHANDLED_EXCEPTION");
    expect(result.message.startsWith("[HTTP_429_RATE_LIMITED] RUGCHECK_REPORT")).toBe(true);
    expect(result.message).toContain("superseded");

    expect(run.callsAfterRateLimit()).toBe(0);
    expect(result.ledger.candidateMintAttempts).toBe(1);
    const mint = recordOf(result, "CANDIDATE_MINT");
    expect(mint).toHaveLength(1);
    expect(mint[0]!.ok).toBe(false);
    expect(mint[0]!.error).toContain("HTTP_429_RATE_LIMITED");
    expect(run.candidateMintSignals).toHaveLength(1);
    expect(run.candidateMintSignals[0]!.aborted).toBe(true);
    expect(rugCheckRecord(result).httpStatus).toBe(429);
    expect(result.ledger.solanaTrackerAttempts).toBe(0);
    expectLedgerConsistent(result);
  });

  it("O12. Overlap + RugCheck request timeout during CANDIDATE_MINT pacing: run stops with the timeout cause; no mint dispatch", async () => {
    const run = await runOptIn({
      overlapRugCheckWithMintPacing: true,
      requestTimeoutMs: 200,
      realPacingDelayAfterRugCheckMs: 800,
      rugCheck: ({ init }) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const { result } = run;
    expect(result.ok).toBe(false);
    expect(result.status).toBe("OVERALL_DIAGNOSTIC_TIMEOUT");
    expect(result.message.startsWith("[OPERATION_TIMEOUT] RUGCHECK_REPORT")).toBe(true);
    expect(result.ledger.candidateMintAttempts).toBe(0);
    expect(run.rugCheckSignals[0]!.aborted).toBe(true);
    const rc = rugCheckRecord(result);
    expect(rc.ok).toBe(false);
    expect(rc.responseBodyMetadata?.bodyStatus).toBe("INCOMPLETE");
    expectLedgerConsistent(result);
  });

  it("O8. Invalid opt-in options fail at construction before any network activity", () => {
    const transport = vi.fn(async () => new Response("{}", { status: 200 }));
    const construct = (extra: Record<string, unknown>) =>
      new CandidateDecisionDiagnostic({
        poolId: TEST_POOL_ID,
        mintAddress: TEST_MINT,
        rpcUrl: TEST_RPC_URL,
        transport,
        wsTransport: createMockWebSocketTransport({ immediateAck: true }),
        executionContext: "PAPER_SIMULATION",
        ...extra,
      });
    for (const bad of [0, -1, 1.5, Number.NaN, 4 * MIB + 1, "1048576"]) {
      expect(() => construct({ rugCheckMaxResponseBytes: bad })).toThrow(
        "[DIAGNOSTIC_INVALID_ARG]",
      );
    }
    expect(() => construct({ overlapRugCheckWithMintPacing: "yes" })).toThrow(
      "[DIAGNOSTIC_INVALID_ARG]",
    );
    expect(() =>
      construct({ rugCheckMaxResponseBytes: 4 * MIB, overlapRugCheckWithMintPacing: true }),
    ).not.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("O9. CLI: invalid opt-ins fail before any network activity; dry-run with opt-ins stays zero-network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const base = ["--pool", TEST_POOL_ID, "--mint", TEST_MINT, "--paper"];
      const invalid = [
        [...base, "--live", "--rugcheck-max-bytes", String(4 * MIB + 1)],
        [...base, "--live", "--rugcheck-max-bytes", "abc"],
        [...base, "--rugcheck-max-bytes", "0"],
        [...base, "--rugcheck-max-bytes", "1.5"],
        [...base, "--live", "--overlap-rugcheck=yes"],
        [...base, "--live", "--rugcheck-max-byte", "2097152"],
      ];
      for (const args of invalid) {
        await expect(runCandidateDecisionDiagnosticCli(args)).rejects.toThrow("[CLI_INVALID_ARG]");
      }

      await runCandidateDecisionDiagnosticCli([
        ...base,
        "--dry-run",
        "--rugcheck-max-bytes",
        String(DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES),
        "--overlap-rugcheck",
      ]);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("4194304 decoded bytes (OPT-IN, RUGCHECK_REPORT only)");
      expect(output).toContain("OVERLAPPED with CANDIDATE_MINT pacing");
      expect(output).toContain("Overlap trade-off");
      expect(output).toContain("without dispatching network calls");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("CandidateDecisionDiagnostic PAPER active-window opt-in (synthetic, offline)", () => {
  const activeOutDir = path.resolve(
    process.cwd(),
    ".tmp",
    "test-diagnostics",
    `active-window-${Date.now()}`,
  );
  beforeEach(() => {
    if (existsSync(activeOutDir)) {
      rmSync(activeOutDir, { recursive: true, force: true });
    }
  });

  // SYNTHETIC identifiers: public Base58 signature strings reused as opaque test identifiers.
  const SIG_C =
    "3aFt8NNc96JF5yMrpTToPy22vaANB9pc41ih3jc93jGonfarwpokoEu9BnF6nWKytqgDWCyBB92fqBMsGWSyvDmu";
  const SIG_D =
    "5qYjujutG9cP6zeCAJ4yELWCmzAyxPQQUuthYgyuhBWhHFPad7PivMqZw5NFV6kJtWWN5AukcVbkLLFLFMND8BMT";
  const SIG_E =
    "MNSAJVBNSy9HuwnmMFjG3xpVnBc47Hm4UuVUdLnvmm4P8BZ1yFaDqcekkoaAYMFMXjHsaGqRareXmjhKiLYEtMy";
  const POOL_CONTEXT = {
    poolId: TEST_POOL_ID,
    candidateTokenMint: TEST_MINT,
    quoteTokenMint: "So11111111111111111111111111111111111111112",
    baseVault: CAPTURED_RAY_WSOL_IDENTITIES.baseVault,
    quoteVault: CAPTURED_RAY_WSOL_IDENTITIES.quoteVault,
    baseMint: TEST_MINT,
    quoteMint: "So11111111111111111111111111111111111111112",
    orientation: "TOKEN_BASE_SOL_QUOTE" as const,
  };

  interface ScheduledSwap {
    readonly signature: string;
    readonly offsetMs: number; // emitted at run start + offset (synthetic clock)
    readonly slot: number;
    readonly side: "BUY" | "SELL";
    /** SYNTHETIC: transaction failed on-chain (meta.err set). */
    readonly failed?: boolean;
    /** SYNTHETIC: getTransaction never answers until aborted (interrupted retrieval). */
    readonly hang?: boolean;
    /** SYNTHETIC transaction-metadata variants for error-status classification. */
    readonly meta?: "STRIP_ERR" | "META_NULL" | "MALFORMED_ERR";
    /** SYNTHETIC: complete, explicitly failed transaction (recognized error; history reports the same err). */
    readonly validFailure?: boolean;
  }

  /** Runs the diagnostic with SYNTHETIC stream notifications and decodable SYNTHETIC swap transactions. */
  async function runActive(params: {
    swaps: readonly ScheduledSwap[];
    paperActiveWindowFlow?: boolean;
    requestTimeoutMs?: number;
    /** SYNTHETIC: JSON-RPC methods whose responses never arrive until aborted. */
    hangMethods?: readonly string[];
    /** SYNTHETIC: synthetic clock time consumed while a hung method waits (models request settlement). */
    hangAdvanceMs?: number;
  }) {
    const now = 1791931000 * 1000;
    const startMs = now - 70_000;
    let clockTime = startMs;
    const clock = () => clockTime;
    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const emitted = new Map<
      string,
      {
        slot: number;
        blockTime: number;
        side: "BUY" | "SELL";
        failed?: boolean;
        hang?: boolean;
        meta?: ScheduledSwap["meta"];
        validFailure?: boolean;
      }
    >();
    const emitDue = () => {
      for (const swap of params.swaps) {
        if (!emitted.has(swap.signature) && clockTime >= startMs + swap.offsetMs) {
          emitted.set(swap.signature, {
            slot: swap.slot,
            blockTime: Math.floor(clockTime / 1000),
            side: swap.side,
            failed: swap.failed === true,
            hang: swap.hang === true,
            meta: swap.meta,
            validFailure: swap.validFailure === true,
          });
          wsTransport.emitMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "logsNotification",
              params: {
                subscription: 101,
                result: {
                  context: { slot: swap.slot },
                  value: {
                    signature: swap.signature,
                    err: null,
                    logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
                  },
                },
              },
            }),
          );
        }
      }
    };
    const sleeper = async (ms: number) => {
      clockTime += ms;
      emitDue();
      await new Promise((resolve) => setImmediate(resolve));
    };
    const baseFetch = createDiagnosticMockFetch({ getClock: clock });
    const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { method?: string; params?: unknown[]; id?: unknown })
          : null;
      if (body?.method && params.hangMethods?.includes(body.method)) {
        clockTime += params.hangAdvanceMs ?? 0;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      if (body?.method === "getTransaction") {
        const sig = String(body.params?.[0]);
        const tx = emitted.get(sig);
        if (tx?.hang) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        }
        if (tx?.validFailure) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: buildSyntheticFailedTransactionResult({
                poolContext: POOL_CONTEXT,
                signature: sig,
                slot: tx.slot,
                blockTime: tx.blockTime,
              }),
            }),
            { status: 200 },
          );
        }
        if (tx) {
          const txResult = buildSyntheticSwapTransactionResult({
            poolContext: POOL_CONTEXT,
            signature: sig,
            slot: tx.slot,
            blockTime: tx.blockTime,
            side: tx.side,
          });
          if (tx.failed) {
            (txResult.meta as Record<string, unknown>).err = {
              InstructionError: [1, { Custom: 30 }],
            };
          }
          if (tx.meta === "STRIP_ERR") delete (txResult.meta as Record<string, unknown>).err;
          if (tx.meta === "MALFORMED_ERR") (txResult.meta as Record<string, unknown>).err = 5;
          if (tx.meta === "META_NULL") (txResult as Record<string, unknown>).meta = null;
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: txResult,
            }),
            { status: 200 },
          );
        }
      }
      if (
        body?.method === "getSignaturesForAddress" &&
        (body.params?.[1] as { limit?: number } | undefined)?.limit !== 1
      ) {
        // SYNTHETIC history page: emitted signatures (newest first) followed by the prior anchor.
        const newest = [...emitted.entries()].sort((a, b) => b[1].slot - a[1].slot);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: [
              ...newest.map(([signature, t]) => ({
                signature,
                slot: t.slot,
                err: t.validFailure ? SYNTHETIC_FAILED_TRANSACTION_ERROR : null,
                blockTime: t.blockTime,
              })),
              {
                signature: TEST_SIG_A,
                slot: 461970800,
                err: null,
                blockTime: Math.floor((clockTime - 75_000) / 1000),
              },
            ],
          }),
          { status: 200 },
        );
      }
      return baseFetch(input, init);
    };
    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: activeOutDir,
      transport,
      wsTransport,
      clock,
      sleeper,
      executionContext: "PAPER_SIMULATION",
      observationDurationMs: 65_000,
      ...(params.paperActiveWindowFlow !== undefined
        ? { paperActiveWindowFlow: params.paperActiveWindowFlow }
        : {}),
      ...(params.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: params.requestTimeoutMs }
        : {}),
    });
    return diagnostic.run();
  }

  const TWO_BUYS: readonly ScheduledSwap[] = [
    { signature: TEST_SIG_B, offsetMs: 25_000, slot: 461970850, side: "BUY" },
    { signature: SIG_C, offsetMs: 45_000, slot: 461970860, side: "BUY" },
  ];

  it("W1. Opt-in active window: stream-resolved swaps qualify, arm the candidate, seal linked evidence, and replay by re-decoding", async () => {
    const result = await runActive({ swaps: TWO_BUYS, paperActiveWindowFlow: true });
    expect(result.flowEvaluation?.diagnosticReason).toContain("PAPER_ACTIVE_WINDOW_QUALIFIED");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ARMED_FIRST_TICK");
    expect(result.flowEvaluation?.isPaperQualified).toBe(true);
    expect(result.flowEvaluation?.recentBuys60s).toBe(2);
    expect(result.flowEvaluation?.recentSells60s).toBe(0);
    const ctx = (
      result.flowEvaluation as { paperQualificationContext?: { qualificationKind?: string } }
    ).paperQualificationContext;
    expect(ctx?.qualificationKind).toBe("ACTIVE_WINDOW");
    // Unchanged ceilings: 2 of 3 shared retrievals, 13 of 14 HTTP attempts.
    expect(result.ledger.transactionDecodeAttempts).toBe(2);
    expect(result.ledger.totalAttempts).toBe(13);
    expect(result.ledger.records).toHaveLength(13);

    const evidence = readJson<{
      resolutions: Array<{ signature: string; status: string; responseFile: string | null }>;
    }>(path.join(activeOutDir, "evidence", "active-window-evidence.json"));
    const manifest = readJson<{ files: Array<{ path: string }> }>(
      path.join(activeOutDir, "evidence-manifest.json"),
    );
    const listed = new Set(manifest.files.map((f) => f.path));
    expect(evidence.resolutions.map((r) => r.status)).toEqual(["RESOLVED", "RESOLVED"]);
    for (const r of evidence.resolutions) {
      expect(r.responseFile).not.toBeNull();
      expect(listed.has(r.responseFile!)).toBe(true);
    }

    const replay = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.status).toBe("ARMED_FIRST_TICK");
    expect(replay.matchesRecordedDecision).toBe(true);
    expect(replay.recomputedActiveWindowFlow?.redecodedTransactions).toBe(2);
    expect(replay.recomputedActiveWindowFlow?.recentBuys60s).toBe(2);
    expect(replay.recomputedActiveWindowFlow?.recentSells60s).toBe(0);
    expect(replay.recomputedActiveWindowFlow?.reconciliationStatus).toBe("RECONCILED");

    // SYNTHETIC tamper + reseal: a sealed transaction now decodes as a SELL; replay re-decodes and fails closed.
    const tamperedFile = evidence.resolutions[1]!.responseFile!;
    const sealed = readJson<{ result: { slot: number; blockTime: number } }>(
      path.join(activeOutDir, tamperedFile),
    );
    writeFileSync(
      path.join(activeOutDir, tamperedFile),
      JSON.stringify({
        ...sealed,
        result: buildSyntheticSwapTransactionResult({
          poolContext: POOL_CONTEXT,
          signature: evidence.resolutions[1]!.signature,
          slot: sealed.result.slot,
          blockTime: sealed.result.blockTime,
          side: "SELL",
        }),
      }),
      "utf8",
    );
    resealSyntheticCapture(activeOutDir);
    const mismatch = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.status).toBe("REPLAY_ACTIVE_WINDOW_MISMATCH");
    expect(mismatch.recomputedActiveWindowFlow?.recentSells60s).toBe(1);
    expect(mismatch.decisionResult).toBeUndefined();

    // Derived active-window evidence removed (resealed): replay cannot recompute and fails closed.
    unlinkSync(path.join(activeOutDir, "evidence", "active-window-evidence.json"));
    resealSyntheticCapture(activeOutDir);
    const missing = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(missing.status).toBe("REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID");
    expect(missing.decisionResult).toBeUndefined();
  });

  it("W5. Relabelled, de-marked, downgraded, or conflicting flow claims on an active capture fail closed before decision replay", async () => {
    const result = await runActive({ swaps: TWO_BUYS, paperActiveWindowFlow: true });
    expect(result.status).toBe("ARMED_FIRST_TICK");
    const flowPath = path.join(activeOutDir, "evidence", "flow-evaluation.json");
    const reportPath = path.join(activeOutDir, "diagnostic-report.json");
    const activePath = path.join(activeOutDir, "evidence", "active-window-evidence.json");
    const manifestPath = path.join(activeOutDir, "evidence-manifest.json");
    const originals = new Map(
      [flowPath, reportPath, activePath, manifestPath].map((p) => [p, readFileSync(p, "utf8")]),
    );
    const restore = () => {
      for (const [p, content] of originals) writeFileSync(p, content, "utf8");
    };
    type FlowRecord = Record<string, unknown> & {
      paperQualificationContext?: Record<string, unknown>;
    };
    /** SYNTHETIC edit of the selected sealed flow records, then reseal. */
    const editFlows = (
      edit: (rec: FlowRecord) => FlowRecord,
      targets: { file?: boolean; reportFlow?: boolean; decisionFlow?: boolean },
    ) => {
      if (targets.file) {
        writeFileSync(flowPath, JSON.stringify(edit(readJson<FlowRecord>(flowPath))), "utf8");
      }
      const report = readJson<{
        flowEvaluation: FlowRecord;
        decisionResult: { flowResult: FlowRecord };
      }>(reportPath);
      if (targets.reportFlow) report.flowEvaluation = edit(report.flowEvaluation);
      if (targets.decisionFlow)
        report.decisionResult.flowResult = edit(report.decisionResult.flowResult);
      writeFileSync(reportPath, JSON.stringify(report), "utf8");
      resealSyntheticCapture(activeOutDir);
      return replayCandidateDecisionFromSealedEvidence(activeOutDir);
    };
    const toQuiet = (rec: FlowRecord): FlowRecord => ({
      ...rec,
      recentBuys60s: 0,
      recentSells60s: 0,
      paperQualificationContext: {
        ...rec.paperQualificationContext,
        qualificationKind: "QUIET_WINDOW",
      },
    });
    const removeMarker = (rec: FlowRecord): FlowRecord => {
      const ctx = { ...rec.paperQualificationContext };
      delete ctx.qualificationKind;
      return { ...rec, paperQualificationContext: ctx };
    };
    const toUnqualified = (rec: FlowRecord): FlowRecord => {
      const copy: FlowRecord = {
        ...rec,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
      };
      delete copy.isPaperQualified;
      delete copy.paperQualificationContext;
      return copy;
    };
    const all = { file: true, reportFlow: true, decisionFlow: true };

    // 1. Reviewer reproduction: only flow-evaluation.json relabelled QUIET with zero counts.
    const relabelled = editFlows(toQuiet, { file: true });
    expect(relabelled.ok).toBe(false);
    expect(relabelled.status).toBe("REPLAY_FLOW_RECORDS_INCONSISTENT");
    expect(relabelled.decisionResult).toBeUndefined();

    // 2. All sealed flow records consistently relabelled QUIET 0/0: contradicted by raw evidence.
    restore();
    const consistentQuiet = editFlows(toQuiet, all);
    expect(consistentQuiet.status).toBe("REPLAY_FLOW_QUALIFICATION_CONTRADICTED");
    expect(consistentQuiet.flowQualificationCheck?.rawActivity.inWindowSignatures).toBe(2);
    expect(consistentQuiet.flowQualificationCheck?.rawActivity.transactionDecodeRecords).toBe(2);
    expect(consistentQuiet.decisionResult).toBeUndefined();

    // 3. Active qualification marker removed everywhere (legacy-quiet form with 2/0 counts).
    restore();
    const unmarked = editFlows(removeMarker, all);
    expect(unmarked.status).toBe("REPLAY_FLOW_QUALIFICATION_CONTRADICTED");
    expect(unmarked.decisionResult).toBeUndefined();

    // 4. Downgraded to an unqualified COLLECTION_GAP everywhere: raw evidence re-decodes to a qualifying window.
    restore();
    const downgraded = editFlows(toUnqualified, all);
    expect(downgraded.status).toBe("REPLAY_FLOW_QUALIFICATION_CONTRADICTED");
    expect(downgraded.recomputedActiveWindowFlow?.recentBuys60s).toBe(2);
    expect(downgraded.decisionResult).toBeUndefined();

    // 5. Conflicting counts across sealed flow records.
    restore();
    const conflicting = editFlows((rec) => ({ ...rec, recentBuys60s: 3 }), { decisionFlow: true });
    expect(conflicting.status).toBe("REPLAY_FLOW_RECORDS_INCONSISTENT");

    // 6. Optional active evidence removed AND records relabelled quiet: still contradicted (no file reliance).
    restore();
    unlinkSync(activePath);
    const noEvidenceQuiet = editFlows(toQuiet, all);
    expect(noEvidenceQuiet.status).toBe("REPLAY_FLOW_QUALIFICATION_CONTRADICTED");

    // Restored capture still replays by re-decoding.
    restore();
    resealSyntheticCapture(activeOutDir);
    const valid = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(valid.ok).toBe(true);
    expect(valid.matchesRecordedDecision).toBe(true);
    expect(valid.flowQualificationCheck?.claimed?.qualificationKind).toBe("ACTIVE_WINDOW");
    expect(valid.recomputedActiveWindowFlow?.redecodedTransactions).toBe(2);
  });

  it("W6. A genuine quiet capture made with the active option enabled replays on the quiet path", async () => {
    const result = await runActive({ swaps: [], paperActiveWindowFlow: true });
    expect(result.status).toBe("ARMED_FIRST_TICK");
    const ctx = (
      result.flowEvaluation as { paperQualificationContext?: { qualificationKind?: string } }
    ).paperQualificationContext;
    expect(ctx?.qualificationKind).toBe("QUIET_WINDOW");
    // The optional evidence file exists but does not make the capture "active".
    expect(existsSync(path.join(activeOutDir, "evidence", "active-window-evidence.json"))).toBe(
      true,
    );
    const replay = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.matchesRecordedDecision).toBe(true);
    expect(replay.flowQualificationCheck?.claimed?.qualificationKind).toBe("QUIET_WINDOW");
    expect(replay.flowQualificationCheck?.rawActivity).toEqual({
      inWindowSignatures: 0,
      discoveredSinceAnchor: 0,
      notificationsReceived: 0,
      transactionDecodeRecords: 0,
    });
    expect(replay.recomputedActiveWindowFlow).toBeUndefined();
  });

  /** SYNTHETIC distinct 64-byte Base58 signatures. */
  const syntheticSig = (k: number) =>
    encodeBase58(Uint8Array.from({ length: 64 }, (_, i) => (i * 31 + k * 17 + 1) % 256));
  const overflowBurst = (offsetMs: number): ScheduledSwap[] =>
    Array.from({ length: 10 }, (_, i) => ({
      signature: syntheticSig(100 + i),
      offsetMs,
      slot: 461970870 + i,
      side: "BUY" as const,
    }));
  interface StreamTelemetry {
    stopReason: string | null;
    observation: { startMs: number | null; endMs: number | null; endBasis: string | null };
    stateBeforeCleanup: {
      reason: string;
      coordinatorStatus: string | null;
      pendingQueueLength: number;
      activeWorkload: number;
      connectionEpoch: number | null;
      recordedGaps: Array<{ reason?: string }>;
      coordinatorMetrics: { totalNotificationsReceived: number } | null;
    };
    keepalive: { clientPingsSentCount: number; matchedClientPongsCount: number };
    transactionDecodeAttempts: number;
    transactionRetrievals: Array<{
      signature: string | null;
      responseFile: string | null;
      rpcRequestId: unknown;
      rpcResponseId: unknown;
      requestOk: boolean;
      adapterOutcome: string | null;
      decodedEventsCount: number | null;
      ingestedEventsCount: number | null;
      onChainErrorStatus: string;
      classification: string;
    }>;
    stagesNotReached: string[];
  }
  const sealedHashes = (dir: string) => {
    const manifest = readJson<{ files: Array<{ path: string }> }>(
      path.join(dir, "evidence-manifest.json"),
    );
    return [...manifest.files.map((f) => f.path), "evidence-manifest.json"].map((p) => [
      p,
      createHash("sha256")
        .update(readFileSync(path.join(dir, p)))
        .digest("hex"),
    ]);
  };

  it("T1. Early queue termination preserves observation, keepalive, workload, epoch, gaps and per-signature outcomes", async () => {
    const decoded: ScheduledSwap[] = [
      { signature: TEST_SIG_B, offsetMs: 20_000, slot: 461970850, side: "BUY" },
      { signature: SIG_C, offsetMs: 20_000, slot: 461970851, side: "BUY" },
      { signature: SIG_D, offsetMs: 20_000, slot: 461970852, side: "SELL", failed: true },
    ];
    const result = await runActive({
      paperActiveWindowFlow: true,
      swaps: [...decoded, ...overflowBurst(40_000)],
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("STREAM_QUEUE_LIMIT_EXCEEDED");

    // Report: actual observation and keepalive state; cutoff never synthesized.
    const obs = result.observationMetadata!;
    expect(obs.observationStartMs).toBeGreaterThan(0);
    expect(obs.observationEndMs).toBeGreaterThanOrEqual(obs.observationStartMs);
    expect(obs.cutoffTimestampMs).toBeNull();
    expect(obs.notificationsReceived).toBe(13);
    expect(result.keepaliveMetrics).toBeDefined();

    // Sealed telemetry, captured before coordinator cleanup.
    const telemetry = readJson<StreamTelemetry>(
      path.join(activeOutDir, "evidence", "stream-telemetry.json"),
    );
    const manifest = readJson<{ files: Array<{ path: string }> }>(
      path.join(activeOutDir, "evidence-manifest.json"),
    );
    const listed = new Set(manifest.files.map((f) => f.path));
    expect(listed.has("evidence/stream-telemetry.json")).toBe(true);
    expect(telemetry.stopReason).toBe("STREAM_QUEUE_LIMIT_EXCEEDED");
    expect(telemetry.observation.endBasis).toBe("EARLY_STOP");
    expect(telemetry.stateBeforeCleanup.reason).toBe("STREAM_LIMIT:STREAM_QUEUE_LIMIT_EXCEEDED");
    expect(telemetry.stateBeforeCleanup.coordinatorStatus).toBe("SUBSCRIBED");
    expect(telemetry.stateBeforeCleanup.pendingQueueLength).toBeGreaterThanOrEqual(10);
    expect(telemetry.stateBeforeCleanup.connectionEpoch).toEqual(expect.any(Number));
    expect(
      telemetry.stateBeforeCleanup.recordedGaps.some((g) => g.reason === "COORDINATOR_CLOSED"),
    ).toBe(false);
    expect(telemetry.stateBeforeCleanup.coordinatorMetrics?.totalNotificationsReceived).toBe(13);
    expect(telemetry.transactionDecodeAttempts).toBe(3);

    // Success vs on-chain failure, each linked to its sealed response and RPC ids.
    const retrievals = telemetry.transactionRetrievals;
    expect(retrievals.map((r) => r.classification)).toEqual([
      "CANDIDATE_BOUND_SWAPS",
      "CANDIDATE_BOUND_SWAPS",
      "ONCHAIN_FAILED",
    ]);
    expect(retrievals.map((r) => r.onChainErrorStatus)).toEqual(["NONE", "NONE", "PRESENT"]);
    expect(retrievals.map((r) => r.decodedEventsCount)).toEqual([1, 1, 0]);
    expect(retrievals.map((r) => r.adapterOutcome)).toEqual([
      "SUCCESS",
      "SUCCESS",
      "DECODE_FAILED",
    ]);
    for (const r of retrievals) {
      expect(listed.has(r.responseFile!)).toBe(true);
      expect(r.rpcRequestId).toBe(1);
      expect(r.rpcResponseId).toBe(1);
    }

    // Stages not reached stay unavailable; nothing synthesized.
    expect(telemetry.stagesNotReached).toEqual(
      expect.arrayContaining(["SOURCE_CUTOFF", "HISTORY_ENUMERATION", "LP_SCREENING"]),
    );
    for (const missing of ["cutoff-evidence.json", "history-evidence.json", "lp-evidence.json"]) {
      expect(existsSync(path.join(activeOutDir, "evidence", missing))).toBe(false);
    }

    // Exactly-once accounting with actual outgoing ids for every Solana RPC request.
    expect(result.ledger.records).toHaveLength(result.ledger.totalAttempts);
    expect(result.ledger.totalAttempts).toBe(5);
    for (const rec of result.ledger.records.filter((r) => r.provider === "SOLANA_RPC")) {
      // Actual outgoing id is recorded; the response id is recorded as observed (the captured
      // bootstrap fixture always answers id 1, which is reported as-is rather than assumed).
      if (rec.purpose === "TRANSACTION_DECODING") {
        expect(rec.rpcRequestId).toBe(1);
      } else {
        expect(rec.rpcRequestId).toMatch(/^diag-\d+$/);
      }
      expect(rec).toHaveProperty("rpcResponseId");
    }

    // Replay fails closed and leaves sealed evidence byte-identical.
    const before = sealedHashes(activeOutDir);
    const replay = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe("INCOMPLETE_MANIFEST_COVERAGE");
    expect(sealedHashes(activeOutDir)).toEqual(before);
  });

  it("T2. An interrupted (timed-out) retrieval is recorded once and reported as unavailable, never as decoded", async () => {
    const result = await runActive({
      paperActiveWindowFlow: true,
      requestTimeoutMs: 300,
      swaps: [
        { signature: TEST_SIG_B, offsetMs: 20_000, slot: 461970850, side: "BUY", hang: true },
        ...overflowBurst(40_000),
      ],
    });
    expect(result.ok).toBe(false);
    const telemetry = readJson<StreamTelemetry>(
      path.join(activeOutDir, "evidence", "stream-telemetry.json"),
    );
    const decodeRecords = result.ledger.records.filter((r) => r.purpose === "TRANSACTION_DECODING");
    expect(decodeRecords).toHaveLength(1);
    expect(decodeRecords[0]!.ok).toBe(false);
    expect(result.ledger.records).toHaveLength(result.ledger.totalAttempts);
    const interrupted = telemetry.transactionRetrievals.find((r) => r.signature === TEST_SIG_B)!;
    expect(interrupted.requestOk).toBe(false);
    expect(result.status).toBe("STREAM_QUEUE_LIMIT_EXCEEDED");
    expect(interrupted.onChainErrorStatus).toBe("UNKNOWN");
    expect(interrupted.adapterOutcome).toBe("REQUEST_TIMEOUT");
    expect(interrupted.classification).toBe("RETRIEVAL_OR_DECODE_FAILED");
    expect(interrupted.decodedEventsCount ?? 0).toBe(0);
    expect(interrupted.ingestedEventsCount ?? 0).toBe(0);
  });

  it("X1. getSlot stalls until its timeout after observation: observation timing and pre-cleanup state are preserved on the exception path", async () => {
    const result = await runActive({
      paperActiveWindowFlow: true,
      requestTimeoutMs: 300,
      hangMethods: ["getSlot"],
      hangAdvanceMs: 10_000,
      swaps: [{ signature: TEST_SIG_B, offsetMs: 20_000, slot: 461970850, side: "BUY" }],
    });
    // Original timeout cause preserved.
    expect(result.ok).toBe(false);
    expect(result.status).toBe("OVERALL_DIAGNOSTIC_TIMEOUT");
    expect(result.message).toContain("GET_SLOT");

    const telemetry = readJson<
      StreamTelemetry & {
        observation: {
          loopEndedAtMs: number | null;
          streamStoppedAtMs: number | null;
          terminationCapturedAtMs: number | null;
          sealedAtMs: number;
        };
      }
    >(path.join(activeOutDir, "evidence", "stream-telemetry.json"));
    const o = telemetry.observation;
    expect(o.endBasis).toBe("OBSERVATION_LOOP_END");
    expect(o.startMs).toEqual(expect.any(Number));
    expect(o.endMs).toBe(o.loopEndedAtMs);
    expect(o.endMs! - o.startMs!).toBeGreaterThanOrEqual(65_000);
    // Observation end is distinct from the later request settlement / exception capture and sealing.
    expect(o.streamStoppedAtMs).toBeNull();
    expect(o.terminationCapturedAtMs!).toBeGreaterThan(o.endMs!);
    expect(o.sealedAtMs).toBeGreaterThanOrEqual(o.terminationCapturedAtMs!);
    expect(telemetry.stateBeforeCleanup.reason).toMatch(/^EXCEPTION:/);
    expect(telemetry.stateBeforeCleanup.coordinatorStatus).toBe("SUBSCRIBED");
    expect(telemetry.transactionRetrievals.map((r) => r.classification)).toEqual([
      "CANDIDATE_BOUND_SWAPS",
    ]);
    expect(telemetry.stagesNotReached).toEqual(
      expect.arrayContaining(["SOURCE_CUTOFF", "HISTORY_ENUMERATION", "LP_SCREENING"]),
    );

    // Report carries the same observation timing; the cutoff never started, so it stays null.
    const obs = result.observationMetadata!;
    expect(obs.observationStartMs).toBe(o.startMs);
    expect(obs.observationEndMs).toBe(o.endMs);
    expect(obs.cutoffTimestampMs).toBeNull();
    expect(obs.notificationsReceived).toBe(1);
    expect(result.keepaliveMetrics).toBeDefined();

    // Exactly-once accounting: the stalled getSlot is recorded once; nothing after it was dispatched.
    expect(result.ledger.records).toHaveLength(result.ledger.totalAttempts);
    const slotRecords = result.ledger.records.filter((r) => r.purpose === "GET_SLOT");
    expect(slotRecords).toHaveLength(1);
    expect(slotRecords[0]!.ok).toBe(false);
    expect(result.ledger.records.some((r) => r.purpose === "GET_BLOCK_TIME")).toBe(false);
    expect(existsSync(path.join(activeOutDir, "evidence", "cutoff-evidence.json"))).toBe(false);
  });

  it("X2. Transaction error status: explicit err null is NONE; missing, null or malformed metadata stays UNKNOWN", async () => {
    const first = await runActive({
      paperActiveWindowFlow: true,
      swaps: [
        { signature: TEST_SIG_B, offsetMs: 20_000, slot: 461970850, side: "BUY" },
        { signature: SIG_C, offsetMs: 20_000, slot: 461970851, side: "BUY", meta: "STRIP_ERR" },
        { signature: SIG_D, offsetMs: 20_000, slot: 461970852, side: "BUY", meta: "MALFORMED_ERR" },
        ...overflowBurst(40_000),
      ],
    });
    expect(first.status).toBe("STREAM_QUEUE_LIMIT_EXCEEDED");
    const t1 = readJson<StreamTelemetry>(
      path.join(activeOutDir, "evidence", "stream-telemetry.json"),
    );
    const bySig = new Map(t1.transactionRetrievals.map((r) => [r.signature, r]));
    expect(bySig.get(TEST_SIG_B)!.onChainErrorStatus).toBe("NONE");
    expect(bySig.get(TEST_SIG_B)!.classification).toBe("CANDIDATE_BOUND_SWAPS");
    for (const sig of [SIG_C, SIG_D]) {
      const r = bySig.get(sig)!;
      expect(r.onChainErrorStatus).toBe("UNKNOWN");
      // Decoder rejection preserved; never classified as a verified on-chain failure or a swap.
      expect(r.adapterOutcome).not.toBe("SUCCESS");
      expect(r.decodedEventsCount ?? 0).toBe(0);
      expect(r.classification).toBe("RETRIEVAL_OR_DECODE_FAILED");
    }

    rmSync(activeOutDir, { recursive: true, force: true });
    const second = await runActive({
      paperActiveWindowFlow: true,
      swaps: [
        {
          signature: TEST_SIG_B,
          offsetMs: 20_000,
          slot: 461970850,
          side: "BUY",
          meta: "META_NULL",
        },
        { signature: SIG_C, offsetMs: 20_000, slot: 461970851, side: "SELL", failed: true },
        ...overflowBurst(40_000),
      ],
    });
    expect(second.status).toBe("STREAM_QUEUE_LIMIT_EXCEEDED");
    const t2 = readJson<StreamTelemetry>(
      path.join(activeOutDir, "evidence", "stream-telemetry.json"),
    );
    const bySig2 = new Map(t2.transactionRetrievals.map((r) => [r.signature, r]));
    expect(bySig2.get(TEST_SIG_B)!.onChainErrorStatus).toBe("UNKNOWN");
    expect(bySig2.get(TEST_SIG_B)!.classification).toBe("RETRIEVAL_OR_DECODE_FAILED");
    expect(bySig2.get(SIG_C)!.onChainErrorStatus).toBe("PRESENT");
    expect(bySig2.get(SIG_C)!.classification).toBe("ONCHAIN_FAILED");
    // Unavailable-flow behaviour unchanged: no qualified flow from these windows.
    expect(second.flowEvaluation?.isCoverageSufficient ?? false).toBe(false);
  });

  it("W2. Budget exhaustion (4 notifications, 3 shared retrievals) leaves a backlog and stays unavailable", async () => {
    const result = await runActive({
      paperActiveWindowFlow: true,
      swaps: [
        { signature: TEST_SIG_B, offsetMs: 20_000, slot: 461970850, side: "BUY" },
        { signature: SIG_C, offsetMs: 30_000, slot: 461970855, side: "BUY" },
        { signature: SIG_D, offsetMs: 40_000, slot: 461970860, side: "BUY" },
        { signature: SIG_E, offsetMs: 50_000, slot: 461970865, side: "SELL" },
      ],
    });
    expect(result.ledger.transactionDecodeAttempts).toBe(3);
    expect(result.ledger.totalAttempts).toBeLessThanOrEqual(14);
    expect(result.flowEvaluation?.flowCoverage).toBe("COLLECTION_GAP");
    expect(result.flowEvaluation?.recentBuys60s).toBeNull();
    expect(result.flowEvaluation?.diagnosticReason).toContain("ACTIVE_WINDOW_UNQUALIFIED");
    expect(result.decisionResult?.outcome).not.toBe("ARMED_FIRST_TICK");

    // A legitimately unqualified active capture is not misreported as a downgrade on replay.
    const replay = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.matchesRecordedDecision).toBe(true);
    expect(replay.flowQualificationCheck?.claimed?.qualificationKind).toBe("UNQUALIFIED");
    expect(replay.recomputedActiveWindowFlow?.flow.isCoverageSufficient).toBe(false);
  });

  it("W3. Without the opt-in, the same active stream keeps the existing non-quiet COLLECTION_GAP behavior", async () => {
    const result = await runActive({ swaps: TWO_BUYS });
    expect(result.flowEvaluation?.flowCoverage).toBe("COLLECTION_GAP");
    expect(result.flowEvaluation?.recentBuys60s).toBeNull();
    expect(result.flowEvaluation?.diagnosticReason).toBe(
      "NON_QUIET_STREAM_UNVERIFIED_COMPLETENESS",
    );
    expect(existsSync(path.join(activeOutDir, "evidence", "active-window-evidence.json"))).toBe(
      false,
    );
  });

  it("W4. The opt-in is rejected outside PAPER before any network activity (constructor and CLI)", async () => {
    const transport = vi.fn(async () => new Response("{}", { status: 200 }));
    const construct = (extra: Record<string, unknown>) =>
      new CandidateDecisionDiagnostic({
        poolId: TEST_POOL_ID,
        mintAddress: TEST_MINT,
        rpcUrl: TEST_RPC_URL,
        transport,
        wsTransport: createMockWebSocketTransport({ immediateAck: true }),
        ...extra,
      });
    expect(() => construct({ paperActiveWindowFlow: true })).toThrow("[DIAGNOSTIC_INVALID_ARG]");
    expect(() =>
      construct({ paperActiveWindowFlow: true, executionContext: "PRODUCTION" }),
    ).toThrow("[DIAGNOSTIC_INVALID_ARG]");
    expect(() =>
      construct({ paperActiveWindowFlow: "yes", executionContext: "PAPER_SIMULATION" }),
    ).toThrow("[DIAGNOSTIC_INVALID_ARG]");
    expect(transport).not.toHaveBeenCalled();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        runCandidateDecisionDiagnosticCli([
          "--pool",
          TEST_POOL_ID,
          "--mint",
          TEST_MINT,
          "--live",
          "--paper-active-window",
        ]),
      ).rejects.toThrow("[CLI_INVALID_ARG]");
      await runCandidateDecisionDiagnosticCli([
        "--pool",
        TEST_POOL_ID,
        "--mint",
        TEST_MINT,
        "--paper",
        "--dry-run",
        "--paper-active-window",
      ]);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("ACTIVE-WINDOW PAPER qualification (OPT-IN");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  interface SealedActiveEvidence {
    failedTransactionPolicy?: string;
    recordedGaps: unknown[];
    resolutions: Array<{
      signature: string;
      status: string;
      classification: string;
      responseFile: string | null;
      knownFailedTransaction?: { onChainErrorCanonical: string; decoderReason: string };
    }>;
  }
  const activeEvidencePath = () =>
    path.join(activeOutDir, "evidence", "active-window-evidence.json");

  it("F6. Mixed window: a validated failed transaction counts zero swaps, consumes a retrieval, seals its policy, and replays", async () => {
    const result = await runActive({
      paperActiveWindowFlow: true,
      swaps: [
        { signature: TEST_SIG_B, offsetMs: 25_000, slot: 461970850, side: "BUY" },
        { signature: SIG_C, offsetMs: 45_000, slot: 461970860, side: "BUY", validFailure: true },
      ],
    });
    expect(result.flowEvaluation?.diagnosticReason).toContain("PAPER_ACTIVE_WINDOW_QUALIFIED");
    expect(result.flowEvaluation?.isPaperQualified).toBe(true);
    expect(result.flowEvaluation?.recentBuys60s).toBe(1);
    expect(result.flowEvaluation?.recentSells60s).toBe(0);
    // Unchanged ceilings: the failed transaction still used one HTTP attempt and one of 3 retrievals.
    expect(result.ledger.transactionDecodeAttempts).toBe(2);
    expect(result.ledger.totalAttempts).toBe(13);

    const evidence = readJson<SealedActiveEvidence>(activeEvidencePath());
    expect(evidence.failedTransactionPolicy).toBe(PAPER_FAILED_TRANSACTION_POLICY);
    // No decode-loss gap for the validated failure (the existing post-evaluation close gap is unaffected).
    const gapReasons = (evidence.recordedGaps as Array<{ reason?: string }>).map((g) => g.reason);
    expect(gapReasons.some((r) => String(r).includes("DECODE_FAILED"))).toBe(false);
    const bySig = new Map(evidence.resolutions.map((r) => [r.signature, r]));
    expect(bySig.get(TEST_SIG_B)?.status).toBe("RESOLVED");
    expect(bySig.get(TEST_SIG_B)?.classification).toBe("EXECUTED_DECODED");
    const failed = bySig.get(SIG_C)!;
    expect(failed.status).toBe("RESOLVED_FAILED_TRANSACTION");
    expect(failed.classification).toBe("KNOWN_FAILED_TRANSACTION_ZERO_COMMITTED_SWAPS");
    expect(failed.knownFailedTransaction?.decoderReason).toBe("TRANSACTION_FAILED");
    expect(failed.responseFile).not.toBeNull();
    const rawFailed = readJson<{ result: { meta: { err: unknown } } }>(
      path.join(activeOutDir, failed.responseFile!),
    );
    expect(rawFailed.result.meta.err).toEqual(SYNTHETIC_FAILED_TRANSACTION_ERROR);

    const replay = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.status).toBe(result.status);
    expect(replay.matchesRecordedDecision).toBe(true);
    expect(replay.recomputedActiveWindowFlow?.failedTransactionPolicy).toBe(
      PAPER_FAILED_TRANSACTION_POLICY,
    );
    expect(replay.recomputedActiveWindowFlow?.knownFailedTransactions).toBe(1);
    expect(replay.recomputedActiveWindowFlow?.redecodedTransactions).toBe(2);
    expect(replay.recomputedActiveWindowFlow?.recentBuys60s).toBe(1);
    expect(replay.recomputedActiveWindowFlow?.recentSells60s).toBe(0);
  });

  it("F7. Failed-only window replays as 0/0 active flow; altered raw responses or sealed labels fail closed", async () => {
    const result = await runActive({
      paperActiveWindowFlow: true,
      swaps: [
        { signature: SIG_C, offsetMs: 45_000, slot: 461970860, side: "BUY", validFailure: true },
      ],
    });
    expect(result.flowEvaluation?.isPaperQualified).toBe(true);
    expect(result.flowEvaluation?.recentBuys60s).toBe(0);
    expect(result.flowEvaluation?.recentSells60s).toBe(0);
    const ctx = (
      result.flowEvaluation as { paperQualificationContext?: { qualificationKind?: string } }
    ).paperQualificationContext;
    expect(ctx?.qualificationKind).toBe("ACTIVE_WINDOW");
    expect(result.status).not.toBe("RETEST_CONFIRMED");
    expect(result.ledger.transactionDecodeAttempts).toBe(1);

    const baseline = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(baseline.ok).toBe(true);
    expect(baseline.matchesRecordedDecision).toBe(true);
    expect(baseline.recomputedActiveWindowFlow?.knownFailedTransactions).toBe(1);
    expect(baseline.recomputedActiveWindowFlow?.recentBuys60s).toBe(0);

    const evidence = readJson<SealedActiveEvidence>(activeEvidencePath());
    const responsePath = path.join(activeOutDir, evidence.resolutions[0]!.responseFile!);
    const manifestPath = path.join(activeOutDir, "evidence-manifest.json");
    const originals = new Map(
      [responsePath, activeEvidencePath(), manifestPath].map((p) => [p, readFileSync(p, "utf8")]),
    );
    const restore = () => {
      for (const [p, content] of originals) writeFileSync(p, content, "utf8");
    };
    const editJson = (p: string, mutate: (j: Record<string, unknown>) => void) => {
      const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      mutate(j);
      writeFileSync(p, JSON.stringify(j), "utf8");
    };
    const setErr = (err: unknown) => (j: Record<string, unknown>) => {
      const meta = (j.result as { meta: Record<string, unknown> }).meta;
      meta.err = err;
      meta.status = { Err: err };
    };
    const cases: Array<[string, () => void, string, string]> = [
      [
        "raw error replaced by an empty object",
        () => editJson(responsePath, setErr({})),
        "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
        "contradicts re-derivation from the raw response (FAILED_DECODE)",
      ],
      [
        "raw error replaced by a different recognized error",
        () => editJson(responsePath, setErr({ InstructionError: [0, { Custom: 31 }] })),
        "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
        "does not match the raw transaction response",
      ],
      [
        "raw error removed",
        () =>
          editJson(responsePath, (j) => {
            const meta = (j.result as { meta: Record<string, unknown> }).meta;
            delete meta.err;
            delete meta.status;
          }),
        "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
        "contradicts re-derivation from the raw response (FAILED_DECODE)",
      ],
      [
        "JSON-RPC response id altered",
        () => editJson(responsePath, (j) => (j.id = 7)),
        "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
        "contradicts re-derivation from the raw response (FAILED_DECODE)",
      ],
      [
        "sealed policy replaced",
        () =>
          editJson(activeEvidencePath(), (j) => (j.failedTransactionPolicy = "SOME_OTHER_POLICY")),
        "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
        "Unsupported sealed failed-transaction policy",
      ],
      [
        "sealed label relabelled as an executed transaction",
        () =>
          editJson(activeEvidencePath(), (j) => {
            (j.resolutions as Array<Record<string, unknown>>)[0]!.status = "RESOLVED";
          }),
        "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
        "(RESOLVED) contradicts re-derivation from the raw response (RESOLVED_FAILED_TRANSACTION)",
      ],
      [
        "sealed response link changed",
        () =>
          editJson(activeEvidencePath(), (j) => {
            (j.resolutions as Array<Record<string, unknown>>)[0]!.responseFile =
              "responses/01-pool-layout.json";
          }),
        "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
        "is not linked to its sealed transaction response",
      ],
      [
        "policy removed (legacy interpretation cannot reproduce the recorded flow)",
        () => editJson(activeEvidencePath(), (j) => delete j.failedTransactionPolicy),
        "REPLAY_ACTIVE_WINDOW_MISMATCH",
        "does not reproduce the recorded flow (buys=0, sells=0)",
      ],
    ];
    try {
      for (const [label, tamper, status, reason] of cases) {
        restore();
        tamper();
        resealSyntheticCapture(activeOutDir);
        const r = replayCandidateDecisionFromSealedEvidence(activeOutDir);
        expect(r.ok, label).toBe(false);
        expect(r.status, label).toBe(status);
        expect(r.message, label).toContain(reason);
        expect(r.decisionResult, label).toBeUndefined();
      }
    } finally {
      restore();
    }
    expect(replayCandidateDecisionFromSealedEvidence(activeOutDir).ok).toBe(true);
  });

  it("F8. Without the opt-in, a validated failed transaction keeps the existing unavailable behavior", async () => {
    const result = await runActive({
      swaps: [
        { signature: SIG_C, offsetMs: 45_000, slot: 461970860, side: "BUY", validFailure: true },
      ],
    });
    expect(result.flowEvaluation?.flowCoverage).toBe("COLLECTION_GAP");
    expect(result.flowEvaluation?.recentBuys60s).toBeNull();
    expect(result.flowEvaluation?.recentSells60s).toBeNull();
    expect(result.flowEvaluation?.diagnosticReason).toBe(
      "NON_QUIET_STREAM_UNVERIFIED_COMPLETENESS",
    );
    expect(existsSync(activeEvidencePath())).toBe(false);
  });

  it("F9. Failed transactions still exhaust the 3 shared retrievals; the window stays unavailable", async () => {
    const result = await runActive({
      paperActiveWindowFlow: true,
      swaps: [
        {
          signature: TEST_SIG_B,
          offsetMs: 20_000,
          slot: 461970850,
          side: "BUY",
          validFailure: true,
        },
        { signature: SIG_C, offsetMs: 30_000, slot: 461970855, side: "BUY", validFailure: true },
        { signature: SIG_D, offsetMs: 40_000, slot: 461970860, side: "BUY", validFailure: true },
        { signature: SIG_E, offsetMs: 50_000, slot: 461970865, side: "SELL" },
      ],
    });
    expect(result.ledger.transactionDecodeAttempts).toBe(3);
    expect(result.ledger.totalAttempts).toBeLessThanOrEqual(14);
    expect(result.flowEvaluation?.flowCoverage).toBe("COLLECTION_GAP");
    expect(result.flowEvaluation?.recentBuys60s).toBeNull();
    expect(result.flowEvaluation?.diagnosticReason).toContain("ACTIVE_WINDOW_UNQUALIFIED");
    const evidence = readJson<SealedActiveEvidence>(activeEvidencePath());
    expect(
      evidence.resolutions.filter((r) => r.status === "RESOLVED_FAILED_TRANSACTION"),
    ).toHaveLength(3);
    const replay = replayCandidateDecisionFromSealedEvidence(activeOutDir);
    expect(replay.ok).toBe(true);
    expect(replay.matchesRecordedDecision).toBe(true);
    expect(replay.recomputedActiveWindowFlow?.flow.isCoverageSufficient).toBe(false);
  });
});
