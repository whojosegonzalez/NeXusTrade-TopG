import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const workspaceRoot = path.resolve(".");
const stagingDir = path.join(workspaceRoot, ".tmp", "staging-evidence11");

if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

const filesToInclude = [
  { src: "audit/patch-v11-incremental.patch", dest: "patch-v11-incremental.patch" },
  { src: "audit/patch-phase12-93d-final.patch", dest: "patch-phase12-93d-final.patch" },
  { src: "audit/verify-isolated-all.log", dest: "verify-isolated-all.log" },
  { src: "audit/backup-manifest-v11.json", dest: "backup-manifest-v11.json" },
  { src: ".tmp/legacy-wallet-migration.json", dest: "legacy-wallet-migration.json" },
  { src: ".tmp/virtual-wallet.json", dest: "virtual-wallet.json" },
  { src: ".tmp/past-sessions.json", dest: "past-sessions.json" },
  {
    src: ".tmp/sessions/session-paper-12.93-pc-day4.json",
    dest: "sessions/session-paper-12.93-pc-day4.json",
  },
  {
    src: ".tmp/sessions/session-paper-12.93-pc-afternoon.json",
    dest: "sessions/session-paper-12.93-pc-afternoon.json",
  },
  { src: "audit/PHASE_12_93D_EVIDENCE_PACKAGE_11.md", dest: "PHASE_12_93D_EVIDENCE_PACKAGE_11.md" },
  { src: "backend/src/paper/CanonicalPaths.ts", dest: "sources/CanonicalPaths.ts" },
  {
    src: "backend/src/paper/PaperTradingDaemon.test.ts",
    dest: "sources/PaperTradingDaemon.test.ts",
  },
  {
    src: "backend/src/scripts/paper-observation-analytics.ts",
    dest: "sources/paper-observation-analytics.ts",
  },
  {
    src: "backend/src/session/SessionControlIpcService.ts",
    dest: "sources/SessionControlIpcService.ts",
  },
  { src: "frontend/vite.config.ts", dest: "sources/vite.config.ts" },
  { src: "scripts/retire-legacy-wallet.mjs", dest: "sources/retire-legacy-wallet.mjs" },
];

for (const item of filesToInclude) {
  const fullSrc = path.join(workspaceRoot, item.src);
  const fullDest = path.join(stagingDir, item.dest);
  const destDir = path.dirname(fullDest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(fullSrc, fullDest);
  console.log(`Staged: ${item.src} -> ${item.dest} (${fs.statSync(fullDest).size} bytes)`);
}

const targetZip = path.join(workspaceRoot, "data", "phase-12.93d-evidence-package11.zip");
if (fs.existsSync(targetZip)) {
  fs.unlinkSync(targetZip);
}

// Compress using PowerShell Compress-Archive
const psCommand = `powershell -NoProfile -Command "Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${targetZip}' -Force"`;
console.log("Compressing package...");
execSync(psCommand, { stdio: "inherit" });

console.log(`Created evidence package: ${targetZip} (${fs.statSync(targetZip).size} bytes)`);

// Copy to Downloads
const downloadsDir = "C:\\Users\\whojo\\Downloads";
const downloadsZip = path.join(downloadsDir, "phase-12.93d-evidence-package11.zip");
const downloadsDoc = path.join(downloadsDir, "PHASE_12_93D_EVIDENCE_PACKAGE_11.md");

fs.copyFileSync(targetZip, downloadsZip);
fs.copyFileSync(
  path.join(workspaceRoot, "audit", "PHASE_12_93D_EVIDENCE_PACKAGE_11.md"),
  downloadsDoc,
);

console.log(`Copied zip to ${downloadsZip} (${fs.statSync(downloadsZip).size} bytes)`);
console.log(`Copied doc to ${downloadsDoc} (${fs.statSync(downloadsDoc).size} bytes)`);

// Cleanup staging
fs.rmSync(stagingDir, { recursive: true, force: true });
console.log("Staging directory cleaned.");
