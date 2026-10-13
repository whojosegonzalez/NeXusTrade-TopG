import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProcessLockDescriptor {
  pid: number;
  processName: string;
  sessionId?: string | undefined;
  acquiredAtMs: number;
  hostname: string;
}

export interface ProcessLockHandle {
  lockPath: string;
  fd: number;
  descriptor: ProcessLockDescriptor;
}

export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let cur = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(cur, "pnpm-workspace.yaml")) || existsSync(path.join(cur, ".git"))) {
      return cur;
    }
    const pkgJson = path.join(cur, "package.json");
    if (existsSync(pkgJson)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgJson, "utf8"));
        if (parsed.name === "nexustrade-otis") {
          return cur;
        }
      } catch {
        // ignore parse error
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(startDir);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ESRCH") {
      return false; // Process does not exist
    }
    // EPERM means process exists but owned by another user or protected
    if (code === "EPERM") {
      return true;
    }
    return true; // Err on side of safety
  }
}

export function resolveLockPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  const root = findWorkspaceRoot();
  return path.resolve(root, ".tmp/paper-process.lock");
}

export function acquireProcessLock(options: {
  processName: string;
  sessionId?: string | undefined;
  lockPath?: string | undefined;
}): ProcessLockHandle {
  const lockPath = resolveLockPath(options.lockPath);
  const lockDir = path.dirname(lockPath);
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }

  const descriptor: ProcessLockDescriptor = {
    pid: process.pid,
    processName: options.processName,
    sessionId: options.sessionId,
    acquiredAtMs: Date.now(),
    hostname: os.hostname(),
  };
  const payload = JSON.stringify(descriptor, null, 2);

  let fd: number;
  try {
    // Atomic exclusive creation via 'wx' flag
    fd = openSync(lockPath, "wx");
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "EEXIST") {
      // Check existing lock descriptor for process liveness
      let existingDesc: ProcessLockDescriptor | null = null;
      try {
        const raw = readFileSync(lockPath, "utf8");
        existingDesc = JSON.parse(raw) as ProcessLockDescriptor;
      } catch {
        // Malformed lock file
      }

      if (existingDesc && typeof existingDesc.pid === "number") {
        if (isProcessAlive(existingDesc.pid)) {
          throw new Error(
            `[ProcessLock] [FATAL] Exclusive lock held by active process (PID: ${existingDesc.pid}, Process: ${existingDesc.processName}, Session: ${existingDesc.sessionId ?? "N/A"}, Acquired: ${new Date(existingDesc.acquiredAtMs).toISOString()}). Execution halted to prevent concurrent ledger mutations.`,
          );
        } else {
          console.warn(
            `[ProcessLock] [STALE_LOCK] Owning process with PID ${existingDesc.pid} is no longer active in the OS. Safely reclaiming stale lock at ${lockPath}.`,
          );
          try {
            unlinkSync(lockPath);
          } catch (unlinkErr) {
            throw new Error(
              `[ProcessLock] [FATAL] Failed to clean up verified stale lock at ${lockPath}: ${String(unlinkErr)}`,
            );
          }
          // Retry atomic acquisition
          fd = openSync(lockPath, "wx");
        }
      } else {
        // Corrupt or unparseable lock file without valid PID
        throw new Error(
          `[ProcessLock] [FATAL] Corrupted or unreadable lock file detected at ${lockPath}. Manual operator inspection required before proceeding.`,
        );
      }
    } else {
      throw err;
    }
  }

  try {
    writeFileSync(fd, payload, "utf8");
  } catch (writeErr) {
    try {
      closeSync(fd);
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
    throw writeErr;
  }

  return {
    lockPath,
    fd,
    descriptor,
  };
}

export function releaseProcessLock(handle: ProcessLockHandle): void {
  try {
    if (existsSync(handle.lockPath)) {
      try {
        const raw = readFileSync(handle.lockPath, "utf8");
        const current = JSON.parse(raw) as ProcessLockDescriptor;
        if (current.pid === process.pid) {
          unlinkSync(handle.lockPath);
        }
      } catch {
        unlinkSync(handle.lockPath);
      }
    }
  } catch (err) {
    console.warn(`[ProcessLock] Warning: Error releasing lock at ${handle.lockPath}:`, err);
  } finally {
    try {
      closeSync(handle.fd);
    } catch {
      // ignore if already closed
    }
  }
}
