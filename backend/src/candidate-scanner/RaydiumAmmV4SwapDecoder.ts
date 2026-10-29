/**
 * Phase 12.94-D Milestone D.3.3: Offline Raydium AMM v4 Swap Decoder & Normalization Adapter
 *
 * Implements authoritative, strictly offline transaction swap decoding and normalization
 * producing immutable TradeEvent inputs for RollingTradeFlowTracker.
 *
 * Pinned Official Raydium Source Code References (Immutable Commit):
 * - Repository: https://github.com/raydium-io/raydium-amm
 * - Pinned Commit: 91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6
 * - Program ID: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (RAYDIUM_AMM_V4_PROGRAM_ID)
 * - Instruction Definitions (program/src/instruction.rs @ 91739d8d):
 *     - SwapBaseIn: tag 9 (u8), amount_in (u64 LE, offset 1..9), minimum_out (u64 LE, offset 9..17)
 *     - SwapBaseOut: tag 11 (u8), max_in (u64 LE, offset 1..9), amount_out (u64 LE, offset 9..17)
 *     - SwapBaseInV2: tag 16 (u8), amount_in (u64 LE, offset 1..9), minimum_out (u64 LE, offset 9..17)
 *     - SwapBaseOutV2: tag 17 (u8), max_in (u64 LE, offset 1..9), amount_out (u64 LE, offset 9..17)
 * - Instruction Account Layouts (program/src/processor.rs @ 91739d8d):
 *     - Standard 17-account layout (process_swap_base_in / process_swap_base_out):
 *         0: token_program
 *         1: amm (pool state account / poolId)
 *         2: amm_authority
 *         3: amm_open_orders
 *         4: amm_coin_vault (baseVault)
 *         5: amm_pc_vault (quoteVault)
 *         6..13: market accounts
 *         14: user_source (user source token account)
 *         15: user_destination (user destination token account)
 *         16: user_source_owner (user wallet signer)
 *     - Shifted 18-account layout (process_swap_base_in / process_swap_base_out with optional target_orders):
 *         0: token_program
 *         1: amm (pool state account / poolId)
 *         2: amm_authority
 *         3: amm_open_orders
 *         4: amm_target_orders (conditionally consumed, shifting all subsequent positions +1)
 *         5: amm_coin_vault (baseVault)
 *         6: amm_pc_vault (quoteVault)
 *         7..14: market accounts
 *         15: user_source
 *         16: user_destination
 *         17: user_source_owner
 *     - Clean 8-account layout (process_swap_base_in_v2 / process_swap_base_out_v2):
 *         0: token_program
 *         1: amm (pool state account / poolId)
 *         2: amm_authority
 *         3: amm_coin_vault (baseVault)
 *         4: amm_pc_vault (quoteVault)
 *         5: user_source
 *         6: user_destination
 *         7: user_source_owner
 * - Swap Directions (program/src/math.rs @ 91739d8d):
 *     - SwapDirection::PC2Coin = 1u64 (Quote -> Coin/Base)
 *     - SwapDirection::Coin2PC = 2u64 (Coin/Base -> Quote)
 * - Program Logs (program/src/log.rs @ 91739d8d):
 *     - SwapBaseInLog: log_type: 3 (u8), direction: u64 LE at offset 17..25 (1 = PC2Coin, 2 = Coin2PC)
 *     - SwapBaseOutLog: log_type: 4 (u8), direction: u64 LE at offset 17..25 (1 = PC2Coin, 2 = Coin2PC)
 */

import { decodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import type { D23RaydiumAmmV4State, RaydiumPairOrientation } from "../research/pilot/PilotTypes.js";
import {
  isCanonicalSolanaBase58,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../research/pilot/RaydiumAmmParser.js";
import type {
  IngestTradeResult,
  RollingTradeFlowTracker,
  TradeEvent,
  TradeSide,
  TradeTimestampProvenance,
} from "./RollingTradeFlowTracker.js";

export const RAYDIUM_AMM_V4_IMMUTABLE_COMMIT = "91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6";

export const RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES = Object.freeze({
  repository: "https://github.com/raydium-io/raydium-amm",
  commit: RAYDIUM_AMM_V4_IMMUTABLE_COMMIT,
  pinnedCommit: RAYDIUM_AMM_V4_IMMUTABLE_COMMIT,
  programId: RAYDIUM_AMM_V4_PROGRAM_ID,
  instructionFile: `https://github.com/raydium-io/raydium-amm/blob/${RAYDIUM_AMM_V4_IMMUTABLE_COMMIT}/program/src/instruction.rs`,
  processorFile: `https://github.com/raydium-io/raydium-amm/blob/${RAYDIUM_AMM_V4_IMMUTABLE_COMMIT}/program/src/processor.rs`,
  mathFile: `https://github.com/raydium-io/raydium-amm/blob/${RAYDIUM_AMM_V4_IMMUTABLE_COMMIT}/program/src/math.rs`,
  logFile: `https://github.com/raydium-io/raydium-amm/blob/${RAYDIUM_AMM_V4_IMMUTABLE_COMMIT}/program/src/log.rs`,
  supportedTags: Object.freeze({
    SWAP_BASE_IN: 9,
    SWAP_BASE_OUT: 11,
    SWAP_BASE_IN_V2: 16,
    SWAP_BASE_OUT_V2: 17,
  }),
});

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface TrackedRaydiumPoolContext {
  readonly poolId: string;
  readonly candidateTokenMint: string;
  readonly quoteTokenMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly orientation: RaydiumPairOrientation;
}

/**
 * Validates public boundary consistency for a TrackedRaydiumPoolContext.
 * Rejects contradictory mints, identical vaults, invalid base58 keys, or mismatched orientations.
 */
export function validateTrackedPoolContext(
  context: unknown,
): asserts context is TrackedRaydiumPoolContext {
  if (!context || typeof context !== "object") {
    throw new Error("[POOL_CONTEXT_INVALID] Pool context must be a non-null object");
  }

  const ctx = context as Record<string, unknown>;

  const fields = [
    "poolId",
    "candidateTokenMint",
    "quoteTokenMint",
    "baseVault",
    "quoteVault",
    "baseMint",
    "quoteMint",
  ] as const;

  for (const field of fields) {
    const val = ctx[field];
    if (typeof val !== "string" || !isCanonicalSolanaBase58(val)) {
      throw new Error(
        `[POOL_CONTEXT_INVALID] Field '${field}' must be a valid canonical Solana Base58 public key`,
      );
    }
  }

  const {
    poolId,
    candidateTokenMint,
    quoteTokenMint,
    baseVault,
    quoteVault,
    baseMint,
    quoteMint,
    orientation,
  } = ctx as unknown as TrackedRaydiumPoolContext;

  if (baseVault === quoteVault) {
    throw new Error("[POOL_CONTEXT_INVALID] baseVault and quoteVault cannot be identical");
  }
  if (baseMint === quoteMint) {
    throw new Error("[POOL_CONTEXT_INVALID] baseMint and quoteMint cannot be identical");
  }

  if (orientation === "TOKEN_BASE_SOL_QUOTE") {
    if (candidateTokenMint !== baseMint) {
      throw new Error(
        `[POOL_CONTEXT_INVALID] TOKEN_BASE_SOL_QUOTE requires candidateTokenMint (${candidateTokenMint}) to equal baseMint (${baseMint})`,
      );
    }
    if (quoteTokenMint !== quoteMint) {
      throw new Error(
        `[POOL_CONTEXT_INVALID] TOKEN_BASE_SOL_QUOTE requires quoteTokenMint (${quoteTokenMint}) to equal quoteMint (${quoteMint})`,
      );
    }
    if (quoteTokenMint !== WSOL_MINT) {
      throw new Error(
        `[POOL_CONTEXT_INVALID] TOKEN_BASE_SOL_QUOTE requires quoteTokenMint to be canonical WSOL (${WSOL_MINT})`,
      );
    }
  } else if (orientation === "SOL_BASE_TOKEN_QUOTE") {
    if (quoteTokenMint !== baseMint) {
      throw new Error(
        `[POOL_CONTEXT_INVALID] SOL_BASE_TOKEN_QUOTE requires quoteTokenMint (${quoteTokenMint}) to equal baseMint (${baseMint})`,
      );
    }
    if (candidateTokenMint !== quoteMint) {
      throw new Error(
        `[POOL_CONTEXT_INVALID] SOL_BASE_TOKEN_QUOTE requires candidateTokenMint (${candidateTokenMint}) to equal quoteMint (${quoteMint})`,
      );
    }
    if (quoteTokenMint !== WSOL_MINT) {
      throw new Error(
        `[POOL_CONTEXT_INVALID] SOL_BASE_TOKEN_QUOTE requires quoteTokenMint to be canonical WSOL (${WSOL_MINT})`,
      );
    }
  } else if (orientation === "NON_SOL_PAIR") {
    if (baseMint === WSOL_MINT || quoteMint === WSOL_MINT) {
      throw new Error(
        "[POOL_CONTEXT_INVALID] NON_SOL_PAIR cannot have WSOL as baseMint or quoteMint",
      );
    }
    const isBaseCandidate = candidateTokenMint === baseMint && quoteTokenMint === quoteMint;
    const isQuoteCandidate = candidateTokenMint === quoteMint && quoteTokenMint === baseMint;
    if (!isBaseCandidate && !isQuoteCandidate) {
      throw new Error(
        "[POOL_CONTEXT_INVALID] NON_SOL_PAIR requires candidateTokenMint and quoteTokenMint to match pool mints",
      );
    }
  } else {
    throw new Error(`[POOL_CONTEXT_INVALID] Unsupported pair orientation: ${String(orientation)}`);
  }

  // Pool ID must not be identical to any vault or mint
  if (
    poolId === baseVault ||
    poolId === quoteVault ||
    poolId === baseMint ||
    poolId === quoteMint
  ) {
    throw new Error(
      "[POOL_CONTEXT_INVALID] poolId cannot be substituted by or equal to vault or mint accounts",
    );
  }
}

/**
 * Creates and freezes a verified TrackedRaydiumPoolContext from state and explicit identities.
 * Explicit canonical pool address is mandatory; NO fallback to vault accounts is permitted.
 */
export function createTrackedRaydiumPoolContext(
  state: D23RaydiumAmmV4State,
  poolAddress: string,
  candidateTokenMint: string,
  quoteTokenMint: string,
  orientation: RaydiumPairOrientation,
): TrackedRaydiumPoolContext {
  if (typeof poolAddress !== "string" || !isCanonicalSolanaBase58(poolAddress)) {
    throw new Error(
      "[SWAP_DECODER_INIT] An explicit, canonical Solana Base58 poolAddress is mandatory",
    );
  }

  const context: TrackedRaydiumPoolContext = Object.freeze({
    poolId: poolAddress,
    candidateTokenMint,
    quoteTokenMint,
    baseVault: state.baseVault,
    quoteVault: state.quoteVault,
    baseMint: state.baseMint,
    quoteMint: state.quoteMint,
    orientation,
  });

  validateTrackedPoolContext(context);
  return context;
}

export type RaydiumSwapLayoutName =
  | "LEGACY_17_ACCOUNTS"
  | "LEGACY_18_ACCOUNTS_TARGET_ORDERS"
  | "V2_8_ACCOUNTS";

export interface RaydiumSwapAccountPositions {
  readonly layout: RaydiumSwapLayoutName;
  readonly poolIdIndex: number;
  readonly baseVaultIndex: number;
  readonly quoteVaultIndex: number;
  readonly userSourceIndex: number;
  readonly userDestinationIndex: number;
  readonly userOwnerIndex: number;
}

/**
 * Strict Tag/Account-Layout Matrix (Ground Truth: program/src/processor.rs @ 91739d8d)
 *
 * Tag 9 (SwapBaseIn) & Tag 11 (SwapBaseOut):
 * - Exactly 17 accounts: LEGACY_17_ACCOUNTS (baseVault: 4, quoteVault: 5, userSrc: 14, userDst: 15, userOwner: 16)
 * - Exactly 18 accounts: LEGACY_18_ACCOUNTS_TARGET_ORDERS (target_orders conditionally consumed at index 4,
 *   shifting baseVault: 5, quoteVault: 6, userSrc: 15, userDst: 16, userOwner: 17)
 * - Any other count (e.g. 8) is strictly unsupported for tags 9 and 11.
 *
 * Tag 16 (SwapBaseInV2) & Tag 17 (SwapBaseOutV2):
 * - Exactly 8 accounts: V2_8_ACCOUNTS (baseVault: 3, quoteVault: 4, userSrc: 5, userDst: 6, userOwner: 7)
 * - Any other count (e.g. 17, 18) is strictly unsupported for tags 16 and 17.
 */
export function matchSupportedSwapLayout(
  tag: number,
  accountCount: number,
): RaydiumSwapAccountPositions | null {
  if (
    tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN ||
    tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT
  ) {
    if (accountCount === 17) {
      return {
        layout: "LEGACY_17_ACCOUNTS",
        poolIdIndex: 1,
        baseVaultIndex: 4,
        quoteVaultIndex: 5,
        userSourceIndex: 14,
        userDestinationIndex: 15,
        userOwnerIndex: 16,
      };
    }
    if (accountCount === 18) {
      return {
        layout: "LEGACY_18_ACCOUNTS_TARGET_ORDERS",
        poolIdIndex: 1,
        baseVaultIndex: 5,
        quoteVaultIndex: 6,
        userSourceIndex: 15,
        userDestinationIndex: 16,
        userOwnerIndex: 17,
      };
    }
    return null;
  }

  if (
    tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN_V2 ||
    tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT_V2
  ) {
    if (accountCount === 8) {
      return {
        layout: "V2_8_ACCOUNTS",
        poolIdIndex: 1,
        baseVaultIndex: 3,
        quoteVaultIndex: 4,
        userSourceIndex: 5,
        userDestinationIndex: 6,
        userOwnerIndex: 7,
      };
    }
    return null;
  }

  return null;
}

export interface DecodableInstruction {
  readonly programIdIndex?: number | undefined;
  readonly programId?: string | undefined;
  readonly accounts: readonly (number | string)[];
  readonly data: string | Uint8Array | readonly number[];
  readonly stackHeight?: number | undefined;
}

export interface DecodableInnerInstructionsGroup {
  readonly index: number;
  readonly instructions: readonly DecodableInstruction[];
}

export interface DecodableTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string | undefined;
  readonly uiTokenAmount?:
    | {
        readonly amount?: string | undefined;
        readonly decimals?: number | undefined;
      }
    | undefined;
}

export interface DecodableTransactionPayload {
  readonly slot: number;
  readonly blockTime?: number | null | undefined;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: {
      readonly accountKeys: readonly (string | { readonly pubkey: string })[];
      readonly instructions: readonly DecodableInstruction[];
      readonly addressTableLookups?: readonly unknown[] | undefined;
    };
  };
  readonly meta: {
    readonly err: unknown | null;
    readonly fee?: number | undefined;
    readonly preBalances?: readonly number[] | undefined;
    readonly postBalances?: readonly number[] | undefined;
    readonly preTokenBalances?: readonly DecodableTokenBalance[] | undefined;
    readonly postTokenBalances?: readonly DecodableTokenBalance[] | undefined;
    readonly innerInstructions?: readonly DecodableInnerInstructionsGroup[] | undefined;
    readonly logMessages?: readonly string[] | undefined;
    readonly loadedAddresses?:
      | {
          readonly writable?: readonly string[] | undefined;
          readonly readonly?: readonly string[] | undefined;
        }
      | undefined;
  };
}

