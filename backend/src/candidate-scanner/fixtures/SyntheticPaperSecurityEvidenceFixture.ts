/**
 * [SYNTHETIC TEST CONTEXT] PAPER candidate security evidence fixtures (offline, version-controlled).
 *
 * Every builder here produces SYNTHETIC evidence for the reference RAY/WSOL identities used by the
 * existing LP fixtures. Nothing here was captured, and none of it describes the real token's state.
 * The only historical input used alongside these builders is the sanitized Solana Tracker bundler
 * capture (`CapturedSolanaTrackerBundlerFixture.ts`), which supports explicitly dated replay only.
 */

import { SPL_TOKEN_PROGRAM_ID } from "../../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import { CAPTURED_RAY_WSOL_IDENTITIES } from "./CapturedRaydiumAmmV4SnapshotFixture.js";

export const SYNTHETIC_SECURITY_POOL: string = CAPTURED_RAY_WSOL_IDENTITIES.poolId;
export const SYNTHETIC_SECURITY_MINT: string = requireMint(
  CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint,
);

function requireMint(mint: string | undefined): string {
  if (mint === undefined) throw new Error("fixture identities must name the expected token mint");
  return mint;
}
/** A canonical base58 address used as a SYNTHETIC active authority. */
export const SYNTHETIC_ACTIVE_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
/** A canonical base58 mint that is not the candidate (identity-mismatch cases). */
export const SYNTHETIC_OTHER_MINT = "So11111111111111111111111111111111111111112";

/** [SYNTHETIC] JSON-RPC request id used by the synthetic mint-account request and response. */
export const SYNTHETIC_MINT_REQUEST_ID = 1;

/**
 * [SYNTHETIC] Mint-account evidence: request identity and SYNTHETIC transport metadata (HTTP 200,
 * complete body, request id) around a synthetic response. Nothing here was observed on the wire.
 */
export function syntheticMintAccountEvidence(
  retrievedAtMs: number,
  options: {
    readonly response?: unknown;
    readonly requestedMint?: string;
    readonly httpStatus?: number;
    readonly bodyComplete?: boolean;
    readonly expectedRequestId?: number | string;
  } = {},
): {
  readonly requestedMint: string;
  readonly retrievedAtMs: number;
  readonly httpStatus: number;
  readonly bodyComplete: boolean;
  readonly expectedRequestId: number | string;
  readonly response: unknown;
} {
  return {
    requestedMint: options.requestedMint ?? SYNTHETIC_SECURITY_MINT,
    retrievedAtMs,
    httpStatus: options.httpStatus ?? 200,
    bodyComplete: options.bodyComplete ?? true,
    expectedRequestId: options.expectedRequestId ?? SYNTHETIC_MINT_REQUEST_ID,
    response: "response" in options ? options.response : syntheticMintAccountResponse(),
  };
}

/**
 * [SYNTHETIC] jsonParsed `getAccountInfo` response for the candidate mint. `info` overrides replace
 * fields; pass `{ mintAuthority: undefined }` style deletions through `omit`.
 */
export function syntheticMintAccountResponse(
  options: {
    readonly info?: Record<string, unknown>;
    readonly omit?: readonly string[];
    readonly owner?: string;
    readonly slot?: number;
    readonly type?: string;
  } = {},
): Record<string, unknown> {
  const info: Record<string, unknown> = {
    decimals: 6,
    supply: "555000000000000",
    isInitialized: true,
    mintAuthority: null,
    freezeAuthority: null,
    ...options.info,
  };
  for (const key of options.omit ?? []) delete info[key];
  return {
    jsonrpc: "2.0",
    id: SYNTHETIC_MINT_REQUEST_ID,
    result: {
      context: { slot: options.slot ?? 462_100_000 },
      value: {
        owner: options.owner ?? SPL_TOKEN_PROGRAM_ID,
        executable: false,
        lamports: 1_461_600,
        data: { program: "spl-token", parsed: { type: options.type ?? "mint", info }, space: 82 },
      },
    },
  };
}

/** [SYNTHETIC] RugCheck report with the fields the accepted validator reads. */
export function syntheticRugCheckReport(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mint: SYNTHETIC_SECURITY_MINT,
    score: 150,
    score_normalised: 2,
    risks: [{ name: "SYNTHETIC informational risk", level: "info" }],
    topHolders: [
      { address: "SYNTHETIC_HOLDER_1", pct: 4 },
      { address: "SYNTHETIC_HOLDER_2", pct: 3 },
      { address: "SYNTHETIC_HOLDER_3", pct: 2 },
    ],
    totalHolders: 450,
    ...overrides,
  };
}

/**
 * [SYNTHETIC] Solana Tracker `/bundlers` response body with the fields the accepted parser reads.
 * Used where evidence must be dated to a synthetic clock; the sanitized historical capture is used
 * only for dated replay at its own retrieval time.
 */
export function syntheticSolanaTrackerBundlersPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    total: 12,
    balance: 1_000,
    percentage: 2.5,
    initialBalance: 800,
    initialPercentage: 2,
    wallets: [
      {
        wallet: SYNTHETIC_ACTIVE_AUTHORITY,
        initialBalance: 800,
        initialPercentage: 2,
        balance: 1_000,
        percentage: 2.5,
        bundleTime: 1_700_000_000_000,
      },
    ],
    ...overrides,
  };
}
