#!/usr/bin/env node
/**
 * NeXusTrade — Stage A: bounded on-chain precheck for ONE fresh Raydium AMM v4 / WSOL pool.
 *
 * Proposal only: live execution is AWAITING SEPARATE OPERATOR APPROVAL. It names at most one
 * PROVISIONAL target for the single-candidate runner; security and strategy eligibility stay
 * unverified until the runner's own checks.
 *
 * Bounded sample (no discovery loop, no retry, no polling):
 * 1. One `getSignaturesForAddress` on the AMM v4 create-pool fee destination (at most 20).
 * 2. At most two `getTransaction` for the newest successful signatures whose block time passes a
 *    coarse prefilter; each must be the requested signature in a valid JSON-RPC envelope, a
 *    successful transaction, and decode (existing PoolInitializationParser) to exactly one AMM v4
 *    `initialize2` whose account 14 is the fee destination, with the candidate as base (coin) mint
 *    and WSOL as quote (pc) mint — the only orientation the runner supports.
 * 3. One DexScreener GET on the runner's own market endpoint, parsed by the runner's own parser:
 *    REQUIRED. It validates the exact pool, base mint and WSOL quote and supplies `pairCreatedAt`,
 *    the runner's age source, from which the start window is computed.
 * At most 3 Solana RPC requests plus 1 market request, no WebSocket, 2,500 ms Solana pacing,
 * first 429 or any redirect stops, bounded bodies, 30 s absolute deadline (PaperRequestSession).
 *
 * The three time sources are different evidence and are kept apart: the initialization
 * transaction's block time, the instruction-requested open time, and DexScreener's
 * `pairCreatedAt`. Finding nothing establishes only that this bounded sample produced no
 * suitable target. Request failures, unavailable evidence and decoded non-matches are distinct.
 *
 * Default is a dry run (plan only; no configuration, request or file). `--live` dispatches.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  PaperRequestSession,
  type PaperRequestExchangeEvidence,
  type PaperRequestSessionLimits,
  type PaperRequestSessionTimers,
} from "../candidate-scanner/PaperRequestSession.js";
import { isValidSolanaSignature } from "../candidate-scanner/ExactPoolHistoryEnumerator.js";
import { isCanonicalSolanaBase58 } from "../candidate-scanner/LpScreeningBridge.js";
import { parseDexScreenerTokenPairs } from "../candidate-scanner/DexScreenerSingleCandidateMarketParser.js";
import {
  buildEscapedSecretRegex,
  redactSensitiveText,
} from "../candidate-scanner/SolanaTrackerBundlerCaptureTool.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  identifyPoolInitializationInstructions,
  resolveTransactionAccountKeys,
} from "../research/pilot/PoolInitializationParser.js";
import { SolanaRpcTransactionFetcher } from "../research/pilot/SolanaRpcTransactionFetcher.js";
import { WSOL_MINT } from "../research/pilot/RaydiumAmmParser.js";
import { serializeJsonPreservingBigInts } from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import { loadDaemonEnvironment } from "./paper-trading-daemon.js";
import { SINGLE_CANDIDATE_PUBLIC_ENDPOINTS } from "./paper-single-candidate-diagnostic.js";

export const PRECHECK_ROOT_SEGMENTS = ["data", "research", "prechecks"] as const;
export const PRECHECK_APPROVAL_STATUS =
  "LIVE_EXECUTION_AWAITING_SEPARATE_OPERATOR_APPROVAL" as const;

/** Raydium AMM v4 create-pool fee destination (mainnet), `initialize2` account index 14. */
export const RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION =
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5" as const;
export const INITIALIZE2_FEE_DESTINATION_INDEX = 14 as const;
export const FEE_DESTINATION_SOURCE = Object.freeze({
  address: RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
  accountIndex: INITIALIZE2_FEE_DESTINATION_INDEX,
  declaredIn: "https://github.com/raydium-io/raydium-amm/blob/master/program/src/processor.rs",
  accountVector: "https://github.com/raydium-io/raydium-amm/blob/master/program/src/instruction.rs",
  revision:
    "master branch, as cited in the operator review of 2026-11-14; the commit SHA was not retrieved (no network access offline) and must be recorded at review. Every selected transaction re-verifies the address at account index 14.",
});

/** PROPOSED Stage A request limits (not approved). Other lanes are disabled. */
export const PRECHECK_LIMITS: PaperRequestSessionLimits = Object.freeze({
  lifetimeMs: 30_000,
  maxHttpAttempts: 4,
  requestTimeoutMs: 10_000,
  lanes: Object.freeze({
    SOLANA_RPC: Object.freeze({ maxAttempts: 3, pacingMs: 2_500, maxResponseBytes: 1_048_576 }),
    DEXSCREENER: Object.freeze({ maxAttempts: 1, pacingMs: 1_000, maxResponseBytes: 1_048_576 }),
    RUGCHECK: Object.freeze({ maxAttempts: 0, pacingMs: 1_000, maxResponseBytes: 1 }),
    SOLANA_TRACKER: Object.freeze({ maxAttempts: 0, pacingMs: 1_000, maxResponseBytes: 1 }),
  }),
}) as PaperRequestSessionLimits;

export const PRECHECK_SAMPLE = Object.freeze({ maxSignatures: 20, maxTransactions: 2 });

/**
 * PLANNING ESTIMATE, not a guarantee of eligibility: the runner reaches scanner intake roughly
 * 67 s after start and decides at least 5 s apart afterwards, but flow outages, retrievals and
 * refreshes can delay decisions. The runtime maturity checks are authoritative. The window is
 * measured on the runner's own age source (DexScreener `pairCreatedAt`).
 */
export const PLANNING_START_WINDOW = Object.freeze({
  minAgeSec: 240,
  maxAgeSec: 760,
  basis: "DEXSCREENER_PAIR_CREATED_AT (the runner's age source)",
  status: "PLANNING_ESTIMATE: does not guarantee eligibility; runtime maturity checks decide",
});

