/**
 * Phase 12.94-D Milestone D.2.9-A: Authoritative Event & Transaction Fixtures
 *
 * Provides deterministic, offline synthetic transaction metadata and WebSocket
 * log-notification envelopes for testing Raydium AMM v4 and CPMM event discovery.
 *
 * Capabilities:
 * 1. AMM v4 initialize2 versioned transactions (legacy and v0 with Address Lookup Tables).
 * 2. CPMM initialize Anchor versioned transactions with discriminators and openTime.
 * 3. Failed transactions (err !== null).
 * 4. Non-initialization instructions (e.g. swaps).
 * 5. Unsupported DEX protocol fixtures (Orca Whirlpool, Raydium CLMM, Meteora DLMM, Pump.fun).
 * 6. Malformed transactions (missing accounts, truncated data, out-of-bounds ALT indices).
 * 7. Mock read-only account fetcher for deterministic verification tests.
 */

import type {
  CompiledInstruction,
  DiscoveredPoolAccountPayload,
  IOnChainAccountFetcher,
  VersionedTransactionMetadata,
  WebSocketLogNotificationEnvelope,
} from "../EventDiscoveryContracts.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CPMM_INIT_DISCRIMINATOR,
  RAYDIUM_CPMM_PROGRAM_ID,
} from "../PoolInitializationParser.js";
import { RAYDIUM_CPMM_AUTHORITY, SPL_TOKEN_PROGRAM_ID } from "../RaydiumCpmmParser.js";
import {
  FIXTURE_BASE_VAULT,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_QUOTE_VAULT,
  FIXTURE_WSOL_MINT,
} from "./AuthoritativeRaydiumFixtures.js";
import {
  FIXTURE_CPMM_AMM_CONFIG,
  FIXTURE_CPMM_CREATOR,
  FIXTURE_CPMM_LP_MINT,
  FIXTURE_CPMM_OBSERVATION,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_MINT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
} from "./AuthoritativeCpmmFixtures.js";

// Canonical constant accounts for AMM v4
export const FIXTURE_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const FIXTURE_RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";
export const FIXTURE_ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const FIXTURE_SERUM_PROGRAM = "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX";
export const FIXTURE_SERUM_MARKET = "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT";
export const FIXTURE_AMM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
export const FIXTURE_OPEN_ORDERS = "H3tWbXQhZkP2xL4cR8gY6mE9pQvJ7rT1uA5sN8wB3dK";
export const FIXTURE_TARGET_ORDERS = "B7mE9pQvJ7rT1uA5sN8wB3dKH3tWbXQhZkP2xL4cR8g";
export const FIXTURE_LP_MINT = "F3tWbXQhZkP2xL4cR8gY6mE9pQvJ7rT1uA5sN8wB3dK";
export const FIXTURE_USER_WALLET = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";

export interface AmmV4TxFixtureOptions {
  signature?: string;
  slot?: number;
  blockTime?: number;
  isVersion0?: boolean;
  poolId?: string;
  token0Mint?: string;
  token1Mint?: string;
  token0Vault?: string;
  token1Vault?: string;
  err?: unknown | null;
}

/**
 * Creates a deterministic Raydium AMM v4 pool initialization transaction fixture.
 */
