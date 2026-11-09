/**
 * PAPER failed-transaction validation and adapter opt-in (offline, synthetic).
 *
 * All transactions, signatures, slots, and times are SYNTHETIC. No network, sockets, or captures are used:
 * the adapter receives an injected in-memory transport and a synthetic clock.
 */
import { describe, it, expect } from "vitest";
import {
  PAPER_FAILED_TRANSACTION_POLICY,
  validateFailedTransactionEvidence,
  validateSolanaTransactionError,
} from "./ValidatedFailedTransactionEvidence.js";
import { RaydiumAmmV4TransactionSourceAdapter } from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import { CAPTURED_RAY_WSOL_IDENTITIES } from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import {
  buildSyntheticFailedTransactionResult,
  buildSyntheticSwapTransactionResult,
  SYNTHETIC_FAILED_TRANSACTION_ERROR,
} from "./fixtures/SyntheticRaydiumSwapTransactionFixture.js";

const WSOL = "So11111111111111111111111111111111111111112";
const POOL: TrackedRaydiumPoolContext = Object.freeze({
  poolId: CAPTURED_RAY_WSOL_IDENTITIES.poolId,
  candidateTokenMint: CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!,
  quoteTokenMint: WSOL,
  baseVault: CAPTURED_RAY_WSOL_IDENTITIES.baseVault,
  quoteVault: CAPTURED_RAY_WSOL_IDENTITIES.quoteVault,
  baseMint: CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!,
  quoteMint: WSOL,
  orientation: "TOKEN_BASE_SOL_QUOTE",
});

// SYNTHETIC signatures (valid Base58, 64 bytes)
const SIG =
  "QHREMqhWG7eahNuQ2EzQqSYKLy8WH9jVerfLRJTttyPorHxQJDzMMcB1142poqJHzYyVSsijoS1U9222QBV6AbM";
const OTHER_SIG =
  "3aFt8NNc96JF5yMrpTToPy22vaANB9pc41ih3jc93jGonfarwpokoEu9BnF6nWKytqgDWCyBB92fqBMsGWSyvDmu";
const SLOT = 461_970_850;
const BLOCK_TIME = 1_791_930_950;

type Payload = Record<string, unknown> & {
  slot: unknown;
  blockTime: unknown;
  version?: unknown;
  transaction: { signatures: unknown[]; message: Record<string, unknown> };
  meta: Record<string, unknown> | null;
};

const failedPayload = (err?: unknown): Payload =>
  JSON.parse(
    JSON.stringify(
      buildSyntheticFailedTransactionResult({
        poolContext: POOL,
        signature: SIG,
        slot: SLOT,
        blockTime: BLOCK_TIME,
        ...(err !== undefined ? { err } : {}),
      }),
    ),
  ) as Payload;

const validate = (payload: unknown, extra: Record<string, unknown> = {}) =>
  validateFailedTransactionEvidence({
    payload,
    expectedSignature: SIG,
    poolContext: POOL,
    ...extra,
  });

describe("validateSolanaTransactionError (recognized representations only)", () => {
  it("accepts recognized unit, InstructionError, DuplicateInstruction, and account-index variants", () => {
    const accepted: unknown[] = [
      "InsufficientFundsForFee",
      "BlockhashNotFound",
      { InstructionError: [0, { Custom: 30 }] },
      { InstructionError: [0, { Custom: 4_294_967_295 }] },
      { InstructionError: [1, "InvalidAccountData"] },
      { InstructionError: [0, { BorshIoError: "legacy detail" }] },
      { DuplicateInstruction: 0 },
      { InsufficientFundsForRent: { account_index: 3 } },
      { ProgramExecutionTemporarilyRestricted: { account_index: 0 } },
    ];
    for (const err of accepted) {
      const r = validateSolanaTransactionError(err, { instructionCount: 2, accountCount: 10 });
      expect(r.ok, JSON.stringify(err)).toBe(true);
    }
  });

  it("rejects arbitrary strings/objects, empty objects, and malformed InstructionError values", () => {
    const rejected: unknown[] = [
      null,
      undefined,
      "",
      "SomethingWentWrong",
      5,
      true,
      [],
      ["InstructionError", 0],
      {},
      { foo: 1 },
      { InstructionError: [0, { Custom: 30 }], DuplicateInstruction: 0 },
      { InstructionError: [0] },
      { InstructionError: [0, { Custom: 30 }, 1] },
      { InstructionError: [-1, { Custom: 30 }] },
      { InstructionError: [2, { Custom: 30 }] }, // out of range for 2 outer instructions
      { InstructionError: [0.5, { Custom: 30 }] },
      { InstructionError: ["0", { Custom: 30 }] },
      { InstructionError: [0, {}] },
      { InstructionError: [0, { Custom: -1 }] },
      { InstructionError: [0, { Custom: 1.5 }] },
      { InstructionError: [0, { Custom: 4_294_967_296 }] },
      { InstructionError: [0, { Custom: "30" }] },
      { InstructionError: [0, "NotARealInstructionError"] },
      { InstructionError: [0, { Custom: 30, Extra: 1 }] },
      { InstructionError: [0, { Unsupported: 1 }] },
      { InstructionError: [0, null] },
      { DuplicateInstruction: 9 },
      { InsufficientFundsForRent: {} },
      { InsufficientFundsForRent: { account_index: 99 } },
      { InsufficientFundsForRent: { account_index: 1, extra: 2 } },
      { AccountInUse: null }, // unit variants serialize as strings, not objects
    ];
    for (const err of rejected) {
      const r = validateSolanaTransactionError(err, { instructionCount: 2, accountCount: 10 });
      expect(r.ok, JSON.stringify(err) ?? String(err)).toBe(false);
    }
  });
});

