/**
 * Phase 12.94-D Milestone D.2.3: Authoritative Raydium AMM v4 Fixtures
 *
 * Constructs 752-byte Raydium AMM v4 account buffers and 165-byte SPL token vault buffers
 * matching the official Raydium SDK liquidityStateV4Layout.
 *
 * Provides positive fixtures (standard and inverted asset orientation) and negative fixtures
 * (corrupted length, wrong program owner, mismatched vault mints, invalid decimals).
 */

import {
  RAYDIUM_AMM_V4_LAYOUT_LENGTH,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_V4_OFFSETS,
  SPL_VAULT_LAYOUT_LENGTH,
  SPL_VAULT_OFFSETS,
  WSOL_MINT,
} from "../RaydiumAmmParser.js";

// Canonical public keys for fixtures
export const FIXTURE_WSOL_MINT = WSOL_MINT; // So11111111111111111111111111111111111111112
export const FIXTURE_MEME_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // Bonk
export const FIXTURE_POOL_ADDRESS = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
export const FIXTURE_BASE_VAULT = "9UYjh9A2dE1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8F";
export const FIXTURE_QUOTE_VAULT = "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v";
export const FIXTURE_LP_MINT = "So11111111111111111111111111111111111111113";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Decodes a base58 string to a 32-byte Uint8Array.
 */
export function decodeBase58To32Bytes(base58String: string): Uint8Array {
  const bytes = new Uint8Array(32);
  let length = 0;

  for (const char of base58String) {
    let carry = BASE58_ALPHABET.indexOf(char);
    if (carry < 0) {
      throw new Error(`Invalid base58 character: ${char}`);
    }

    for (let j = 0; j < length; j++) {
      const idx = 31 - j;
      const prev = bytes[idx] ?? 0;
      carry += prev * 58;
      bytes[idx] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      const idx = 31 - length;
      if (idx >= 0) {
        bytes[idx] = carry & 0xff;
      }
      length += 1;
      carry >>= 8;
    }
  }

  return bytes;
}

export interface RaydiumFixtureOptions {
  baseDecimal?: bigint;
  quoteDecimal?: bigint;
  baseVaultBase58?: string;
  quoteVaultBase58?: string;
  baseMintBase58?: string;
  quoteMintBase58?: string;
  lpMintBase58?: string;
  baseNeedTakePnl?: bigint;
  quoteNeedTakePnl?: bigint;
  lpReserve?: bigint;
  customBufferLength?: number;
}

/**
 * Creates an authoritative 752-byte Raydium AMM v4 Buffer.
 */
export function createAuthoritativeRaydiumAmmV4Buffer(options: RaydiumFixtureOptions = {}): Buffer {
  const length = options.customBufferLength ?? RAYDIUM_AMM_V4_LAYOUT_LENGTH;
  const buffer = Buffer.alloc(length);

  if (length < RAYDIUM_AMM_V4_LAYOUT_LENGTH) {
    return buffer;
  }

  const baseDec = options.baseDecimal ?? 6n;
  const quoteDec = options.quoteDecimal ?? 9n;

  buffer.writeBigUInt64LE(1n, RAYDIUM_V4_OFFSETS.STATUS);
  buffer.writeBigUInt64LE(baseDec, RAYDIUM_V4_OFFSETS.BASE_DECIMAL);
  buffer.writeBigUInt64LE(quoteDec, RAYDIUM_V4_OFFSETS.QUOTE_DECIMAL);

  buffer.writeBigUInt64LE(options.baseNeedTakePnl ?? 0n, RAYDIUM_V4_OFFSETS.BASE_NEED_TAKE_PNL);
  buffer.writeBigUInt64LE(options.quoteNeedTakePnl ?? 0n, RAYDIUM_V4_OFFSETS.QUOTE_NEED_TAKE_PNL);
  buffer.writeBigUInt64LE(0n, RAYDIUM_V4_OFFSETS.QUOTE_TOTAL_PNL);
  buffer.writeBigUInt64LE(0n, RAYDIUM_V4_OFFSETS.BASE_TOTAL_PNL);

  const baseVaultBytes = decodeBase58To32Bytes(options.baseVaultBase58 ?? FIXTURE_BASE_VAULT);
  const quoteVaultBytes = decodeBase58To32Bytes(options.quoteVaultBase58 ?? FIXTURE_QUOTE_VAULT);
  const baseMintBytes = decodeBase58To32Bytes(options.baseMintBase58 ?? FIXTURE_MEME_MINT);
  const quoteMintBytes = decodeBase58To32Bytes(options.quoteMintBase58 ?? FIXTURE_WSOL_MINT);
  const lpMintBytes = decodeBase58To32Bytes(options.lpMintBase58 ?? FIXTURE_LP_MINT);
  const openOrdersBytes = decodeBase58To32Bytes("So11111111111111111111111111111111111111114");
  const marketIdBytes = decodeBase58To32Bytes("So11111111111111111111111111111111111111115");

  buffer.set(baseVaultBytes, RAYDIUM_V4_OFFSETS.BASE_VAULT);
  buffer.set(quoteVaultBytes, RAYDIUM_V4_OFFSETS.QUOTE_VAULT);
  buffer.set(baseMintBytes, RAYDIUM_V4_OFFSETS.BASE_MINT);
  buffer.set(quoteMintBytes, RAYDIUM_V4_OFFSETS.QUOTE_MINT);
  buffer.set(lpMintBytes, RAYDIUM_V4_OFFSETS.LP_MINT);
  buffer.set(openOrdersBytes, RAYDIUM_V4_OFFSETS.OPEN_ORDERS);
  buffer.set(marketIdBytes, RAYDIUM_V4_OFFSETS.MARKET_ID);

  if (options.lpReserve !== undefined) {
    buffer.writeBigUInt64LE(options.lpReserve, RAYDIUM_V4_OFFSETS.LP_RESERVE);
  }

  return buffer;
}

