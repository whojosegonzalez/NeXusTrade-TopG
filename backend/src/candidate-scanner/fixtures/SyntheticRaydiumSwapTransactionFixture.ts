/**
 * SYNTHETIC FIXTURE — JSON-safe Raydium AMM v4 swap transactions for offline PAPER active-window tests.
 *
 * Builds getTransaction `result` payloads (base58 instruction data, ray_log lines, SPL inner transfers) using
 * the same legacy 17-account SwapBaseIn layout exercised by RaydiumAmmV4SwapDecoder.test.ts. These are not
 * captured market data; amounts, users, slots, and times are synthetic and chosen by each test.
 */
import { encodeBase58 } from "../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../../research/pilot/RaydiumAmmParser.js";
import type { TrackedRaydiumPoolContext } from "../RaydiumAmmV4SwapDecoder.js";

const SYNTHETIC_AMM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const SYNTHETIC_USER_SOURCE_ATA = "UserSourceTokenAccount1111111111111111111111";
const SYNTHETIC_USER_DEST_ATA = "UserDestTokenAccount111111111111111111111111";
const SYNTHETIC_USER_WALLET = "UserWalletOwner1111111111111111111111111111";

function u64Data(tag: number, a: bigint, b: bigint): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = tag;
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, a, true);
  view.setBigUint64(9, b, true);
  return buf;
}

function splTransferData(amount: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = 3; // SPL Transfer
  new DataView(buf.buffer).setBigUint64(1, amount, true);
  return buf;
}

function rayLogSwapBaseIn(direction: "Coin2PC" | "PC2Coin", amountIn: bigint, amountOut: bigint) {
  const buf = Buffer.alloc(57);
  buf[0] = 3; // SwapBaseInLog
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amountIn, true);
  view.setBigUint64(9, 0n, true);
  view.setBigUint64(17, direction === "PC2Coin" ? 1n : 2n, true);
  view.setBigUint64(49, amountOut, true);
  return `Program log: ray_log: ${buf.toString("base64")}`;
}

/**
 * SYNTHETIC: one candidate-bound Raydium AMM v4 SwapBaseIn for a TOKEN_BASE_SOL_QUOTE pool.
 * BUY = SOL in to the quote vault, candidate out of the base vault; SELL = the reverse.
 */
export function buildSyntheticSwapTransactionResult(params: {
  readonly poolContext: TrackedRaydiumPoolContext;
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly side: "BUY" | "SELL";
}): Record<string, unknown> {
  const { poolContext, signature, slot, blockTime, side } = params;
  if (poolContext.orientation !== "TOKEN_BASE_SOL_QUOTE") {
    throw new Error("SYNTHETIC fixture supports TOKEN_BASE_SOL_QUOTE pools only");
  }
  const solAmount = 100_000_000n;
  const tokenAmount = 50_000_000_000n;
  const amountIn = side === "BUY" ? solAmount : tokenAmount;
  const amountOut = side === "BUY" ? tokenAmount : solAmount;
  // BUY: user SOL -> quote vault, base vault -> user candidate. SELL: user candidate -> base vault, quote vault -> user SOL.
  const inVault = side === "BUY" ? poolContext.quoteVault : poolContext.baseVault;
  const outVault = side === "BUY" ? poolContext.baseVault : poolContext.quoteVault;

  const accountKeys = [
    SPL_TOKEN_PROGRAM_ID,
    poolContext.poolId,
    SYNTHETIC_AMM_AUTHORITY,
    "OpenOrdersAccount1111111111111111111111111111",
    poolContext.baseVault,
    poolContext.quoteVault,
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

  return {
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
            data: encodeBase58(u64Data(9, amountIn, amountOut)),
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
              accounts: [SYNTHETIC_USER_SOURCE_ATA, inVault, SYNTHETIC_USER_WALLET],
              data: encodeBase58(splTransferData(amountIn)),
            },
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [outVault, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
              data: encodeBase58(splTransferData(amountOut)),
            },
          ],
        },
      ],
      logMessages: [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        rayLogSwapBaseIn(side === "BUY" ? "PC2Coin" : "Coin2PC", amountIn, amountOut),
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      ],
    },
  };
}
