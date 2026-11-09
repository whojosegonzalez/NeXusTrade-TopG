/**
 * PAPER-only validation of an explicitly failed on-chain transaction as zero committed swaps.
 *
 * SAFETY CONTRACT:
 *  - A decoder TRANSACTION_FAILED result alone is insufficient: the decoder returns that failure before its later
 *    structure and timestamp checks. This module re-establishes those checks before a failed transaction may be
 *    treated as "known failed, zero committed swaps".
 *  - Only recognized Solana TransactionError JSON representations are accepted. Arbitrary objects, nonempty
 *    strings, empty objects, malformed InstructionError values, missing metadata, contradictory `meta.status`,
 *    identities, or timestamps remain unavailable (fail-closed).
 *  - The result is a distinct classification. It never manufactures trade events and never represents a
 *    successfully executed transaction with no candidate swaps.
 *  - Callers apply it only under the explicit PAPER active-window opt-in; default, production, and daemon
 *    behavior are unchanged.
 */
import {
  decodeRaydiumTransactionSwaps,
  type TrackedRaydiumPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import { isValidSolanaSignature } from "./ExactPoolHistoryEnumerator.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID } from "../research/pilot/RaydiumAmmParser.js";

/** Sealed policy identifier. Replay honours only this exact value; any other sealed value fails closed. */
export const PAPER_FAILED_TRANSACTION_POLICY =
  "PAPER_VALIDATED_FAILED_TRANSACTION_ZERO_SWAPS_V1" as const;
export type PaperFailedTransactionPolicyId = typeof PAPER_FAILED_TRANSACTION_POLICY;

/** Unit (string-serialized) variants of Solana `TransactionError`. */
const TRANSACTION_ERROR_UNIT_VARIANTS: ReadonlySet<string> = new Set([
  "AccountInUse",
  "AccountLoadedTwice",
  "AccountNotFound",
  "ProgramAccountNotFound",
  "InsufficientFundsForFee",
  "InvalidAccountForFee",
  "AlreadyProcessed",
  "BlockhashNotFound",
  "CallChainTooDeep",
  "MissingSignatureForFee",
  "InvalidAccountIndex",
  "SignatureFailure",
  "InvalidProgramForExecution",
  "SanitizeFailure",
  "ClusterMaintenance",
  "AccountBorrowOutstanding",
  "WouldExceedMaxBlockCostLimit",
  "UnsupportedVersion",
  "InvalidWritableAccount",
  "WouldExceedMaxAccountCostLimit",
  "WouldExceedAccountDataBlockLimit",
  "TooManyAccountLocks",
  "AddressLookupTableNotFound",
  "InvalidAddressLookupTableOwner",
  "InvalidAddressLookupTableData",
  "InvalidAddressLookupTableIndex",
  "InvalidRentPayingAccount",
  "WouldExceedMaxVoteCostLimit",
  "WouldExceedAccountDataTotalLimit",
  "MaxLoadedAccountsDataSizeExceeded",
  "InvalidLoadedAccountsDataSizeLimit",
  "ResanitizationNeeded",
  "UnbalancedTransaction",
  "ProgramCacheHitMaxLimit",
  "CommitCancelled",
]);

/** Unit (string-serialized) variants of Solana `InstructionError`. */
const INSTRUCTION_ERROR_UNIT_VARIANTS: ReadonlySet<string> = new Set([
  "GenericError",
  "InvalidArgument",
  "InvalidInstructionData",
  "InvalidAccountData",
  "AccountDataTooSmall",
  "InsufficientFunds",
  "IncorrectProgramId",
  "MissingRequiredSignature",
  "AccountAlreadyInitialized",
  "UninitializedAccount",
  "UnbalancedInstruction",
  "ModifiedProgramId",
  "ExternalAccountLamportSpend",
  "ExternalAccountDataModified",
  "ReadonlyLamportChange",
  "ReadonlyDataModified",
  "DuplicateAccountIndex",
  "ExecutableModified",
  "RentEpochModified",
  "NotEnoughAccountKeys",
  "AccountDataSizeChanged",
  "AccountNotExecutable",
  "AccountBorrowFailed",
  "AccountBorrowOutstanding",
  "DuplicateAccountOutOfSync",
  "InvalidError",
  "ExecutableDataModified",
  "ExecutableLamportChange",
  "ExecutableAccountNotRentExempt",
  "UnsupportedProgramId",
  "CallDepth",
  "MissingAccount",
  "ReentrancyNotAllowed",
  "MaxSeedLengthExceeded",
  "InvalidSeeds",
  "InvalidRealloc",
  "ComputationalBudgetExceeded",
  "PrivilegeEscalation",
  "ProgramEnvironmentSetupFailure",
  "ProgramFailedToComplete",
  "ProgramFailedToCompile",
  "Immutable",
  "IncorrectAuthority",
  "AccountNotRentExempt",
  "InvalidAccountOwner",
  "ArithmeticOverflow",
  "UnsupportedSysvar",
  "IllegalOwner",
  "MaxAccountsDataAllocationsExceeded",
  "MaxAccountsExceeded",
  "MaxInstructionTraceLengthExceeded",
  "BuiltinProgramsMustConsumeComputeUnits",
  "BorshIoError",
]);

const U8_MAX = 255;
const U32_MAX = 4_294_967_295;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
}

