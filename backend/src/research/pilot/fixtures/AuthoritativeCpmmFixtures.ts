/**
 * Phase 12.94-D Milestone D.2.8: Authoritative Raydium CPMM Fixtures
 *
 * Constructs 637-byte Raydium CPMM PoolState account buffers matching the official
 * Anchor zero_copy packed C layout in raydium-io/raydium-cp-swap v0.1.0.
 *
 * Provides:
 * 1. Positive fixtures:
 *    - WSOL native pair (Token 0 Token / Token 1 WSOL)
 *    - Inverted WSOL native pair (Token 0 WSOL / Token 1 Token)
 *    - Stablecoin USD pair (Token 0 Token / Token 1 USDC)
 *    - Exotic cross-pair (Token 0 Meme / Token 1 Meme)
 *    - Fee liability accruals (protocol fees, fund fees)
 *    - Token-2022 program pair
 * 2. Negative fixtures:
 *    - Truncated buffer (< 637 bytes)
 *    - Corrupted Anchor discriminator (not 0xf7ede3f5d7c3de46)
 *    - Contradictory mints (token_0_mint === token_1_mint)
 *    - Contradictory vaults (token_0_vault === token_1_vault)
 *    - Invalid decimals (> 18)
 *    - Unsupported token program (neither SPL Token nor Token-2022)
 *    - Invalid pubkey bytes
 */

import {
  RAYDIUM_CPMM_ANCHOR_DISCRIMINATOR,
  RAYDIUM_CPMM_LAYOUT_LENGTH,
  RAYDIUM_CPMM_OFFSETS,
  SPL_TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "../RaydiumCpmmParser.js";
import { decodeBase58To32Bytes } from "./AuthoritativeRaydiumFixtures.js";

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

  return buffer;
}
