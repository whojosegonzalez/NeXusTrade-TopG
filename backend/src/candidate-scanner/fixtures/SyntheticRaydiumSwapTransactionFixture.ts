/**
 * SYNTHETIC FIXTURE — JSON-safe Raydium AMM v4 swap transactions for offline PAPER active-window tests.
 *
 * Builds getTransaction `result` payloads (base58 instruction data, ray_log lines, SPL inner transfers) using
 * the same legacy 17-account SwapBaseIn layout exercised by RaydiumAmmV4SwapDecoder.test.ts. These are not
 * captured market data; amounts, users, slots, and times are synthetic and chosen by each test.
 */
import { createHash } from "node:crypto";
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

/** SYNTHETIC on-chain error shaped like a Raydium slippage failure (`InstructionError` with a custom code). */
export const SYNTHETIC_FAILED_TRANSACTION_ERROR = Object.freeze({
  InstructionError: Object.freeze([0, Object.freeze({ Custom: 30 })]),
});

/**
 * SYNTHETIC deterministic 32-byte address: canonical Base58 of SHA-256 over a fixed label. Structurally valid
 * (unlike the placeholder strings used by the swap fixture); it names no real account.
 */
export function syntheticCanonicalAddress(label: string): string {
  return encodeBase58(createHash("sha256").update(`NEXUSTRADE-SYNTHETIC:${label}`).digest());
}

/**
 * SYNTHETIC: a structurally complete getTransaction `result` (json encoding, legacy message) for a candidate-
 * pool SwapBaseIn attempt that FAILED on-chain. Every field the failed-transaction validator checks is valid:
 *  - header consistent with one writable fee-payer signer and the readonly static keys;
 *  - canonical 32-byte Base58 account keys and recent blockhash (deterministic synthetic addresses, plus the
 *    pool, vaults, and real program ids);
 *  - Raydium AMM v4 program as a static, non-fee-payer program index; Base58 instruction data;
 *  - empty loaded addresses (legacy), a recognized `meta.err`, and a matching deprecated `meta.status`.
 * No inner transfers are committed. Pass `err` to vary the error.
 */
export function buildSyntheticFailedTransactionResult(params: {
  readonly poolContext: TrackedRaydiumPoolContext;
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly err?: unknown;
}): Record<string, unknown> {
  const { poolContext, signature, slot, blockTime } = params;
  const err = params.err === undefined ? SYNTHETIC_FAILED_TRANSACTION_ERROR : params.err;
  const a = (label: string) => syntheticCanonicalAddress(`${label}:${poolContext.poolId}`);
  // Writable signer, writable non-signers, then readonly non-signers (Solana static key ordering).
  const accountKeys = [
    a("user-wallet"), // 0 fee payer / user owner (writable signer)
    a("user-source-ata"), // 1
    a("user-dest-ata"), // 2
    poolContext.poolId, // 3 amm
    a("amm-open-orders"), // 4
    poolContext.baseVault, // 5 pool coin vault
    poolContext.quoteVault, // 6 pool pc vault
    a("serum-market"), // 7
    a("serum-bids"), // 8
    a("serum-asks"), // 9
    a("serum-event-queue"), // 10
    a("serum-coin-vault"), // 11
    a("serum-pc-vault"), // 12
    a("amm-authority"), // 13 readonly
    a("serum-vault-signer"), // 14 readonly
    a("serum-program"), // 15 readonly
    SPL_TOKEN_PROGRAM_ID, // 16 readonly
    RAYDIUM_AMM_V4_PROGRAM_ID, // 17 readonly
  ];
  return {
    slot,
    blockTime,
    version: "legacy",
    transaction: {
      signatures: [signature],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 5,
        },
        accountKeys,
        recentBlockhash: a("recent-blockhash"),
        instructions: [
          {
            programIdIndex: 17,
            accounts: [16, 3, 13, 4, 5, 6, 15, 7, 8, 9, 10, 11, 12, 14, 1, 2, 0],
            data: encodeBase58(u64Data(9, 100_000_000n, 50_000_000_000n)),
            stackHeight: null,
          },
        ],
      },
    },
    meta: {
      err: JSON.parse(JSON.stringify(err)) as unknown,
      status: { Err: JSON.parse(JSON.stringify(err)) as unknown },
      fee: 5000,
      innerInstructions: [],
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        "Program log: Error: exceeds desired slippage limit",
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} failed: custom program error: 0x1e`,
      ],
    },
  };
}