/** Deterministic JSON with sorted object keys (TransactionError values are small, acyclic JSON). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function deepFreezeClone<T>(value: T): T {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (v: unknown): void => {
    if (v && typeof v === "object") {
      Object.freeze(v);
      for (const child of Object.values(v as Record<string, unknown>)) freeze(child);
    }
  };
  freeze(clone);
  return clone;
}

export interface SolanaTransactionErrorBounds {
  /** Number of outer instructions; when supplied, instruction indices must be below it. */
  readonly instructionCount?: number | undefined;
  /** Number of static plus loaded account keys; when supplied, account indices must be below it. */
  readonly accountCount?: number | undefined;
}

export type SolanaTransactionErrorValidation =
  | { readonly ok: true; readonly canonical: string; readonly variant: string }
  | { readonly ok: false; readonly reason: string };

function validateInstructionError(value: unknown): string | null {
  if (typeof value === "string") {
    return INSTRUCTION_ERROR_UNIT_VARIANTS.has(value)
      ? null
      : `unrecognized InstructionError variant '${value}'`;
  }
  if (!isPlainObject(value)) return "InstructionError detail must be a string or single-key object";
  const keys = Object.keys(value);
  if (keys.length !== 1) return "InstructionError detail object must have exactly one key";
  const key = keys[0]!;
  const inner = value[key];
  if (key === "Custom") {
    return isIntInRange(inner, 0, U32_MAX) ? null : "InstructionError Custom code must be a u32";
  }
  if (key === "BorshIoError") {
    // Legacy tuple form BorshIoError(String); newer clusters serialize the unit form handled above.
    return typeof inner === "string"
      ? null
      : "InstructionError BorshIoError detail must be a string";
  }
  return `unsupported InstructionError representation '${key}'`;
}

/**
 * Validates a JSON-RPC `meta.err` value against the recognized Solana `TransactionError` representations.
 * Unit variants serialize as strings; tuple/struct variants serialize as single-key objects.
 */
export function validateSolanaTransactionError(
  err: unknown,
  bounds: SolanaTransactionErrorBounds = {},
): SolanaTransactionErrorValidation {
  const instructionMax =
    bounds.instructionCount !== undefined ? Math.min(U8_MAX, bounds.instructionCount - 1) : U8_MAX;
  const accountMax =
    bounds.accountCount !== undefined ? Math.min(U8_MAX, bounds.accountCount - 1) : U8_MAX;

  if (typeof err === "string") {
    return TRANSACTION_ERROR_UNIT_VARIANTS.has(err)
      ? { ok: true, canonical: canonicalJson(err), variant: err }
      : { ok: false, reason: `unrecognized TransactionError variant '${err}'` };
  }
  if (!isPlainObject(err)) {
    return {
      ok: false,
      reason: "TransactionError must be a recognized string or single-key object",
    };
  }
  const keys = Object.keys(err);
  if (keys.length !== 1) {
    return {
      ok: false,
      reason: `TransactionError object must have exactly one key (found ${keys.length})`,
    };
  }
  const variant = keys[0]!;
  const value = err[variant];
  let problem: string | null;
  switch (variant) {
    case "InstructionError": {
      if (!Array.isArray(value) || value.length !== 2) {
        problem = "InstructionError must be a [index, error] pair";
      } else if (!isIntInRange(value[0], 0, instructionMax)) {
        problem = `InstructionError index ${String(value[0])} is not a valid outer instruction index`;
      } else {
        problem = validateInstructionError(value[1]);
      }
      break;
    }
    case "DuplicateInstruction":
      problem = isIntInRange(value, 0, instructionMax)
        ? null
        : `DuplicateInstruction index ${String(value)} is not a valid outer instruction index`;
      break;
    case "InsufficientFundsForRent":
    case "ProgramExecutionTemporarilyRestricted":
      problem =
        isPlainObject(value) &&
        Object.keys(value).length === 1 &&
        isIntInRange(value.account_index, 0, accountMax)
          ? null
          : `${variant} must carry a valid account_index`;
      break;
    default:
      problem = `unsupported TransactionError representation '${variant}'`;
  }
  return problem === null
    ? { ok: true, canonical: canonicalJson(err), variant }
    : { ok: false, reason: problem };
}

