import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getCanonicalGenerationsRegistryPath,
  getCanonicalWalletPath,
  getGenerationWalletPath,
} from "./CanonicalPaths.js";

export const GEN_01_BASELINE_ID = "gen-01-legacy-baseline";
export const GEN_01_BASELINE_HASH =
  "7f2c2353ac2f62cac1bb98703742ab19c74ac5521635af6f49bbe777ad020ed9";

export interface WalletGenerationMetadata {
  generationId: string;
  label: string;
  status: "ACTIVE" | "ARCHIVED" | "PENDING_ACTIVATION";
  createdAtIso: string;
  archivedAtIso?: string | undefined;
  initialBalanceSol: number;
  currentBalanceSol: number;
  totalSessionsCompleted: number;
  lifetimeRealizedPnlSol: number;
  walletSnapshotSha256: string;
  settledSessionIds: string[];
  unresolvedTokensCount: number;
  note: string;
}

export interface GenerationsRegistry {
  version: 1;
  activeGenerationId: string;
  generations: Record<string, WalletGenerationMetadata>;
  updatedAtIso: string;
}

function computeFileSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function buildDefaultGeneration1(workspaceRoot?: string): WalletGenerationMetadata {
  const canonicalWallet = getCanonicalWalletPath(workspaceRoot);
  let currentBalanceSol = 7.9259;
  let totalSessionsCompleted = 7;
  let lifetimeRealizedPnlSol = -2.074;
  let settledSessionIds = ["session-paper-12.93-pc-day4", "session-paper-12.93-pc-afternoon"];
  let unresolvedTokensCount = 0;
  let walletSnapshotSha256 = GEN_01_BASELINE_HASH;

  if (existsSync(canonicalWallet)) {
    try {
      const raw = JSON.parse(readFileSync(canonicalWallet, "utf8"));
      if (typeof raw.currentBalanceSol === "number") currentBalanceSol = raw.currentBalanceSol;
      if (typeof raw.totalSessionsCompleted === "number")
        totalSessionsCompleted = raw.totalSessionsCompleted;
      if (typeof raw.allTimeRealizedPnlSol === "number")
        lifetimeRealizedPnlSol = raw.allTimeRealizedPnlSol;
      if (Array.isArray(raw.settledSessionIds)) settledSessionIds = raw.settledSessionIds;
      if (Array.isArray(raw.unresolvedTokens)) unresolvedTokensCount = raw.unresolvedTokens.length;
      walletSnapshotSha256 = computeFileSha256(canonicalWallet);
    } catch {
      // Fallback to baseline constants
    }
  }

  return {
    generationId: GEN_01_BASELINE_ID,
    label: "Phase 12.93 Baseline Continuous Wallet (Frozen)",
    status: "ACTIVE",
    createdAtIso: "2026-10-13T17:00:00.000Z",
    initialBalanceSol: 10.0,
    currentBalanceSol,
    totalSessionsCompleted,
    lifetimeRealizedPnlSol,
    walletSnapshotSha256,
    settledSessionIds,
    unresolvedTokensCount,
    note: "Preserves 7 continuous settled sessions (-2.0740 SOL realized PnL; 7 closed losing trades on Oct 13 across 2 sessions = -0.5288 SOL) distinct from 12-session historical index.",
  };
}

export function loadGenerationsRegistry(workspaceRoot?: string): GenerationsRegistry {
  const registryPath = getCanonicalGenerationsRegistryPath(workspaceRoot);
  if (!existsSync(registryPath)) {
    const defaultRegistry: GenerationsRegistry = {
      version: 1,
      activeGenerationId: GEN_01_BASELINE_ID,
      generations: {
        [GEN_01_BASELINE_ID]: buildDefaultGeneration1(workspaceRoot),
      },
      updatedAtIso: new Date().toISOString(),
    };
    saveGenerationsRegistry(defaultRegistry, workspaceRoot);
    return defaultRegistry;
  }

  try {
    const raw = readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw) as GenerationsRegistry;
    if (parsed.version !== 1 || !parsed.activeGenerationId || !parsed.generations) {
      throw new Error("Invalid generations registry format");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_REGISTRY] Corrupted or unreadable generations registry at ${registryPath}: ${String(err)}. Manual inspection required.`,
    );
  }
}

export function saveGenerationsRegistry(
  registry: GenerationsRegistry,
  workspaceRoot?: string,
): void {
  const registryPath = getCanonicalGenerationsRegistryPath(workspaceRoot);
  const dir = path.dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const payload: GenerationsRegistry = {
    ...registry,
    updatedAtIso: new Date().toISOString(),
  };

  const tempPath = `${registryPath}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tempPath, registryPath);
}

export function getActiveGeneration(workspaceRoot?: string): WalletGenerationMetadata {
  const registry = loadGenerationsRegistry(workspaceRoot);
  const active = registry.generations[registry.activeGenerationId];
  if (!active) {
    throw new Error(
      `[GenerationsRegistry] Active generation '${registry.activeGenerationId}' not found in registry.`,
    );
  }
  return active;
}

export function getGeneration(
  generationId: string,
  workspaceRoot?: string,
): WalletGenerationMetadata | undefined {
  const registry = loadGenerationsRegistry(workspaceRoot);
  return registry.generations[generationId];
}

export function listGenerations(workspaceRoot?: string): WalletGenerationMetadata[] {
  const registry = loadGenerationsRegistry(workspaceRoot);
  return Object.values(registry.generations);
}

export function verifyGenerationIntegrity(
  generationId: string,
  workspaceRoot?: string,
): { valid: boolean; error?: string } {
  const registry = loadGenerationsRegistry(workspaceRoot);
  const meta = registry.generations[generationId];
  if (!meta) {
    return { valid: false, error: `Generation '${generationId}' does not exist in registry` };
  }

  if (generationId === GEN_01_BASELINE_ID) {
    const canonicalWallet = getCanonicalWalletPath(workspaceRoot);
    if (!existsSync(canonicalWallet)) {
      return { valid: false, error: `Canonical wallet missing at ${canonicalWallet}` };
    }
    const currentHash = computeFileSha256(canonicalWallet);
    if (currentHash !== meta.walletSnapshotSha256) {
      return {
        valid: false,
        error: `Generation 1 hash mismatch: expected ${meta.walletSnapshotSha256}, found ${currentHash}`,
      };
    }
  } else {
    const genWallet = getGenerationWalletPath(generationId, workspaceRoot);
    if (!existsSync(genWallet)) {
      return { valid: false, error: `Generation wallet missing at ${genWallet}` };
    }
    const currentHash = computeFileSha256(genWallet);
    if (currentHash !== meta.walletSnapshotSha256) {
      return {
        valid: false,
        error: `Generation ${generationId} hash mismatch: expected ${meta.walletSnapshotSha256}, found ${currentHash}`,
      };
    }
  }

  return { valid: true };
}
