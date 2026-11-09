import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CandidateDecisionDiagnostic,
  replayCandidateDecisionFromSealedEvidence,
  evaluateAuthorityEvidence,
  CANONICAL_ZERO_ADDRESS,
} from "./CandidateDecisionDiagnostic.js";
import {
  CAPTURED_RAY_WSOL_IDENTITIES,
  RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE,
  RAW_CAPTURED_RAY_WSOL_ACCOUNT_BATCH_RPC_RESPONSE,
  SYNTHETIC_QUALIFIED_RAW_PAYLOAD,
} from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import { CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD } from "./fixtures/CapturedSolanaTrackerBundlerFixture.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";

const TEST_POOL_ID = CAPTURED_RAY_WSOL_IDENTITIES.poolId;
const TEST_MINT = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!;
const TEST_RPC_URL = "http://127.0.0.1:8899";

const TEST_SIG_A =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const TEST_SIG_B =
  "QHREMqhWG7eahNuQ2EzQqSYKLy8WH9jVerfLRJTttyPorHxQJDzMMcB1142poqJHzYyVSsijoS1U9222QBV6AbM";

export interface MockWebSocketTransportOptions {
  immediateAck?: boolean;
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
    }) as ISolanaWebSocketTransport["on"],
  };

  return transport;
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

    // Invalid non-existent drive on Windows
    const unwritableDir = "Z:\\non-existent-drive-topg\\invalid-path";

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

  it("25. Pre-admission screening: accepts canonical 32-byte zero address as valid disabled authority", async () => {
    const now = 1791931000 * 1000;
    let clockTime = now - 70_000;
    const clock = () => clockTime;
    const sleeper = async (ms: number) => {
      clockTime += ms;
      await new Promise((resolve) => setImmediate(resolve));
    };

    const wsTransport = createMockWebSocketTransport({ immediateAck: true });
    const transport = createDiagnosticMockFetch({
      mintAuthority: CANONICAL_ZERO_ADDRESS,
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
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ARMED_FIRST_TICK");
    expect(result.preAdmissionScreening?.passed).toBe(true);
    expect(result.candidateMintAccount?.mintAuthorityStatus).toBe("DISABLED");
    expect(result.candidateMintAccount?.freezeAuthorityStatus).toBe("DISABLED");
  });

  it("26. evaluateAuthorityEvidence helper correctly classifies all states", () => {
    // 1. OMITTED: undefined or missing key
    expect(evaluateAuthorityEvidence({}, "mintAuthority").status).toBe("OMITTED");
    expect(evaluateAuthorityEvidence({ mintAuthority: undefined }, "mintAuthority").status).toBe(
      "OMITTED",
    );
    expect(evaluateAuthorityEvidence(null, "mintAuthority").status).toBe("OMITTED");

    // 2. DISABLED: null or canonical zero address
    const nullEval = evaluateAuthorityEvidence({ mintAuthority: null }, "mintAuthority");
    expect(nullEval.status).toBe("DISABLED");
    expect(nullEval.isRenounced).toBe(true);
    expect(nullEval.isExplicitlyObserved).toBe(true);

    const zeroEval = evaluateAuthorityEvidence(
      { mintAuthority: CANONICAL_ZERO_ADDRESS },
      "mintAuthority",
    );
    expect(zeroEval.status).toBe("DISABLED");
    expect(zeroEval.isRenounced).toBe(true);

    // 3. ACTIVE: valid non-zero Base58 public key
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
});
