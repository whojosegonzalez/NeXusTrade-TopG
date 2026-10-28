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
 */
export function decodeInstructionData(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (Array.isArray(data)) {
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
      try {
        const b64 = Buffer.from(trimmed, "base64");
        return new Uint8Array(b64.buffer, b64.byteOffset, b64.byteLength);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Resolves static and lookup-table accounts from message and meta into a flat array of Base58 strings.
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
): string[] {
  const accounts: string[] = [];
  if (Array.isArray(message.accountKeys)) {
    for (const key of message.accountKeys) {
      if (typeof key === "string") {
        accounts.push(key);
      } else if (key && typeof key.pubkey === "string") {
        accounts.push(key.pubkey);
      }
    }
  }
  if (meta?.loadedAddresses) {
    if (Array.isArray(meta.loadedAddresses.writable)) {
      for (const key of meta.loadedAddresses.writable) {
        if (typeof key === "string") accounts.push(key);
      }
    }
    if (Array.isArray(meta.loadedAddresses.readonly)) {
      for (const key of meta.loadedAddresses.readonly) {
        if (typeof key === "string") accounts.push(key);
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
  readonly rayLogs: DecodedRayLogSwap[];
}

/**
 * Parses logMessages into an execution call-stack structure to isolate each
 * program invocation and bind ray_log events strictly to their originating invocation.
 */
export function parseInvocationFrames(
  logMessages: readonly string[],
): readonly RaydiumInvocationFrame[] {
  const raydiumFrames: RaydiumInvocationFrame[] = [];
  const activeStack: { programId: string; depth: number; frame?: RaydiumInvocationFrame }[] = [];
  let raydiumCounter = 0;

  for (const line of logMessages) {
    // 1. Program invocation: Program <ProgramId> invoke [<depth>]
    const invokeMatch = line.match(/^Program\s+([A-Za-z0-9]{32,44})\s+invoke\s+\[(\d+)\]/);
    if (invokeMatch) {
      const programId = invokeMatch[1]!;
      const depth = parseInt(invokeMatch[2]!, 10);

      if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
        const frame: RaydiumInvocationFrame = {
          invocationIndex: raydiumCounter++,
          programId,
          depth,
          success: false,
          failed: false,
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
      // Find matching frame from top of stack
      for (let i = activeStack.length - 1; i >= 0; i--) {
        if (activeStack[i]!.programId === programId) {
          const entry = activeStack[i]!;
          if (entry.frame) {
            entry.frame.success = true;
          }
          activeStack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    // 3. Program failed: Program <ProgramId> failed:
    const failMatch = line.match(/^Program\s+([A-Za-z0-9]{32,44})\s+failed:/);
    if (failMatch) {
      const programId = failMatch[1]!;
      for (let i = activeStack.length - 1; i >= 0; i--) {
        if (activeStack[i]!.programId === programId) {
          const entry = activeStack[i]!;
          if (entry.frame) {
            entry.frame.failed = true;
          }
          activeStack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    // 4. Raydium ray_log line: attribute to current active Raydium frame on stack
    const rayLog = parseRayLog(line);
    if (rayLog) {
      for (let i = activeStack.length - 1; i >= 0; i--) {
        const entry = activeStack[i]!;
        if (entry.frame && entry.programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
          entry.frame.rayLogs.push(rayLog);
          break;
        }
      }
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
    !txPayload.transaction.message ||
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

  // 8. Resolve transaction accounts (static + lookup tables)
  const resolvedAccounts = resolveTransactionAccounts(
    txPayload.transaction.message,
    txPayload.meta,
  );

  // 9. Parse invocation frames from logMessages to isolate ray_log events and proven success
  const logMessages = txPayload.meta.logMessages;
  const hasLogMessages = Array.isArray(logMessages) && logMessages.length > 0;
  const raydiumFrames = hasLogMessages ? parseInvocationFrames(logMessages) : [];
  let raydiumInvocationCursor = 0;

  // Track consumed transfers to ensure distinct invocation attribution
  const consumedTransferIndices = new Set<number>();

  // 10. Parse all SPL token transfers across all inner instructions
  const allSplTransfers: DecodedSplTransfer[] = [];
  let globalTransferCounter = 0;
  if (Array.isArray(txPayload.meta.innerInstructions)) {
    for (const group of txPayload.meta.innerInstructions) {
      if (Array.isArray(group.instructions)) {
        for (const innerInst of group.instructions) {
          const transfer = parseSplTokenTransfer(
            innerInst,
            resolvedAccounts,
            globalTransferCounter++,
          );
          if (transfer) {
            allSplTransfers.push(transfer);
          }
        }
      }
    }
  }

  const decodedEvents: TradeEvent[] = [];
  let totalInstructionsScanned = 0;
  let matchingSwapsCount = 0;
  let nonMatchingPoolSwapsCount = 0;

  // Instruction decoder closure
  const decodeInstructionIfRaydiumSwap = (
    inst: DecodableInstruction,
    outerInstructionIndex: number,
    swapIndex: number,
    isInnerCpi: boolean,
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

    // Determine direction and exact amounts from scoped evidence
    let directionFromTransfers: "Coin2PC" | "PC2Coin" | null = null;
    let tokenAmountFromTransfers: bigint | undefined;
    let solAmountFromTransfers: bigint | undefined;

    // Search for unconsumed transfers matching this invocation's userSource, userDestination, baseVault, quoteVault
    let matchedInIdx = -1;
    let matchedOutIdx = -1;

    for (let i = 0; i < allSplTransfers.length; i++) {
      if (consumedTransferIndices.has(i)) continue;
      const t = allSplTransfers[i]!;

      // Transfer into pool: source must be userSource, destination must be baseVault or quoteVault
      if (t.source === userSourceAccount) {
        if (t.destination === poolContext.baseVault) {
          matchedInIdx = i;
        } else if (t.destination === poolContext.quoteVault) {
          matchedInIdx = i;
        }
      }

      // Transfer out of pool: destination must be userDestination, source must be quoteVault or baseVault
      if (t.destination === userDestinationAccount) {
        if (t.source === poolContext.quoteVault) {
          matchedOutIdx = i;
        } else if (t.source === poolContext.baseVault) {
          matchedOutIdx = i;
        }
      }

      if (matchedInIdx !== -1 && matchedOutIdx !== -1) {
        break;
      }
    }

    if (matchedInIdx !== -1 && matchedOutIdx !== -1) {
      const inTransfer = allSplTransfers[matchedInIdx]!;
      const outTransfer = allSplTransfers[matchedOutIdx]!;

      const isCandidateBase = poolContext.candidateTokenMint === poolContext.baseMint;
      if (
        inTransfer.destination === poolContext.baseVault &&
        outTransfer.source === poolContext.quoteVault
      ) {
        directionFromTransfers = "Coin2PC";
        const amountBase = inTransfer.amount;
        const amountQuote = outTransfer.amount;
        tokenAmountFromTransfers = isCandidateBase ? amountBase : amountQuote;
        const quoteAmt = isCandidateBase ? amountQuote : amountBase;
        solAmountFromTransfers = poolContext.quoteTokenMint === WSOL_MINT ? quoteAmt : undefined;
        consumedTransferIndices.add(matchedInIdx);
        consumedTransferIndices.add(matchedOutIdx);
      } else if (
        inTransfer.destination === poolContext.quoteVault &&
        outTransfer.source === poolContext.baseVault
      ) {
        directionFromTransfers = "PC2Coin";
        const amountBase = outTransfer.amount;
        const amountQuote = inTransfer.amount;
        tokenAmountFromTransfers = isCandidateBase ? amountBase : amountQuote;
        const quoteAmt = isCandidateBase ? amountQuote : amountBase;
        solAmountFromTransfers = poolContext.quoteTokenMint === WSOL_MINT ? quoteAmt : undefined;
        consumedTransferIndices.add(matchedInIdx);
        consumedTransferIndices.add(matchedOutIdx);
      }
    }

    // Inspect ray_log strictly bound to this invocation frame
    let directionFromRayLog: "Coin2PC" | "PC2Coin" | null = null;
    let tokenAmountFromRayLog: bigint | undefined;
    let solAmountFromRayLog: bigint | undefined;

    if (currentFrame && currentFrame.rayLogs.length > 0) {
      const rayLog = currentFrame.rayLogs[0]!;
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

    // Reconcile evidence and fail closed on conflict
    if (
      directionFromTransfers &&
      directionFromRayLog &&
      directionFromTransfers !== directionFromRayLog
    ) {
      return {
        isRaydium: true,
        error: {
          reason: "CONFLICTING_EVIDENCE",
          message: `Transfer direction (${directionFromTransfers}) contradicts ray_log direction (${directionFromRayLog}) for invocation ${currentFrame?.invocationIndex}`,
        },
      };
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
  const innerGroups = new Map<number, readonly DecodableInstruction[]>();
  if (Array.isArray(txPayload.meta.innerInstructions)) {
    for (const group of txPayload.meta.innerInstructions) {
      if (typeof group.index === "number" && Array.isArray(group.instructions)) {
        innerGroups.set(group.index, group.instructions);
      }
    }
  }

  for (let outerIdx = 0; outerIdx < topLevelInstructions.length; outerIdx++) {
    totalInstructionsScanned++;
    const inst = topLevelInstructions[outerIdx]!;

    const result = decodeInstructionIfRaydiumSwap(inst, outerIdx, 0, false);
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
    const relevantInners = innerGroups.get(outerIdx) ?? [];
    for (let innerIdx = 0; innerIdx < relevantInners.length; innerIdx++) {
      totalInstructionsScanned++;
      const innerInst = relevantInners[innerIdx]!;

      const innerResult = decodeInstructionIfRaydiumSwap(innerInst, outerIdx, innerIdx, true);
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
   */
  public ingestTransaction(
    payload: DecodableTransactionPayload | unknown,
    tracker: RollingTradeFlowTracker,
    options?: DecodeSwapOptions,
  ): IngestTransactionResult {
    const rawTx = payload as DecodableTransactionPayload | undefined;
    const signature = rawTx?.transaction?.signatures?.[0] ?? "unknown-signature";
    const decodeResult = decodeRaydiumTransactionSwaps(payload, this.poolContext, options);

    if (!decodeResult.ok) {
      return {
        signature,
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
