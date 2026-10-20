/**
 * Phase 12.94-D Milestone D.2.9-A: Pool Initialization Parser Unit & Negative Tests
 *
 * Verifies protocol-neutral detection and classification of pool initialization instructions:
 * 1. Raydium AMM v4 initialize2 (tag 1) matching authoritative upstream instruction.rs
 *    (21 accounts, 26-byte payload, creator at index 17, market at indices 15-16, open_time at bytes 2..10).
 * 2. Raydium CPMM initialize Anchor instruction with discriminator and openTime.
 * 3. Base58 and Base64 RPC string instruction data representations (D29-F3).
 * 4. Nested CPI innerInstructions and multiple distinct pool initializations (D29-F4).
 * 5. Fail-closed controls: on-chain tx failure, deprecated tag 0, missing accounts, out-of-bounds ALT indices.
 * 6. Explicit unsupported-protocol classification (Orca, CLMM, DLMM, Pump.fun, Moonshot).
 * 7. Strict temporal separation: blockTimeSec, firstSeenTimestampMs, poolOpenTimeSec.
 */

import { describe, expect, it } from "vitest";
import {
  createAmmV4InitTransactionFixture,
  createCpiPoolInitTransactionFixture,
  createCpmmInitTransactionFixture,
  createMultiPoolInitTransactionFixture,
  createUnsupportedProtocolTransactionFixture,
  FIXTURE_AMM_AUTHORITY,
  FIXTURE_LP_MINT,
  FIXTURE_SERUM_MARKET,
  FIXTURE_USER_WALLET,
} from "./fixtures/AuthoritativeEventFixtures.js";
import {
  FIXTURE_CPMM_AMM_CONFIG,
  FIXTURE_CPMM_CREATOR,
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_MINT,
  FIXTURE_CPMM_TOKEN_1_MINT,
} from "./fixtures/AuthoritativeCpmmFixtures.js";
import {
  FIXTURE_MEME_MINT,
  FIXTURE_POOL_ADDRESS,
  FIXTURE_WSOL_MINT,
} from "./fixtures/AuthoritativeRaydiumFixtures.js";
import {
  identifyPoolInitializationInstruction,
  identifyPoolInitializationInstructions,
  RAYDIUM_AMM_V4_INIT2_PAYLOAD_LENGTH,
} from "./PoolInitializationParser.js";

