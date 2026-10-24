/**
 * Phase 12.94-D Milestone D.2.9-A: Authoritative Event & Transaction Fixtures
 *
 * Provides deterministic, offline synthetic transaction metadata and WebSocket
 * log-notification envelopes for testing Raydium AMM v4 and CPMM event discovery.
 *
 * Capabilities:
 * 1. AMM v4 initialize2 versioned transactions matching authoritative upstream instruction.rs
 *    (21 accounts in official order, 26-byte payload, open_time at bytes 2..10, creator at 17, market at 15-16).
 * 2. CPMM initialize Anchor versioned transactions with discriminators and openTime.
 * 3. Base58 and Base64 RPC string instruction data representations.
 * 4. Nested CPI innerInstructions and multiple-initialization transactions.
 * 5. Failed transactions (err !== null).
 * 6. Non-initialization instructions (e.g. swaps).
 * 7. Unsupported DEX protocol fixtures (Orca Whirlpool, Raydium CLMM, Meteora DLMM, Pump.fun).
 * 8. Malformed transactions (missing accounts, truncated data, out-of-bounds ALT indices).
 * 9. Mock read-only account fetcher for deterministic verification tests.
 */

import { encodeBase58 } from "../../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import type {
  CompiledInstruction,
  DiscoveredPoolAccountPayload,
  IOnChainAccountFetcher,
  Version1TransactionConfig,
  VersionedTransactionMetadata,
  WebSocketLogNotificationEnvelope,
} from "../EventDiscoveryContracts.js";
import {
  RAYDIUM_AMM_V4_INIT2_PAYLOAD_LENGTH,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CPMM_INIT_DISCRIMINATOR,
  RAYDIUM_CPMM_PROGRAM_ID,
} from "../PoolInitializationParser.js";
import { RAYDIUM_CPMM_AUTHORITY, SPL_TOKEN_PROGRAM_ID } from "../RaydiumCpmmParser.js";
import {
  createAuthoritativeCpmmSplVaultBuffer,
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
import {
  createAuthoritativeSplVaultBuffer,
  FIXTURE_BASE_VAULT,
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_QUOTE_VAULT,
  FIXTURE_WSOL_MINT,
} from "./AuthoritativeRaydiumFixtures.js";

export { createAuthoritativeSplVaultBuffer, createAuthoritativeCpmmSplVaultBuffer };

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
  signature?: string | undefined;
  slot?: number | undefined;
  blockTime?: number | undefined;
  openTime?: number | undefined;
  isVersion0?: boolean | undefined;
  isVersion1?: boolean | undefined;
  version?: "legacy" | 0 | 1 | undefined;
  transactionConfig?: Version1TransactionConfig | undefined;
  poolId?: string | undefined;
  token0Mint?: string | undefined;
  token1Mint?: string | undefined;
  token0Vault?: string | undefined;
  token1Vault?: string | undefined;
  creatorWallet?: string | undefined;
  marketId?: string | undefined;
  marketProgramId?: string | undefined;
  err?: unknown | null | undefined;
  tag?: number | undefined;
  customDataLength?: number | undefined;
  asBase58String?: boolean | undefined;
  asBase64String?: boolean | undefined;
}

/**
 * Creates a deterministic Raydium AMM v4 pool initialization transaction fixture
 * conforming to upstream raydium-amm instruction.rs (21 accounts, 26-byte payload).
 */