describe("validateFailedTransactionEvidence (decoder TRANSACTION_FAILED alone is insufficient)", () => {
  it("accepts a complete, explicitly failed, candidate-bound transaction with distinct classification", () => {
    const r = validate(failedPayload());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.policy).toBe(PAPER_FAILED_TRANSACTION_POLICY);
    expect(r.value.classification).toBe("KNOWN_FAILED_TRANSACTION_ZERO_COMMITTED_SWAPS");
    expect(r.value.committedSwapCount).toBe(0);
    expect(r.value.decoderReason).toBe("TRANSACTION_FAILED");
    expect(r.value.decoderMessage).toContain(SIG);
    expect(r.value.slot).toBe(SLOT);
    expect(r.value.blockTime).toBe(BLOCK_TIME);
    expect(r.value.onChainError).toEqual(SYNTHETIC_FAILED_TRANSACTION_ERROR);
    expect(r.value.onChainErrorVariant).toBe("InstructionError");
    expect(Object.isFrozen(r.value.onChainError)).toBe(true);
  });

  it("accepts the deprecated meta.status only when it agrees; absent status is allowed", () => {
    const noStatus = failedPayload();
    delete noStatus.meta!.status;
    expect(validate(noStatus).ok).toBe(true);
  });

  it("rejects missing, null, malformed, unsupported, or contradictory error metadata", () => {
    const cases: Array<[string, (p: Payload) => void]> = [
      ["missing err", (p) => delete p.meta!.err],
      ["err null (successful)", (p) => (p.meta!.err = null)],
      ["meta null", (p) => (p.meta = null)],
      ["meta missing", (p) => delete (p as Record<string, unknown>).meta],
      ["empty object err", (p) => ((p.meta!.err = {}), (p.meta!.status = { Err: {} }))],
      ["arbitrary string err", (p) => ((p.meta!.err = "boom"), (p.meta!.status = { Err: "boom" }))],
      [
        "malformed InstructionError",
        (p) => {
          const e = { InstructionError: [0, { Custom: -4 }] };
          p.meta!.err = e;
          p.meta!.status = { Err: e };
        },
      ],
      [
        "instruction index beyond outer instructions",
        (p) => {
          const e = { InstructionError: [1, { Custom: 30 }] };
          p.meta!.err = e;
          p.meta!.status = { Err: e };
        },
      ],
      ["status Ok contradicts err", (p) => (p.meta!.status = { Ok: null })],
      [
        "status Err differs from err",
        (p) => (p.meta!.status = { Err: { InstructionError: [0, { Custom: 31 }] } }),
      ],
      ["status malformed", (p) => (p.meta!.status = "Err")],
    ];
    for (const [label, mutate] of cases) {
      const p = failedPayload();
      mutate(p);
      const r = validate(p);
      expect(r.ok, label).toBe(false);
    }
  });

  it("rejects identity, timestamp, version, structure, and pool-binding defects", () => {
    const cases: Array<[string, (p: Payload) => void, Record<string, unknown>?]> = [
      ["signature mismatch", (p) => (p.transaction.signatures = [OTHER_SIG])],
      ["invalid signature encoding", (p) => (p.transaction.signatures = ["not-a-signature"])],
      ["header signer count mismatch", (p) => (p.transaction.signatures = [SIG, OTHER_SIG])],
      ["missing header", (p) => delete p.transaction.message.header],
      ["missing blockTime", (p) => (p.blockTime = null)],
      ["zero blockTime", (p) => (p.blockTime = 0)],
      ["fractional blockTime", (p) => (p.blockTime = BLOCK_TIME + 0.5)],
      ["invalid slot", (p) => (p.slot = -1)],
      ["unsupported version", (p) => (p.version = 2)],
      ["malformed instruction", (p) => (p.transaction.message.instructions = [{ data: "x" }])],
      [
        "instruction account index out of range",
        (p) =>
          (p.transaction.message.instructions = [
            { programIdIndex: 17, accounts: [99], data: "x" },
          ]),
      ],
      ["no instructions", (p) => (p.transaction.message.instructions = [])],
      [
        "pool not referenced",
        (p) => {
          const keys = p.transaction.message.accountKeys as string[];
          keys[1] = "ForeignPoo1111111111111111111111111111111111";
        },
      ],
      [
        "duplicate account keys",
        (p) => {
          const keys = p.transaction.message.accountKeys as string[];
          keys[3] = keys[2]!;
        },
      ],
      ["slot contradicts notification", () => undefined, { expectedSlot: SLOT + 1 }],
      [
        "blockTime contradicts notification",
        () => undefined,
        { expectedBlockTime: BLOCK_TIME + 1 },
      ],
    ];
    for (const [label, mutate, extra] of cases) {
      const p = failedPayload();
      mutate(p);
      expect(validate(p, extra).ok, label).toBe(false);
    }
  });

  it("never reclassifies a successful swap or a successful zero-swap transaction", () => {
    const swap = buildSyntheticSwapTransactionResult({
      poolContext: POOL,
      signature: SIG,
      slot: SLOT,
      blockTime: BLOCK_TIME,
      side: "BUY",
    });
    expect(validate(swap).ok).toBe(false);
  });
});

