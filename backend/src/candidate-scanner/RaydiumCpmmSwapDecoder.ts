/**
 * Pure, offline Raydium CPMM swap decoder (assessment §8.38.17, items 8–10).
 *
 * Decodes `swap_base_input` / `swap_base_output` invocations of the Raydium CPMM program
 * against one verified pool (the Stage 1 adapter's `RaydiumCpmmPoolStateSuccess`) from a
 * `getTransaction` response in `encoding: "json"` (legacy, v0, or v1 when the caller's request
 * policy allowed it; see "Transaction versions" below). It performs no network,
 * RPC, timer, clock, wallet or filesystem access, and is not connected to flow tracking,
 * admission or any failed-transaction (zero-swap) policy.
 *
 * Evidence rules:
 *  - Executed amounts come only from the two direct-child SPL Token `TransferChecked`
 *    invocations of each target swap frame, located by an exact call-tree reconstruction from
 *    `stackHeight`. Instruction parameters and token balances are never used as amounts.
 *  - A failed CPI cannot be caught (the transaction fails), so `meta.err === null` proves that
 *    every recorded invocation completed. Logs are optional corroboration: they can contradict
 *    (refusal) but never establish execution or amounts.
 *  - Timestamps come only from a valid integer `blockTime` (`ON_CHAIN_BLOCK_TIME`). There is no
 *    provenance override, rounding, clock or default: receipt time is a required injected input.
 *  - Results are never partial: one refused target swap refuses the whole transaction.
 *
 * Sources (versioned):
 *  - Raydium CP-Swap b3187ae53a1b95a201f855a59024a12ca8f5b51a: swap_base_input.rs,
 *    swap_base_output.rs, utils/token.rs, states/events.rs, lib.rs.
 *  - Anchor v1.0.2 (the pinned dependency): lang/attribute/event (`emit!` = `sol_log_data` of the
 *    discriminator and Borsh fields) and spl/src/token_2022.rs (`transfer_checked`, no multisig).
 *  - SPL Token program@v9.0.0 (dfb260231c761be7d9c8b63728e770a102b86495),
 *    interface/src/instruction.rs: `TransferChecked` packs tag 12, u64 LE amount, u8 decimals;
 *    accounts [source, mint, destination, authority].
 *  - Solana documentation (solana-foundation/solana-com 319da217d17c9de427f83718da23c154bbd5b6c4):
 *    core/cpi (privilege rules, stack depth), rpc/http/gettransaction (fields), and the
 *    solana-cpi `invoke` documentation (a failed callee fails the whole transaction).
 *  Deployed-bytecode correspondence is not verified.
 *
 * Transaction versions (`SOLANA_TRANSACTION_VERSION_SOURCE_REFERENCES`, pinned):
 *  - The response's `version` must be present and one of `"legacy"`, `0` or `1`, and must not
 *    exceed the request policy's `maxSupportedTransactionVersion` (option; default `0`, the
 *    historical policy, under which v1 is refused exactly as before). Agave's `validate_version`
 *    returns v1 only when the request allowed it, so a v1 body under a cap of 0 contradicts the
 *    request and is refused (UNSUPPORTED_TRANSACTION_VERSION). Any other value is refused.
 *  - v1 (SIMD-0385) has static accounts only: `addressTableLookups` must be absent (Agave omits
 *    it) and `meta.loadedAddresses`, if present, must be empty, as for legacy. Agave serializes
 *    `transactionConfig` only for v1, as an object with exactly four keys whose unset values are
 *    JSON `null`; legacy and v0 messages must not carry the key at all.
 *  - Protocol constraints (SIMD-0385, `SOLANA_V1_PROTOCOL_LIMITS`): at most 12 signatures, 64
 *    static accounts, 64 instructions, 255 accounts per instruction and 4,096 serialized bytes
 *    (recomputed exactly from the JSON fields and the SIMD-0385 wire layout); a heap size, when
 *    set, is a 1 KiB multiple in [32 KiB, 256 KiB]; u32 fields are in [0, 2^32 - 1]. Violations
 *    are INVALID_PAYLOAD. The reference SDK sanitizer (solana-sdk 7b382f65) does not itself
 *    enforce the 64/12/4,096/heap bounds; this decoder applies the SIMD's stated rules and fails
 *    closed on a body that breaks them.
 *  - Application limit (narrower supported subset): `priorityFee` is a u64 on chain, but only
 *    values that survive JSON parsing exactly (at most Number.MAX_SAFE_INTEGER) are accepted;
 *    larger values are EVIDENCE_LIMIT_EXCEEDED, never rounded. CPMM_DECODER_LIMITS apply as well.
 *  - ComputeBudgetProgram instructions in a v1 message are configuration no-ops (SIMD-0385); they
 *    are ordinary non-CPMM instructions to this decoder and need no special handling.
 */

