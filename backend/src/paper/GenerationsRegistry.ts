import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  getCanonicalGenerationsRegistryPath,
  getCanonicalLockPath,
  getCanonicalWalletPath,
  getGenerationWalletPath,
  validateGenerationId,
} from "./CanonicalPaths.js";
import { acquireProcessLock, releaseProcessLock, type ProcessLockHandle } from "./ProcessLock.js";

/**
 * Phase 12.94 Multi-Generation Wallet Registry
 *
 * SCOPE & SAFETY CONSTRAINTS (Subphase 12.94-A):
 * 1. Read-only loading: `loadGenerationsRegistry()` NEVER creates or mutates files. If missing, it throws [REGISTRY_NOT_INITIALIZED].
 * 2. Explicit bootstrap: `bootstrapGenerationsRegistry()` requires verified canonical wallet existence, valid JSON, hash match, and exclusive process locking.
 * 3. Fail-closed: Corrupted, missing, or mismatched canonical state aborts with fatal errors and writes zero files.
 * 4. Autonomous activation disabled: Subphase 12.94-A contains NO automatic generation cutover or activation pathway.
 *    Multi-file transition intents, crash-injection recovery, and journaled cutover are mandatory deferred prerequisites for Subphase 12.94-E.
 */

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
  baselineSnapshotSha256: string;
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

export function computeFileSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Validates a registry against the full schema.
 * Rejects invalid versions, unsafe generation IDs, multiple ACTIVE generations,
 * map key mismatches, non-finite numbers, and invalid statuses or hashes.
 */