describe("RaydiumAmmV4TransactionSourceAdapter PAPER failed-transaction opt-in (synthetic transport)", () => {
  const T0 = BLOCK_TIME * 1000 + 500;

  function setup(params: { payload: unknown; policy?: unknown; responseId?: unknown }) {
    const requests: string[] = [];
    const transport: typeof fetch = async (_input, init) => {
      requests.push(typeof init?.body === "string" ? init.body : "");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: params.responseId === undefined ? 1 : params.responseId,
          result: params.payload,
        }),
        { status: 200 },
      );
    };
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 14,
      maxEnrichmentAttempts: 14,
      minReservedForwardRequests: 0,
      minProviderSpacingMs: 2500,
      clock: () => T0,
    });
    const tracker = new RollingTradeFlowTracker({
      poolId: POOL.poolId,
      tokenMint: POOL.candidateTokenMint,
      clock: () => T0,
    });
    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: POOL,
      rpcUrl: "https://mock-solana-rpc.internal",
      budgetManager,
      transport,
      clock: () => T0,
      sleepFn: async () => undefined,
      ...(params.policy !== undefined
        ? { paperFailedTransactionPolicy: params.policy as never }
        : {}),
    });
    return { adapter, tracker, budgetManager, requests };
  }

  const POLICY = { enabled: true, executionContext: "PAPER_SIMULATION" } as const;

  it("opted in: a validated failed transaction is KNOWN_FAILED_TRANSACTION with zero swaps and no loss gap", async () => {
    const { adapter, tracker, budgetManager, requests } = setup({
      payload: failedPayload(),
      policy: POLICY,
    });
    const res = await adapter.processNotification(SIG, tracker);
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("KNOWN_FAILED_TRANSACTION");
    expect(res.ingestedEventsCount).toBe(0);
    expect(res.diagnostics.decodedEventsCount).toBe(0);
    expect(res.diagnostics.decodedEvents).toBeUndefined();
    expect(res.diagnostics.responseBody).toContain("InstructionError");
    expect(res.diagnostics.knownFailedTransaction?.decoderReason).toBe("TRANSACTION_FAILED");
    expect(res.diagnostics.knownFailedTransaction?.onChainError).toEqual(
      SYNTHETIC_FAILED_TRANSACTION_ERROR,
    );
    expect(tracker.getRecordedGaps()).toHaveLength(0);
    expect(tracker.getEventsCount()).toBe(0);
    // The retrieval still consumed exactly one HTTP attempt against the shared budget.
    expect(requests).toHaveLength(1);
    expect(res.diagnostics.httpAttempts).toBe(1);
    expect(budgetManager.getTotalRequests()).toBe(1);
  });

  it("default (no opt-in): the same failed transaction keeps DECODE_FAILED and its loss gap", async () => {
    const { adapter, tracker, budgetManager } = setup({ payload: failedPayload() });
    const res = await adapter.processNotification(SIG, tracker);
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("DECODE_FAILED");
    expect(res.diagnostics.knownFailedTransaction).toBeUndefined();
    expect(res.diagnostics.error).toMatch(/TRANSACTION_FAILED/);
    expect(tracker.getRecordedGaps()).toHaveLength(1);
    expect(budgetManager.getTotalRequests()).toBe(1);
  });

  it("opted in: unvalidated failures stay DECODE_FAILED with a loss gap and the rejection reason", async () => {
    const malformed = failedPayload();
    malformed.meta!.err = { InstructionError: [0, {}] };
    malformed.meta!.status = { Err: { InstructionError: [0, {}] } };
    const missingTime = failedPayload();
    missingTime.blockTime = null;
    const stripped = failedPayload();
    delete stripped.meta!.err;
    for (const [label, payload] of [
      ["malformed InstructionError", malformed],
      ["missing blockTime", missingTime],
      ["missing err", stripped],
    ] as const) {
      const { adapter, tracker } = setup({ payload, policy: POLICY });
      const res = await adapter.processNotification(SIG, tracker);
      expect(res.outcome, label).toBe("DECODE_FAILED");
      expect(res.ok, label).toBe(false);
      expect(tracker.getRecordedGaps(), label).toHaveLength(1);
    }
    const { adapter, tracker } = setup({ payload: malformed, policy: POLICY });
    const res = await adapter.processNotification(SIG, tracker);
    expect(res.diagnostics.error).toContain("failed-transaction evidence rejected");
  });

  it("opted in: response id, signature, slot and blockTime contradictions fail before classification", async () => {
    const idMismatch = setup({ payload: failedPayload(), policy: POLICY, responseId: 2 });
    const r1 = await idMismatch.adapter.processNotification(SIG, idMismatch.tracker);
    expect(r1.outcome).toBe("MALFORMED_RESPONSE");

    const sigPayload = failedPayload();
    sigPayload.transaction.signatures = [OTHER_SIG];
    const sigMismatch = setup({ payload: sigPayload, policy: POLICY });
    const r2 = await sigMismatch.adapter.processNotification(SIG, sigMismatch.tracker);
    expect(r2.outcome).toBe("RESPONSE_SIGNATURE_MISMATCH");

    const slotCase = setup({ payload: failedPayload(), policy: POLICY });
    const r3 = await slotCase.adapter.processNotification(
      { signature: SIG, slot: SLOT + 1 },
      slotCase.tracker,
    );
    expect(r3.outcome).toBe("CONTRADICTORY_METADATA");

    const timeCase = setup({ payload: failedPayload(), policy: POLICY });
    const r4 = await timeCase.adapter.processNotification(
      { signature: SIG, blockTime: BLOCK_TIME + 1 },
      timeCase.tracker,
    );
    expect(r4.outcome).toBe("CONTRADICTORY_METADATA");

    for (const r of [r1, r2, r3, r4]) {
      expect(r.ok).toBe(false);
      expect(r.diagnostics.knownFailedTransaction).toBeUndefined();
    }
    for (const c of [idMismatch, sigMismatch, slotCase, timeCase]) {
      expect(c.tracker.getRecordedGaps()).toHaveLength(1);
    }
  });

  it("opted in: exhausted budget denies the retrieval before dispatch; nothing is classified", async () => {
    const { adapter, tracker, budgetManager, requests } = setup({
      payload: failedPayload(),
      policy: POLICY,
    });
    // Exhaust the unchanged 14-request ceiling with properly paced earlier attempts.
    for (let i = 0; i < 14; i++) {
      budgetManager.recordRequestAttempt(
        "SOLANA_RPC",
        "CANDIDATE_ENRICHMENT",
        T0 - (14 - i) * 3_000,
      );
    }
    expect(budgetManager.getTotalRequests()).toBe(14);
    const res = await adapter.processNotification(SIG, tracker);
    expect(res.outcome).toBe("PRE_DISPATCH_BUDGET_DENIED");
    expect(requests).toHaveLength(0);
    expect(res.diagnostics.knownFailedTransaction).toBeUndefined();
  });

  it("rejects a policy outside PAPER or malformed at construction (production/daemon unchanged)", () => {
    for (const policy of [
      { enabled: true, executionContext: "PRODUCTION" },
      { enabled: false, executionContext: "PAPER_SIMULATION" },
      { executionContext: "BACKTEST" },
      true,
      null,
    ]) {
      expect(() => setup({ payload: failedPayload(), policy }), JSON.stringify(policy)).toThrow(
        /paperFailedTransactionPolicy/,
      );
    }
    expect(() =>
      setup({ payload: failedPayload(), policy: { enabled: true, executionContext: "BACKTEST" } }),
    ).not.toThrow();
  });
});
