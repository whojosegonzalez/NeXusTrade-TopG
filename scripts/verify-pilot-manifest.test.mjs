/**
 * Phase 12.94-D.2.6: Offline Unit Tests for Read-Only Standalone Pilot Manifest Verifier (G2-F8)
 *
 * Verifies:
 * 1. CLI argument parsing (--help, --source=<path>, positional path, invalid arguments).
 * 2. Missing argument, nonexistent path, and non-directory rejection.
 * 3. Valid sealed session manifest returns exit code 0.
 * 4. Corrupted or tampered files return exit code 1.
 * 5. Extraneous unmanifested files return exit code 1.
 * 6. Missing compiled backend dependencies fail closed with exit code 1 and zero disk mutation (no auto-build).
 * 7. Strictly read-only invariant: session directory files and metadata remain 100% unaltered.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs, runVerifyManifestCli } from "./verify-pilot-manifest.mjs";
import { generateSessionExportManifest } from "../backend/dist/research/pilot/PilotExportManifest.js";
import { saveB2EventSession } from "../backend/dist/research/pilot/EventSessionEvidenceCapture.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors in test teardown
    }
  }
});

function createTempDir(prefix = "manifest-test-") {
  const tmpBase = path.join(rootDir, ".tmp");
  if (!fs.existsSync(tmpBase)) {
    fs.mkdirSync(tmpBase, { recursive: true });
  }
  const dir = fs.mkdtempSync(path.join(tmpBase, prefix));
  tempDirs.push(dir);
  return dir;
}

function computeDirFingerprints(dir) {
  const files = fs.readdirSync(dir).sort();
  const fingerprints = {};
  for (const f of files) {
    const filePath = path.join(dir, f);
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    fingerprints[f] = {
      size: stat.size,
      sha256: hash,
    };
  }
  return fingerprints;
}

test("parseArgs correctly handles flags, positionals, and invalid arguments", () => {
  // Help flag
  assert.deepEqual(parseArgs(["node", "verify.mjs", "--help"]), { source: null, help: true });
  assert.deepEqual(parseArgs(["node", "verify.mjs", "-h"]), { source: null, help: true });

  // Source flag
  assert.deepEqual(parseArgs(["node", "verify.mjs", "--source=/path/to/session"]), {
    source: "/path/to/session",
    help: false,
  });

  // Positional source
  assert.deepEqual(parseArgs(["node", "verify.mjs", "/path/to/session"]), {
    source: "/path/to/session",
    help: false,
  });

  // Unknown flag
  const resultUnknown = parseArgs(["node", "verify.mjs", "--invalid-flag"]);
  assert.equal(resultUnknown.source, null);
  assert.equal(resultUnknown.help, false);
  assert.match(resultUnknown.error, /Unrecognized argument/);
});

test("runVerifyManifestCli rejects missing arguments, nonexistent paths, and non-directories", async () => {
  // Missing path
  assert.equal(await runVerifyManifestCli(["node", "verify.mjs"]), 1);

  // Nonexistent path
  assert.equal(
    await runVerifyManifestCli([
      "node",
      "verify.mjs",
      "--source=" + path.join(rootDir, "nonexistent-dir-12345"),
    ]),
    1,
  );

  // File instead of directory
  assert.equal(
    await runVerifyManifestCli([
      "node",
      "verify.mjs",
      "--source=" + path.join(__dirname, "verify-pilot-manifest.mjs"),
    ]),
    1,
  );
});

test("runVerifyManifestCli validates a valid session manifest without mutating files", async () => {
  const sessionDir = createTempDir("valid-sess-");

  // Create sample session files
  fs.writeFileSync(
    path.join(sessionDir, "session-summary.json"),
    JSON.stringify({ sessionId: "sess-valid", status: "FINALIZED" }, null, 2),
  );
  fs.writeFileSync(
    path.join(sessionDir, "candidate-decisions.jsonl"),
    JSON.stringify({ eventId: "evt-1", mint: "Mint111111111111111111111111111111111111111" }) +
      "\n",
  );

  // Generate authoritative manifest
  await generateSessionExportManifest(sessionDir, "sess-valid", "gen-1");
  assert.ok(fs.existsSync(path.join(sessionDir, "manifest.json")));

  const before = computeDirFingerprints(sessionDir);

  // Run verifier
  const exitCode = await runVerifyManifestCli([
    "node",
    "scripts/verify-pilot-manifest.mjs",
    `--source=${sessionDir}`,
  ]);

  assert.equal(exitCode, 0);

  const after = computeDirFingerprints(sessionDir);
  assert.deepEqual(before, after, "Verifier must not mutate any file or file content");
});

test("runVerifyManifestCli rejects a tampered file in session directory without mutating files", async () => {
  const sessionDir = createTempDir("tampered-sess-");

  fs.writeFileSync(
    path.join(sessionDir, "session-summary.json"),
    JSON.stringify({ sessionId: "sess-tampered", status: "FINALIZED" }, null, 2),
  );
  fs.writeFileSync(
    path.join(sessionDir, "candidate-decisions.jsonl"),
    JSON.stringify({ eventId: "evt-1" }) + "\n",
  );

  await generateSessionExportManifest(sessionDir, "sess-tampered", "gen-1");

  // Tamper with candidate-decisions.jsonl after manifest generation
  fs.appendFileSync(path.join(sessionDir, "candidate-decisions.jsonl"), "tampered byte\n");

  const before = computeDirFingerprints(sessionDir);

  const exitCode = await runVerifyManifestCli([
    "node",
    "scripts/verify-pilot-manifest.mjs",
    `--source=${sessionDir}`,
  ]);

  assert.equal(exitCode, 1);

  const after = computeDirFingerprints(sessionDir);
  assert.deepEqual(
    before,
    after,
    "Verifier must remain strictly non-mutating on tampered directories",
  );
});

test("runVerifyManifestCli rejects extraneous unmanifested files", async () => {
  const sessionDir = createTempDir("extra-sess-");

  fs.writeFileSync(
    path.join(sessionDir, "session-summary.json"),
    JSON.stringify({ sessionId: "sess-extra", status: "FINALIZED" }, null, 2),
  );

  await generateSessionExportManifest(sessionDir, "sess-extra", "gen-1");

  // Add extraneous file
  fs.writeFileSync(path.join(sessionDir, "untracked-file.txt"), "unauthorized artifact");

  const before = computeDirFingerprints(sessionDir);

  const exitCode = await runVerifyManifestCli([
    "node",
    "scripts/verify-pilot-manifest.mjs",
    `--source=${sessionDir}`,
  ]);

  assert.equal(exitCode, 1);

  const after = computeDirFingerprints(sessionDir);
  assert.deepEqual(
    before,
    after,
    "Verifier must remain strictly non-mutating when extraneous files exist",
  );
});

test("runVerifyManifestCli fails closed with exit code 1 when compiled module is missing, without auto-building (G2-F8)", () => {
  const sandboxDir = createTempDir("no-dist-sandbox-");
  const fakeScriptsDir = path.join(sandboxDir, "scripts");
  fs.mkdirSync(fakeScriptsDir, { recursive: true });

  // Copy verify-pilot-manifest.mjs into the sandbox where ../backend/dist does NOT exist
  const sourceScript = fs.readFileSync(path.join(__dirname, "verify-pilot-manifest.mjs"), "utf8");
  const destScriptPath = path.join(fakeScriptsDir, "verify-pilot-manifest.mjs");
  fs.writeFileSync(destScriptPath, sourceScript);

  const testSessionDir = path.join(sandboxDir, "dummy-session");
  fs.mkdirSync(testSessionDir, { recursive: true });

  // Run the sandboxed script
  const result = spawnSync(process.execPath, [destScriptPath, `--source=${testSessionDir}`], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1, "Must exit with status 1 when compiled backend module is missing");
  assert.match(
    result.stderr,
    /Required compiled backend module is missing/,
    "Must output clear diagnostic about missing backend module",
  );
  assert.match(
    result.stderr,
    /The manifest verifier is strictly read-only and will not compile code automatically/,
    "Must state that manifest verifier is strictly read-only",
  );

  // Assert that backend/dist was NOT created or compiled in the sandbox
  assert.equal(
    fs.existsSync(path.join(sandboxDir, "backend/dist")),
    false,
    "Must NOT compile or write backend/dist automatically",
  );
});

test("runVerifyManifestCli validates a sealed B2 session manifest and rejects tampering", async () => {
  const sessionDir = createTempDir("b2-manifest-test-");

  const saveResult = saveB2EventSession({
    captureBaseDir: sessionDir,
    sessionId: "b2-test-cli-verify",
    wsUrl: "wss://api.mainnet-beta.solana.com",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    endpointHost: "api.mainnet-beta.solana.com",
    endpointFingerprint: "sha256:test",
    forcedStatus: "FINALIZED",
    rawNotifications: [],
    rawTransactions: [],
    rawAccounts: [],
    discoveredEvents: [],
    verificationReports: [],
  });

  // Verify valid B2 manifest returns 0
  const validExit = await runVerifyManifestCli([
    "node",
    "scripts/verify-pilot-manifest.mjs",
    `--source=${saveResult.sessionDir}`,
  ]);
  assert.equal(validExit, 0, "Valid B2 session manifest must exit 0");

  // Tamper with one of the files
  const notifPath = path.join(saveResult.sessionDir, "raw-notifications.jsonl");
  fs.writeFileSync(notifPath, "tampered-content");

  // Verify tampered B2 manifest returns 1
  const tamperedExit = await runVerifyManifestCli([
    "node",
    "scripts/verify-pilot-manifest.mjs",
    `--source=${saveResult.sessionDir}`,
  ]);
  assert.equal(tamperedExit, 1, "Tampered B2 session manifest must exit 1");
});

test("runVerifyManifestCli validates CPMM snapshot manifest (B1 format) and rejects tampering", async () => {
  const { verifyCpmmSnapshotManifest } =
    await import("../backend/dist/research/pilot/RaydiumCpmmParser.js");
  assert.equal(
    typeof verifyCpmmSnapshotManifest,
    "function",
    "verifyCpmmSnapshotManifest must be exported from RaydiumCpmmParser.js",
  );

  // If authentic B1 directory exists, verify it passes
  const authenticB1Dir = path.join(rootDir, ".tmp", "cpmm-captures", "cpmm-snapshot-1792560830086");
  if (fs.existsSync(authenticB1Dir)) {
    const exitCode = await runVerifyManifestCli([
      "node",
      "scripts/verify-pilot-manifest.mjs",
      `--source=${authenticB1Dir}`,
    ]);
    assert.equal(exitCode, 0, "Authentic B1 snapshot directory must verify with exit code 0");
  }

  // Create isolated synthetic CPMM snapshot directory
  const snapshotDir = createTempDir("cpmm-snapshot-test-");
  const files = [
    "pool-account-rpc.json",
    "vault-accounts-rpc.json",
    "snapshot-metadata.json",
    "cpmm-verification-report.json",
  ];

  let totalBytes = 0;
  const manifestFiles = [];
  for (const filename of files) {
    const content = Buffer.from(`test-content-for-${filename}`, "utf8");
    fs.writeFileSync(path.join(snapshotDir, filename), content);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    totalBytes += content.length;
    manifestFiles.push({
      filename,
      byteSize: content.length,
      sha256,
    });
  }

  manifestFiles.sort((a, b) => a.filename.localeCompare(b.filename));
  const canonicalPayload = manifestFiles.map((f) => `${f.filename}:${f.sha256}`).join("\n");
  const canonicalManifestSha256 = crypto
    .createHash("sha256")
    .update(canonicalPayload)
    .digest("hex");

  const manifestObj = {
    manifestVersion: "1.0.0",
    snapshotId: "cpmm-snapshot-test",
    createdAtIso: new Date().toISOString(),
    status: "FINALIZED",
    manifestSha256: canonicalManifestSha256,
    totalFiles: manifestFiles.length,
    totalBytes,
    files: manifestFiles,
  };

  fs.writeFileSync(
    path.join(snapshotDir, "cpmm-snapshot-manifest.json"),
    JSON.stringify(manifestObj, null, 2),
  );

  // Valid exit code check
  const validExit = await runVerifyManifestCli([
    "node",
    "scripts/verify-pilot-manifest.mjs",
    `--source=${snapshotDir}`,
  ]);
  assert.equal(validExit, 0, "Valid CPMM snapshot manifest must exit 0");

  // Tamper with one of the files
  fs.writeFileSync(path.join(snapshotDir, "snapshot-metadata.json"), "tampered-content");

  // Tampered exit code check
  const tamperedExit = await runVerifyManifestCli([
    "node",
    "scripts/verify-pilot-manifest.mjs",
    `--source=${snapshotDir}`,
  ]);
  assert.equal(tamperedExit, 1, "Tampered CPMM snapshot manifest must exit 1");
});