export function validateGenerationsRegistry(data: unknown): GenerationsRegistry {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("[GenerationsRegistry] [FATAL_SCHEMA] Registry must be a non-null object.");
  }

  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_SCHEMA] Unsupported registry version '${String(obj.version)}'. Only version 1 is supported.`,
    );
  }

  if (typeof obj.activeGenerationId !== "string") {
    throw new Error(
      "[GenerationsRegistry] [FATAL_SCHEMA] activeGenerationId must be a valid generation string.",
    );
  }
  validateGenerationId(obj.activeGenerationId);

  if (typeof obj.updatedAtIso !== "string" || isNaN(Date.parse(obj.updatedAtIso))) {
    throw new Error(
      "[GenerationsRegistry] [FATAL_SCHEMA] updatedAtIso must be a valid ISO-8601 date string.",
    );
  }

  if (
    typeof obj.generations !== "object" ||
    obj.generations === null ||
    Array.isArray(obj.generations)
  ) {
    throw new Error(
      "[GenerationsRegistry] [FATAL_SCHEMA] generations property must be an object map of generation metadata.",
    );
  }

  const genMap = obj.generations as Record<string, unknown>;
  const entries = Object.entries(genMap);
  if (entries.length === 0) {
    throw new Error(
      "[GenerationsRegistry] [FATAL_SCHEMA] generations map cannot be empty. At least one generation must exist.",
    );
  }

  let activeCount = 0;
  for (const [key, val] of entries) {
    validateGenerationId(key);

    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation entry '${key}' must be an object.`,
      );
    }
    const meta = val as Record<string, unknown>;

    if (meta.generationId !== key) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation map key '${key}' does not match generationId '${String(meta.generationId)}'.`,
      );
    }
    validateGenerationId(meta.generationId as string);

    if (
      meta.status !== "ACTIVE" &&
      meta.status !== "ARCHIVED" &&
      meta.status !== "PENDING_ACTIVATION"
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid status '${String(meta.status)}'. Must be ACTIVE, ARCHIVED, or PENDING_ACTIVATION.`,
      );
    }

    if (meta.status === "ACTIVE") {
      activeCount++;
    }

    if (typeof meta.label !== "string" || meta.label.trim().length === 0) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid or empty label.`,
      );
    }

    if (typeof meta.createdAtIso !== "string" || isNaN(Date.parse(meta.createdAtIso))) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid createdAtIso.`,
      );
    }

    if (meta.archivedAtIso !== undefined) {
      if (typeof meta.archivedAtIso !== "string" || isNaN(Date.parse(meta.archivedAtIso))) {
        throw new Error(
          `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid archivedAtIso.`,
        );
      }
    }

    if (
      typeof meta.initialBalanceSol !== "number" ||
      !Number.isFinite(meta.initialBalanceSol) ||
      meta.initialBalanceSol < 0
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid initialBalanceSol: ${String(meta.initialBalanceSol)}.`,
      );
    }

    if (
      typeof meta.currentBalanceSol !== "number" ||
      !Number.isFinite(meta.currentBalanceSol) ||
      meta.currentBalanceSol < 0
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid currentBalanceSol: ${String(meta.currentBalanceSol)}.`,
      );
    }

    if (
      typeof meta.totalSessionsCompleted !== "number" ||
      !Number.isInteger(meta.totalSessionsCompleted) ||
      meta.totalSessionsCompleted < 0
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid totalSessionsCompleted: ${String(meta.totalSessionsCompleted)}.`,
      );
    }

    if (
      typeof meta.lifetimeRealizedPnlSol !== "number" ||
      !Number.isFinite(meta.lifetimeRealizedPnlSol)
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has non-finite lifetimeRealizedPnlSol: ${String(meta.lifetimeRealizedPnlSol)}.`,
      );
    }

    const HASH_REGEX = /^[a-f0-9]{64}$/i;
    if (
      typeof meta.baselineSnapshotSha256 !== "string" ||
      !HASH_REGEX.test(meta.baselineSnapshotSha256)
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid baselineSnapshotSha256: must be 64-hex string.`,
      );
    }

    if (
      typeof meta.walletSnapshotSha256 !== "string" ||
      !HASH_REGEX.test(meta.walletSnapshotSha256)
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid walletSnapshotSha256: must be 64-hex string.`,
      );
    }

    if (
      !Array.isArray(meta.settledSessionIds) ||
      !meta.settledSessionIds.every((s) => typeof s === "string")
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' settledSessionIds must be an array of strings.`,
      );
    }

    if (
      typeof meta.unresolvedTokensCount !== "number" ||
      !Number.isInteger(meta.unresolvedTokensCount) ||
      meta.unresolvedTokensCount < 0
    ) {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' has invalid unresolvedTokensCount: ${String(meta.unresolvedTokensCount)}.`,
      );
    }

    if (typeof meta.note !== "string") {
      throw new Error(
        `[GenerationsRegistry] [FATAL_SCHEMA] Generation '${key}' note must be a string.`,
      );
    }
  }

  if (activeCount !== 1) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_SCHEMA] Exactly one generation must have status 'ACTIVE', found ${activeCount}.`,
    );
  }

  const activeEntry = genMap[obj.activeGenerationId] as Record<string, unknown> | undefined;
  if (!activeEntry) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_SCHEMA] activeGenerationId '${obj.activeGenerationId}' not found in generations map.`,
    );
  }

  if (activeEntry.status !== "ACTIVE") {
    throw new Error(
      `[GenerationsRegistry] [FATAL_SCHEMA] activeGenerationId '${obj.activeGenerationId}' must have status 'ACTIVE', but found '${String(activeEntry.status)}'.`,
    );
  }

  return data as GenerationsRegistry;
}

/**
 * Builds verified Generation 1 metadata directly from the authoritative canonical wallet.
 * Fails closed if the canonical wallet is missing, corrupt, or hash-mismatched.
 */
