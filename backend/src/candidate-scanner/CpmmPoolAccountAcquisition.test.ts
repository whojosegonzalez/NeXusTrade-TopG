import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_2022_PROGRAM_ID } from "../research/pilot/RaydiumCpmmParser.js";
import {
  FIXTURE_CPMM_POOL_ADDRESS as POOL,
  FIXTURE_CPMM_TOKEN_0_VAULT as VAULT0,
  FIXTURE_CPMM_TOKEN_1_VAULT as VAULT1,
  RAYDIUM_CPMM_AUTHORITY,
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
} from "../research/pilot/fixtures/AuthoritativeCpmmFixtures.js";
import {
  CpmmPoolAccountAcquisition,
  type CpmmPoolAccountAcquisitionOptions,
} from "./CpmmPoolAccountAcquisition.js";
import {
  PAPER_REQUEST_LANES,
  PaperRequestSession,
  type PaperRequestExchangeEvidence,
  type PaperRequestSessionLimits,
} from "./PaperRequestSession.js";
import {
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
  adaptRaydiumCpmmPoolState,
} from "./RaydiumCpmmPoolStateAdapter.js";
import * as poolStateAdapter from "./RaydiumCpmmPoolStateAdapter.js";

const LOW_MINT = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const HIGH_MINT = "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG";
const URL = "https://rpc.invalid/local-fixture";
const FOREIGN_URL = "https://rpc.invalid/other-owner";
const START = 100_000;
const S1 = 310_000_000;
const S2 = S1 + 4;
const DISCOVERY = "CPMM_POOL_VAULT_DISCOVERY";
const SNAPSHOT = "CPMM_POOL_ACCOUNT_SNAPSHOT";

type PoolOverrides = NonNullable<Parameters<typeof createAuthoritativeRaydiumCpmmBuffer>[0]>;
function fixture(reversed = false, overrides: PoolOverrides = {}) {
  const candidateMint = reversed ? HIGH_MINT : LOW_MINT;
  const [mint0, mint1] = reversed ? [WSOL_MINT, candidateMint] : [candidateMint, WSOL_MINT];
  const pool = createAuthoritativeRaydiumCpmmBuffer({
    authBump: 253,
    token0MintBase58: mint0!,
    token1MintBase58: mint1!,
    mint0Decimals: reversed ? 9 : 6,
    mint1Decimals: reversed ? 6 : 9,
    ...overrides,
  });
  const vault = (mintBase58: string, rawAmount: bigint) =>
    createAuthoritativeCpmmSplVaultBuffer({
      mintBase58,
      ownerBase58: RAYDIUM_CPMM_AUTHORITY,
      rawAmount,
      state: 1,
    });
  const target = { poolAddress: POOL, candidateMint };
  const poolAccount = {
    address: POOL,
    data: pool,
    ownerProgramId: RAYDIUM_CPMM_PROGRAM_ID,
    slot: S2,
  };
  const vault0Account = {
    address: VAULT0,
    data: vault(mint0!, 10_000_000_000n),
    ownerProgramId: SPL_TOKEN_PROGRAM_ID,
    slot: S2,
  };
  const vault1Account = {
    address: VAULT1,
    data: vault(mint1!, 20_000_000_000n),
    ownerProgramId: SPL_TOKEN_PROGRAM_ID,
    slot: S2,
  };
  const value = [poolAccount, vault0Account, vault1Account].map((a) => ({
    owner: a.ownerProgramId,
    executable: false,
    lamports: 123,
    rentEpoch: Number(18_446_744_073_709_551_615n),
    space: a.data.length,
    data: [a.data.toString("base64"), "base64"],
  }));
  return { target, value, input: { target, poolAccount, vault0Account, vault1Account } };
}

function rpc(id: number, value: readonly unknown[], slot: number) {
  return { jsonrpc: "2.0", id, result: { value, context: { slot, apiVersion: "2.0.0" } } };
}
type Reply = (call: {
  id: number;
  purpose: typeof DISCOVERY | typeof SNAPSHOT;
  signal: AbortSignal;
}) => Response | Promise<Response>;

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const sessions: PaperRequestSession[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.stop("TEST_CLEANUP");
  vi.useRealTimers();
});