/** Coarse block-time prefilter for choosing which transactions to retrieve (not the window). */
export const RETRIEVAL_PREFILTER = Object.freeze({
  maxBlockTimeAgeSec: PLANNING_START_WINDOW.maxAgeSec,
  basis: "initialization block time from the signature page (prefilter only)",
});

export type PrecheckPurpose = "PRECHECK_SIGNATURES" | "PRECHECK_TRANSACTION" | "PRECHECK_MARKET";

/** One sealed exchange as the derivation reads it (from the observer, or from the sealed file). */
export interface PrecheckExchange {
  readonly seq: number;
  readonly purpose: string;
  readonly lane: string;
  readonly jsonRpcId: number | string | null;
  readonly request: {
    readonly url: string;
    readonly rpcMethod: string | null;
    readonly rpcParams: unknown;
    readonly [extra: string]: unknown;
  };
  readonly dispatchedAtMs: number;
  readonly completedAtMs: number | null;
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly response: {
    readonly bodyState: string;
    readonly bodyEncoding: string | null;
    readonly bodyRedacted: boolean;
    readonly body: string | null;
    readonly [extra: string]: unknown;
  };
}

export type SignatureStatus =
  | "NOT_RETRIEVED_FAILED_TRANSACTION"
  | "NOT_RETRIEVED_BLOCK_TIME_UNAVAILABLE"
  | "NOT_RETRIEVED_OUTSIDE_PREFILTER"
  | "NOT_RETRIEVED_SAMPLE_BOUND"
  | "NOT_REACHED_AFTER_MATCH"
  | "INVALID_SIGNATURE_RECORD"
  | `REQUEST_FAILED:${string}`
  | `EVIDENCE_UNAVAILABLE:${string}`
  | `DECODED_NONMATCH:${string}`
  | "DECODED_MATCH";

export interface SignatureLedgerEntry {
  readonly index: number;
  readonly signature: string | null;
  readonly slot: number | null;
  readonly signatureBlockTimeSec: number | null;
  readonly blockTimeAgeSecAtPage: number | null;
  readonly status: SignatureStatus;
  readonly exchangeSeq: number | null;
}

export interface PrecheckTarget {
  readonly poolId: string;
  readonly mintAddress: string;
  readonly quoteMint: typeof WSOL_MINT;
  readonly orientation: "CANDIDATE_BASE_WSOL_QUOTE";
  readonly initialization: {
    readonly signature: string;
    readonly slot: number;
    /** Block time of the initialization transaction (getTransaction). */
    readonly transactionBlockTimeSec: number | null;
    /** Block time reported on the signature page. */
    readonly signatureBlockTimeSec: number | null;
    /** open_time requested in the initialize2 instruction bytes. */
    readonly instructionRequestedOpenTimeSec: number | null;
    readonly feeDestination: { readonly accountIndex: 14; readonly address: string };
    readonly exchangeSeq: number;
  };
  readonly market: {
    /** DexScreener pairCreatedAt (the runner's age source). */
    readonly pairCreatedAtMs: number;
    readonly runnerOpenTimeSec: number;
    readonly receivedAtMs: number;
    readonly ageSecAtReceipt: number;
    readonly exchangeSeq: number;
    readonly informationalIndicators: Record<string, unknown>;
  };
  readonly startWindow: {
    readonly basis: string;
    readonly status: string;
    readonly minAgeSec: number;
    readonly maxAgeSec: number;
    readonly opensAtMs: number;
    readonly closesAtMs: number;
    readonly opensAtIso: string;
    readonly closesAtIso: string;
  };
  readonly eligibility: "PROVISIONAL: security and strategy eligibility are unverified";
}

export type PrecheckOutcomeCategory =
  | "TARGET_SELECTED"
  | "SAMPLE_PRODUCED_NO_SUITABLE_TARGET"
  | "REQUEST_FAILED"
  | "EVIDENCE_UNAVAILABLE"
  | "MARKET_EVIDENCE_UNAVAILABLE"
  | "START_WINDOW_ALREADY_CLOSED"
  | "EVIDENCE_INVALID";

export interface PrecheckSelection {
  readonly outcome: PrecheckOutcomeCategory;
  readonly reason: string | null;
  readonly sampleStatement: string;
  readonly signatures: readonly SignatureLedgerEntry[];
  readonly target: PrecheckTarget | null;
}

export type PrecheckNextRequest =
  | { readonly kind: "SIGNATURES" }
  | { readonly kind: "TRANSACTION"; readonly signature: string }
  | { readonly kind: "MARKET"; readonly poolId: string; readonly mintAddress: string }
  | null;

const SAMPLE_STATEMENT =
  "Bounded sample: at most 20 signatures inspected and at most 2 transactions retrieved. A result without a target establishes only that this sample produced no suitable target.";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const safeInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** The JSON body of a completed text exchange, or the reason it cannot be used. */
function usableJson(
  ex: PrecheckExchange,
): { ok: true; json: unknown } | { ok: false; failure: string; kind: "REQUEST" | "EVIDENCE" } {
  if (ex.error !== null) return { ok: false, failure: ex.error, kind: "REQUEST" };
  if (ex.httpStatus !== 200) {
    return { ok: false, failure: `HTTP_${String(ex.httpStatus)}`, kind: "REQUEST" };
  }
  if (ex.response.bodyState !== "COMPLETE" || ex.response.body === null) {
    return { ok: false, failure: "BODY_INCOMPLETE", kind: "EVIDENCE" };
  }
  if (ex.response.bodyEncoding !== "utf8") {
    return { ok: false, failure: "BODY_NOT_TEXT", kind: "EVIDENCE" };
  }
  if (ex.response.bodyRedacted) return { ok: false, failure: "BODY_REDACTED", kind: "EVIDENCE" };
  try {
    return { ok: true, json: JSON.parse(ex.response.body) };
  } catch {
    return { ok: false, failure: "BODY_NOT_JSON", kind: "EVIDENCE" };
  }
}

