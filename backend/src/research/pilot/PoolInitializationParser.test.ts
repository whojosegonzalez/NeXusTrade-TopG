/**
 * Phase 12.94-D Milestone D.2.9-A: Pool Initialization Parser Unit & Negative Tests
 *
 * Verifies protocol-neutral detection and classification of pool initialization instructions:
 * 1. Raydium AMM v4 initialize2 (tag 1) in legacy and v0 (ALT) transactions.
 * 2. Raydium CPMM initialize Anchor instruction with discriminator and openTime.
 * 3. Fail-closed controls: on-chain tx failure, missing accounts, out-of-bounds ALT indices.
 * 4. Explicit unsupported-protocol classification (Orca, CLMM, DLMM, Pump.fun, Moonshot).
 * 5. Strict temporal separation: blockTimeSec, firstSeenTimestampMs, poolOpenTimeSec.
 */

import { describe, expect, it } from "vitest";
import {
  createAmmV4InitTransactionFixture,
  createCpmmInitTransactionFixture,
  createUnsupportedProtocolTransactionFixture,
} from "./fixtures/AuthoritativeEventFixtures.js";
import {
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_1_MINT,
} from "./fixtures/AuthoritativeCpmmFixtures.js";
import {
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";
import { identifyPoolInitializationInstruction } from "./PoolInitializationParser.js";

describe("Milestone D.2.9-A: Pool Initialization Parser Tests", () => {
  // --------------------------------------------------------------------------
  // 1. Raydium AMM v4 Recognition (D29-A2)
  // --------------------------------------------------------------------------
  describe("1. Raydium AMM v4 Recognition", () => {
    it("identifies genuine AMM v4 initialize2 instruction from legacy transaction", () => {
      const tx = createAmmV4InitTransactionFixture({ isVersion0: false });
      const hostNow = 1792375105000;
      const result = identifyPoolInitializationInstruction(tx, hostNow);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.event.protocol).toBe("RAYDIUM_AMM_V4");
      expect(result.event.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(result.event.token0Mint).toBe(FIXTURE_MEME_MINT);
      expect(result.event.token1Mint).toBe(FIXTURE_WSOL_MINT);
      expect(result.event.slot).toBe(tx.slot);
      expect(result.event.blockTimeSec).toBe(tx.blockTime);
      expect(result.event.firstSeenTimestampMs).toBe(hostNow);
      expect(result.event.poolOpenTimeSec).toBe(tx.blockTime);
      expect(result.event.eventId).toBe(`${tx.signature}:0`);
    });

    it("identifies AMM v4 initialize2 instruction in Version 0 transaction with ALTs", () => {
      const tx = createAmmV4InitTransactionFixture({ isVersion0: true });
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.event.protocol).toBe("RAYDIUM_AMM_V4");
      expect(result.event.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(result.event.token0Mint).toBe(FIXTURE_MEME_MINT);
      expect(result.event.token1Mint).toBe(FIXTURE_WSOL_MINT);
    });

    it("fails closed on AMM v4 non-initialization instruction (e.g. swap tag 9)", () => {
      const tx = createAmmV4InitTransactionFixture();
      // Overwrite tag to 9 (swap)
      (tx.instructions[0]!.data as Buffer)[0] = 9;

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("UNSUPPORTED_PROTOCOL");
      expect(result.reason).toBe("NON_INITIALIZATION_INSTRUCTION");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Raydium CPMM Recognition (D29-A2)
  // --------------------------------------------------------------------------
  describe("2. Raydium CPMM Recognition", () => {
    it("identifies genuine CPMM initialize instruction and decodes openTime from params", () => {
      const tx = createCpmmInitTransactionFixture({
        isVersion0: false,
        openTime: 1792375500,
      });
      const hostNow = 1792375205000;
      const result = identifyPoolInitializationInstruction(tx, hostNow);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.event.protocol).toBe("RAYDIUM_CPMM");
      expect(result.event.poolId).toBe(FIXTURE_CPMM_POOL_ADDRESS);
      expect(result.event.token0Mint).toBe(FIXTURE_CPMM_TOKEN_0_MINT);
      expect(result.event.token1Mint).toBe(FIXTURE_CPMM_TOKEN_1_MINT);
      expect(result.event.slot).toBe(tx.slot);
      expect(result.event.blockTimeSec).toBe(tx.blockTime);
      expect(result.event.firstSeenTimestampMs).toBe(hostNow);
      expect(result.event.poolOpenTimeSec).toBe(1792375500); // Decoded from instruction data
      expect(result.event.poolOpenTimeSec).not.toBe(result.event.blockTimeSec); // Distinct from blockTime
      expect(result.event.eventId).toBe(`${tx.signature}:0`);
    });

    it("identifies CPMM initialize instruction in Version 0 transaction with ALTs", () => {
      const tx = createCpmmInitTransactionFixture({ isVersion0: true });
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.event.protocol).toBe("RAYDIUM_CPMM");
      expect(result.event.poolId).toBe(FIXTURE_CPMM_POOL_ADDRESS);
    });

    it("fails closed on CPMM non-initialization instruction (mismatched discriminator)", () => {
      const tx = createCpmmInitTransactionFixture();
      // Tamper discriminator byte 0
      (tx.instructions[0]!.data as Buffer)[0] = 0x00;

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("UNSUPPORTED_PROTOCOL");
      expect(result.reason).toBe("NON_INITIALIZATION_INSTRUCTION");
    });
  });

  // --------------------------------------------------------------------------
  // 3. Fail-Closed Controls (D29-A2 #5)
  // --------------------------------------------------------------------------
  describe("3. Fail-Closed Negative Controls", () => {
    it("fails closed when transaction failed on-chain (err !== null)", () => {
      const tx = createAmmV4InitTransactionFixture({
        err: { InstructionError: [0, "Custom"] },
      });

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("TRANSACTION_FAILED");
      expect(result.message).toContain("failed with on-chain error");
    });

    it("fails closed when instruction references out-of-bounds account index in ALT", () => {
      const tx = createCpmmInitTransactionFixture({ isVersion0: true });
      // Point instruction account index to index 999 (out of bounds)
      (tx.instructions[0]!.accountKeyIndexes as number[])[3] = 999;

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("UNRESOLVED_LOOKUP_TABLE_INDEX");
    });

    it("fails closed when instruction data is truncated (< discriminator/tag size)", () => {
      const baseTx = createCpmmInitTransactionFixture();
      // Truncate instruction data to 4 bytes (Anchor requires 8 bytes discriminator)
      const tx = {
        ...baseTx,
        instructions: [
          {
            ...baseTx.instructions[0]!,
            data: Buffer.alloc(4),
          },
        ],
      };

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("CORRUPTED_INSTRUCTION_DATA");
    });

    it("fails closed when instruction has fewer accounts than required", () => {
      const baseTx = createCpmmInitTransactionFixture();
      // Provide only 5 accounts (CPMM requires 17)
      const tx = {
        ...baseTx,
        instructions: [
          {
            ...baseTx.instructions[0]!,
            accountKeyIndexes: [0, 1, 2, 3, 4],
          },
        ],
      };

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("MISSING_ACCOUNTS");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Explicit Unsupported Protocol Classification (D29-A1, D29-A2)
  // --------------------------------------------------------------------------
  describe("4. Explicit Unsupported Protocol Classification", () => {
    it("explicitly classifies Orca Whirlpools", () => {
      const tx = createUnsupportedProtocolTransactionFixture(
        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
      );
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("UNSUPPORTED_PROTOCOL");
      expect(result.reason).toBe("ORCA_WHIRLPOOL");
    });

    it("explicitly classifies Raydium CLMM", () => {
      const tx = createUnsupportedProtocolTransactionFixture(
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
      );
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("UNSUPPORTED_PROTOCOL");
      expect(result.reason).toBe("RAYDIUM_CLMM");
    });

    it("explicitly classifies Meteora DLMM", () => {
      const tx = createUnsupportedProtocolTransactionFixture(
        "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
      );
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("UNSUPPORTED_PROTOCOL");
      expect(result.reason).toBe("METEORA_DLMM");
    });

    it("explicitly classifies Pump.fun", () => {
      const tx = createUnsupportedProtocolTransactionFixture(
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      );
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("UNSUPPORTED_PROTOCOL");
      expect(result.reason).toBe("PUMP_FUN");
    });

    it("explicitly classifies unknown program as UNKNOWN_PROGRAM", () => {
      const tx = createUnsupportedProtocolTransactionFixture(
        "UnknownProgram1111111111111111111111111111111",
      );
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("UNSUPPORTED_PROTOCOL");
      expect(result.reason).toBe("UNKNOWN_PROGRAM");
    });
  });
});