function harness(
  config: {
    reversed?: boolean;
    observe?: (
      e: PaperRequestExchangeEvidence,
      forward: (e: PaperRequestExchangeEvidence) => void,
    ) => void;
    reply?: Reply;
    foreign?: (signal: AbortSignal) => Response | Promise<Response>;
    limits?: Partial<PaperRequestSessionLimits>;
    laneMax?: number;
    open?: boolean;
    options?: Partial<CpmmPoolAccountAcquisitionOptions>;
  } = {},
) {
  const acquisition = new CpmmPoolAccountAcquisition();
  const data = fixture(config.reversed);
  const owned = new Set<ReturnType<typeof setTimeout>>();
  const timers = {
    setTimeout(fn: () => void, ms: number) {
      const handle = setTimeout(() => {
        owned.delete(handle);
        fn();
      }, ms);
      owned.add(handle);
      return handle;
    },
    clearTimeout(handle: unknown) {
      owned.delete(handle as ReturnType<typeof setTimeout>);
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  const ordinary: Reply = ({ id, purpose }) =>
    new Response(
      JSON.stringify(
        purpose === DISCOVERY ? rpc(id, data.value.slice(0, 1), S1) : rpc(id, data.value, S2),
      ).replaceAll('"rentEpoch":18446744073709552000', '"rentEpoch":18446744073709551615'),
    );
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    if (url === FOREIGN_URL) return config.foreign?.(init!.signal!) ?? new Response("foreign");
    expect(url).toBe(URL);
    const body = JSON.parse(init?.body as string) as { id: number; params: [string[]] };
    return (config.reply ?? ordinary)({
      id: body.id,
      purpose: body.params[0].length === 1 ? DISCOVERY : SNAPSHOT,
      signal: init!.signal!,
    });
  });
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn,
    clock: Date.now,
    timers: { setTimeout, clearTimeout },
    limits: {
      lifetimeMs: 60_000,
      maxHttpAttempts: 8,
      requestTimeoutMs: 20_000,
      lanes: {
        SOLANA_RPC: { maxAttempts: config.laneMax ?? 4, pacingMs: 2500, maxResponseBytes: 24_576 },
        RUGCHECK: { maxAttempts: 1, pacingMs: 1, maxResponseBytes: 24_576 },
        SOLANA_TRACKER: { maxAttempts: 1, pacingMs: 1, maxResponseBytes: 24_576 },
        DEXSCREENER: { maxAttempts: 1, pacingMs: 1, maxResponseBytes: 24_576 },
      },
      ...config.limits,
    },
    onExchangeComplete: config.observe
      ? (evidence) => config.observe!(evidence, acquisition.onExchangeComplete)
      : acquisition.onExchangeComplete,
  });
  sessions.push(session);
  if (config.open !== false) session.open();
  const options = {
    session,
    timers,
    url: URL,
    target: data.target,
    deadlineMs: Date.now() + 12_000,
    timeoutMs: 1000,
    ...config.options,
  };
  const run = () => acquisition.acquire(options);
  const ledger = () => session.getLedgerSince(0);
  const assertClean = () => {
    expect(owned.size).toBe(0);
    expect(session.getActiveTimerCount()).toBe(session.isOpen() ? 1 : 0);
  };
  const foreign = () =>
    session.dispatch({
      lane: "SOLANA_RPC",
      owner: "FLOW",
      purpose: DISCOVERY,
      requestedIdentity: POOL,
      method: "GET",
      url: FOREIGN_URL,
    });
  const finish = async (ms = 4000) => {
    const result = run();
    await vi.advanceTimersByTimeAsync(ms);
    return result;
  };
  return {
    acquisition,
    session,
    options,
    fetchFn,
    ledger,
    assertClean,
    foreign,
    run,
    finish,
    ordinary,
    owned,
  };
}