export interface SplVaultFixtureOptions {
  mintBase58?: string;
  ownerBase58?: string;
  rawAmount?: bigint;
  state?: number;
  customBufferLength?: number;
}

/**
 * Creates an authoritative 165-byte SPL Token Account Buffer for a vault.
 */
export function createAuthoritativeSplVaultBuffer(options: SplVaultFixtureOptions = {}): Buffer {
  const length = options.customBufferLength ?? SPL_VAULT_LAYOUT_LENGTH;
  const buffer = Buffer.alloc(length);

  if (length < SPL_VAULT_LAYOUT_LENGTH) {
    return buffer;
  }

  const mintBytes = decodeBase58To32Bytes(options.mintBase58 ?? FIXTURE_MEME_MINT);
  const ownerBytes = decodeBase58To32Bytes(options.ownerBase58 ?? RAYDIUM_AMM_V4_PROGRAM_ID);

  buffer.set(mintBytes, SPL_VAULT_OFFSETS.MINT);
  buffer.set(ownerBytes, SPL_VAULT_OFFSETS.OWNER);

  buffer.writeBigUInt64LE(options.rawAmount ?? 1_000_000_000_000n, SPL_VAULT_OFFSETS.AMOUNT);
  buffer[SPL_VAULT_OFFSETS.STATE] = options.state ?? 1; // Default to 1: Initialized (BREADY-03)

  return buffer;
}

export interface SplMintFixtureOptions {
  mintAuthorityOption?: number;
  mintAuthorityBase58?: string | null;
  supply?: bigint;
  decimals?: number;
  isInitialized?: boolean;
  freezeAuthorityOption?: number;
  freezeAuthorityBase58?: string | null;
  customBufferLength?: number;
}

/**
 * Creates an authoritative 82-byte SPL Token Mint buffer.
 */
export function createAuthoritativeSplMintBuffer(options: SplMintFixtureOptions = {}): Buffer {
  const length = options.customBufferLength ?? 82;
  const buffer = Buffer.alloc(length);

  if (length < 82) {
    return buffer;
  }

  const hasMintAuth =
    options.mintAuthorityBase58 !== undefined && options.mintAuthorityBase58 !== null;
  const mintAuthOption = options.mintAuthorityOption ?? (hasMintAuth ? 1 : 0);
  buffer.writeUInt32LE(mintAuthOption, 0);

  if (mintAuthOption === 1 && options.mintAuthorityBase58) {
    buffer.set(decodeBase58To32Bytes(options.mintAuthorityBase58), 4);
  }

  buffer.writeBigUInt64LE(options.supply ?? 1_000_000_000n, 36);
  buffer.writeUInt8(options.decimals ?? 6, 44);
  buffer.writeUInt8((options.isInitialized ?? true) ? 1 : 0, 45);

  const hasFreezeAuth =
    options.freezeAuthorityBase58 !== undefined && options.freezeAuthorityBase58 !== null;
  const freezeAuthOption = options.freezeAuthorityOption ?? (hasFreezeAuth ? 1 : 0);
  buffer.writeUInt32LE(freezeAuthOption, 46);

  if (freezeAuthOption === 1 && options.freezeAuthorityBase58) {
    buffer.set(decodeBase58To32Bytes(options.freezeAuthorityBase58), 50);
  }

  return buffer;
}