import { PublicKey } from "@solana/web3.js";
import { decodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import { isCanonicalSolanaBase58 } from "../research/pilot/RaydiumAmmParser.js";
import {
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
} from "../research/pilot/RaydiumCpmmParser.js";
import { isValidSolanaSignature } from "./ExactPoolHistoryEnumerator.js";
import type { RaydiumCpmmPoolStateSuccess } from "./RaydiumCpmmPoolStateAdapter.js";
import type { TradeEvent, TradeSide } from "./RollingTradeFlowTracker.js";

export {
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
};

// ---------------------------------------------------------------------------------------------
// Constants and pure-decoder policies
// ---------------------------------------------------------------------------------------------

export const RAYDIUM_CPMM_SOURCE_COMMIT = "b3187ae53a1b95a201f855a59024a12ca8f5b51a";
export const RAYDIUM_CPMM_SWAP_SOURCE_REFERENCES = Object.freeze({
  swapBaseInput: `https://github.com/raydium-io/raydium-cp-swap/blob/${RAYDIUM_CPMM_SOURCE_COMMIT}/programs/cp-swap/src/instructions/swap_base_input.rs`,
  swapBaseOutput: `https://github.com/raydium-io/raydium-cp-swap/blob/${RAYDIUM_CPMM_SOURCE_COMMIT}/programs/cp-swap/src/instructions/swap_base_output.rs`,
  tokenHelpers: `https://github.com/raydium-io/raydium-cp-swap/blob/${RAYDIUM_CPMM_SOURCE_COMMIT}/programs/cp-swap/src/utils/token.rs`,
  events: `https://github.com/raydium-io/raydium-cp-swap/blob/${RAYDIUM_CPMM_SOURCE_COMMIT}/programs/cp-swap/src/states/events.rs`,
  anchorEmit:
    "https://github.com/solana-foundation/anchor/blob/v1.0.2/lang/attribute/event/src/lib.rs",
  anchorTransferChecked:
    "https://github.com/solana-foundation/anchor/blob/v1.0.2/spl/src/token_2022.rs",
  splTokenTransferChecked:
    "https://github.com/solana-program/token/blob/dfb260231c761be7d9c8b63728e770a102b86495/interface/src/instruction.rs",
});

/** sha256("global:swap_base_input")[0..8] */
export const CPMM_SWAP_BASE_INPUT_DISCRIMINATOR = Object.freeze([
  0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde,
]);
/** sha256("global:swap_base_output")[0..8] */
export const CPMM_SWAP_BASE_OUTPUT_DISCRIMINATOR = Object.freeze([
  0x37, 0xd9, 0x62, 0x56, 0xa3, 0x4a, 0xb4, 0xad,
]);
/** sha256("event:SwapEvent")[0..8] */
export const CPMM_SWAP_EVENT_DISCRIMINATOR = Object.freeze([
  0x40, 0xc6, 0xcd, 0xe8, 0x26, 0x08, 0x71, 0xe2,
]);
export const CPMM_SWAP_EVENT_LENGTH = 170;
export const SPL_TOKEN_TRANSFER_CHECKED_TAG = 12;

/**
 * Pure-decoder input bounds (decoder policy, not runtime facts; acquisition limits are separate).
 * Exceeding any bound refuses the transaction with EVIDENCE_LIMIT_EXCEEDED before further decoding.
 */
export const CPMM_DECODER_LIMITS = Object.freeze({
  maxAccountKeys: 256,
  maxTopLevelInstructions: 64,
  maxInnerInstructions: 1_024,
  maxInstructionAccounts: 256,
  /** Encoded base58 string length checked before decoding (base58 decoding is quadratic). */
  maxInstructionDataChars: 14_000,
  /** Decoded bytes: the documented maximum CPI instruction data (10 KiB). */
  maxInstructionDataBytes: 10_240,
  maxLogLines: 10_000,
  /** Cumulative UTF-8 bytes of all log lines. */
  maxLogBytes: 1_048_576,
  /** Documented maximum instruction stack height with SIMD-0268 (5 without it). */
  maxStackHeight: 9,
});

/**
 * Primary specification and source revisions for transaction-version handling (pinned commits).
 * SIMD-0385's revision is the latest commit touching the proposal ("Mark SIMDs as Activated").
 */
export const SOLANA_TRANSACTION_VERSION_SOURCE_REFERENCES = Object.freeze({
  simd0385:
    "https://github.com/solana-foundation/solana-improvement-documents/blob/6cc17538e26601e65beca89bbfa761e755720956/proposals/0385-transaction-v1.md",
  agaveUiRawMessage:
    "https://github.com/anza-xyz/agave/blob/318c00ca5aab27ad348e19f7a0c3c3ae7f229ed6/transaction-status-client-types/src/lib.rs",
  agaveValidateVersion:
    "https://github.com/anza-xyz/agave/blob/318c00ca5aab27ad348e19f7a0c3c3ae7f229ed6/transaction-status/src/lib.rs",
  agaveUnsupportedVersionError:
    "https://github.com/anza-xyz/agave/blob/318c00ca5aab27ad348e19f7a0c3c3ae7f229ed6/rpc-client-api/src/custom_error.rs",
  sdkTransactionVersion:
    "https://github.com/anza-xyz/solana-sdk/blob/7b382f65da053cb91e7debc912aaf969a01a5859/transaction/src/versioned/mod.rs",
  sdkV1Message:
    "https://github.com/anza-xyz/solana-sdk/blob/7b382f65da053cb91e7debc912aaf969a01a5859/message/src/versions/v1/mod.rs",
  sdkV1Config:
    "https://github.com/anza-xyz/solana-sdk/blob/7b382f65da053cb91e7debc912aaf969a01a5859/message/src/versions/v1/config.rs",
});

/** Transaction versions this decoder can read (the request policy may allow fewer). */
export type CpmmTransactionVersion = "legacy" | 0 | 1;
/** The `maxSupportedTransactionVersion` values a request policy may use. */
export type CpmmMaxSupportedTransactionVersion = 0 | 1;

/** SIMD-0385 protocol constraints for v1 transactions (not application limits). */
export const SOLANA_V1_PROTOCOL_LIMITS = Object.freeze({
  maxTransactionBytes: 4_096,
  maxSignatures: 12,
  maxStaticAccounts: 64,
  maxInstructions: 64,
  maxAccountsPerInstruction: 255,
  minHeapSizeBytes: 32 * 1024,
  maxHeapSizeBytes: 256 * 1024,
  heapSizeGranularityBytes: 1_024,
  maxU32: 0xffff_ffff,
  /** VersionByte, LegacyHeader (3), TransactionConfigMask (u32), LifetimeSpecifier, two u8 counts. */
  fixedHeaderBytes: 1 + 3 + 4 + 32 + 1 + 1,
  /** (ProgramAccountIndex u8, NumInstructionAccounts u8, NumInstructionDataBytes u16). */
  instructionHeaderBytes: 4,
  /** Priority fee occupies two 4-byte ConfigValues slots (both mask bits 0 and 1). */
  priorityFeeConfigBytes: 8,
  u32ConfigBytes: 4,
});

/** The exact `UiTransactionConfig` keys Agave serializes (camelCase, no skipped fields). */
export const SOLANA_V1_TRANSACTION_CONFIG_KEYS = Object.freeze([
  "priorityFee",
  "computeUnitLimit",
  "loadedAccountsDataSizeLimit",
  "heapSize",
] as const);

/** blockTime (seconds) for which blockTime * 1000 is still a safe integer. */
export const MAX_BLOCK_TIME_SEC = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

export interface DecodeCpmmSwapOptions {
  /** Host receipt time in integer milliseconds; required (the decoder has no clock). */
  readonly receiptTimestampMs: number;
  /**
   * The `maxSupportedTransactionVersion` the request carried (0 or 1). Omitted means 0, the
   * historical policy: legacy and v0 only. A response version above it contradicts the request.
   */
  readonly maxSupportedTransactionVersion?: CpmmMaxSupportedTransactionVersion;
}

/**
 * CORROBORATED: complete logs agree with the trace. UNAVAILABLE: no logs. INCOMPLETE: logs that
 * are truncated or unbalanced (not used). NOT_EVALUATED: the target-pool-not-referenced shortcut,
 * where logs are only checked for bounds and recorded failures.
 */
export type CpmmLogCorroboration = "CORROBORATED" | "UNAVAILABLE" | "INCOMPLETE" | "NOT_EVALUATED";

export interface CpmmDecodeDiagnostics {
  readonly topLevelInstructions: number;
  readonly innerInstructions: number;
  readonly cpmmInvocations: number;
  readonly targetSwaps: number;
  readonly nonTargetSwaps: number;
  readonly otherCpmmInstructions: number;
  readonly logCorroboration: CpmmLogCorroboration;
  readonly shortcut: "TARGET_POOL_NOT_REFERENCED" | null;
}

export type CpmmUnresolvedReason =
  | "INVALID_PAYLOAD"
  | "INVALID_OPTIONS"
  | "INVALID_POOL_CONTEXT"
  | "INVALID_RECEIPT_TIMESTAMP"
  | "MISSING_SIGNATURE"
  | "INVALID_SLOT"
  | "METADATA_UNAVAILABLE"
  | "UNSUPPORTED_ENCODING"
  | "UNSUPPORTED_TRANSACTION_VERSION"
  | "MALFORMED_ACCOUNT_KEYS"
  | "INNER_INSTRUCTIONS_UNAVAILABLE"
  | "UNSUPPORTED_CALL_TREE"
  | "MALFORMED_INSTRUCTION_DATA"
  | "EVIDENCE_LIMIT_EXCEEDED"
  | "MISSING_UPSTREAM_TIMESTAMP"
  | "INVALID_UPSTREAM_TIMESTAMP"
  | "UNSUPPORTED_INSTRUCTION"
  | "UNSUPPORTED_ACCOUNT_COUNT"
  | "UNSUPPORTED_TOKEN_PROGRAM"
  | "IDENTITY_MISMATCH"
  | "VAULT_MISMATCH"
  | "MINT_MISMATCH"
  | "CONFLICTING_EVIDENCE";

export type CpmmConflictDetail =
  | "PAYER_NOT_MESSAGE_SIGNER"
  | "SWAP_FRAME_SHAPE_INVALID"
  | "TRANSFER_BINDING_INVALID"
  | "AMOUNT_PARAMETER_MISMATCH"
  | "USER_ACCOUNT_INVALID"
  | "LOG_TRACE_MISMATCH"
  | "EVENT_MISMATCH"
  | "FAILED_LOG_IN_SUCCESSFUL_TRANSACTION";

export interface CpmmSwapDecodedResult {
  readonly ok: true;
  readonly status: "SWAP_DECODED";
  readonly signature: string;
  readonly slot: number;
  readonly events: readonly TradeEvent[];
  readonly diagnostics: CpmmDecodeDiagnostics;
}

export interface CpmmNoMatchingSwapsResult {
  readonly ok: true;
  readonly status: "NO_MATCHING_SWAPS";
  readonly signature: string;
  readonly slot: number;
  readonly events: readonly [];
  readonly diagnostics: CpmmDecodeDiagnostics;
}

/** A recorded on-chain failure. Not zero-swap evidence: no failed-transaction policy uses it. */
export interface CpmmTransactionFailedResult {
  readonly ok: false;
  readonly status: "TRANSACTION_FAILED";
  readonly signature: string;
  readonly slot: number;
  readonly events: readonly [];
}

export interface CpmmUnresolvedResult {
  readonly ok: false;
  readonly status: "UNRESOLVED_EVIDENCE";
  readonly reason: CpmmUnresolvedReason;
  readonly detail: string | null;
  readonly message: string;
  readonly signature?: string | undefined;
  readonly slot?: number | undefined;
  readonly events: readonly [];
}

export type DecodeRaydiumCpmmTransactionResult =
  | CpmmSwapDecodedResult
  | CpmmNoMatchingSwapsResult
  | CpmmTransactionFailedResult
  | CpmmUnresolvedResult;

// ---------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------

class Refusal extends Error {
  constructor(
    readonly reason: CpmmUnresolvedReason,
    readonly detail: string | null,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (reason: CpmmUnresolvedReason, detail: string | null, message: string): never => {
  throw new Refusal(reason, detail, message);
};
const conflict = (detail: CpmmConflictDetail, message: string): never =>
  refuse("CONFLICTING_EVIDENCE", detail, message);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isSafeIndex = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const bytesEqual = (a: Uint8Array, offset: number, b: readonly number[]) =>
  b.every((x, i) => a[offset + i] === x);
const readU64 = (d: Uint8Array, offset: number): bigint =>
  Buffer.from(d.buffer, d.byteOffset, d.byteLength).readBigUInt64LE(offset);
const pubkeyAt = (d: Uint8Array, offset: number): string =>
  new PublicKey(d.subarray(offset, offset + 32)).toBase58();

// ---------------------------------------------------------------------------------------------
// Pool context (consistent with the Stage 1 adapter's bounds)
// ---------------------------------------------------------------------------------------------

interface PoolView {
  readonly poolAddress: string;
  readonly candidateMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly mintOfVault: ReadonlyMap<string, string>;
  readonly decimalsOfMint: ReadonlyMap<string, number>;
}

function validatePool(pool: unknown): PoolView {
  const bad = (m: string): never => refuse("INVALID_POOL_CONTEXT", null, m);
  if (!isPlainObject(pool) || pool.ok !== true) bad("pool context must be an adapter success");
  const p = pool as unknown as RaydiumCpmmPoolStateSuccess;
  for (const [name, v] of [
    ["poolAddress", p.poolAddress],
    ["candidateMint", p.candidateMint],
    ["baseVaultAddress", p.baseVaultAddress],
    ["quoteVaultAddress", p.quoteVaultAddress],
  ] as const) {
    if (!isCanonicalSolanaBase58(v)) bad(`${name} is not a canonical address`);
  }
  if (p.wsolMint !== WSOL_MINT) bad("wsolMint must be canonical WSOL");
  if (p.candidateMint === WSOL_MINT) bad("candidateMint cannot be WSOL");
  const identities = [
    p.poolAddress,
    p.candidateMint,
    WSOL_MINT,
    p.baseVaultAddress,
    p.quoteVaultAddress,
  ];
  if (new Set(identities).size !== identities.length) bad("pool identities must be distinct");
  if (p.orientation !== "TOKEN_0_BASE_WSOL_QUOTE" && p.orientation !== "TOKEN_1_BASE_WSOL_QUOTE") {
    bad("unknown orientation");
  }
  if (!Number.isInteger(p.baseDecimals) || p.baseDecimals < 0 || p.baseDecimals > 18) {
    bad("baseDecimals must be an integer from 0 to 18");
  }
  if (p.quoteDecimals !== 9) bad("quoteDecimals must be exactly 9");
  const v = (p as { verification?: unknown }).verification;
  if (
    !isPlainObject(v) ||
    v.ownerVerified !== true ||
    v.vaultAuthoritiesVerified !== true ||
    v.tokenProgramsVerified !== true ||
    v.authBumpVerified !== true
  ) {
    bad("pool verification flags must all be true");
  }
  return {
    poolAddress: p.poolAddress,
    candidateMint: p.candidateMint,
    baseVault: p.baseVaultAddress,
    quoteVault: p.quoteVaultAddress,
    mintOfVault: new Map([
      [p.baseVaultAddress, p.candidateMint],
      [p.quoteVaultAddress, WSOL_MINT],
    ]),
    decimalsOfMint: new Map([
      [p.candidateMint, p.baseDecimals],
      [WSOL_MINT, 9],
    ]),
  };
}

// ---------------------------------------------------------------------------------------------
// Envelope, account resolution and compiled instructions
// ---------------------------------------------------------------------------------------------

interface ResolvedMessage {
  readonly accounts: readonly string[];
  readonly numRequiredSignatures: number;
}

/** Empty `meta.loadedAddresses` (or none) for a message without address table lookups. */
function requireNoLoadedAddresses(loaded: unknown, detail: string, label: string): void {
  if (loaded === undefined || loaded === null) return;
  if (
    !isPlainObject(loaded) ||
    !Array.isArray(loaded.writable) ||
    !Array.isArray(loaded.readonly) ||
    loaded.writable.length !== 0 ||
    loaded.readonly.length !== 0
  ) {
    refuse("MALFORMED_ACCOUNT_KEYS", detail, `${label} message with loaded addresses`);
  }
}

interface V1Config {
  /** Serialized ConfigValues bytes implied by the non-null fields (mask popcount x 4). */
  readonly configBytes: number;
}

/**
 * The v1 `transactionConfig` (Agave `UiTransactionConfig`): a plain object with exactly the four
 * documented keys, each `null` (mask bit unset) or a valid value for its field.
 */
function validateV1TransactionConfig(raw: unknown): V1Config {
  const P = SOLANA_V1_PROTOCOL_LIMITS;
  const bad = (m: string): never => refuse("INVALID_PAYLOAD", "TRANSACTION_CONFIG", m);
  if (!isPlainObject(raw)) return bad("v1 transactionConfig must be an object");
  const c = raw as Record<string, unknown>;
  const keys = Object.keys(c);
  if (
    keys.length !== SOLANA_V1_TRANSACTION_CONFIG_KEYS.length ||
    !SOLANA_V1_TRANSACTION_CONFIG_KEYS.every((k) => hasOwn(c, k))
  ) {
    bad("v1 transactionConfig must have exactly the four documented keys");
  }
  let configBytes = 0;
  const fee = c.priorityFee;
  if (fee !== null) {
    if (typeof fee !== "number" || !Number.isInteger(fee) || fee < 0) {
      bad("priorityFee must be null or a non-negative integer");
    }
    if (!Number.isSafeInteger(fee)) {
      refuse(
        "EVIDENCE_LIMIT_EXCEEDED",
        "TRANSACTION_CONFIG_UNSAFE_INTEGER",
        "priorityFee exceeds the exactly representable range (application limit)",
      );
    }
    configBytes += P.priorityFeeConfigBytes;
  }
  for (const k of ["computeUnitLimit", "loadedAccountsDataSizeLimit", "heapSize"] as const) {
    const v = c[k];
    if (v === null) continue;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > P.maxU32) {
      bad(`${k} must be null or a u32`);
    }
    configBytes += P.u32ConfigBytes;
  }
  const heap = c.heapSize;
  if (
    heap !== null &&
    ((heap as number) % P.heapSizeGranularityBytes !== 0 ||
      (heap as number) < P.minHeapSizeBytes ||
      (heap as number) > P.maxHeapSizeBytes)
  ) {
    bad("heapSize must be a 1 KiB multiple in [32 KiB, 256 KiB]");
  }
  return { configBytes };
}

function resolveAccounts(
  message: Record<string, unknown>,
  meta: Record<string, unknown>,
  version: CpmmTransactionVersion,
  signatures: readonly unknown[],
): ResolvedMessage & { readonly v1: V1Config | null } {
  const L = CPMM_DECODER_LIMITS;
  const P = SOLANA_V1_PROTOCOL_LIMITS;
  // transactionConfig is serialized for v1 only (Agave omits it for legacy and v0).
  let v1: V1Config | null = null;
  if (version === 1) {
    if (!hasOwn(message, "transactionConfig")) {
      refuse("INVALID_PAYLOAD", "TRANSACTION_CONFIG", "v1 message lacks transactionConfig");
    }
    v1 = validateV1TransactionConfig(message.transactionConfig);
  } else if (hasOwn(message, "transactionConfig")) {
    refuse(
      "INVALID_PAYLOAD",
      "TRANSACTION_CONFIG_FORBIDDEN",
      "transactionConfig is only defined for v1 messages",
    );
  }
  const keys = message.accountKeys;
  if (!Array.isArray(keys)) refuse("INVALID_PAYLOAD", null, "message.accountKeys must be an array");
  const staticKeys = keys as unknown[];
  if (version === 1 && staticKeys.length > P.maxStaticAccounts) {
    refuse("INVALID_PAYLOAD", "V1_ACCOUNT_KEYS", "v1 allows at most 64 static accounts");
  }
  if (staticKeys.length > L.maxAccountKeys) {
    refuse("EVIDENCE_LIMIT_EXCEEDED", "ACCOUNT_KEYS", "too many static account keys");
  }
  for (const k of staticKeys) {
    if (typeof k !== "string") {
      refuse("UNSUPPORTED_ENCODING", "ACCOUNT_KEY_NOT_STRING", 'only encoding "json" is supported');
    }
  }
  const header = message.header;
  if (!isPlainObject(header)) refuse("MALFORMED_ACCOUNT_KEYS", "HEADER", "message.header missing");
  const h = header as Record<string, unknown>;
  const req = h.numRequiredSignatures;
  const roSigned = h.numReadonlySignedAccounts;
  const roUnsigned = h.numReadonlyUnsignedAccounts;
  if (
    !isSafeIndex(req) ||
    !isSafeIndex(roSigned) ||
    !isSafeIndex(roUnsigned) ||
    req < 1 ||
    req > staticKeys.length ||
    roSigned >= req ||
    roUnsigned > staticKeys.length - req
  ) {
    refuse("MALFORMED_ACCOUNT_KEYS", "HEADER", "message.header is inconsistent");
  }
  if (signatures.length !== req || !signatures.every((s) => isValidSolanaSignature(s))) {
    refuse("INVALID_PAYLOAD", "SIGNATURES", "signatures must match numRequiredSignatures");
  }
  if (version === 1 && (req as number) > P.maxSignatures) {
    refuse("INVALID_PAYLOAD", "V1_SIGNATURES", "v1 allows at most 12 signatures");
  }
  let writable: unknown[] = [];
  let readonly: unknown[] = [];
  const loaded = meta.loadedAddresses;
  const lookups = message.addressTableLookups;
  if (version === "legacy") {
    if (lookups !== undefined) {
      refuse("MALFORMED_ACCOUNT_KEYS", "LEGACY_LOOKUPS", "legacy message carries lookups");
    }
    requireNoLoadedAddresses(loaded, "LEGACY_LOADED", "legacy");
  } else if (version === 1) {
    // SIMD-0385: no address lookup tables; Agave omits the key (never null or []).
    if (hasOwn(message, "addressTableLookups")) {
      refuse("MALFORMED_ACCOUNT_KEYS", "V1_LOOKUPS", "v1 message carries addressTableLookups");
    }
    requireNoLoadedAddresses(loaded, "V1_LOADED", "v1");
  } else {
    if (!Array.isArray(lookups)) {
      refuse("MALFORMED_ACCOUNT_KEYS", "V0_LOOKUPS", "v0 message lacks addressTableLookups");
    }
    let w = 0;
    let r = 0;
    for (const lk of lookups as unknown[]) {
      if (
        !isPlainObject(lk) ||
        !isCanonicalSolanaBase58(lk.accountKey) ||
        !Array.isArray(lk.writableIndexes) ||
        !Array.isArray(lk.readonlyIndexes) ||
        ![...lk.writableIndexes, ...lk.readonlyIndexes].every((x) => isSafeIndex(x) && x <= 255)
      ) {
        refuse("MALFORMED_ACCOUNT_KEYS", "V0_LOOKUPS", "malformed address table lookup");
      }
      w += (lk as { writableIndexes: unknown[] }).writableIndexes.length;
      r += (lk as { readonlyIndexes: unknown[] }).readonlyIndexes.length;
      if (staticKeys.length + w + r > L.maxAccountKeys) {
        refuse("EVIDENCE_LIMIT_EXCEEDED", "ACCOUNT_KEYS", "too many account keys");
      }
    }
    if (
      !isPlainObject(loaded) ||
      !Array.isArray(loaded.writable) ||
      !Array.isArray(loaded.readonly) ||
      loaded.writable.length !== w ||
      loaded.readonly.length !== r
    ) {
      refuse("MALFORMED_ACCOUNT_KEYS", "V0_LOADED", "loadedAddresses do not match the lookups");
    }
    writable = (loaded as { writable: unknown[] }).writable;
    readonly = (loaded as { readonly: unknown[] }).readonly;
  }
  const all = [...staticKeys, ...writable, ...readonly];
  for (const k of all) {
    if (!isCanonicalSolanaBase58(k)) {
      refuse("MALFORMED_ACCOUNT_KEYS", "KEY", "account key is not a canonical address");
    }
  }
  if (new Set(all).size !== all.length) {
    refuse("MALFORMED_ACCOUNT_KEYS", "DUPLICATE", "duplicate account key");
  }
  return { accounts: all as string[], numRequiredSignatures: req as number, v1 };
}

/**
 * SIMD-0385 instruction constraints and the exact serialized size of a v1 transaction, from its
 * JSON fields: fixed header, 32 bytes per static address, the ConfigValues implied by the non-null
 * config fields, a 4-byte header plus account indexes and data per instruction, 64 bytes per
 * signature. JSON encoding carries no wire bytes, so this recomputation is the size check.
 */
function checkV1Size(
  top: readonly CompiledInstruction[],
  staticAccounts: number,
  signatures: number,
  v1: V1Config,
): void {
  const P = SOLANA_V1_PROTOCOL_LIMITS;
  let bytes = P.fixedHeaderBytes + 32 * staticAccounts + v1.configBytes + 64 * signatures;
  for (const ix of top) {
    if (ix.accountIndexes.length > P.maxAccountsPerInstruction) {
      refuse(
        "INVALID_PAYLOAD",
        "V1_INSTRUCTION_ACCOUNTS",
        "v1 allows 255 accounts per instruction",
      );
    }
    bytes += P.instructionHeaderBytes + ix.accountIndexes.length + ix.data.length;
  }
  if (bytes > P.maxTransactionBytes) {
    refuse("INVALID_PAYLOAD", "V1_TRANSACTION_SIZE", "v1 transaction exceeds 4,096 bytes");
  }
}

interface CompiledInstruction {
  readonly programId: string;
  readonly accountIndexes: readonly number[];
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
  readonly stackHeight: number | null;
}

function parseInstruction(
  raw: unknown,
  accounts: readonly string[],
  where: string,
  inner: boolean,
): CompiledInstruction {
  const L = CPMM_DECODER_LIMITS;
  if (!isPlainObject(raw)) refuse("INVALID_PAYLOAD", where, `${where} is not an object`);
  const ix = raw as Record<string, unknown>;
  if (hasOwn(ix, "parsed") || hasOwn(ix, "programId") || typeof ix.data !== "string") {
    refuse("UNSUPPORTED_ENCODING", where, `${where}: only compiled "json" instructions`);
  }
  const data = ix.data as string;
  if (data.length > L.maxInstructionDataChars) {
    refuse("EVIDENCE_LIMIT_EXCEEDED", where, `${where}: encoded data too long`);
  }
  if (!Array.isArray(ix.accounts)) {
    refuse("MALFORMED_INSTRUCTION_DATA", where, `${where}: accounts must be an array`);
  }
  const idx = ix.accounts as unknown[];
  if (idx.length > L.maxInstructionAccounts) {
    refuse("EVIDENCE_LIMIT_EXCEEDED", where, `${where}: too many accounts`);
  }
  if (!isSafeIndex(ix.programIdIndex) || ix.programIdIndex >= accounts.length) {
    refuse("MALFORMED_INSTRUCTION_DATA", where, `${where}: programIdIndex out of range`);
  }
  for (const a of idx) {
    if (!isSafeIndex(a) || a >= accounts.length) {
      refuse("MALFORMED_INSTRUCTION_DATA", where, `${where}: account index out of range`);
    }
  }
  const sh = ix.stackHeight;
  let stackHeight: number | null = null;
  if (inner) {
    if (!isSafeIndex(sh) || sh < 2 || sh > L.maxStackHeight) {
      refuse("UNSUPPORTED_CALL_TREE", where, `${where}: stackHeight must be an integer 2..9`);
    }
    stackHeight = sh as number;
  } else if (sh !== undefined && sh !== null && sh !== 1) {
    refuse("UNSUPPORTED_CALL_TREE", where, `${where}: top-level stackHeight must be 1`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(decodeBase58(data));
  } catch {
    return refuse("MALFORMED_INSTRUCTION_DATA", where, `${where}: data is not base58`);
  }
  if (bytes.length > L.maxInstructionDataBytes) {
    refuse("EVIDENCE_LIMIT_EXCEEDED", where, `${where}: decoded data too long`);
  }
  const accountIndexes = idx as number[];
  return {
    programId: accounts[ix.programIdIndex as number] as string,
    accountIndexes,
    accounts: accountIndexes.map((i) => accounts[i] as string),
    data: bytes,
    stackHeight,
  };
}

// ---------------------------------------------------------------------------------------------
// Call tree
// ---------------------------------------------------------------------------------------------

interface TraceNode {
  readonly outer: number;
  readonly pos: number;
  readonly height: number;
  readonly ix: CompiledInstruction;
  readonly children: TraceNode[];
  descendants: number;
}

/** Rebuilds the ordered call tree of one outer instruction from preorder positions and heights. */
function buildTree(outer: number, top: CompiledInstruction, inner: readonly CompiledInstruction[]) {
  const nodes: TraceNode[] = [{ outer, pos: 0, height: 1, ix: top, children: [], descendants: 0 }];
  inner.forEach((ix, k) =>
    nodes.push({
      outer,
      pos: k + 1,
      height: ix.stackHeight as number,
      ix,
      children: [],
      descendants: 0,
    }),
  );
  const stack: TraceNode[] = [nodes[0] as TraceNode];
  for (const n of nodes.slice(1)) {
    while ((stack[stack.length - 1] as TraceNode).height >= n.height) stack.pop();
    const parent = stack[stack.length - 1] as TraceNode;
    if (n.height !== parent.height + 1) {
      refuse(
        "UNSUPPORTED_CALL_TREE",
        `instruction ${outer} inner ${n.pos - 1}`,
        `stackHeight ${n.height} skips a level under height ${parent.height}`,
      );
    }
    parent.children.push(n);
    stack.push(n);
  }
  for (let i = 0; i < nodes.length; i++) {
    let j = i + 1;
    while (j < nodes.length && (nodes[j] as TraceNode).height > (nodes[i] as TraceNode).height) j++;
    (nodes[i] as TraceNode).descendants = j - i - 1;
  }
  return nodes;
}

// ---------------------------------------------------------------------------------------------
// Target swap validation
// ---------------------------------------------------------------------------------------------

interface TargetSwap {
  readonly node: TraceNode;
  readonly baseInput: boolean;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: bigint;
  readonly outAmount: bigint;
}

function decodeTransferChecked(
  child: TraceNode,
  expect: {
    readonly program: string;
    readonly source: string;
    readonly mint: string;
    readonly destination: string;
    readonly authority: string;
    readonly decimals: number;
  },
  label: string,
): bigint {
  const ix = child.ix;
  const bad = (why: string): never =>
    conflict(
      "TRANSFER_BINDING_INVALID",
      `${label} transfer at instruction ${child.outer} position ${child.pos}: ${why}`,
    );
  if (ix.programId !== expect.program) bad("program is not the swap's token program");
  if (ix.data.length !== 10 || ix.data[0] !== SPL_TOKEN_TRANSFER_CHECKED_TAG) {
    bad("not a 10-byte TransferChecked");
  }
  if (ix.accounts.length !== 4) bad("TransferChecked must have exactly 4 accounts");
  const [source, mint, destination, authority] = ix.accounts;
  if (source !== expect.source) bad("source mismatch");
  if (mint !== expect.mint) bad("mint mismatch");
  if (destination !== expect.destination) bad("destination mismatch");
  if (authority !== expect.authority) bad("authority mismatch");
  if (ix.data[9] !== expect.decimals) bad("decimals mismatch");
  const amount = readU64(ix.data, 1);
  if (amount === 0n) bad("zero amount");
  return amount;
}

function validateTargetSwap(
  node: TraceNode,
  baseInput: boolean,
  pool: PoolView,
  numRequiredSignatures: number,
): TargetSwap {
  const ix = node.ix;
  const at = `instruction ${node.outer} position ${node.pos}`;
  if (ix.data.length !== 24) {
    refuse("MALFORMED_INSTRUCTION_DATA", at, `${at}: swap data must be exactly 24 bytes`);
  }
  if (ix.accounts.length !== 13) {
    refuse("UNSUPPORTED_ACCOUNT_COUNT", at, `${at}: target swap must have exactly 13 accounts`);
  }
  const a = ix.accounts as readonly string[];
  if (a[1] !== RAYDIUM_CPMM_AUTHORITY) {
    refuse("IDENTITY_MISMATCH", at, `${at}: account 1 is not the CPMM authority`);
  }
  for (const i of [8, 9]) {
    if (a[i] === TOKEN_2022_PROGRAM_ID) {
      refuse("UNSUPPORTED_TOKEN_PROGRAM", at, `${at}: Token-2022 is not supported`);
    }
    if (a[i] !== SPL_TOKEN_PROGRAM_ID) {
      refuse("IDENTITY_MISMATCH", at, `${at}: account ${i} is not SPL Token`);
    }
  }
  const inVault = a[6] as string;
  const outVault = a[7] as string;
  if (inVault === outVault || !pool.mintOfVault.has(inVault) || !pool.mintOfVault.has(outVault)) {
    refuse("VAULT_MISMATCH", at, `${at}: vaults are not the pool's two distinct vaults`);
  }
  const inMint = a[10] as string;
  const outMint = a[11] as string;
  if (inMint !== pool.mintOfVault.get(inVault) || outMint !== pool.mintOfVault.get(outVault)) {
    refuse("MINT_MISMATCH", at, `${at}: mints do not match their vaults`);
  }
  const userIn = a[4] as string;
  const userOut = a[5] as string;
  if (userIn === userOut || pool.mintOfVault.has(userIn) || pool.mintOfVault.has(userOut)) {
    conflict("USER_ACCOUNT_INVALID", `${at}: user token accounts must be distinct non-vaults`);
  }
  if (node.height === 1 && (ix.accountIndexes[0] as number) >= numRequiredSignatures) {
    conflict("PAYER_NOT_MESSAGE_SIGNER", `${at}: top-level payer is not a message signer`);
  }
  // Routed swaps: the caller supplies the payer's signer flag (pass-through or its own PDA);
  // it is not visible in the JSON and is not checked.
  if (node.children.length !== 2 || node.descendants !== 2) {
    conflict(
      "SWAP_FRAME_SHAPE_INVALID",
      `${at}: a swap frame must have exactly two direct-child transfers and no other descendants`,
    );
  }
  const [c0, c1] = node.children as [TraceNode, TraceNode];
  const inAmount = decodeTransferChecked(
    c0,
    {
      program: a[8] as string,
      source: userIn,
      mint: inMint,
      destination: inVault,
      authority: a[0] as string,
      decimals: pool.decimalsOfMint.get(inMint) as number,
    },
    "input",
  );
  const outAmount = decodeTransferChecked(
    c1,
    {
      program: a[9] as string,
      source: outVault,
      mint: outMint,
      destination: userOut,
      authority: RAYDIUM_CPMM_AUTHORITY,
      decimals: pool.decimalsOfMint.get(outMint) as number,
    },
    "output",
  );
  const p1 = readU64(ix.data, 8);
  const p2 = readU64(ix.data, 16);
  if (baseInput) {
    if (inAmount !== p1 || outAmount < p2) {
      conflict(
        "AMOUNT_PARAMETER_MISMATCH",
        `${at}: transfers contradict amount_in / minimum_amount_out`,
      );
    }
  } else if (outAmount !== p2 || inAmount > p1) {
    conflict("AMOUNT_PARAMETER_MISMATCH", `${at}: transfers contradict max_amount_in / amount_out`);
  }
  return { node, baseInput, inputMint: inMint, outputMint: outMint, inAmount, outAmount };
}

// ---------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------

const B58 = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const INVOKE = new RegExp(`^Program (${B58}) invoke \\[(\\d+)\\]$`);
const SUCCESS = new RegExp(`^Program (${B58}) success$`);
const FAILED = new RegExp(`^Program ${B58} failed(?:: .*)?$`);
const DATA = /^Program data: (.*)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validates the log bounds and refuses a recorded failure in a successful transaction. */
function checkLogs(logs: unknown): readonly string[] | null {
  if (logs === undefined || logs === null) return null;
  if (!Array.isArray(logs)) refuse("INVALID_PAYLOAD", "LOGS", "logMessages must be an array");
  const lines = logs as unknown[];
  if (lines.length > CPMM_DECODER_LIMITS.maxLogLines) {
    refuse("EVIDENCE_LIMIT_EXCEEDED", "LOG_LINES", "too many log lines");
  }
  let bytes = 0;
  for (const l of lines) {
    if (typeof l !== "string") refuse("INVALID_PAYLOAD", "LOGS", "log lines must be strings");
    bytes += Buffer.byteLength(l as string, "utf8");
    if (bytes > CPMM_DECODER_LIMITS.maxLogBytes) {
      refuse("EVIDENCE_LIMIT_EXCEEDED", "LOG_BYTES", "log payload exceeds 1 MiB");
    }
  }
  // Checked before any completeness classification: incompleteness never erases a recorded failure.
  for (const l of lines as string[]) {
    if (FAILED.test(l)) {
      conflict(
        "FAILED_LOG_IN_SUCCESSFUL_TRANSACTION",
        "a program failure is recorded in a transaction whose meta.err is null",
      );
    }
  }
  return lines as string[];
}

interface LogFrame {
  readonly programId: string;
  readonly depth: number;
  readonly childPrograms: string[];
  readonly data: string[];
}

function parseLogFrames(lines: readonly string[]): LogFrame[] | null {
  const frames: LogFrame[] = [];
  const stack: LogFrame[] = [];
  for (const line of lines) {
    if (line.startsWith("Log truncated")) return null;
    const inv = INVOKE.exec(line);
    if (inv) {
      const depth = Number(inv[2]);
      if (depth !== stack.length + 1) return null;
      const f: LogFrame = { programId: inv[1] as string, depth, childPrograms: [], data: [] };
      stack[stack.length - 1]?.childPrograms.push(f.programId);
      frames.push(f);
      stack.push(f);
      continue;
    }
    const ok = SUCCESS.exec(line);
    if (ok) {
      const top = stack.pop();
      if (!top || top.programId !== ok[1]) return null;
      continue;
    }
    const d = DATA.exec(line);
    if (d) {
      const top = stack[stack.length - 1];
      if (!top) return null;
      top.data.push(d[1] as string);
    }
  }
  return stack.length === 0 ? frames : null;
}

function checkSwapEvent(encoded: readonly string[], swap: TargetSwap, poolAddress: string): void {
  const at = `instruction ${swap.node.outer} position ${swap.node.pos}`;
  const bad = (why: string): never => conflict("EVENT_MISMATCH", `${at}: ${why}`);
  if (encoded.length !== 1)
    bad(`expected exactly one SwapEvent, found ${encoded.length} data lines`);
  const b64 = encoded[0] as string;
  if (!BASE64.test(b64)) bad("event data is not base64");
  const d = new Uint8Array(Buffer.from(b64, "base64"));
  if (Buffer.from(d).toString("base64") !== b64) bad("event data is not canonical base64");
  if (d.length !== CPMM_SWAP_EVENT_LENGTH || !bytesEqual(d, 0, CPMM_SWAP_EVENT_DISCRIMINATOR)) {
    bad("not a 170-byte SwapEvent");
  }
  if ((d[88] as number) > 1 || (d[169] as number) > 1) bad("SwapEvent booleans must be 0 or 1");
  if (pubkeyAt(d, 8) !== poolAddress) bad("event pool_id differs");
  if (readU64(d, 56) !== swap.inAmount || readU64(d, 64) !== swap.outAmount) {
    bad("event amounts differ from the transfers");
  }
  if (readU64(d, 72) !== 0n || readU64(d, 80) !== 0n) bad("event reports a transfer fee");
  if ((d[88] === 1) !== swap.baseInput) bad("event base_input differs");
  if (pubkeyAt(d, 89) !== swap.inputMint || pubkeyAt(d, 121) !== swap.outputMint) {
    bad("event mints differ");
  }
}

function corroborate(
  lines: readonly string[] | null,
  cpmmNodes: readonly TraceNode[],
  swaps: ReadonlyMap<TraceNode, TargetSwap>,
  poolAddress: string,
): CpmmLogCorroboration {
  if (lines === null) return "UNAVAILABLE";
  const frames = parseLogFrames(lines);
  if (frames === null) return "INCOMPLETE";
  const cpmmFrames = frames.filter((f) => f.programId === RAYDIUM_CPMM_PROGRAM_ID);
  if (cpmmFrames.length !== cpmmNodes.length) {
    conflict("LOG_TRACE_MISMATCH", "CPMM invocation count in logs differs from the trace");
  }
  cpmmNodes.forEach((n, k) => {
    const f = cpmmFrames[k] as LogFrame;
    const expected = n.children.map((c) => c.ix.programId);
    if (
      f.depth !== n.height ||
      f.childPrograms.length !== expected.length ||
      f.childPrograms.some((p, i) => p !== expected[i])
    ) {
      conflict("LOG_TRACE_MISMATCH", `CPMM frame ${k} in logs differs from the trace`);
    }
    const swap = swaps.get(n);
    if (swap) checkSwapEvent(f.data, swap, poolAddress);
  });
  return "CORROBORATED";
}

// ---------------------------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------------------------

export function decodeRaydiumCpmmTransactionSwaps(
  payload: unknown,
  pool: RaydiumCpmmPoolStateSuccess,
  options: DecodeCpmmSwapOptions,
): DecodeRaydiumCpmmTransactionResult {
  let signature: string | undefined;
  let slot: number | undefined;
  try {
    return deepFreeze(decode());
  } catch (err) {
    const r =
      err instanceof Refusal
        ? err
        : new Refusal("INVALID_PAYLOAD", null, "payload could not be read as a transaction");
    return deepFreeze({
      ok: false,
      status: "UNRESOLVED_EVIDENCE",
      reason: r.reason,
      detail: r.detail,
      message: r.message,
      signature,
      slot,
      events: [],
    } as CpmmUnresolvedResult);
  }

  function decode(): DecodeRaydiumCpmmTransactionResult {
    const L = CPMM_DECODER_LIMITS;
    // 1. Options: a required injected receipt time and nothing else (no clock, no override).
    if (!isPlainObject(options)) refuse("INVALID_OPTIONS", null, "options are required");
    for (const k of Object.keys(options)) {
      if (k !== "receiptTimestampMs" && k !== "maxSupportedTransactionVersion") {
        refuse("INVALID_OPTIONS", k, `unsupported option ${k}`);
      }
    }
    // The request policy: omitted means the historical cap of 0; only 0 and 1 are defined.
    let maxVersion: CpmmMaxSupportedTransactionVersion = 0;
    if (hasOwn(options, "maxSupportedTransactionVersion")) {
      const cap = (options as { maxSupportedTransactionVersion?: unknown })
        .maxSupportedTransactionVersion;
      if (cap !== 0 && cap !== 1) {
        refuse(
          "INVALID_OPTIONS",
          "maxSupportedTransactionVersion",
          "maxSupportedTransactionVersion must be 0 or 1",
        );
      }
      maxVersion = cap as CpmmMaxSupportedTransactionVersion;
    }
    const receiptTimestampMs = options.receiptTimestampMs;
    if (!Number.isSafeInteger(receiptTimestampMs) || receiptTimestampMs <= 0) {
      refuse(
        "INVALID_RECEIPT_TIMESTAMP",
        null,
        "receiptTimestampMs must be a positive safe integer",
      );
    }
    // 2. Pool context.
    const pv = validatePool(pool);
    // 3. Envelope.
    if (!isPlainObject(payload)) refuse("INVALID_PAYLOAD", null, "payload must be an object");
    const tx = (payload as Record<string, unknown>).transaction;
    const meta = (payload as Record<string, unknown>).meta;
    if (!isPlainObject(tx) || !isPlainObject(tx.message) || !Array.isArray(tx.signatures)) {
      refuse("INVALID_PAYLOAD", null, "transaction.message and signatures are required");
    }
    const t = tx as { message: Record<string, unknown>; signatures: unknown[] };
    if (!isValidSolanaSignature(t.signatures[0])) {
      refuse("MISSING_SIGNATURE", null, "signatures[0] is not a canonical signature");
    }
    signature = t.signatures[0] as string;
    const rawSlot = (payload as Record<string, unknown>).slot;
    if (!isSafeIndex(rawSlot))
      refuse("INVALID_SLOT", null, "slot must be a non-negative safe integer");
    slot = rawSlot as number;
    const version = (payload as Record<string, unknown>).version;
    // "legacy" is accepted under every cap; a number only up to the request's cap. A v1 body under
    // a cap of 0 contradicts the request and is refused exactly as before v1 was supported.
    if (version !== "legacy" && !(version === 0 || (version === 1 && maxVersion >= 1))) {
      refuse(
        "UNSUPPORTED_TRANSACTION_VERSION",
        version === undefined ? "VERSION_MISSING" : String(version),
        maxVersion === 0
          ? "only legacy and v0 are supported, with the version field present"
          : "only legacy, v0 and v1 are supported, with the version field present",
      );
    }
    if (!isPlainObject(meta) || !hasOwn(meta, "err") || meta.err === undefined) {
      refuse("METADATA_UNAVAILABLE", null, "meta with an err field is required");
    }
    const m = meta as Record<string, unknown>;
    // 4. Accounts and top-level instructions (preconditions of every later result).
    const resolved = resolveAccounts(t.message, m, version as CpmmTransactionVersion, t.signatures);
    const A = resolved.accounts;
    const rawTop = t.message.instructions;
    if (!Array.isArray(rawTop))
      refuse("INVALID_PAYLOAD", null, "message.instructions must be an array");
    if (
      resolved.v1 !== null &&
      (rawTop as unknown[]).length > SOLANA_V1_PROTOCOL_LIMITS.maxInstructions
    ) {
      refuse("INVALID_PAYLOAD", "V1_INSTRUCTIONS", "v1 allows at most 64 instructions");
    }
    if ((rawTop as unknown[]).length > L.maxTopLevelInstructions) {
      refuse("EVIDENCE_LIMIT_EXCEEDED", "TOP_LEVEL", "too many top-level instructions");
    }
    const top = (rawTop as unknown[]).map((ix, i) =>
      parseInstruction(ix, A, `instruction ${i}`, false),
    );
    if (resolved.v1 !== null) {
      // Static accounts only (lookups refused above), so every account is a static address.
      checkV1Size(top, A.length, resolved.numRequiredSignatures, resolved.v1);
    }
    // 5. Recorded failure: not zero-swap evidence.
    if (m.err !== null) {
      return { ok: false, status: "TRANSACTION_FAILED", signature, slot, events: [] };
    }
    // 6. Logs: bounds and recorded-failure contradiction (before any shortcut).
    const logLines = checkLogs(m.logMessages);
    // 7. Inner instructions, when present, are validated fully (heights and tree shape).
    const rawInner = m.innerInstructions;
    let trees: TraceNode[][] | null = null;
    let innerCount = 0;
    if (rawInner !== undefined && rawInner !== null) {
      if (!Array.isArray(rawInner)) {
        refuse("INVALID_PAYLOAD", "INNER", "innerInstructions must be an array");
      }
      const groups = new Map<number, CompiledInstruction[]>();
      for (const g of rawInner as unknown[]) {
        if (
          !isPlainObject(g) ||
          !isSafeIndex(g.index) ||
          g.index >= top.length ||
          groups.has(g.index) ||
          !Array.isArray(g.instructions) ||
          g.instructions.length === 0
        ) {
          refuse("UNSUPPORTED_CALL_TREE", "GROUP", "malformed, duplicate or empty inner group");
        }
        const gi = (g as { index: number }).index;
        const list = (g as { instructions: unknown[] }).instructions;
        innerCount += list.length;
        if (innerCount > L.maxInnerInstructions) {
          refuse("EVIDENCE_LIMIT_EXCEEDED", "INNER", "too many inner instructions");
        }
        groups.set(
          gi,
          list.map((ix, k) => parseInstruction(ix, A, `instruction ${gi} inner ${k}`, true)),
        );
      }
      trees = top.map((ix, o) => buildTree(o, ix, groups.get(o) ?? []));
    }
    const baseDiagnostics = {
      topLevelInstructions: top.length,
      innerInstructions: innerCount,
    };
    // 8. Shortcut: a swap must pass pool_state and both vaults, so a transaction referencing none
    // of them cannot have swapped against the pool. (A vault referenced without the pool, e.g. by
    // another pool's swap, is decoded in full so that the contradiction is refused.)
    const targetRefs = new Set([pv.poolAddress, pv.baseVault, pv.quoteVault]);
    if (!A.some((k) => targetRefs.has(k))) {
      return {
        ok: true,
        status: "NO_MATCHING_SWAPS",
        signature,
        slot,
        events: [],
        diagnostics: {
          ...baseDiagnostics,
          cpmmInvocations: 0,
          targetSwaps: 0,
          nonTargetSwaps: 0,
          otherCpmmInstructions: 0,
          logCorroboration: logLines === null ? "UNAVAILABLE" : "NOT_EVALUATED",
          shortcut: "TARGET_POOL_NOT_REFERENCED",
        },
      };
    }
    if (trees === null) {
      refuse(
        "INNER_INSTRUCTIONS_UNAVAILABLE",
        null,
        "innerInstructions are required to decode the pool",
      );
    }
    // 9. Every CPMM invocation, in execution order.
    const cpmmNodes = (trees as TraceNode[][])
      .flat()
      .filter((n) => n.ix.programId === RAYDIUM_CPMM_PROGRAM_ID);
    const swaps = new Map<TraceNode, TargetSwap>();
    let nonTargetSwaps = 0;
    let otherCpmm = 0;
    for (const n of cpmmNodes) {
      const at = `instruction ${n.outer} position ${n.pos}`;
      const d = n.ix.data;
      if (d.length < 8)
        refuse("MALFORMED_INSTRUCTION_DATA", at, `${at}: CPMM data shorter than 8 bytes`);
      const isIn = bytesEqual(d, 0, CPMM_SWAP_BASE_INPUT_DISCRIMINATOR);
      const isOut = bytesEqual(d, 0, CPMM_SWAP_BASE_OUTPUT_DISCRIMINATOR);
      const touches = n.ix.accounts.some((a) => targetRefs.has(a));
      if (isIn || isOut) {
        if (n.ix.accounts.length < 13) {
          refuse("MALFORMED_INSTRUCTION_DATA", at, `${at}: swap with fewer than 13 accounts`);
        }
        if (n.ix.accounts[3] !== pv.poolAddress) {
          if (touches)
            refuse("IDENTITY_MISMATCH", at, `${at}: another pool's swap references the target`);
          nonTargetSwaps++;
          continue;
        }
        swaps.set(n, validateTargetSwap(n, isIn, pv, resolved.numRequiredSignatures));
      } else if (touches) {
        refuse(
          "UNSUPPORTED_INSTRUCTION",
          at,
          `${at}: a non-swap CPMM instruction touches the target pool`,
        );
      } else {
        otherCpmm++;
      }
    }
    // 10. Logs: optional corroboration.
    const logCorroboration = corroborate(logLines, cpmmNodes, swaps, pv.poolAddress);
    const diagnostics: CpmmDecodeDiagnostics = {
      ...baseDiagnostics,
      cpmmInvocations: cpmmNodes.length,
      targetSwaps: swaps.size,
      nonTargetSwaps,
      otherCpmmInstructions: otherCpmm,
      logCorroboration,
      shortcut: null,
    };
    if (swaps.size === 0) {
      return { ok: true, status: "NO_MATCHING_SWAPS", signature, slot, events: [], diagnostics };
    }
    // 11. Timestamps (only when events are emitted).
    const bt = (payload as Record<string, unknown>).blockTime;
    if (bt === undefined || bt === null) {
      refuse("MISSING_UPSTREAM_TIMESTAMP", null, "blockTime is unavailable (never manufactured)");
    }
    if (typeof bt !== "number" || !Number.isSafeInteger(bt) || bt <= 0 || bt > MAX_BLOCK_TIME_SEC) {
      refuse(
        "INVALID_UPSTREAM_TIMESTAMP",
        null,
        "blockTime must be a positive safe integer (seconds)",
      );
    }
    const blockTimeSec = bt as number;
    const events: TradeEvent[] = [...swaps.values()].map((s) => {
      const buy = s.inputMint === WSOL_MINT;
      const side: TradeSide = buy ? "BUY" : "SELL";
      return {
        eventId: `${signature}:${s.node.outer}:${s.node.pos}`,
        signature: signature as string,
        swapIndex: s.node.pos,
        outerInstructionIndex: s.node.outer,
        poolId: pv.poolAddress,
        tokenMint: pv.candidateMint,
        side,
        slot: slot as number,
        blockTimeSec,
        eventTimestampMs: blockTimeSec * 1000,
        receiptTimestampMs,
        timestampProvenance: "ON_CHAIN_BLOCK_TIME",
        tokenAmount: buy ? s.outAmount : s.inAmount,
        solAmount: buy ? s.inAmount : s.outAmount,
      };
    });
    return {
      ok: true,
      status: "SWAP_DECODED",
      signature: signature as string,
      slot: slot as number,
      events,
      diagnostics,
    };
  }
}