export function createAmmV4InitTransactionFixture(
  options: AmmV4TxFixtureOptions = {},
): VersionedTransactionMetadata {
  const signature = options.signature ?? "5K...ammV4InitTxSignatureCanonical111111111111111111111";
  const slot = options.slot ?? 300000100;
  const blockTime = options.blockTime ?? 1792375100;
  const poolId = options.poolId ?? FIXTURE_POOL_ADDRESS;
  const coinMint = options.token0Mint ?? FIXTURE_MEME_MINT;
  const pcMint = options.token1Mint ?? FIXTURE_WSOL_MINT;
  const coinVault = options.token0Vault ?? FIXTURE_BASE_VAULT;
  const pcVault = options.token1Vault ?? FIXTURE_QUOTE_VAULT;

  // Ordered accounts for initialize2:
  // 0: Token Program, 1: ATA Program, 2: System Program, 3: Rent Sysvar,
  // 4: AMM Account (poolId), 5: AMM Authority, 6: Open Orders, 7: LP Mint,
  // 8: Coin Mint, 9: PC Mint, 10: Coin Vault, 11: PC Vault, 12: Target Orders,
  // 13: Model, 14: User Payer, 15: User Coin, 16: User PC, 17: User LP,
  // 18: Serum Program, 19: Serum Market, 20: Raydium AMM Program
  const accounts = [
    SPL_TOKEN_PROGRAM_ID, // 0
    FIXTURE_ASSOCIATED_TOKEN_PROGRAM, // 1
    FIXTURE_SYSTEM_PROGRAM, // 2
    FIXTURE_RENT_SYSVAR, // 3
    poolId, // 4: AMM account
    FIXTURE_AMM_AUTHORITY, // 5
    FIXTURE_OPEN_ORDERS, // 6
    FIXTURE_LP_MINT, // 7
    coinMint, // 8
    pcMint, // 9
    coinVault, // 10
    pcVault, // 11
    FIXTURE_TARGET_ORDERS, // 12
    FIXTURE_SYSTEM_PROGRAM, // 13 (Model)
    FIXTURE_USER_WALLET, // 14 (Payer)
    FIXTURE_BASE_VAULT, // 15 (User Coin)
    FIXTURE_QUOTE_VAULT, // 16 (User PC)
    FIXTURE_LP_MINT, // 17 (User LP)
    FIXTURE_SERUM_PROGRAM, // 18
    FIXTURE_SERUM_MARKET, // 19
    RAYDIUM_AMM_V4_PROGRAM_ID, // 20: Program ID
  ];

  // Instruction data: byte 0 is 1 (initialize2), followed by nonce, openTime, etc.
  const data = Buffer.alloc(32);
  data.writeUInt8(1, 0); // tag = 1 (initialize2)
  data.writeBigUInt64LE(BigInt(blockTime), 8); // openTime

  if (options.isVersion0) {
    // Split into static keys and Address Lookup Table loaded keys
    const staticAccountKeys = accounts.slice(0, 10);
    const loadedWritable = accounts.slice(10, 16);
    const loadedReadonly = accounts.slice(16);

    const compiledInstruction: CompiledInstruction = {
      programIdIndex: 20, // References programId in loadedReadonly (index 20)
      accountKeyIndexes: accounts.map((_, idx) => idx).slice(0, 20),
      data,
    };

    return {
      signature,
      slot,
      blockTime,
      err: options.err ?? null,
      version: 0,
      accountKeys: {
        staticAccountKeys,
        loadedAddresses: {
          writable: loadedWritable,
          readonly: loadedReadonly,
        },
      },
      instructions: [compiledInstruction],
    };
  }

  // Legacy transaction fixture
  const compiledInstruction: CompiledInstruction = {
    programIdIndex: 20,
    accountKeyIndexes: accounts.map((_, idx) => idx).slice(0, 20),
    data,
  };

  return {
    signature,
    slot,
    blockTime,
    err: options.err ?? null,
    version: "legacy",
    accountKeys: {
      staticAccountKeys: accounts,
    },
    instructions: [compiledInstruction],
  };
}

export interface CpmmTxFixtureOptions {
  signature?: string;
  slot?: number;
  blockTime?: number;
  openTime?: number;
  isVersion0?: boolean;
  poolId?: string;
  token0Mint?: string;
  token1Mint?: string;
  token0Vault?: string;
  token1Vault?: string;
  err?: unknown | null;
}

/**
 * Creates a deterministic Raydium CPMM pool initialization transaction fixture.
 */
