/**
 * Phase 12.94-D Milestone D.3.3: Offline Raydium AMM v4 Swap Decoder & Normalization Adapter
 *
 * Implements authoritative, strictly offline transaction swap decoding and normalization
 * producing immutable TradeEvent inputs for RollingTradeFlowTracker.
 *
 * Pinned Official Raydium Source Code References:
 * - Repository: https://github.com/raydium-io/raydium-amm
 * - Program ID: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 (RAYDIUM_AMM_V4_PROGRAM_ID)
 * - Instruction Definitions (program/src/instruction.rs):
 *     - SwapBaseIn: tag 9 (u8), amount_in (u64 LE, offset 1..9), minimum_out (u64 LE, offset 9..17)
 *     - SwapBaseOut: tag 11 (u8), max_in (u64 LE, offset 1..9), amount_out (u64 LE, offset 9..17)
 *     - SwapBaseInV2: tag 16 (u8), amount_in (u64 LE, offset 1..9), minimum_out (u64 LE, offset 9..17)
 *     - SwapBaseOutV2: tag 17 (u8), max_in (u64 LE, offset 1..9), amount_out (u64 LE, offset 9..17)
 * - Instruction Account Layouts (program/src/processor.rs):
 *     - Standard 17/18-account layout (process_swap_base_in / process_swap_base_out):
 *         0: token_program
 *         1: amm (pool state account / poolId)
 *         2: amm_authority
 *         3: amm_open_orders
 *         4: amm_coin_vault (baseVault)
 *         5: amm_pc_vault (quoteVault)
 *         6: market_program
 *         7: market
 *         8: market_bids
 *         9: market_asks
 *         10: market_event_queue
 *         11: market_coin_vault
 *         12: market_pc_vault
 *         13: market_vault_signer
 *         14: user_source (user source token account)
 *         15: user_destination (user destination token account)
 *         16: user_source_owner (user wallet signer)
 *     - Clean 8-account layout (SwapBaseInV2 / SwapBaseOutV2):
 *         0: token_program
 *         1: amm (pool state account / poolId)
 *         2: amm_authority
 *         3: amm_coin_vault (baseVault)
 *         4: amm_pc_vault (quoteVault)
 *         5: user_source
 *         6: user_destination
 *         7: user_source_owner
 * - Swap Directions (program/src/math.rs):
 *     - SwapDirection::PC2Coin = 1u64 (Quote -> Coin/Base)
 *     - SwapDirection::Coin2PC = 2u64 (Coin/Base -> Quote)
 * - Program Logs (program/src/log.rs):
 *     - SwapBaseInLog: log_type: 3 (u8), direction: u64 LE at offset 17..25 (1 = PC2Coin, 2 = Coin2PC)
 *     - SwapBaseOutLog: log_type: 4 (u8), direction: u64 LE at offset 17..25 (1 = PC2Coin, 2 = Coin2PC)
 *
 * CRITICAL INVARIANTS:
 * 1. Offline Execution: Accepts injected/retained transaction payloads only; zero networking or live subscriptions.
 * 2. Strict Pool Binding: Binds every swap to exact tracked pool, candidate mint, quote mint, and vault accounts.
 * 3. Direction Attribution: Attributes BUY/SELL per individual swap and account context relative to candidate token;
 *    NEVER infers direction from transaction-wide net balances.
 * 4. Coordinate Preservation: Unique coordinates (${signature}:${outerInstructionIndex}:${swapIndex}) distinguish
 *    multiple swaps within one transaction, including inner/CPI instructions and versioned transactions.
 * 5. Temporal Integrity: Preserves upstream slot, block time, source precision, and host receipt time.
 *    Missing upstream block time is NEVER manufactured.
 * 6. Coverage Preservation: Decoding transactions populates trade events, but NEVER advances observation
 *    checkpoints or fabricates complete window coverage.
 */

import { decodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import type { D23RaydiumAmmV4State, RaydiumPairOrientation } from "../research/pilot/PilotTypes.js";
import {
  isCanonicalSolanaBase58,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";
import type {
  IngestTradeResult,
  RollingTradeFlowTracker,
  TradeEvent,
  TradeSide,
  TradeTimestampProvenance,
} from "./RollingTradeFlowTracker.js";

export const RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES = Object.freeze({
  repository: "https://github.com/raydium-io/raydium-amm",
  programId: RAYDIUM_AMM_V4_PROGRAM_ID,
  instructionFile: "program/src/instruction.rs",
  processorFile: "program/src/processor.rs",
  mathFile: "program/src/math.rs",
  logFile: "program/src/log.rs",
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

export function createTrackedRaydiumPoolContext(
  state: D23RaydiumAmmV4State,
  candidateTokenMint: string,
  quoteTokenMint: string,
  orientation: RaydiumPairOrientation,
  poolAddress?: string,
): TrackedRaydiumPoolContext {
  if (
    !isCanonicalSolanaBase58(candidateTokenMint) ||
    !isCanonicalSolanaBase58(quoteTokenMint) ||
    !isCanonicalSolanaBase58(state.baseVault) ||
    !isCanonicalSolanaBase58(state.quoteVault) ||
    !isCanonicalSolanaBase58(state.baseMint) ||
    !isCanonicalSolanaBase58(state.quoteMint)
  ) {
    throw new Error(
      "[SWAP_DECODER_INIT] Invalid canonical Solana Base58 public key in pool context",
    );
  }

  // Cross-validate orientation and mint identities
  if (orientation === "TOKEN_BASE_SOL_QUOTE") {
    if (state.baseMint !== candidateTokenMint) {
      throw new Error(
        `[SWAP_DECODER_INIT] TOKEN_BASE_SOL_QUOTE orientation expects baseMint to match candidate (${candidateTokenMint}), got: ${state.baseMint}`,
      );
    }
    if (state.quoteMint !== quoteTokenMint) {
      throw new Error(
        `[SWAP_DECODER_INIT] TOKEN_BASE_SOL_QUOTE orientation expects quoteMint to match quote (${quoteTokenMint}), got: ${state.quoteMint}`,
      );
    }
  } else if (orientation === "SOL_BASE_TOKEN_QUOTE") {
    if (state.baseMint !== quoteTokenMint) {
      throw new Error(
        `[SWAP_DECODER_INIT] SOL_BASE_TOKEN_QUOTE orientation expects baseMint to match quote (${quoteTokenMint}), got: ${state.baseMint}`,
      );
    }
    if (state.quoteMint !== candidateTokenMint) {
      throw new Error(
        `[SWAP_DECODER_INIT] SOL_BASE_TOKEN_QUOTE orientation expects quoteMint to match candidate (${candidateTokenMint}), got: ${state.quoteMint}`,
      );
    }
  } else {
    throw new Error(`[SWAP_DECODER_INIT] Unsupported orientation: ${orientation}`);
  }

  const poolId = poolAddress ?? state.baseVault; // if explicit pool address not provided

  return Object.freeze({
    poolId,
    candidateTokenMint,
    quoteTokenMint,
    baseVault: state.baseVault,
    quoteVault: state.quoteVault,
    baseMint: state.baseMint,
    quoteMint: state.quoteMint,
    orientation,
  });
}

export interface DecodableInstruction {
  readonly programIdIndex?: number | undefined;
  readonly programId?: string | undefined;
  readonly accounts: readonly number[] | readonly string[];
  readonly data: string | Uint8Array | readonly number[];
}

export interface DecodableInnerInstructionsGroup {
  readonly index: number; // outerInstructionIndex
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
  readonly meta?:
    | {
        readonly err: unknown | null | undefined;
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
      }
    | null
    | undefined;
}

export type DecodeRaydiumSwapFailureReason =
  | "TRANSACTION_FAILED"
  | "MISSING_SIGNATURE"
  | "INVALID_SLOT"
  | "MISSING_UPSTREAM_TIMESTAMP"
  | "NO_MATCHING_SWAPS_FOUND"
  | "IDENTITY_MISMATCH"
  | "VAULT_MISMATCH"
  | "UNSUPPORTED_INSTRUCTION"
  | "MALFORMED_INSTRUCTION_DATA"
  | "AMBIGUOUS_DIRECTION";

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
  /** Local clock function for receipt timestamps (defaults to Date.now) */
  readonly clock?: (() => number) | undefined;
  /** Explicit receipt timestamp (overrides clock reading) */
  readonly receiptTimestampMs?: number | undefined;
  /** Explicit provenance for synthetic fixtures (e.g. "SYNTHETIC_FIXTURE") */
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
 * Normalizes instruction data to a Uint8Array.
 * Handles Uint8Array, Buffer, number arrays, base58 strings, and base64 strings.
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
    // Attempt base58 decoding first (standard for Solana RPC compiled instructions)
    try {
      const b58 = decodeBase58(trimmed);
      return new Uint8Array(b58.buffer, b58.byteOffset, b58.byteLength);
    } catch {
      // Fallback: try base64 decoding
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
 * Resolves static and lookup-table accounts from message and meta into a flat array of base58 public keys.
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
  for (const key of message.accountKeys) {
    if (typeof key === "string") {
      accounts.push(key);
    } else if (key && typeof key.pubkey === "string") {
      accounts.push(key.pubkey);
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
  if (instruction.programId) {
    return instruction.programId;
  }
  if (
    typeof instruction.programIdIndex === "number" &&
    instruction.programIdIndex >= 0 &&
    instruction.programIdIndex < resolvedAccounts.length
  ) {
    return resolvedAccounts[instruction.programIdIndex] ?? null;
  }
  return null;
}

function resolveInstructionAccounts(
  instruction: DecodableInstruction,
  resolvedAccounts: readonly string[],
): string[] {
  const result: string[] = [];
  for (const acc of instruction.accounts) {
    if (typeof acc === "string") {
      result.push(acc);
    } else if (typeof acc === "number" && acc >= 0 && acc < resolvedAccounts.length) {
      result.push(resolvedAccounts[acc]!);
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

/**
 * Parses Raydium program event log (`ray_log: <base64>`) emitted in logMessages.
 * Extracts official Raydium SwapDirection (1 = PC2Coin, 2 = Coin2PC) and exact amounts.
 */
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
  readonly source: string;
  readonly destination: string;
  readonly authority: string;
  readonly amount: bigint;
}

function parseSplTokenTransfer(
  instruction: DecodableInstruction,
  resolvedAccounts: readonly string[],
): DecodedSplTransfer | null {
  const progId = resolveProgramId(instruction, resolvedAccounts);
  if (progId !== SPL_TOKEN_PROGRAM_ID && progId !== TOKEN_2022_PROGRAM_ID) {
    return null;
  }

  const rawData = decodeInstructionData(instruction.data);
  if (!rawData || rawData.length < 9) return null;

  const tag = rawData[0];
  const accounts = resolveInstructionAccounts(instruction, resolvedAccounts);

  if (tag === 3) {
    // SPL Token Transfer: [source, destination, authority]
    if (accounts.length < 3) return null;
    try {
      const amount = readU64LE(rawData, 1);
      return {
        source: accounts[0]!,
        destination: accounts[1]!,
        authority: accounts[2]!,
        amount,
      };
    } catch {
      return null;
    }
  } else if (tag === 12) {
    // SPL Token TransferChecked: [source, mint, destination, authority]
    if (accounts.length < 4) return null;
    try {
      const amount = readU64LE(rawData, 1);
      return {
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

function attributeTradeSide(
  direction: "Coin2PC" | "PC2Coin",
  orientation: RaydiumPairOrientation,
): TradeSide {
  if (orientation === "TOKEN_BASE_SOL_QUOTE") {
    // Base is Candidate, Quote is SOL
    // Coin2PC: Candidate -> SOL = SELL
    // PC2Coin: SOL -> Candidate = BUY
    return direction === "Coin2PC" ? "SELL" : "BUY";
  } else if (orientation === "SOL_BASE_TOKEN_QUOTE") {
    // Base is SOL, Quote is Candidate
    // Coin2PC: SOL -> Candidate = BUY
    // PC2Coin: Candidate -> SOL = SELL
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
  payload: DecodableTransactionPayload,
  poolContext: TrackedRaydiumPoolContext,
  options?: DecodeSwapOptions,
): DecodeRaydiumTransactionResult {
  const clock = options?.clock ?? Date.now;
  const receiptTimestampMs = options?.receiptTimestampMs ?? clock();

  // 1. Validate signature presence
  const signature = payload.transaction?.signatures?.[0];
  if (!signature || typeof signature !== "string" || signature.trim().length === 0) {
    return {
      ok: false,
      reason: "MISSING_SIGNATURE",
      message: "Transaction payload is missing a valid signature at index 0",
      events: [],
    };
  }

  // 2. Validate slot
  const slot = payload.slot;
  if (typeof slot !== "number" || !Number.isFinite(slot) || !Number.isInteger(slot) || slot < 0) {
    return {
      ok: false,
      reason: "INVALID_SLOT",
      message: `Invalid transaction slot: ${String(slot)}`,
      signature,
      events: [],
    };
  }

  // 3. Check transaction success status
  if (payload.meta?.err !== null && payload.meta?.err !== undefined) {
    return {
      ok: false,
      reason: "TRANSACTION_FAILED",
      message: `Transaction ${signature} failed on-chain with error: ${JSON.stringify(payload.meta.err)}`,
      signature,
      slot,
      events: [],
    };
  }

  // 4. Resolve upstream timestamp and provenance
  let blockTimeSec: number | null = null;
  let eventTimestampMs: number;
  let timestampProvenance: TradeTimestampProvenance;

  if (
    typeof payload.blockTime === "number" &&
    Number.isFinite(payload.blockTime) &&
    payload.blockTime > 0
  ) {
    blockTimeSec = Math.floor(payload.blockTime);
    eventTimestampMs = blockTimeSec * 1000;
    timestampProvenance = options?.fallbackProvenance ?? "ON_CHAIN_BLOCK_TIME";
  } else if (options?.fallbackProvenance === "SYNTHETIC_FIXTURE") {
    // Explicit synthetic fixture allows local simulated time
    eventTimestampMs = receiptTimestampMs;
    blockTimeSec = Math.floor(eventTimestampMs / 1000);
    timestampProvenance = "SYNTHETIC_FIXTURE";
  } else {
    // Missing upstream time must remain unavailable; do not manufacture it
    return {
      ok: false,
      reason: "MISSING_UPSTREAM_TIMESTAMP",
      message: `Transaction ${signature} lacks an on-chain blockTime and cannot manufacture upstream timestamp`,
      signature,
      slot,
      events: [],
    };
  }

  // 5. Resolve transaction accounts (static + lookup tables)
  const resolvedAccounts = resolveTransactionAccounts(payload.transaction.message, payload.meta);

  // 6. Index inner instructions by outer instruction index
  const innerGroups = new Map<number, readonly DecodableInstruction[]>();
  if (Array.isArray(payload.meta?.innerInstructions)) {
    for (const group of payload.meta.innerInstructions) {
      if (typeof group.index === "number" && Array.isArray(group.instructions)) {
        innerGroups.set(group.index, group.instructions);
      }
    }
  }

  // 7. Parse ray_log entries from logMessages if present
  const rayLogs: DecodedRayLogSwap[] = [];
  if (Array.isArray(payload.meta?.logMessages)) {
    for (const line of payload.meta.logMessages) {
      const parsed = parseRayLog(line);
      if (parsed) {
        rayLogs.push(parsed);
      }
    }
  }

  const decodedEvents: TradeEvent[] = [];
  let totalInstructionsScanned = 0;
  let matchingSwapsCount = 0;
  let nonMatchingPoolSwapsCount = 0;
  let rayLogCursor = 0;

  // Helper to decode a single Raydium swap instruction
  const decodeInstructionIfRaydiumSwap = (
    inst: DecodableInstruction,
    outerInstructionIndex: number,
    swapIndex: number,
    relevantInnerInstructions: readonly DecodableInstruction[],
  ): {
    readonly isRaydium: boolean;
    readonly error?: { readonly reason: DecodeRaydiumSwapFailureReason; readonly message: string };
    readonly event?: TradeEvent;
  } => {
    const progId = resolveProgramId(inst, resolvedAccounts);
    if (progId !== RAYDIUM_AMM_V4_PROGRAM_ID) {
      return { isRaydium: false };
    }

    const accounts = resolveInstructionAccounts(inst, resolvedAccounts);
    if (accounts.length < 8) {
      return {
        isRaydium: true,
        error: {
          reason: "MALFORMED_INSTRUCTION_DATA",
          message: `Raydium instruction has insufficient accounts: ${accounts.length} (minimum 8)`,
        },
      };
    }

    // Account 1 is always the AMM pool account
    const instructionPoolId = accounts[1]!;
    if (instructionPoolId !== poolContext.poolId) {
      nonMatchingPoolSwapsCount++;
      return { isRaydium: true }; // Raydium swap for another pool in the same transaction
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

    const tag = rawData[0];
    const isStandardLayout = accounts.length >= 17;
    const isV2Layout = accounts.length === 8;

    let baseVaultAccount: string;
    let quoteVaultAccount: string;
    let userSourceAccount: string;
    let userDestinationAccount: string;

    if (isStandardLayout) {
      // 17-account layout: 4: coin_vault, 5: pc_vault, 14: user_source, 15: user_dest
      baseVaultAccount = accounts[4]!;
      quoteVaultAccount = accounts[5]!;
      userSourceAccount = accounts[14]!;
      userDestinationAccount = accounts[15]!;
    } else if (isV2Layout) {
      // 8-account layout: 3: coin_vault, 4: pc_vault, 5: user_source, 6: user_dest
      baseVaultAccount = accounts[3]!;
      quoteVaultAccount = accounts[4]!;
      userSourceAccount = accounts[5]!;
      userDestinationAccount = accounts[6]!;
    } else {
      return {
        isRaydium: true,
        error: {
          reason: "UNSUPPORTED_INSTRUCTION",
          message: `Unexpected Raydium account count: ${accounts.length} (expected 8 or >= 17)`,
        },
      };
    }

    // Validate instruction tag
    const isSwapBaseIn =
      tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN ||
      tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN_V2;
    const isSwapBaseOut =
      tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT ||
      tag === RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT_V2;

    if (!isSwapBaseIn && !isSwapBaseOut) {
      return {
        isRaydium: true,
        error: {
          reason: "UNSUPPORTED_INSTRUCTION",
          message: `Unsupported Raydium instruction tag: ${String(tag)} (expected 9, 11, 16, or 17)`,
        },
      };
    }

    // Strict vault binding: vault accounts must match the validated pool
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

    // Determine direction and exact amounts
    let direction: "Coin2PC" | "PC2Coin" | null = null;
    let tokenAmount: bigint | undefined;
    let solAmount: bigint | undefined;

    // Method 1: Inspect inner SPL Token transfers executed under this swap
    const splTransfers: DecodedSplTransfer[] = [];
    for (const innerInst of relevantInnerInstructions) {
      const transfer = parseSplTokenTransfer(innerInst, resolvedAccounts);
      if (transfer) {
        splTransfers.push(transfer);
      }
    }

    const transferIntoBase = splTransfers.find((t) => t.destination === poolContext.baseVault);
    const transferIntoQuote = splTransfers.find((t) => t.destination === poolContext.quoteVault);
    const transferOutOfBase = splTransfers.find((t) => t.source === poolContext.baseVault);
    const transferOutOfQuote = splTransfers.find((t) => t.source === poolContext.quoteVault);

    if (transferIntoBase && transferOutOfQuote) {
      direction = "Coin2PC";
      const amountBase = transferIntoBase.amount;
      const amountQuote = transferOutOfQuote.amount;
      if (poolContext.orientation === "TOKEN_BASE_SOL_QUOTE") {
        tokenAmount = amountBase;
        solAmount = amountQuote;
      } else {
        tokenAmount = amountQuote;
        solAmount = amountBase;
      }
    } else if (transferIntoQuote && transferOutOfBase) {
      direction = "PC2Coin";
      const amountBase = transferOutOfBase.amount;
      const amountQuote = transferIntoQuote.amount;
      if (poolContext.orientation === "TOKEN_BASE_SOL_QUOTE") {
        tokenAmount = amountBase;
        solAmount = amountQuote;
      } else {
        tokenAmount = amountQuote;
        solAmount = amountBase;
      }
    }

    // Method 2: Inspect Raydium ray_log if inner transfers did not resolve direction
    if (!direction && rayLogs.length > rayLogCursor) {
      const rayLog = rayLogs[rayLogCursor++];
      if (rayLog) {
        direction = rayLog.direction;
        if (poolContext.orientation === "TOKEN_BASE_SOL_QUOTE") {
          tokenAmount = direction === "Coin2PC" ? rayLog.amountIn : rayLog.amountOut;
          solAmount = direction === "Coin2PC" ? rayLog.amountOut : rayLog.amountIn;
        } else {
          tokenAmount = direction === "Coin2PC" ? rayLog.amountOut : rayLog.amountIn;
          solAmount = direction === "Coin2PC" ? rayLog.amountIn : rayLog.amountOut;
        }
      }
    }

    // Method 3: Inspect preTokenBalances / postTokenBalances for user source/dest accounts
    if (!direction && Array.isArray(payload.meta?.preTokenBalances)) {
      const sourceBalance = payload.meta.preTokenBalances.find(
        (b) => resolvedAccounts[b.accountIndex] === userSourceAccount,
      );
      const destBalance = payload.meta.preTokenBalances.find(
        (b) => resolvedAccounts[b.accountIndex] === userDestinationAccount,
      );

      if (sourceBalance?.mint === poolContext.baseMint) {
        direction = "Coin2PC";
      } else if (sourceBalance?.mint === poolContext.quoteMint) {
        direction = "PC2Coin";
      } else if (destBalance?.mint === poolContext.quoteMint) {
        direction = "Coin2PC";
      } else if (destBalance?.mint === poolContext.baseMint) {
        direction = "PC2Coin";
      }
    }

    // Fail closed if direction cannot be determined unambiguously
    if (!direction) {
      return {
        isRaydium: true,
        error: {
          reason: "AMBIGUOUS_DIRECTION",
          message:
            "Cannot determine swap direction from inner transfers, ray_log, or account context",
        },
      };
    }

    const side = attributeTradeSide(direction, poolContext.orientation);
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
  const topLevelInstructions = payload.transaction.message.instructions ?? [];
  for (let outerIdx = 0; outerIdx < topLevelInstructions.length; outerIdx++) {
    totalInstructionsScanned++;
    const inst = topLevelInstructions[outerIdx]!;
    const relevantInners = innerGroups.get(outerIdx) ?? [];

    const result = decodeInstructionIfRaydiumSwap(inst, outerIdx, 0, relevantInners);
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

    // In addition, scan any inner instructions under this outer instruction (routed / CPI swaps)
    for (let innerIdx = 0; innerIdx < relevantInners.length; innerIdx++) {
      totalInstructionsScanned++;
      const innerInst = relevantInners[innerIdx]!;
      // Relevant inners for this inner instruction are subsequent inners
      const subsequentInners = relevantInners.slice(innerIdx + 1);

      const innerResult = decodeInstructionIfRaydiumSwap(
        innerInst,
        outerIdx,
        innerIdx,
        subsequentInners,
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
    this.poolContext = poolContext;
  }

  public getPoolContext(): TrackedRaydiumPoolContext {
    return this.poolContext;
  }

  /**
   * Decodes a transaction payload and ingests any matching swaps into the provided tracker.
   */
  public ingestTransaction(
    payload: DecodableTransactionPayload,
    tracker: RollingTradeFlowTracker,
    options?: DecodeSwapOptions,
  ): IngestTransactionResult {
    const signature = payload.transaction?.signatures?.[0] ?? "unknown-signature";
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
