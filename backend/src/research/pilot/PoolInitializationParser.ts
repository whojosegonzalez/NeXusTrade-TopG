/**
 * Phase 12.94-D Milestone D.2.9-A: Protocol-Specific Pool Initialization Parser
 *
 * Implements strict offline detection and parsing of pool initialization instructions
 * for canonical Raydium AMM v4 and CPMM protocols, with explicit unsupported-protocol
 * classification, Version 0 (v0) Address Lookup Table (ALT) account resolution,
 * nested CPI inspection, and multi-pool recognition.
 *
 * Requirements (D29-A2, D29-F2, D29-F3, D29-F4):
 * 1. Deterministic identification of genuine pool initialization instructions.
 * 2. Never relies on log strings alone; verifies instruction program ID, discriminators,
 *    payload length, and exact account vectors.
 * 3. Supports Versioned Transactions (v0 with loadedAddresses.writable and readonly).
 * 4. Fails closed on failed txs (meta.err !== null), missing keys, or out-of-bounds indices.
 * 5. Reconciles AMM v4 initialize2 against authoritative upstream instruction.rs (21 accounts, 26-byte payload, creator at index 17, market at indices 15-16, open_time at bytes 2..10).
 * 6. Deprecated initialize tag 0 is rejected fail-closed.
 * 7. Supports explicit instruction data encodings (raw, base58, base64) without regex guessing.
 * 8. Inspects top-level and innerInstructions (CPI), returning all identified pools.
 * 9. Immutable event deduplication key: `${signature}:${outerInstructionIndex}` or `${signature}:${outerInstructionIndex}:inner:${innerInstructionIndex}`.
 * 10. Preserves separate slot, blockTimeSec, firstSeenTimestampMs, and poolOpenTimeSec.
 */

import { decodeBase58 } from "../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import type {
  CompiledInstruction,
  DiscoveredPoolInitializationEvent,
  DiscoveredProtocolType,
  InstructionDataEncoding,
  UnsupportedProtocolReason,
  VersionedTransactionAccountResolution,
  VersionedTransactionMetadata,
} from "./EventDiscoveryContracts.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID } from "./RaydiumAmmParser.js";
import { RAYDIUM_CPMM_AUTHORITY, RAYDIUM_CPMM_PROGRAM_ID } from "./RaydiumCpmmParser.js";

export { RAYDIUM_AMM_V4_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CPMM_AUTHORITY };

// Anchor Discriminator for CPMM initialize: sha256("global:initialize")[0..8]
export const RAYDIUM_CPMM_INIT_DISCRIMINATOR = Object.freeze([
  0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed,
]);

// AMM v4 active initialize2 tag (byte 0 is 1)
export const RAYDIUM_AMM_V4_INIT2_TAG = 1;
// Deprecated legacy initialize tag (byte 0 is 0)
export const RAYDIUM_AMM_V4_DEPRECATED_INIT_TAG = 0;
export const RAYDIUM_AMM_V4_INIT_TAGS = Object.freeze([
  RAYDIUM_AMM_V4_DEPRECATED_INIT_TAG,
  RAYDIUM_AMM_V4_INIT2_TAG,
]);

// Authoritative AMM v4 initialize2 payload length: 1 (tag) + 1 (nonce) + 8 (open_time) + 8 (init_pc_amount) + 8 (init_coin_amount) = 26 bytes
export const RAYDIUM_AMM_V4_INIT2_PAYLOAD_LENGTH = 26;

// Authoritative CPMM initialize payload minimum length: 8 (discriminator) + 8 (amount_0) + 8 (amount_1) + 8 (open_time) = 32 bytes
export const RAYDIUM_CPMM_INIT_MIN_PAYLOAD_LENGTH = 32;

// Known unsupported DEX Program IDs for explicit classification
export const KNOWN_UNSUPPORTED_DEX_PROGRAMS: Readonly<Record<string, UnsupportedProtocolReason>> =
  Object.freeze({
    whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "ORCA_WHIRLPOOL",
    CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "RAYDIUM_CLMM",
    LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "METEORA_DLMM",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "PUMP_FUN",
    MSPCiR9qX1xJ8pZ3kG5hJbM1d3o8sY5Xy2Z7K6q3G9A: "MOONSHOT",
  });

