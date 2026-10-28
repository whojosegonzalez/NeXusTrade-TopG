/**
 * Phase 12.94-D Milestone D.3.3: Offline Raydium AMM v4 Swap Decoder Unit Tests
 *
 * Comprehensive offline verification of:
 * 1. Single BUY swaps (standard TOKEN_BASE_SOL_QUOTE and inverted SOL_BASE_TOKEN_QUOTE).
 * 2. Single SELL swaps (standard and inverted pair orientations).
 * 3. Exact 8-account (SwapBaseInV2/SwapBaseOutV2) and 17-account (SwapBaseIn/SwapBaseOut) layouts.
 * 4. Multiple swaps in one transaction with distinct coordinates (${sig}:${outer}:${swap}).
 * 5. Supported routed/CPI cases (inner instructions under aggregator/router programs).
 * 6. Identity mismatch handling:
 *    - Unrelated Raydium pool swaps in the same transaction are skipped.
 *    - Vault account mismatch produces explicit VAULT_MISMATCH failure.
 * 7. Failed transaction handling (meta.err present -> TRANSACTION_FAILED, 0 events emitted).
 * 8. Malformed / unsupported instruction handling:
 *    - Instruction data underflow (< 17 bytes) -> MALFORMED_INSTRUCTION_DATA.
 *    - Non-swap Raydium instruction tags -> UNSUPPORTED_INSTRUCTION.
 *    - Ambiguous swap direction without transfers or logs -> AMBIGUOUS_DIRECTION.
 * 9. Missing upstream blockTime handling (MISSING_UPSTREAM_TIMESTAMP; time is never manufactured).
 * 10. Normalization adapter integration & tracker deduplication:
 *     - Ingestion into RollingTradeFlowTracker via RaydiumAmmV4SwapNormalizationAdapter.
 *     - Duplicate ingestion yields DUPLICATE_EVENT and keeps counts stable.
 * 11. Complete window coverage guard:
 *     - Transaction ingestion populates trade counts, but NEVER establishes window coverage.
 *
 * NOTE: All tests in this file execute strictly offline using labeled synthetic fixtures.
 * Synthetic decoding tests do NOT represent live-cluster validation.
 */

import { describe, expect, it } from "vitest";
import {
  decodeInstructionData,
  decodeRaydiumTransactionSwaps,
  parseRayLog,
  RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES,
  RaydiumAmmV4SwapNormalizationAdapter,
  resolveTransactionAccounts,
  type TrackedRaydiumPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";

// Canonical Base58 Public Key Fixtures (Synthetic Fixtures)
const SYNTHETIC_WSOL_MINT = "So11111111111111111111111111111111111111112";
const SYNTHETIC_CANDIDATE_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const SYNTHETIC_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const SYNTHETIC_OTHER_POOL_ID = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const SYNTHETIC_BASE_VAULT = "9UYjh9A2dE1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8F";
const SYNTHETIC_QUOTE_VAULT = "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v";
const SYNTHETIC_AMM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const SYNTHETIC_USER_SOURCE_ATA = "UserSourceTokenAccount1111111111111111111111";
const SYNTHETIC_USER_DEST_ATA = "UserDestTokenAccount111111111111111111111111";
const SYNTHETIC_USER_WALLET = "UserWalletOwner1111111111111111111111111111";
const SYNTHETIC_ROUTER_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"; // Jupiter

// Standard Tracked Pool Context (Candidate is Base, WSOL is Quote)
const STANDARD_POOL_CONTEXT: TrackedRaydiumPoolContext = Object.freeze({
  poolId: SYNTHETIC_POOL_ID,
  candidateTokenMint: SYNTHETIC_CANDIDATE_MINT,
  quoteTokenMint: SYNTHETIC_WSOL_MINT,
  baseVault: SYNTHETIC_BASE_VAULT,
  quoteVault: SYNTHETIC_QUOTE_VAULT,
  baseMint: SYNTHETIC_CANDIDATE_MINT,
  quoteMint: SYNTHETIC_WSOL_MINT,
  orientation: "TOKEN_BASE_SOL_QUOTE",
});

// Inverted Tracked Pool Context (WSOL is Base, Candidate is Quote)
const INVERTED_POOL_CONTEXT: TrackedRaydiumPoolContext = Object.freeze({
  poolId: SYNTHETIC_POOL_ID,
  candidateTokenMint: SYNTHETIC_CANDIDATE_MINT,
  quoteTokenMint: SYNTHETIC_WSOL_MINT,
  baseVault: SYNTHETIC_BASE_VAULT,
  quoteVault: SYNTHETIC_QUOTE_VAULT,
  baseMint: SYNTHETIC_WSOL_MINT,
  quoteMint: SYNTHETIC_CANDIDATE_MINT,
  orientation: "SOL_BASE_TOKEN_QUOTE",
});

// Helper functions to create synthetic instruction payloads
function makeSwapBaseInData(amountIn: bigint, minimumOut: bigint): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = 9; // SwapBaseIn tag
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amountIn, true);
  view.setBigUint64(9, minimumOut, true);
  return buf;
}

