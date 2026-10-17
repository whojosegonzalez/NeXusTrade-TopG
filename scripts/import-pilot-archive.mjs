#!/usr/bin/env node
/**
 * Phase 12.94-D Milestone D.2.4: Pilot Archive Import & Verification Script
 *
 * Implements isolated, safe import of Linux/Fedora pilot session archives into
 * the Windows research environment.
 *
 * Non-Destructive Guarantees (D24F-04):
 * - Rejects existing target sessions by default; requires explicit '--overwrite'.
 * - Verifies source manifest BEFORE touching target or staging.
 * - Stages files in a temporary disposable directory.
 * - Atomically publishes only verified sessions.
 *
 * Usage:
 *   node scripts/import-pilot-archive.mjs --source=/path/to/pilot-sess-xxx [--target-root=.tmp/pilot-imports/sessions] [--overwrite]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_IMPORT_ROOT = ".tmp/pilot-imports/sessions";
const MANIFEST_FILENAME = "manifest.json";

function parseArgs(argv) {
  let source = null;
  let targetRoot = DEFAULT_IMPORT_ROOT;
  let runCompatibility = true;
  let allowOverwrite = false;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--source=")) {
      source = arg.slice("--source=".length);
    } else if (arg.startsWith("--target-root=")) {
      targetRoot = arg.slice("--target-root=".length);
    } else if (arg === "--no-compatibility") {
      runCompatibility = false;
    } else if (arg === "--overwrite") {
      allowOverwrite = true;
    }
  }

  return { source, targetRoot, runCompatibility, allowOverwrite };
}

function computeSha256(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function verifyManifest(sessionDir) {
  const manifestPath = path.join(sessionDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      missingFiles: [MANIFEST_FILENAME],
      mismatchedFiles: [],
      extraFiles: [],
      error: `Missing manifest file: ${MANIFEST_FILENAME}`,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return {
      valid: false,
      missingFiles: [],
      mismatchedFiles: [MANIFEST_FILENAME],
      extraFiles: [],
      error: `Corrupt manifest JSON: ${String(err)}`,
    };
  }

  const dirEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
  const diskFiles = new Set(
    dirEntries.filter((e) => e.isFile() && e.name !== MANIFEST_FILENAME).map((e) => e.name),
  );

  const manifestFileMap = new Map();
  const missingFiles = [];
  const mismatchedFiles = [];

  for (const entry of manifest.files) {
    manifestFileMap.set(entry.filename, entry);
    if (!diskFiles.has(entry.filename)) {
      missingFiles.push(entry.filename);
      continue;
    }

    const filePath = path.join(sessionDir, entry.filename);
    const hash = computeSha256(filePath);
    const size = fs.statSync(filePath).size;

    if (hash !== entry.sha256 || size !== entry.sizeBytes) {
      mismatchedFiles.push(entry.filename);
    }
  }

  const extraFiles = [];
  for (const diskFile of diskFiles) {
    if (!manifestFileMap.has(diskFile)) {
      extraFiles.push(diskFile);
    }
  }

  const valid =
    missingFiles.length === 0 && mismatchedFiles.length === 0 && extraFiles.length === 0;

  return {
    valid,
    missingFiles,
    mismatchedFiles,
    extraFiles,
    sessionId: manifest.sessionId,
    generationId: manifest.generationId,
    fileCount: manifest.files.length,
  };
}

export async function main() {
  const { source, targetRoot, allowOverwrite } = parseArgs(process.argv);

  if (!source) {
    console.error("[ERROR] Missing required --source argument.");
    console.error(
      "Usage: node scripts/import-pilot-archive.mjs --source=<path-to-session-dir> [--overwrite]",
    );
    process.exit(1);
  }

  const resolvedSource = path.resolve(source);
  if (!fs.existsSync(resolvedSource)) {
    console.error(`[ERROR] Source path does not exist: ${resolvedSource}`);
    process.exit(1);
  }

  const resolvedTargetRoot = path.resolve(targetRoot);
  const resolvedHistoricalTelemetry = path.resolve(".tmp/telemetry/sessions");
  if (resolvedTargetRoot.startsWith(resolvedHistoricalTelemetry)) {
    console.error(
      `[ERROR] Target root cannot resolve inside protected telemetry directory: ${resolvedTargetRoot}`,
    );
    process.exit(1);
  }

  const sessionFolderName = path.basename(resolvedSource);
  const targetDir = path.join(resolvedTargetRoot, sessionFolderName);

  // 1. Collision Check: Prohibit clobbering existing target without explicit --overwrite
  const targetExists = fs.existsSync(targetDir);
  if (targetExists && !allowOverwrite) {
    console.error(
      `[ERROR] Destination directory already exists: ${targetDir}. Pass --overwrite to authorize replacement.`,
    );
    process.exit(1);
  }

  // 2. Mandatory Source Manifest Verification BEFORE touching anything
  console.log(`[IMPORT] Verifying source manifest integrity: ${resolvedSource}`);
  const sourceManifestResult = verifyManifest(resolvedSource);

  if (!sourceManifestResult.valid) {
    console.error(`[ERROR] Source directory failed manifest verification:`);
    console.error(`  Missing files: ${sourceManifestResult.missingFiles.join(", ") || "none"}`);
    console.error(
      `  Mismatched files: ${sourceManifestResult.mismatchedFiles.join(", ") || "none"}`,
    );
    console.error(`  Unexpected files: ${sourceManifestResult.extraFiles.join(", ") || "none"}`);
    process.exit(1);
  }

  console.log(
    `[IMPORT] Source manifest VALID (Session: ${sourceManifestResult.sessionId}, Generation: ${sourceManifestResult.generationId}, Files: ${sourceManifestResult.fileCount})`,
  );

  fs.mkdirSync(resolvedTargetRoot, { recursive: true });

  if (resolvedSource === targetDir) {
    console.log(`[IMPORT_SUCCESS] In-place session verified at: ${targetDir}`);
    return;
  }

  // 3. Stage import in temporary disposable directory
  const stagingDir = path.join(
    resolvedTargetRoot,
    `.staging-${sessionFolderName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  fs.mkdirSync(stagingDir, { recursive: true });

  let stagingPublished = false;

  try {
    console.log(`[IMPORT] Copying session files to temporary staging: ${stagingDir}`);
    const entries = fs.readdirSync(resolvedSource, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile()) {
        fs.copyFileSync(path.join(resolvedSource, ent.name), path.join(stagingDir, ent.name));
      }
    }

    // 4. Re-verify staging manifest integrity
    const stagingManifestResult = verifyManifest(stagingDir);
    if (!stagingManifestResult.valid) {
      console.error(`[ERROR] Staging directory failed manifest verification post-copy!`);
      process.exit(1);
    }

    // 5. Atomically publish staging to targetDir
    if (targetExists) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    try {
      fs.renameSync(stagingDir, targetDir);
      stagingPublished = true;
    } catch {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const ent of fs.readdirSync(stagingDir, { withFileTypes: true })) {
        if (ent.isFile()) {
          fs.copyFileSync(path.join(stagingDir, ent.name), path.join(targetDir, ent.name));
        }
      }
      stagingPublished = true;
    }

    console.log(`[IMPORT] Re-verifying published target manifest integrity: ${targetDir}`);
    const targetManifestResult = verifyManifest(targetDir);
    if (!targetManifestResult.valid) {
      console.error(`[ERROR] Published target directory failed manifest verification!`);
      process.exit(1);
    }

    console.log(
      `[IMPORT_SUCCESS] Successfully imported and verified pilot session into isolated research directory:`,
    );
    console.log(`  Path: ${targetDir}`);
    console.log(`  Status: VALID SHA-256 MANIFEST VERIFIED`);
  } finally {
    if (!stagingPublished && fs.existsSync(stagingDir)) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // cleanup ignore
      }
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
) {
  main().catch((err) => {
    console.error(`[FATAL] Import failed: ${err}`);
    process.exit(1);
  });
}
