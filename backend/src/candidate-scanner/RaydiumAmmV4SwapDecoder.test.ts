/**
 * Phase 12.94-D Milestone D.3.3: Offline Raydium AMM v4 Swap Decoder Unit Tests
 *
 * Comprehensive offline verification of:
 * 1. Single BUY swaps (standard TOKEN_BASE_SOL_QUOTE and inverted SOL_BASE_TOKEN_QUOTE).
 * 2. Single SELL swaps (standard and inverted pair orientations).
 * 3. Exact instruction tag to account layout matrix (commit 91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6):
 *    - 17-account legacy layout (SwapBaseIn tag 9 / SwapBaseOut tag 11).
 *    - 18-account shifted legacy layout with optional target_orders at index 4.
 *    - 8-account clean V2 layout (SwapBaseInV2 tag 16 / SwapBaseOutV2 tag 17).
 *    - Rejection of tag 9/11 with 8 accounts (UNSUPPORTED_LAYOUT).
 *    - Rejection of tag 16/17 with 17 or 18 accounts (UNSUPPORTED_LAYOUT).
 * 4. Invocation-scoped evidence attribution:
 *    - Call-stack parsing of logMessages with depth tracking.
 *    - Strict binding of ray_log events to originating call frame.
 *    - Isolation of inner SPL transfers by matching exact source/dest/vaults.
 *    - Consumed transfer index tracking preventing transfer reuse across routed swaps.
 *    - Rejection of cross-pool or sibling log corruption.
 *    - Fail closed on conflicting or unassignable evidence (CONFLICTING_EVIDENCE, AMBIGUOUS_DIRECTION).
 * 5. Proven successful on-chain execution:
 *    - Explicit meta presence and meta.err === null requirement (TRANSACTION_NOT_SUCCESSFUL).
 *    - Proven invocation success via logMessages (Program 675k... success).
 *    - Caught CPI failures produce INVOCATION_FAILED.
 * 6. Pool boundary validation & context protection:
 *    - createTrackedRaydiumPoolContext enforces mandatory Base58 poolAddress (no substitution).
 *    - validateTrackedPoolContext enforces orientation and mint consistency.
 *    - Normalization adapter freezes context against caller mutation.
 *    - Non-WSOL quote tokens leave solAmount undefined.
 * 7. Malformed payload & temporal integrity handling:
 *    - Non-object / null payloads return INVALID_PAYLOAD without throwing.
 *    - Out-of-bounds instruction account indices return MALFORMED_INSTRUCTION_DATA.
 *    - Missing, non-finite, or non-positive blockTime returns MISSING_UPSTREAM_TIMESTAMP.
 * 8. Tracker integration & window coverage preservation:
 *    - Normalization adapter ingests into RollingTradeFlowTracker.
 *    - Deduplication via canonical key (${sig}:${outer}:${swap}) keeps counts stable.
 *    - Ingestion populates trade counts but NEVER manufactures observation coverage.
 *
 * NOTE: All tests execute strictly offline using labeled synthetic fixtures.
 * Synthetic decoding tests do NOT represent live-cluster validation.
 */