export type DecodeRaydiumSwapFailureReason =
  | "INVALID_PAYLOAD"
  | "INVALID_POOL_CONTEXT"
  | "MISSING_SIGNATURE"
  | "INVALID_SLOT"
  | "TRANSACTION_NOT_SUCCESSFUL"
  | "TRANSACTION_FAILED"
  | "INVOCATION_FAILED"
  | "MISSING_UPSTREAM_TIMESTAMP"
  | "NO_MATCHING_SWAPS_FOUND"
  | "IDENTITY_MISMATCH"
  | "VAULT_MISMATCH"
  | "UNSUPPORTED_INSTRUCTION"
  | "UNSUPPORTED_LAYOUT"
  | "UNSUPPORTED_CALL_TREE"
  | "MALFORMED_INSTRUCTION_DATA"
  | "AMBIGUOUS_DIRECTION"
  | "CONFLICTING_EVIDENCE";

export interface DecodedSwapEventResult {
  readonly ok: true;
  readonly signature: string;
  readonly slot: number;
  readonly events: readonly TradeEvent[];
  readonly diagnostics: {
    readonly totalInstructionsScanned: number;
    readonly matchingSwapsCount: number;
    readonly nonMatchingPoolSwapsCount: number;
  };
}

export interface DecodeSwapFailureResult {
  readonly ok: false;
  readonly reason: DecodeRaydiumSwapFailureReason;
  readonly message: string;
  readonly signature?: string | undefined;
  readonly slot?: number | undefined;
  readonly events: readonly [];
}

export type DecodeRaydiumTransactionResult = DecodedSwapEventResult | DecodeSwapFailureResult;

export interface DecodeSwapOptions {
  readonly clock?: (() => number) | undefined;
  readonly receiptTimestampMs?: number | undefined;
  readonly fallbackProvenance?: TradeTimestampProvenance | undefined;
}

export interface IngestTransactionResult {
  readonly signature: string;
  readonly decodeResult: DecodeRaydiumTransactionResult;
  readonly ingestedCount: number;
  readonly ingestFailures: readonly {
    readonly eventId: string;
    readonly reason: string;
    readonly message: string;
  }[];
}

/**
 * Decodes instruction data into a Uint8Array.
 * Validates byte-array elements before conversion; rejects negative, fractional,
 * non-finite, or out-of-range (>255) values. Avoids heuristic base64 recovery.
 */
export function decodeInstructionData(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (
        typeof b !== "number" ||
        !Number.isFinite(b) ||
        !Number.isInteger(b) ||
        b < 0 ||
        b > 255
      ) {
        return null;
      }
    }
    return new Uint8Array(data);
  }
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed.length === 0) {
      return new Uint8Array(0);
    }
    try {
      const b58 = decodeBase58(trimmed);
      return new Uint8Array(b58.buffer, b58.byteOffset, b58.byteLength);
    } catch {
      // Avoid heuristic encoding recovery (e.g. base64 fallback)
      return null;
    }
  }
  return null;
}

/**
 * Resolves static and lookup-table accounts from message and meta into a flat array of Base58 strings.
 * Rejects invalid static or loaded account entries without filtering or shifting index positions.
 * Returns null if any entry is null or invalid Base58.
 */
export function resolveTransactionAccounts(
  message: {
    readonly accountKeys: readonly (string | { readonly pubkey: string })[];
  },
  meta?:
    | {
        readonly loadedAddresses?:
          | {
              readonly writable?: readonly string[] | undefined;
              readonly readonly?: readonly string[] | undefined;
            }
          | undefined;
      }
    | null
    | undefined,
): string[] | null {
  if (!message || !Array.isArray(message.accountKeys)) {
    return null;
  }
  const accounts: string[] = [];
  for (let i = 0; i < message.accountKeys.length; i++) {
    const key = message.accountKeys[i];
    let pubkeyStr: string | null = null;
    if (typeof key === "string") {
      pubkeyStr = key;
    } else if (
      key &&
      typeof key === "object" &&
      typeof (key as { pubkey?: unknown }).pubkey === "string"
    ) {
      pubkeyStr = (key as { pubkey: string }).pubkey;
    }
    if (!pubkeyStr || pubkeyStr.trim().length === 0) {
      // Reject invalid or null account entries without filtering or shifting index positions
      return null;
    }
    accounts.push(pubkeyStr);
  }

  if (meta?.loadedAddresses) {
    if (meta.loadedAddresses.writable !== undefined) {
      if (!Array.isArray(meta.loadedAddresses.writable)) {
        return null;
      }
      for (const key of meta.loadedAddresses.writable) {
        if (typeof key !== "string" || key.trim().length === 0) {
          return null;
        }
        accounts.push(key);
      }
    }
    if (meta.loadedAddresses.readonly !== undefined) {
      if (!Array.isArray(meta.loadedAddresses.readonly)) {
        return null;
      }
      for (const key of meta.loadedAddresses.readonly) {
        if (typeof key !== "string" || key.trim().length === 0) {
          return null;
        }
        accounts.push(key);
      }
    }
  }

  return accounts;
}

function resolveProgramId(
  instruction: DecodableInstruction,
  resolvedAccounts: readonly string[],
): string | null {
  if (typeof instruction.programId === "string") {
    return instruction.programId;
  }
  if (
    typeof instruction.programIdIndex === "number" &&
    Number.isInteger(instruction.programIdIndex) &&
    instruction.programIdIndex >= 0 &&
    instruction.programIdIndex < resolvedAccounts.length
  ) {
    return resolvedAccounts[instruction.programIdIndex] ?? null;
  }
  return null;
}

