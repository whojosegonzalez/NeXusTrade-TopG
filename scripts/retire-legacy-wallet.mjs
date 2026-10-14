import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function computeSha256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function copyDirRecursive(src, dest) {
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

async function runRetirement() {
  const workspaceRoot = path.resolve(".");
  const canonicalTmp = path.join(workspaceRoot, ".tmp");
  const backendTmp = path.join(workspaceRoot, "backend", ".tmp");
  const canonicalWallet = path.join(canonicalTmp, "virtual-wallet.json");
  const legacyWallet = path.join(backendTmp, "virtual-wallet.json");
  const lockFile = path.join(canonicalTmp, "paper-process.lock");

  console.log("[Retirement] Initiating controlled legacy wallet retirement...");

  // 1. Process Lock check
  if (fs.existsSync(lockFile)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      throw new Error(
        `[Retirement] Aborting: Process lock is currently held by PID ${lockData.pid} (${lockData.hostname})`,
      );
    } catch (err) {
      if (err.message.includes("Aborting")) throw err;
      // Stale or corrupted lock
    }
  }

  // Acquire exclusive process lock
  const lockPayload = {
    pid: process.pid,
    acquiredAtMs: Date.now(),
    hostname: "windows-pc",
    purpose: "legacy-wallet-retirement",
  };
  fs.writeFileSync(lockFile, JSON.stringify(lockPayload, null, 2), "utf8");
  console.log(`[Retirement] Acquired process lock (PID: ${process.pid}).`);

  try {
    // 2. Verify existence of both files
    if (!fs.existsSync(canonicalWallet)) {
      throw new Error(`[Retirement] Canonical wallet missing at ${canonicalWallet}`);
    }
    if (!fs.existsSync(legacyWallet)) {
      console.log(
        `[Retirement] Legacy wallet already retired or absent at ${legacyWallet}. Nothing to retire.`,
      );
      return;
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
    const backupDir = path.join(workspaceRoot, "data", "backups", "pre-legacy-retirement-20261013");
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    copyDirRecursive(canonicalTmp, path.join(backupDir, "root_tmp"));
    copyDirRecursive(backendTmp, path.join(backupDir, "backend_tmp"));
    console.log(`[Retirement] Pre-retirement backups created in ${backupDir}`);

    // 5. Rename legacy active wallet
    const retiredTimestamp = "20261013-1700";
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
  } finally {
    // Release process lock
    try {
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      console.log("[Retirement] Released process lock.");
    } catch (err) {
      console.error("[Retirement] Failed to release lock:", err);
    }
  }

  console.log("[Retirement] Controlled legacy wallet retirement complete successfully.");
}

runRetirement().catch((err) => {
  console.error("[Retirement] ERROR:", err);
  process.exit(1);
});
