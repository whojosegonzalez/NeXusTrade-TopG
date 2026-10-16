/**
 * Phase 12.94-D Milestone D.2.2: Shadow Resource Controller & Path Confinement
 *
 * Implements deterministic virtual-time rate limiting, token bucket controls,
 * backoff scheduling, storage quota monitors, and strict path confinement.
 */

import fs from "node:fs";
import path from "node:path";
import type { IVirtualClock, PathConfinementResult } from "./ShadowCollectorTypes.js";

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
}

/**
 * Verifies strict path confinement against forbidden canonical directories (D22-A01, D22-A05).
 */
export function validatePathConfinement(
  targetPath: string,
  options?: {
    repoRootDir?: string;
    forbiddenPaths?: string[];
  },
): PathConfinementResult {
  const repoRoot = path.resolve(options?.repoRootDir ?? process.cwd());
  const normalizedTarget = path.resolve(targetPath);

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

  // 1. Check for directory traversal tricks (e.g. resolving into forbidden root)
  for (const f of forbidden) {
    if (normalizedTarget === f || normalizedTarget.startsWith(f + path.sep)) {
      return {
        isConfinementValid: false,
        resolvedPath: normalizedTarget,
        rejectionReason: `PATH_CONFINEMENT_VIOLATION: Target path '${normalizedTarget}' resolves inside forbidden path '${f}'.`,
      };
    }
  }

  // 2. Check if the target is a symlink or contains a symlink in its ancestry pointing to forbidden paths
  if (fs.existsSync(normalizedTarget)) {
    try {
      const real = fs.realpathSync(normalizedTarget);
      for (const f of forbidden) {
        if (real === f || real.startsWith(f + path.sep)) {
          return {
            isConfinementValid: false,
            resolvedPath: real,
            rejectionReason: `SYMLINK_CONFINEMENT_VIOLATION: Real path '${real}' resolves inside forbidden path '${f}'.`,
          };
        }
      }
    } catch {
      // Ignored if cannot resolve realpath
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
