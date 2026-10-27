/**
 * Phase 12.94-D Milestone D.3.3: Pure Calculation Helper Regression Tests
 *
 * Covers:
 * 1. Correct decoding at byte offset 720 in AMM v4 layout.
 * 2. Genesis initialization with the unminted minimum.
 * 3. Ordinary redemption reducing both quantities equally.
 * 4. Direct burn reducing mint supply alone.
 * 5. Subsequent deposit dilution.
 * 6. Exact 90% boundary, immediately below, and immediately above.
 * 7. Zero denominator, inconsistent supply, and invalid inputs.
 * 8. Quantities above JavaScript's safe integer range (> 2^53 - 1).
 *
 * All test fixtures are clearly labeled deterministic fixtures.
 */

import { describe, expect, it } from "vitest";
import {
  calculateAmmV4LpInaccessibleClaims,
  parseRaydiumAmmV4Account,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_V4_OFFSETS,
} from "./RaydiumAmmParser.js";
import {
  createAuthoritativeRaydiumAmmV4Buffer,
  FIXTURE_POOL_ADDRESS,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";

describe("Raydium AMM v4 LP Accounting & Inaccessible Claims", () => {
  describe("1. Correct Binary Decoding at Byte Offset 720", () => {
    it("decodes lpReserve at offset 720 as a little-endian u64 BigInt", () => {
      const expectedLpReserve = 1_000_000_000_000n; // 1 trillion raw units
      const buffer = createAuthoritativeRaydiumAmmV4Buffer({
        lpReserve: expectedLpReserve,
      });

      expect(RAYDIUM_V4_OFFSETS.LP_RESERVE).toBe(720);
      expect(buffer.readBigUInt64LE(720)).toBe(expectedLpReserve);

      const parsed = parseRaydiumAmmV4Account(
        buffer,
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
      );

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.state.lpReserve).toBe(expectedLpReserve);
    });

    it("preserves un-set lpReserve as 0n in zeroed fixture buffers without inventing evidence", () => {
      const buffer = createAuthoritativeRaydiumAmmV4Buffer();
      const parsed = parseRaydiumAmmV4Account(
        buffer,
        FIXTURE_POOL_ADDRESS,
        RAYDIUM_AMM_V4_PROGRAM_ID,
      );

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.state.lpReserve).toBe(0n);
    });
  });

  describe("2. Lifecycle Scenarios: Initialization, Redemption, Burn, and Dilution", () => {
    it("Scenario 1: Genesis initialization with unminted minimum correctly fails the 90% threshold", () => {
      // Deterministic Genesis Fixture:
      // Base: 1,000,000 MEME (6 dec) = 10^12 raw units
      // Quote: 100 SOL (9 dec) = 10^11 raw units
      // Product: 10^23. Integer sqrt(10^23) = 316_227_766_016n.
      // Unminted minimum (6 dec LP): 10^6 = 1_000_000n.
      const protocolLp = 316_227_766_016n; // L
      const unmintedMinimum = 1_000_000n;
      const circulatingSupply = protocolLp - unmintedMinimum; // S = 316_226_766_016n

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.protocolLp).toBe(protocolLp);
      expect(result.circulatingSupply).toBe(circulatingSupply);
      expect(result.rawInaccessibleLp).toBe(unmintedMinimum);
      expect(result.rawDenominator).toBe(protocolLp);
      expect(result.meetsNinetyPercentThreshold).toBe(false);
      expect(result.displayInaccessiblePct).toBeCloseTo(0.0003, 3);
    });

    it("Scenario 2: Ordinary 90% redemption reduces both L and S equally and fails the 90% threshold", () => {
      // Deterministic Redemption Fixture:
      // Start: L = 1_000_000_000n, S = 999_000_000n
      // Deployer withdraws 900,000,000 LP tokens via AMM withdraw instruction
      // AMM withdraw reduces both L and S by 900,000,000n
      const redeemedAmount = 900_000_000n;
      const protocolLp = 1_000_000_000n - redeemedAmount; // 100_000_000n
      const circulatingSupply = 999_000_000n - redeemedAmount; // 99_000_000n

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.rawInaccessibleLp).toBe(1_000_000n); // Unchanged from genesis unminted minimum
      expect(result.rawDenominator).toBe(100_000_000n);
      expect(result.meetsNinetyPercentThreshold).toBe(false); // 1.0% < 90%
      expect(result.displayInaccessiblePct).toBe(1.0);
    });

    it("Scenario 3: Direct SPL burn reduces S alone while L remains constant, passing the 90% threshold", () => {
      // Deterministic Direct Burn Fixture:
      // Start: L = 1_000_000_000n, S = 999_000_000n
      // Holder directly burns 950,000,000 LP tokens via spl_token::burn outside AMM
      // S drops by 950,000,000n; L remains 1_000_000_000n
      const burnedAmount = 950_000_000n;
      const protocolLp = 1_000_000_000n; // L is fixed
      const circulatingSupply = 999_000_000n - burnedAmount; // S = 49_000_000n

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.rawInaccessibleLp).toBe(951_000_000n);
      expect(result.rawDenominator).toBe(1_000_000_000n);
      expect(result.meetsNinetyPercentThreshold).toBe(true); // 95.1% >= 90%
      expect(result.displayInaccessiblePct).toBe(95.1);
    });

    it("Scenario 4: Subsequent deposit dilutes the inaccessible share and fails threshold if below 90%", () => {
      // Deterministic Dilution Fixture:
      // Starting from Scenario 3: L = 1_000_000_000n, S = 49_000_000n (inaccessible: 951_000_000n)
      // New depositor deposits assets, receiving 500,000,000 newly minted LP tokens
      // Both L and S increase by 500,000,000n
      const depositMinted = 500_000_000n;
      const protocolLp = 1_000_000_000n + depositMinted; // 1_500_000_000n
      const circulatingSupply = 49_000_000n + depositMinted; // 549_000_000n

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.rawInaccessibleLp).toBe(951_000_000n);
      expect(result.rawDenominator).toBe(1_500_000_000n);
      expect(result.meetsNinetyPercentThreshold).toBe(false); // 951M / 1500M = 63.4% < 90%
      expect(result.displayInaccessiblePct).toBe(63.4);
    });
  });

  describe("3. Threshold Boundaries: Exact 90%, Immediately Below, and Immediately Above", () => {
    it("exact 90.0% boundary passes via integer cross-multiplication", () => {
      const protocolLp = 1_000_000_000n;
      const circulatingSupply = 100_000_000n; // L - S = 900_000_000n = 90%

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.rawInaccessibleLp).toBe(900_000_000n);
      expect(result.meetsNinetyPercentThreshold).toBe(true);
      expect(result.displayInaccessiblePct).toBe(90.0);
    });

    it("immediately below 90.0% (89.9999999%) strictly fails", () => {
      const protocolLp = 1_000_000_000n;
      const circulatingSupply = 100_000_001n; // L - S = 899_999_999n < 90%

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.meetsNinetyPercentThreshold).toBe(false);
      expect(result.displayInaccessiblePct).toBeCloseTo(89.999, 2);
    });

    it("immediately above 90.0% (90.0000001%) strictly passes", () => {
      const protocolLp = 1_000_000_000n;
      const circulatingSupply = 99_999_999n; // L - S = 900_000_001n > 90%

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.meetsNinetyPercentThreshold).toBe(true);
      expect(result.displayInaccessiblePct).toBeCloseTo(90.0, 2);
    });
  });

  describe("4. Edge Cases: Zero Denominator, Inconsistent Supply, Range Checks", () => {
    it("rejects zero protocol LP denominator (L = 0)", () => {
      const result = calculateAmmV4LpInaccessibleClaims(0n, 0n);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("ZERO_PROTOCOL_LP");
    });

    it("rejects inconsistent supply when circulating supply exceeds protocol LP (S > L)", () => {
      const result = calculateAmmV4LpInaccessibleClaims(1_000_000n, 1_200_000n);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.category).toBe("SUPPLY_EXCEEDS_PROTOCOL_LP");
    });

    it("rejects negative quantities or values exceeding unsigned 64-bit bounds", () => {
      const negativeResult = calculateAmmV4LpInaccessibleClaims(-1n, 100n);
      expect(negativeResult.ok).toBe(false);
      if (negativeResult.ok) return;
      expect(negativeResult.category).toBe("INVALID_U64_RANGE");

      const overflowVal = 0x1_0000_0000_0000_0000n; // 2^64
      const overflowResult = calculateAmmV4LpInaccessibleClaims(overflowVal, 100n);
      expect(overflowResult.ok).toBe(false);
      if (overflowResult.ok) return;
      expect(overflowResult.category).toBe("INVALID_U64_RANGE");
    });
  });

  describe("5. Safe Integer Overflow: Quantities Above Number.MAX_SAFE_INTEGER (> 2^53 - 1)", () => {
    it("preserves exact integer math and correct threshold for quantities exceeding JavaScript safe integer limit", () => {
      // 10^19 is well above Number.MAX_SAFE_INTEGER (9,007,199,254,740,991 ~ 9 * 10^15)
      // but within unsigned 64-bit integer limit (1.84 * 10^19)
      const protocolLp = 10_000_000_000_000_000_000n; // 10^19
      const circulatingSupply = 900_000_000_000_000_000n; // 9 * 10^17 (9% supply -> 91% locked)

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.rawInaccessibleLp).toBe(9_100_000_000_000_000_000n);
      expect(result.rawDenominator).toBe(protocolLp);
      expect(result.meetsNinetyPercentThreshold).toBe(true);
      expect(result.displayInaccessiblePct).toBe(91.0);
    });

    it("evaluates boundary correctly at large magnitudes above 2^53 - 1", () => {
      const protocolLp = 10_000_000_000_000_000_000n;
      const circulatingSupply = 1_000_000_000_000_000_001n; // Just below 90%

      const result = calculateAmmV4LpInaccessibleClaims(protocolLp, circulatingSupply);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.meetsNinetyPercentThreshold).toBe(false); // 89.9999999999999999% < 90%
    });
  });
});