/**
 * Result of instruction parsing attempt for a single event.
 */
export type PoolInitializationParseResult =
  | { readonly ok: true; readonly event: DiscoveredPoolInitializationEvent }
  | {
      readonly ok: false;
      readonly protocol: DiscoveredProtocolType;
      readonly reason: UnsupportedProtocolReason;
      readonly message: string;
      readonly instructionIndex?: number | undefined;
    };

/**
 * Result of instruction scanning across all top-level and inner instructions.
 */
export type PoolInitializationScanResult =
  | { readonly ok: true; readonly events: readonly DiscoveredPoolInitializationEvent[] }
  | {
      readonly ok: false;
      readonly protocol: DiscoveredProtocolType;
      readonly reason: UnsupportedProtocolReason;
      readonly message: string;
      readonly instructionIndex?: number | undefined;
    };

/**
 * Flattens versioned transaction account keys (static + lookup tables).
 */
export function resolveTransactionAccountKeys(
  accountKeys: VersionedTransactionAccountResolution,
):
  | { ok: true; keys: readonly string[] }
  | { ok: false; reason: UnsupportedProtocolReason; error: string } {
  if (!Array.isArray(accountKeys.staticAccountKeys)) {
    return {
      ok: false,
      reason: "MISSING_ACCOUNTS",
      error: "staticAccountKeys must be an array",
    };
  }

  const keys: string[] = [...accountKeys.staticAccountKeys];

  if (accountKeys.loadedAddresses) {
    if (Array.isArray(accountKeys.loadedAddresses.writable)) {
      keys.push(...accountKeys.loadedAddresses.writable);
    }
    if (Array.isArray(accountKeys.loadedAddresses.readonly)) {
      keys.push(...accountKeys.loadedAddresses.readonly);
    }
  }

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (typeof k !== "string" || k.trim() === "") {
      return {
        ok: false,
        reason: "MISSING_ACCOUNTS",
        error: `Invalid account key at index ${i}: must be non-empty string`,
      };
    }
  }

  return { ok: true, keys: Object.freeze(keys) };
}

export interface NormalizeInstructionDataOptions {
  readonly encoding?: InstructionDataEncoding | undefined;
}

/**
 * Converts instruction data into a Buffer/Uint8Array adhering to strict encoding contracts (D29-F3).
 * Decodes Solana RPC base58 or base64 without heuristic guessing on string content.
 */