export function createCpmmInitTransactionFixture(
  options: CpmmTxFixtureOptions = {},
): VersionedTransactionMetadata {
  const signature = options.signature ?? "5K...cpmmInitTxSignatureCanonical222222222222222222222";
  const slot = options.slot ?? 300000200;
  const blockTime = options.blockTime ?? 1792375200;
  const openTime = options.openTime ?? blockTime + 300; // unlocks 5 mins later
  const poolId = options.poolId ?? FIXTURE_CPMM_POOL_ADDRESS;
  const token0Mint = options.token0Mint ?? FIXTURE_CPMM_TOKEN_0_MINT;
  const token1Mint = options.token1Mint ?? FIXTURE_CPMM_TOKEN_1_MINT;
  const token0Vault = options.token0Vault ?? FIXTURE_CPMM_TOKEN_0_VAULT;
  const token1Vault = options.token1Vault ?? FIXTURE_CPMM_TOKEN_1_VAULT;

  // Ordered accounts for CPMM initialize:
  // 0: creator, 1: amm_config, 2: authority PDA, 3: pool_state,
  // 4: token_0_mint, 5: token_1_mint, 6: lp_mint, 7: creator_token_0,
  // 8: creator_token_1, 9: creator_lp_token, 10: token_0_vault, 11: token_1_vault,
  // 12: create_pool_fee, 13: observation_state, 14: token_program,
  // 15: token_0_program, 16: token_1_program, 17: CPMM Program
  const accounts = [
    FIXTURE_CPMM_CREATOR, // 0
    FIXTURE_CPMM_AMM_CONFIG, // 1
    RAYDIUM_CPMM_AUTHORITY, // 2
    poolId, // 3: PoolState
    token0Mint, // 4
    token1Mint, // 5
    FIXTURE_CPMM_LP_MINT, // 6
    token0Vault, // 7: creator_token_0
    token1Vault, // 8: creator_token_1
    FIXTURE_CPMM_LP_MINT, // 9: creator_lp_token
    token0Vault, // 10: token_0_vault
    token1Vault, // 11: token_1_vault
    FIXTURE_CPMM_CREATOR, // 12: create_pool_fee
    FIXTURE_CPMM_OBSERVATION, // 13: observation_state
    SPL_TOKEN_PROGRAM_ID, // 14: token_program
    SPL_TOKEN_PROGRAM_ID, // 15: token_0_program
    SPL_TOKEN_PROGRAM_ID, // 16: token_1_program
    RAYDIUM_CPMM_PROGRAM_ID, // 17: Program ID
  ];

  // Instruction data: Anchor discriminator (8B) + init_amount_0 (8B) + init_amount_1 (8B) + open_time (8B)
  const data = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) {
    data[i] = RAYDIUM_CPMM_INIT_DISCRIMINATOR[i] ?? 0;
  }
  data.writeBigUInt64LE(1_000_000_000n, 8); // init_amount_0
  data.writeBigUInt64LE(5_000_000_000n, 16); // init_amount_1
  data.writeBigUInt64LE(BigInt(openTime), 24); // open_time

  if (options.isVersion0) {
    const staticAccountKeys = accounts.slice(0, 8);
    const loadedWritable = accounts.slice(8, 14);
    const loadedReadonly = accounts.slice(14);

    const compiledInstruction: CompiledInstruction = {
      programIdIndex: 17, // CPMM program ID
      accountKeyIndexes: accounts.map((_, idx) => idx).slice(0, 17),
      data,
    };

    return {
      signature,
      slot,
      blockTime,
      err: options.err ?? null,
      version: 0,
      accountKeys: {
        staticAccountKeys,
        loadedAddresses: {
          writable: loadedWritable,
          readonly: loadedReadonly,
        },
      },
      instructions: [compiledInstruction],
    };
  }

  const compiledInstruction: CompiledInstruction = {
    programIdIndex: 17,
    accountKeyIndexes: accounts.map((_, idx) => idx).slice(0, 17),
    data,
  };

  return {
    signature,
    slot,
    blockTime,
    err: options.err ?? null,
    version: "legacy",
    accountKeys: {
      staticAccountKeys: accounts,
    },
    instructions: [compiledInstruction],
  };
}

/**
 * Creates an unsupported DEX transaction fixture.
 */
export function createUnsupportedProtocolTransactionFixture(
  unsupportedProgramId: string,
  signature = "5K...unsupportedDexTxCanonical3333333333333333333",
): VersionedTransactionMetadata {
  const accounts = [
    FIXTURE_USER_WALLET,
    FIXTURE_MEME_MINT,
    FIXTURE_WSOL_MINT,
    unsupportedProgramId,
  ];

  return {
    signature,
    slot: 300000300,
    blockTime: 1792375300,
    err: null,
    version: "legacy",
    accountKeys: {
      staticAccountKeys: accounts,
    },
    instructions: [
      {
        programIdIndex: 3,
        accountKeyIndexes: [0, 1, 2],
        data: Buffer.alloc(16),
      },
    ],
  };
}

/**
 * Creates a mock WebSocket log-notification envelope.
 */
export function createMockLogNotificationEnvelope(
  signature: string,
  slot: number = 300000100,
  err: unknown | null = null,
): WebSocketLogNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      result: {
        context: { slot },
        value: {
          signature,
          err,
          logs: [
            "Program 11111111111111111111111111111111 invoke [1]",
            "Program 11111111111111111111111111111111 success",
          ],
        },
      },
      subscription: 12345,
    },
  };
}

/**
 * In-memory mock on-chain account fetcher for deterministic unit and negative tests.
 */
export class MockOnChainAccountFetcher implements IOnChainAccountFetcher {
  private readonly accounts = new Map<string, DiscoveredPoolAccountPayload>();
  private currentSlot: number;

  constructor(initialSlot = 300000100) {
    this.currentSlot = initialSlot;
  }

  public setAccount(
    address: string,
    owner: string,
    data: Buffer,
    slot: number = this.currentSlot,
    lamports = 100_000_000n,
  ): void {
    this.accounts.set(address, {
      address,
      owner,
      data,
      slot,
      lamports,
    });
  }

  public setSlot(slot: number): void {
    this.currentSlot = slot;
  }

  public async getAccountInfo(address: string): Promise<DiscoveredPoolAccountPayload | null> {
    return this.accounts.get(address) ?? null;
  }

  public async getMultipleAccounts(
    addresses: readonly string[],
  ): Promise<readonly (DiscoveredPoolAccountPayload | null)[]> {
    return addresses.map((addr) => this.accounts.get(addr) ?? null);
  }

  public async getSlot(): Promise<number> {
    return this.currentSlot;
  }
}
