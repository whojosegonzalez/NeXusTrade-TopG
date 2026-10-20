/**
 * Phase 12.94-D Milestone D.2.8: Authoritative Raydium CPMM Fixtures
 *
 * Constructs 637-byte Raydium CPMM PoolState account buffers matching the official
 * Anchor zero_copy packed C layout in raydium-io/raydium-cp-swap v0.1.0 (PR #55/#80).
 *
 * Provides:
 * 1. Standard configurable fixture generator (`createAuthoritativeRaydiumCpmmBuffer`).
 * 2. Independent hardcoded layout buffer (`createIndependentHardcodedCpmmBuffer`)
 *    that uses raw literal byte offsets independent of parser constant references (D28-F1).
 */

import {
  RAYDIUM_CPMM_ANCHOR_DISCRIMINATOR,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_LAYOUT_LENGTH,
  RAYDIUM_CPMM_OFFSETS,
  SPL_TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "../RaydiumCpmmParser.js";

export { RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_CPMM_AUTHORITY };
import {
  createAuthoritativeSplVaultBuffer,
  decodeBase58To32Bytes,
  type SplVaultFixtureOptions,
} from "./AuthoritativeRaydiumFixtures.js";

export const FIXTURE_CPMM_POOL_ADDRESS = "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp";
export const FIXTURE_CPMM_AMM_CONFIG = "D4F5ch3Syuy9WP3MKNmxoWgKcDpDxWtaMmrtwpjRQDU";
export const FIXTURE_CPMM_CREATOR = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";
export const FIXTURE_CPMM_TOKEN_0_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // Bonk
export const FIXTURE_CPMM_TOKEN_1_MINT = WSOL_MINT; // WSOL
export const FIXTURE_CPMM_TOKEN_0_VAULT = "9UYjh9A2dE1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8F";
export const FIXTURE_CPMM_TOKEN_1_VAULT = "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v";
export const FIXTURE_CPMM_LP_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
export const FIXTURE_CPMM_OBSERVATION = "obs1111111111111111111111111111111111111111";
export const FIXTURE_CPMM_USDC_MINT = USDC_MINT;
export const FIXTURE_CPMM_MEME_MINT_2 = "68R6PSWipAwGVmHpfvsCSfQG6chrqe7q4tA3uDoevJ2S"; // zkat

export interface CpmmFixtureOptions {
  customBufferLength?: number;
  discriminator?: number[];
  ammConfigBase58?: string;
  poolCreatorBase58?: string;
  token0VaultBase58?: string;
  token1VaultBase58?: string;
  lpMintBase58?: string;
  token0MintBase58?: string;
  token1MintBase58?: string;
  token0ProgramBase58?: string;
  token1ProgramBase58?: string;
  observationKeyBase58?: string;
  authBump?: number;
  status?: number;
  lpMintDecimals?: number;
  mint0Decimals?: number;
  mint1Decimals?: number;
  lpSupply?: bigint;
  protocolFeesToken0?: bigint;
  protocolFeesToken1?: bigint;
  fundFeesToken0?: bigint;
  fundFeesToken1?: bigint;
  openTime?: bigint;
  recentEpoch?: bigint;
  creatorFeeOn?: number;
  enableCreatorFee?: boolean;
  creatorFeesToken0?: bigint;
  creatorFeesToken1?: bigint;
}

/**
 * Creates an authoritative 637-byte Raydium CPMM PoolState Buffer.
 */
export function createAuthoritativeRaydiumCpmmBuffer(options: CpmmFixtureOptions = {}): Buffer {
  const length = options.customBufferLength ?? RAYDIUM_CPMM_LAYOUT_LENGTH;
  const buffer = Buffer.alloc(length);

  if (length < RAYDIUM_CPMM_LAYOUT_LENGTH) {
    return buffer;
  }

  // 1. Discriminator (bytes 0..8)
  const disc = options.discriminator ?? RAYDIUM_CPMM_ANCHOR_DISCRIMINATOR;
  for (let i = 0; i < 8; i++) {
    buffer[i] = disc[i] ?? 0;
  }

  // 2. Pubkeys (32 bytes each)
  const writePubkey = (offset: number, base58: string) => {
    const bytes = decodeBase58To32Bytes(base58);
    buffer.set(bytes, offset);
  };

  writePubkey(RAYDIUM_CPMM_OFFSETS.AMM_CONFIG, options.ammConfigBase58 ?? FIXTURE_CPMM_AMM_CONFIG);
  writePubkey(RAYDIUM_CPMM_OFFSETS.POOL_CREATOR, options.poolCreatorBase58 ?? FIXTURE_CPMM_CREATOR);
  writePubkey(
    RAYDIUM_CPMM_OFFSETS.TOKEN_0_VAULT,
    options.token0VaultBase58 ?? FIXTURE_CPMM_TOKEN_0_VAULT,
  );
  writePubkey(
    RAYDIUM_CPMM_OFFSETS.TOKEN_1_VAULT,
    options.token1VaultBase58 ?? FIXTURE_CPMM_TOKEN_1_VAULT,
  );
  writePubkey(RAYDIUM_CPMM_OFFSETS.LP_MINT, options.lpMintBase58 ?? FIXTURE_CPMM_LP_MINT);
  writePubkey(
    RAYDIUM_CPMM_OFFSETS.TOKEN_0_MINT,
    options.token0MintBase58 ?? FIXTURE_CPMM_TOKEN_0_MINT,
  );
  writePubkey(
    RAYDIUM_CPMM_OFFSETS.TOKEN_1_MINT,
    options.token1MintBase58 ?? FIXTURE_CPMM_TOKEN_1_MINT,
  );
  writePubkey(
    RAYDIUM_CPMM_OFFSETS.TOKEN_0_PROGRAM,
    options.token0ProgramBase58 ?? SPL_TOKEN_PROGRAM_ID,
  );
  writePubkey(
    RAYDIUM_CPMM_OFFSETS.TOKEN_1_PROGRAM,
    options.token1ProgramBase58 ?? SPL_TOKEN_PROGRAM_ID,
  );
  writePubkey(
    RAYDIUM_CPMM_OFFSETS.OBSERVATION_KEY,
    options.observationKeyBase58 ?? FIXTURE_CPMM_OBSERVATION,
  );

  // 3. Byte fields
  buffer.writeUInt8(options.authBump ?? 254, RAYDIUM_CPMM_OFFSETS.AUTH_BUMP);
  buffer.writeUInt8(options.status ?? 0, RAYDIUM_CPMM_OFFSETS.STATUS);
  buffer.writeUInt8(options.lpMintDecimals ?? 6, RAYDIUM_CPMM_OFFSETS.LP_MINT_DECIMALS);
  buffer.writeUInt8(options.mint0Decimals ?? 5, RAYDIUM_CPMM_OFFSETS.MINT_0_DECIMALS);
  buffer.writeUInt8(options.mint1Decimals ?? 9, RAYDIUM_CPMM_OFFSETS.MINT_1_DECIMALS);

  // 4. u64 LE fields
  buffer.writeBigUInt64LE(options.lpSupply ?? 1_000_000_000_000n, RAYDIUM_CPMM_OFFSETS.LP_SUPPLY);
  buffer.writeBigUInt64LE(
    options.protocolFeesToken0 ?? 0n,
    RAYDIUM_CPMM_OFFSETS.PROTOCOL_FEES_TOKEN_0,
  );
  buffer.writeBigUInt64LE(
    options.protocolFeesToken1 ?? 0n,
    RAYDIUM_CPMM_OFFSETS.PROTOCOL_FEES_TOKEN_1,
  );
  buffer.writeBigUInt64LE(options.fundFeesToken0 ?? 0n, RAYDIUM_CPMM_OFFSETS.FUND_FEES_TOKEN_0);
  buffer.writeBigUInt64LE(options.fundFeesToken1 ?? 0n, RAYDIUM_CPMM_OFFSETS.FUND_FEES_TOKEN_1);
  buffer.writeBigUInt64LE(options.openTime ?? 1792370000n, RAYDIUM_CPMM_OFFSETS.OPEN_TIME);
  buffer.writeBigUInt64LE(options.recentEpoch ?? 650n, RAYDIUM_CPMM_OFFSETS.RECENT_EPOCH);

  // 5. Creator fees (D28-F1)
  buffer.writeUInt8(options.creatorFeeOn ?? 0, RAYDIUM_CPMM_OFFSETS.CREATOR_FEE_ON);
  buffer.writeUInt8(options.enableCreatorFee ? 1 : 0, RAYDIUM_CPMM_OFFSETS.ENABLE_CREATOR_FEE);
  buffer.writeBigUInt64LE(
    options.creatorFeesToken0 ?? 0n,
    RAYDIUM_CPMM_OFFSETS.CREATOR_FEES_TOKEN_0,
  );
  buffer.writeBigUInt64LE(
    options.creatorFeesToken1 ?? 0n,
    RAYDIUM_CPMM_OFFSETS.CREATOR_FEES_TOKEN_1,
  );

  return buffer;
}

/**
 * Creates an independent raw 637-byte buffer using hardcoded literal byte offsets,
 * entirely independent of the parser's RAYDIUM_CPMM_OFFSETS constants (D28-F1 requirement 7).
 */
export function createIndependentHardcodedCpmmBuffer(params: {
  token0MintBase58: string;
  token1MintBase58: string;
  token0VaultBase58: string;
  token1VaultBase58: string;
  mint0Decimals: number;
  mint1Decimals: number;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  creatorFeesToken0: bigint;
  creatorFeesToken1: bigint;
  creatorFeeOn: number;
  enableCreatorFee: boolean;
  openTime: bigint;
  recentEpoch: bigint;
}): Buffer {
  const buf = Buffer.alloc(637);

  // Hardcoded literal discriminator
  buf[0] = 0xf7;
  buf[1] = 0xed;
  buf[2] = 0xe3;
  buf[3] = 0xf5;
  buf[4] = 0xd7;
  buf[5] = 0xc3;
  buf[6] = 0xde;
  buf[7] = 0x46;

  const set32 = (offset: number, b58: string) => {
    buf.set(decodeBase58To32Bytes(b58), offset);
  };

  set32(8, FIXTURE_CPMM_AMM_CONFIG);
  set32(40, FIXTURE_CPMM_CREATOR);
  set32(72, params.token0VaultBase58);
  set32(104, params.token1VaultBase58);
  set32(136, FIXTURE_CPMM_LP_MINT);
  set32(168, params.token0MintBase58);
  set32(200, params.token1MintBase58);
  set32(232, SPL_TOKEN_PROGRAM_ID);
  set32(264, SPL_TOKEN_PROGRAM_ID);
  set32(296, FIXTURE_CPMM_OBSERVATION);

  buf.writeUInt8(254, 328); // authBump
  buf.writeUInt8(0, 329); // status
  buf.writeUInt8(6, 330); // lpMintDecimals
  buf.writeUInt8(params.mint0Decimals, 331); // mint0Decimals
  buf.writeUInt8(params.mint1Decimals, 332); // mint1Decimals

  buf.writeBigUInt64LE(1_000_000_000n, 333); // lpSupply
  buf.writeBigUInt64LE(params.protocolFeesToken0, 341); // protocolFeesToken0
  buf.writeBigUInt64LE(params.protocolFeesToken1, 349); // protocolFeesToken1
  buf.writeBigUInt64LE(params.fundFeesToken0, 357); // fundFeesToken0
  buf.writeBigUInt64LE(params.fundFeesToken1, 365); // fundFeesToken1
  buf.writeBigUInt64LE(params.openTime, 373); // openTime
  buf.writeBigUInt64LE(params.recentEpoch, 381); // recentEpoch

  buf.writeUInt8(params.creatorFeeOn, 389); // creatorFeeOn
  buf.writeUInt8(params.enableCreatorFee ? 1 : 0, 390); // enableCreatorFee
  // 391..397 padding1 (6 bytes zero)
  buf.writeBigUInt64LE(params.creatorFeesToken0, 397); // creatorFeesToken0
  buf.writeBigUInt64LE(params.creatorFeesToken1, 405); // creatorFeesToken1
  // 413..637 padding (224 bytes zero)

  return buf;
}

/**
 * Creates an authoritative 165-byte SPL Token Account Buffer for a CPMM vault,
 * with owner/authority matching the canonical Raydium CPMM authority PDA (D29-F1).
 */
export function createAuthoritativeCpmmSplVaultBuffer(
  options: SplVaultFixtureOptions = {},
): Buffer {
  return createAuthoritativeSplVaultBuffer({
    ...options,
    ownerBase58: options.ownerBase58 ?? RAYDIUM_CPMM_AUTHORITY,
  });
}