/** A JSON-RPC 2.0 success envelope for exactly the request that was sent. */
function rpcResult(
  ex: PrecheckExchange,
): { ok: true; result: unknown } | { ok: false; status: SignatureStatus } {
  const body = usableJson(ex);
  if (!body.ok) {
    return {
      ok: false,
      status:
        body.kind === "REQUEST"
          ? `REQUEST_FAILED:${body.failure}`
          : `EVIDENCE_UNAVAILABLE:${body.failure}`,
    };
  }
  const env = body.json;
  if (!isRecord(env) || env.jsonrpc !== "2.0") {
    return { ok: false, status: "EVIDENCE_UNAVAILABLE:RPC_ENVELOPE_INVALID" };
  }
  if (ex.jsonRpcId === null || env.id !== ex.jsonRpcId) {
    return { ok: false, status: "EVIDENCE_UNAVAILABLE:RPC_ID_MISMATCH" };
  }
  if (env.error !== undefined && env.error !== null) {
    return { ok: false, status: "EVIDENCE_UNAVAILABLE:RPC_ERROR" };
  }
  if (!("result" in env)) return { ok: false, status: "EVIDENCE_UNAVAILABLE:RPC_RESULT_MISSING" };
  return { ok: true, result: env.result };
}

interface DecodedInitialization {
  readonly poolId: string;
  readonly mintAddress: string;
  readonly signature: string;
  readonly slot: number;
  readonly transactionBlockTimeSec: number | null;
  readonly instructionRequestedOpenTimeSec: number | null;
}

/** Validates and decodes one sealed getTransaction exchange for the requested signature. */
export function evaluateInitializationExchange(
  ex: PrecheckExchange,
  requested: { readonly signature: string; readonly slot: number },
):
  | { readonly ok: true; readonly init: DecodedInitialization }
  | { readonly ok: false; readonly status: SignatureStatus } {
  const params = ex.request.rpcParams;
  if (
    ex.request.rpcMethod !== "getTransaction" ||
    !Array.isArray(params) ||
    params[0] !== requested.signature
  ) {
    return { ok: false, status: "EVIDENCE_UNAVAILABLE:REQUEST_NOT_FOR_SIGNATURE" };
  }
  const r = rpcResult(ex);
  if (!r.ok) return r;
  const tx = r.result;
  if (tx === null) return { ok: false, status: "EVIDENCE_UNAVAILABLE:TRANSACTION_UNAVAILABLE" };
  if (!isRecord(tx) || !isRecord(tx.transaction) || !isRecord(tx.meta)) {
    return { ok: false, status: "EVIDENCE_UNAVAILABLE:TRANSACTION_MALFORMED" };
  }
  const sigs = tx.transaction.signatures;
  if (!Array.isArray(sigs) || sigs[0] !== requested.signature) {
    return { ok: false, status: "EVIDENCE_UNAVAILABLE:SIGNATURE_MISMATCH" };
  }
  if (tx.slot !== requested.slot)
    return { ok: false, status: "EVIDENCE_UNAVAILABLE:SLOT_MISMATCH" };
  if (tx.meta.err !== null)
    return { ok: false, status: "DECODED_NONMATCH:TRANSACTION_NOT_SUCCESSFUL" };
  const normalized = SolanaRpcTransactionFetcher.parseTransactionResponse(requested.signature, {
    result: tx,
  });
  if (!normalized) return { ok: false, status: "EVIDENCE_UNAVAILABLE:TRANSACTION_UNPARSEABLE" };
  const scan = identifyPoolInitializationInstructions(normalized, ex.completedAtMs ?? 0);
  if (!scan.ok) return { ok: false, status: `DECODED_NONMATCH:${scan.reason}` };
  const amm = scan.events.filter((e) => e.protocol === "RAYDIUM_AMM_V4");
  if (amm.length === 0) return { ok: false, status: "DECODED_NONMATCH:NO_AMM_V4_INITIALIZE2" };
  if (amm.length > 1) return { ok: false, status: "DECODED_NONMATCH:MULTIPLE_AMM_V4_INITIALIZE2" };
  const event = amm[0]!;
  // The instruction's own account reference at index 14 must be the fee destination.
  const keys = resolveTransactionAccountKeys(normalized.accountKeys);
  if (!keys.ok) return { ok: false, status: "EVIDENCE_UNAVAILABLE:ACCOUNT_KEYS_UNRESOLVED" };
  const instruction =
    event.innerInstructionIndex === undefined
      ? normalized.instructions[event.outerInstructionIndex]
      : normalized.innerInstructions?.find((g) => g.index === event.outerInstructionIndex)
          ?.instructions[event.innerInstructionIndex];
  if (!instruction) return { ok: false, status: "EVIDENCE_UNAVAILABLE:INSTRUCTION_NOT_FOUND" };
  if (keys.keys[instruction.programIdIndex] !== RAYDIUM_AMM_V4_PROGRAM_ID) {
    return { ok: false, status: "DECODED_NONMATCH:PROGRAM_NOT_AMM_V4" };
  }
  const feeIndex = instruction.accountKeyIndexes[INITIALIZE2_FEE_DESTINATION_INDEX];
  if (
    feeIndex === undefined ||
    keys.keys[feeIndex] !== RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION
  ) {
    return { ok: false, status: "DECODED_NONMATCH:FEE_DESTINATION_MISMATCH" };
  }
  // Supported orientation only: candidate as coin (base) mint, WSOL as pc (quote) mint.
  const base = event.token0Mint;
  const quote = event.token1Mint;
  if (base === WSOL_MINT && quote === WSOL_MINT) {
    return { ok: false, status: "DECODED_NONMATCH:BOTH_LEGS_WSOL" };
  }
  if (base === WSOL_MINT)
    return { ok: false, status: "DECODED_NONMATCH:UNSUPPORTED_ORIENTATION_WSOL_BASE" };
  if (quote !== WSOL_MINT) return { ok: false, status: "DECODED_NONMATCH:NO_WSOL_QUOTE" };
  if (!isCanonicalSolanaBase58(event.poolId) || !isCanonicalSolanaBase58(base)) {
    return { ok: false, status: "DECODED_NONMATCH:NON_CANONICAL_IDENTITY" };
  }
  return {
    ok: true,
    init: {
      poolId: event.poolId,
      mintAddress: base,
      signature: requested.signature,
      slot: requested.slot,
      transactionBlockTimeSec: safeInt(tx.blockTime) ? tx.blockTime : null,
      instructionRequestedOpenTimeSec: event.instructionRequestedOpenTimeSec,
    },
  };
}

