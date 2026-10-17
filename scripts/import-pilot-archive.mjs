#!/usr/bin/env node
/**
 * Phase 12.94-D Milestone D.2.4: Pilot Archive Import & Verification Script
 *
 * Implements isolated, safe import of Linux/Fedora pilot session archives into
 * the Windows research environment.
 *
 * Usage:
 *   node scripts/import-pilot-archive.mjs --source=/path/to/pilot-sess-xxx [--target-root=.tmp/pilot-imports/sessions]
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

  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--source=")) {
      source = arg.slice("--source=".length);
    } else if (arg.startsWith("--target-root=")) {
      targetRoot = arg.slice("--target-root=".length);
    } else if (arg === "--no-compatibility") {
      runCompatibility = false;
    }
  }

  return { source, targetRoot, runCompatibility };
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
  const { source, targetRoot } = parseArgs(process.argv);

  if (!source) {
    console.error("[ERROR] Missing required --source argument.");
    console.error("Usage: node scripts/import-pilot-archive.mjs --source=<path-to-session-dir>");
    process.exit(1);
  }

  const resolvedSource = path.resolve(source);
  if (!fs.existsSync(resolvedSource)) {
    console.error(`[ERROR] Source path does not exist: ${resolvedSource}`);
    process.exit(1);
  }

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

  const resolvedTargetRoot = path.resolve(targetRoot);
  fs.mkdirSync(resolvedTargetRoot, { recursive: true });

  const sessionFolderName = path.basename(resolvedSource);
  const targetDir = path.join(resolvedTargetRoot, sessionFolderName);

  if (resolvedSource !== targetDir) {
    console.log(`[IMPORT] Copying session files to isolated target: ${targetDir}`);
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(targetDir, { recursive: true });

    const entries = fs.readdirSync(resolvedSource, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile()) {
        fs.copyFileSync(path.join(resolvedSource, ent.name), path.join(targetDir, ent.name));
      }
    }
  }

  console.log(`[IMPORT] Re-verifying target manifest integrity: ${targetDir}`);
  const targetManifestResult = verifyManifest(targetDir);

  if (!targetManifestResult.valid) {
    console.error(`[ERROR] Target directory failed manifest verification post-copy!`);
    process.exit(1);
  }

  console.log(
    `[IMPORT_SUCCESS] Successfully imported and verified pilot session into isolated research directory:`,
  );
  console.log(`  Path: ${targetDir}`);
  console.log(`  Status: VALID SHA-256 MANIFEST VERIFIED`);
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
