import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GEN_01_BASELINE_ID,
  GEN_01_BASELINE_HASH,
  bootstrapGenerationsRegistry,
  loadGenerationsRegistry,
  saveGenerationsRegistry,
  getActiveGeneration,
  getGeneration,
  listGenerations,
  verifyGenerationIntegrity,
  validateGenerationsRegistry,
  computeFileSha256,
  type GenerationsRegistry,
  type WalletGenerationMetadata,
} from "./GenerationsRegistry.js";
import {
  validateGenerationId,
  getCanonicalGenerationDir,
  getGenerationWalletPath,
  getGenerationPastSessionsPath,
  getGenerationSessionsDir,
  getCanonicalGenerationsDir,
  getCanonicalGenerationsRegistryPath,
  getCanonicalWalletPath,
  getCanonicalLockPath,
} from "./CanonicalPaths.js";
import { loadVirtualWallet, saveVirtualWallet, type VirtualWalletState } from "./VirtualWallet.js";
import { acquireProcessLock, releaseProcessLock } from "./ProcessLock.js";

describe("Phase 12.94-A GenerationsRegistry & Path Confinement", () => {
  // --------------------------------------------------------------------------
  // Required Test 1: Fail-closed initialization & read-only loader
  // --------------------------------------------------------------------------
  describe("Test 1: Fail-Closed Initialization & Read-Only Loader (A94-01)", () => {
    it("loadGenerationsRegistry throws REGISTRY_NOT_INITIALIZED when registry is absent and writes ZERO files", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test1-absent-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const registryPath = getCanonicalGenerationsRegistryPath(tempDir);
      expect(existsSync(registryPath)).toBe(false);

      expect(() => loadGenerationsRegistry(tempDir)).toThrow(/\[REGISTRY_NOT_INITIALIZED\]/);

      // Verify strict read-only guarantee: no file was created on disk
      expect(existsSync(registryPath)).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("bootstrapGenerationsRegistry fails closed when canonical wallet is missing and writes ZERO files", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test1-missing-wallet-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const registryPath = getCanonicalGenerationsRegistryPath(tempDir);
      expect(() => bootstrapGenerationsRegistry({ workspaceRoot: tempDir })).toThrow(
        /\[FATAL_BOOTSTRAP\].*canonical wallet missing/i,
      );

      // Verify no registry was fabricated
      expect(existsSync(registryPath)).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("bootstrapGenerationsRegistry fails closed on corrupt canonical wallet without fabricating 7.9259 SOL", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test1-corrupt-wallet-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const canonicalWallet = getCanonicalWalletPath(tempDir);
      writeFileSync(canonicalWallet, "{ broken json payload -- not valid", "utf8");

      const registryPath = getCanonicalGenerationsRegistryPath(tempDir);
      expect(() => bootstrapGenerationsRegistry({ workspaceRoot: tempDir })).toThrow(
        /\[FATAL_BOOTSTRAP\]/,
      );

      // Verify no registry was created
      expect(existsSync(registryPath)).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("bootstrapGenerationsRegistry fails closed on wallet hash mismatch without force", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test1-hash-mismatch-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const canonicalWallet = getCanonicalWalletPath(tempDir);
      const walletState = {
        walletAddress: "SimWalletMismatchTest",
        currentBalanceSol: 5.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 2,
        allTimeRealizedPnlSol: -5.0,
        lastUpdatedMs: Date.now(),
        settledSessionIds: ["session-1"],
        unresolvedTokens: [],
      };
      writeFileSync(canonicalWallet, JSON.stringify(walletState, null, 2), "utf8");

      // Attempt bootstrap with baseline hash check against different content
      expect(() =>
        bootstrapGenerationsRegistry({
          workspaceRoot: tempDir,
          expectedBaselineHash: GEN_01_BASELINE_HASH,
        }),
      ).toThrow(/\[FATAL_BOOTSTRAP\].*hash mismatch/i);

      expect(existsSync(getCanonicalGenerationsRegistryPath(tempDir))).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Required Test 2: Valid baseline + verified manifest + exclusive lock
  // --------------------------------------------------------------------------
  describe("Test 2: Lock-Protected & Idempotent Bootstrap (A94-01 & A94-04)", () => {
    it("explicit bootstrap succeeds with verified hash, produces valid registry, and is strictly idempotent", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test2-valid-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const canonicalWallet = getCanonicalWalletPath(tempDir);
      const walletState = {
        walletAddress: "SimWalletBaselineTest",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: Date.now(),
        settledSessionIds: ["session-paper-12.93-pc-day4", "session-paper-12.93-pc-afternoon"],
        unresolvedTokens: [],
      };
      const walletJson = JSON.stringify(walletState, null, 2);
      writeFileSync(canonicalWallet, walletJson, "utf8");
      const fixtureHash = crypto.createHash("sha256").update(Buffer.from(walletJson)).digest("hex");

      // First bootstrap: succeeds
      const registry = bootstrapGenerationsRegistry({
        workspaceRoot: tempDir,
        expectedBaselineHash: fixtureHash,
      });

      expect(registry.version).toBe(1);
      expect(registry.activeGenerationId).toBe(GEN_01_BASELINE_ID);
      expect(registry.generations[GEN_01_BASELINE_ID]).toBeDefined();

      const gen1 = registry.generations[GEN_01_BASELINE_ID]!;
      expect(gen1.generationId).toBe(GEN_01_BASELINE_ID);
      expect(gen1.status).toBe("ACTIVE");
      expect(gen1.currentBalanceSol).toBe(7.9259);
      expect(gen1.totalSessionsCompleted).toBe(7);
      expect(gen1.lifetimeRealizedPnlSol).toBe(-2.074);
      expect(gen1.walletSnapshotSha256).toBe(fixtureHash);
      expect(gen1.baselineSnapshotSha256).toBe(fixtureHash);

      // Verify file written to disk
      const registryPath = getCanonicalGenerationsRegistryPath(tempDir);
      expect(existsSync(registryPath)).toBe(true);

      // Second bootstrap: idempotent no-op returns same registry without error
      const registrySecond = bootstrapGenerationsRegistry({
        workspaceRoot: tempDir,
        expectedBaselineHash: fixtureHash,
      });
      expect(registrySecond.activeGenerationId).toBe(GEN_01_BASELINE_ID);
      expect(registrySecond.generations[GEN_01_BASELINE_ID]?.currentBalanceSol).toBe(7.9259);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("bootstrap fails closed if an active external process holds the exclusive lock", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test2-lock-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const canonicalWallet = getCanonicalWalletPath(tempDir);
      const walletState = {
        walletAddress: "SimWalletLockTest",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: Date.now(),
        settledSessionIds: ["session-1"],
        unresolvedTokens: [],
      };
      const walletJson = JSON.stringify(walletState, null, 2);
      writeFileSync(canonicalWallet, walletJson, "utf8");
      const fixtureHash = crypto.createHash("sha256").update(Buffer.from(walletJson)).digest("hex");

      // Acquire lock externally first
      const lockPath = getCanonicalLockPath(tempDir);
      const holdingLock = acquireProcessLock({
        processName: "competing-test-process",
        lockPath,
      });

      try {
        // Attempting bootstrap must fail closed
        expect(() =>
          bootstrapGenerationsRegistry({
            workspaceRoot: tempDir,
            expectedBaselineHash: fixtureHash,
          }),
        ).toThrow(/\[ProcessLock\] \[FATAL\] Exclusive lock held by active process/);

        // Verify registry was not written
        expect(existsSync(getCanonicalGenerationsRegistryPath(tempDir))).toBe(false);
      } finally {
        releaseProcessLock(holdingLock);
      }

      // After release, bootstrap succeeds
      const registry = bootstrapGenerationsRegistry({
        workspaceRoot: tempDir,
        expectedBaselineHash: fixtureHash,
      });
      expect(registry.version).toBe(1);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Required Test 3: Path ID validation & path traversal rejection
  // --------------------------------------------------------------------------
  describe("Test 3: Path Traversal & Identifier Validation (A94-02)", () => {
    it("validateGenerationId enforces single-segment alphanumeric format and rejects traversal", () => {
      // Valid generation IDs
      expect(validateGenerationId("gen-01-legacy-baseline")).toBe("gen-01-legacy-baseline");
      expect(validateGenerationId("gen-02-quote-aware")).toBe("gen-02-quote-aware");
      expect(validateGenerationId("gen-3")).toBe("gen-3");
      expect(validateGenerationId("g")).toBe("g");
      expect(validateGenerationId("a1b2c3")).toBe("a1b2c3");

      // Invalid: Path traversal
      expect(() => validateGenerationId("..")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("../outside")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("../../etc/passwd")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("gen..01")).toThrow(/\[FATAL_PATH\]/);

      // Invalid: Path separators (POSIX & Windows)
      expect(() => validateGenerationId("gen/01")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("gen\\01")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("/root/gen")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("C:\\Windows")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("D:/data")).toThrow(/\[FATAL_PATH\]/);

      // Invalid: URL / percent encoding
      expect(() => validateGenerationId("gen%2F01")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("gen%5C01")).toThrow(/\[FATAL_PATH\]/);

      // Invalid: Non-conforming syntax
      expect(() => validateGenerationId("")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("   ")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId(".hidden")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("-leading-hyphen")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("trailing-hyphen-")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("UPPERCASE_NOT_ALLOWED")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("with spaces")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateGenerationId("a".repeat(65))).toThrow(/\[FATAL_PATH\]/);
    });

    it("generation path helpers confine paths strictly within canonical generations directory", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test3-helpers-"));
      const generationsBase = getCanonicalGenerationsDir(tempDir);

      // Valid resolution
      const genDir = getCanonicalGenerationDir("gen-01-legacy-baseline", tempDir);
      expect(genDir).toBe(path.resolve(generationsBase, "gen-01-legacy-baseline"));

      const walletPath = getGenerationWalletPath("gen-01-legacy-baseline", tempDir);
      expect(walletPath).toBe(
        path.resolve(generationsBase, "gen-01-legacy-baseline", "virtual-wallet.json"),
      );

      const pastSessionsPath = getGenerationPastSessionsPath("gen-01-legacy-baseline", tempDir);
      expect(pastSessionsPath).toBe(
        path.resolve(generationsBase, "gen-01-legacy-baseline", "past-sessions.json"),
      );

      const sessionsDir = getGenerationSessionsDir("gen-01-legacy-baseline", tempDir);
      expect(sessionsDir).toBe(path.resolve(generationsBase, "gen-01-legacy-baseline", "sessions"));

      // Traversal attempts must throw across all helpers
      expect(() => getCanonicalGenerationDir("../outside", tempDir)).toThrow(/\[FATAL_PATH\]/);
      expect(() => getGenerationWalletPath("../wallet", tempDir)).toThrow(/\[FATAL_PATH\]/);
      expect(() => getGenerationPastSessionsPath("../../root", tempDir)).toThrow(/\[FATAL_PATH\]/);
      expect(() => getGenerationSessionsDir("C:\\outside", tempDir)).toThrow(/\[FATAL_PATH\]/);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Required Test 4: Generation ID round-trip & cross-generation mismatch guard
  // --------------------------------------------------------------------------
  describe("Test 4: Generation ID Round-Trip & Wallet Mismatch Guard (A94-03)", () => {
    it("preserves generationId during wallet save and load cycles", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test4-roundtrip-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const walletFile = path.join(tempDir, ".tmp", "custom-gen2-wallet.json");
      const gen2Wallet: VirtualWalletState = {
        walletAddress: "SimWalletGen2Test",
        generationId: "gen-02-quote-aware",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 0,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: Date.now(),
        settledSessionIds: [],
        unresolvedTokens: [],
      };

      saveVirtualWallet(gen2Wallet, walletFile);

      // Load wallet and assert generationId is intact
      const loaded = loadVirtualWallet(walletFile);
      expect(loaded.generationId).toBe("gen-02-quote-aware");
      expect(loaded.currentBalanceSol).toBe(10.0);
      expect(loaded.totalSessionsCompleted).toBe(0);

      // Verify JSON on disk contains generationId
      const diskRaw = JSON.parse(readFileSync(walletFile, "utf8"));
      expect(diskRaw.generationId).toBe("gen-02-quote-aware");

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("loadVirtualWallet validates expectedGenerationId and aborts on cross-generation mismatch", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test4-mismatch-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const walletFile = path.join(tempDir, ".tmp", "gen2-wallet.json");
      const gen2Wallet: VirtualWalletState = {
        walletAddress: "SimWalletGen2Test",
        generationId: "gen-02-quote-aware",
        currentBalanceSol: 10.0,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 0,
        allTimeRealizedPnlSol: 0.0,
        lastUpdatedMs: Date.now(),
        settledSessionIds: [],
        unresolvedTokens: [],
      };
      saveVirtualWallet(gen2Wallet, walletFile);

      // Correct expected ID succeeds
      const loadedCorrect = loadVirtualWallet(walletFile, {
        expectedGenerationId: "gen-02-quote-aware",
      });
      expect(loadedCorrect.generationId).toBe("gen-02-quote-aware");

      // Mismatched expected ID fails closed
      expect(() =>
        loadVirtualWallet(walletFile, {
          expectedGenerationId: "gen-01-legacy-baseline",
        }),
      ).toThrow(
        /\[GENERATION_MISMATCH\].*has generationId 'gen-02-quote-aware', but expected 'gen-01-legacy-baseline'/,
      );

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("supports legacy untagged wallet compatibility for Generation 1 but rejects untagged for Generation 2+", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test4-legacy-compat-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const legacyWalletFile = path.join(tempDir, ".tmp", "legacy-wallet.json");
      const legacyWalletState: VirtualWalletState = {
        walletAddress: "SimLegacyWallet",
        // Notice: generationId is undefined (legacy Phase 12.93 format)
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: Date.now(),
        settledSessionIds: ["session-paper-12.93-pc-day4"],
        unresolvedTokens: [],
      };
      saveVirtualWallet(legacyWalletState, legacyWalletFile);

      // Loading with expected GEN_01_BASELINE_ID succeeds (explicit backward compatibility)
      const loadedLegacy = loadVirtualWallet(legacyWalletFile, {
        expectedGenerationId: "gen-01-legacy-baseline",
      });
      expect(loadedLegacy.currentBalanceSol).toBe(7.9259);

      // Loading untagged wallet with expected gen-02-quote-aware fails closed
      expect(() =>
        loadVirtualWallet(legacyWalletFile, {
          expectedGenerationId: "gen-02-quote-aware",
        }),
      ).toThrow(/\[GENERATION_MISMATCH\].*untagged.*expected 'gen-02-quote-aware'/);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Required Test 5: Schema validation & frozen baseline semantics
  // --------------------------------------------------------------------------
  describe("Test 5: Schema Validation & Baseline Integrity (A94-05)", () => {
    const validGen1Meta: WalletGenerationMetadata = {
      generationId: GEN_01_BASELINE_ID,
      label: "Phase 12.93 Baseline Continuous Wallet (Frozen)",
      status: "ACTIVE",
      createdAtIso: "2026-10-13T17:00:00.000Z",
      initialBalanceSol: 10.0,
      currentBalanceSol: 7.9259,
      totalSessionsCompleted: 7,
      lifetimeRealizedPnlSol: -2.074,
      baselineSnapshotSha256: GEN_01_BASELINE_HASH,
      walletSnapshotSha256: GEN_01_BASELINE_HASH,
      settledSessionIds: ["session-paper-12.93-pc-day4", "session-paper-12.93-pc-afternoon"],
      unresolvedTokensCount: 0,
      note: "Preserves 7 continuous settled sessions distinct from 12-session historical index.",
    };

    it("validateGenerationsRegistry accepts valid schema", () => {
      const validRegistry: GenerationsRegistry = {
        version: 1,
        activeGenerationId: GEN_01_BASELINE_ID,
        generations: {
          [GEN_01_BASELINE_ID]: validGen1Meta,
        },
        updatedAtIso: "2026-10-13T18:00:00.000Z",
      };

      const result = validateGenerationsRegistry(validRegistry);
      expect(result.version).toBe(1);
      expect(result.activeGenerationId).toBe(GEN_01_BASELINE_ID);
    });

    it("rejects unsupported registry versions", () => {
      const invalid = {
        version: 2,
        activeGenerationId: GEN_01_BASELINE_ID,
        generations: { [GEN_01_BASELINE_ID]: validGen1Meta },
        updatedAtIso: "2026-10-13T18:00:00.000Z",
      };
      expect(() => validateGenerationsRegistry(invalid)).toThrow(
        /\[FATAL_SCHEMA\].*Unsupported registry version '2'/,
      );
    });

    it("rejects multiple ACTIVE generations", () => {
      const invalid = {
        version: 1,
        activeGenerationId: GEN_01_BASELINE_ID,
        generations: {
          [GEN_01_BASELINE_ID]: { ...validGen1Meta, status: "ACTIVE" },
          "gen-02-test": {
            ...validGen1Meta,
            generationId: "gen-02-test",
            status: "ACTIVE",
          },
        },
        updatedAtIso: "2026-10-13T18:00:00.000Z",
      };
      expect(() => validateGenerationsRegistry(invalid)).toThrow(
        /\[FATAL_SCHEMA\].*Exactly one generation must have status 'ACTIVE', found 2/,
      );
    });

    it("rejects mismatched map key and metadata generationId", () => {
      const invalid = {
        version: 1,
        activeGenerationId: GEN_01_BASELINE_ID,
        generations: {
          "wrong-key": { ...validGen1Meta, generationId: GEN_01_BASELINE_ID },
        },
        updatedAtIso: "2026-10-13T18:00:00.000Z",
      };
      expect(() => validateGenerationsRegistry(invalid)).toThrow(
        /\[FATAL_SCHEMA\].*Generation map key 'wrong-key' does not match generationId/,
      );
    });

    it("rejects non-finite balances and negative session counts", () => {
      const invalidBalance = {
        version: 1,
        activeGenerationId: GEN_01_BASELINE_ID,
        generations: {
          [GEN_01_BASELINE_ID]: { ...validGen1Meta, currentBalanceSol: NaN },
        },
        updatedAtIso: "2026-10-13T18:00:00.000Z",
      };
      expect(() => validateGenerationsRegistry(invalidBalance)).toThrow(
        /\[FATAL_SCHEMA\].*invalid currentBalanceSol/,
      );

      const invalidSessions = {
        version: 1,
        activeGenerationId: GEN_01_BASELINE_ID,
        generations: {
          [GEN_01_BASELINE_ID]: { ...validGen1Meta, totalSessionsCompleted: -1 },
        },
        updatedAtIso: "2026-10-13T18:00:00.000Z",
      };
      expect(() => validateGenerationsRegistry(invalidSessions)).toThrow(
        /\[FATAL_SCHEMA\].*invalid totalSessionsCompleted/,
      );
    });

    it("rejects invalid hash formats", () => {
      const invalidHash = {
        version: 1,
        activeGenerationId: GEN_01_BASELINE_ID,
        generations: {
          [GEN_01_BASELINE_ID]: { ...validGen1Meta, walletSnapshotSha256: "not-a-64-hex-hash" },
        },
        updatedAtIso: "2026-10-13T18:00:00.000Z",
      };
      expect(() => validateGenerationsRegistry(invalidHash)).toThrow(
        /\[FATAL_SCHEMA\].*walletSnapshotSha256: must be 64-hex string/,
      );
    });

    it("verifyGenerationIntegrity confirms valid hash and reports tampering", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test5-integrity-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const canonicalWallet = getCanonicalWalletPath(tempDir);
      const walletState = {
        walletAddress: "SimWalletIntegTest",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: Date.now(),
        settledSessionIds: ["session-1"],
        unresolvedTokens: [],
      };
      const walletJson = JSON.stringify(walletState, null, 2);
      writeFileSync(canonicalWallet, walletJson, "utf8");
      const fixtureHash = crypto.createHash("sha256").update(Buffer.from(walletJson)).digest("hex");

      bootstrapGenerationsRegistry({
        workspaceRoot: tempDir,
        expectedBaselineHash: fixtureHash,
      });

      const initialResult = verifyGenerationIntegrity(GEN_01_BASELINE_ID, tempDir);
      expect(initialResult.valid).toBe(true);

      // Tamper with canonical wallet file
      writeFileSync(
        canonicalWallet,
        JSON.stringify({ ...walletState, currentBalanceSol: 99.0 }),
        "utf8",
      );
      const tamperedResult = verifyGenerationIntegrity(GEN_01_BASELINE_ID, tempDir);
      expect(tamperedResult.valid).toBe(false);
      expect(tamperedResult.error).toMatch(/Generation 1 hash mismatch/);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Required Test 6: Autonomous activation safety & query helpers
  // --------------------------------------------------------------------------
  describe("Test 6: Autonomous Activation Safety & Query API (A94-04)", () => {
    it("getActiveGeneration, getGeneration, and listGenerations operate strictly read-only", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test6-query-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const canonicalWallet = getCanonicalWalletPath(tempDir);
      const walletState = {
        walletAddress: "SimWalletQueryTest",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: Date.now(),
        settledSessionIds: ["session-paper-12.93-pc-day4"],
        unresolvedTokens: [],
      };
      const walletJson = JSON.stringify(walletState, null, 2);
      writeFileSync(canonicalWallet, walletJson, "utf8");
      const fixtureHash = crypto.createHash("sha256").update(Buffer.from(walletJson)).digest("hex");

      bootstrapGenerationsRegistry({
        workspaceRoot: tempDir,
        expectedBaselineHash: fixtureHash,
      });

      const active = getActiveGeneration(tempDir);
      expect(active.generationId).toBe(GEN_01_BASELINE_ID);
      expect(active.status).toBe("ACTIVE");

      const gen1 = getGeneration(GEN_01_BASELINE_ID, tempDir);
      expect(gen1?.generationId).toBe(GEN_01_BASELINE_ID);

      const all = listGenerations(tempDir);
      expect(all.length).toBe(1);
      expect(all[0]?.generationId).toBe(GEN_01_BASELINE_ID);

      // Verify canonical wallet hash was never modified during queries
      const currentWalletHash = computeFileSha256(canonicalWallet);
      expect(currentWalletHash).toBe(fixtureHash);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("verifies no autonomous cutover or activation mechanism exists in Subphase 12.94-A", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test6-no-auto-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const canonicalWallet = getCanonicalWalletPath(tempDir);
      const walletState = {
        walletAddress: "SimWalletNoAuto",
        currentBalanceSol: 7.9259,
        initialBalanceSol: 10.0,
        totalSessionsCompleted: 7,
        allTimeRealizedPnlSol: -2.074,
        lastUpdatedMs: Date.now(),
        settledSessionIds: ["session-1"],
        unresolvedTokens: [],
      };
      const walletJson = JSON.stringify(walletState, null, 2);
      writeFileSync(canonicalWallet, walletJson, "utf8");
      const fixtureHash = crypto.createHash("sha256").update(Buffer.from(walletJson)).digest("hex");

      const registry = bootstrapGenerationsRegistry({
        workspaceRoot: tempDir,
        expectedBaselineHash: fixtureHash,
      });

      // Generation 2 does NOT exist in registry
      expect(registry.generations["gen-02-quote-aware"]).toBeUndefined();
      expect(registry.activeGenerationId).toBe(GEN_01_BASELINE_ID);

      // Loading registry multiple times NEVER triggers cutover
      const reloaded = loadGenerationsRegistry(tempDir);
      expect(reloaded.activeGenerationId).toBe(GEN_01_BASELINE_ID);
      expect(Object.keys(reloaded.generations)).toEqual([GEN_01_BASELINE_ID]);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("saveGenerationsRegistry persists valid registry with fsync durability and updates timestamp", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-test6-save-"));
      mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

      const customRegistry: GenerationsRegistry = {
        version: 1,
        activeGenerationId: GEN_01_BASELINE_ID,
        generations: {
          [GEN_01_BASELINE_ID]: {
            generationId: GEN_01_BASELINE_ID,
            label: "Phase 12.93 Baseline Continuous Wallet (Frozen)",
            status: "ACTIVE",
            createdAtIso: "2026-10-13T17:00:00.000Z",
            initialBalanceSol: 10.0,
            currentBalanceSol: 7.9259,
            totalSessionsCompleted: 7,
            lifetimeRealizedPnlSol: -2.074,
            baselineSnapshotSha256: GEN_01_BASELINE_HASH,
            walletSnapshotSha256: GEN_01_BASELINE_HASH,
            settledSessionIds: ["session-1"],
            unresolvedTokensCount: 0,
            note: "Explicit save durability test",
          },
        },
        updatedAtIso: "2026-10-13T00:00:00.000Z",
      };

      saveGenerationsRegistry(customRegistry, tempDir);

      const loaded = loadGenerationsRegistry(tempDir);
      expect(loaded.version).toBe(1);
      expect(loaded.updatedAtIso).not.toBe("2026-10-13T00:00:00.000Z");
      expect(loaded.generations[GEN_01_BASELINE_ID]?.note).toBe("Explicit save durability test");

      rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