/**
 * Pure derivation from the exchanges so far. Live, it names the next request (or null when the
 * bounded sequence is finished); on sealed evidence (`complete: true`) it re-derives the outcome.
 */
export function derivePrecheckSelection(
  exchanges: readonly PrecheckExchange[],
  options: { readonly complete: boolean },
): { readonly selection: PrecheckSelection; readonly next: PrecheckNextRequest } {
  const done = (
    outcome: PrecheckOutcomeCategory,
    reason: string | null,
    signatures: readonly SignatureLedgerEntry[] = [],
    target: PrecheckTarget | null = null,
  ) => ({
    selection: { outcome, reason, sampleStatement: SAMPLE_STATEMENT, signatures, target },
    next: null,
  });
  const byPurpose = (p: PrecheckPurpose) => exchanges.filter((x) => x.purpose === p);
  const rpcCount = exchanges.filter((x) => x.lane === "SOLANA_RPC").length;
  const marketCount = exchanges.filter((x) => x.lane === "DEXSCREENER").length;
  if (
    rpcCount > 3 ||
    marketCount > 1 ||
    byPurpose("PRECHECK_SIGNATURES").length > 1 ||
    byPurpose("PRECHECK_TRANSACTION").length > PRECHECK_SAMPLE.maxTransactions ||
    exchanges.length !== rpcCount + marketCount
  ) {
    return done("EVIDENCE_INVALID", "REQUEST_BOUND_EXCEEDED");
  }

  // 1. The signature page.
  const page = byPurpose("PRECHECK_SIGNATURES")[0];
  if (!page) {
    return options.complete
      ? done("REQUEST_FAILED", "SIGNATURES_NOT_DISPATCHED")
      : { selection: done("REQUEST_FAILED", "PENDING").selection, next: { kind: "SIGNATURES" } };
  }
  const params = page.request.rpcParams;
  if (
    page.request.rpcMethod !== "getSignaturesForAddress" ||
    !Array.isArray(params) ||
    params[0] !== RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION ||
    !isRecord(params[1]) ||
    params[1].limit !== PRECHECK_SAMPLE.maxSignatures
  ) {
    return done("EVIDENCE_INVALID", "SIGNATURE_REQUEST_NOT_FOR_FEE_DESTINATION");
  }
  const pageResult = rpcResult(page);
  if (!pageResult.ok) {
    const s = pageResult.status;
    return done(s.startsWith("REQUEST_FAILED") ? "REQUEST_FAILED" : "EVIDENCE_UNAVAILABLE", s);
  }
  if (!Array.isArray(pageResult.result)) {
    return done("EVIDENCE_UNAVAILABLE", "EVIDENCE_UNAVAILABLE:SIGNATURE_PAGE_NOT_ARRAY");
  }
  if (pageResult.result.length > PRECHECK_SAMPLE.maxSignatures) {
    return done("EVIDENCE_UNAVAILABLE", "EVIDENCE_UNAVAILABLE:SIGNATURE_PAGE_TOO_LARGE");
  }
  const pageAtSec = Math.floor((page.completedAtMs ?? page.dispatchedAtMs) / 1000);
  const ledger: SignatureLedgerEntry[] = [];
  const eligible: { index: number; signature: string; slot: number }[] = [];
  (pageResult.result as unknown[]).forEach((raw, index) => {
    const rec = isRecord(raw) ? raw : {};
    const signature = isValidSolanaSignature(rec.signature) ? rec.signature : null;
    const slot = safeInt(rec.slot) && rec.slot >= 0 ? rec.slot : null;
    const blockTime =
      rec.blockTime === null ? null : safeInt(rec.blockTime) ? rec.blockTime : undefined;
    const base = {
      index,
      signature,
      slot,
      signatureBlockTimeSec: blockTime ?? null,
      blockTimeAgeSecAtPage: typeof blockTime === "number" ? pageAtSec - blockTime : null,
      exchangeSeq: null,
    };
    if (signature === null || slot === null || blockTime === undefined || !("err" in rec)) {
      ledger.push({ ...base, status: "INVALID_SIGNATURE_RECORD" });
    } else if (rec.err !== null) {
      ledger.push({ ...base, status: "NOT_RETRIEVED_FAILED_TRANSACTION" });
    } else if (blockTime === null) {
      ledger.push({ ...base, status: "NOT_RETRIEVED_BLOCK_TIME_UNAVAILABLE" });
    } else if (
      base.blockTimeAgeSecAtPage! < 0 ||
      base.blockTimeAgeSecAtPage! > RETRIEVAL_PREFILTER.maxBlockTimeAgeSec
    ) {
      ledger.push({ ...base, status: "NOT_RETRIEVED_OUTSIDE_PREFILTER" });
    } else {
      ledger.push({ ...base, status: "NOT_RETRIEVED_SAMPLE_BOUND" }); // provisional; set below
      eligible.push({ index, signature, slot });
    }
  });
  // Newest first (highest slot, then page order); at most two retrievals.
  eligible.sort((a, b) => b.slot - a.slot || a.index - b.index);
  const chosen = eligible.slice(0, PRECHECK_SAMPLE.maxTransactions);
  const txExchanges = byPurpose("PRECHECK_TRANSACTION");
  for (const x of txExchanges) {
    const p = x.request.rpcParams;
    if (!Array.isArray(p) || !chosen.some((c) => c.signature === p[0])) {
      return done("EVIDENCE_INVALID", "TRANSACTION_REQUEST_NOT_IN_SAMPLE", ledger);
    }
  }

  // 2. Retrieved transactions, newest first; stop at the first match.
  let match: DecodedInitialization | null = null;
  let matchSeq = -1;
  let anyRequestFailure = false;
  for (const c of chosen) {
    const entry = ledger[c.index]!;
    if (match) {
      ledger[c.index] = { ...entry, status: "NOT_REACHED_AFTER_MATCH" };
      if (txExchanges.some((x) => (x.request.rpcParams as unknown[])[0] === c.signature)) {
        return done("EVIDENCE_INVALID", "TRANSACTION_RETRIEVED_AFTER_MATCH", ledger);
      }
      continue;
    }
    const ex = txExchanges.find((x) => (x.request.rpcParams as unknown[])[0] === c.signature);
    if (!ex) {
      if (!options.complete) {
        return {
          selection: done("REQUEST_FAILED", "PENDING", ledger).selection,
          next: { kind: "TRANSACTION", signature: c.signature },
        };
      }
      ledger[c.index] = { ...entry, status: "REQUEST_FAILED:NOT_DISPATCHED" };
      anyRequestFailure = true;
      continue;
    }
    const evaluated = evaluateInitializationExchange(ex, c);
    if (evaluated.ok) {
      ledger[c.index] = { ...entry, status: "DECODED_MATCH", exchangeSeq: ex.seq };
      match = evaluated.init;
      matchSeq = ex.seq;
    } else {
      ledger[c.index] = { ...entry, status: evaluated.status, exchangeSeq: ex.seq };
      if (evaluated.status.startsWith("REQUEST_FAILED")) anyRequestFailure = true;
    }
  }
  const marketExchanges = byPurpose("PRECHECK_MARKET");
  if (!match) {
    if (marketExchanges.length > 0) {
      return done("EVIDENCE_INVALID", "MARKET_REQUEST_WITHOUT_MATCH", ledger);
    }
    if (chosen.length === 0) {
      return done(
        "SAMPLE_PRODUCED_NO_SUITABLE_TARGET",
        "NO_RETRIEVABLE_SIGNATURE_IN_SAMPLE",
        ledger,
      );
    }
    // Distinct overall classes: any decoded non-match means the sample was examined and held no
    // suitable target; otherwise the retrievals failed as requests or as evidence.
    const statuses = chosen.map((c) => ledger[c.index]!.status);
    const count = (prefix: string) => statuses.filter((s) => s.startsWith(prefix)).length;
    const reason = `retrieved ${chosen.length}: ${count("DECODED_NONMATCH")} decoded non-match, ${count("EVIDENCE_UNAVAILABLE")} evidence unavailable, ${count("REQUEST_FAILED")} request failed`;
    if (count("DECODED_NONMATCH") > 0) {
      return done("SAMPLE_PRODUCED_NO_SUITABLE_TARGET", reason, ledger);
    }
    return anyRequestFailure && count("EVIDENCE_UNAVAILABLE") === 0
      ? done("REQUEST_FAILED", reason, ledger)
      : done("EVIDENCE_UNAVAILABLE", reason, ledger);
  }

  // 3. The required market check on the runner's own endpoint and parser.
  const market = marketExchanges[0];
  if (!market) {
    if (!options.complete) {
      return {
        selection: done("MARKET_EVIDENCE_UNAVAILABLE", "PENDING", ledger).selection,
        next: { kind: "MARKET", poolId: match.poolId, mintAddress: match.mintAddress },
      };
    }
    return done("MARKET_EVIDENCE_UNAVAILABLE", "MARKET_NOT_DISPATCHED", ledger);
  }
  if (market.request.url !== SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(match.mintAddress)) {
    return done("EVIDENCE_INVALID", "MARKET_REQUEST_NOT_FOR_TARGET", ledger);
  }
  const marketBody = usableJson(market);
  if (!marketBody.ok) return done("MARKET_EVIDENCE_UNAVAILABLE", marketBody.failure, ledger);
  const receivedAtMs = market.completedAtMs ?? market.dispatchedAtMs;
  const parsed = parseDexScreenerTokenPairs(
    marketBody.json,
    { poolId: match.poolId, mintAddress: match.mintAddress },
    receivedAtMs,
  );
  if (!parsed.ok) return done("MARKET_EVIDENCE_UNAVAILABLE", parsed.reason, ledger);
  const pairCreatedAtMs = parsed.provenance.creation.pairCreatedAtMs;
  const runnerOpenTimeSec = parsed.pool.openTimeSec;
  const opensAtMs = (runnerOpenTimeSec + PLANNING_START_WINDOW.minAgeSec) * 1000;
  const closesAtMs = (runnerOpenTimeSec + PLANNING_START_WINDOW.maxAgeSec) * 1000;
  const p = parsed.pool;
  const target: PrecheckTarget = {
    poolId: match.poolId,
    mintAddress: match.mintAddress,
    quoteMint: WSOL_MINT,
    orientation: "CANDIDATE_BASE_WSOL_QUOTE",
    initialization: {
      signature: match.signature,
      slot: match.slot,
      transactionBlockTimeSec: match.transactionBlockTimeSec,
      signatureBlockTimeSec: ledger.find((e) => e.signature === match!.signature)!
        .signatureBlockTimeSec,
      instructionRequestedOpenTimeSec: match.instructionRequestedOpenTimeSec,
      feeDestination: { accountIndex: 14, address: RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION },
      exchangeSeq: matchSeq,
    },
    market: {
      pairCreatedAtMs,
      runnerOpenTimeSec,
      receivedAtMs,
      ageSecAtReceipt: Math.floor(receivedAtMs / 1000) - runnerOpenTimeSec,
      exchangeSeq: market.seq,
      informationalIndicators: {
        note: "Informational only; the runner's scanner and gates decide at runtime.",
        liquidityUsd: p.liquidityUsd,
        marketCapUsd: p.marketCapUsd,
        buys5m: p.buys5m,
        sells5m: p.sells5m,
        volume5mUsd: p.volume5mUsd,
      },
    },
    startWindow: {
      basis: PLANNING_START_WINDOW.basis,
      status: PLANNING_START_WINDOW.status,
      minAgeSec: PLANNING_START_WINDOW.minAgeSec,
      maxAgeSec: PLANNING_START_WINDOW.maxAgeSec,
      opensAtMs,
      closesAtMs,
      opensAtIso: new Date(opensAtMs).toISOString(),
      closesAtIso: new Date(closesAtMs).toISOString(),
    },
    eligibility: "PROVISIONAL: security and strategy eligibility are unverified",
  };
  if (receivedAtMs > closesAtMs) {
    // The candidate's evidence and timestamps are kept, but it is not selected.
    return done("START_WINDOW_ALREADY_CLOSED", "PAIR_CREATED_AT_AGE_BEYOND_WINDOW", ledger, target);
  }
  return done("TARGET_SELECTED", null, ledger, target);
}

