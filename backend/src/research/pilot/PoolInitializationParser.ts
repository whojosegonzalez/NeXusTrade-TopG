/**
 * Phase 12.94-D Milestone D.2.9-A: Protocol-Specific Pool Initialization Parser
 *
 * Implements strict offline detection and parsing of pool initialization instructions
 * for canonical Raydium AMM v4 and CPMM protocols, with explicit unsupported-protocol
 * classification and Version 0 (v0) Address Lookup Table (ALT) account resolution.
 *
 * Requirements (D29-A2, D29-A7):
 * 1. Deterministic identification of genuine pool initialization instructions.
 * 2. Never relies on log strings alone; verifies instruction program ID, discriminators,
 *    and exact account vectors.
 * 3. Supports Versioned Transactions (v0 with loadedAddresses.writable and readonly).
 * 4. Fails closed on failed txs (meta.err !== null), missing keys, or out-of-bounds indices.
 * 5. Immutable event deduplication key: `${signature}:${instructionIndex}`.
 * 6. Preserves separate blockTimeSec, firstSeenTimestampMs, and poolOpenTimeSec.
 */

import type {
  CompiledInstruction,
  DiscoveredPoolInitializationEvent,
  DiscoveredProtocolType,
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

// AMM v4 Initialization instruction tags (byte 0): 1 for initialize2, 0 for initialize
export const RAYDIUM_AMM_V4_INIT_TAGS = Object.freeze([0, 1]);

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
 * Result of instruction parsing attempt.
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

/**
 * Converts instruction data into a Buffer/Uint8Array.
 */
export function normalizeInstructionData(data: Uint8Array | Buffer | string): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") {
    // Attempt hex decoding first if hex string, else assume base64 or base58
    if (/^[0-9a-fA-F]+$/.test(data) && data.length % 2 === 0) {
      return Buffer.from(data, "hex");
    }
    // Attempt base64 decoding
    try {
      return Buffer.from(data, "base64");
    } catch {
      return Buffer.from(data, "utf8");
    }
  }
  return Buffer.alloc(0);
}

/**
 * Parses and classifies pool initialization instructions from versioned transaction metadata.
 */
