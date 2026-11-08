import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { CandidateDecisionDiagnostic } from "./CandidateDecisionDiagnostic.js";
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

function createMockWebSocketTransport(options?: {
  immediateAck?: boolean;
  messagesToSend?: string[];
}): ISolanaWebSocketTransport {
  const listeners: {
    open: (() => void)[];
    message: ((data: string | Buffer) => void)[];
    error: ((err: Error) => void)[];
    close: ((code: number, reason: string) => void)[];
  } = {
    open: [],
    message: [],
    error: [],
    close: [],
  };
  let isClosed = false;

  const transport: ISolanaWebSocketTransport = {
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
      for (const fn of listeners.close) {
        fn(code ?? 1000, reason ?? "");
      }
    },
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "open") {
        listeners.open.push(listener as () => void);
        queueMicrotask(() => {
          if (!isClosed) (listener as () => void)();
        });
      } else if (event === "message") {
        listeners.message.push(listener as (data: string | Buffer) => void);
      } else if (event === "error") {
        listeners.error.push(listener as (err: Error) => void);
      } else if (event === "close") {
        listeners.close.push(listener as (code: number, reason: string) => void);
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
  active429OnProvider?: string;
  hangingRequest?: boolean;
  rugScore?: number;
  hasDanger?: boolean;
  delayMs?: number;
  getClock?: () => number;
  blockTimeSec?: number;
  unqualifiedLp?: boolean;
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
      const pairPayload = {
        schemaVersion: "1.0.0",
        pairs: [
          {
            chainId: "solana",
            dexId: "raydium",
            url: `https://dexscreener.com/solana/${TEST_POOL_ID}`,
            pairAddress: TEST_POOL_ID,
            baseToken: { address: TEST_MINT, name: "Raydium", symbol: "RAY" },
            quoteToken: {
              address: "So11111111111111111111111111111111111111112",
              name: "Wrapped SOL",
              symbol: "SOL",
            },
            priceNative: "0.015",
            priceUsd: "2.50",
            liquidity: scenario.missingLiquidity ? undefined : { usd: 65000 },
            marketCap: scenario.marketCap !== undefined ? scenario.marketCap : 250000,
            fdv: scenario.fdv !== undefined ? scenario.fdv : 300000,
            volume: { m5: 15000 },
            txns: { m5: { buys: 40, sells: 15 } },
            pairCreatedAt: scenario.missingCreatedAt ? undefined : currentMs - 600 * 1000,
            priceChange: { m5: 1.5, h1: 4.2 },
          },
        ],
      };
      return new Response(JSON.stringify(pairPayload), { status: 200 });
    }

    // RugCheck Report Request
    if (urlStr.includes("api.rugcheck.xyz/v1/tokens/")) {
      const rcPayload = {
        score: scenario.rugScore !== undefined ? scenario.rugScore : 150,
        risks: scenario.hasDanger
          ? [{ name: "High Risk", level: "danger" }]
          : [{ name: "Info", level: "info" }],
        tokenMeta: { mutable: false },
        topHolders: [
          { address: "Holder1", pct: 5.0 },
          { address: "Holder2", pct: 4.0 },
        ],
        totalHolders: 450,
      };
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
          const freezeAuth =
            scenario.freezeAuthority !== undefined ? scenario.freezeAuthority : null;
          const mintAuth = scenario.mintAuthority !== undefined ? scenario.mintAuthority : null;
          const mintAccountRpc = {
            jsonrpc: "2.0",
            result: {
              context: { slot: 461970878 },
              value: {
                data: {
                  program: "spl-token",
                  parsed: {
                    info: {
                      decimals: 6,
                      freezeAuthority: freezeAuth,
                      isInitialized: true,
                      mintAuthority: mintAuth,
                      supply: "555000000000000",
                    },
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
                  signature:
                    "3bJ8AnchorSig1111111111111111111111111111111111111111111111111111111111111111",
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
                  signature:
                    "3bJ8AnchorSig1111111111111111111111111111111111111111111111111111111111111111",
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
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: 461970880, id }), {
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
            signature:
              "5LiveTxSignature111111111111111111111111111111111111111111111111111111111111111111",
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
      freezeAuthority: "ActiveMaliciousFreezeAuthority11111111111111111",
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

    const transport = createDiagnosticMockFetch();

    const walletPath = path.resolve(process.cwd(), ".tmp", "virtual-wallet.json");
    const walletBefore = existsSync(walletPath) ? readFileSync(walletPath, "utf8") : null;

    const diagnostic = new CandidateDecisionDiagnostic({
      poolId: TEST_POOL_ID,
      mintAddress: TEST_MINT,
      rpcUrl: TEST_RPC_URL,
      outDir: testOutDir,
      transport,
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
});
