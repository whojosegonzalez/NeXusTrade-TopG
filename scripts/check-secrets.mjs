import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const blockedPathPatterns = [
  {
    pattern: /(^|\/)\.env($|[._-])/i,
    reason:
      "Local environment files must not be committed. Use .env.example for safe placeholders.",
  },
  {
    pattern: /(^|\/)(keypair|wallet)\.json$/i,
    reason: "Wallet and keypair files must stay local.",
  },
  {
    pattern: /\.(pem|key|enc\.json)$/i,
    reason: "Private key material and encrypted key files must stay local.",
  },
];

const privateKeyPattern = new RegExp(
  "-----BEGIN (?:RSA |EC |OPENSSH |DSA )?" + "PRIVATE " + "KEY-----",
);

const blockedContentPatterns = [
  {
    pattern: privateKeyPattern,
    reason: "Private key content detected.",
  },
];

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getCandidateFiles() {
  const stagedFiles = runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);

  if (stagedFiles.length > 0) {
    return stagedFiles;
  }

  return runGit(["ls-files", "--cached", "--others", "--exclude-standard"]);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isAllowedEnvExample(filePath) {
  return normalizePath(filePath).endsWith(".env.example");
}

function checkPath(filePath) {
  if (isAllowedEnvExample(filePath)) {
    return [];
  }

  const normalized = normalizePath(filePath);

  return blockedPathPatterns
    .filter(({ pattern }) => pattern.test(normalized))
    .map(({ reason }) => ({
      filePath,
      reason,
    }));
}

function checkContent(filePath) {
  const absolutePath = path.join(repoRoot, filePath);

  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    return [];
  }

  const content = readFileSync(absolutePath, "utf8");

  return blockedContentPatterns
    .filter(({ pattern }) => pattern.test(content))
    .map(({ reason }) => ({
      filePath,
      reason,
    }));
}

const findings = getCandidateFiles().flatMap((filePath) => [
  ...checkPath(filePath),
  ...checkContent(filePath),
]);

if (findings.length > 0) {
  console.error("Secret check failed. Remove the blocked files or content before committing.");

  for (const finding of findings) {
    console.error(`- ${finding.filePath}: ${finding.reason}`);
  }

  process.exitCode = 1;
} else {
  console.log("Secret check passed.");
}