export function createAmmV4InitTransactionFixture(
  options: AmmV4TxFixtureOptions = {},
): VersionedTransactionMetadata {
  const signature = options.signature ?? "5K...ammV4InitTxSignatureCanonical111111111111111111111";
  const slot = options.slot ?? 300000100;
  const blockTime = options.blockTime ?? 1792375100;
  const openTime = options.openTime ?? blockTime + 120; // Pool unlock time distinct from blockTime (D29-F2)
  const poolId = options.poolId ?? FIXTURE_POOL_ADDRESS;
  const coinMint = options.token0Mint ?? FIXTURE_MEME_MINT;
  const pcMint = options.token1Mint ?? FIXTURE_WSOL_MINT;
  const coinVault = options.token0Vault ?? FIXTURE_BASE_VAULT;
  const pcVault = options.token1Vault ?? FIXTURE_QUOTE_VAULT;
  const creatorWallet = options.creatorWallet ?? FIXTURE_USER_WALLET;
  const marketProgramId = options.marketProgramId ?? FIXTURE_SERUM_PROGRAM;
  const marketId = options.marketId ?? FIXTURE_SERUM_MARKET;

  // Ordered accounts for initialize2 per raydium-amm instruction.rs (21 accounts):
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
  // 21: Raydium AMM Program (invoked program)
  const accounts = [
    SPL_TOKEN_PROGRAM_ID, // 0
    FIXTURE_ASSOCIATED_TOKEN_PROGRAM, // 1
    FIXTURE_SYSTEM_PROGRAM, // 2
    FIXTURE_RENT_SYSVAR, // 3
    poolId, // 4: AMM account
    FIXTURE_AMM_AUTHORITY, // 5
    FIXTURE_OPEN_ORDERS, // 6
    FIXTURE_LP_MINT, // 7
    coinMint, // 8: coin mint
    pcMint, // 9: pc mint
    coinVault, // 10: coin vault
    pcVault, // 11: pc vault
    FIXTURE_TARGET_ORDERS, // 12
    FIXTURE_SYSTEM_PROGRAM, // 13: ammConfig
    FIXTURE_SYSTEM_PROGRAM, // 14: feeDestination
    marketProgramId, // 15: marketProgramId
    marketId, // 16: marketId
    creatorWallet, // 17: creator wallet
    FIXTURE_BASE_VAULT, // 18: userTokenCoin
    FIXTURE_QUOTE_VAULT, // 19: userTokenPc
    FIXTURE_LP_MINT, // 20: userLpAta
    RAYDIUM_AMM_V4_PROGRAM_ID, // 21: Program ID
  ];

  // Authoritative initialize2 payload (26 bytes):
  // 0: tag = 1 (u8)
  // 1: nonce (u8)
  // 2..10: open_time (u64 LE)
  // 10..18: init_pc_amount (u64 LE)
  // 18..26: init_coin_amount (u64 LE)
  const length = options.customDataLength ?? RAYDIUM_AMM_V4_INIT2_PAYLOAD_LENGTH;
  const dataBuf = Buffer.alloc(length);
  if (length >= 1) dataBuf.writeUInt8(options.tag ?? 1, 0); // tag = 1 (initialize2)
  if (length >= 2) dataBuf.writeUInt8(254, 1); // nonce
  if (length >= 10) dataBuf.writeBigUInt64LE(BigInt(openTime), 2); // open_time
  if (length >= 18) dataBuf.writeBigUInt64LE(100_000_000_000n, 10); // init_pc_amount
  if (length >= 26) dataBuf.writeBigUInt64LE(50_000_000_000n, 18); // init_coin_amount

  let finalData: Buffer | string = dataBuf;
  let finalEncoding: "raw" | "base58" | "base64" | undefined = undefined;

  if (options.asBase58String) {
    finalData = encodeBase58(dataBuf);
    finalEncoding = "base58";
  } else if (options.asBase64String) {
    finalData = dataBuf.toString("base64");
    finalEncoding = "base64";
  }

  const accountKeyIndexes = accounts.map((_, idx) => idx).slice(0, 21);

  if (options.isVersion1 || options.version === 1) {
    // Version 1 (SIMD-0385): All account keys are inline in staticAccountKeys (no ALTs)
    const compiledInstruction: CompiledInstruction = {
      programIdIndex: 21,
      accountKeyIndexes,
      data: finalData,
      ...(finalEncoding ? { dataEncoding: finalEncoding } : {}),
    };

    return {
      signature,
      slot,
      blockTime,
      err: options.err ?? null,
      version: 1,
      accountKeys: {
        staticAccountKeys: accounts,
      },
      instructions: [compiledInstruction],
      transactionConfig: options.transactionConfig ?? {
        computeUnitLimit: 200_000,
        priorityFeeLamports: 10_000,
        loadedAccountsDataSizeLimit: 64_000,
        heapSize: 32_768,
      },
    };
  }

  if (options.isVersion0 || options.version === 0) {
    // Split into static keys and Address Lookup Table loaded keys
    const staticAccountKeys = accounts.slice(0, 11);
    const loadedWritable = accounts.slice(11, 17);
    const loadedReadonly = accounts.slice(17);

    const compiledInstruction: CompiledInstruction = {
      programIdIndex: 21, // References programId at index 21
      accountKeyIndexes,
      data: finalData,
      ...(finalEncoding ? { dataEncoding: finalEncoding } : {}),
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
    programIdIndex: 21,
    accountKeyIndexes,
    data: finalData,
    ...(finalEncoding ? { dataEncoding: finalEncoding } : {}),
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
  signature?: string | undefined;
  slot?: number | undefined;
  blockTime?: number | undefined;
  openTime?: number | undefined;
  isVersion0?: boolean | undefined;
  isVersion1?: boolean | undefined;
  version?: "legacy" | 0 | 1 | undefined;
  transactionConfig?: Version1TransactionConfig | undefined;
  poolId?: string | undefined;
  token0Mint?: string | undefined;
  token1Mint?: string | undefined;
  token0Vault?: string | undefined;
  token1Vault?: string | undefined;
  creatorWallet?: string | undefined;
  err?: unknown | null | undefined;
  asBase58String?: boolean | undefined;
  asBase64String?: boolean | undefined;
  customDataLength?: number | undefined;
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
  const creatorWallet = options.creatorWallet ?? FIXTURE_CPMM_CREATOR;

  // Ordered accounts for CPMM initialize per raydium-cp-swap instructions/initialize.rs (20 accounts):
  // 0: creator, 1: amm_config, 2: authority PDA, 3: pool_state,
  // 4: token_0_mint, 5: token_1_mint, 6: lp_mint, 7: creator_token_0,
  // 8: creator_token_1, 9: creator_lp_token, 10: token_0_vault, 11: token_1_vault,
  // 12: create_pool_fee, 13: observation_state, 14: token_program,
  // 15: token_0_program, 16: token_1_program, 17: associated_token_program,
  // 18: system_program, 19: rent, 20: CPMM Program
  const accounts = [
    creatorWallet, // 0
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
    creatorWallet, // 12: create_pool_fee
    FIXTURE_CPMM_OBSERVATION, // 13: observation_state
    SPL_TOKEN_PROGRAM_ID, // 14: token_program
    SPL_TOKEN_PROGRAM_ID, // 15: token_0_program
    SPL_TOKEN_PROGRAM_ID, // 16: token_1_program
    FIXTURE_ASSOCIATED_TOKEN_PROGRAM, // 17: associated_token_program
    FIXTURE_SYSTEM_PROGRAM, // 18: system_program
    FIXTURE_RENT_SYSVAR, // 19: rent sysvar
    RAYDIUM_CPMM_PROGRAM_ID, // 20: Program ID
  ];

  const length = options.customDataLength ?? 32;
  const dataBuf = Buffer.alloc(length);
  for (let i = 0; i < Math.min(8, length); i++) {
    dataBuf[i] = RAYDIUM_CPMM_INIT_DISCRIMINATOR[i] ?? 0;
  }
  if (length >= 16) dataBuf.writeBigUInt64LE(1_000_000_000n, 8); // init_amount_0
  if (length >= 24) dataBuf.writeBigUInt64LE(5_000_000_000n, 16); // init_amount_1
  if (length >= 32) dataBuf.writeBigUInt64LE(BigInt(openTime), 24); // open_time

  let finalData: Buffer | string = dataBuf;
  let finalEncoding: "raw" | "base58" | "base64" | undefined = undefined;

  if (options.asBase58String) {
    finalData = encodeBase58(dataBuf);
    finalEncoding = "base58";
  } else if (options.asBase64String) {
    finalData = dataBuf.toString("base64");
    finalEncoding = "base64";
  }

  const accountKeyIndexes = accounts.map((_, idx) => idx).slice(0, 20);

  if (options.isVersion1 || options.version === 1) {
    // Version 1 (SIMD-0385): All account keys are inline in staticAccountKeys (no ALTs)
    const compiledInstruction: CompiledInstruction = {
      programIdIndex: 20,
      accountKeyIndexes,
      data: finalData,
      ...(finalEncoding ? { dataEncoding: finalEncoding } : {}),
    };

    return {
      signature,
      slot,
      blockTime,
      err: options.err ?? null,
      version: 1,
      accountKeys: {
        staticAccountKeys: accounts,
      },
      instructions: [compiledInstruction],
      transactionConfig: options.transactionConfig ?? {
        computeUnitLimit: 200_000,
        priorityFeeLamports: 10_000,
        loadedAccountsDataSizeLimit: 64_000,
        heapSize: 32_768,
      },
    };
  }

  if (options.isVersion0 || options.version === 0) {
    const staticAccountKeys = accounts.slice(0, 10);
    const loadedWritable = accounts.slice(10, 16);
    const loadedReadonly = accounts.slice(16);

    const compiledInstruction: CompiledInstruction = {
      programIdIndex: 20, // CPMM program ID
      accountKeyIndexes,
      data: finalData,
      ...(finalEncoding ? { dataEncoding: finalEncoding } : {}),
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
    programIdIndex: 20,
    accountKeyIndexes,
    data: finalData,
    ...(finalEncoding ? { dataEncoding: finalEncoding } : {}),
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

export interface CpiTxFixtureOptions {
  protocol?: "RAYDIUM_AMM_V4" | "RAYDIUM_CPMM" | undefined;
  version?: "legacy" | 0 | 1 | undefined;
  isVersion1?: boolean | undefined;
  transactionConfig?: Version1TransactionConfig | undefined;
  signature?: string | undefined;
  slot?: number | undefined;
  blockTime?: number | undefined;
}

/**
 * Creates a transaction fixture with nested CPI innerInstructions (D29-F4).
 */
export function createCpiPoolInitTransactionFixture(
  protocolOrOptions: "RAYDIUM_AMM_V4" | "RAYDIUM_CPMM" | CpiTxFixtureOptions = "RAYDIUM_AMM_V4",
): VersionedTransactionMetadata {
  const options: CpiTxFixtureOptions =
    typeof protocolOrOptions === "string" ? { protocol: protocolOrOptions } : protocolOrOptions;
  const protocol = options.protocol ?? "RAYDIUM_AMM_V4";
  const isV1 = options.isVersion1 || options.version === 1;
  const sig = options.signature ?? "5K...cpiPoolInitSignature111111111111111111111111";

  const baseTx =
    protocol === "RAYDIUM_AMM_V4"
      ? createAmmV4InitTransactionFixture({
          signature: sig,
          slot: options.slot,
          blockTime: options.blockTime,
          isVersion1: isV1,
          transactionConfig: options.transactionConfig,
        })
      : createCpmmInitTransactionFixture({
          signature: sig,
          slot: options.slot,
          blockTime: options.blockTime,
          isVersion1: isV1,
          transactionConfig: options.transactionConfig,
        });

  // Top-level instruction invokes a proxy/wrapper contract
  const proxyProgramId = "ProxyWrapper111111111111111111111111111111";
  const accounts = [...baseTx.accountKeys.staticAccountKeys, proxyProgramId];
  const proxyProgramIndex = accounts.length - 1;

  const topLevelInstruction: CompiledInstruction = {
    programIdIndex: proxyProgramIndex,
    accountKeyIndexes: [0, 1, 2],
    data: Buffer.from([0x01, 0x02, 0x03]),
  };

  // The inner instruction is the real pool init
  const innerInstruction = baseTx.instructions[0]!;

  return {
    signature: baseTx.signature,
    slot: baseTx.slot,
    blockTime: baseTx.blockTime,
    err: null,
    version: isV1 ? 1 : "legacy",
    accountKeys: {
      staticAccountKeys: accounts,
    },
    instructions: [topLevelInstruction],
    innerInstructions: [
      {
        index: 0, // Outer instruction index 0 executed this CPI
        instructions: [innerInstruction],
      },
    ],
    ...(isV1
      ? {
          transactionConfig: options.transactionConfig ?? {
            computeUnitLimit: 300_000,
            priorityFeeLamports: 25_000,
            loadedAccountsDataSizeLimit: 64_000,
          },
        }
      : {}),
  };
}

/**
 * Creates a transaction fixture containing multiple distinct pool initializations (D29-F4).
 */
export function createMultiPoolInitTransactionFixture(): VersionedTransactionMetadata {
  const poolA_Id = "PoolA11111111111111111111111111111111111111";
  const poolB_Id = "PoolB22222222222222222222222222222222222222";

  const txA = createAmmV4InitTransactionFixture({
    poolId: poolA_Id,
    signature: "5K...multiPoolInitTx1111111111111111111111111111",
  });
  const txB = createAmmV4InitTransactionFixture({
    poolId: poolB_Id,
    signature: "5K...multiPoolInitTx1111111111111111111111111111",
  });

  // Combine static keys
  const allKeysSet = new Set<string>();
  for (const k of txA.accountKeys.staticAccountKeys) allKeysSet.add(k);
  for (const k of txB.accountKeys.staticAccountKeys) allKeysSet.add(k);
  allKeysSet.add(poolB_Id);

  const staticAccountKeys = Array.from(allKeysSet);
  const keyMap = new Map<string, number>();
  staticAccountKeys.forEach((k, idx) => keyMap.set(k, idx));

  // Remap instruction A
  const instA: CompiledInstruction = {
    programIdIndex: keyMap.get(RAYDIUM_AMM_V4_PROGRAM_ID)!,
    accountKeyIndexes: txA.instructions[0]!.accountKeyIndexes.map(
      (oldIdx) => keyMap.get(txA.accountKeys.staticAccountKeys[oldIdx]!)!,
    ),
    data: txA.instructions[0]!.data,
  };

  // Remap instruction B
  const instB: CompiledInstruction = {
    programIdIndex: keyMap.get(RAYDIUM_AMM_V4_PROGRAM_ID)!,
    accountKeyIndexes: txB.instructions[0]!.accountKeyIndexes.map((oldIdx) => {
      const origKey = txB.accountKeys.staticAccountKeys[oldIdx]!;
      const actualKey = oldIdx === 4 ? poolB_Id : origKey;
      return keyMap.get(actualKey)!;
    }),
    data: txB.instructions[0]!.data,
  };

  return {
    signature: "5K...multiPoolInitTx1111111111111111111111111111",
    slot: 300000150,
    blockTime: 1792375150,
    err: null,
    version: "legacy",
    accountKeys: {
      staticAccountKeys,
    },
    instructions: [instA, instB],
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

export interface RealisticV1RpcOptions {
  signature?: string | undefined;
  slot?: number | undefined;
  blockTime?: number | undefined;
  protocol?: "RAYDIUM_AMM_V4" | "RAYDIUM_CPMM" | undefined;
  isCpi?: boolean | undefined;
  poolId?: string | undefined;
  token0Mint?: string | undefined;
  token1Mint?: string | undefined;
  token0Vault?: string | undefined;
  token1Vault?: string | undefined;
  creatorWallet?: string | undefined;
  transactionConfig?: Version1TransactionConfig | undefined;
  err?: unknown | null | undefined;
  malformedProgramIndex?: boolean | undefined;
  malformedAccountIndex?: boolean | undefined;
  corruptInstructionData?: boolean | undefined;
}

/**
 * Creates a genuine-shaped Solana JSON-RPC getTransaction response for a version 1 transaction (SIMD-0385 / txv1).
 * Features inline accountKeys, first-class transactionConfig, and no Address Lookup Tables (ALTs).
 */
export function createRealisticVersion1GetTransactionRpcResponse(
  options: RealisticV1RpcOptions = {},
): Record<string, unknown> {
  const protocol = options.protocol ?? "RAYDIUM_AMM_V4";
  const isCpi = options.isCpi ?? false;
  const signature = options.signature ?? "5K...v1RealisticRpcSignature11111111111111111111111";
  const slot = options.slot ?? 459800100;
  const blockTime = options.blockTime ?? 1792618963;

  const baseTx = isCpi
    ? createCpiPoolInitTransactionFixture({
        protocol,
        version: 1,
        signature,
        slot,
        blockTime,
        transactionConfig: options.transactionConfig,
      })
    : protocol === "RAYDIUM_AMM_V4"
      ? createAmmV4InitTransactionFixture({
          signature,
          slot,
          blockTime,
          version: 1,
          poolId: options.poolId,
          token0Mint: options.token0Mint,
          token1Mint: options.token1Mint,
          token0Vault: options.token0Vault,
          token1Vault: options.token1Vault,
          creatorWallet: options.creatorWallet,
          transactionConfig: options.transactionConfig,
        })
      : createCpmmInitTransactionFixture({
          signature,
          slot,
          blockTime,
          version: 1,
          poolId: options.poolId,
          token0Mint: options.token0Mint,
          token1Mint: options.token1Mint,
          token0Vault: options.token0Vault,
          token1Vault: options.token1Vault,
          creatorWallet: options.creatorWallet,
          transactionConfig: options.transactionConfig,
        });

  const txConfig = options.transactionConfig ??
    baseTx.transactionConfig ?? {
      computeUnitLimit: 200_000,
      priorityFeeLamports: 10_000,
      loadedAccountsDataSizeLimit: 64_000,
      heapSize: 32_768,
    };

  // Solana JSON-RPC wire format for version 1 transactionConfig uses 'priorityFee' (SIMD-0385, B2-GO-FIX-03)
  const rawPriorityFee =
    txConfig.priorityFeeLamports ?? (txConfig as Record<string, unknown>).priorityFee;
  const wireTxConfig: Record<string, unknown> = {
    computeUnitLimit: txConfig.computeUnitLimit,
    priorityFee: rawPriorityFee,
    loadedAccountsDataSizeLimit: txConfig.loadedAccountsDataSizeLimit,
    heapSize: txConfig.heapSize,
  };

  const accountKeys = [...baseTx.accountKeys.staticAccountKeys];

  // Map instructions to JSON-RPC format
  const instructions = baseTx.instructions.map((inst) => {
    let programIdIndex = inst.programIdIndex;
    if (options.malformedProgramIndex) {
      programIdIndex = -1; // Corrupted programIdIndex
    }

    let accounts = [...inst.accountKeyIndexes];
    if (options.malformedAccountIndex) {
      accounts = [9999]; // Out of bounds account index
    }

    let dataStr = typeof inst.data === "string" ? inst.data : encodeBase58(Buffer.from(inst.data));
    if (options.corruptInstructionData) {
      dataStr = "???not-valid-base58???";
    }

    return {
      programIdIndex,
      accounts,
      data: dataStr,
    };
  });

  const innerInstructions = baseTx.innerInstructions?.map((group) => ({
    index: group.index,
    instructions: group.instructions.map((inst) => {
      let programIdIndex = inst.programIdIndex;
      if (options.malformedProgramIndex) programIdIndex = -1;
      let accounts = [...inst.accountKeyIndexes];
      if (options.malformedAccountIndex) accounts = [9999];
      let dataStr =
        typeof inst.data === "string" ? inst.data : encodeBase58(Buffer.from(inst.data));
      if (options.corruptInstructionData) dataStr = "???not-valid-base58???";

      return {
        programIdIndex,
        accounts,
        data: dataStr,
      };
    }),
  }));

  return {
    jsonrpc: "2.0",
    id: `pilot-tx-${Date.now()}`,
    result: {
      slot,
      blockTime,
      version: 1,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys,
          recentBlockhash: "GHtXQBkQwsr65ppjL1TKqc2UoxZrKV21stUvNDmwkpea",
          instructions,
          transactionConfig: wireTxConfig,
        },
      },
      meta: {
        err: options.err ?? null,
        fee: 5000,
        logMessages: [
          `Program ${accountKeys[instructions[0]?.programIdIndex ?? 0]} invoke [1]`,
          "Program log: initialize",
          `Program ${accountKeys[instructions[0]?.programIdIndex ?? 0]} success`,
        ],
        ...(innerInstructions ? { innerInstructions } : {}),
      },
    },
  };
}
