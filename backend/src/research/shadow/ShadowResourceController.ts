/**
 * Phase 12.94-D Milestone D.2.2: Shadow Resource Controller & Path Confinement
 *
 * Implements deterministic virtual-time rate limiting, token bucket controls,
 * backoff scheduling, storage quota monitors, and strict path confinement.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  IVirtualClock,
  PathConfinementOptions,
  PathConfinementResult,
  SessionIdValidationResult,
} from "./ShadowCollectorTypes.js";

/**
 * Token bucket rate limiter tied to virtual time.
 */
export class VirtualTokenBucket {
  private readonly maxTokens: number;
  private readonly refillRatePerSecond: number;
  private tokens: number;
  private lastRefillMs: number;
  private readonly clock: IVirtualClock;

  constructor(options: { maxTokens: number; refillRatePerSecond: number; clock: IVirtualClock }) {
    this.maxTokens = options.maxTokens;
    this.refillRatePerSecond = options.refillRatePerSecond;
    this.clock = options.clock;
    this.tokens = options.maxTokens;
    this.lastRefillMs = options.clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSec = Math.max(0, (now - this.lastRefillMs) / 1000);
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsedSec * this.refillRatePerSecond);
    this.lastRefillMs = now;
  }

  public tryConsume(tokensRequested: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokensRequested) {
      this.tokens -= tokensRequested;
      return true;
    }
    return false;
  }

  public getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Deterministic exponential backoff calculator with pseudo-jitter.
 */
export class DeterministicBackoffCalculator {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxAttempts: number;

  constructor(options?: { baseMs?: number; maxMs?: number; maxAttempts?: number }) {
    this.baseMs = options?.baseMs ?? 500;
    this.maxMs = options?.maxMs ?? 5000;
    this.maxAttempts = options?.maxAttempts ?? 5;
  }

  public computeBackoffMs(attempt: number): number {
    if (attempt >= this.maxAttempts) {
      return -1; // Exhausted
    }
    // Deterministic backoff: base * 2^attempt with small deterministic offset
    const exp = Math.min(this.maxMs, this.baseMs * Math.pow(2, attempt));
    const deterministicJitter = (attempt * 37) % 50; // Reproducible pseudo-jitter
    return Math.min(this.maxMs, exp + deterministicJitter);
  }

  public getDelayMs(attempt: number): number {
    const delay = this.computeBackoffMs(attempt);
    return delay > 0 ? delay : this.baseMs;
  }
}

/**
 * Validates a session ID to prevent path traversal or special characters (D22-S01).
 */
export function validateSessionId(sessionId: string): SessionIdValidationResult {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    const error = "SESSION_ID_EMPTY";
    return { isValid: false, error, rejectionReason: error };
  }
  // Strictly disallow traversal sequences, separators, and forbidden filesystem chars
  if (
    sessionId.includes("..") ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes(":") ||
    sessionId.includes("\0")
  ) {
    const error = "SESSION_ID_CONTAINS_PATH_SEPARATORS_OR_TRAVERSAL";
    return { isValid: false, error, rejectionReason: error };
  }
  // Disallow excessively long IDs (> 100 chars)
  if (sessionId.length > 100) {
    const error = "SESSION_ID_EXCEEDS_MAX_LENGTH";
    return { isValid: false, error, rejectionReason: error };
  }
  // Enforce strict alphanumeric, underscore, hyphen, dot format
  if (!/^[a-zA-Z0-9_\-.]+$/.test(sessionId)) {
    const error = "SESSION_ID_INVALID_CHARACTERS";
    return { isValid: false, error, rejectionReason: error };
  }
  return { isValid: true, sanitizedSessionId: sessionId };
}

/**
 * Verifies strict path confinement against forbidden canonical directories and allowed roots (D22-A01, D22-S01).
 */