// ---------------------------------------------------------------------------------------------
// Sealing (exclusive writes, credential redaction before any encoding, manifest)
// ---------------------------------------------------------------------------------------------

export const PRECHECK_CORE_FILES = [
  "plan.json",
  "request-ledger.json",
  "request-exchanges.json",
  "selection.json",
  "evidence-manifest.json",
] as const;
export const PRECHECK_MANIFEST_KIND = "PAPER_FRESH_AMM_V4_PRECHECK_MANIFEST" as const;
export const PRECHECK_MANIFEST_VERSION = 1 as const;
export const RPC_URL_PLACEHOLDER = "SOLANA_RPC_URL (configuration; not recorded)";
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function secretsFrom(rpcUrl: string): string[] {
  const secrets = new Set<string>([rpcUrl]);
  try {
    const u = new URL(rpcUrl);
    if (u.username) secrets.add(u.username);
    if (u.password) secrets.add(u.password);
    for (const v of u.searchParams.values()) if (v.length >= 6) secrets.add(v);
    for (const seg of u.pathname.split("/")) if (seg.length >= 16) secrets.add(seg);
  } catch {
    // Rejected before use.
  }
  return [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
}

/** Credential redaction on bytes (Latin-1 maps bytes 1:1), applied before text or base64 storage. */
function byteSanitizer(secrets: readonly string[]) {
  const forms = secrets.map((s) => {
    const latin1 = Buffer.from(s, "utf8").toString("latin1");
    let escaped: RegExp | null = null;
    try {
      escaped = buildEscapedSecretRegex(latin1);
    } catch {
      escaped = null;
    }
    return { latin1, escaped };
  });
  return (original: Buffer) => {
    let text = original.toString("latin1");
    for (const f of forms) {
      text = text.split(f.latin1).join("[REDACTED]");
      if (f.escaped) text = text.replace(f.escaped, "[REDACTED]");
    }
    for (const f of forms)
      if (text.includes(f.latin1)) throw new Error("[SEAL_REFUSED] credential bytes");
    const bytes = Buffer.from(text, "latin1");
    const asUtf8 = bytes.toString("utf8");
    const isUtf8 = Buffer.from(asUtf8, "utf8").equals(bytes);
    return {
      redacted: !bytes.equals(original),
      encoding: isUtf8 ? ("utf8" as const) : ("base64" as const),
      stored: isUtf8 ? asUtf8 : bytes.toString("base64"),
    };
  };
}

function precheckWriter(outDir: string, secrets: readonly string[]) {
  const entries: {
    path: string;
    category: "EVIDENCE" | "RESPONSE";
    sha256: string;
    bytes: number;
  }[] = [];
  const redactText = (t: string) => {
    let out = t;
    for (const s of secrets) out = out.split(s).join("[REDACTED]");
    return out;
  };
  const deep = (v: unknown): unknown =>
    typeof v === "string"
      ? redactText(v)
      : Array.isArray(v)
        ? v.map(deep)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).map(([k, x]) => [
                redactText(k),
                deep(x),
              ]),
            )
          : v;
  const write = (rel: string, data: unknown, category: "EVIDENCE" | "RESPONSE") => {
    const content = serializeJsonPreservingBigInts(deep(data));
    for (const s of secrets) {
      if (content.includes(s))
        throw new Error(`[SEAL_REFUSED] a credential would be persisted in ${rel}`);
    }
    writeFileSync(path.join(outDir, ...rel.split("/")), content, { encoding: "utf8", flag: "wx" });
    const meta = {
      path: rel,
      category,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
    };
    entries.push(meta);
    return meta;
  };
  return { entries, write, sanitize: byteSanitizer(secrets), redactText };
}

