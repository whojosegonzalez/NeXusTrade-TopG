/**
 * Phase 12.94-D Milestone D.3.3: Raydium CPMM Pool-State Adapter Unit Tests
 *
 * Comprehensive synthetic offline tests verifying the pure Raydium CPMM pool-state adapter:
 * - Both orientations (TOKEN_0_BASE_WSOL_QUOTE, TOKEN_1_BASE_WSOL_QUOTE)
 * - Identity validations, anti-manufacturing, PDA allowance, candidate !== WSOL
 * - Canonical byte ordering (token_0_mint < token_1_mint)
 * - Protocol fields: creator_fee_on (0..2), enable_creator_fee (0..1), status bitmask (0..7)
 * - Nonzero padding acceptance (no zero-padding requirement)
 * - Strict canonical SPL Token enforcement (Token-2022 rejection)
 * - Canonical authority bump 253 (rejecting 254)
 * - Strict slot provenance and discrepancy refusals
 * - Exact integer reserve accounting, insolvency, and zero reserves
 * - Integers above 2^53 through u64 maximum (18446744073709551615n)
 * - Independent literal layout vector (raw byte offsets, independent of fixtures)
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_CPMM_AUTH_BUMP,
  RAYDIUM_CPMM_LAYOUT_LENGTH,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
  adaptRaydiumCpmmPoolState,
  type RaydiumCpmmPoolStateInput,
} from "./RaydiumCpmmPoolStateAdapter.js";
import {
  FIXTURE_CPMM_AMM_CONFIG,
  FIXTURE_CPMM_CREATOR,
  FIXTURE_CPMM_LP_MINT,
  FIXTURE_CPMM_OBSERVATION,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
  RAYDIUM_CPMM_AUTHORITY,
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
} from "../research/pilot/fixtures/AuthoritativeCpmmFixtures.js";
import { decodeBase58To32Bytes } from "../research/pilot/fixtures/AuthoritativeRaydiumFixtures.js";
import { TOKEN_2022_PROGRAM_ID } from "../research/pilot/RaydiumCpmmParser.js";

// Canonical mints with guaranteed byte ordering against WSOL:
// WSOL bytes hex: 069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001
// CANDIDATE_LESS (0x01 * 32) < WSOL:
const CANDIDATE_LESS = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
// WSOL < CANDIDATE_GREATER (0xff * 32):
const CANDIDATE_GREATER = "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG";

// Valid PDA address (PDA for vault authority, not on ed25519 curve)
const VALID_PDA_ADDRESS = RAYDIUM_CPMM_AUTHORITY;

function makeValidInputOrientationA(
  overrides: {
    poolBuffer?: Buffer;
    poolSlot?: number;
    vault0Slot?: number;
    vault1Slot?: number;
    vault0Raw?: bigint;
    vault1Raw?: bigint;
    candidateMint?: string;
  } = {},
): RaydiumCpmmPoolStateInput {
  const candidateMint = overrides.candidateMint ?? CANDIDATE_LESS;
  const poolBuffer =
    overrides.poolBuffer ??
    createAuthoritativeRaydiumCpmmBuffer({
      authBump: CANONICAL_CPMM_AUTH_BUMP,
      token0MintBase58: candidateMint,
      token1MintBase58: WSOL_MINT,
      mint0Decimals: 6,
      mint1Decimals: 9,
      status: 0,
      creatorFeeOn: 0,
      enableCreatorFee: false,
    });

  const slot = overrides.poolSlot ?? 300_000_000;

  const vault0Data = createAuthoritativeCpmmSplVaultBuffer({
    mintBase58: candidateMint,
    ownerBase58: RAYDIUM_CPMM_AUTHORITY,
    rawAmount: overrides.vault0Raw ?? 10_000_000_000n, // 10,000 base tokens
    state: 1,
  });

  const vault1Data = createAuthoritativeCpmmSplVaultBuffer({
    mintBase58: WSOL_MINT,
    ownerBase58: RAYDIUM_CPMM_AUTHORITY,
    rawAmount: overrides.vault1Raw ?? 50_000_000_000n, // 50 SOL
    state: 1,
  });

  return {
    target: {
      poolAddress: FIXTURE_CPMM_POOL_ADDRESS,
      candidateMint,
    },
    poolAccount: {
      address: FIXTURE_CPMM_POOL_ADDRESS,
      data: poolBuffer,
      ownerProgramId: RAYDIUM_CPMM_PROGRAM_ID,
      slot: overrides.poolSlot ?? slot,
    },
    vault0Account: {
      address: FIXTURE_CPMM_TOKEN_0_VAULT,
      data: vault0Data,
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: overrides.vault0Slot ?? slot,
    },
    vault1Account: {
      address: FIXTURE_CPMM_TOKEN_1_VAULT,
      data: vault1Data,
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: overrides.vault1Slot ?? slot,
    },
  };
}

function makeValidInputOrientationB(
  overrides: {
    poolBuffer?: Buffer;
    poolSlot?: number;
    vault0Slot?: number;
    vault1Slot?: number;
    vault0Raw?: bigint;
    vault1Raw?: bigint;
  } = {},
): RaydiumCpmmPoolStateInput {
  const candidateMint = CANDIDATE_GREATER;
  const poolBuffer =
    overrides.poolBuffer ??
    createAuthoritativeRaydiumCpmmBuffer({
      authBump: CANONICAL_CPMM_AUTH_BUMP,
      token0MintBase58: WSOL_MINT,
      token1MintBase58: candidateMint,
      mint0Decimals: 9,
      mint1Decimals: 6,
      status: 0,
      creatorFeeOn: 0,
      enableCreatorFee: false,
    });

  const slot = overrides.poolSlot ?? 300_000_000;

  const vault0Data = createAuthoritativeCpmmSplVaultBuffer({
    mintBase58: WSOL_MINT,
    ownerBase58: RAYDIUM_CPMM_AUTHORITY,
    rawAmount: overrides.vault0Raw ?? 50_000_000_000n, // 50 SOL (quote)
    state: 1,
  });

  const vault1Data = createAuthoritativeCpmmSplVaultBuffer({
    mintBase58: candidateMint,
    ownerBase58: RAYDIUM_CPMM_AUTHORITY,
    rawAmount: overrides.vault1Raw ?? 10_000_000_000n, // 10,000 base tokens
    state: 1,
  });

  return {
    target: {
      poolAddress: FIXTURE_CPMM_POOL_ADDRESS,
      candidateMint,
    },
    poolAccount: {
      address: FIXTURE_CPMM_POOL_ADDRESS,
      data: poolBuffer,
      ownerProgramId: RAYDIUM_CPMM_PROGRAM_ID,
      slot: overrides.poolSlot ?? slot,
    },
    vault0Account: {
      address: FIXTURE_CPMM_TOKEN_0_VAULT,
      data: vault0Data,
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: overrides.vault0Slot ?? slot,
    },
    vault1Account: {
      address: FIXTURE_CPMM_TOKEN_1_VAULT,
      data: vault1Data,
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: overrides.vault1Slot ?? slot,
    },
  };
}

describe("RaydiumCpmmPoolStateAdapter", () => {
  describe("Group 1: Canonical Orientations & Success Invariants", () => {
    it("successfully adapts Orientation A (token_0 candidate, token_1 WSOL)", () => {
      const input = makeValidInputOrientationA();
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.orientation).toBe("TOKEN_0_BASE_WSOL_QUOTE");
      expect(res.candidateMint).toBe(CANDIDATE_LESS);
      expect(res.wsolMint).toBe(WSOL_MINT);
      expect(res.baseDecimals).toBe(6);
      expect(res.quoteDecimals).toBe(9);
      expect(res.baseVaultAddress).toBe(FIXTURE_CPMM_TOKEN_0_VAULT);
      expect(res.quoteVaultAddress).toBe(FIXTURE_CPMM_TOKEN_1_VAULT);
      expect(res.baseVaultRaw).toBe(10_000_000_000n);
      expect(res.quoteVaultRaw).toBe(50_000_000_000n);
      expect(res.baseEffectiveReserveRaw).toBe(10_000_000_000n);
      expect(res.quoteEffectiveReserveRaw).toBe(50_000_000_000n);
      expect(res.baseEffectiveReserveApproxDecimal).toBeCloseTo(10_000, 2);
      expect(res.quoteEffectiveReserveApproxDecimal).toBeCloseTo(50, 2);
      expect(res.spotPriceSolApprox).toBeCloseTo(0.005, 5); // 50 SOL / 10,000 base
      expect(res.poolStatus).toBe(0);
      expect(res.swapEnabledByStatus).toBe(true);
      expect(res.verification.ownerVerified).toBe(true);
      expect(res.verification.vaultAuthoritiesVerified).toBe(true);
      expect(res.verification.tokenProgramsVerified).toBe(true);
      expect(res.verification.authBumpVerified).toBe(true);
      expect(res.verification.slotProvenance.consistentSlot).toBe(300_000_000);
    });

    it("successfully adapts Orientation B (token_0 WSOL, token_1 candidate)", () => {
      const input = makeValidInputOrientationB();
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.orientation).toBe("TOKEN_1_BASE_WSOL_QUOTE");
      expect(res.candidateMint).toBe(CANDIDATE_GREATER);
      expect(res.wsolMint).toBe(WSOL_MINT);
      expect(res.baseDecimals).toBe(6);
      expect(res.quoteDecimals).toBe(9);
      expect(res.baseVaultAddress).toBe(FIXTURE_CPMM_TOKEN_1_VAULT);
      expect(res.quoteVaultAddress).toBe(FIXTURE_CPMM_TOKEN_0_VAULT);
      expect(res.baseVaultRaw).toBe(10_000_000_000n);
      expect(res.quoteVaultRaw).toBe(50_000_000_000n);
      expect(res.baseEffectiveReserveRaw).toBe(10_000_000_000n);
      expect(res.quoteEffectiveReserveRaw).toBe(50_000_000_000n);
      expect(res.baseEffectiveReserveApproxDecimal).toBeCloseTo(10_000, 2);
      expect(res.quoteEffectiveReserveApproxDecimal).toBeCloseTo(50, 2);
      expect(res.spotPriceSolApprox).toBeCloseTo(0.005, 5);
      expect(res.poolStatus).toBe(0);
      expect(res.swapEnabledByStatus).toBe(true);
    });

    it("accepts nonzero padding without inventing a zero-padding requirement", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        mint0Decimals: 6,
        mint1Decimals: 9,
      });

      // Fill padding1 (391..397) and trailing padding (413..637) with non-zero bytes
      poolBuffer.fill(0xaa, 391, 397);
      poolBuffer.fill(0x55, 413, 637);

      const input = makeValidInputOrientationA({ poolBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(true);
    });

    it("handles all known status bitmask values 0..7 correctly", () => {
      for (let s = 0; s <= 7; s++) {
        const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
          authBump: CANONICAL_CPMM_AUTH_BUMP,
          token0MintBase58: CANDIDATE_LESS,
          token1MintBase58: WSOL_MINT,
          status: s,
        });

        const input = makeValidInputOrientationA({ poolBuffer });
        const res = adaptRaydiumCpmmPoolState(input);

        expect(res.ok).toBe(true);
        if (!res.ok) continue;

        expect(res.poolStatus).toBe(s);
        // Statuses 0..3 allow swap; 4..7 disable swap
        if (s <= 3) {
          expect(res.swapEnabledByStatus).toBe(true);
        } else {
          expect(res.swapEnabledByStatus).toBe(false);
        }
      }
    });

    it("accepts creator_fee_on values 0, 1, and 2", () => {
      for (const feeOn of [0, 1, 2]) {
        const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
          authBump: CANONICAL_CPMM_AUTH_BUMP,
          token0MintBase58: CANDIDATE_LESS,
          token1MintBase58: WSOL_MINT,
          creatorFeeOn: feeOn,
          enableCreatorFee: true,
        });

        const input = makeValidInputOrientationA({ poolBuffer });
        const res = adaptRaydiumCpmmPoolState(input);

        expect(res.ok).toBe(true);
      }
    });

    it("accepts enable_creator_fee values 0 (false) and 1 (true)", () => {
      for (const enable of [false, true]) {
        const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
          authBump: CANONICAL_CPMM_AUTH_BUMP,
          token0MintBase58: CANDIDATE_LESS,
          token1MintBase58: WSOL_MINT,
          enableCreatorFee: enable,
        });

        const input = makeValidInputOrientationA({ poolBuffer });
        const res = adaptRaydiumCpmmPoolState(input);

        expect(res.ok).toBe(true);
      }
    });

    it("handles integers above 2^53 through u64 maximum (18446744073709551615n)", () => {
      const u64Max = 18446744073709551615n;
      const largeLp = 18_000_000_000_000_000_000n;
      const largeActivation = 18_446_744_073_709_551_000n;

      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        lpSupply: largeLp,
        openTime: largeActivation,
      });

      const input = makeValidInputOrientationA({
        poolBuffer,
        vault0Raw: u64Max,
        vault1Raw: u64Max,
      });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.baseVaultRaw).toBe(u64Max);
      expect(res.quoteVaultRaw).toBe(u64Max);
      expect(res.lpSupply).toBe(largeLp);
      expect(res.swapActivationTimeSec).toBe(largeActivation);
    });
  });

  describe("Group 2: Address Validation, Identity & Anti-Manufacturing", () => {
    it("refuses malformed base58 string with ADDRESS_MALFORMED", () => {
      const input = makeValidInputOrientationA();
      const malformedInput = {
        ...input,
        target: { ...input.target, poolAddress: "invalid_not_base58_!!!" },
      };

      const res = adaptRaydiumCpmmPoolState(malformedInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("ADDRESS_MALFORMED");
    });

    it("allows PDA addresses that do not lie on the ed25519 curve", () => {
      // VALID_PDA_ADDRESS is a derived PDA; ensure it is accepted as pool/target address
      const input = makeValidInputOrientationA();
      const pdaInput: RaydiumCpmmPoolStateInput = {
        ...input,
        target: { ...input.target, poolAddress: VALID_PDA_ADDRESS },
        poolAccount: { ...input.poolAccount, address: VALID_PDA_ADDRESS },
      };
      const res = adaptRaydiumCpmmPoolState(pdaInput);
      expect(res.ok).toBe(true);
    });

    it("refuses target.candidateMint === WSOL with CANDIDATE_MINT_IS_WSOL", () => {
      const input = makeValidInputOrientationA();
      const wsolTargetInput = {
        ...input,
        target: { ...input.target, candidateMint: WSOL_MINT },
      };

      const res = adaptRaydiumCpmmPoolState(wsolTargetInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("CANDIDATE_MINT_IS_WSOL");
    });

    it("refuses poolAccount.address mismatch with POOL_ADDRESS_MISMATCH", () => {
      const input = makeValidInputOrientationA();
      const mismatchedInput = {
        ...input,
        poolAccount: {
          ...input.poolAccount,
          address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        },
      };

      const res = adaptRaydiumCpmmPoolState(mismatchedInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("POOL_ADDRESS_MISMATCH");
    });

    it("refuses candidate mint mismatch with CANDIDATE_MINT_MISMATCH", () => {
      const input = makeValidInputOrientationA();
      const mismatchedCandidateInput = {
        ...input,
        target: {
          ...input.target,
          candidateMint: CANDIDATE_GREATER, // pool contains CANDIDATE_LESS
        },
      };

      const res = adaptRaydiumCpmmPoolState(mismatchedCandidateInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("CANDIDATE_MINT_MISMATCH");
    });

    it("refuses non-WSOL pool with NON_WSOL_PAIR", () => {
      const nonWsolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: CANDIDATE_GREATER, // neither is WSOL
      });

      const input = makeValidInputOrientationA({ poolBuffer: nonWsolBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("NON_WSOL_PAIR");
    });

    it("refuses identical mints with IDENTICAL_MINTS", () => {
      const identicalMintsBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: WSOL_MINT,
        token1MintBase58: WSOL_MINT,
      });

      const input = makeValidInputOrientationA({ poolBuffer: identicalMintsBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("IDENTICAL_MINTS");
    });

    it("refuses non-canonical byte ordering token_0_mint > token_1_mint with CANONICAL_MINT_ORDER_VIOLATED", () => {
      // CANDIDATE_GREATER > WSOL, but placing it as token 0 violates canonical ordering
      const invertedOrderBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_GREATER,
        token1MintBase58: WSOL_MINT,
      });

      const input = makeValidInputOrientationA({ poolBuffer: invertedOrderBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("CANONICAL_MINT_ORDER_VIOLATED");
    });

    it("refuses contradictory identical vaults with CONTRADICTORY_VAULTS", () => {
      const contradictoryVaultsBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        token0VaultBase58: FIXTURE_CPMM_TOKEN_0_VAULT,
        token1VaultBase58: FIXTURE_CPMM_TOKEN_0_VAULT, // identical vault
      });

      const input = makeValidInputOrientationA({ poolBuffer: contradictoryVaultsBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("CONTRADICTORY_VAULTS");
    });
  });

  describe("Group 3: Protocol Fields & Encoding Refusals", () => {
    it("refuses truncated buffer with POOL_BUFFER_INVALID_LENGTH", () => {
      const input = makeValidInputOrientationA();
      const truncatedInput = {
        ...input,
        poolAccount: {
          ...input.poolAccount,
          data: input.poolAccount.data.subarray(0, 600),
        },
      };

      const res = adaptRaydiumCpmmPoolState(truncatedInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("POOL_BUFFER_INVALID_LENGTH");
    });

    it("refuses oversized buffer with POOL_BUFFER_INVALID_LENGTH", () => {
      const input = makeValidInputOrientationA();
      const oversizedBuffer = Buffer.concat([
        Buffer.from(input.poolAccount.data),
        Buffer.alloc(10),
      ]);
      const oversizedInput = {
        ...input,
        poolAccount: {
          ...input.poolAccount,
          data: oversizedBuffer,
        },
      };

      const res = adaptRaydiumCpmmPoolState(oversizedInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("POOL_BUFFER_INVALID_LENGTH");
    });

    it("refuses invalid Anchor discriminator with POOL_DISCRIMINATOR_MISMATCH", () => {
      const corruptDiscriminatorBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        discriminator: [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07],
      });

      const input = makeValidInputOrientationA({ poolBuffer: corruptDiscriminatorBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("POOL_DISCRIMINATOR_MISMATCH");
    });

    it("refuses unauthorized pool owner program with POOL_OWNER_UNAUTHORIZED", () => {
      const input = makeValidInputOrientationA();
      const unauthorizedOwnerInput = {
        ...input,
        poolAccount: {
          ...input.poolAccount,
          ownerProgramId: SPL_TOKEN_PROGRAM_ID, // wrong program
        },
      };

      const res = adaptRaydiumCpmmPoolState(unauthorizedOwnerInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("POOL_OWNER_UNAUTHORIZED");
    });

    it("refuses auth_bump !== 253 with AUTH_BUMP_INVALID", () => {
      const wrongBumpBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: 254, // wrong bump
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
      });

      const input = makeValidInputOrientationA({ poolBuffer: wrongBumpBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("AUTH_BUMP_INVALID");
    });

    it("refuses status > 7 with INVALID_STATUS", () => {
      const unknownStatusBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        status: 8,
      });

      const input = makeValidInputOrientationA({ poolBuffer: unknownStatusBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("INVALID_STATUS");
    });

    it("refuses creator_fee_on > 2 with MALFORMED_CREATOR_FEE_FLAG", () => {
      const corruptFeeOnBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        creatorFeeOn: 3, // invalid
      });

      const input = makeValidInputOrientationA({ poolBuffer: corruptFeeOnBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("MALFORMED_CREATOR_FEE_FLAG");
    });

    it("refuses enable_creator_fee > 1 with MALFORMED_CREATOR_FEE_FLAG", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
      });
      poolBuffer.writeUInt8(2, 390); // rawEnableCreatorFee = 2 (invalid)

      const input = makeValidInputOrientationA({ poolBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("MALFORMED_CREATOR_FEE_FLAG");
    });

    it("refuses Token-2022 in pool state with UNSUPPORTED_TOKEN_PROGRAM", () => {
      const token2022Buffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        token0ProgramBase58: TOKEN_2022_PROGRAM_ID,
      });

      const input = makeValidInputOrientationA({ poolBuffer: token2022Buffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("UNSUPPORTED_TOKEN_PROGRAM");
    });

    it("refuses decimals > 18 with INVALID_DECIMALS", () => {
      const invalidDecimalsBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        mint0Decimals: 19,
      });

      const input = makeValidInputOrientationA({ poolBuffer: invalidDecimalsBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("INVALID_DECIMALS");
    });

    it("refuses WSOL decimals !== 9 with WSOL_DECIMALS_INVALID", () => {
      const invalidWsolDecimalsBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        mint0Decimals: 6,
        mint1Decimals: 6, // WSOL decimals must be 9
      });

      const input = makeValidInputOrientationA({ poolBuffer: invalidWsolDecimalsBuffer });
      const res = adaptRaydiumCpmmPoolState(input);

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("WSOL_DECIMALS_INVALID");
    });
  });

  describe("Group 4: Vault Account Refusals", () => {
    it("refuses vault address mismatch with VAULT_ADDRESS_MISMATCH", () => {
      const input = makeValidInputOrientationA();
      const mismatchedVaultInput = {
        ...input,
        vault0Account: {
          ...input.vault0Account,
          address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
        },
      };

      const res = adaptRaydiumCpmmPoolState(mismatchedVaultInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("VAULT_ADDRESS_MISMATCH");
    });

    it("refuses vault buffer length !== 165 with VAULT_BUFFER_INVALID_LENGTH", () => {
      const input = makeValidInputOrientationA();
      const corruptVaultInput = {
        ...input,
        vault0Account: {
          ...input.vault0Account,
          data: input.vault0Account.data.subarray(0, 100),
        },
      };

      const res = adaptRaydiumCpmmPoolState(corruptVaultInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("VAULT_BUFFER_INVALID_LENGTH");
    });

    it("refuses vault owned by Token-2022 program with VAULT_OWNER_UNAUTHORIZED", () => {
      const input = makeValidInputOrientationA();
      const token2022VaultInput = {
        ...input,
        vault0Account: {
          ...input.vault0Account,
          ownerProgramId: TOKEN_2022_PROGRAM_ID,
        },
      };

      const res = adaptRaydiumCpmmPoolState(token2022VaultInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("VAULT_OWNER_UNAUTHORIZED");
    });

    it("refuses vault mint mismatch with VAULT_MINT_MISMATCH", () => {
      const wrongMintVaultData = createAuthoritativeCpmmSplVaultBuffer({
        mintBase58: WSOL_MINT, // vault0 expected CANDIDATE_LESS
        ownerBase58: RAYDIUM_CPMM_AUTHORITY,
        rawAmount: 10_000_000_000n,
        state: 1,
      });

      const input = makeValidInputOrientationA();
      const mismatchedMintVaultInput = {
        ...input,
        vault0Account: {
          ...input.vault0Account,
          data: wrongMintVaultData,
        },
      };

      const res = adaptRaydiumCpmmPoolState(mismatchedMintVaultInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("VAULT_MINT_MISMATCH");
    });

    it("refuses vault authority mismatch with VAULT_AUTHORITY_UNAUTHORIZED", () => {
      const wrongAuthVaultData = createAuthoritativeCpmmSplVaultBuffer({
        mintBase58: CANDIDATE_LESS,
        ownerBase58: FIXTURE_CPMM_CREATOR, // not RAYDIUM_CPMM_AUTHORITY
        rawAmount: 10_000_000_000n,
        state: 1,
      });

      const input = makeValidInputOrientationA();
      const wrongAuthInput = {
        ...input,
        vault0Account: {
          ...input.vault0Account,
          data: wrongAuthVaultData,
        },
      };

      const res = adaptRaydiumCpmmPoolState(wrongAuthInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("VAULT_AUTHORITY_UNAUTHORIZED");
    });

    it("refuses uninitialized or frozen vault with VAULT_STATE_NOT_INITIALIZED", () => {
      for (const st of [0, 2]) {
        const invalidStateVaultData = createAuthoritativeCpmmSplVaultBuffer({
          mintBase58: CANDIDATE_LESS,
          ownerBase58: RAYDIUM_CPMM_AUTHORITY,
          rawAmount: 10_000_000_000n,
          state: st,
        });

        const input = makeValidInputOrientationA();
        const invalidStateInput = {
          ...input,
          vault0Account: {
            ...input.vault0Account,
            data: invalidStateVaultData,
          },
        };

        const res = adaptRaydiumCpmmPoolState(invalidStateInput);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.refusalCode).toBe("VAULT_STATE_NOT_INITIALIZED");
      }
    });
  });

  describe("Group 5: Slot Provenance & Coherence", () => {
    it("refuses missing/undefined slot with SLOT_PROVENANCE_MISSING_OR_INVALID", () => {
      const input = makeValidInputOrientationA();
      const missingSlotInput = {
        ...input,
        poolAccount: {
          ...input.poolAccount,
          slot: undefined as unknown as number,
        },
      };

      const res = adaptRaydiumCpmmPoolState(missingSlotInput);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("SLOT_PROVENANCE_MISSING_OR_INVALID");
    });

    it("refuses negative, non-integer, or NaN slots with SLOT_PROVENANCE_MISSING_OR_INVALID", () => {
      for (const badSlot of [-1, 123.45, Number.NaN]) {
        const input = makeValidInputOrientationA();
        const badSlotInput = {
          ...input,
          vault0Account: {
            ...input.vault0Account,
            slot: badSlot,
          },
        };

        const res = adaptRaydiumCpmmPoolState(badSlotInput);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.refusalCode).toBe("SLOT_PROVENANCE_MISSING_OR_INVALID");
      }
    });

    it("refuses slot discrepancy between vaults with SLOT_DISCREPANCY", () => {
      const input = makeValidInputOrientationA({
        poolSlot: 300_000_000,
        vault0Slot: 300_000_000,
        vault1Slot: 300_000_001, // mismatch
      });

      const res = adaptRaydiumCpmmPoolState(input);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("SLOT_DISCREPANCY");
    });

    it("refuses slot discrepancy between pool and vaults with SLOT_DISCREPANCY", () => {
      const input = makeValidInputOrientationA({
        poolSlot: 300_000_005, // mismatch
        vault0Slot: 300_000_000,
        vault1Slot: 300_000_000,
      });

      const res = adaptRaydiumCpmmPoolState(input);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("SLOT_DISCREPANCY");
    });
  });

  describe("Group 6: Reserve Accounting & Insolvency", () => {
    it("refuses insolvent reserves when vault balance is less than total fees", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        protocolFeesToken0: 5_000_000_000n,
        fundFeesToken0: 5_000_000_000n,
        creatorFeesToken0: 1_000_000_000n, // total fees = 11_000_000_000n
      });

      const input = makeValidInputOrientationA({
        poolBuffer,
        vault0Raw: 10_000_000_000n, // vault (10B) < fees (11B)
      });

      const res = adaptRaydiumCpmmPoolState(input);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("INSOLVENT_RESERVES");
    });

    it("refuses zero effective reserve when vault balance exactly equals total fees", () => {
      const poolBuffer = createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE_LESS,
        token1MintBase58: WSOL_MINT,
        protocolFeesToken0: 5_000_000_000n,
        fundFeesToken0: 5_000_000_000n, // total fees = 10_000_000_000n
      });

      const input = makeValidInputOrientationA({
        poolBuffer,
        vault0Raw: 10_000_000_000n, // effective reserve = 0
      });

      const res = adaptRaydiumCpmmPoolState(input);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.refusalCode).toBe("ZERO_EFFECTIVE_RESERVES");
    });
  });

  describe("Group 7: Independent Literal Layout Vector", () => {
    it("successfully adapts an independently constructed buffer with literal byte offsets", () => {
      // Independent literal buffer (637 bytes)
      const buf = Buffer.alloc(RAYDIUM_CPMM_LAYOUT_LENGTH);

      // Discriminator (bytes 0..8): sha256("account:PoolState")[0..8]
      Buffer.from([0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46]).copy(buf, 0);

      const write32 = (offset: number, b58: string) => {
        buf.set(decodeBase58To32Bytes(b58), offset);
      };

      write32(8, FIXTURE_CPMM_AMM_CONFIG);
      write32(40, FIXTURE_CPMM_CREATOR);
      write32(72, FIXTURE_CPMM_TOKEN_0_VAULT);
      write32(104, FIXTURE_CPMM_TOKEN_1_VAULT);
      write32(136, FIXTURE_CPMM_LP_MINT);
      write32(168, CANDIDATE_LESS);
      write32(200, WSOL_MINT);
      write32(232, SPL_TOKEN_PROGRAM_ID);
      write32(264, SPL_TOKEN_PROGRAM_ID);
      write32(296, FIXTURE_CPMM_OBSERVATION);

      buf.writeUInt8(253, 328); // authBump = 253
      buf.writeUInt8(0, 329); // status = 0
      buf.writeUInt8(6, 330); // lpMintDecimals
      buf.writeUInt8(6, 331); // mint0Decimals
      buf.writeUInt8(9, 332); // mint1Decimals

      buf.writeBigUInt64LE(500_000_000n, 333); // lpSupply
      buf.writeBigUInt64LE(100_000n, 341); // protocolFeesToken0
      buf.writeBigUInt64LE(200_000n, 349); // protocolFeesToken1
      buf.writeBigUInt64LE(300_000n, 357); // fundFeesToken0
      buf.writeBigUInt64LE(400_000n, 365); // fundFeesToken1
      buf.writeBigUInt64LE(1_700_000_000n, 373); // openTime
      buf.writeBigUInt64LE(600n, 381); // recentEpoch

      buf.writeUInt8(0, 389); // creatorFeeOn
      buf.writeUInt8(1, 390); // enableCreatorFee
      // Non-zero padding bytes to verify resilience
      buf.fill(0xee, 391, 397);
      buf.writeBigUInt64LE(50_000n, 397); // creatorFeesToken0
      buf.writeBigUInt64LE(60_000n, 405); // creatorFeesToken1
      buf.fill(0xdd, 413, 637);

      const input = makeValidInputOrientationA({
        poolBuffer: buf,
        vault0Raw: 1_000_000_000n,
        vault1Raw: 2_000_000_000n,
      });

      const res = adaptRaydiumCpmmPoolState(input);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.baseVaultAddress).toBe(FIXTURE_CPMM_TOKEN_0_VAULT);
      expect(res.quoteVaultAddress).toBe(FIXTURE_CPMM_TOKEN_1_VAULT);
      expect(res.baseTotalFeesRaw).toBe(450_000n); // 100k + 300k + 50k
      expect(res.quoteTotalFeesRaw).toBe(660_000n); // 200k + 400k + 60k
      expect(res.baseEffectiveReserveRaw).toBe(1_000_000_000n - 450_000n);
      expect(res.quoteEffectiveReserveRaw).toBe(2_000_000_000n - 660_000n);
      expect(res.swapActivationTimeSec).toBe(1_700_000_000n);
      expect(res.verification.authBumpVerified).toBe(true);
    });
  });
});