export function validatePathConfinement(
  targetPath: string,
  options?: PathConfinementOptions,
): PathConfinementResult {
  const repoRoot = path.resolve(options?.repoRootDir ?? process.cwd());
  const normalizedTarget = path.resolve(targetPath);

  // 1. If allowedRoot is provided, target must be inside allowedRoot
  if (options?.allowedRoot) {
    const normalizedAllowed = path.resolve(options.allowedRoot);
    if (
      normalizedTarget !== normalizedAllowed &&
      !normalizedTarget.startsWith(normalizedAllowed + path.sep)
    ) {
      return {
        isConfinementValid: false,
        resolvedPath: normalizedTarget,
        rejectionReason: `PATH_CONFINEMENT_VIOLATION: Target path '${normalizedTarget}' escapes allowed root '${normalizedAllowed}'.`,
      };
    }
  }

  // Default forbidden paths that mock collector MUST NEVER write to:
  const forbidden = (
    options?.forbiddenPaths ?? [
      path.join(repoRoot, ".tmp", "telemetry", "sessions"),
      path.join(repoRoot, ".tmp", "sessions"),
      path.join(repoRoot, ".tmp", "virtual-wallet.json"),
      path.join(repoRoot, "backend"),
      path.join(repoRoot, "audit"),
      path.join(repoRoot, "scripts"),
    ]
  ).map((p) => path.resolve(p));

  // 2. Direct check of normalized target against forbidden paths
  for (const f of forbidden) {
    if (normalizedTarget === f || normalizedTarget.startsWith(f + path.sep)) {
      return {
        isConfinementValid: false,
        resolvedPath: normalizedTarget,
        rejectionReason: `PATH_CONFINEMENT_VIOLATION: Target path '${normalizedTarget}' resolves inside forbidden path '${f}'.`,
      };
    }
  }

  // 3. Symlink / Reparse inspection:
  // Walk upwards from normalizedTarget to find the closest existing ancestor directory
  let closestExisting = normalizedTarget;
  const missingSegments: string[] = [];
  while (!fs.existsSync(closestExisting)) {
    const parent = path.dirname(closestExisting);
    if (parent === closestExisting) break; // reached filesystem root
    missingSegments.unshift(path.basename(closestExisting));
    closestExisting = parent;
  }

  if (fs.existsSync(closestExisting)) {
    try {
      const realAncestor = fs.realpathSync(closestExisting);
      const effectiveTarget =
        missingSegments.length > 0 ? path.resolve(realAncestor, ...missingSegments) : realAncestor;

      // Check realAncestor and effectiveTarget against forbidden paths
      for (const f of forbidden) {
        if (
          realAncestor === f ||
          realAncestor.startsWith(f + path.sep) ||
          effectiveTarget === f ||
          effectiveTarget.startsWith(f + path.sep)
        ) {
          return {
            isConfinementValid: false,
            resolvedPath: effectiveTarget,
            rejectionReason: `SYMLINK_CONFINEMENT_VIOLATION: Real path '${effectiveTarget}' resolves inside forbidden path '${f}'.`,
          };
        }
      }

      // If allowedRoot was specified, verify both realAncestor and effectiveTarget remain inside real allowedRoot
      if (options?.allowedRoot) {
        const normalizedAllowed = path.resolve(options.allowedRoot);
        const realAllowed = fs.existsSync(normalizedAllowed)
          ? fs.realpathSync(normalizedAllowed)
          : normalizedAllowed;

        if (
          effectiveTarget !== realAllowed &&
          !effectiveTarget.startsWith(realAllowed + path.sep)
        ) {
          return {
            isConfinementValid: false,
            resolvedPath: effectiveTarget,
            rejectionReason: `SYMLINK_CONFINEMENT_VIOLATION: Real target '${effectiveTarget}' escapes allowed root '${realAllowed}'.`,
          };
        }
      }

      return {
        isConfinementValid: true,
        resolvedPath: effectiveTarget,
      };
    } catch (err: unknown) {
      return {
        isConfinementValid: false,
        resolvedPath: normalizedTarget,
        rejectionReason: `PATH_RESOLUTION_ERROR: Unable to resolve real path for '${closestExisting}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    isConfinementValid: true,
    resolvedPath: normalizedTarget,
  };
}

/**
 * Resource tripwire and emergency kill-switch monitor.
 */
export class ShadowResourceController {
  private readonly clock: IVirtualClock;
  private readonly maxSessionDiskBytes: number;
  private readonly maxRssBytes: number;
  private readonly killSwitchPath: string;
  private currentDiskBytesWritten: number = 0;
  private memoryUsageOverride?: number | undefined;

  constructor(options: {
    clock: IVirtualClock;
    maxSessionDiskBytes?: number | undefined;
    maxRssBytes?: number | undefined;
    killSwitchPath?: string | undefined;
  }) {
    this.clock = options.clock;
    this.maxSessionDiskBytes = options.maxSessionDiskBytes ?? 50 * 1024 * 1024; // 50 MB
    this.maxRssBytes = options.maxRssBytes ?? 256 * 1024 * 1024; // 256 MB
    this.killSwitchPath = path.resolve(options.killSwitchPath ?? ".tmp/SHADOW_KILL_SWITCH");
  }

  public getMaxDiskBytes(): number {
    return this.maxSessionDiskBytes;
  }

  public checkWriteAdmission(bytesToWrite: number): void {
    if (this.currentDiskBytesWritten + bytesToWrite > this.maxSessionDiskBytes) {
      throw new Error(
        `[ShadowResourceController] [STORAGE_QUOTA_EXCEEDED] Projected write of ${bytesToWrite} bytes exceeds storage quota limit (current: ${this.currentDiskBytesWritten}, max: ${this.maxSessionDiskBytes}).`,
      );
    }
  }

  public recordBytesWritten(bytes: number): void {
    this.currentDiskBytesWritten += bytes;
  }

  public getBytesWritten(): number {
    return this.currentDiskBytesWritten;
  }

  public setMemoryUsageOverride(bytes?: number): void {
    this.memoryUsageOverride = bytes;
  }

  public isStorageQuotaExceeded(): boolean {
    return this.currentDiskBytesWritten > this.maxSessionDiskBytes;
  }

  public isMemoryQuotaExceeded(): boolean {
    const currentRss = this.memoryUsageOverride ?? process.memoryUsage().rss;
    return currentRss > this.maxRssBytes;
  }

  public isKillSwitchTriggered(): boolean {
    try {
      return fs.existsSync(this.killSwitchPath);
    } catch {
      return false;
    }
  }
}