export function buildGeneration1Metadata(
  canonicalWalletPath: string,
  expectedBaselineHash: string = GEN_01_BASELINE_HASH,
): WalletGenerationMetadata {
  if (!existsSync(canonicalWalletPath)) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_BOOTSTRAP] Cannot bootstrap generation 1: canonical wallet missing at ${canonicalWalletPath}. Refusing to fabricate baseline registry.`,
    );
  }

  let raw = "";
  try {
    raw = readFileSync(canonicalWalletPath, "utf8");
  } catch (err) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_BOOTSTRAP] Failed reading canonical wallet at ${canonicalWalletPath}: ${String(err)}. Refusing to fabricate baseline registry.`,
    );
  }

  const actualSha256 = computeFileSha256(canonicalWalletPath);
  if (actualSha256 !== expectedBaselineHash) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_BOOTSTRAP] Canonical wallet hash mismatch: expected ${expectedBaselineHash}, found ${actualSha256}. Refusing to bootstrap unverified baseline.`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_BOOTSTRAP] Canonical wallet at ${canonicalWalletPath} is corrupt or unparseable: ${String(err)}. Refusing to fabricate baseline registry.`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.currentBalanceSol !== "number" ||
    !Number.isFinite(parsed.currentBalanceSol) ||
    typeof parsed.totalSessionsCompleted !== "number" ||
    !Number.isInteger(parsed.totalSessionsCompleted) ||
    typeof parsed.allTimeRealizedPnlSol !== "number" ||
    !Number.isFinite(parsed.allTimeRealizedPnlSol) ||
    !Array.isArray(parsed.settledSessionIds)
  ) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_BOOTSTRAP] Canonical wallet at ${canonicalWalletPath} has invalid structure or non-finite numbers. Refusing to fabricate baseline registry.`,
    );
  }

  const initialBalanceSol =
    typeof parsed.initialBalanceSol === "number" && Number.isFinite(parsed.initialBalanceSol)
      ? parsed.initialBalanceSol
      : 10.0;
  const createdAtIso =
    typeof parsed.lastUpdatedMs === "number" &&
    Number.isFinite(parsed.lastUpdatedMs) &&
    parsed.lastUpdatedMs > 0
      ? new Date(parsed.lastUpdatedMs).toISOString()
      : "2026-10-13T17:00:00.000Z";
  const unresolvedTokensCount = Array.isArray(parsed.unresolvedTokens)
    ? parsed.unresolvedTokens.length
    : 0;

  return {
    generationId: GEN_01_BASELINE_ID,
    label: "Phase 12.93 Baseline Continuous Wallet (Frozen)",
    status: "ACTIVE",
    createdAtIso,
    initialBalanceSol,
    currentBalanceSol: parsed.currentBalanceSol,
    totalSessionsCompleted: parsed.totalSessionsCompleted,
    lifetimeRealizedPnlSol: parsed.allTimeRealizedPnlSol,
    baselineSnapshotSha256: expectedBaselineHash,
    walletSnapshotSha256: actualSha256,
    settledSessionIds: [...(parsed.settledSessionIds as string[])],
    unresolvedTokensCount,
    note: "Preserves 7 continuous settled sessions (-2.0740 SOL realized PnL; 7 closed losing trades on Oct 13 across 2 sessions = -0.5288 SOL) distinct from 12-session historical index.",
  };
}

/**
 * Backward compatibility alias for buildGeneration1Metadata.
 * Fails closed if the canonical wallet is missing or corrupt.
 */
export function buildDefaultGeneration1(
  workspaceRoot?: string,
  expectedBaselineHash?: string,
): WalletGenerationMetadata {
  const canonicalWallet = getCanonicalWalletPath(workspaceRoot);
  return buildGeneration1Metadata(canonicalWallet, expectedBaselineHash);
}

/**
 * Strictly read-only loader.
 * Throws [REGISTRY_NOT_INITIALIZED] if missing; does NOT synthesize or write any files.
 * Throws [FATAL_REGISTRY] if corrupt or schema-invalid.
 */
export function loadGenerationsRegistry(workspaceRoot?: string): GenerationsRegistry {
  const registryPath = getCanonicalGenerationsRegistryPath(workspaceRoot);
  if (!existsSync(registryPath)) {
    throw new Error(
      `[GenerationsRegistry] [REGISTRY_NOT_INITIALIZED] Generations registry missing at ${registryPath}. Explicit bootstrap required.`,
    );
  }

  try {
    const raw = readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    return validateGenerationsRegistry(parsed);
  } catch (err) {
    throw new Error(
      `[GenerationsRegistry] [FATAL_REGISTRY] Corrupted or unreadable generations registry at ${registryPath}: ${err instanceof Error ? err.message : String(err)}. Manual inspection required.`,
    );
  }
}

export interface BootstrapRegistryOptions {
  workspaceRoot?: string;
  expectedBaselineHash?: string;
  lockHandle?: ProcessLockHandle;
}

/**
 * Explicit, lock-protected initialization of the GenerationsRegistry.
 * Verifies canonical wallet, checks baseline hash, enforces process lock,
 * and writes the initial Generation 1 registry.
 * Strictly idempotent: safe to call repeatedly.
 *
 * SAFETY GUARANTEE (V2-02):
 * - Rechecks registry existence AFTER acquiring exclusive process lock.
 * - NEVER overwrites or resets an existing registry.
 * - Destructive reinitialization is prohibited.
 */
export function bootstrapGenerationsRegistry(
  options?: BootstrapRegistryOptions,
): GenerationsRegistry {
  const workspaceRoot = options?.workspaceRoot;
  const registryPath = getCanonicalGenerationsRegistryPath(workspaceRoot);

  // Acquire exclusive process lock before any state inspection or writes
  let lockHandle = options?.lockHandle;
  let ownsLock = false;
  if (!lockHandle) {
    const lockPath = getCanonicalLockPath(workspaceRoot);
    lockHandle = acquireProcessLock({
      processName: "bootstrapGenerationsRegistry",
      lockPath,
    });
    ownsLock = true;
  }

  try {
    // Recheck registry existence AFTER acquiring the lock to eliminate check-before-lock races (V2-02)
    if (existsSync(registryPath)) {
      return loadGenerationsRegistry(workspaceRoot);
    }

    const canonicalWallet = getCanonicalWalletPath(workspaceRoot);
    const gen1Meta = buildGeneration1Metadata(canonicalWallet, options?.expectedBaselineHash);

    const initialRegistry: GenerationsRegistry = {
      version: 1,
      activeGenerationId: GEN_01_BASELINE_ID,
      generations: {
        [GEN_01_BASELINE_ID]: gen1Meta,
      },
      updatedAtIso: new Date().toISOString(),
    };

    saveGenerationsRegistry(initialRegistry, workspaceRoot);
    return initialRegistry;
  } finally {
    if (ownsLock && lockHandle) {
      releaseProcessLock(lockHandle);
    }
  }
}

/**
 * Saves registry atomically with schema validation and fsync durability.
 *
 * DEFERRED GATE (Subphase 12.94-E / V2-03):
 * General live registry mutations during multi-generation lifecycle (activation, cutover, archiving)
 * MUST enforce verified exclusive process lock ownership, transition intent logging, and crash recovery.
 * In Subphase 12.94-A, saveGenerationsRegistry is invoked strictly during locked bootstrap and
 * isolated test fixtures; autonomous live mutations remain prohibited.
 */
export function saveGenerationsRegistry(
  registry: GenerationsRegistry,
  workspaceRoot?: string,
): void {
  const validated = validateGenerationsRegistry(registry);
  const registryPath = getCanonicalGenerationsRegistryPath(workspaceRoot);
  const dir = path.dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const payload: GenerationsRegistry = {
    ...validated,
    updatedAtIso: new Date().toISOString(),
  };

  const tempPath = `${registryPath}.${crypto.randomUUID()}.tmp`;
  const data = JSON.stringify(payload, null, 2);
  const fd = openSync(tempPath, "w");
  try {
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
  validateGenerationId(generationId);
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
  validateGenerationId(generationId);
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