/** Validated, immutable evidence that a transaction failed on-chain and committed zero swaps. */
export interface ValidatedFailedTransaction {
  readonly policy: PaperFailedTransactionPolicyId;
  readonly classification: "KNOWN_FAILED_TRANSACTION_ZERO_COMMITTED_SWAPS";
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly onChainError: unknown;
  readonly onChainErrorCanonical: string;
  readonly onChainErrorVariant: string;
  readonly decoderReason: "TRANSACTION_FAILED";
  readonly decoderMessage: string;
  readonly committedSwapCount: 0;
}

export type FailedTransactionValidationResult =
  | { readonly ok: true; readonly value: ValidatedFailedTransaction }
  | { readonly ok: false; readonly reason: string };

export interface ValidateFailedTransactionParams {
  /** getTransaction `result` payload (JSON-RPC envelope already validated by the caller). */
  readonly payload: unknown;
  /** Exact requested transaction signature. */
  readonly expectedSignature: string;
  /** Candidate pool binding; the transaction must reference this pool and the Raydium AMM v4 program. */
  readonly poolContext: TrackedRaydiumPoolContext;
  /** Optional slot/blockTime supplied by the notification; contradictions fail closed. */
  readonly expectedSlot?: number | undefined;
  readonly expectedBlockTime?: number | null | undefined;
}

const fail = (reason: string): FailedTransactionValidationResult => ({ ok: false, reason });

/**
 * Re-validates a decoder TRANSACTION_FAILED payload: exact signature, supported version and structure, verified
 * slot and blockTime, candidate pool binding, recognized `meta.err`, and consistent `meta.status`.
 */