/** The sealed form of one exchange (also the derivation's input). */
function precheckExchangeRecord(
  e: PaperRequestExchangeEvidence,
  sanitize: ReturnType<typeof byteSanitizer>,
  redactText: (t: string) => string,
): PrecheckExchange & Record<string, unknown> {
  let rpcMethod: string | null = null;
  let rpcParams: unknown = null;
  if (e.requestBody !== null) {
    try {
      const parsed = JSON.parse(e.requestBody) as {
        jsonrpc?: unknown;
        method?: unknown;
        params?: unknown;
      };
      if (parsed.jsonrpc === "2.0") {
        rpcMethod = typeof parsed.method === "string" ? parsed.method : null;
        rpcParams = parsed.params ?? null;
      }
    } catch {
      // Not JSON-RPC.
    }
  }
  const s = e.body === null ? null : sanitize(e.body);
  return {
    kind: "PAPER_PRECHECK_EXCHANGE_EVIDENCE",
    seq: e.entry.seq,
    purpose: e.entry.purpose,
    lane: e.entry.lane,
    owner: e.entry.owner,
    requestedIdentity: e.entry.requestedIdentity,
    jsonRpcId: e.entry.jsonRpcId,
    request: {
      method: e.method,
      url: e.entry.lane === "SOLANA_RPC" ? RPC_URL_PLACEHOLDER : redactText(e.url),
      headersRecorded: false,
      rpcMethod,
      rpcParams,
    },
    dispatchedAtMs: e.entry.dispatchedAtMs,
    completedAtMs: e.entry.completedAtMs,
    httpStatus: e.entry.httpStatus,
    error: e.entry.error,
    response: {
      headers: e.responseHeaders,
      bodyState: e.bodyState,
      completeEvidence: e.bodyState === "COMPLETE",
      retainedBytes: e.body?.length ?? null,
      observedBytes: e.observedBodyBytes,
      maxResponseBytes: e.maxResponseBytes,
      receivedBytesSha256: e.body === null ? null : sha256(e.body),
      bodyEncoding: s?.encoding ?? null,
      bodyRedacted: s?.redacted ?? false,
      reproducesReceivedDigest: e.body !== null && !(s?.redacted ?? false),
      body: s?.stored ?? null,
    },
  };
}

