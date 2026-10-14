import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import url from "node:url";

export function computeSha256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function runRetirement(options = {}) {
  if (
    !options.workspaceRoot &&
    !process.env.RETIREMENT_TARGET_DIR &&
    (process.env.NODE_ENV === "test" || process.env.VITEST)
  ) {
    throw new Error(
      "[Retirement] [FATAL_TEST_SAFETY] Production migration utility cannot target default workspace during automated test execution without an explicit options.workspaceRoot.",
    );
  }
  const workspaceRoot = path.resolve(
    options.workspaceRoot || process.env.RETIREMENT_TARGET_DIR || ".",
  );
  const isFixture =
    Boolean(options.isFixtureTest) || process.env.RETIREMENT_FIXTURE_MODE === "true";
  const canonicalTmp = path.join(workspaceRoot, ".tmp");
  const backendTmp = path.join(workspaceRoot, "backend", ".tmp");
  const canonicalWallet = path.join(canonicalTmp, "virtual-wallet.json");
  const legacyWallet = path.join(backendTmp, "virtual-wallet.json");
  const lockFile = path.join(canonicalTmp, "paper-process.lock");

  console.log("[Retirement] Initiating controlled legacy wallet retirement...");

  // Guard against re-execution on live workspace where migration is already completed
  const canonicalMigrationRecord = path.join(canonicalTmp, "legacy-wallet-migration.json");
  if (fs.existsSync(canonicalMigrationRecord) && !isFixture) {
    console.log(
      `[Retirement] Notice: Legacy wallet retirement has already been completed and verified. Canonical ledger is active at ${canonicalWallet}. Re-execution blocked to protect ledger integrity.`,
    );
    return { status: "ALREADY_COMPLETED", canonicalMigrationRecord };
  }

  if (!fs.existsSync(canonicalTmp)) {
    fs.mkdirSync(canonicalTmp, { recursive: true });
  }

  // 1. Process Lock check and atomic acquisition via 'wx' flag
  const acquisitionNonce = crypto.randomUUID();
  const lockPayload = {
    pid: process.pid,
    acquisitionNonce,
    acquiredAtMs: Date.now(),
    hostname: os.hostname(),
    purpose: "legacy-wallet-retirement",
  };

  let lockFd = null;
  try {
    lockFd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(lockFd, JSON.stringify(lockPayload, null, 2), "utf8");
    fs.closeSync(lockFd);
    lockFd = null;
    console.log(
      `[Retirement] Acquired exclusive process lock (PID: ${process.pid}, Nonce: ${acquisitionNonce}).`,
    );
  } catch (err) {
    if (err && err.code === "EEXIST") {
      let existingLock = null;
      try {
        existingLock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch {
        // malformed or empty
      }
      if (existingLock && typeof existingLock.pid === "number") {
        throw new Error(
          `[Retirement] Aborting: Process lock is currently held by PID ${existingLock.pid} (${existingLock.hostname || "unknown"}, purpose: ${existingLock.purpose || "unknown"})`,
        );
      }
      throw new Error(
        `[Retirement] Aborting: Process lock file already exists at ${lockFile} and is malformed or inaccessible. Manual operator review required.`,
      );
    }
    throw err;
  }

  try {
    // 2. Verify existence of both files
    if (!fs.existsSync(canonicalWallet)) {
      throw new Error(`[Retirement] Canonical wallet missing at ${canonicalWallet}`);
    }
    if (!fs.existsSync(legacyWallet)) {
      console.log(
        `[Retirement] Legacy wallet already retired or absent at ${legacyWallet}. Nothing to retire.`,
      );
      return { status: "NOTHING_TO_RETIRE" };
    }

    // 3. Compute and compare SHA-256
    const canonicalHash = computeSha256(canonicalWallet);
    const legacyHash = computeSha256(legacyWallet);
    const canonicalContent = JSON.parse(fs.readFileSync(canonicalWallet, "utf8"));
    const legacyContent = JSON.parse(fs.readFileSync(legacyWallet, "utf8"));

    console.log(`[Retirement] Canonical Wallet SHA-256: ${canonicalHash}`);
    console.log(`[Retirement] Legacy Wallet SHA-256:    ${legacyHash}`);

    if (canonicalHash !== legacyHash) {
      throw new Error(
        `[Retirement] [FATAL_CONFLICT] Canonical and legacy wallet SHA-256 hashes do not match! Manual operator review required.`,
      );
    }

    if (canonicalContent.currentBalanceSol !== legacyContent.currentBalanceSol) {
      throw new Error(
        `[Retirement] [FATAL_CONFLICT] Balance mismatch: ${canonicalContent.currentBalanceSol} vs ${legacyContent.currentBalanceSol}`,
      );
    }

    console.log(
      `[Retirement] Hashes and balances verified identical (${canonicalContent.currentBalanceSol} SOL, ${canonicalContent.totalSessionsCompleted} sessions).`,
    );

    // 4. Create pre-retirement backup
    const backupDir = isFixture
      ? path.join(workspaceRoot, "backups", "pre-retirement")
      : path.join(workspaceRoot, "data", "backups", "pre-legacy-retirement-20261013");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    copyDirRecursive(canonicalTmp, path.join(backupDir, "root_tmp"));
    copyDirRecursive(backendTmp, path.join(backupDir, "backend_tmp"));
    console.log(`[Retirement] Pre-retirement backups created in ${backupDir}`);

    // 5. Rename legacy active wallet
    const retiredTimestamp = options.retiredTimestamp || "20261013-1700";
    const retiredLegacyWallet = path.join(
      backendTmp,
      `virtual-wallet.json.retired-${retiredTimestamp}`,
    );
    fs.renameSync(legacyWallet, retiredLegacyWallet);
    console.log(`[Retirement] Renamed legacy wallet to ${retiredLegacyWallet}`);

    // 6. Write migration record
    const migrationRecord = {
      action: "RETIRE_LEGACY_ACTIVE_WALLET",
      timestamp: new Date().toISOString(),
      retiredTimestamp,
      verifiedSha256: canonicalHash,
      canonicalPath: canonicalWallet,
      legacyOriginalPath: legacyWallet,
      legacyRetiredPath: retiredLegacyWallet,
      walletState: {
        currentBalanceSol: canonicalContent.currentBalanceSol,
        allTimeRealizedPnlSol: canonicalContent.allTimeRealizedPnlSol,
        totalSessionsCompleted: canonicalContent.totalSessionsCompleted,
        settledSessionIds: canonicalContent.settledSessionIds,
        unresolvedTokensCount: canonicalContent.unresolvedTokens
          ? canonicalContent.unresolvedTokens.length
          : 0,
      },
      operatorNote:
        "Legacy active mirror retired per Audit v11. Root .tmp/virtual-wallet.json is sole canonical ledger.",
    };

    const recordJson = JSON.stringify(migrationRecord, null, 2);
    fs.writeFileSync(path.join(canonicalTmp, "legacy-wallet-migration.json"), recordJson, "utf8");
    fs.writeFileSync(path.join(backendTmp, "legacy-wallet-migration.json"), recordJson, "utf8");
    console.log(
      "[Retirement] Migration record written to canonical and backend .tmp/legacy-wallet-migration.json",
    );
    return {
      status: "SUCCESS",
      canonicalHash,
      retiredLegacyWallet,
      migrationRecord,
    };
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // ignore
      }
    }
    // Release process lock verifying ownership and nonce
    try {
      if (fs.existsSync(lockFile)) {
        let currentLock = null;
        try {
          currentLock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        } catch (readErr) {
          console.error(
            `[Retirement] Refusing to unlink lock file at ${lockFile}: lock file is unreadable/corrupted (${String(readErr)})`,
          );
        }
        if (
          currentLock &&
          currentLock.pid === process.pid &&
          currentLock.acquisitionNonce === acquisitionNonce
        ) {
          fs.unlinkSync(lockFile);
          console.log("[Retirement] Released process lock cleanly.");
        } else if (currentLock) {
          console.warn(
            `[Retirement] Refusing to unlink lock file at ${lockFile}: owned by different process/nonce (current PID: ${currentLock.pid}, expected: ${process.pid}).`,
          );
        }
      }
    } catch (err) {
      console.error("[Retirement] Failed to release lock:", err);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url))
) {
  runRetirement().catch((err) => {
    console.error("[Retirement] ERROR:", err);
    process.exit(1);
  });
}