function makeSwapBaseInV2Data(amountIn: bigint, minimumOut: bigint): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = 16; // SwapBaseInV2 tag
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amountIn, true);
  view.setBigUint64(9, minimumOut, true);
  return buf;
}

function makeSwapBaseOutData(maxAmountIn: bigint, amountOut: bigint): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = 11; // SwapBaseOut tag
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, maxAmountIn, true);
  view.setBigUint64(9, amountOut, true);
  return buf;
}

function makeSplTransferData(amount: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = 3; // Transfer tag
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amount, true);
  return buf;
}

function makeRayLogLine(
  logType: 3 | 4,
  direction: "Coin2PC" | "PC2Coin",
  amountIn: bigint,
  amountOut: bigint,
): string {
  const buf = Buffer.alloc(57);
  buf[0] = logType;
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amountIn, true);
  view.setBigUint64(9, 0n, true);
  view.setBigUint64(17, direction === "PC2Coin" ? 1n : 2n, true);
  view.setBigUint64(25, 0n, true);
  view.setBigUint64(33, 0n, true);
  view.setBigUint64(41, 0n, true);
  view.setBigUint64(49, amountOut, true);
  return `Program log: ray_log: ${buf.toString("base64")}`;
}

describe("RaydiumAmmV4SwapDecoder — Offline Swap Decoding & Normalization", () => {
  it("verifies pinned official Raydium source code references", () => {
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.programId).toBe(RAYDIUM_AMM_V4_PROGRAM_ID);
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN).toBe(9);
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT).toBe(11);
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN_V2).toBe(16);
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT_V2).toBe(17);
  });

  it("decodes a top-level standard BUY swap (PC2Coin: SOL -> Candidate Token)", () => {
    const signature = "5jW84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_100;
    const blockTime = 1_700_000_020; // epoch seconds
    const solIn = 100_000_000n; // 0.1 SOL
    const candidateOut = 50_000_000_000n; // 50,000 BONK

    // 17-account layout for SwapBaseIn
    const accountKeys = [
      SPL_TOKEN_PROGRAM_ID, // 0
      SYNTHETIC_POOL_ID, // 1: amm
      SYNTHETIC_AMM_AUTHORITY, // 2
      "OpenOrdersAccount1111111111111111111111111111", // 3
      SYNTHETIC_BASE_VAULT, // 4: amm_coin_vault (Candidate Vault)
      SYNTHETIC_QUOTE_VAULT, // 5: amm_pc_vault (SOL Vault)
      "MarketProgram1111111111111111111111111111111", // 6
      "MarketAccount1111111111111111111111111111111", // 7
      "MarketBids1111111111111111111111111111111111", // 8
      "MarketAsks1111111111111111111111111111111111", // 9
      "MarketEventQueue1111111111111111111111111111", // 10
      "MarketCoinVault11111111111111111111111111111", // 11
      "MarketPcVault1111111111111111111111111111111", // 12
      "MarketVaultSigner111111111111111111111111111", // 13
      SYNTHETIC_USER_SOURCE_ATA, // 14: user_source (SOL ATA)
      SYNTHETIC_USER_DEST_ATA, // 15: user_destination (Candidate ATA)
      SYNTHETIC_USER_WALLET, // 16: user_source_owner
      RAYDIUM_AMM_V4_PROGRAM_ID, // 17
    ];

    const instructionAccounts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const data = makeSwapBaseInData(solIn, candidateOut);

    // Inner SPL token transfers:
    // Transfer 1: user_source -> quote_vault (SOL in)
    // Transfer 2: base_vault -> user_dest (Candidate out)
    const innerInstructions = [
      {
        programId: SPL_TOKEN_PROGRAM_ID,
        accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
        data: makeSplTransferData(solIn),
      },
      {
        programId: SPL_TOKEN_PROGRAM_ID,
        accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
        data: makeSplTransferData(candidateOut),
      },
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys,
          instructions: [
            {
              programIdIndex: 17,
              accounts: instructionAccounts,
              data,
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: innerInstructions,
          },
        ],
        logMessages: [makeRayLogLine(3, "PC2Coin", solIn, candidateOut)],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT, {
      receiptTimestampMs: 1_700_000_021_000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.signature).toBe(signature);
    expect(res.slot).toBe(slot);
    expect(res.events.length).toBe(1);

    const event = res.events[0]!;
    expect(event.signature).toBe(signature);
    expect(event.swapIndex).toBe(0);
    expect(event.outerInstructionIndex).toBe(0);
    expect(event.eventId).toBe(`${signature}:0:0`);
    expect(event.poolId).toBe(SYNTHETIC_POOL_ID);
    expect(event.tokenMint).toBe(SYNTHETIC_CANDIDATE_MINT);
    expect(event.side).toBe("BUY");
    expect(event.slot).toBe(slot);
    expect(event.blockTimeSec).toBe(blockTime);
    expect(event.eventTimestampMs).toBe(blockTime * 1000);
    expect(event.receiptTimestampMs).toBe(1_700_000_021_000);
    expect(event.timestampProvenance).toBe("ON_CHAIN_BLOCK_TIME");
    expect(event.tokenAmount).toBe(candidateOut);
    expect(event.solAmount).toBe(solIn);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("decodes a top-level standard SELL swap (Coin2PC: Candidate Token -> SOL)", () => {
    const signature = "4kP84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_105;
    const blockTime = 1_700_000_025;
    const candidateIn = 25_000_000_000n; // 25,000 BONK
    const solOut = 49_500_000n; // 0.0495 SOL

    const accountKeys = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      "OpenOrdersAccount1111111111111111111111111111",
      SYNTHETIC_BASE_VAULT, // 4: amm_coin_vault (Candidate Vault)
      SYNTHETIC_QUOTE_VAULT, // 5: amm_pc_vault (SOL Vault)
      "MarketProgram1111111111111111111111111111111",
      "MarketAccount1111111111111111111111111111111",
      "MarketBids1111111111111111111111111111111111",
      "MarketAsks1111111111111111111111111111111111",
      "MarketEventQueue1111111111111111111111111111",
      "MarketCoinVault11111111111111111111111111111",
      "MarketPcVault1111111111111111111111111111111",
      "MarketVaultSigner111111111111111111111111111",
      SYNTHETIC_USER_SOURCE_ATA, // 14: Candidate ATA
      SYNTHETIC_USER_DEST_ATA, // 15: SOL ATA
      SYNTHETIC_USER_WALLET,
      RAYDIUM_AMM_V4_PROGRAM_ID,
    ];

    const instructionAccounts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const data = makeSwapBaseInData(candidateIn, solOut);

    // Inner SPL token transfers:
    // Transfer 1: user_source -> base_vault (Candidate in)
    // Transfer 2: quote_vault -> user_dest (SOL out)
    const innerInstructions = [
      {
        programId: SPL_TOKEN_PROGRAM_ID,
        accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_WALLET],
        data: makeSplTransferData(candidateIn),
      },
      {
        programId: SPL_TOKEN_PROGRAM_ID,
        accounts: [SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
        data: makeSplTransferData(solOut),
      },
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys,
          instructions: [
            {
              programIdIndex: 17,
              accounts: instructionAccounts,
              data,
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: innerInstructions,
          },
        ],
        logMessages: [makeRayLogLine(3, "Coin2PC", candidateIn, solOut)],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events.length).toBe(1);
    const event = res.events[0]!;
    expect(event.side).toBe("SELL");
    expect(event.tokenAmount).toBe(candidateIn);
    expect(event.solAmount).toBe(solOut);
  });

  it("decodes SwapBaseInV2 using clean 8-account layout", () => {
    const signature = "3mN84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_110;
    const blockTime = 1_700_000_030;
    const solIn = 200_000_000n;
    const candidateOut = 100_000_000_000n;

    // 8-account layout for SwapBaseInV2:
    // 0: token_program, 1: amm, 2: amm_authority, 3: coin_vault, 4: pc_vault, 5: user_src, 6: user_dst, 7: user_wallet
    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT,
      SYNTHETIC_QUOTE_VAULT,
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(solIn, candidateOut),
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(solIn),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(candidateOut),
              },
            ],
          },
        ],
        logMessages: [makeRayLogLine(3, "PC2Coin", solIn, candidateOut)],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events.length).toBe(1);
    expect(res.events[0]!.side).toBe("BUY");
    expect(res.events[0]!.tokenAmount).toBe(candidateOut);
    expect(res.events[0]!.solAmount).toBe(solIn);
  });

  it("handles inverted pair orientation (SOL_BASE_TOKEN_QUOTE) correctly", () => {
    const signature = "2bA84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_120;
    const blockTime = 1_700_000_040;
    const solIn = 150_000_000n;
    const candidateOut = 75_000_000_000n;

    // In SOL_BASE_TOKEN_QUOTE:
    // Base vault is SOL, Quote vault is Candidate.
    // User puts in SOL (Base) and gets Candidate (Quote).
    // Swap direction is Coin2PC!
    // Relative to Candidate token, this is a BUY!
    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT, // holds SOL
      SYNTHETIC_QUOTE_VAULT, // holds Candidate
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(solIn, candidateOut),
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(solIn),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(candidateOut),
              },
            ],
          },
        ],
        logMessages: [makeRayLogLine(3, "Coin2PC", solIn, candidateOut)],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, INVERTED_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events[0]!.side).toBe("BUY");
    expect(res.events[0]!.tokenAmount).toBe(candidateOut);
    expect(res.events[0]!.solAmount).toBe(solIn);
  });

  it("decodes multiple swaps in one transaction with distinct coordinates", () => {
    const signature = "7kM84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_130;
    const blockTime = 1_700_000_050;

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT,
      SYNTHETIC_QUOTE_VAULT,
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
    ];

    // Transaction has two top-level swaps:
    // Outer 0: BUY 10,000 BONK for 0.02 SOL
    // Outer 1: SELL 5,000 BONK for 0.009 SOL
    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(20_000_000n, 10_000_000_000n),
            },
            {
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(5_000_000_000n, 9_000_000n),
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(20_000_000n),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(10_000_000_000n),
              },
            ],
          },
          {
            index: 1,
            instructions: [
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(5_000_000_000n),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(9_000_000n),
              },
            ],
          },
        ],
        logMessages: [
          makeRayLogLine(3, "PC2Coin", 20_000_000n, 10_000_000_000n),
          makeRayLogLine(3, "Coin2PC", 5_000_000_000n, 9_000_000n),
        ],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events.length).toBe(2);

    // Swap 1 (BUY)
    expect(res.events[0]!.outerInstructionIndex).toBe(0);
    expect(res.events[0]!.swapIndex).toBe(0);
    expect(res.events[0]!.eventId).toBe(`${signature}:0:0`);
    expect(res.events[0]!.side).toBe("BUY");
    expect(res.events[0]!.tokenAmount).toBe(10_000_000_000n);
    expect(res.events[0]!.solAmount).toBe(20_000_000n);

    // Swap 2 (SELL)
    expect(res.events[1]!.outerInstructionIndex).toBe(1);
    expect(res.events[1]!.swapIndex).toBe(0);
    expect(res.events[1]!.eventId).toBe(`${signature}:1:0`);
    expect(res.events[1]!.side).toBe("SELL");
    expect(res.events[1]!.tokenAmount).toBe(5_000_000_000n);
    expect(res.events[1]!.solAmount).toBe(9_000_000n);
  });

  it("decodes routed / CPI swaps invoked via router program (e.g. Jupiter)", () => {
    const signature = "8yT84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_140;
    const blockTime = 1_700_000_060;

    const accounts = [
      SYNTHETIC_ROUTER_PROGRAM_ID, // 0: Jupiter
      SPL_TOKEN_PROGRAM_ID, // 1
      SYNTHETIC_POOL_ID, // 2: Raydium AMM
      SYNTHETIC_AMM_AUTHORITY, // 3
      SYNTHETIC_BASE_VAULT, // 4
      SYNTHETIC_QUOTE_VAULT, // 5
      SYNTHETIC_USER_SOURCE_ATA, // 6
      SYNTHETIC_USER_DEST_ATA, // 7
      SYNTHETIC_USER_WALLET, // 8
      RAYDIUM_AMM_V4_PROGRAM_ID, // 9
    ];

    // Top-level instruction is Jupiter router call
    // Inner instruction 0 is Raydium AMM v4 swap
    // Inner instructions 1 and 2 are SPL token transfers
    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 0, // Jupiter
              accounts: [6, 7, 8],
              data: new Uint8Array([1, 2, 3]), // dummy router data
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programIdIndex: 9, // Raydium AMM v4
                accounts: [1, 2, 3, 4, 5, 6, 7, 8],
                data: makeSwapBaseInV2Data(50_000_000n, 25_000_000_000n),
              },
              {
                programIdIndex: 1, // SPL Token
                accounts: [6, 5, 8], // user -> quote vault
                data: makeSplTransferData(50_000_000n),
              },
              {
                programIdIndex: 1, // SPL Token
                accounts: [4, 7, 3], // base vault -> user
                data: makeSplTransferData(25_000_000_000n),
              },
            ],
          },
        ],
        logMessages: [
          "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [2]",
          makeRayLogLine(3, "PC2Coin", 50_000_000n, 25_000_000_000n),
          "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
          "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
        ],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events.length).toBe(1);
    const event = res.events[0]!;
    expect(event.outerInstructionIndex).toBe(0);
    expect(event.swapIndex).toBe(0);
    expect(event.eventId).toBe(`${signature}:0:0`);
    expect(event.side).toBe("BUY");
    expect(event.tokenAmount).toBe(25_000_000_000n);
    expect(event.solAmount).toBe(50_000_000n);
  });

  it("skips Raydium swaps targeting a different pool in the same transaction", () => {
    const signature = "1xA84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_150;
    const blockTime = 1_700_000_070;

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_OTHER_POOL_ID, // Different pool!
      SYNTHETIC_AMM_AUTHORITY,
      "OtherBaseVault111111111111111111111111111111",
      "OtherQuoteVault11111111111111111111111111111",
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
      RAYDIUM_AMM_V4_PROGRAM_ID,
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 8,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(10_000_000n, 5_000_000n),
            },
          ],
        },
      },
      meta: {
        err: null,
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("NO_MATCHING_SWAPS_FOUND");
    expect(res.events.length).toBe(0);
  });

  it("rejects instruction when pool ID matches but vault accounts do not match (VAULT_MISMATCH)", () => {
    const signature = "6mR84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_160;
    const blockTime = 1_700_000_080;

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID, // matches poolId
      SYNTHETIC_AMM_AUTHORITY,
      "SpoofedBaseVault1111111111111111111111111111", // wrong vault!
      SYNTHETIC_QUOTE_VAULT,
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
      RAYDIUM_AMM_V4_PROGRAM_ID,
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 8,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(10_000_000n, 5_000_000n),
            },
          ],
        },
      },
      meta: {
        err: null,
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("VAULT_MISMATCH");
    expect(res.message).toMatch(/do not match validated pool vaults/);
  });

  it("rejects failed on-chain transactions with TRANSACTION_FAILED", () => {
    const signature = "9pZ84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_170;
    const blockTime = 1_700_000_090;

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [SYNTHETIC_POOL_ID],
          instructions: [],
        },
      },
      meta: {
        err: { InstructionError: [0, "Custom: 1"] }, // On-chain execution failed!
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("TRANSACTION_FAILED");
    expect(res.events.length).toBe(0);
  });

  it("rejects malformed instruction data with MALFORMED_INSTRUCTION_DATA", () => {
    const signature = "4nK84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_180;
    const blockTime = 1_700_000_100;

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT,
      SYNTHETIC_QUOTE_VAULT,
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
      RAYDIUM_AMM_V4_PROGRAM_ID,
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 8,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: new Uint8Array([9, 1, 2, 3]), // Only 4 bytes (needs 17)!
            },
          ],
        },
      },
      meta: {
        err: null,
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("MALFORMED_INSTRUCTION_DATA");
  });

  it("rejects non-swap Raydium instructions with UNSUPPORTED_INSTRUCTION", () => {
    const signature = "2vX84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_190;
    const blockTime = 1_700_000_110;

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT,
      SYNTHETIC_QUOTE_VAULT,
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
      RAYDIUM_AMM_V4_PROGRAM_ID,
    ];

    const data = new Uint8Array(24);
    data[0] = 3; // Tag 3 is Deposit, not a swap!

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 8,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data,
            },
          ],
        },
      },
      meta: {
        err: null,
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("UNSUPPORTED_INSTRUCTION");
  });

  it("fails closed with AMBIGUOUS_DIRECTION when direction cannot be determined from transfers, logs, or balances", () => {
    const signature = "8mQ84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_200;
    const blockTime = 1_700_000_120;

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT,
      SYNTHETIC_QUOTE_VAULT,
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
      RAYDIUM_AMM_V4_PROGRAM_ID,
    ];

    // No inner transfers, no ray_log, no preTokenBalances
    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 8,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(10_000_000n, 5_000_000n),
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [],
        logMessages: [],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("AMBIGUOUS_DIRECTION");
  });

  it("rejects transactions with missing upstream blockTime (MISSING_UPSTREAM_TIMESTAMP)", () => {
    const signature = "7uT84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_210;

    // Upstream blockTime is null!
    const payload = {
      slot,
      blockTime: null,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [SYNTHETIC_POOL_ID],
          instructions: [],
        },
      },
      meta: {
        err: null,
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("MISSING_UPSTREAM_TIMESTAMP");
    expect(res.message).toMatch(/cannot manufacture upstream timestamp/);
  });

  it("integrates with RollingTradeFlowTracker via NormalizationAdapter and verifies deduplication", () => {
    const nowMs = 1_700_000_000_000;
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: nowMs - 60_000,
      clock: () => nowMs,
    });

    // Provide verified observation range across window so tracker can evaluate SUFFICIENT
    tracker.recordCompletedRange(nowMs - 60_000, nowMs);
    tracker.recordHeartbeat(nowMs);

    const adapter = new RaydiumAmmV4SwapNormalizationAdapter(STANDARD_POOL_CONTEXT);

    const signature = "3wX84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_220;
    const blockTime = Math.floor((nowMs - 30_000) / 1000); // 30s ago
    const solIn = 100_000_000n;
    const candidateOut = 50_000_000_000n;

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT,
      SYNTHETIC_QUOTE_VAULT,
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(solIn, candidateOut),
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(solIn),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(candidateOut),
              },
            ],
          },
        ],
        logMessages: [makeRayLogLine(3, "PC2Coin", solIn, candidateOut)],
      },
    };

    // First ingestion: succeeds
    const ingestResult1 = adapter.ingestTransaction(payload, tracker, {
      receiptTimestampMs: nowMs,
    });
    expect(ingestResult1.decodeResult.ok).toBe(true);
    expect(ingestResult1.ingestedCount).toBe(1);
    expect(ingestResult1.ingestFailures.length).toBe(0);

    // Evaluate tracker: counts exactly 1 BUY, 0 SELLS
    const eval1 = tracker.evaluateWindow(nowMs);
    expect(eval1.coverage).toBe("SUFFICIENT");
    expect(eval1.recentBuys60s).toBe(1);
    expect(eval1.recentSells60s).toBe(0);

    // Second ingestion of the EXACT SAME transaction: deduplicates via deriveCanonicalSwapKey
    const ingestResult2 = adapter.ingestTransaction(payload, tracker, {
      receiptTimestampMs: nowMs,
    });
    expect(ingestResult2.decodeResult.ok).toBe(true);
    expect(ingestResult2.ingestedCount).toBe(0); // Deduplicated!
    expect(ingestResult2.ingestFailures.length).toBe(1);
    expect(ingestResult2.ingestFailures[0]!.reason).toBe("DUPLICATE_EVENT");

    // Counts remain stable and are NOT double-counted
    const eval2 = tracker.evaluateWindow(nowMs);
    expect(eval2.recentBuys60s).toBe(1);
    expect(eval2.recentSells60s).toBe(0);
  });

  it("confirms decoding transactions NEVER establishes window coverage", () => {
    const nowMs = 1_700_000_000_000;
    // Tracker started 60s ago with NO heartbeats and NO completed ranges recorded
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: nowMs - 60_000,
      clock: () => nowMs,
    });

    const adapter = new RaydiumAmmV4SwapNormalizationAdapter(STANDARD_POOL_CONTEXT);

    const signature = "5tY84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_230;
    const blockTime = Math.floor((nowMs - 20_000) / 1000);

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT,
      SYNTHETIC_QUOTE_VAULT,
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(10_000_000n, 5_000_000_000n),
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(10_000_000n),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(5_000_000_000n),
              },
            ],
          },
        ],
        logMessages: [makeRayLogLine(3, "PC2Coin", 10_000_000n, 5_000_000_000n)],
      },
    };

    // Ingest transaction
    adapter.ingestTransaction(payload, tracker, { receiptTimestampMs: nowMs });

    // CRITICAL GUARANTEE: Ingestion must NOT fabricate stream observation or window coverage!
    // Because no heartbeats or completed ranges were recorded, evaluation must detect silence and report COLLECTION_GAP!
    const evalResult = tracker.evaluateWindow(nowMs);
    expect(evalResult.coverage).toBe("COLLECTION_GAP");
    expect(evalResult.isCoverageSufficient).toBe(false);
    expect(evalResult.recentBuys60s).toBeNull();
    expect(evalResult.recentSells60s).toBeNull();
    expect(evalResult.flowRatio).toBeNull();
  });

  it("decodes SwapBaseOut (exact output swap, tag 11)", () => {
    const signature = "6hR84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_240;
    const blockTime = 1_700_000_150;
    const maxSolIn = 200_000_000n;
    const exactCandidateOut = 100_000_000_000n;

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      "OpenOrdersAccount1111111111111111111111111111",
      SYNTHETIC_BASE_VAULT,
      SYNTHETIC_QUOTE_VAULT,
      "MarketProgram1111111111111111111111111111111",
      "MarketAccount1111111111111111111111111111111",
      "MarketBids1111111111111111111111111111111111",
      "MarketAsks1111111111111111111111111111111111",
      "MarketEventQueue1111111111111111111111111111",
      "MarketCoinVault11111111111111111111111111111",
      "MarketPcVault1111111111111111111111111111111",
      "MarketVaultSigner111111111111111111111111111",
      SYNTHETIC_USER_SOURCE_ATA,
      SYNTHETIC_USER_DEST_ATA,
      SYNTHETIC_USER_WALLET,
      RAYDIUM_AMM_V4_PROGRAM_ID,
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 17,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
              data: makeSwapBaseOutData(maxSolIn, exactCandidateOut),
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(195_000_000n), // Actual deducted in
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(exactCandidateOut),
              },
            ],
          },
        ],
        logMessages: [makeRayLogLine(4, "PC2Coin", 195_000_000n, exactCandidateOut)],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events[0]!.side).toBe("BUY");
    expect(res.events[0]!.tokenAmount).toBe(exactCandidateOut);
    expect(res.events[0]!.solAmount).toBe(195_000_000n);
  });

  it("verifies resolveTransactionAccounts with versioned loadedAddresses", () => {
    const message = {
      accountKeys: [
        "StaticKey1111111111111111111111111111111111",
        { pubkey: "StaticKey2222222222222222222222222222222222" },
      ],
    };
    const meta = {
      loadedAddresses: {
        writable: ["WritableLookupKey11111111111111111111111111111"],
        readonly: ["ReadonlyLookupKey11111111111111111111111111111"],
      },
    };

    const resolved = resolveTransactionAccounts(message, meta);
    expect(resolved.length).toBe(4);
    expect(resolved[0]).toBe("StaticKey1111111111111111111111111111111111");
    expect(resolved[1]).toBe("StaticKey2222222222222222222222222222222222");
    expect(resolved[2]).toBe("WritableLookupKey11111111111111111111111111111");
    expect(resolved[3]).toBe("ReadonlyLookupKey11111111111111111111111111111");
  });

  it("verifies decodeInstructionData and parseRayLog helpers", () => {
    // decodeInstructionData
    expect(decodeInstructionData(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(decodeInstructionData([4, 5, 6])).toEqual(new Uint8Array([4, 5, 6]));
    expect(decodeInstructionData("")).toEqual(new Uint8Array(0));
    expect(decodeInstructionData(null)).toBeNull();

    // parseRayLog
    const validLog = makeRayLogLine(3, "Coin2PC", 100n, 200n);
    const parsed = parseRayLog(validLog);
    expect(parsed).not.toBeNull();
    expect(parsed?.logType).toBe(3);
    expect(parsed?.direction).toBe("Coin2PC");
    expect(parsed?.amountIn).toBe(100n);
    expect(parsed?.amountOut).toBe(200n);

    expect(parseRayLog("Random log without ray_log")).toBeNull();
    expect(parseRayLog("Program log: ray_log: not-base-64!")).toBeNull();
  });
});