import { describe, expect, it } from "vitest";
import {
  createTrackedRaydiumPoolContext,
  decodeInstructionData,
  decodeRaydiumTransactionSwaps,
  matchSupportedSwapLayout,
  parseInvocationFrames,
  parseRayLog,
  RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES,
  RaydiumAmmV4SwapNormalizationAdapter,
  resolveTransactionAccounts,
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";
import type { D23RaydiumAmmV4State } from "../research/pilot/PilotTypes.js";

// Canonical Base58 Public Key Fixtures (Synthetic Fixtures)
const SYNTHETIC_WSOL_MINT = "So11111111111111111111111111111111111111112";
const SYNTHETIC_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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

// USDC Quoted Tracked Pool Context (Non-WSOL quote token)
const USDC_QUOTED_POOL_CONTEXT: TrackedRaydiumPoolContext = Object.freeze({
  poolId: SYNTHETIC_POOL_ID,
  candidateTokenMint: SYNTHETIC_CANDIDATE_MINT,
  quoteTokenMint: SYNTHETIC_USDC_MINT,
  baseVault: SYNTHETIC_BASE_VAULT,
  quoteVault: SYNTHETIC_QUOTE_VAULT,
  baseMint: SYNTHETIC_CANDIDATE_MINT,
  quoteMint: SYNTHETIC_USDC_MINT,
  orientation: "NON_SOL_PAIR",
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

function makeSwapBaseOutV2Data(maxAmountIn: bigint, amountOut: bigint): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = 17; // SwapBaseOutV2 tag
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
  maxInOrMinOut = 0n,
): string {
  const buf = Buffer.alloc(57);
  buf[0] = logType;
  const view = new DataView(buf.buffer);
  if (logType === 3) {
    view.setBigUint64(1, amountIn, true); // amount_in
    view.setBigUint64(9, maxInOrMinOut, true); // minimum_out
    view.setBigUint64(17, direction === "PC2Coin" ? 1n : 2n, true);
    view.setBigUint64(25, 0n, true);
    view.setBigUint64(33, 0n, true);
    view.setBigUint64(41, 0n, true);
    view.setBigUint64(49, amountOut, true); // out_amount
  } else {
    // logType === 4 (SwapBaseOutLog): offset 1 = max_in, offset 9 = amount_out, offset 49 = deduct_in
    view.setBigUint64(1, maxInOrMinOut > 0n ? maxInOrMinOut : amountIn, true);
    view.setBigUint64(9, amountOut, true);
    view.setBigUint64(17, direction === "PC2Coin" ? 1n : 2n, true);
    view.setBigUint64(25, 0n, true);
    view.setBigUint64(33, 0n, true);
    view.setBigUint64(41, 0n, true);
    view.setBigUint64(49, amountIn, true);
  }
  return `Program log: ray_log: ${buf.toString("base64")}`;
}

function makeRaydiumLogs(
  logType: 3 | 4,
  direction: "Coin2PC" | "PC2Coin",
  amountIn: bigint,
  amountOut: bigint,
  depth = 1,
  maxInOrMinOut = 0n,
): string[] {
  return [
    `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [${depth}]`,
    makeRayLogLine(logType, direction, amountIn, amountOut, maxInOrMinOut),
    `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
  ];
}

describe("RaydiumAmmV4SwapDecoder — Offline Swap Decoding & Normalization", () => {
  it("verifies pinned official Raydium source code references and immutable commit", () => {
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.repository).toBe(
      "https://github.com/raydium-io/raydium-amm",
    );
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.pinnedCommit).toBe(
      "91739d8d9f5cf347e0ce14ebe4d2bb7069fb31b6",
    );
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.programId).toBe(RAYDIUM_AMM_V4_PROGRAM_ID);
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN).toBe(9);
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT).toBe(11);
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_IN_V2).toBe(16);
    expect(RAYDIUM_AMM_V4_SWAP_SOURCE_REFERENCES.supportedTags.SWAP_BASE_OUT_V2).toBe(17);
  });

  // =========================================================================
  // AUDIT AREA 1: Match instruction tags to source-verified account layouts
  // =========================================================================

  it("decodes a standard legacy 17-account BUY swap (SwapBaseIn tag 9)", () => {
    const signature = "5jW84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_100;
    const blockTime = 1_700_000_020;
    const solIn = 100_000_000n; // 0.1 SOL
    const candidateOut = 50_000_000_000n; // 50,000 BONK

    // Standard 17-account layout for SwapBaseIn
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
        logMessages: makeRaydiumLogs(3, "PC2Coin", solIn, candidateOut),
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

  it("decodes a shifted legacy 18-account layout with optional target_orders at index 4 without VAULT_MISMATCH", () => {
    // Official processor.rs @ 91739d8d:
    // If accounts.len() == 18, target_orders is consumed at index 4, shifting all subsequent positions +1.
    const signature = "8tY84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_102;
    const blockTime = 1_700_000_022;
    const solIn = 150_000_000n;
    const candidateOut = 75_000_000_000n;

    // 18-account layout:
    // 0: token_program
    // 1: amm
    // 2: amm_authority
    // 3: amm_open_orders
    // 4: amm_target_orders (shifts subsequent accounts)
    // 5: amm_coin_vault (baseVault)
    // 6: amm_pc_vault (quoteVault)
    // 7..14: market accounts (8 accounts)
    // 15: user_source
    // 16: user_destination
    // 17: user_source_owner
    const accountKeys = [
      SPL_TOKEN_PROGRAM_ID, // 0
      SYNTHETIC_POOL_ID, // 1: amm
      SYNTHETIC_AMM_AUTHORITY, // 2: amm_authority
      "OpenOrdersAccount1111111111111111111111111111", // 3: open_orders
      "TargetOrdersAccount1111111111111111111111111", // 4: target_orders (index 4!)
      SYNTHETIC_BASE_VAULT, // 5: amm_coin_vault (shifted to 5!)
      SYNTHETIC_QUOTE_VAULT, // 6: amm_pc_vault (shifted to 6!)
      "MarketProgram1111111111111111111111111111111", // 7
      "MarketAccount1111111111111111111111111111111", // 8
      "MarketBids1111111111111111111111111111111111", // 9
      "MarketAsks1111111111111111111111111111111111", // 10
      "MarketEventQueue1111111111111111111111111111", // 11
      "MarketCoinVault11111111111111111111111111111", // 12
      "MarketPcVault1111111111111111111111111111111", // 13
      "MarketVaultSigner111111111111111111111111111", // 14
      SYNTHETIC_USER_SOURCE_ATA, // 15: user_source (shifted to 15!)
      SYNTHETIC_USER_DEST_ATA, // 16: user_destination (shifted to 16!)
      SYNTHETIC_USER_WALLET, // 17: user_source_owner (shifted to 17!)
      RAYDIUM_AMM_V4_PROGRAM_ID, // 18
    ];

    const instructionAccounts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
    const data = makeSwapBaseInData(solIn, candidateOut);

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
              programIdIndex: 18,
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
        logMessages: makeRaydiumLogs(3, "PC2Coin", solIn, candidateOut),
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events.length).toBe(1);
    const event = res.events[0]!;
    expect(event.side).toBe("BUY");
    expect(event.tokenAmount).toBe(candidateOut);
    expect(event.solAmount).toBe(solIn);
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
        logMessages: makeRaydiumLogs(3, "PC2Coin", solIn, candidateOut),
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

  it("decodes SwapBaseOutV2 (exact output swap, tag 17) using clean 8-account layout", () => {
    const signature = "5kR84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_245;
    const blockTime = 1_700_000_155;
    const maxSolIn = 200_000_000n;
    const exactCandidateOut = 100_000_000_000n;

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
              data: makeSwapBaseOutV2Data(maxSolIn, exactCandidateOut),
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
                data: makeSplTransferData(190_000_000n),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(exactCandidateOut),
              },
            ],
          },
        ],
        logMessages: makeRaydiumLogs(4, "PC2Coin", 190_000_000n, exactCandidateOut),
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events[0]!.side).toBe("BUY");
    expect(res.events[0]!.tokenAmount).toBe(exactCandidateOut);
    expect(res.events[0]!.solAmount).toBe(190_000_000n);
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
        logMessages: makeRaydiumLogs(4, "PC2Coin", 195_000_000n, exactCandidateOut),
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events[0]!.side).toBe("BUY");
    expect(res.events[0]!.tokenAmount).toBe(exactCandidateOut);
    expect(res.events[0]!.solAmount).toBe(195_000_000n);
  });

  it("decodes a standard SELL swap (Coin2PC: Candidate Token -> SOL)", () => {
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
        logMessages: makeRaydiumLogs(3, "Coin2PC", candidateIn, solOut),
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

  it("rejects legacy instruction tag 9 with 8-account layout as UNSUPPORTED_LAYOUT", () => {
    const signature = "7qA84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_115;
    const blockTime = 1_700_000_035;

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

    // Instruction tag 9 passed with only 8 accounts (requires 17 or 18)
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
              data: makeSwapBaseInData(100_000_000n, 50_000_000_000n),
            },
          ],
        },
      },
      meta: {
        err: null,
        logMessages: makeRaydiumLogs(3, "PC2Coin", 100_000_000n, 50_000_000_000n),
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("UNSUPPORTED_LAYOUT");
    expect(res.message).toMatch(/Unsupported account count 8 for Raydium instruction tag 9/);
  });

  it("rejects V2 instruction tag 16 with 17-account layout as UNSUPPORTED_LAYOUT", () => {
    const signature = "2zQ84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_116;
    const blockTime = 1_700_000_036;

    const accountKeys = [
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

    // Instruction tag 16 passed with 17 accounts (requires exactly 8)
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
              accounts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
              data: makeSwapBaseInV2Data(100_000_000n, 50_000_000_000n),
            },
          ],
        },
      },
      meta: {
        err: null,
        logMessages: makeRaydiumLogs(3, "PC2Coin", 100_000_000n, 50_000_000_000n),
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("UNSUPPORTED_LAYOUT");
    expect(res.message).toMatch(/Unsupported account count 17 for Raydium instruction tag 16/);
  });

  it("source-derived layout matrix independently verifies positions against commit 91739d8d", () => {
    // Tag 9 & 11: only 17 and 18 supported
    expect(matchSupportedSwapLayout(9, 8)).toBeNull();
    expect(matchSupportedSwapLayout(9, 16)).toBeNull();
    expect(matchSupportedSwapLayout(9, 19)).toBeNull();

    const legacy17 = matchSupportedSwapLayout(9, 17);
    expect(legacy17).not.toBeNull();
    expect(legacy17?.layout).toBe("LEGACY_17_ACCOUNTS");
    expect(legacy17?.poolIdIndex).toBe(1);
    expect(legacy17?.baseVaultIndex).toBe(4);
    expect(legacy17?.quoteVaultIndex).toBe(5);
    expect(legacy17?.userSourceIndex).toBe(14);
    expect(legacy17?.userDestinationIndex).toBe(15);
    expect(legacy17?.userOwnerIndex).toBe(16);

    const legacy18 = matchSupportedSwapLayout(9, 18);
    expect(legacy18).not.toBeNull();
    expect(legacy18?.layout).toBe("LEGACY_18_ACCOUNTS_TARGET_ORDERS");
    expect(legacy18?.poolIdIndex).toBe(1);
    expect(legacy18?.baseVaultIndex).toBe(5); // shifted by target_orders
    expect(legacy18?.quoteVaultIndex).toBe(6); // shifted by target_orders
    expect(legacy18?.userSourceIndex).toBe(15); // shifted by target_orders
    expect(legacy18?.userDestinationIndex).toBe(16); // shifted by target_orders
    expect(legacy18?.userOwnerIndex).toBe(17); // shifted by target_orders

    // Tag 16 & 17: only 8 supported
    expect(matchSupportedSwapLayout(16, 17)).toBeNull();
    expect(matchSupportedSwapLayout(16, 18)).toBeNull();
    expect(matchSupportedSwapLayout(16, 7)).toBeNull();

    const v2_8 = matchSupportedSwapLayout(16, 8);
    expect(v2_8).not.toBeNull();
    expect(v2_8?.layout).toBe("V2_8_ACCOUNTS");
    expect(v2_8?.poolIdIndex).toBe(1);
    expect(v2_8?.baseVaultIndex).toBe(3);
    expect(v2_8?.quoteVaultIndex).toBe(4);
    expect(v2_8?.userSourceIndex).toBe(5);
    expect(v2_8?.userDestinationIndex).toBe(6);
    expect(v2_8?.userOwnerIndex).toBe(7);
  });

  // =========================================================================
  // AUDIT AREA 2: Attribute evidence to the exact invocation
  // =========================================================================

  it("correctly decodes SELL when preceded by another pool's BUY ray_log (invocation isolation)", () => {
    const signature = "4pL84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_125;
    const blockTime = 1_700_000_045;

    // Transaction executes two swaps:
    // Outer 0: Other pool swap (BUY)
    // Outer 1: Tracked pool swap (SELL)
    const accounts = [
      SPL_TOKEN_PROGRAM_ID, // 0
      SYNTHETIC_OTHER_POOL_ID, // 1: Other pool
      SYNTHETIC_AMM_AUTHORITY, // 2
      "OtherBaseVault111111111111111111111111111111", // 3
      "OtherQuoteVault11111111111111111111111111111", // 4
      SYNTHETIC_USER_SOURCE_ATA, // 5
      SYNTHETIC_USER_DEST_ATA, // 6
      SYNTHETIC_USER_WALLET, // 7
      RAYDIUM_AMM_V4_PROGRAM_ID, // 8
      SYNTHETIC_POOL_ID, // 9: Tracked pool
      SYNTHETIC_BASE_VAULT, // 10: Tracked base vault
      SYNTHETIC_QUOTE_VAULT, // 11: Tracked quote vault
    ];

    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            // Outer 0: Other pool BUY
            {
              programIdIndex: 8,
              accounts: [0, 1, 2, 3, 4, 5, 6, 7],
              data: makeSwapBaseInV2Data(10_000_000n, 100_000_000n),
            },
            // Outer 1: Tracked pool SELL
            {
              programIdIndex: 8,
              accounts: [0, 9, 2, 10, 11, 5, 6, 7],
              data: makeSwapBaseInV2Data(25_000_000_000n, 50_000_000n),
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
                accounts: [SYNTHETIC_USER_SOURCE_ATA, accounts[4]!, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(10_000_000n),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [accounts[3]!, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(100_000_000n),
              },
            ],
          },
          {
            index: 1,
            instructions: [
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_WALLET],
                data: makeSplTransferData(25_000_000_000n),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(50_000_000n),
              },
            ],
          },
        ],
        // Two separate invocation frames:
        // Frame 0: PC2Coin (BUY) for other pool
        // Frame 1: Coin2PC (SELL) for tracked pool
        logMessages: [
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
          makeRayLogLine(3, "PC2Coin", 10_000_000n, 100_000_000n),
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
          makeRayLogLine(3, "Coin2PC", 25_000_000_000n, 50_000_000n),
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
        ],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Must isolate to the tracked pool and decode as SELL (not corrupted into BUY by prior ray_log!)
    expect(res.events.length).toBe(1);
    const event = res.events[0]!;
    expect(event.outerInstructionIndex).toBe(1);
    expect(event.side).toBe("SELL");
    expect(event.tokenAmount).toBe(25_000_000_000n);
    expect(event.solAmount).toBe(50_000_000n);
  });

  it("correctly decodes two routed same-pool swaps (BUY then SELL) in one transaction without transfer reuse", () => {
    const signature = "3wR84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_128;
    const blockTime = 1_700_000_048;

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

    // Single top-level router instruction containing TWO inner Raydium swaps
    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 0,
              accounts: [6, 7, 8],
              data: new Uint8Array([1, 2, 3]),
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
              // Swap 1: BUY
              {
                programIdIndex: 9,
                accounts: [1, 2, 3, 4, 5, 6, 7, 8],
                data: makeSwapBaseInV2Data(50_000_000n, 25_000_000_000n),
              },
              {
                programIdIndex: 1,
                accounts: [6, 5, 8], // user -> quote vault (SOL in)
                data: makeSplTransferData(50_000_000n),
              },
              {
                programIdIndex: 1,
                accounts: [4, 7, 3], // base vault -> user (Candidate out)
                data: makeSplTransferData(25_000_000_000n),
              },
              // Swap 2: SELL
              {
                programIdIndex: 9,
                accounts: [1, 2, 3, 4, 5, 6, 7, 8],
                data: makeSwapBaseInV2Data(10_000_000_000n, 19_000_000n),
              },
              {
                programIdIndex: 1,
                accounts: [6, 4, 8], // user -> base vault (Candidate in)
                data: makeSplTransferData(10_000_000_000n),
              },
              {
                programIdIndex: 1,
                accounts: [5, 7, 3], // quote vault -> user (SOL out)
                data: makeSplTransferData(19_000_000n),
              },
            ],
          },
        ],
        logMessages: [
          `Program ${SYNTHETIC_ROUTER_PROGRAM_ID} invoke [1]`,
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [2]`,
          makeRayLogLine(3, "PC2Coin", 50_000_000n, 25_000_000_000n),
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [2]`,
          makeRayLogLine(3, "Coin2PC", 10_000_000_000n, 19_000_000n),
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
          `Program ${SYNTHETIC_ROUTER_PROGRAM_ID} success`,
        ],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events.length).toBe(2);

    const buyEvent = res.events[0]!;
    expect(buyEvent.outerInstructionIndex).toBe(0);
    expect(buyEvent.swapIndex).toBe(0);
    expect(buyEvent.eventId).toBe(`${signature}:0:0`);
    expect(buyEvent.side).toBe("BUY");
    expect(buyEvent.tokenAmount).toBe(25_000_000_000n);
    expect(buyEvent.solAmount).toBe(50_000_000n);

    const sellEvent = res.events[1]!;
    expect(sellEvent.outerInstructionIndex).toBe(0);
    expect(sellEvent.swapIndex).toBe(3);
    expect(sellEvent.eventId).toBe(`${signature}:0:3`);
    expect(sellEvent.side).toBe("SELL");
    expect(sellEvent.tokenAmount).toBe(10_000_000_000n);
    expect(sellEvent.solAmount).toBe(19_000_000n);
  });

  it("fails closed with CONFLICTING_EVIDENCE when inner transfers contradict ray_log direction", () => {
    const signature = "9aX84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_129;
    const blockTime = 1_700_000_049;

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

    // Transfers indicate SELL (user sends Candidate to Base Vault, receives SOL from Quote Vault)
    const innerInstructions = [
      {
        programId: SPL_TOKEN_PROGRAM_ID,
        accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_WALLET],
        data: makeSplTransferData(25_000_000_000n),
      },
      {
        programId: SPL_TOKEN_PROGRAM_ID,
        accounts: [SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
        data: makeSplTransferData(50_000_000n),
      },
    ];

    // But ray_log indicates PC2Coin (BUY)!
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
              data: makeSwapBaseInV2Data(50_000_000n, 25_000_000_000n),
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
        logMessages: makeRaydiumLogs(3, "PC2Coin", 50_000_000n, 25_000_000_000n),
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("CONFLICTING_EVIDENCE");
    expect(res.message).toMatch(
      /Transfer direction \(Coin2PC\) contradicts ray_log direction \(PC2Coin\)/,
    );
  });

  // =========================================================================
  // AUDIT AREA 3: Require proven successful execution
  // =========================================================================

  it("fails closed with TRANSACTION_NOT_SUCCESSFUL when meta.err is missing or undefined", () => {
    const signature = "1qT84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_135;
    const blockTime = 1_700_000_055;

    // meta object has no err property (err: undefined)
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
        // err is omitted/undefined!
      } as unknown as { err: null },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("TRANSACTION_NOT_SUCCESSFUL");
    expect(res.message).toMatch(/explicit successful status \(err: null\) is required/);
  });

  it("fails closed with INVOCATION_FAILED when caught Raydium CPI swap failed even if outer tx succeeded", () => {
    const signature = "6uM84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_142;
    const blockTime = 1_700_000_062;

    const accounts = [
      SYNTHETIC_ROUTER_PROGRAM_ID,
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

    // Outer transaction succeeds (meta.err === null), but inner Raydium call failed and was caught by router!
    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 0,
              accounts: [6, 7, 8],
              data: new Uint8Array([1, 2, 3]),
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
                programIdIndex: 9,
                accounts: [1, 2, 3, 4, 5, 6, 7, 8],
                data: makeSwapBaseInV2Data(50_000_000n, 25_000_000_000n),
              },
            ],
          },
        ],
        logMessages: [
          `Program ${SYNTHETIC_ROUTER_PROGRAM_ID} invoke [1]`,
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [2]`,
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} failed: custom program error: 0x1772`,
          `Program ${SYNTHETIC_ROUTER_PROGRAM_ID} success`,
        ],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("INVOCATION_FAILED");
    expect(res.message).toMatch(/did not complete successfully in log messages/);
  });

  it("fails closed with INVOCATION_FAILED when inner CPI swap lacks logMessages to prove execution", () => {
    const signature = "5jK84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_144;
    const blockTime = 1_700_000_064;

    const accounts = [
      SYNTHETIC_ROUTER_PROGRAM_ID,
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

    // Inner CPI instruction without logMessages
    const payload = {
      slot,
      blockTime,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programIdIndex: 0,
              accounts: [6, 7, 8],
              data: new Uint8Array([1, 2, 3]),
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
                programIdIndex: 9,
                accounts: [1, 2, 3, 4, 5, 6, 7, 8],
                data: makeSwapBaseInV2Data(50_000_000n, 25_000_000_000n),
              },
            ],
          },
        ],
        // logMessages omitted!
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("INVOCATION_FAILED");
    expect(res.message).toMatch(
      /Cannot prove successful execution of inner CPI swap without transaction logMessages/,
    );
  });

  // =========================================================================
  // AUDIT AREA 4: Remove pool-context substitution and validate boundaries
  // =========================================================================

  it("createTrackedRaydiumPoolContext throws when poolAddress is missing or invalid Base58 (no substitution)", () => {
    const mockState = {
      baseVault: SYNTHETIC_BASE_VAULT,
      quoteVault: SYNTHETIC_QUOTE_VAULT,
      baseMint: SYNTHETIC_CANDIDATE_MINT,
      quoteMint: SYNTHETIC_WSOL_MINT,
    } as unknown as D23RaydiumAmmV4State;

    // Missing poolAddress: throws error without falling back to state.baseVault!
    expect(() =>
      createTrackedRaydiumPoolContext(
        mockState,
        undefined as unknown as string,
        SYNTHETIC_CANDIDATE_MINT,
        SYNTHETIC_WSOL_MINT,
        "TOKEN_BASE_SOL_QUOTE",
      ),
    ).toThrow(/explicit.*poolAddress is mandatory/i);

    // Invalid Base58 poolAddress: throws error
    expect(() =>
      createTrackedRaydiumPoolContext(
        mockState,
        "Not-A-Base58-Key!",
        SYNTHETIC_CANDIDATE_MINT,
        SYNTHETIC_WSOL_MINT,
        "TOKEN_BASE_SOL_QUOTE",
      ),
    ).toThrow(/explicit.*poolAddress is mandatory/i);
  });

  it("validateTrackedPoolContext rejects contradictory mints or invalid orientation", () => {
    // Contradictory orientation: TOKEN_BASE_SOL_QUOTE requires candidateTokenMint to equal baseMint
    const contradictoryContext: TrackedRaydiumPoolContext = {
      poolId: SYNTHETIC_POOL_ID,
      candidateTokenMint: SYNTHETIC_CANDIDATE_MINT,
      quoteTokenMint: SYNTHETIC_WSOL_MINT,
      baseVault: SYNTHETIC_BASE_VAULT,
      quoteVault: SYNTHETIC_QUOTE_VAULT,
      baseMint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", // Different mint!
      quoteMint: SYNTHETIC_WSOL_MINT,
      orientation: "TOKEN_BASE_SOL_QUOTE",
    };

    expect(() => validateTrackedPoolContext(contradictoryContext)).toThrow(
      /TOKEN_BASE_SOL_QUOTE requires candidateTokenMint/,
    );
  });

  it("leaves solAmount undefined when quoteTokenMint is not WSOL (e.g. USDC quote)", () => {
    const signature = "8mU84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_152;
    const blockTime = 1_700_000_072;
    const usdcIn = 10_000_000n; // 10 USDC (6 decimals)
    const candidateOut = 50_000_000_000n; // 50,000 BONK

    const accounts = [
      SPL_TOKEN_PROGRAM_ID,
      SYNTHETIC_POOL_ID,
      SYNTHETIC_AMM_AUTHORITY,
      SYNTHETIC_BASE_VAULT, // BONK vault
      SYNTHETIC_QUOTE_VAULT, // USDC vault
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
              data: makeSwapBaseInV2Data(usdcIn, candidateOut),
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
                data: makeSplTransferData(usdcIn),
              },
              {
                programId: SPL_TOKEN_PROGRAM_ID,
                accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
                data: makeSplTransferData(candidateOut),
              },
            ],
          },
        ],
        logMessages: makeRaydiumLogs(3, "PC2Coin", usdcIn, candidateOut),
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, USDC_QUOTED_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events.length).toBe(1);
    const event = res.events[0]!;
    expect(event.side).toBe("BUY");
    expect(event.tokenAmount).toBe(candidateOut);
    // Non-WSOL quote quantity must NEVER be labeled as SOL
    expect(event.solAmount).toBeUndefined();
  });

  it("adapter freezes pool context against caller mutation", () => {
    const mutableContext: TrackedRaydiumPoolContext = {
      poolId: SYNTHETIC_POOL_ID,
      candidateTokenMint: SYNTHETIC_CANDIDATE_MINT,
      quoteTokenMint: SYNTHETIC_WSOL_MINT,
      baseVault: SYNTHETIC_BASE_VAULT,
      quoteVault: SYNTHETIC_QUOTE_VAULT,
      baseMint: SYNTHETIC_CANDIDATE_MINT,
      quoteMint: SYNTHETIC_WSOL_MINT,
      orientation: "TOKEN_BASE_SOL_QUOTE",
    };

    const adapter = new RaydiumAmmV4SwapNormalizationAdapter(mutableContext);
    const retrieved = adapter.getPoolContext();

    expect(Object.isFrozen(retrieved)).toBe(true);
    expect(retrieved.poolId).toBe(SYNTHETIC_POOL_ID);
  });

  // =========================================================================
  // AUDIT AREA 5: Fail cleanly on malformed payloads and missing time
  // =========================================================================

  it("returns INVALID_PAYLOAD without throwing on null or non-object payloads", () => {
    // Null payload
    const nullRes = decodeRaydiumTransactionSwaps(null, STANDARD_POOL_CONTEXT);
    expect(nullRes.ok).toBe(false);
    if (!nullRes.ok) {
      expect(nullRes.reason).toBe("INVALID_PAYLOAD");
    }

    // String payload
    const strRes = decodeRaydiumTransactionSwaps("not-a-payload", STANDARD_POOL_CONTEXT);
    expect(strRes.ok).toBe(false);
    if (!strRes.ok) {
      expect(strRes.reason).toBe("INVALID_PAYLOAD");
    }

    // Number payload
    const numRes = decodeRaydiumTransactionSwaps(12345, STANDARD_POOL_CONTEXT);
    expect(numRes.ok).toBe(false);
    if (!numRes.ok) {
      expect(numRes.reason).toBe("INVALID_PAYLOAD");
    }

    // Adapter ingestTransaction with null
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
    });
    const adapter = new RaydiumAmmV4SwapNormalizationAdapter(STANDARD_POOL_CONTEXT);
    const ingestRes = adapter.ingestTransaction(null, tracker);
    expect(ingestRes.decodeResult.ok).toBe(false);
    if (!ingestRes.decodeResult.ok) {
      expect(ingestRes.decodeResult.reason).toBe("INVALID_PAYLOAD");
    }
  });

  it("returns MALFORMED_INSTRUCTION_DATA when instruction account index is out of bounds", () => {
    const signature = "4pB84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_155;
    const blockTime = 1_700_000_075;

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

    // Account index 999 is out of bounds (resolved accounts length is 9)
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
              accounts: [0, 1, 2, 3, 4, 5, 6, 999], // Index 999 is out of bounds!
              data: makeSwapBaseInV2Data(10_000_000n, 50_000_000n),
            },
          ],
        },
      },
      meta: {
        err: null,
        logMessages: makeRaydiumLogs(3, "PC2Coin", 10_000_000n, 50_000_000n),
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("MALFORMED_INSTRUCTION_DATA");
    expect(res.message).toMatch(/Instruction account indices are invalid or out of bounds/);
  });

  it("rejects transactions with missing, non-finite, or non-positive blockTime (MISSING_UPSTREAM_TIMESTAMP)", () => {
    const signature = "7uT84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_210;

    const testMissingTime = (blockTime: unknown) => {
      const payload = {
        slot,
        blockTime: blockTime as number | null,
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
    };

    testMissingTime(null);
    testMissingTime(undefined);
    testMissingTime(NaN);
    testMissingTime(0);
    testMissingTime(-100);
  });

  // =========================================================================
  // ADDITIONAL BASELINE & SYSTEM BEHAVIOR REGRESSIONS
  // =========================================================================

  it("handles inverted pair orientation (SOL_BASE_TOKEN_QUOTE) correctly", () => {
    const signature = "2bA84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_120;
    const blockTime = 1_700_000_040;
    const solIn = 150_000_000n;
    const candidateOut = 75_000_000_000n;

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
        logMessages: makeRaydiumLogs(3, "Coin2PC", solIn, candidateOut),
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
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
          makeRayLogLine(3, "PC2Coin", 20_000_000n, 10_000_000_000n),
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
          makeRayLogLine(3, "Coin2PC", 5_000_000_000n, 9_000_000n),
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
        ],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.events.length).toBe(2);

    expect(res.events[0]!.outerInstructionIndex).toBe(0);
    expect(res.events[0]!.swapIndex).toBe(0);
    expect(res.events[0]!.eventId).toBe(`${signature}:0:0`);
    expect(res.events[0]!.side).toBe("BUY");
    expect(res.events[0]!.tokenAmount).toBe(10_000_000_000n);
    expect(res.events[0]!.solAmount).toBe(20_000_000n);

    expect(res.events[1]!.outerInstructionIndex).toBe(1);
    expect(res.events[1]!.swapIndex).toBe(0);
    expect(res.events[1]!.eventId).toBe(`${signature}:1:0`);
    expect(res.events[1]!.side).toBe("SELL");
    expect(res.events[1]!.tokenAmount).toBe(5_000_000_000n);
    expect(res.events[1]!.solAmount).toBe(9_000_000n);
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
      SYNTHETIC_POOL_ID,
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
        err: { InstructionError: [0, "Custom: 1"] },
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

  it("fails closed with AMBIGUOUS_DIRECTION when direction cannot be determined from transfers or logs", () => {
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
        logMessages: [
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
          `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
        ],
      },
    };

    const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.reason).toBe("AMBIGUOUS_DIRECTION");
  });

  it("integrates with RollingTradeFlowTracker via NormalizationAdapter and verifies deduplication", () => {
    const nowMs = 1_700_000_000_000;
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: nowMs - 60_000,
      clock: () => nowMs,
    });

    // Establish complete window coverage with explicit historical range and heartbeat
    tracker.recordCompletedRange(nowMs - 60_000, nowMs);
    tracker.recordHeartbeat(nowMs);

    const adapter = new RaydiumAmmV4SwapNormalizationAdapter(STANDARD_POOL_CONTEXT);

    const signature = "4pA84qB1sN6yK4xM8jD4vR7kP2qT9uV1wX3yZ5aB7cE9gH1jK3mN5pQ7sU9wX2yZ";
    const slot = 280_000_220;
    const blockTime = Math.floor((nowMs - 10_000) / 1000);
    const solIn = 50_000_000n;
    const candidateOut = 20_000_000_000n;

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
        logMessages: makeRaydiumLogs(3, "PC2Coin", solIn, candidateOut),
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
        logMessages: makeRaydiumLogs(3, "PC2Coin", 10_000_000n, 5_000_000_000n),
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
    expect(resolved).not.toBeNull();
    expect(resolved!.length).toBe(4);
    expect(resolved![0]).toBe("StaticKey1111111111111111111111111111111111");
    expect(resolved![1]).toBe("StaticKey2222222222222222222222222222222222");
    expect(resolved![2]).toBe("WritableLookupKey11111111111111111111111111111");
    expect(resolved![3]).toBe("ReadonlyLookupKey11111111111111111111111111111");
  });

  it("verifies decodeInstructionData, parseRayLog, and parseInvocationFrames helpers", () => {
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

    // parseInvocationFrames
    const frames = parseInvocationFrames([
      "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
      validLog,
      "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
    ]);
    expect(frames.length).toBe(1);
    expect(frames[0]!.success).toBe(true);
    expect(frames[0]!.rayLogs.length).toBe(1);
  });

  // =========================================================================
  // AUDIT CORRECTIONS: Invocation Binding & Input Validation Regressions
  // =========================================================================

  describe("Invocation Binding & Malformed Input Audit Regressions", () => {
    it("Reproduction 1: reversed innerInstructions groups order preserves parent index binding", () => {
      const signature = "ReversedGroupOrderTxSig111111111111111111111111111111111111";
      const slot = 280_000_300;
      const blockTime = 1_700_000_300;

      const solIn0 = 100_000_000n;
      const tokenOut0 = 50_000_000_000n;
      const solIn1 = 200_000_000n;
      const tokenOut1 = 100_000_000_000n;

      const accounts = [
        SPL_TOKEN_PROGRAM_ID, // 0
        SYNTHETIC_POOL_ID, // 1
        SYNTHETIC_AMM_AUTHORITY, // 2
        SYNTHETIC_BASE_VAULT, // 3
        SYNTHETIC_QUOTE_VAULT, // 4
        SYNTHETIC_USER_SOURCE_ATA, // 5
        SYNTHETIC_USER_DEST_ATA, // 6
        SYNTHETIC_USER_WALLET, // 7
        RAYDIUM_AMM_V4_PROGRAM_ID, // 8
      ];

      // Two outer SwapBaseInV2 instructions reusing the same user accounts
      const instructions = [
        {
          programIdIndex: 8,
          accounts: [0, 1, 2, 3, 4, 5, 6, 7],
          data: makeSwapBaseInV2Data(solIn0, tokenOut0),
        },
        {
          programIdIndex: 8,
          accounts: [0, 1, 2, 3, 4, 5, 6, 7],
          data: makeSwapBaseInV2Data(solIn1, tokenOut1),
        },
      ];

      // REVERSED group order in meta.innerInstructions: group for outer 1 comes FIRST, outer 0 SECOND
      const innerInstructions = [
        {
          index: 1, // Parent is outer instruction 1
          instructions: [
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
              data: makeSplTransferData(solIn1),
            },
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
              data: makeSplTransferData(tokenOut1),
            },
          ],
        },
        {
          index: 0, // Parent is outer instruction 0
          instructions: [
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
              data: makeSplTransferData(solIn0),
            },
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
              data: makeSplTransferData(tokenOut0),
            },
          ],
        },
      ];

      const logMessages = [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        makeRayLogLine(3, "PC2Coin", solIn0, tokenOut0),
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        makeRayLogLine(3, "PC2Coin", solIn1, tokenOut1),
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      ];

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: accounts,
            instructions,
          },
        },
        meta: {
          err: null,
          innerInstructions,
          logMessages,
        },
      };

      const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.events.length).toBe(2);
      // Outer 0 must receive solIn0 (100) and tokenOut0 (50), NOT 200 then 100!
      expect(res.events[0]!.outerInstructionIndex).toBe(0);
      expect(res.events[0]!.solAmount).toBe(solIn0);
      expect(res.events[0]!.tokenAmount).toBe(tokenOut0);

      // Outer 1 must receive solIn1 (200) and tokenOut1 (100)
      expect(res.events[1]!.outerInstructionIndex).toBe(1);
      expect(res.events[1]!.solAmount).toBe(solIn1);
      expect(res.events[1]!.tokenAmount).toBe(tokenOut1);
    });

    it("Reproduction 2: same-direction transfers (200/180) vs log (100/90) fails closed with CONFLICTING_EVIDENCE", () => {
      const signature = "ConflictingQuantitiesTxSig11111111111111111111111111111111";
      const slot = 280_000_305;
      const blockTime = 1_700_000_305;

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

      // Instruction specifies 100 in, 90 out
      const instruction = {
        programIdIndex: 8,
        accounts: [0, 1, 2, 3, 4, 5, 6, 7],
        data: makeSwapBaseInV2Data(100_000_000n, 90_000_000_000n),
      };

      // Transfers report 200 in, 180 out (same direction PC2Coin)
      const innerInstructions = [
        {
          index: 0,
          instructions: [
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
              data: makeSplTransferData(200_000_000n),
            },
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
              data: makeSplTransferData(180_000_000_000n),
            },
          ],
        },
      ];

      // Log reports 100 in, 90 out (same direction PC2Coin)
      const logMessages = [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        makeRayLogLine(3, "PC2Coin", 100_000_000n, 90_000_000_000n),
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      ];

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: accounts,
            instructions: [instruction],
          },
        },
        meta: {
          err: null,
          innerInstructions,
          logMessages,
        },
      };

      const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe("CONFLICTING_EVIDENCE");
      expect(res.message).toMatch(/contradict ray_log quantities/);
      expect(res.events.length).toBe(0);
    });

    it("Reproduction 3: child program emitting BUY ray_log is ignored; parent Raydium SELL log decodes as SELL", () => {
      const signature = "ChildProgramLogAttributionTxSig11111111111111111111111111111";
      const slot = 280_000_310;
      const blockTime = 1_700_000_310;

      const candidateIn = 25_000_000_000n;
      const solOut = 50_000_000n;

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
        SYNTHETIC_ROUTER_PROGRAM_ID,
      ];

      const instruction = {
        programIdIndex: 8,
        accounts: [0, 1, 2, 3, 4, 5, 6, 7],
        data: makeSwapBaseInV2Data(candidateIn, solOut),
      };

      const innerInstructions = [
        {
          index: 0,
          instructions: [
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
          ],
        },
      ];

      // Child program emits a BUY-shaped ray_log while executing at depth 2
      // Parent Raydium emits its own SELL log at depth 1
      const logMessages = [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        `Program ${SYNTHETIC_ROUTER_PROGRAM_ID} invoke [2]`,
        makeRayLogLine(3, "PC2Coin", 100_000_000n, 50_000_000_000n), // Child's BUY log
        `Program ${SYNTHETIC_ROUTER_PROGRAM_ID} success`,
        makeRayLogLine(3, "Coin2PC", candidateIn, solOut), // Raydium's actual SELL log
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      ];

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: accounts,
            instructions: [instruction],
          },
        },
        meta: {
          err: null,
          innerInstructions,
          logMessages,
        },
      };

      const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.events.length).toBe(1);
      // Must be SELL, NOT BUY! Child log must not corrupt parent frame.
      expect(res.events[0]!.side).toBe("SELL");
      expect(res.events[0]!.tokenAmount).toBe(candidateIn);
      expect(res.events[0]!.solAmount).toBe(solOut);
    });

    it("Reproduction 4: ambiguous multiple ray_logs within single Raydium frame fails closed with AMBIGUOUS_DIRECTION", () => {
      const signature = "AmbiguousMultipleLogsTxSig111111111111111111111111111111111";
      const slot = 280_000_315;
      const blockTime = 1_700_000_315;

      const solIn = 100_000_000n;
      const tokenOut = 50_000_000_000n;

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

      const instruction = {
        programIdIndex: 8,
        accounts: [0, 1, 2, 3, 4, 5, 6, 7],
        data: makeSwapBaseInV2Data(solIn, tokenOut),
      };

      // Two ray_logs emitted in the same Raydium frame
      const logMessages = [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        makeRayLogLine(3, "PC2Coin", solIn, tokenOut),
        makeRayLogLine(3, "Coin2PC", tokenOut, solIn), // Second log in same frame
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      ];

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: accounts,
            instructions: [instruction],
          },
        },
        meta: {
          err: null,
          logMessages,
        },
      };

      const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe("AMBIGUOUS_DIRECTION");
      expect(res.message).toMatch(/Ambiguous multiple ray_logs/);
      expect(res.events.length).toBe(0);
    });

    it("Reproduction 5: null static account-key entry is rejected with MALFORMED_INSTRUCTION_DATA (no shifted indices)", () => {
      const signature = "NullStaticAccountKeyTxSig1111111111111111111111111111111111";
      const slot = 280_000_320;
      const blockTime = 1_700_000_320;

      // Null static account key entry at index 1
      const malformedAccounts: (string | null)[] = [
        SPL_TOKEN_PROGRAM_ID, // 0
        null, // 1: NULL ENTRY!
        SYNTHETIC_POOL_ID, // 2: would shift to 1 if null were silently dropped!
        SYNTHETIC_AMM_AUTHORITY, // 3
        SYNTHETIC_BASE_VAULT, // 4
        SYNTHETIC_QUOTE_VAULT, // 5
        SYNTHETIC_USER_SOURCE_ATA, // 6
        SYNTHETIC_USER_DEST_ATA, // 7
        SYNTHETIC_USER_WALLET, // 8
        RAYDIUM_AMM_V4_PROGRAM_ID, // 9
      ];

      const instruction = {
        programIdIndex: 9,
        accounts: [0, 1, 3, 4, 5, 6, 7, 8],
        data: makeSwapBaseInV2Data(100_000_000n, 50_000_000_000n),
      };

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: malformedAccounts,
            instructions: [instruction],
          },
        },
        meta: {
          err: null,
          logMessages: makeRaydiumLogs(3, "PC2Coin", 100_000_000n, 50_000_000_000n),
        },
      };

      const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe("MALFORMED_INSTRUCTION_DATA");
      expect(res.events.length).toBe(0);
    });

    it("Reproduction 6: null instruction in message.instructions returns MALFORMED_INSTRUCTION_DATA without throwing", () => {
      const signature = "NullInstructionTxSig11111111111111111111111111111111111111";
      const slot = 280_000_325;
      const blockTime = 1_700_000_325;

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [SPL_TOKEN_PROGRAM_ID, SYNTHETIC_POOL_ID],
            instructions: [null], // Null instruction!
          },
        },
        meta: {
          err: null,
        },
      };

      expect(() => {
        const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe("MALFORMED_INSTRUCTION_DATA");
          expect(res.events.length).toBe(0);
        }
      }).not.toThrow();
    });

    it("Reproduction 7: null innerInstructions group or inner instruction returns MALFORMED_INSTRUCTION_DATA without throwing", () => {
      const signature = "NullInnerGroupTxSig111111111111111111111111111111111111111";
      const slot = 280_000_330;
      const blockTime = 1_700_000_330;

      // Case A: Null group
      const payloadA = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [SPL_TOKEN_PROGRAM_ID],
            instructions: [
              {
                programIdIndex: 0,
                accounts: [0],
                data: "",
              },
            ],
          },
        },
        meta: {
          err: null,
          innerInstructions: [null], // Null group!
        },
      };

      expect(() => {
        const res = decodeRaydiumTransactionSwaps(payloadA, STANDARD_POOL_CONTEXT);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe("MALFORMED_INSTRUCTION_DATA");
        }
      }).not.toThrow();

      // Case B: Null inner instruction inside group
      const payloadB = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [SPL_TOKEN_PROGRAM_ID],
            instructions: [
              {
                programIdIndex: 0,
                accounts: [0],
                data: "",
              },
            ],
          },
        },
        meta: {
          err: null,
          innerInstructions: [
            {
              index: 0,
              instructions: [null], // Null inner instruction!
            },
          ],
        },
      };

      expect(() => {
        const res = decodeRaydiumTransactionSwaps(payloadB, STANDARD_POOL_CONTEXT);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe("MALFORMED_INSTRUCTION_DATA");
        }
      }).not.toThrow();
    });

    it("Reproduction 8: non-string log entry in meta.logMessages returns MALFORMED_INSTRUCTION_DATA without throwing", () => {
      const signature = "NonStringLogTxSig1111111111111111111111111111111111111111";
      const slot = 280_000_335;
      const blockTime = 1_700_000_335;

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [SPL_TOKEN_PROGRAM_ID],
            instructions: [
              {
                programIdIndex: 0,
                accounts: [0],
                data: "",
              },
            ],
          },
        },
        meta: {
          err: null,
          logMessages: [
            "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
            12345, // NON-STRING LOG ENTRY!
            "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
          ] as unknown as string[],
        },
      };

      expect(() => {
        const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe("MALFORMED_INSTRUCTION_DATA");
          expect(res.events.length).toBe(0);
        }
      }).not.toThrow();
    });

    it("Reproduction 9: numeric instruction data containing -240 returns MALFORMED_INSTRUCTION_DATA (never coerced to byte 16)", () => {
      const signature = "NegativeByteTxSig1111111111111111111111111111111111111111";
      const slot = 280_000_340;
      const blockTime = 1_700_000_340;

      // decodeInstructionData directly rejects negative, fractional, or non-finite values
      expect(decodeInstructionData([-240])).toBeNull();
      expect(decodeInstructionData([1.5, 2])).toBeNull();
      expect(decodeInstructionData([NaN])).toBeNull();
      expect(decodeInstructionData([Infinity])).toBeNull();
      expect(decodeInstructionData([256])).toBeNull();

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

      // Array containing -240 at index 0 (which would coerce to byte 16 if not validated)
      const dataWithNegativeByte = [-240, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 50];

      const instruction = {
        programIdIndex: 8,
        accounts: [0, 1, 2, 3, 4, 5, 6, 7],
        data: dataWithNegativeByte,
      };

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: accounts,
            instructions: [instruction],
          },
        },
        meta: {
          err: null,
          logMessages: makeRaydiumLogs(3, "PC2Coin", 100_000_000n, 50_000_000_000n),
        },
      };

      const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe("MALFORMED_INSTRUCTION_DATA");
      expect(res.events.length).toBe(0);
    });

    it("Normalization adapter handles all malformed inputs cleanly without throwing", () => {
      const adapter = new RaydiumAmmV4SwapNormalizationAdapter(STANDARD_POOL_CONTEXT);
      const tracker = new RollingTradeFlowTracker({
        poolId: STANDARD_POOL_CONTEXT.poolId,
        tokenMint: STANDARD_POOL_CONTEXT.candidateTokenMint,
      });

      // 1. null payload
      expect(() => {
        const res = adapter.ingestTransaction(null, tracker);
        expect(res.decodeResult.ok).toBe(false);
        expect(res.ingestedCount).toBe(0);
        expect(res.signature).toBe("unknown-signature");
      }).not.toThrow();

      // 2. undefined payload
      expect(() => {
        const res = adapter.ingestTransaction(undefined, tracker);
        expect(res.decodeResult.ok).toBe(false);
        expect(res.ingestedCount).toBe(0);
      }).not.toThrow();

      // 3. payload with null message
      expect(() => {
        const res = adapter.ingestTransaction(
          {
            slot: 100,
            blockTime: 100,
            transaction: { signatures: ["sig1"], message: null },
            meta: { err: null },
          },
          tracker,
        );
        expect(res.decodeResult.ok).toBe(false);
        if (!res.decodeResult.ok) {
          expect(res.decodeResult.reason).toBe("MALFORMED_INSTRUCTION_DATA");
        }
        expect(res.ingestedCount).toBe(0);
      }).not.toThrow();

      // 4. payload with null instruction
      expect(() => {
        const res = adapter.ingestTransaction(
          {
            slot: 100,
            blockTime: 100,
            transaction: {
              signatures: ["sig1"],
              message: {
                accountKeys: ["Key111111111111111111111111111111111111111"],
                instructions: [null],
              },
            },
            meta: { err: null },
          },
          tracker,
        );
        expect(res.decodeResult.ok).toBe(false);
        if (!res.decodeResult.ok) {
          expect(res.decodeResult.reason).toBe("MALFORMED_INSTRUCTION_DATA");
        }
        expect(res.ingestedCount).toBe(0);
      }).not.toThrow();
    });

    it("rejects instruction when ray_log logType contradicts instruction tag", () => {
      const signature = "MismatchedLogTypeTxSig111111111111111111111111111111111111";
      const slot = 280_000_350;
      const blockTime = 1_700_000_350;

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

      // Instruction tag 16 (SwapBaseInV2)
      const instruction = {
        programIdIndex: 8,
        accounts: [0, 1, 2, 3, 4, 5, 6, 7],
        data: makeSwapBaseInV2Data(100_000_000n, 50_000_000_000n),
      };

      // Ray log has logType 4 (SwapBaseOut) instead of 3 (SwapBaseIn)
      const logMessages = [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        makeRayLogLine(4, "PC2Coin", 100_000_000n, 50_000_000_000n),
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      ];

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: accounts,
            instructions: [instruction],
          },
        },
        meta: {
          err: null,
          logMessages,
        },
      };

      const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe("CONFLICTING_EVIDENCE");
      expect(res.message).toMatch(/expects logType 3/);
      expect(res.events.length).toBe(0);
    });

    it("fails closed with INVOCATION_FAILED when unclosed Raydium frame remains at end of logMessages", () => {
      const signature = "UnclosedFrameTxSig1111111111111111111111111111111111111111";
      const slot = 280_000_355;
      const blockTime = 1_700_000_355;

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

      const instruction = {
        programIdIndex: 8,
        accounts: [0, 1, 2, 3, 4, 5, 6, 7],
        data: makeSwapBaseInV2Data(100_000_000n, 50_000_000_000n),
      };

      // Invocation never receives a success or failed log (truncated trace)
      const logMessages = [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        makeRayLogLine(3, "PC2Coin", 100_000_000n, 50_000_000_000n),
        // Missing "Program 675k... success"!
      ];

      const payload = {
        slot,
        blockTime,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: accounts,
            instructions: [instruction],
          },
        },
        meta: {
          err: null,
          logMessages,
        },
      };

      const res = decodeRaydiumTransactionSwaps(payload, STANDARD_POOL_CONTEXT);
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.reason).toBe("INVOCATION_FAILED");
      expect(res.events.length).toBe(0);
    });
  });
});