function resolveInstructionAccountsStrict(
  instruction: DecodableInstruction,
  resolvedAccounts: readonly string[],
): string[] | null {
  if (!Array.isArray(instruction.accounts)) {
    return null;
  }
  const result: string[] = [];
  for (let i = 0; i < instruction.accounts.length; i++) {
    const acc = instruction.accounts[i];
    if (typeof acc === "string") {
      result.push(acc);
    } else if (
      typeof acc === "number" &&
      Number.isInteger(acc) &&
      acc >= 0 &&
      acc < resolvedAccounts.length
    ) {
      result.push(resolvedAccounts[acc]!);
    } else {
      // Out of bounds or invalid account index: do NOT drop or shift, fail closed
      return null;
    }
  }
  return result;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) {
    throw new Error(
      `Data underflow: expected 8 bytes at offset ${offset}, total length ${data.length}`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

export interface DecodedRayLogSwap {
  readonly logType: 3 | 4;
  readonly direction: "Coin2PC" | "PC2Coin";
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export function parseRayLog(logLine: string): DecodedRayLogSwap | null {
  const match = logLine.match(/ray_log:\s*([A-Za-z0-9+/=]+)/);
  if (!match || !match[1]) return null;

  try {
    const buf = Buffer.from(match[1], "base64");
    if (buf.length < 57) return null;

    const logType = buf[0];
    if (logType !== 3 && logType !== 4) return null;

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const directionRaw = view.getBigUint64(17, true);
    if (directionRaw !== 1n && directionRaw !== 2n) return null;
    const direction: "Coin2PC" | "PC2Coin" = directionRaw === 1n ? "PC2Coin" : "Coin2PC";

    let amountIn: bigint;
    let amountOut: bigint;

    if (logType === 3) {
      amountIn = view.getBigUint64(1, true);
      amountOut = view.getBigUint64(49, true);
    } else {
      amountIn = view.getBigUint64(49, true);
      amountOut = view.getBigUint64(9, true);
    }

    return { logType, direction, amountIn, amountOut };
  } catch {
    return null;
  }
}

export interface DecodedSplTransfer {
  readonly transferIndex: number;
  readonly source: string;
  readonly destination: string;
  readonly authority: string;
  readonly amount: bigint;
}

function parseSplTokenTransfer(
  instruction: DecodableInstruction,
  resolvedAccounts: readonly string[],
  transferIndex: number,
): DecodedSplTransfer | null {
  const progId = resolveProgramId(instruction, resolvedAccounts);
  if (progId !== SPL_TOKEN_PROGRAM_ID && progId !== TOKEN_2022_PROGRAM_ID) {
    return null;
  }

  const rawData = decodeInstructionData(instruction.data);
  if (!rawData || rawData.length < 9) return null;

  const tag = rawData[0];
  const accounts = resolveInstructionAccountsStrict(instruction, resolvedAccounts);
  if (!accounts) return null;

  if (tag === 3) {
    if (accounts.length < 3) return null;
    try {
      const amount = readU64LE(rawData, 1);
      return {
        transferIndex,
        source: accounts[0]!,
        destination: accounts[1]!,
        authority: accounts[2]!,
        amount,
      };
    } catch {
      return null;
    }
  } else if (tag === 12) {
    if (accounts.length < 4) return null;
    try {
      const amount = readU64LE(rawData, 1);
      return {
        transferIndex,
        source: accounts[0]!,
        destination: accounts[2]!,
        authority: accounts[3]!,
        amount,
      };
    } catch {
      return null;
    }
  }

  return null;
}

export interface RaydiumInvocationFrame {
  readonly invocationIndex: number;
  readonly programId: string;
  readonly depth: number;
  success: boolean;
  failed: boolean;
  isAmbiguous: boolean;
  descendantInvocationsCount: number;
  readonly rayLogs: DecodedRayLogSwap[];
}

/**
 * Parses logMessages into an execution call-stack structure to isolate each
 * program invocation and bind ray_log events strictly to their originating invocation.
 * Enforces strict LIFO execution: success/failed logs must match the active stack top.
 * Incomplete stacks, depth zero, invalid depth transitions, or unclosed child frames
 * fail closed and invalidate all Raydium frames.
 */
export function parseInvocationFrames(
  logMessages: readonly string[],
): readonly RaydiumInvocationFrame[] {
  const raydiumFrames: RaydiumInvocationFrame[] = [];
  const activeStack: { programId: string; depth: number; frame?: RaydiumInvocationFrame }[] = [];
  let raydiumCounter = 0;
  let stackInconsistent = false;

  for (const line of logMessages) {
    if (typeof line !== "string") {
      continue;
    }

    // 1. Program invocation: Program <ProgramId> invoke [<depth>]
    const invokeMatch = line.match(/^Program\s+([A-Za-z0-9]{32,44})\s+invoke\s+\[(\d+)\]/);
    if (invokeMatch) {
      const programId = invokeMatch[1]!;
      const depth = parseInt(invokeMatch[2]!, 10);

      // Validate depth: must be integer >= 1 and transition correctly
      const expectedDepth =
        activeStack.length === 0 ? 1 : activeStack[activeStack.length - 1]!.depth + 1;
      if (!Number.isInteger(depth) || depth < 1 || depth !== expectedDepth) {
        stackInconsistent = true;
      }

      // Any active Raydium frame on stack counts this new invoke as a descendant
      for (const entry of activeStack) {
        if (entry.frame) {
          entry.frame.descendantInvocationsCount++;
        }
      }

      if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
        const frame: RaydiumInvocationFrame = {
          invocationIndex: raydiumCounter++,
          programId,
          depth,
          success: false,
          failed: stackInconsistent,
          isAmbiguous: false,
          descendantInvocationsCount: 0,
          rayLogs: [],
        };
        raydiumFrames.push(frame);
        activeStack.push({ programId, depth, frame });
      } else {
        activeStack.push({ programId, depth });
      }
      continue;
    }

    // 2. Program success: Program <ProgramId> success
    const successMatch = line.match(/^Program\s+([A-Za-z0-9]{32,44})\s+success/);
    if (successMatch) {
      const programId = successMatch[1]!;
      // Strict LIFO: success must match the top active frame
      if (activeStack.length > 0 && activeStack[activeStack.length - 1]!.programId === programId) {
        const entry = activeStack.pop()!;
        if (entry.frame && !stackInconsistent) {
          entry.frame.success = true;
        }
      } else {
        // Strict LIFO violation (parent completing before child, or unexpected frame)
        stackInconsistent = true;
      }
      continue;
    }

    // 3. Program failed: Program <ProgramId> failed:
    const failMatch = line.match(/^Program\s+([A-Za-z0-9]{32,44})\s+failed:/);
    if (failMatch) {
      const programId = failMatch[1]!;
      if (activeStack.length > 0 && activeStack[activeStack.length - 1]!.programId === programId) {
        const entry = activeStack.pop()!;
        if (entry.frame) {
          entry.frame.failed = true;
          entry.frame.success = false;
        }
      } else {
        stackInconsistent = true;
      }
      continue;
    }

    // 4. Raydium ray_log line: attribute strictly to the CURRENTLY EXECUTING frame (top of active stack)
    const rayLog = parseRayLog(line);
    if (rayLog) {
      if (activeStack.length > 0) {
        const topOfStack = activeStack[activeStack.length - 1]!;
        if (topOfStack.programId === RAYDIUM_AMM_V4_PROGRAM_ID && topOfStack.frame) {
          if (topOfStack.frame.rayLogs.length > 0) {
            topOfStack.frame.isAmbiguous = true;
          }
          topOfStack.frame.rayLogs.push(rayLog);
        }
      }
    }
  }

  // Any inconsistency or unclosed frames remaining on stack invalidates all frames
  if (stackInconsistent || activeStack.length > 0) {
    for (const frame of raydiumFrames) {
      frame.failed = true;
      frame.success = false;
    }
  }

  return raydiumFrames;
}

function attributeTradeSide(
  direction: "Coin2PC" | "PC2Coin",
  orientation: RaydiumPairOrientation,
  candidateTokenMint?: string,
  baseMint?: string,
): TradeSide {
  if (orientation === "TOKEN_BASE_SOL_QUOTE") {
    return direction === "Coin2PC" ? "SELL" : "BUY";
  } else if (orientation === "SOL_BASE_TOKEN_QUOTE") {
    return direction === "Coin2PC" ? "BUY" : "SELL";
  } else if (orientation === "NON_SOL_PAIR") {
    if (candidateTokenMint && baseMint && candidateTokenMint === baseMint) {
      return direction === "Coin2PC" ? "SELL" : "BUY";
    }
    return direction === "Coin2PC" ? "BUY" : "SELL";
  } else {
    throw new Error(`[SWAP_DECODER] Unsupported pair orientation: ${orientation}`);
  }
}

interface SubtreeResolutionResult {
  readonly ok: boolean;
  readonly subtreeEnd?: number;
  readonly error?: {
    readonly reason: DecodeRaydiumSwapFailureReason;
    readonly message: string;
  };
}

/**
 * Resolves the invocation subtree boundary for an inner CPI Raydium instruction.
 * Distinguishes descendant instructions from later siblings or ancestors using
 * stackHeight (Solana CPI execution structure) and verified execution log depth/counts.
 * Does NOT rely on "next Raydium instruction".
 * Discrepancies fail closed with CONFLICTING_EVIDENCE; unresolvable boundaries fail with UNSUPPORTED_CALL_TREE.
 */
function resolveInvocationSubtree(
  innerInst: DecodableInstruction,
  innerIdx: number,
  relevantInners: readonly DecodableInstruction[],
  currentFrame: RaydiumInvocationFrame | null,
): SubtreeResolutionResult {
  let stackHeightEnd: number | null = null;
  let stackHeightMalformed = false;

  const hasStackHeight =
    typeof innerInst.stackHeight === "number" &&
    Number.isInteger(innerInst.stackHeight) &&
    innerInst.stackHeight >= 1;

  if (innerInst.stackHeight !== undefined && !hasStackHeight) {
    return {
      ok: false,
      error: {
        reason: "MALFORMED_INSTRUCTION_DATA",
        message: `Invalid stackHeight ${String(innerInst.stackHeight)} on inner instruction at index ${innerIdx}`,
      },
    };
  }

  if (hasStackHeight) {
    const raydiumHeight = innerInst.stackHeight!;
    for (let k = innerIdx + 1; k < relevantInners.length; k++) {
      const nextInst = relevantInners[k]!;
      if (
        typeof nextInst.stackHeight === "number" &&
        Number.isInteger(nextInst.stackHeight) &&
        nextInst.stackHeight >= 1
      ) {
        if (nextInst.stackHeight <= raydiumHeight) {
          stackHeightEnd = k;
          break;
        }
      } else {
        // Subsequent instruction lacks valid stackHeight
        stackHeightMalformed = true;
        break;
      }
    }
    if (!stackHeightMalformed && stackHeightEnd === null) {
      stackHeightEnd = relevantInners.length;
    }
  }

  let logEnd: number | null = null;
  if (currentFrame) {
    if (hasStackHeight && currentFrame.depth !== innerInst.stackHeight) {
      return {
        ok: false,
        error: {
          reason: "CONFLICTING_EVIDENCE",
          message: `Instruction stackHeight (${innerInst.stackHeight}) contradicts execution log depth (${currentFrame.depth}) for Raydium invocation at inner ${innerIdx}`,
        },
      };
    }

    const calculatedLogEnd = innerIdx + 1 + currentFrame.descendantInvocationsCount;
    if (calculatedLogEnd > relevantInners.length) {
      return {
        ok: false,
        error: {
          reason: "CONFLICTING_EVIDENCE",
          message: `Execution log reports ${currentFrame.descendantInvocationsCount} descendant invocations, but only ${relevantInners.length - (innerIdx + 1)} inner instructions remain`,
        },
      };
    }
    logEnd = calculatedLogEnd;
  }

  // Cross-check stackHeight and log evidence if both available
  if (stackHeightEnd !== null && logEnd !== null) {
    if (stackHeightEnd !== logEnd) {
      return {
        ok: false,
        error: {
          reason: "CONFLICTING_EVIDENCE",
          message: `Call-tree boundary from stackHeight (${stackHeightEnd}) contradicts execution log boundary (${logEnd}) for Raydium invocation at inner ${innerIdx}`,
        },
      };
    }
    return { ok: true, subtreeEnd: stackHeightEnd };
  }

  if (stackHeightEnd !== null) {
    return { ok: true, subtreeEnd: stackHeightEnd };
  }

  if (logEnd !== null) {
    if (currentFrame && currentFrame.descendantInvocationsCount > 0) {
      return { ok: true, subtreeEnd: logEnd };
    }
    if (innerIdx + 1 === relevantInners.length) {
      return { ok: true, subtreeEnd: logEnd };
    }
    return {
      ok: false,
      error: {
        reason: "UNSUPPORTED_CALL_TREE",
        message: `Execution logs report zero child invocations for inner instruction at index ${innerIdx}, but remaining instructions exist without stackHeight`,
      },
    };
  }

  return {
    ok: false,
    error: {
      reason: "UNSUPPORTED_CALL_TREE",
      message: `Cannot reliably establish invocation subtree boundary for inner instruction at index ${innerIdx} without valid stackHeight or execution log depth`,
    },
  };
}

/**
 * Pure decoder function: Decodes a transaction payload into normalized TradeEvent objects
 * bound strictly to the given Raydium pool context.
 */
export function decodeRaydiumTransactionSwaps(
  payload: DecodableTransactionPayload | unknown,
  poolContext: TrackedRaydiumPoolContext,
  options?: DecodeSwapOptions,
): DecodeRaydiumTransactionResult {
  // 1. Validate payload existence
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      reason: "INVALID_PAYLOAD",
      message: "Transaction payload must be a non-null object",
      events: [],
    };
  }

  // 2. Validate pool context at boundary
  try {
    validateTrackedPoolContext(poolContext);
  } catch (err) {
    return {
      ok: false,
      reason: "INVALID_POOL_CONTEXT",
      message: err instanceof Error ? err.message : String(err),
      events: [],
    };
  }

  const txPayload = payload as DecodableTransactionPayload;

  // 3. Validate signature presence
  const signature = txPayload.transaction?.signatures?.[0];
  if (!signature || typeof signature !== "string" || signature.trim().length === 0) {
    return {
      ok: false,
      reason: "MISSING_SIGNATURE",
      message: "Transaction payload is missing a valid signature at index 0",
      events: [],
    };
  }

  // 4. Validate slot
  const slot = txPayload.slot;
  if (typeof slot !== "number" || !Number.isFinite(slot) || !Number.isInteger(slot) || slot < 0) {
    return {
      ok: false,
      reason: "INVALID_SLOT",
      message: `Invalid transaction slot: ${String(slot)}`,
      signature,
      events: [],
    };
  }

  // 5. Require explicit transaction-success metadata
  if (!txPayload.meta || typeof txPayload.meta !== "object") {
    return {
      ok: false,
      reason: "TRANSACTION_NOT_SUCCESSFUL",
      message: `Transaction ${signature} lacks required meta object confirming execution success`,
      signature,
      slot,
      events: [],
    };
  }

  // Transaction must have explicit meta.err === null
  if (txPayload.meta.err !== null) {
    if (txPayload.meta.err === undefined) {
      return {
        ok: false,
        reason: "TRANSACTION_NOT_SUCCESSFUL",
        message: `Transaction ${signature} meta.err is undefined; explicit successful status (err: null) is required`,
        signature,
        slot,
        events: [],
      };
    }
    return {
      ok: false,
      reason: "TRANSACTION_FAILED",
      message: `Transaction ${signature} failed on-chain with error: ${JSON.stringify(txPayload.meta.err)}`,
      signature,
      slot,
      events: [],
    };
  }

  // 6. Upstream timestamp validation: missing time is NEVER manufactured
  if (
    typeof txPayload.blockTime !== "number" ||
    !Number.isFinite(txPayload.blockTime) ||
    txPayload.blockTime <= 0
  ) {
    return {
      ok: false,
      reason: "MISSING_UPSTREAM_TIMESTAMP",
      message: `Transaction ${signature} lacks an on-chain blockTime; upstream timestamp is unavailable (cannot manufacture upstream timestamp)`,
      signature,
      slot,
      events: [],
    };
  }

  const blockTimeSec = Math.floor(txPayload.blockTime);
  const eventTimestampMs = blockTimeSec * 1000;
  const timestampProvenance: TradeTimestampProvenance =
    options?.fallbackProvenance ?? "ON_CHAIN_BLOCK_TIME";

  const clock = options?.clock ?? Date.now;
  const receiptTimestampMs = options?.receiptTimestampMs ?? clock();

  // 7. Validate transaction message structure
  if (
    !txPayload.transaction?.message ||
    !Array.isArray(txPayload.transaction.message.accountKeys) ||
    !Array.isArray(txPayload.transaction.message.instructions)
  ) {
    return {
      ok: false,
      reason: "MALFORMED_INSTRUCTION_DATA",
      message: `Transaction ${signature} has malformed message structure`,
      signature,
      slot,
      events: [],
    };
  }

  // Validate every instruction in message.instructions
  for (let i = 0; i < txPayload.transaction.message.instructions.length; i++) {
    const inst = txPayload.transaction.message.instructions[i];
    if (
      !inst ||
      typeof inst !== "object" ||
      Array.isArray(inst) ||
      !Array.isArray((inst as DecodableInstruction).accounts) ||
      (inst as DecodableInstruction).data === undefined
    ) {
      return {
        ok: false,
        reason: "MALFORMED_INSTRUCTION_DATA",
        message: `Transaction ${signature} has a null or malformed instruction at index ${i}`,
        signature,
        slot,
        events: [],
      };
    }
  }

  // Validate meta.innerInstructions if present
  if (txPayload.meta.innerInstructions !== undefined && txPayload.meta.innerInstructions !== null) {
    if (!Array.isArray(txPayload.meta.innerInstructions)) {
      return {
        ok: false,
        reason: "MALFORMED_INSTRUCTION_DATA",
        message: `Transaction ${signature} meta.innerInstructions must be an array`,
        signature,
        slot,
        events: [],
      };
    }
    for (let g = 0; g < txPayload.meta.innerInstructions.length; g++) {
      const group = txPayload.meta.innerInstructions[g];
      if (
        !group ||
        typeof group !== "object" ||
        Array.isArray(group) ||
        typeof (group as DecodableInnerInstructionsGroup).index !== "number" ||
        !Number.isInteger((group as DecodableInnerInstructionsGroup).index) ||
        (group as DecodableInnerInstructionsGroup).index < 0 ||
        !Array.isArray((group as DecodableInnerInstructionsGroup).instructions)
      ) {
        return {
          ok: false,
          reason: "MALFORMED_INSTRUCTION_DATA",
          message: `Transaction ${signature} has a null or malformed innerInstructions group at index ${g}`,
          signature,
          slot,
          events: [],
        };
      }
      const groupInstructions = (group as DecodableInnerInstructionsGroup).instructions;
      for (let k = 0; k < groupInstructions.length; k++) {
        const innerInst = groupInstructions[k];
        if (
          !innerInst ||
          typeof innerInst !== "object" ||
          Array.isArray(innerInst) ||
          !Array.isArray((innerInst as DecodableInstruction).accounts) ||
          (innerInst as DecodableInstruction).data === undefined
        ) {
          return {
            ok: false,
            reason: "MALFORMED_INSTRUCTION_DATA",
            message: `Transaction ${signature} has a null or malformed inner instruction at group ${g}, index ${k}`,
            signature,
            slot,
            events: [],
          };
        }
      }
    }
  }

  // Validate meta.logMessages if present
  if (txPayload.meta.logMessages !== undefined && txPayload.meta.logMessages !== null) {
    if (!Array.isArray(txPayload.meta.logMessages)) {
      return {
        ok: false,
        reason: "MALFORMED_INSTRUCTION_DATA",
        message: `Transaction ${signature} meta.logMessages must be an array`,
        signature,
        slot,
        events: [],
      };
    }
    for (let i = 0; i < txPayload.meta.logMessages.length; i++) {
      if (typeof txPayload.meta.logMessages[i] !== "string") {
        return {
          ok: false,
          reason: "MALFORMED_INSTRUCTION_DATA",
          message: `Transaction ${signature} has a non-string log message at index ${i}`,
          signature,
          slot,
          events: [],
        };
      }
    }
  }

  // 8. Resolve transaction accounts (static + lookup tables)
  const resolvedAccounts = resolveTransactionAccounts(
    txPayload.transaction.message,
    txPayload.meta,
  );
  if (!resolvedAccounts) {
    return {
      ok: false,
      reason: "MALFORMED_INSTRUCTION_DATA",
      message: `Transaction ${signature} contains invalid or null account keys in accountKeys or loadedAddresses`,
      signature,
      slot,
      events: [],
    };
  }

  // 9. Parse invocation frames from logMessages to isolate ray_log events and proven success
  const logMessages = txPayload.meta.logMessages;
  const hasLogMessages = Array.isArray(logMessages) && logMessages.length > 0;
  const raydiumFrames = hasLogMessages ? parseInvocationFrames(logMessages) : [];
  let raydiumInvocationCursor = 0;

  // 10. Group inner instructions by parent outer instruction index
  const innerGroupsByParent = new Map<number, DecodableInstruction[]>();
  if (Array.isArray(txPayload.meta.innerInstructions)) {
    for (const group of txPayload.meta.innerInstructions) {
      const existing = innerGroupsByParent.get(group.index);
      if (existing) {
        existing.push(...group.instructions);
      } else {
        innerGroupsByParent.set(group.index, [...group.instructions]);
      }
    }
  }

  const decodedEvents: TradeEvent[] = [];
  let totalInstructionsScanned = 0;
  let matchingSwapsCount = 0;
  let nonMatchingPoolSwapsCount = 0;

  // Instruction decoder closure bound to exact invocation subtree
  const decodeInstructionIfRaydiumSwap = (
    inst: DecodableInstruction,
    outerInstructionIndex: number,
    swapIndex: number,
    isInnerCpi: boolean,
    invocationInnerInstructions: readonly DecodableInstruction[],
  ): {
    readonly isRaydium: boolean;
    readonly error?: { readonly reason: DecodeRaydiumSwapFailureReason; readonly message: string };
    readonly event?: TradeEvent;
  } => {
    const progId = resolveProgramId(inst, resolvedAccounts);
    if (progId !== RAYDIUM_AMM_V4_PROGRAM_ID) {
      return { isRaydium: false };
    }

    // Next Raydium invocation frame
    const currentFrame =
      raydiumFrames.length > raydiumInvocationCursor
        ? raydiumFrames[raydiumInvocationCursor++]
        : null;

    // Verify invocation success when logs are present
    if (hasLogMessages) {
      if (!currentFrame || !currentFrame.success || currentFrame.failed) {
        return {
          isRaydium: true,
          error: {
            reason: "INVOCATION_FAILED",
            message: `Raydium AMM v4 invocation at index ${raydiumInvocationCursor - 1} did not complete successfully in log messages`,
          },
        };
      }
    } else if (isInnerCpi) {
      // For inner CPI without log messages, success of inner execution cannot be proven
      return {
        isRaydium: true,
        error: {
          reason: "INVOCATION_FAILED",
          message:
            "Cannot prove successful execution of inner CPI swap without transaction logMessages",
        },
      };
    }

    const accounts = resolveInstructionAccountsStrict(inst, resolvedAccounts);
    if (!accounts) {
      return {
        isRaydium: true,
        error: {
          reason: "MALFORMED_INSTRUCTION_DATA",
          message: "Instruction account indices are invalid or out of bounds",
        },
      };
    }

    // Decode instruction data
    const rawData = decodeInstructionData(inst.data);
    if (!rawData || rawData.length < 17) {
      return {
        isRaydium: true,
        error: {
          reason: "MALFORMED_INSTRUCTION_DATA",
          message: `Raydium swap instruction data underflow: ${rawData ? rawData.length : 0} bytes (minimum 17 bytes required)`,
        },
      };
    }

    const tag = rawData[0]!;

    // Strict Layout Matrix Match
    const positions = matchSupportedSwapLayout(tag, accounts.length);
    if (!positions) {
      const isKnownTag =
        tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN ||
        tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT ||
        tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN_V2 ||
        tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT_V2;

      if (isKnownTag) {
        return {
          isRaydium: true,
          error: {
            reason: "UNSUPPORTED_LAYOUT",
            message: `Unsupported account count ${accounts.length} for Raydium instruction tag ${tag}`,
          },
        };
      }
      return {
        isRaydium: true,
        error: {
          reason: "UNSUPPORTED_INSTRUCTION",
          message: `Unsupported Raydium instruction tag: ${tag}`,
        },
      };
    }

    // Account positions verified from layout
    const instructionPoolId = accounts[positions.poolIdIndex]!;
    if (instructionPoolId !== poolContext.poolId) {
      nonMatchingPoolSwapsCount++;
      return { isRaydium: true }; // Swap on a different pool
    }

    const baseVaultAccount = accounts[positions.baseVaultIndex]!;
    const quoteVaultAccount = accounts[positions.quoteVaultIndex]!;
    const userSourceAccount = accounts[positions.userSourceIndex]!;
    const userDestinationAccount = accounts[positions.userDestinationIndex]!;

    // Strict Vault Binding
    if (
      baseVaultAccount !== poolContext.baseVault ||
      quoteVaultAccount !== poolContext.quoteVault
    ) {
      return {
        isRaydium: true,
        error: {
          reason: "VAULT_MISMATCH",
          message: `Swap instruction vault accounts (${baseVaultAccount}, ${quoteVaultAccount}) do not match validated pool vaults (${poolContext.baseVault}, ${poolContext.quoteVault})`,
        },
      };
    }

    // Scoped SPL token transfers: strictly parsed from invocationInnerInstructions
    const invocationTransfers: DecodedSplTransfer[] = [];
    for (let i = 0; i < invocationInnerInstructions.length; i++) {
      const t = parseSplTokenTransfer(invocationInnerInstructions[i]!, resolvedAccounts, i);
      if (t) {
        invocationTransfers.push(t);
      }
    }

    let matchedInTransfer: DecodedSplTransfer | null = null;
    let matchedOutTransfer: DecodedSplTransfer | null = null;

    for (const t of invocationTransfers) {
      if (t.source === userSourceAccount) {
        if (t.destination === poolContext.baseVault || t.destination === poolContext.quoteVault) {
          if (matchedInTransfer !== null) {
            return {
              isRaydium: true,
              error: {
                reason: "CONFLICTING_EVIDENCE",
                message: `Multiple matching in-transfers detected for Raydium invocation at outer ${outerInstructionIndex}, inner ${swapIndex}`,
              },
            };
          }
          matchedInTransfer = t;
        }
      }
      if (t.destination === userDestinationAccount) {
        if (t.source === poolContext.quoteVault || t.source === poolContext.baseVault) {
          if (matchedOutTransfer !== null) {
            return {
              isRaydium: true,
              error: {
                reason: "CONFLICTING_EVIDENCE",
                message: `Multiple matching out-transfers detected for Raydium invocation at outer ${outerInstructionIndex}, inner ${swapIndex}`,
              },
            };
          }
          matchedOutTransfer = t;
        }
      }
    }

    if ((matchedInTransfer && !matchedOutTransfer) || (!matchedInTransfer && matchedOutTransfer)) {
      return {
        isRaydium: true,
        error: {
          reason: "CONFLICTING_EVIDENCE",
          message: `Incomplete token transfers detected for Raydium invocation at outer ${outerInstructionIndex}, inner ${swapIndex}`,
        },
      };
    }

    let directionFromTransfers: "Coin2PC" | "PC2Coin" | null = null;
    let transferInAmount: bigint | undefined;
    let transferOutAmount: bigint | undefined;
    let tokenAmountFromTransfers: bigint | undefined;
    let solAmountFromTransfers: bigint | undefined;

    if (matchedInTransfer && matchedOutTransfer) {
      transferInAmount = matchedInTransfer.amount;
      transferOutAmount = matchedOutTransfer.amount;
      const isCandidateBase = poolContext.candidateTokenMint === poolContext.baseMint;

      if (
        matchedInTransfer.destination === poolContext.baseVault &&
        matchedOutTransfer.source === poolContext.quoteVault
      ) {
        directionFromTransfers = "Coin2PC";
        const amountBase = matchedInTransfer.amount;
        const amountQuote = matchedOutTransfer.amount;
        tokenAmountFromTransfers = isCandidateBase ? amountBase : amountQuote;
        const quoteAmt = isCandidateBase ? amountQuote : amountBase;
        solAmountFromTransfers = poolContext.quoteTokenMint === WSOL_MINT ? quoteAmt : undefined;
      } else if (
        matchedInTransfer.destination === poolContext.quoteVault &&
        matchedOutTransfer.source === poolContext.baseVault
      ) {
        directionFromTransfers = "PC2Coin";
        const amountBase = matchedOutTransfer.amount;
        const amountQuote = matchedInTransfer.amount;
        tokenAmountFromTransfers = isCandidateBase ? amountBase : amountQuote;
        const quoteAmt = isCandidateBase ? amountQuote : amountBase;
        solAmountFromTransfers = poolContext.quoteTokenMint === WSOL_MINT ? quoteAmt : undefined;
      } else {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Transfer vault endpoints do not match pool pair structure for invocation at outer ${outerInstructionIndex}, inner ${swapIndex}`,
          },
        };
      }
    }

    // Inspect ray_log strictly bound to this invocation frame
    let rayLog: DecodedRayLogSwap | null = null;
    if (currentFrame) {
      if (currentFrame.isAmbiguous || currentFrame.rayLogs.length > 1) {
        return {
          isRaydium: true,
          error: {
            reason: "AMBIGUOUS_DIRECTION",
            message: `Ambiguous multiple ray_logs (${currentFrame.rayLogs.length}) within single Raydium invocation frame`,
          },
        };
      }
      if (currentFrame.rayLogs.length === 1) {
        rayLog = currentFrame.rayLogs[0]!;
      }
    }

    let directionFromRayLog: "Coin2PC" | "PC2Coin" | null = null;
    let tokenAmountFromRayLog: bigint | undefined;
    let solAmountFromRayLog: bigint | undefined;

    const isBaseInTag =
      tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN ||
      tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN_V2;
    const isBaseOutTag =
      tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT ||
      tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT_V2;

    if (rayLog) {
      // Validate log type matches instruction tag
      if (isBaseInTag && rayLog.logType !== 3) {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Instruction tag ${tag} expects logType 3 (SwapBaseIn), but ray_log reports logType ${rayLog.logType}`,
          },
        };
      }
      if (isBaseOutTag && rayLog.logType !== 4) {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Instruction tag ${tag} expects logType 4 (SwapBaseOut), but ray_log reports logType ${rayLog.logType}`,
          },
        };
      }

      directionFromRayLog = rayLog.direction;
      const isCandidateBase = poolContext.candidateTokenMint === poolContext.baseMint;
      if (isCandidateBase) {
        tokenAmountFromRayLog =
          directionFromRayLog === "Coin2PC" ? rayLog.amountIn : rayLog.amountOut;
        const quoteAmt = directionFromRayLog === "Coin2PC" ? rayLog.amountOut : rayLog.amountIn;
        solAmountFromRayLog = poolContext.quoteTokenMint === WSOL_MINT ? quoteAmt : undefined;
      } else {
        tokenAmountFromRayLog =
          directionFromRayLog === "Coin2PC" ? rayLog.amountOut : rayLog.amountIn;
        const quoteAmt = directionFromRayLog === "Coin2PC" ? rayLog.amountIn : rayLog.amountOut;
        solAmountFromRayLog = poolContext.quoteTokenMint === WSOL_MINT ? quoteAmt : undefined;
      }
    }

    // Cross-check: transfers vs ray_log direction & exact quantities
    if (directionFromTransfers && directionFromRayLog) {
      if (directionFromTransfers !== directionFromRayLog) {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Transfer direction (${directionFromTransfers}) contradicts ray_log direction (${directionFromRayLog}) for invocation ${currentFrame?.invocationIndex}`,
          },
        };
      }
      if (
        transferInAmount !== undefined &&
        transferOutAmount !== undefined &&
        rayLog &&
        (transferInAmount !== rayLog.amountIn || transferOutAmount !== rayLog.amountOut)
      ) {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Transfer quantities (in: ${transferInAmount}, out: ${transferOutAmount}) contradict ray_log quantities (in: ${rayLog.amountIn}, out: ${rayLog.amountOut}) for invocation ${currentFrame?.invocationIndex}`,
          },
        };
      }
    }

    // Cross-check against instruction parameters
    if (isBaseInTag) {
      const instAmountIn = readU64LE(rawData, 1);
      const instMinimumOut = readU64LE(rawData, 9);

      if (transferInAmount !== undefined && transferInAmount !== instAmountIn) {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Transfer in amount (${transferInAmount}) does not match instruction amountIn (${instAmountIn})`,
          },
        };
      }
      if (transferOutAmount !== undefined && transferOutAmount < instMinimumOut) {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Transfer out amount (${transferOutAmount}) is below instruction minimumOut (${instMinimumOut})`,
          },
        };
      }
      if (rayLog) {
        if (rayLog.amountIn !== instAmountIn) {
          return {
            isRaydium: true,
            error: {
              reason: "CONFLICTING_EVIDENCE",
              message: `ray_log amountIn (${rayLog.amountIn}) does not match instruction amountIn (${instAmountIn})`,
            },
          };
        }
        if (rayLog.amountOut < instMinimumOut) {
          return {
            isRaydium: true,
            error: {
              reason: "CONFLICTING_EVIDENCE",
              message: `ray_log amountOut (${rayLog.amountOut}) is below instruction minimumOut (${instMinimumOut})`,
            },
          };
        }
      }
    } else if (isBaseOutTag) {
      const instMaxAmountIn = readU64LE(rawData, 1);
      const instAmountOut = readU64LE(rawData, 9);

      if (transferOutAmount !== undefined && transferOutAmount !== instAmountOut) {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Transfer out amount (${transferOutAmount}) does not match instruction amountOut (${instAmountOut})`,
          },
        };
      }
      if (transferInAmount !== undefined && transferInAmount > instMaxAmountIn) {
        return {
          isRaydium: true,
          error: {
            reason: "CONFLICTING_EVIDENCE",
            message: `Transfer in amount (${transferInAmount}) exceeds instruction maxAmountIn (${instMaxAmountIn})`,
          },
        };
      }
      if (rayLog) {
        if (rayLog.amountOut !== instAmountOut) {
          return {
            isRaydium: true,
            error: {
              reason: "CONFLICTING_EVIDENCE",
              message: `ray_log amountOut (${rayLog.amountOut}) does not match instruction amountOut (${instAmountOut})`,
            },
          };
        }
        if (rayLog.amountIn > instMaxAmountIn) {
          return {
            isRaydium: true,
            error: {
              reason: "CONFLICTING_EVIDENCE",
              message: `ray_log amountIn (${rayLog.amountIn}) exceeds instruction maxAmountIn (${instMaxAmountIn})`,
            },
          };
        }
      }
    }

    const direction = directionFromTransfers ?? directionFromRayLog;
    const tokenAmount = tokenAmountFromTransfers ?? tokenAmountFromRayLog;
    const solAmount = solAmountFromTransfers ?? solAmountFromRayLog;

    if (!direction) {
      return {
        isRaydium: true,
        error: {
          reason: "AMBIGUOUS_DIRECTION",
          message:
            "Cannot unambiguously determine swap direction from bound invocation transfers or ray_log",
        },
      };
    }

    const side = attributeTradeSide(
      direction,
      poolContext.orientation,
      poolContext.candidateTokenMint,
      poolContext.baseMint,
    );
    const eventId = `${signature}:${outerInstructionIndex}:${swapIndex}`;

    const tradeEvent: TradeEvent = Object.freeze({
      eventId,
      signature,
      swapIndex,
      outerInstructionIndex,
      poolId: poolContext.poolId,
      tokenMint: poolContext.candidateTokenMint,
      side,
      slot,
      blockTimeSec,
      eventTimestampMs,
      receiptTimestampMs,
      timestampProvenance,
      ...(tokenAmount !== undefined ? { tokenAmount } : {}),
      ...(solAmount !== undefined ? { solAmount } : {}),
    });

    matchingSwapsCount++;
    return { isRaydium: true, event: tradeEvent };
  };

  // Scan top-level instructions
  const topLevelInstructions = txPayload.transaction.message.instructions ?? [];

  for (let outerIdx = 0; outerIdx < topLevelInstructions.length; outerIdx++) {
    totalInstructionsScanned++;
    const inst = topLevelInstructions[outerIdx]!;
    const relevantInners = innerGroupsByParent.get(outerIdx) ?? [];

    const result = decodeInstructionIfRaydiumSwap(inst, outerIdx, 0, false, relevantInners);
    if (result.isRaydium) {
      if (result.error) {
        return {
          ok: false,
          reason: result.error.reason,
          message: result.error.message,
          signature,
          slot,
          events: [],
        };
      }
      if (result.event) {
        decodedEvents.push(result.event);
      }
    }

    // Scan inner instructions under this outer instruction
    for (let innerIdx = 0; innerIdx < relevantInners.length; innerIdx++) {
      totalInstructionsScanned++;
      const innerInst = relevantInners[innerIdx]!;
      const progId = resolveProgramId(innerInst, resolvedAccounts);
      if (progId !== RAYDIUM_AMM_V4_PROGRAM_ID) {
        continue;
      }

      // For inner CPI without log messages, success of inner execution cannot be proven
      if (!hasLogMessages) {
        return {
          ok: false,
          reason: "INVOCATION_FAILED",
          message:
            "Cannot prove successful execution of inner CPI swap without transaction logMessages",
          signature,
          slot,
          events: [],
        };
      }

      // Peek corresponding Raydium frame to evaluate invocation subtree boundary
      const currentFrame =
        raydiumFrames.length > raydiumInvocationCursor
          ? raydiumFrames[raydiumInvocationCursor]!
          : null;

      const subtreeResult = resolveInvocationSubtree(
        innerInst,
        innerIdx,
        relevantInners,
        currentFrame,
      );

      if (!subtreeResult.ok) {
        return {
          ok: false,
          reason: subtreeResult.error!.reason,
          message: subtreeResult.error!.message,
          signature,
          slot,
          events: [],
        };
      }

      const invocationInnerSlice = relevantInners.slice(innerIdx + 1, subtreeResult.subtreeEnd);

      const innerResult = decodeInstructionIfRaydiumSwap(
        innerInst,
        outerIdx,
        innerIdx,
        true,
        invocationInnerSlice,
      );
      if (innerResult.isRaydium) {
        if (innerResult.error) {
          return {
            ok: false,
            reason: innerResult.error.reason,
            message: innerResult.error.message,
            signature,
            slot,
            events: [],
          };
        }
        if (innerResult.event) {
          decodedEvents.push(innerResult.event);
        }
      }
    }
  }

  if (decodedEvents.length === 0) {
    return {
      ok: false,
      reason: "NO_MATCHING_SWAPS_FOUND",
      message: `No matching Raydium AMM v4 swaps found for pool ${poolContext.poolId} in transaction ${signature}`,
      signature,
      slot,
      events: [],
    };
  }

  return {
    ok: true,
    signature,
    slot,
    events: Object.freeze(decodedEvents),
    diagnostics: {
      totalInstructionsScanned,
      matchingSwapsCount,
      nonMatchingPoolSwapsCount,
    },
  };
}