export function validateFailedTransactionEvidence(
  params: ValidateFailedTransactionParams,
): FailedTransactionValidationResult {
  const { payload, expectedSignature, poolContext } = params;

  // 1. The shared decoder must classify this exact payload as TRANSACTION_FAILED for the candidate pool context
  //    (it also validates the pool context, signature presence, slot, and supported transaction version).
  const decoded = decodeRaydiumTransactionSwaps(payload, poolContext);
  if (decoded.ok) return fail("decoder did not report a failed transaction");
  if (decoded.reason !== "TRANSACTION_FAILED") {
    return fail(`decoder reason ${decoded.reason} is not TRANSACTION_FAILED`);
  }
  if (decoded.signature !== expectedSignature) return fail("decoded signature mismatch");

  if (!isPlainObject(payload)) return fail("transaction payload must be a plain object");

  // 2. Exact signature identity and signature list structure.
  const transaction = payload.transaction;
  if (!isPlainObject(transaction)) return fail("transaction object missing");
  const signatures = transaction.signatures;
  if (!Array.isArray(signatures) || signatures.length === 0) return fail("signatures missing");
  if (!signatures.every((s) => isValidSolanaSignature(s)))
    return fail("invalid signature encoding");
  if (signatures[0] !== expectedSignature) return fail("primary signature does not match request");
  if (new Set(signatures).size !== signatures.length) return fail("duplicate signatures");

  // 3. Verified slot and blockTime (never manufactured).
  const slot = payload.slot;
  if (!isIntInRange(slot, 0, Number.MAX_SAFE_INTEGER)) return fail("invalid slot");
  const blockTime = payload.blockTime;
  if (!isIntInRange(blockTime, 1, Number.MAX_SAFE_INTEGER))
    return fail("missing or invalid blockTime");
  if (params.expectedSlot !== undefined && params.expectedSlot !== slot) {
    return fail(`slot ${slot} contradicts expected slot ${params.expectedSlot}`);
  }
  if (
    params.expectedBlockTime !== undefined &&
    params.expectedBlockTime !== null &&
    params.expectedBlockTime !== blockTime
  ) {
    return fail(
      `blockTime ${blockTime} contradicts expected blockTime ${params.expectedBlockTime}`,
    );
  }

  // 4. Supported message structure.
  const message = transaction.message;
  if (!isPlainObject(message)) return fail("message missing");
  const header = message.header;
  if (
    !isPlainObject(header) ||
    !isIntInRange(header.numRequiredSignatures, 1, U8_MAX) ||
    !isIntInRange(header.numReadonlySignedAccounts, 0, U8_MAX) ||
    !isIntInRange(header.numReadonlyUnsignedAccounts, 0, U8_MAX)
  ) {
    return fail("message header missing or malformed");
  }
  if (header.numRequiredSignatures !== signatures.length) {
    return fail("signature count does not match header.numRequiredSignatures");
  }
  const staticKeys = message.accountKeys;
  if (
    !Array.isArray(staticKeys) ||
    staticKeys.length === 0 ||
    !staticKeys.every((k) => typeof k === "string" && k.trim().length > 0)
  ) {
    return fail("accountKeys must be a nonempty array of account strings");
  }
  if (staticKeys.length < header.numRequiredSignatures)
    return fail("accountKeys shorter than signers");

  const meta = payload.meta;
  if (!isPlainObject(meta)) return fail("meta object missing");
  const loadedKeys: string[] = [];
  if (meta.loadedAddresses !== undefined && meta.loadedAddresses !== null) {
    const loaded = meta.loadedAddresses;
    if (!isPlainObject(loaded)) return fail("loadedAddresses malformed");
    for (const field of ["writable", "readonly"] as const) {
      const list = loaded[field];
      if (list === undefined) continue;
      if (
        !Array.isArray(list) ||
        !list.every((k) => typeof k === "string" && k.trim().length > 0)
      ) {
        return fail(`loadedAddresses.${field} malformed`);
      }
      loadedKeys.push(...(list as string[]));
    }
  }
  const allKeys = [...(staticKeys as string[]), ...loadedKeys];
  if (new Set(allKeys).size !== allKeys.length) return fail("duplicate account keys");

  const instructions = message.instructions;
  if (!Array.isArray(instructions) || instructions.length === 0)
    return fail("instructions missing");
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i] as unknown;
    if (
      !isPlainObject(ix) ||
      !isIntInRange(ix.programIdIndex, 0, allKeys.length - 1) ||
      !Array.isArray(ix.accounts) ||
      !ix.accounts.every((a) => isIntInRange(a, 0, allKeys.length - 1)) ||
      typeof ix.data !== "string"
    ) {
      return fail(`instruction ${i} malformed`);
    }
  }

  // 5. Candidate pool binding: the failed transaction must reference the candidate pool and the AMM program.
  if (!allKeys.includes(poolContext.poolId))
    return fail("transaction does not reference candidate pool");
  if (!allKeys.includes(RAYDIUM_AMM_V4_PROGRAM_ID)) {
    return fail("transaction does not reference the Raydium AMM v4 program");
  }

  // 6. Explicit, recognized Solana TransactionError; deprecated meta.status must agree when present.
  if (!Object.prototype.hasOwnProperty.call(meta, "err")) return fail("meta.err missing");
  const errCheck = validateSolanaTransactionError(meta.err, {
    instructionCount: instructions.length,
    accountCount: allKeys.length,
  });
  if (!errCheck.ok) return fail(`meta.err rejected: ${errCheck.reason}`);
  if (meta.status !== undefined) {
    const status = meta.status;
    if (
      !isPlainObject(status) ||
      Object.keys(status).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(status, "Err") ||
      canonicalJson(status.Err) !== errCheck.canonical
    ) {
      return fail("meta.status contradicts meta.err");
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      policy: PAPER_FAILED_TRANSACTION_POLICY,
      classification: "KNOWN_FAILED_TRANSACTION_ZERO_COMMITTED_SWAPS",
      signature: expectedSignature,
      slot,
      blockTime,
      onChainError: deepFreezeClone(meta.err),
      onChainErrorCanonical: errCheck.canonical,
      onChainErrorVariant: errCheck.variant,
      decoderReason: "TRANSACTION_FAILED",
      decoderMessage: decoded.message,
      committedSwapCount: 0,
    }),
  };
}