export function normalizeInstructionData(
  data: Uint8Array | Buffer | string,
  encodingOrOptions?: InstructionDataEncoding | NormalizeInstructionDataOptions,
): Buffer {
  const encoding =
    typeof encodingOrOptions === "string" ? encodingOrOptions : encodingOrOptions?.encoding;

  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  if (typeof data !== "string") {
    throw new Error("MALFORMED_INSTRUCTION_DATA: Data must be a Buffer, Uint8Array, or string");
  }

  const trimmed = data.trim();

  // Explicit base58 encoding
  if (encoding === "base58") {
    try {
      return decodeBase58(trimmed);
    } catch (err) {
      throw new Error(`MALFORMED_BASE58_DATA: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Explicit base64 encoding
  if (encoding === "base64") {
    if (trimmed.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
      throw new Error("MALFORMED_BASE64_DATA: String contains invalid base64 characters");
    }
    try {
      return Buffer.from(trimmed, "base64");
    } catch (err) {
      throw new Error(`MALFORMED_BASE64_DATA: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Explicit raw encoding
  if (encoding === "raw") {
    throw new Error(
      "INVALID_ENCODING_CONTRACT: String data cannot have raw encoding without explicit binary type",
    );
  }

  // Unannotated string: in Solana JSON RPC getTransaction responses, compiled instruction data is base58 encoded.
  try {
    return decodeBase58(trimmed);
  } catch (err) {
    throw new Error(
      `MALFORMED_INSTRUCTION_DATA: Failed to decode unannotated instruction data as Solana RPC base58: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface ParsedInstructionCandidate {
  readonly event?: DiscoveredPoolInitializationEvent | undefined;
  readonly error?:
    | {
        readonly protocol: DiscoveredProtocolType;
        readonly reason: UnsupportedProtocolReason;
        readonly message: string;
      }
    | undefined;
  readonly unsupported?:
    | {
        readonly reason: UnsupportedProtocolReason;
        readonly message: string;
      }
    | undefined;
}

/**
 * Inspects a single compiled instruction against supported protocol discriminators.
 */
function parseSingleInstruction(
  inst: CompiledInstruction,
  outerIdx: number,
  innerIdx: number | undefined,
  allKeys: readonly string[],
  tx: VersionedTransactionMetadata,
  hostObservationTimestampMs: number,
): ParsedInstructionCandidate {
  // Check program index bounds
  if (inst.programIdIndex < 0 || inst.programIdIndex >= allKeys.length) {
    return {
      error: {
        protocol: "UNSUPPORTED_PROTOCOL",
        reason: "UNRESOLVED_LOOKUP_TABLE_INDEX",
        message: `Instruction (outer: ${outerIdx}, inner: ${innerIdx ?? "none"}) programIdIndex ${inst.programIdIndex} out of bounds (total keys: ${allKeys.length})`,
      },
    };
  }
  const programId = allKeys[inst.programIdIndex];

  // Check account indexes bounds
  const accounts: string[] = [];
  for (const accIdx of inst.accountKeyIndexes) {
    if (accIdx < 0 || accIdx >= allKeys.length) {
      return {
        error: {
          protocol: "UNSUPPORTED_PROTOCOL",
          reason: "UNRESOLVED_LOOKUP_TABLE_INDEX",
          message: `Instruction (outer: ${outerIdx}, inner: ${innerIdx ?? "none"}) references out-of-bounds account index ${accIdx} (total keys: ${allKeys.length})`,
        },
      };
    }
    accounts.push(allKeys[accIdx]!);
  }

  let dataBuffer: Buffer;
  try {
    dataBuffer = normalizeInstructionData(inst.data, inst.dataEncoding);
  } catch (err) {
    return {
      error: {
        protocol: "UNSUPPORTED_PROTOCOL",
        reason: "CORRUPTED_INSTRUCTION_DATA",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // --------------------------------------------------------------------------
  // Check Raydium AMM v4
  // --------------------------------------------------------------------------
  if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
    if (dataBuffer.length < 1) {
      return {
        error: {
          protocol: "RAYDIUM_AMM_V4",
          reason: "CORRUPTED_INSTRUCTION_DATA",
          message: `Raydium AMM v4 instruction data too short (${dataBuffer.length} bytes)`,
        },
      };
    }

    const tag = dataBuffer.readUInt8(0);

    // Reject deprecated legacy initialize tag 0 (D29-F2)
    if (tag === RAYDIUM_AMM_V4_DEPRECATED_INIT_TAG) {
      return {
        error: {
          protocol: "RAYDIUM_AMM_V4",
          reason: "DEPRECATED_INITIALIZE_TAG",
          message:
            "Raydium AMM v4 deprecated initialize tag 0 is not supported; initialize2 (tag 1) required",
        },
      };
    }

    // If tag is neither 0 nor 1, it is a non-initialization instruction (swap, deposit, etc.)
    if (tag !== RAYDIUM_AMM_V4_INIT2_TAG) {
      return {
        unsupported: {
          reason: "NON_INITIALIZATION_INSTRUCTION",
          message: `Raydium AMM v4 instruction tag ${tag} is not initialize2 (tag 1)`,
        },
      };
    }

    // Enforce actual instruction payload length: exactly/at least 26 bytes (D29-F2)
    if (dataBuffer.length < RAYDIUM_AMM_V4_INIT2_PAYLOAD_LENGTH) {
      return {
        error: {
          protocol: "RAYDIUM_AMM_V4",
          reason: "CORRUPTED_INSTRUCTION_DATA",
          message: `Raydium AMM v4 initialize2 instruction data too short: expected at least ${RAYDIUM_AMM_V4_INIT2_PAYLOAD_LENGTH} bytes, got ${dataBuffer.length}`,
        },
      };
    }

    // Authoritative Raydium AMM v4 initialize2 21-account vector (D29-F2):
    // 0: SPL Token program id
    // 1: Associated Token program id
    // 2: System program id
    // 3: Rent sysvar
    // 4: AMM Account to create (Pool state PDA)
    // 5: AMM Authority
    // 6: AMM open orders
    // 7: AMM LP mint
    // 8: AMM coin mint (Base token)
    // 9: AMM PC mint (Quote token)
    // 10: AMM coin vault (Base vault)
    // 11: AMM PC vault (Quote vault)
    // 12: AMM target orders
    // 13: AMM config
    // 14: AMM create pool fee destination
    // 15: Market program ID (Serum / OpenBook)
    // 16: Market Account
    // 17: User wallet Account (Creator / signer)
    // 18: User token coin
    // 19: User token PC
    // 20: User destination LP token ATA
    if (accounts.length < 21) {
      return {
        error: {
          protocol: "RAYDIUM_AMM_V4",
          reason: "MISSING_ACCOUNTS",
          message: `Raydium AMM v4 initialize2 requires at least 21 accounts in authoritative upstream order, got ${accounts.length}`,
        },
      };
    }

    const poolId = accounts[4]!;
    const authorityPda = accounts[5];
    const lpMint = accounts[7];
    const token0Mint = accounts[8]!; // coin mint
    const token1Mint = accounts[9]!; // pc mint
    const token0Vault = accounts[10]!; // coin vault
    const token1Vault = accounts[11]!; // pc vault
    const marketId = accounts[16];
    const creatorWallet = accounts[17]; // creator at index 17

    // Decode AMM v4 open_time from instruction bytes 2..10 (D29-F2)
    const rawOpenTime = dataBuffer.readBigUInt64LE(2);
    const poolOpenTimeSec = Number(rawOpenTime);

    const eventId =
      innerIdx !== undefined
        ? `${tx.signature}:${outerIdx}:inner:${innerIdx}`
        : `${tx.signature}:${outerIdx}`;

    const event: DiscoveredPoolInitializationEvent = {
      eventId,
      signature: tx.signature,
      outerInstructionIndex: outerIdx,
      innerInstructionIndex: innerIdx,
      instructionIndex: outerIdx,
      slot: tx.slot,
      blockTimeSec: tx.blockTime,
      firstSeenTimestampMs: hostObservationTimestampMs,
      poolOpenTimeSec, // Decoded from initialize2 instruction bytes
      protocol: "RAYDIUM_AMM_V4",
      poolId,
      token0Mint,
      token1Mint,
      token0Vault,
      token1Vault,
      lpMint,
      token0Program: SPL_TOKEN_PROGRAM_ID,
      token1Program: SPL_TOKEN_PROGRAM_ID,
      ammConfigOrMarket: marketId,
      authorityPda,
      creatorWallet,
      rawInstructionDataHex: dataBuffer.toString("hex"),
    };

    return { event };
  }

  // --------------------------------------------------------------------------
  // Check Raydium CPMM
  // --------------------------------------------------------------------------
  if (programId === RAYDIUM_CPMM_PROGRAM_ID) {
    if (dataBuffer.length < 8) {
      return {
        error: {
          protocol: "RAYDIUM_CPMM",
          reason: "CORRUPTED_INSTRUCTION_DATA",
          message: `Raydium CPMM instruction data too short for Anchor discriminator (${dataBuffer.length} bytes)`,
        },
      };
    }

    // Check Anchor discriminator: sha256("global:initialize")[0..8] = 0xafaf6d1f0d989bed
    let isInitDiscriminator = true;
    for (let d = 0; d < 8; d++) {
      if (dataBuffer.readUInt8(d) !== RAYDIUM_CPMM_INIT_DISCRIMINATOR[d]) {
        isInitDiscriminator = false;
        break;
      }
    }

    if (!isInitDiscriminator) {
      return {
        unsupported: {
          reason: "NON_INITIALIZATION_INSTRUCTION",
          message: "Raydium CPMM instruction discriminator mismatch (not initialize)",
        },
      };
    }

    if (dataBuffer.length < RAYDIUM_CPMM_INIT_MIN_PAYLOAD_LENGTH) {
      return {
        error: {
          protocol: "RAYDIUM_CPMM",
          reason: "CORRUPTED_INSTRUCTION_DATA",
          message: `Raydium CPMM initialize instruction data too short: expected at least ${RAYDIUM_CPMM_INIT_MIN_PAYLOAD_LENGTH} bytes, got ${dataBuffer.length}`,
        },
      };
    }

    // Expected accounts layout for Raydium CPMM initialize (17 accounts):
    // 0: creator (Signer)
    // 1: amm_config
    // 2: authority PDA
    // 3: pool_state (Pool ID)
    // 4: token_0_mint
    // 5: token_1_mint
    // 6: lp_mint
    // 7: creator_token_0
    // 8: creator_token_1
    // 9: creator_lp_token
    // 10: token_0_vault
    // 11: token_1_vault
    // 12: create_pool_fee
    // 13: observation_state
    // 14: token_program
    // 15: token_0_program
    // 16: token_1_program
    if (accounts.length < 17) {
      return {
        error: {
          protocol: "RAYDIUM_CPMM",
          reason: "MISSING_ACCOUNTS",
          message: `Raydium CPMM init instruction requires at least 17 accounts, got ${accounts.length}`,
        },
      };
    }

    const creatorWallet = accounts[0];
    const ammConfigOrMarket = accounts[1];
    const authorityPda = accounts[2];
    const poolId = accounts[3]!;
    const token0Mint = accounts[4]!;
    const token1Mint = accounts[5]!;
    const lpMint = accounts[6];
    const token0Vault = accounts[10]!;
    const token1Vault = accounts[11]!;
    const token0Program = accounts[15];
    const token1Program = accounts[16];

    // Extract open_time from instruction data bytes 24..32
    const rawOpenTime = dataBuffer.readBigUInt64LE(24);
    const poolOpenTimeSec = Number(rawOpenTime);

    const eventId =
      innerIdx !== undefined
        ? `${tx.signature}:${outerIdx}:inner:${innerIdx}`
        : `${tx.signature}:${outerIdx}`;

    const event: DiscoveredPoolInitializationEvent = {
      eventId,
      signature: tx.signature,
      outerInstructionIndex: outerIdx,
      innerInstructionIndex: innerIdx,
      instructionIndex: outerIdx,
      slot: tx.slot,
      blockTimeSec: tx.blockTime,
      firstSeenTimestampMs: hostObservationTimestampMs,
      poolOpenTimeSec, // Decoded from CPMM initialize instruction bytes
      protocol: "RAYDIUM_CPMM",
      poolId,
      token0Mint,
      token1Mint,
      token0Vault,
      token1Vault,
      lpMint,
      token0Program,
      token1Program,
      ammConfigOrMarket,
      authorityPda,
      creatorWallet,
      rawInstructionDataHex: dataBuffer.toString("hex"),
    };

    return { event };
  }

  // --------------------------------------------------------------------------
  // Check Known Unsupported DEX Programs
  // --------------------------------------------------------------------------
  if (programId && programId in KNOWN_UNSUPPORTED_DEX_PROGRAMS) {
    const unsupportedReason = KNOWN_UNSUPPORTED_DEX_PROGRAMS[programId]!;
    return {
      unsupported: {
        reason: unsupportedReason,
        message: `Transaction ${tx.signature} invoked unsupported DEX protocol: ${unsupportedReason} (${programId})`,
      },
    };
  }

  return {
    unsupported: {
      reason: "UNKNOWN_PROGRAM",
      message: `Unknown or non-Raydium program invoked: ${programId}`,
    },
  };
}

/**
 * Scans all top-level and inner instructions to discover all pool initialization events in a transaction (D29-F4).
 */
export function identifyPoolInitializationInstructions(
  tx: VersionedTransactionMetadata,
  hostObservationTimestampMs: number = Date.now(),
): PoolInitializationScanResult {
  // 1. Fail closed on failed transaction
  if (tx.err !== null) {
    return {
      ok: false,
      protocol: "UNSUPPORTED_PROTOCOL",
      reason: "TRANSACTION_FAILED",
      message: `Transaction ${tx.signature} failed with on-chain error: ${JSON.stringify(tx.err)}`,
    };
  }

  // 2. Resolve account keys across static keys and address lookup tables
  const resolvedKeysResult = resolveTransactionAccountKeys(tx.accountKeys);
  if (!resolvedKeysResult.ok) {
    return {
      ok: false,
      protocol: "UNSUPPORTED_PROTOCOL",
      reason: resolvedKeysResult.reason,
      message: resolvedKeysResult.error,
    };
  }
  const allKeys = resolvedKeysResult.keys;

  if (!Array.isArray(tx.instructions) || tx.instructions.length === 0) {
    return {
      ok: false,
      protocol: "UNSUPPORTED_PROTOCOL",
      reason: "MISSING_ACCOUNTS",
      message: `Transaction ${tx.signature} contains no instructions`,
    };
  }

  const events: DiscoveredPoolInitializationEvent[] = [];
  let firstUnsupportedReason: UnsupportedProtocolReason | null = null;
  let firstUnsupportedMessage: string | null = null;

  // 3. Scan top-level instructions
  for (let idx = 0; idx < tx.instructions.length; idx++) {
    const inst = tx.instructions[idx];
    if (!inst) continue;

    const res = parseSingleInstruction(
      inst,
      idx,
      undefined,
      allKeys,
      tx,
      hostObservationTimestampMs,
    );

    if (res.error) {
      return {
        ok: false,
        protocol: res.error.protocol,
        reason: res.error.reason,
        message: res.error.message,
        instructionIndex: idx,
      };
    }

    if (res.event) {
      events.push(res.event);
    } else if (res.unsupported && !firstUnsupportedReason) {
      firstUnsupportedReason = res.unsupported.reason;
      firstUnsupportedMessage = res.unsupported.message;
    }
  }

  // 4. Scan inner instructions (CPI calls) (D29-F4)
  if (Array.isArray(tx.innerInstructions)) {
    for (const group of tx.innerInstructions) {
      const outerIdx = group.index;
      if (!Array.isArray(group.instructions)) continue;

      for (let innerIdx = 0; innerIdx < group.instructions.length; innerIdx++) {
        const innerInst = group.instructions[innerIdx];
        if (!innerInst) continue;

        const res = parseSingleInstruction(
          innerInst,
          outerIdx,
          innerIdx,
          allKeys,
          tx,
          hostObservationTimestampMs,
        );

        if (res.error) {
          return {
            ok: false,
            protocol: res.error.protocol,
            reason: res.error.reason,
            message: res.error.message,
            instructionIndex: outerIdx,
          };
        }

        if (res.event) {
          events.push(res.event);
        } else if (res.unsupported && !firstUnsupportedReason) {
          firstUnsupportedReason = res.unsupported.reason;
          firstUnsupportedMessage = res.unsupported.message;
        }
      }
    }
  }

  // 5. Deduplicate discovered events by stable eventId
  const seenEventIds = new Set<string>();
  const uniqueEvents: DiscoveredPoolInitializationEvent[] = [];

  for (const ev of events) {
    if (!seenEventIds.has(ev.eventId)) {
      seenEventIds.add(ev.eventId);
      uniqueEvents.push(ev);
    }
  }

  if (uniqueEvents.length > 0) {
    return {
      ok: true,
      events: Object.freeze(uniqueEvents),
    };
  }

  return {
    ok: false,
    protocol: "UNSUPPORTED_PROTOCOL",
    reason: firstUnsupportedReason ?? "NON_INITIALIZATION_INSTRUCTION",
    message:
      firstUnsupportedMessage ??
      `No recognized Raydium pool initialization instruction in tx ${tx.signature}`,
  };
}

/**
 * Backward-compatible wrapper returning the first pool initialization event in a transaction.
 */
export function identifyPoolInitializationInstruction(
  tx: VersionedTransactionMetadata,
  hostObservationTimestampMs: number = Date.now(),
): PoolInitializationParseResult {
  const scanResult = identifyPoolInitializationInstructions(tx, hostObservationTimestampMs);
  if (!scanResult.ok) {
    return scanResult;
  }
  return {
    ok: true,
    event: scanResult.events[0]!,
  };
}