describe("Milestone D.2.9-A: Pool Initialization Parser Tests", () => {
  // --------------------------------------------------------------------------
  // 1. Raydium AMM v4 Recognition (D29-A2, D29-F2)
  // --------------------------------------------------------------------------
  describe("1. Raydium AMM v4 Recognition", () => {
    it("identifies genuine AMM v4 initialize2 instruction from legacy transaction conforming to upstream instruction.rs", () => {
      const openTime = 1792375500;
      const tx = createAmmV4InitTransactionFixture({
        isVersion0: false,
        openTime,
        blockTime: 1792375100,
      });
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

      // Decoded open_time from instruction bytes 2..10 (D29-F2)
      expect(result.event.poolOpenTimeSec).toBe(openTime);
      expect(result.event.poolOpenTimeSec).not.toBe(result.event.blockTimeSec);

      // Authoritative account mapping
      expect(result.event.creatorWallet).toBe(FIXTURE_USER_WALLET); // Index 17
      expect(result.event.authorityPda).toBe(FIXTURE_AMM_AUTHORITY); // Index 5
      expect(result.event.lpMint).toBe(FIXTURE_LP_MINT); // Index 7
      expect(result.event.ammConfigOrMarket).toBe(FIXTURE_SERUM_MARKET); // Index 16

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

    it("fails closed on deprecated AMM v4 legacy initialize tag 0 (D29-F2)", () => {
      const tx = createAmmV4InitTransactionFixture({ tag: 0 });
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("RAYDIUM_AMM_V4");
      expect(result.reason).toBe("DEPRECATED_INITIALIZE_TAG");
      expect(result.message).toContain("deprecated initialize tag 0 is not supported");
    });

    it("fails closed on AMM v4 instruction data shorter than authoritative 26 bytes (D29-F2)", () => {
      const tx = createAmmV4InitTransactionFixture({ customDataLength: 20 });
      const result = identifyPoolInitializationInstruction(tx);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("RAYDIUM_AMM_V4");
      expect(result.reason).toBe("CORRUPTED_INSTRUCTION_DATA");
      expect(result.message).toContain(`expected at least ${RAYDIUM_AMM_V4_INIT2_PAYLOAD_LENGTH}`);
    });

    it("fails closed when AMM v4 initialize2 instruction has fewer than 21 accounts (D29-F2)", () => {
      const baseTx = createAmmV4InitTransactionFixture();
      // Provide only 18 accounts instead of 21
      const tx = {
        ...baseTx,
        instructions: [
          {
            ...baseTx.instructions[0]!,
            accountKeyIndexes: baseTx.instructions[0]!.accountKeyIndexes.slice(0, 18),
          },
        ],
      };

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.protocol).toBe("RAYDIUM_AMM_V4");
      expect(result.reason).toBe("MISSING_ACCOUNTS");
      expect(result.message).toContain("requires at least 21 accounts");
    });

    it("fails closed on AMM v4 non-initialization instruction (e.g. swap tag 9)", () => {
      const tx = createAmmV4InitTransactionFixture({ tag: 9 });

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
      const openTime = 1792375500;
      const tx = createCpmmInitTransactionFixture({
        isVersion0: false,
        openTime,
        blockTime: 1792375200,
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
      expect(result.event.poolOpenTimeSec).toBe(openTime); // Decoded from instruction data
      expect(result.event.poolOpenTimeSec).not.toBe(result.event.blockTimeSec); // Distinct from blockTime
      expect(result.event.creatorWallet).toBe(FIXTURE_CPMM_CREATOR);
      expect(result.event.ammConfigOrMarket).toBe(FIXTURE_CPMM_AMM_CONFIG);
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
  // 3. Instruction Data Encoding Contracts (D29-F3)
  // --------------------------------------------------------------------------
  describe("3. Instruction Data Encoding Contracts", () => {
    it("decodes Solana RPC base58 instruction data reaching identical identity as raw bytes", () => {
      const rawTx = createAmmV4InitTransactionFixture({ openTime: 1792375800 });
      const base58Tx = createAmmV4InitTransactionFixture({
        openTime: 1792375800,
        asBase58String: true,
      });

      const rawResult = identifyPoolInitializationInstruction(rawTx);
      const base58Result = identifyPoolInitializationInstruction(base58Tx);

      expect(rawResult.ok).toBe(true);
      expect(base58Result.ok).toBe(true);
      if (!rawResult.ok || !base58Result.ok) return;

      expect(base58Result.event.poolId).toBe(rawResult.event.poolId);
      expect(base58Result.event.token0Mint).toBe(rawResult.event.token0Mint);
      expect(base58Result.event.token1Mint).toBe(rawResult.event.token1Mint);
      expect(base58Result.event.poolOpenTimeSec).toBe(rawResult.event.poolOpenTimeSec);
      expect(base58Result.event.rawInstructionDataHex).toBe(rawResult.event.rawInstructionDataHex);
    });

    it("decodes Solana RPC base64 instruction data reaching identical identity as raw bytes", () => {
      const rawTx = createCpmmInitTransactionFixture({ openTime: 1792375900 });
      const base64Tx = createCpmmInitTransactionFixture({
        openTime: 1792375900,
        asBase64String: true,
      });

      const rawResult = identifyPoolInitializationInstruction(rawTx);
      const base64Result = identifyPoolInitializationInstruction(base64Tx);

      expect(rawResult.ok).toBe(true);
      expect(base64Result.ok).toBe(true);
      if (!rawResult.ok || !base64Result.ok) return;

      expect(base64Result.event.poolId).toBe(rawResult.event.poolId);
      expect(base64Result.event.poolOpenTimeSec).toBe(rawResult.event.poolOpenTimeSec);
      expect(base64Result.event.rawInstructionDataHex).toBe(rawResult.event.rawInstructionDataHex);
    });

    it("fails closed on invalid base58 character in instruction data", () => {
      const baseTx = createAmmV4InitTransactionFixture();
      const tx = {
        ...baseTx,
        instructions: [
          {
            ...baseTx.instructions[0]!,
            data: "000InvalidBase58Character000",
            dataEncoding: "base58" as const,
          },
        ],
      };

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("CORRUPTED_INSTRUCTION_DATA");
      expect(result.message).toContain("MALFORMED_BASE58_DATA");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Nested CPI & Multiple Initializations (D29-F4)
  // --------------------------------------------------------------------------
  describe("4. Nested CPI & Multiple Initializations", () => {
    it("identifies pool initialization located inside innerInstructions (CPI call)", () => {
      const tx = createCpiPoolInitTransactionFixture("RAYDIUM_AMM_V4");
      const hostNow = 1792375120000;
      const scanResult = identifyPoolInitializationInstructions(tx, hostNow);

      expect(scanResult.ok).toBe(true);
      if (!scanResult.ok) return;

      expect(scanResult.events.length).toBe(1);
      const event = scanResult.events[0]!;

      expect(event.protocol).toBe("RAYDIUM_AMM_V4");
      expect(event.poolId).toBe(FIXTURE_POOL_ADDRESS);
      expect(event.outerInstructionIndex).toBe(0);
      expect(event.innerInstructionIndex).toBe(0);
      expect(event.eventId).toBe(`${tx.signature}:0:inner:0`);
    });

    it("identifies multiple distinct pool initializations within one transaction without losing either", () => {
      const tx = createMultiPoolInitTransactionFixture();
      const hostNow = 1792375130000;
      const scanResult = identifyPoolInitializationInstructions(tx, hostNow);

      expect(scanResult.ok).toBe(true);
      if (!scanResult.ok) return;

      expect(scanResult.events.length).toBe(2);
      const [event1, event2] = scanResult.events;

      expect(event1!.poolId).toBe("PoolA11111111111111111111111111111111111111");
      expect(event1!.outerInstructionIndex).toBe(0);
      expect(event1!.eventId).toBe(`${tx.signature}:0`);

      expect(event2!.poolId).toBe("PoolB22222222222222222222222222222222222222");
      expect(event2!.outerInstructionIndex).toBe(1);
      expect(event2!.eventId).toBe(`${tx.signature}:1`);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Fail-Closed Controls (D29-A2 #5)
  // --------------------------------------------------------------------------
  describe("5. Fail-Closed Negative Controls", () => {
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
      (tx.instructions[0]!.accountKeyIndexes as number[])[3] = 999;

      const result = identifyPoolInitializationInstruction(tx);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("UNRESOLVED_LOOKUP_TABLE_INDEX");
    });

    it("fails closed when instruction data is truncated (< discriminator/tag size)", () => {
      const baseTx = createCpmmInitTransactionFixture();
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
  // 6. Explicit Unsupported Protocol Classification (D29-A1, D29-A2)
  // --------------------------------------------------------------------------
  describe("6. Explicit Unsupported Protocol Classification", () => {
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