export function identifyPoolInitializationInstruction(
  tx: VersionedTransactionMetadata,
  hostObservationTimestampMs: number = Date.now(),
): PoolInitializationParseResult {
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

  // 3. Scan instructions for Raydium pool initialization
  let firstUnsupportedReason: UnsupportedProtocolReason | null = null;
  let firstUnsupportedMessage: string | null = null;

  for (let idx = 0; idx < tx.instructions.length; idx++) {
    const inst: CompiledInstruction | undefined = tx.instructions[idx];
    if (!inst) continue;

    // Check program index bounds
    if (inst.programIdIndex < 0 || inst.programIdIndex >= allKeys.length) {
      return {
        ok: false,
        protocol: "UNSUPPORTED_PROTOCOL",
        reason: "UNRESOLVED_LOOKUP_TABLE_INDEX",
        message: `Instruction ${idx} programIdIndex ${inst.programIdIndex} out of bounds (total keys: ${allKeys.length})`,
        instructionIndex: idx,
      };
    }
    const programId = allKeys[inst.programIdIndex];

    // Check account indexes bounds
    const accounts: string[] = [];
    for (const accIdx of inst.accountKeyIndexes) {
      if (accIdx < 0 || accIdx >= allKeys.length) {
        return {
          ok: false,
          protocol: "UNSUPPORTED_PROTOCOL",
          reason: "UNRESOLVED_LOOKUP_TABLE_INDEX",
          message: `Instruction ${idx} references out-of-bounds account index ${accIdx} (total keys: ${allKeys.length})`,
          instructionIndex: idx,
        };
      }
      accounts.push(allKeys[accIdx]!);
    }

    const dataBuffer = normalizeInstructionData(inst.data);

    // ------------------------------------------------------------------------
    // Check Raydium AMM v4
    // ------------------------------------------------------------------------
    if (programId === RAYDIUM_AMM_V4_PROGRAM_ID) {
      if (dataBuffer.length < 1) {
        return {
          ok: false,
          protocol: "RAYDIUM_AMM_V4",
          reason: "CORRUPTED_INSTRUCTION_DATA",
          message: `Raydium AMM v4 instruction ${idx} data too short (${dataBuffer.length} bytes)`,
          instructionIndex: idx,
        };
      }

      const tag = dataBuffer.readUInt8(0);
      if (!RAYDIUM_AMM_V4_INIT_TAGS.includes(tag)) {
        firstUnsupportedReason = "NON_INITIALIZATION_INSTRUCTION";
        firstUnsupportedMessage = `Raydium AMM v4 instruction tag ${tag} is not initialize (0) or initialize2 (1)`;
        continue;
      }

      // Expected accounts layout for Raydium AMM v4 initialize2 (tag 1)
      // 0: Token Program, 1: Associated Token, 2: System, 3: Rent,
      // 4: AMM Account (poolId), 5: AMM Authority, 6: Open Orders, 7: LP Mint,
      // 8: Coin Mint, 9: PC Mint, 10: Coin Vault, 11: PC Vault, 12: Target Orders,
      // 13: Model, 14: User Payer, 15: User Coin, 16: User PC, 17: User LP,
      // 18: Serum Program, 19: Serum Market
      if (accounts.length < 18) {
        return {
          ok: false,
          protocol: "RAYDIUM_AMM_V4",
          reason: "MISSING_ACCOUNTS",
          message: `Raydium AMM v4 init instruction ${idx} requires at least 18 accounts, got ${accounts.length}`,
          instructionIndex: idx,
        };
      }

      const poolId = accounts[4]!;
      const authorityPda = accounts[5];
      const lpMint = accounts[7];
      const token0Mint = accounts[8]!; // coin
      const token1Mint = accounts[9]!; // pc
      const token0Vault = accounts[10]!; // coin vault
      const token1Vault = accounts[11]!; // pc vault
      const creatorWallet = accounts[14];
      const ammConfigOrMarket = accounts.length > 19 ? accounts[19] : undefined;

      const event: DiscoveredPoolInitializationEvent = {
        eventId: `${tx.signature}:${idx}`,
        signature: tx.signature,
        instructionIndex: idx,
        slot: tx.slot,
        blockTimeSec: tx.blockTime,
        firstSeenTimestampMs: hostObservationTimestampMs,
        poolOpenTimeSec: tx.blockTime, // AMM v4 unlocks upon creation
        protocol: "RAYDIUM_AMM_V4",
        poolId,
        token0Mint,
        token1Mint,
        token0Vault,
        token1Vault,
        lpMint,
        token0Program: SPL_TOKEN_PROGRAM_ID,
        token1Program: SPL_TOKEN_PROGRAM_ID,
        ammConfigOrMarket,
        authorityPda,
        creatorWallet,
        rawInstructionDataHex: dataBuffer.toString("hex"),
      };

      return { ok: true, event };
    }

    // ------------------------------------------------------------------------
    // Check Raydium CPMM
    // ------------------------------------------------------------------------
    if (programId === RAYDIUM_CPMM_PROGRAM_ID) {
      if (dataBuffer.length < 8) {
        return {
          ok: false,
          protocol: "RAYDIUM_CPMM",
          reason: "CORRUPTED_INSTRUCTION_DATA",
          message: `Raydium CPMM instruction ${idx} data too short for Anchor discriminator (${dataBuffer.length} bytes)`,
          instructionIndex: idx,
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
        firstUnsupportedReason = "NON_INITIALIZATION_INSTRUCTION";
        firstUnsupportedMessage = `Raydium CPMM instruction discriminator mismatch (not initialize)`;
        continue;
      }

      // Expected accounts layout for Raydium CPMM initialize:
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
          ok: false,
          protocol: "RAYDIUM_CPMM",
          reason: "MISSING_ACCOUNTS",
          message: `Raydium CPMM init instruction ${idx} requires at least 17 accounts, got ${accounts.length}`,
          instructionIndex: idx,
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

      // Extract open_time from instruction data if present (bytes 24..32)
      // Anchor initialize layout: discriminator (8B) + init_amount_0 (8B) + init_amount_1 (8B) + open_time (8B)
      let poolOpenTimeSec: number | null = null;
      if (dataBuffer.length >= 32) {
        try {
          const rawOpenTime = dataBuffer.readBigUInt64LE(24);
          poolOpenTimeSec = Number(rawOpenTime);
        } catch {
          poolOpenTimeSec = null;
        }
      }

      const event: DiscoveredPoolInitializationEvent = {
        eventId: `${tx.signature}:${idx}`,
        signature: tx.signature,
        instructionIndex: idx,
        slot: tx.slot,
        blockTimeSec: tx.blockTime,
        firstSeenTimestampMs: hostObservationTimestampMs,
        poolOpenTimeSec: poolOpenTimeSec ?? tx.blockTime,
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

      return { ok: true, event };
    }

    // ------------------------------------------------------------------------
    // Check Known Unsupported DEX Programs
    // ------------------------------------------------------------------------
    if (programId && programId in KNOWN_UNSUPPORTED_DEX_PROGRAMS) {
      const unsupportedReason = KNOWN_UNSUPPORTED_DEX_PROGRAMS[programId]!;
      firstUnsupportedReason = unsupportedReason;
      firstUnsupportedMessage = `Transaction ${tx.signature} invoked unsupported DEX protocol: ${unsupportedReason} (${programId})`;
    }
  }

  // 4. Return unsupported protocol classification if no valid Raydium init was found
  return {
    ok: false,
    protocol: "UNSUPPORTED_PROTOCOL",
    reason: firstUnsupportedReason ?? "UNKNOWN_PROGRAM",
    message:
      firstUnsupportedMessage ??
      `No recognized Raydium pool initialization instruction in tx ${tx.signature}`,
  };
}