export const precheckExchangePath = (seq: number) =>
  `exchanges/${String(seq).padStart(4, "0")}.json`;

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface FreshPoolPrecheckDeps {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly loadEnvironment?: (() => void) | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly projectRoot?: string | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export interface FreshPoolPrecheckResult {
  readonly mode: "DRY_RUN" | "LIVE";
  readonly planDigestSha256: string;
  readonly outDir?: string | undefined;
  readonly selection?: PrecheckSelection | undefined;
}

export function buildPrecheckPlan(outDirRelative: string, mode: "DRY_RUN" | "LIVE") {
  return {
    kind: "PAPER_FRESH_AMM_V4_PRECHECK_PLAN",
    executionContext: "PAPER_SIMULATION",
    mode,
    approval: PRECHECK_APPROVAL_STATUS,
    outDir: outDirRelative,
    feeDestination: FEE_DESTINATION_SOURCE,
    endpoints: {
      solanaRpc: "SOLANA_RPC_URL (configuration; never printed)",
      market:
        "https://api.dexscreener.com/latest/dex/tokens/<decoded candidate mint> (the runner's endpoint)",
      webSocket: "NONE",
    },
    limits: PRECHECK_LIMITS,
    sample: PRECHECK_SAMPLE,
    retrievalPrefilter: RETRIEVAL_PREFILTER,
    startWindow: PLANNING_START_WINDOW,
    stopConditions: [
      "Sequence complete: target selected, or the bounded sample produced no suitable target",
      "First 429 or any redirect (session stops)",
      "30 s absolute deadline",
      "Request or evidence failure on the signature page or the market check",
    ],
    boundaries: [
      "Read-only: no WebSocket, no transaction signing, no wallet, no daemon",
      "No discovery loop, no retry, no polling; one run per new output directory",
      "A selected target is PROVISIONAL: security and strategy eligibility are unverified",
    ],
  };
}

function cliError(message: string): Error {
  return new Error(`[CLI_INVALID_ARG] ${message}`);
}

export async function runFreshPoolPrecheck(
  rawArgs: readonly string[],
  deps: FreshPoolPrecheckDeps = {},
): Promise<FreshPoolPrecheckResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let values: Record<string, string | boolean | undefined>;
  let tokens: readonly { kind: string; name?: string }[] = [];
  try {
    ({ values, tokens = [] } = parseArgs({
      args: [...rawArgs],
      options: { "out-dir": { type: "string" }, live: { type: "boolean" } },
      strict: true,
      tokens: true,
    }));
  } catch (err) {
    throw cliError(err instanceof Error ? err.message : String(err));
  }
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== "option" || t.name === undefined) continue;
    if (seen.has(t.name)) throw cliError(`--${t.name} may be given only once`);
    seen.add(t.name);
  }
  const rawOut = typeof values["out-dir"] === "string" ? values["out-dir"] : "";
  if (rawOut === "") throw cliError("--out-dir is required (a new directory)");
  const projectRoot = path.resolve(deps.projectRoot ?? findWorkspaceRoot());
  const root = path.join(projectRoot, ...PRECHECK_ROOT_SEGMENTS);
  const outDir = path.resolve(projectRoot, rawOut);
  const rel = path.relative(root, outDir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw cliError(`--out-dir must be a new directory inside ${PRECHECK_ROOT_SEGMENTS.join("/")}/`);
  }
  if (existsSync(outDir)) {
    throw new Error(
      `[OUTPUT_EXISTS] ${path.relative(projectRoot, outDir)} already exists; refusing to overwrite`,
    );
  }
  const mode = values.live === true ? "LIVE" : "DRY_RUN";
  const plan = buildPrecheckPlan(path.relative(projectRoot, outDir).replace(/\\/g, "/"), mode);
  const planJson = serializeJsonPreservingBigInts(plan);
  const planDigestSha256 = sha256(planJson);
  if (mode === "DRY_RUN") {
    log("[DRY_RUN] No configuration loaded, no request sent, nothing written.");
    log(`[DRY_RUN] Live execution: ${PRECHECK_APPROVAL_STATUS}`);
    log(`[DRY_RUN] Plan digest (sha256): ${planDigestSha256}`);
    log(planJson);
    return { mode, planDigestSha256 };
  }

  (deps.loadEnvironment ?? loadDaemonEnvironment)();
  const env = deps.env ?? process.env;
  const rpcUrl = env.SOLANA_RPC_URL ?? "";
  if (!/^https?:\/\//i.test(rpcUrl)) {
    throw new Error(
      "[MISSING_CONFIGURATION] SOLANA_RPC_URL (http or https) is required for --live",
    );
  }
  const secrets = secretsFrom(rpcUrl);
  const redact = (t: string) => redactSensitiveText(t, secrets);
  const out = (line: string) => log(redact(line));
  try {
    out(`[LIVE] ${PRECHECK_APPROVAL_STATUS}`);
    out(`[LIVE] Plan digest (sha256): ${planDigestSha256}`);
    mkdirSync(path.dirname(outDir), { recursive: true });
    mkdirSync(outDir);
    mkdirSync(path.join(outDir, "exchanges"));
    const writer = precheckWriter(outDir, secrets);
    writer.write("plan.json", plan, "EVIDENCE");
    const exchanges: PrecheckExchange[] = [];
    const captureFailures: string[] = [];
    const session = new PaperRequestSession({
      executionContext: "PAPER_SIMULATION",
      fetchFn: deps.fetchFn ?? globalThis.fetch,
      limits: PRECHECK_LIMITS,
      clock: deps.clock,
      timers: deps.timers,
      onExchangeComplete: (e) => {
        try {
          const record = precheckExchangeRecord(e, writer.sanitize, writer.redactText);
          writer.write(precheckExchangePath(e.entry.seq), record, "RESPONSE");
          exchanges.push(record);
        } catch (err) {
          captureFailures.push(redact(err instanceof Error ? err.message : String(err)));
        }
      },
    });
    session.open();
    const rpc = (purpose: PrecheckPurpose, identity: string, method: string, params: unknown[]) => {
      const id = session.nextJsonRpcId();
      return session.dispatch({
        lane: "SOLANA_RPC",
        owner: "SECURITY",
        purpose,
        requestedIdentity: identity,
        url: rpcUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        jsonRpcId: id,
      });
    };
    // The bounded sequence: at most 4 steps, each named by the pure derivation.
    let stoppedBy: string | null = null;
    for (let step = 0; step < 4; step++) {
      const { next } = derivePrecheckSelection(exchanges, { complete: false });
      if (next === null) break;
      const exchange =
        next.kind === "SIGNATURES"
          ? await rpc(
              "PRECHECK_SIGNATURES",
              RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
              "getSignaturesForAddress",
              [
                RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
                { limit: PRECHECK_SAMPLE.maxSignatures, commitment: "confirmed" },
              ],
            )
          : next.kind === "TRANSACTION"
            ? await rpc("PRECHECK_TRANSACTION", next.signature, "getTransaction", [
                next.signature,
                { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
              ])
            : await session.dispatch({
                lane: "DEXSCREENER",
                owner: "SPOT",
                purpose: "PRECHECK_MARKET",
                requestedIdentity: next.mintAddress,
                url: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(next.mintAddress),
                method: "GET",
                headers: { Accept: "application/json" },
              });
      if (!exchange.dispatched) {
        stoppedBy = exchange.error ?? "NOT_DISPATCHED";
        break;
      }
    }
    session.stop("PRECHECK_COMPLETE");
    const { selection } = derivePrecheckSelection(exchanges, { complete: true });
    const status = session.getStatus();
    writer.write("request-ledger.json", status, "EVIDENCE");
    writer.write(
      "request-exchanges.json",
      {
        exchanges: [...exchanges]
          .sort((a, b) => a.seq - b.seq)
          .map((x) => ({ seq: x.seq, file: precheckExchangePath(x.seq), purpose: x.purpose })),
        missingExchangeSeqs: status.ledger
          .map((e) => e.seq)
          .filter((s) => !exchanges.some((x) => x.seq === s)),
        captureFailures,
        stoppedBy,
      },
      "EVIDENCE",
    );
    writer.write("selection.json", selection, "EVIDENCE");
    const manifest = {
      kind: PRECHECK_MANIFEST_KIND,
      manifestVersion: PRECHECK_MANIFEST_VERSION,
      planDigestSha256,
      approval: PRECHECK_APPROVAL_STATUS,
      outcome: selection.outcome,
      files: [...writer.entries].sort((a, b) => a.path.localeCompare(b.path)),
    };
    const manifestMeta = writer.write("evidence-manifest.json", manifest, "EVIDENCE");
    out(`[LIVE] Outcome: ${selection.outcome}${selection.reason ? ` (${selection.reason})` : ""}`);
    if (selection.target) {
      out(
        `[LIVE] PROVISIONAL target: pool ${selection.target.poolId} mint ${selection.target.mintAddress}; start window (planning estimate, pairCreatedAt basis) ${selection.target.startWindow.opensAtIso} .. ${selection.target.startWindow.closesAtIso}`,
      );
    }
    out(
      `[LIVE] Evidence sealed: ${path.relative(projectRoot, outDir)} (manifest sha256 ${manifestMeta.sha256})`,
    );
    return { mode, planDigestSha256, outDir, selection };
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err)));
  }
}

if (process.argv[1] && process.argv[1].endsWith("fresh-amm-v4-precheck.ts")) {
  runFreshPoolPrecheck(process.argv.slice(2))
    .then((r) => {
      if (r.mode === "LIVE") process.exit(r.selection?.outcome === "TARGET_SELECTED" ? 0 : 3);
    })
    .catch((err: unknown) => {
      console.error(
        "[FRESH_AMM_V4_PRECHECK_ERROR]",
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    });
}
