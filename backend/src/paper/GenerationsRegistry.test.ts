import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GEN_01_BASELINE_ID,
  buildDefaultGeneration1,
  getActiveGeneration,
  getGeneration,
  listGenerations,
  loadGenerationsRegistry,
  saveGenerationsRegistry,
  verifyGenerationIntegrity,
  type GenerationsRegistry,
} from "./GenerationsRegistry.js";

describe("GenerationsRegistry", () => {
  it("initializes default Generation 1 registry when file is absent in fixture", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-reg-init-"));
    mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

    const canonicalWallet = path.join(tempDir, ".tmp", "virtual-wallet.json");
    const walletState = {
      walletAddress: "SimWalletGen1Test",
      currentBalanceSol: 7.9259,
      initialBalanceSol: 10.0,
      totalSessionsCompleted: 7,
      allTimeRealizedPnlSol: -2.074,
      lastUpdatedMs: Date.now(),
      settledSessionIds: ["session-paper-12.93-pc-day4", "session-paper-12.93-pc-afternoon"],
      unresolvedTokens: [],
    };
    writeFileSync(canonicalWallet, JSON.stringify(walletState, null, 2), "utf8");

    const registry = loadGenerationsRegistry(tempDir);
    expect(registry.version).toBe(1);
    expect(registry.activeGenerationId).toBe(GEN_01_BASELINE_ID);
    expect(registry.generations[GEN_01_BASELINE_ID]).toBeDefined();

    const gen1 = registry.generations[GEN_01_BASELINE_ID]!;
    expect(gen1.generationId).toBe(GEN_01_BASELINE_ID);
    expect(gen1.status).toBe("ACTIVE");
    expect(gen1.currentBalanceSol).toBe(7.9259);
    expect(gen1.totalSessionsCompleted).toBe(7);
    expect(gen1.lifetimeRealizedPnlSol).toBe(-2.074);
    expect(gen1.settledSessionIds).toEqual([
      "session-paper-12.93-pc-day4",
      "session-paper-12.93-pc-afternoon",
    ]);

    // File persisted to disk
    const registryPath = path.join(tempDir, ".tmp", "generations-registry.json");
    expect(existsSync(registryPath)).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getActiveGeneration returns active generation metadata correctly", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-reg-active-"));
    mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

    const active = getActiveGeneration(tempDir);
    expect(active.generationId).toBe(GEN_01_BASELINE_ID);
    expect(active.status).toBe("ACTIVE");
    expect(active.initialBalanceSol).toBe(10.0);

    const retrieved = getGeneration(GEN_01_BASELINE_ID, tempDir);
    expect(retrieved?.generationId).toBe(GEN_01_BASELINE_ID);

    const all = listGenerations(tempDir);
    expect(all.length).toBe(1);
    expect(all[0]!.generationId).toBe(GEN_01_BASELINE_ID);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("verifyGenerationIntegrity verifies hash match and fails on divergence", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-reg-integ-"));
    mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

    const canonicalWallet = path.join(tempDir, ".tmp", "virtual-wallet.json");
    writeFileSync(canonicalWallet, JSON.stringify({ currentBalanceSol: 7.9259 }), "utf8");

    // Initialize registry
    expect(loadGenerationsRegistry(tempDir).version).toBe(1);
    const result = verifyGenerationIntegrity(GEN_01_BASELINE_ID, tempDir);
    expect(result.valid).toBe(true);

    // Tamper with canonical wallet
    writeFileSync(canonicalWallet, JSON.stringify({ currentBalanceSol: 999.0 }), "utf8");
    const tamperedResult = verifyGenerationIntegrity(GEN_01_BASELINE_ID, tempDir);
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.error).toMatch(/hash mismatch/);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("fails closed on corrupted registry file", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-reg-corrupt-"));
    mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

    const registryPath = path.join(tempDir, ".tmp", "generations-registry.json");
    writeFileSync(registryPath, "{ corrupt json -- ", "utf8");

    expect(() => loadGenerationsRegistry(tempDir)).toThrow(/\[FATAL_REGISTRY\]/);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("saveGenerationsRegistry updates timestamp and atomic file safely", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "gen-reg-save-"));
    mkdirSync(path.join(tempDir, ".tmp"), { recursive: true });

    const registry: GenerationsRegistry = {
      version: 1,
      activeGenerationId: GEN_01_BASELINE_ID,
      generations: {
        [GEN_01_BASELINE_ID]: buildDefaultGeneration1(tempDir),
      },
      updatedAtIso: "2026-10-13T00:00:00.000Z",
    };

    saveGenerationsRegistry(registry, tempDir);
    const loaded = loadGenerationsRegistry(tempDir);
    expect(loaded.version).toBe(1);
    expect(loaded.updatedAtIso).not.toBe("2026-10-13T00:00:00.000Z");

    rmSync(tempDir, { recursive: true, force: true });
  });
});