/**
 * Normalization Adapter that bridges decoded Raydium AMM v4 transactions directly
 * into RollingTradeFlowTracker.
 *
 * CRITICAL GUARANTEE: Ingesting transactions NEVER establishes window coverage.
 * Coverage remains strictly anchored to source-supported stream checkpoints.
 */
export class RaydiumAmmV4SwapNormalizationAdapter {
  private readonly poolContext: TrackedRaydiumPoolContext;

  public constructor(poolContext: TrackedRaydiumPoolContext) {
    validateTrackedPoolContext(poolContext);
    this.poolContext = Object.freeze({ ...poolContext });
  }

  public getPoolContext(): TrackedRaydiumPoolContext {
    return this.poolContext;
  }

  /**
   * Decodes a transaction payload and ingests any matching swaps into the provided tracker.
   * Handles malformed inputs cleanly without throwing exceptions.
   */
  public ingestTransaction(
    payload: DecodableTransactionPayload | unknown,
    tracker: RollingTradeFlowTracker,
    options?: DecodeSwapOptions,
  ): IngestTransactionResult {
    let signature = "unknown-signature";
    if (payload && typeof payload === "object") {
      const p = payload as { transaction?: { signatures?: readonly unknown[] } };
      const sigCandidate = p.transaction?.signatures?.[0];
      if (typeof sigCandidate === "string" && sigCandidate.trim().length > 0) {
        signature = sigCandidate;
      }
    }

    const decodeResult = decodeRaydiumTransactionSwaps(payload, this.poolContext, options);

    if (!decodeResult.ok) {
      return {
        signature: decodeResult.signature ?? signature,
        decodeResult,
        ingestedCount: 0,
        ingestFailures: [],
      };
    }

    let ingestedCount = 0;
    const ingestFailures: {
      readonly eventId: string;
      readonly reason: string;
      readonly message: string;
    }[] = [];

    for (const event of decodeResult.events) {
      const ingestRes: IngestTradeResult = tracker.ingestTrade(event);
      if (ingestRes.ok) {
        ingestedCount++;
      } else {
        ingestFailures.push({
          eventId: event.eventId,
          reason: ingestRes.reason,
          message: ingestRes.message,
        });
      }
    }

    return {
      signature,
      decodeResult,
      ingestedCount,
      ingestFailures: Object.freeze(ingestFailures),
    };
  }
}