describe("CpmmPoolAccountAcquisition", () => {
  it.each([false, true])(
    "AQ1/AQ6: exact paced requests and adaptation from snapshot only (reversed=%s)",
    async (reversed) => {
      const discovery = fixture(reversed);
      const snapshot = fixture(reversed, { protocolFeesToken0: 123n, status: 1 });
      const slot = reversed ? S1 : S2;
      const h = harness({
        reversed,
        reply: ({ id, purpose }) =>
          Response.json(
            purpose === DISCOVERY
              ? rpc(id, discovery.value.slice(0, 1), S1)
              : rpc(id, snapshot.value, slot),
          ),
      });
      expect(h.session.nextJsonRpcId()).toBe(1); // shared sequence already used by another owner
      const result = await h.finish();
      expect(result.outcome).toBe("ACQUIRED");
      if (result.outcome !== "ACQUIRED") throw new Error(result.code);
      const expected = {
        target: snapshot.target,
        poolAccount: { ...snapshot.input.poolAccount, slot },
        vault0Account: { ...snapshot.input.vault0Account, slot },
        vault1Account: { ...snapshot.input.vault1Account, slot },
      };
      expect(result.input).toMatchObject(expected);
      expect(result.adapted).toEqual(adaptRaydiumCpmmPoolState(expected));
      expect(result.adapted.ok).toBe(true);
      expect(result.contextSlot).toBe(slot);
      expect(result.discoveryPoolBytesEqual).toBe(false);
      const bodies = [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "getMultipleAccounts",
          params: [[POOL], { commitment: "confirmed", encoding: "base64" }],
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "getMultipleAccounts",
          params: [
            [POOL, VAULT0, VAULT1],
            { commitment: "confirmed", encoding: "base64", minContextSlot: S1 },
          ],
        }),
      ];
      expect(
        h.fetchFn.mock.calls.map(([url, init]) => [url, init?.method, init?.redirect, init?.body]),
      ).toEqual(bodies.map((body) => [URL, "POST", "manual", body]));
      expect(h.ledger()).toMatchObject([
        {
          seq: 1,
          lane: "SOLANA_RPC",
          owner: "FLOW",
          requestedIdentity: POOL,
          purpose: DISCOVERY,
          dispatchedAtMs: START,
          jsonRpcId: 2,
        },
        {
          seq: 2,
          lane: "SOLANA_RPC",
          owner: "FLOW",
          requestedIdentity: POOL,
          purpose: SNAPSHOT,
          dispatchedAtMs: START + 2500,
          jsonRpcId: 3,
        },
      ]);
      expect(result.exchanges.map((entry) => entry.requestBody)).toEqual(bodies);
      expect(result.exchanges.map((entry) => entry.entry)).toEqual(h.ledger());
      expect(result).not.toHaveProperty("qualified");
      h.assertClean();
    },
  );

  it.each([
    [
      "candidate mint",
      { target: { candidateMint: "bad", poolAddress: POOL } },
      "TARGET_INVALID:candidateMint",
    ],
    [
      "pool address",
      { target: { candidateMint: LOW_MINT, poolAddress: ` ${POOL}` } },
      "TARGET_INVALID:poolAddress",
    ],
    [
      "pool equals mint",
      { target: { candidateMint: LOW_MINT, poolAddress: LOW_MINT } },
      "TARGET_INVALID:poolAddress",
    ],
    [
      "pool is WSOL",
      { target: { candidateMint: LOW_MINT, poolAddress: WSOL_MINT } },
      "TARGET_INVALID:poolAddress",
    ],
    [
      "mint is WSOL",
      { target: { candidateMint: WSOL_MINT, poolAddress: POOL } },
      "CANDIDATE_MINT_IS_WSOL",
    ],
    ["extra key", { extra: true }, "OPTIONS_INVALID"],
    ["bad endpoint", { url: "file:///local" }, "OPTIONS_INVALID"],
    ["bad body ceiling", { maxResponseBytes: 16_385 }, "OPTIONS_INVALID"],
    ["bad timeout", { timeoutMs: 10_001 }, "OPTIONS_INVALID"],
    ["bad deadline", { deadlineMs: Infinity }, "OPTIONS_INVALID"],
    ["overlong deadline", { deadlineMs: START + 30_001 }, "OPTIONS_INVALID"],
    ["already expired", { deadlineMs: START }, "ACQUISITION_DEADLINE_EXCEEDED"],
    ["timeout cannot fit", { deadlineMs: START + 999 }, "ACQUISITION_DEADLINE_EXCEEDED"],
    ["caller cancelled", { signal: AbortSignal.abort() }, "CALLER_CANCELLED"],
  ])("AQ2: %s refuses before HTTP", async (_label, bad, code) => {
    const h = harness();
    const acquisition = h.acquisition;
    expect(await acquisition.acquire({ ...h.options, ...bad })).toMatchObject({
      outcome: "ACQUISITION_FAILED",
      code,
      exchanges: [],
    });
    expect(await h.run()).toMatchObject({ code: "ALREADY_STARTED" });
    expect(h.fetchFn).not.toHaveBeenCalled();
    h.assertClean();
  });

  it("AQ2: concurrent and repeated calls cannot start more than one bounded pair", async () => {
    const h = harness();
    const first = h.run();
    expect(await h.run()).toMatchObject({ code: "ALREADY_STARTED", exchanges: [] });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await first).toMatchObject({ outcome: "ACQUIRED", discoveryPoolBytesEqual: true });
    expect(await h.run()).toMatchObject({ code: "ALREADY_STARTED", exchanges: [] });
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    h.assertClean();
  });

  it.each(["unopened", "stopped", "lifetime", "lane", "total", "budget"] as const)(
    "AQ2: %s follows the accepted shared session, without an extra dispatch",
    async (kind) => {
      const h = harness({
        open: kind !== "unopened",
        ...(kind === "lane" ? { laneMax: 0 } : {}),
        ...(kind === "lifetime" ? { limits: { lifetimeMs: 10 } } : {}),
        ...(kind === "total" ? { laneMax: 1, limits: { maxHttpAttempts: 1 } } : {}),
      });
      if (kind === "stopped") h.session.stop("ALREADY_STOPPED");
      if (kind === "lifetime") vi.setSystemTime(START + 10);
      if (kind === "total") await h.foreign();
      if (kind === "budget")
        vi.spyOn(h.session.budget, "recordActualDispatch").mockReturnValue(false);
      const code = {
        unopened: "REQUEST_SESSION_NOT_OPEN",
        stopped: "REQUEST_SESSION_STOPPED",
        lifetime: "LIFETIME_EXPIRED",
        lane: "SOLANA_RPC_ATTEMPT_CEILING_REACHED",
        total: "HTTP_ATTEMPT_CEILING_REACHED",
        budget: "BUDGET_MANAGER_DENIED",
      }[kind];
      expect(await h.run()).toMatchObject({ outcome: "ACQUISITION_FAILED", code, exchanges: [] });
      expect(h.fetchFn).toHaveBeenCalledTimes(kind === "total" ? 1 : 0);
      if (kind === "lifetime") h.session.stop(); // setSystemTime does not run the session's timer
      h.assertClean();
    },
  );

  it.each([DISCOVERY, SNAPSHOT])(
    "AQ3: transport failures at %s keep their cause and do not retry",
    async (step) => {
      const cases = [
        ["REQUEST_TIMED_OUT", () => new Promise<Response>(() => {})],
        ["NETWORK_ERROR", () => Promise.reject(new Error("injected"))],
        ["HTTP_429_RECEIVED", () => new Response(null, { status: 429 })],
        [
          "HTTP_REDIRECT_REJECTED",
          () => new Response(null, { status: 302, headers: { location: FOREIGN_URL } }),
        ],
        [
          "RESPONSE_TOO_LARGE",
          () => new Response("tiny", { headers: { "content-length": "16385" } }),
        ],
        ["RESPONSE_TOO_LARGE", () => new Response("x".repeat(16_385))],
        ["HTTP_STATUS_NOT_200", () => new Response("injected", { status: 503 })],
      ] as const;
      const count = step === DISCOVERY ? 1 : 2;
      for (const [index, [code, response]] of cases.entries()) {
        const h = harness({
          reply: (call) => (call.purpose === step ? response() : h.ordinary(call)),
        });
        const result = await h.finish();
        expect(result, `${step}/${code}/${index}`).toMatchObject({
          code,
          outcome: "ACQUISITION_FAILED",
        });
        expect(h.fetchFn).toHaveBeenCalledTimes(count);
        expect(result.exchanges.map((x) => x.entry)).toEqual(h.ledger());
        const last = result.exchanges.at(-1)!;
        expect(last.bodyState).toBe(
          index === 5 ? "PARTIAL_OVERFLOW" : index === 6 ? "COMPLETE" : "NOT_READ",
        );
        if (index === 5) expect(last.body).toHaveLength(16_384);
        if (index === 2 || index === 3) expect(h.session.getStopReason()).toBe(code);
        h.assertClean();
      }
      const h = harness();
      const dispatch = h.session.dispatch.bind(h.session);
      vi.spyOn(h.session, "dispatch").mockImplementation((req) =>
        req.purpose === step
          ? Promise.reject(new Error("injected dispatch exception"))
          : dispatch(req),
      );
      expect(await h.finish()).toMatchObject({ code: "DISPATCH_EXCEPTION" });
      expect(h.ledger()).toHaveLength(count - 1);
      h.assertClean();
    },
  );

  it("AQ3: the stricter session timeout and lane byte ceiling still govern", async () => {
    const lane = { maxAttempts: 3, pacingMs: 2500, maxResponseBytes: 1200 };
    const lanes = Object.fromEntries(
      PAPER_REQUEST_LANES.map((key) => [key, lane]),
    ) as PaperRequestSessionLimits["lanes"];
    const h = harness({ limits: { requestTimeoutMs: 300, lanes } });
    const result = await h.finish();
    expect(result).toMatchObject({ code: "RESPONSE_TOO_LARGE", stage: "SNAPSHOT" });
    expect(result.exchanges.map((e) => e.maxResponseBytes)).toEqual([1200, 1200]);
    h.assertClean();
    const pending = harness({
      limits: { requestTimeoutMs: 300 },
      options: { deadlineMs: Date.now() + 500 },
      reply: () => new Promise<Response>(() => {}),
    });
    expect(await pending.finish(350)).toMatchObject({ code: "REQUEST_TIMED_OUT" });
    expect(pending.ledger()).toMatchObject([{ completedAtMs: Date.now() - 50 }]);
    pending.assertClean();
  });

  it.each([
    ["not JSON", "NOT_JSON", () => new Response("{")],
    ["not UTF-8", "NOT_UTF8", () => new Response(Uint8Array.of(0xc0, 0x80))],
    ["non-object", "ENVELOPE_SHAPE", () => Response.json([])],
    [
      "extra key",
      "ENVELOPE_SHAPE",
      (id: number) => Response.json({ ...rpc(id, [], S1), extra: true }),
    ],
    [
      "wrong version",
      "ENVELOPE_VERSION",
      (id: number) => Response.json({ ...rpc(id, [], S1), jsonrpc: "1.0" }),
    ],
    ["missing id", "ID_MISSING", () => Response.json({ jsonrpc: "2.0", result: {} })],
    ["wrong id", "ID_MISMATCH", (id: number) => Response.json(rpc(id + 1, [], S1))],
    [
      "string id",
      "ID_MISMATCH",
      (id: number) => Response.json({ ...rpc(id, [], S1), id: String(id) }),
    ],
    [
      "both result and error",
      "ENVELOPE_RESULT_OR_ERROR",
      (id: number) => Response.json({ ...rpc(id, [], S1), error: {} }),
    ],
    ["neither", "ENVELOPE_RESULT_OR_ERROR", (id: number) => Response.json({ jsonrpc: "2.0", id })],
    [
      "RPC error",
      "RPC_ERROR",
      (id: number) => Response.json({ jsonrpc: "2.0", id, error: { code: -32602 } }),
    ],
  ] as const)("AQ4: %s is not acquisition evidence", async (_label, code, response) => {
    const h = harness({ reply: ({ id }) => response(id) });
    const result = await h.finish();
    expect(result).toMatchObject({ code, stage: "DISCOVERY" });
    if (code === "RPC_ERROR") expect(result).toHaveProperty("rpcErrorCode", -32602);
    expect(result.exchanges).toHaveLength(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    h.assertClean();
  });

  it.each([
    [
      "minimum-slot RPC error",
      "RPC_ERROR",
      (id: number) => Response.json({ jsonrpc: "2.0", id, error: { code: -32016 } }),
    ],
    [
      "regressed context",
      "CONTEXT_SLOT_REGRESSED",
      (id: number) => Response.json(rpc(id, fixture().value, S1 - 1)),
    ],
  ] as const)("AQ4/AQ6: no retry on %s", async (_label, code, response) => {
    const h = harness({
      reply: (call) => (call.purpose === SNAPSHOT ? response(call.id) : h.ordinary(call)),
    });
    const result = await h.finish();
    expect(result).toMatchObject({ code, stage: "SNAPSHOT" });
    if (code === "RPC_ERROR") expect(result).toHaveProperty("rpcErrorCode", -32016);
    expect(result.exchanges).toHaveLength(2);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    h.assertClean();
  });

  it.each([
    ["RESULT_SHAPE", null],
    ["RESULT_SHAPE", { context: { slot: S1 }, value: [], extra: true }],
    ["RESULT_SHAPE", { context: { slot: S1 } }],
    ["CONTEXT_SHAPE", { context: [], value: [] }],
    ["CONTEXT_SHAPE", { context: { slot: S1, extra: true }, value: [] }],
    ["CONTEXT_SHAPE", { context: { slot: S1, apiVersion: 2 }, value: [] }],
    ...[undefined, -1, 1.2, 2 ** 53, String(S1)].map(
      (slot) => ["CONTEXT_SLOT_INVALID", { context: { slot }, value: [] }] as const,
    ),
    ...[{}, [], [...fixture().value]].map(
      (value) => ["VALUE_LENGTH_MISMATCH", { context: { slot: S1 }, value }] as const,
    ),
  ] as const)("AQ5: refuses the result/context fixture (%s, %#)", async (code, result) => {
    const h = harness({ reply: ({ id }) => Response.json({ jsonrpc: "2.0", id, result }) });
    expect(await h.finish()).toMatchObject({ code, stage: "DISCOVERY" });
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    h.assertClean();
  });

  it.each([
    ["POOL", 0],
    ["VAULT0", 1],
    ["VAULT1", 2],
  ] as const)("AQ5: validates every account rule at %s", async (pos, index) => {
    const valid = fixture().value;
    const account = valid[index]!;
    const cases = [
      ["ACCOUNT_MISSING", null],
      ["ACCOUNT_SHAPE", { ...account, extra: true }],
      ["ACCOUNT_SHAPE", []],
      ["ACCOUNT_ENCODING", { ...account, data: [account.data[0], "base64+zstd"] }],
      ["ACCOUNT_ENCODING", { ...account, data: [account.data[0], "base64", "extra"] }],
      ["ACCOUNT_ENCODING", { ...account, data: [` ${account.data[0]}`, "base64"] }],
      ["ACCOUNT_ENCODING", { ...account, data: ["AB==", "base64"] }], // decodes, but the pad bits are noncanonical
      ["ACCOUNT_ENCODING", { ...account, data: ["YQ", "base64"] }],
      ["ACCOUNT_SPACE_MISMATCH", { ...account, space: account.space + 1 }],
      ["ACCOUNT_SPACE_MISMATCH", { ...account, space: String(account.space) }],
      ["ACCOUNT_OWNER_MALFORMED", { ...account, owner: ` ${account.owner}` }],
      ["ACCOUNT_OWNER_MALFORMED", { ...account, owner: undefined }],
      ["ACCOUNT_EXECUTABLE", { ...account, executable: true }],
      ["ACCOUNT_EXECUTABLE", { ...account, executable: undefined }],
      ...[-1, 1.5, 2 ** 53, undefined].map(
        (lamports) => ["ACCOUNT_LAMPORTS_UNSAFE", { ...account, lamports }] as const,
      ),
      ...[-1, "1", undefined].map(
        (rentEpoch) => ["ACCOUNT_RENT_EPOCH_INVALID", { ...account, rentEpoch }] as const,
      ),
      ["ACCOUNT_RENT_EPOCH_INVALID", { ...account, rentEpoch: "OVERFLOW_NUMBER" }],
    ] as const;
    for (const [caseIndex, [code, value]] of cases.entries()) {
      const accounts = valid.map((item, i) => (i === index ? value : item));
      const h = harness({
        reply: (call) =>
          call.purpose === SNAPSHOT
            ? new Response(
                JSON.stringify(rpc(call.id, accounts, S2)).replace('"OVERFLOW_NUMBER"', "1e400"),
              )
            : h.ordinary(call),
      });
      expect(await h.finish(), `account ${pos}, case ${caseIndex}`).toMatchObject({
        code: `${code}:${pos}`,
        stage: "SNAPSHOT",
      });
      expect(h.fetchFn).toHaveBeenCalledTimes(2);
      h.assertClean();
    }
    const h = harness({
      reply: (call) =>
        call.purpose === SNAPSHOT
          ? Response.json(
              rpc(
                call.id,
                valid.map((v) => ({ ...v, space: undefined, lamports: 0 })),
                S2,
              ),
            )
          : h.ordinary(call),
    });
    expect(await h.finish()).toMatchObject({ outcome: "ACQUIRED" });
    h.assertClean();
  });

  it.each(["first", "second", "swapped"] as const)(
    "AQ7: refuses %s vault change without calling adaptation or retrying",
    async (changed) => {
      const changedPool = fixture(false, {
        ...(changed === "first" ? { token0VaultBase58: HIGH_MINT } : {}),
        ...(changed === "second" ? { token1VaultBase58: HIGH_MINT } : {}),
        ...(changed === "swapped" ? { token0VaultBase58: VAULT1, token1VaultBase58: VAULT0 } : {}),
        authBump: 254, // adaptation would refuse auth bump if reached
      });
      const h = harness({
        reply: (call) =>
          call.purpose === SNAPSHOT
            ? Response.json(rpc(call.id, changedPool.value, S2))
            : h.ordinary(call),
      });
      const result = await h.finish();
      expect(result).toMatchObject({
        code: "POOL_VAULTS_CHANGED",
        stage: "SNAPSHOT",
        outcome: "ACQUISITION_FAILED",
      });
      expect(result.exchanges.map((e) => e.entry.purpose)).toEqual([DISCOVERY, SNAPSHOT]);
      expect(h.fetchFn).toHaveBeenCalledTimes(2);
      h.assertClean();
    },
  );

  it.each([
    [{ customBufferLength: 636 }, undefined, "DISCOVERY_POOL_REFUSED:INVALID_BUFFER_LENGTH"],
    [{ discriminator: [] }, undefined, "DISCOVERY_POOL_REFUSED:INVALID_ANCHOR_DISCRIMINATOR"],
    [{ mint0Decimals: 19 }, undefined, "DISCOVERY_POOL_REFUSED:INVALID_DECIMALS"],
    [{}, SPL_TOKEN_PROGRAM_ID, "DISCOVERY_POOL_REFUSED:UNAUTHORIZED_OWNER_PROGRAM"],
    [{ token1VaultBase58: VAULT0 }, undefined, "DISCOVERY_POOL_REFUSED:CONTRADICTORY_VAULTS"],
    [{ token0VaultBase58: POOL }, undefined, "DISCOVERY_VAULTS_INVALID"],
    [{ token1VaultBase58: POOL }, undefined, "DISCOVERY_VAULTS_INVALID"],
  ] as const)(
    "AQ8: bad discovery fixture %# cannot supply request 2",
    async (overrides, owner, code) => {
      const [pool] = fixture(
        false,
        "discriminator" in overrides ? { discriminator: [] } : overrides,
      ).value;
      const h = harness({
        reply: ({ id }) => Response.json(rpc(id, [{ ...pool, owner: owner ?? pool!.owner }], S1)),
      });
      expect(await h.finish()).toMatchObject({ code, stage: "DISCOVERY" });
      expect(h.fetchFn).toHaveBeenCalledTimes(1);
      h.assertClean();
    },
  );

  it("AQ8: snapshot pool is parsed independently of the discovery", async () => {
    const h = harness({
      reply: (call) =>
        call.purpose === SNAPSHOT
          ? Response.json(rpc(call.id, fixture(false, { customBufferLength: 636 }).value, S2))
          : h.ordinary(call),
    });
    expect(await h.finish()).toMatchObject({
      code: "SNAPSHOT_POOL_REFUSED:INVALID_BUFFER_LENGTH",
      stage: "SNAPSHOT",
    });
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    h.assertClean();
  });

  it.each([
    [{ token0ProgramBase58: TOKEN_2022_PROGRAM_ID }, undefined, "UNSUPPORTED_TOKEN_PROGRAM"],
    [{ token1MintBase58: HIGH_MINT }, undefined, "NON_WSOL_PAIR"],
    [
      { token0MintBase58: "11111111111111111111111111111111" },
      undefined,
      "CANDIDATE_MINT_MISMATCH",
    ],
    [{ authBump: 254 }, undefined, "AUTH_BUMP_INVALID"],
    [{ protocolFeesToken0: 10_000_000_001n }, undefined, "INSOLVENT_RESERVES"],
    [{}, TOKEN_2022_PROGRAM_ID, "VAULT_OWNER_UNAUTHORIZED"],
    [{}, RAYDIUM_CPMM_PROGRAM_ID, "VAULT_OWNER_UNAUTHORIZED"],
  ] as const)("AQ9: forwards adapter refusal %s / %#", async (overrides, owner, code) => {
    const { value } = fixture(false, overrides);
    const h = harness({
      reply: (call) =>
        call.purpose === SNAPSHOT
          ? Response.json(
              rpc(
                call.id,
                value.map((v, i) => (i === 1 && owner ? { ...v, owner } : v)),
                S2,
              ),
            )
          : h.ordinary(call),
    });
    const result = await h.finish();
    expect(result).toMatchObject({
      outcome: "ACQUIRED_CONTEXT_REFUSED",
      stage: "ADAPTATION",
      code,
    });
    expect(result).not.toHaveProperty("adapted");
    expect(result.exchanges).toHaveLength(2);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    h.assertClean();
  });

  it.each(["cancel", "deadline", "timeout no longer fits"] as const)(
    "AQ10: %s during shared pacing never sends the snapshot",
    async (cause) => {
      const abort = new AbortController();
      const h = harness({
        options: {
          signal: abort.signal,
          deadlineMs: START + (cause === "deadline" ? 2000 : 3100),
          timeoutMs: 1000,
        },
      });
      const acquired = h.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.getActiveTimerCount()).toBe(2); // lifetime and lane pacing
      if (cause === "cancel") abort.abort();
      await vi.advanceTimersByTimeAsync(
        cause === "deadline" ? 2000 : cause === "cancel" ? 0 : 2500,
      );
      expect(await acquired).toMatchObject({
        code: cause === "cancel" ? "CALLER_CANCELLED" : "ACQUISITION_DEADLINE_EXCEEDED",
        stage: "SNAPSHOT",
        exchanges: [{ entry: { purpose: DISCOVERY } }],
      });
      expect(h.fetchFn).toHaveBeenCalledTimes(1);
      h.assertClean();
    },
  );

  it.each(["cancel", "deadline", "session"] as const)(
    "AQ10: %s during an in-flight snapshot retains both exchanges",
    async (cause) => {
      const abort = new AbortController();
      const pending = deferredResponse();
      let transportSignal: AbortSignal | undefined;
      const h = harness({
        options: { signal: abort.signal, deadlineMs: START + 3500 },
        reply: (call) => {
          if (call.purpose === DISCOVERY) return h.ordinary(call);
          transportSignal = call.signal;
          return pending.promise;
        },
      });
      const acquired = h.run();
      await vi.advanceTimersByTimeAsync(2500);
      expect(transportSignal?.aborted).toBe(false);
      if (cause === "cancel") abort.abort();
      if (cause === "session") h.session.stop("INJECTED_STOP");
      await vi.advanceTimersByTimeAsync(cause === "deadline" ? 1000 : 0);
      const result = await acquired;
      expect(result).toMatchObject({
        code: {
          cancel: "CALLER_CANCELLED_IN_FLIGHT",
          deadline: "DEADLINE_EXCEEDED_IN_FLIGHT",
          session: "SESSION_STOPPED_IN_FLIGHT",
        }[cause],
        stage: "SNAPSHOT",
        exchanges: [
          { bodyState: "COMPLETE" },
          { bodyState: "NOT_READ", entry: { error: "REQUEST_ABORTED" } },
        ],
      });
      if (cause === "session") expect(result).toHaveProperty("sessionStopReason", "INJECTED_STOP");
      expect(transportSignal?.aborted).toBe(true);
      h.assertClean();
      pending.reject(new Error("late transport rejection"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fetchFn).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["cancel", "deadline", "session"] as const)(
    "AQ10: %s after snapshot completion cannot promote success",
    async (cause) => {
      const abort = new AbortController();
      const deadlineMs = START + 7000;
      const h = harness({
        options: { signal: abort.signal, deadlineMs },
        observe: (evidence, forward) => {
          forward(evidence);
          if (evidence.entry.purpose !== SNAPSHOT) return;
          if (cause === "cancel") abort.abort();
          if (cause === "session") h.session.stop("STOP_AFTER_RESPONSE");
          if (cause === "deadline") vi.setSystemTime(deadlineMs); // clock crossed before deadline callback
        },
      });
      const result = await h.finish(2500);
      expect(result).toMatchObject({
        code: {
          cancel: "CALLER_CANCELLED",
          deadline: "ACQUISITION_DEADLINE_EXCEEDED",
          session: "REQUEST_SESSION_STOPPED",
        }[cause],
        exchanges: [{ bodyState: "COMPLETE" }, { bodyState: "COMPLETE" }],
      });
      h.assertClean();
    },
  );

  it("AQ10: rechecks cancellation after the accepted adapter, immediately before success", async () => {
    const abort = new AbortController();
    const adapt = poolStateAdapter.adaptRaydiumCpmmPoolState;
    using spy = vi
      .spyOn(poolStateAdapter, "adaptRaydiumCpmmPoolState")
      .mockImplementation((input) => {
        const result = adapt(input);
        abort.abort();
        return result;
      });
    const h = harness({ options: { signal: abort.signal } });
    expect(await h.finish()).toMatchObject({
      outcome: "ACQUISITION_FAILED",
      code: "CALLER_CANCELLED",
      stage: "ADAPTATION",
      exchanges: [{ bodyState: "COMPLETE" }, { bodyState: "COMPLETE" }],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    h.assertClean();
  });

  it("AQ10: deadline settles independently of a blocked lane, and releases no HTTP later", async () => {
    const held = deferredResponse();
    const { signal } = new AbortController();
    using removeListener = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const h = harness({
      options: { deadlineMs: START + 3000, signal },
      foreign: () => held.promise,
    });
    const blocker = h.foreign();
    await vi.advanceTimersByTimeAsync(0);
    const dispatch = h.session.dispatch.bind(h.session);
    let queuedResult: Awaited<ReturnType<typeof dispatch>> | undefined;
    vi.spyOn(h.session, "dispatch").mockImplementation(async (req) => {
      queuedResult = await dispatch(req);
      throw new Error("injected late rejection after the real queued refusal");
    });
    const settled = vi.fn();
    const acquired = h.run().then(settled);
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: "ACQUISITION_FAILED",
        code: "ACQUISITION_DEADLINE_EXCEEDED",
        exchanges: [],
      }),
    );
    expect(queuedResult).toBeUndefined();
    expect(h.owned.size).toBe(0);
    expect(removeListener.mock.contexts).toContain(signal);
    expect(h.ledger()).toHaveLength(1);
    expect(h.session.getStatus().inFlight).toBe(1);
    held.resolve(new Response("foreign"));
    await blocker;
    await acquired;
    await vi.advanceTimersByTimeAsync(100);
    expect(queuedResult).toMatchObject({
      dispatched: false,
      error: "ACQUISITION_DEADLINE_EXCEEDED",
    });
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(h.ledger()).toHaveLength(1);
    h.assertClean();
  });

  it.each([
    ["absent", "EVIDENCE_NOT_RECORDED"],
    ["duplicate", "EVIDENCE_DUPLICATED"],
    ["wrong sequence", "EVIDENCE_NOT_RECORDED"],
    ["wrong purpose", "EVIDENCE_ENTRY_MISMATCH:purpose"],
    ["wrong status", "EVIDENCE_ENTRY_MISMATCH:httpStatus"],
    ["wrong request", "EVIDENCE_BODY_MISMATCH"],
    ["wrong bytes", "EVIDENCE_BODY_MISMATCH"],
    ["over the limit", "EVIDENCE_BODY_MISMATCH"],
  ] as const)("AQ11: %s observer evidence cannot be used", async (issue, code) => {
    const h = harness({
      observe: (e, forward) => {
        switch (issue) {
          case "absent":
            break;
          case "duplicate":
            forward(e);
            for (let n = 0; n < 10; n++) forward({ ...e, body: Buffer.alloc(16_384) });
            break;
          case "wrong sequence":
            forward({ ...e, entry: { ...e.entry, seq: e.entry.seq + 1 } });
            break;
          case "wrong purpose":
            forward({ ...e, entry: { ...e.entry, purpose: SNAPSHOT } });
            break;
          case "wrong status":
            forward({ ...e, entry: { ...e.entry, httpStatus: 201 } });
            break;
          case "wrong request":
            forward({ ...e, requestBody: "{}" });
            break;
          case "wrong bytes":
            forward({ ...e, body: Buffer.alloc(e.body!.length) });
            break;
          case "over the limit":
            forward({ ...e, body: Buffer.alloc(e.maxResponseBytes + 1) });
            break;
        }
      },
    });
    const result = await h.finish();
    expect(result).toMatchObject({ outcome: "ACQUISITION_FAILED", stage: "DISCOVERY", code });
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(result.exchanges).toHaveLength(
      issue === "duplicate" || issue === "wrong status" || issue === "wrong bytes" ? 1 : 0,
    );
    if (issue === "duplicate") expect(result.exchanges[0]?.body?.toString()).toContain('"jsonrpc"');
    h.assertClean();
  });

  it("AQ11: a foreign exchange with the same purpose is ignored and retained bodies are copied", async () => {
    const h = harness({
      observe: (e, forward) => {
        forward(e);
        e.body?.fill(0);
      },
    });
    const first = h.foreign();
    const acquired = h.run();
    await vi.advanceTimersByTimeAsync(5000);
    await first;
    const result = await acquired;
    expect(result.outcome).toBe("ACQUIRED");
    expect(result.exchanges.map((e) => e.entry.seq)).toEqual([2, 3]);
    expect(result.exchanges.map((e) => e.entry.dispatchedAtMs)).toEqual([
      START + 2500,
      START + 5000,
    ]);
    expect(result.exchanges.every((e) => e.body?.toString().includes('"jsonrpc"'))).toBe(true);
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
    h.assertClean();
  });

  it("AQ12: rejects getters and proxies in supplied option records without invoking them", async () => {
    const trap = vi.fn(() => {
      throw new Error("must not run");
    });
    const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const base = harness().options;
    const bad = [
      proxy,
      revoked.proxy,
      {
        ...base,
        get target() {
          return trap();
        },
      },
      {
        ...base,
        target: {
          ...base.target,
          get candidateMint() {
            return trap();
          },
        },
      },
      { ...base, target: proxy },
      { ...base, target: revoked.proxy },
      {
        ...base,
        timers: {
          ...base.timers,
          get setTimeout() {
            return trap();
          },
        },
      },
      { ...base, timers: proxy },
      { ...base, timers: { ...base.timers, setTimeout: new Proxy(trap, { apply: trap }) } },
      { ...base, session: proxy },
      { ...base, signal: revoked.proxy },
    ];
    for (const options of bad) {
      const acquisition = new CpmmPoolAccountAcquisition();
      expect(await acquisition.acquire(options as CpmmPoolAccountAcquisitionOptions)).toMatchObject(
        {
          code: "OPTIONS_INVALID",
          exchanges: [],
        },
      );
    }
    expect(trap).not.toHaveBeenCalled();
    expect(base.session.getLedgerLength()).toBe(0);
  });
});
