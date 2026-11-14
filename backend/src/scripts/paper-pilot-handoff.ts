#!/usr/bin/env node
/**
 * NeXusTrade — enforced conditional handoff from the Stage A precheck to the Stage B pilot.
 *
 * Read-only and offline: git and local files only; no request, socket or provider call. It is
 * evaluated by the PowerShell wrapper (`scripts/paper-pilot-sequence.ps1`) once after the
 * precheck and again immediately before Stage B. It ALLOWS Stage B only when every check passes:
 *
 * 1. Code and configuration: the relevant tracked files equal the pinned (reviewed) commit, none
 *    are modified or untracked, and since the reviewed runner commit only the allowed new files
 *    were added (the runner and everything it depends on are byte-identical).
 * 2. Evidence: the sealed precheck verifies (manifest, digests, paths, nothing unlisted).
 * 3. Selection: re-deriving from the sealed responses reproduces the sealed target exactly; the
 *    outcome is TARGET_SELECTED; the identity is canonical, candidate base / WSOL quote.
 * 4. Start window (PLANNING ESTIMATE): the pool's age on the runner's own age source (DexScreener
 *    `pairCreatedAt`) is inside 240–760 s. Before the window opens it answers WAIT with the exact
 *    wait (one wait only, no polling); after it closes it refuses.
 * 5. Output: the pilot directory is new and inside the single-candidate evidence root.
 *
 * Nothing is substituted: Stage B uses exactly the sealed pool and mint.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { isCanonicalSolanaBase58 } from "../candidate-scanner/LpScreeningBridge.js";
import { WSOL_MINT } from "../research/pilot/RaydiumAmmParser.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import { EVIDENCE_ROOT_SEGMENTS } from "./paper-single-candidate-diagnostic.js";
import {
  PLANNING_START_WINDOW,
  PRECHECK_CORE_FILES,
  PRECHECK_MANIFEST_KIND,
  PRECHECK_MANIFEST_VERSION,
  derivePrecheckSelection,
  precheckExchangePath,
  type PrecheckExchange,
  type PrecheckSelection,
} from "./fresh-amm-v4-precheck.js";

/** The runner reviewed for Stage B; it and its dependencies must be unchanged since. */
export const REVIEWED_RUNNER_COMMIT = "6855efb0e4ab5023e2c556030c42613a0ee86f53" as const;
/**
 * Inherited runtime configuration outside backend/ and shared/: the root TypeScript base
 * configuration (extended by backend/tsconfig.json; it maps @nexustrade/shared), the package
 * manager configuration and the Node version declarations. Tooling-only files (ESLint, Prettier,
 * EditorConfig) and the example environment file do not affect the run. The secret .env file is
 * untracked and deliberately never inspected: its values stay out of every check and output.
 */
export const INHERITED_RUNTIME_CONFIGURATION = Object.freeze([
  "tsconfig.base.json",
  ".npmrc",
  ".node-version",
  ".nvmrc",
]);
/** The runner's dependency surface, compared with the reviewed runner commit. */
export const RUNNER_DEPENDENCY_PATHS = Object.freeze([
  "backend",
  "shared",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ...INHERITED_RUNTIME_CONFIGURATION,
]);
/** Tracked code and configuration that must equal the pinned commit and be clean. */
export const PIN_PATHS = Object.freeze([
  ...RUNNER_DEPENDENCY_PATHS,
  "scripts/paper-pilot-sequence.ps1",
]);
/** The only changes allowed in that surface since the reviewed runner: these added files. */
export const ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER = Object.freeze([
  "backend/src/scripts/fresh-amm-v4-precheck.ts",
  "backend/src/scripts/fresh-amm-v4-precheck.test.ts",
  "backend/src/scripts/fresh-amm-v4-precheck.test-support.ts",
  "backend/src/scripts/paper-pilot-handoff.ts",
  "backend/src/scripts/paper-pilot-handoff.test.ts",
]);
/** One wait at most, never longer than the window's lower bound. */
export const MAX_WAIT_MS = PLANNING_START_WINDOW.minAgeSec * 1000;

export type GitRunner = (args: readonly string[]) => { status: number; stdout: string };

export const defaultGit =
  (repoRoot: string): GitRunner =>
  (args) => {
    const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", timeout: 20_000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? "" };
  };

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

/** Code and configuration pin (read-only git). */
export function checkPin(pinnedCommit: string, git: GitRunner): string[] {
  if (!COMMIT_HEX.test(pinnedCommit)) return ["PINNED_COMMIT_INVALID"];
  const problems: string[] = [];
  if (git(["rev-parse", "--verify", "--quiet", `${pinnedCommit}^{commit}`]).status !== 0) {
    return ["PINNED_COMMIT_UNKNOWN"];
  }
  if (git(["diff", "--quiet", pinnedCommit, "--", ...PIN_PATHS]).status !== 0) {
    problems.push("CODE_OR_CONFIGURATION_CHANGED");
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=all", "--", ...PIN_PATHS]);
  if (dirty.status !== 0 || dirty.stdout.trim() !== "") problems.push("RELEVANT_FILES_DIRTY");
  const changed = git([
    "diff",
    "--name-status",
    "--no-renames",
    REVIEWED_RUNNER_COMMIT,
    pinnedCommit,
    "--",
    ...RUNNER_DEPENDENCY_PATHS,
  ]);
  if (changed.status !== 0) {
    problems.push("REVIEWED_RUNNER_COMPARISON_FAILED");
  } else {
    for (const line of changed.stdout.split(/\r?\n/).filter((l) => l.trim() !== "")) {
      const [kind, file] = line.split("\t");
      if (kind !== "A" || !ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER.includes(file ?? "")) {
        problems.push(`REVIEWED_RUNNER_DEPENDENCY_CHANGED:${file ?? line}`);
      }
    }
  }
  return problems;
}

function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 256) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(p) || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const readJson = (dir: string, rel: string): unknown =>
  JSON.parse(readFileSync(path.join(dir, ...rel.split("/")), "utf8"));

/** Integrity of a sealed precheck directory (fails closed). */
export function verifyPrecheckEvidence(dir: string): string[] {
  const problems: string[] = [];
  let manifest: Record<string, unknown>;
  try {
    manifest = readJson(dir, "evidence-manifest.json") as Record<string, unknown>;
  } catch {
    return ["MANIFEST_MISSING_OR_INVALID"];
  }
  if (manifest.kind !== PRECHECK_MANIFEST_KIND) problems.push("MANIFEST_KIND_INVALID");
  if (manifest.manifestVersion !== PRECHECK_MANIFEST_VERSION)
    problems.push("MANIFEST_VERSION_INVALID");
  if (!Array.isArray(manifest.files)) return [...problems, "MANIFEST_FILES_INVALID"];
  const listed = new Set<string>();
  for (const [i, raw] of (manifest.files as unknown[]).entries()) {
    const f = (raw ?? {}) as Record<string, unknown>;
    if (!isSafeRelativePath(f.path) || f.path === "evidence-manifest.json") {
      problems.push(`INVALID_PATH:#${i}`);
      continue;
    }
    if (listed.has(f.path)) {
      problems.push(`DUPLICATE_PATH:${f.path}`);
      continue;
    }
    listed.add(f.path);
    const expected = f.path.startsWith("exchanges/") ? "RESPONSE" : "EVIDENCE";
    if (f.category !== expected) problems.push(`INVALID_CATEGORY:${f.path}`);
    const full = path.join(dir, ...f.path.split("/"));
    if (!existsSync(full) || !lstatSync(full).isFile()) {
      problems.push(`MISSING:${f.path}`);
      continue;
    }
    const buf = readFileSync(full);
    if (
      typeof f.sha256 !== "string" ||
      !SHA256_HEX.test(f.sha256) ||
      typeof f.bytes !== "number" ||
      buf.length !== f.bytes ||
      sha256(buf) !== f.sha256
    ) {
      problems.push(`MODIFIED:${f.path}`);
    }
  }
  for (const required of PRECHECK_CORE_FILES) {
    if (required !== "evidence-manifest.json" && !listed.has(required)) {
      problems.push(`REQUIRED_ENTRY_MISSING:${required}`);
    }
  }
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, ...(rel ? rel.split("/") : [])))) {
      const child = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path.join(dir, ...child.split("/")));
      if (st.isDirectory()) walk(child);
      else if (!st.isFile()) problems.push(`UNEXPECTED_ENTRY:${child}`);
      else if (child !== "evidence-manifest.json" && !listed.has(child))
        problems.push(`UNLISTED:${child}`);
    }
  };
  walk("");
  if (listed.has("plan.json") && existsSync(path.join(dir, "plan.json"))) {
    if (sha256(readFileSync(path.join(dir, "plan.json"))) !== manifest.planDigestSha256) {
      problems.push("PLAN_DIGEST_MISMATCH");
    }
  }
  return problems;
}

export interface HandoffResult {
  readonly decision: "ALLOWED" | "WAIT" | "REFUSED";
  readonly refusals: readonly string[];
  readonly poolId?: string | undefined;
  readonly mintAddress?: string | undefined;
  readonly ageSecNow?: number | undefined;
  readonly ageSource?: string | undefined;
  readonly startWindow?:
    | { readonly opensAtIso: string; readonly closesAtIso: string; readonly status: string }
    | undefined;
  readonly waitMs?: number | undefined;
  readonly pilotOutDir?: string | undefined;
  readonly evaluatedAtIso: string;
}

const LEDGER_FIELDS = [
  "purpose",
  "lane",
  "jsonRpcId",
  "dispatchedAtMs",
  "completedAtMs",
  "httpStatus",
  "error",
] as const;

/**
 * Validates every response reference BEFORE any indexed response is read, then reads only the
 * canonical, manifest-listed files and checks each against the request ledger. Returns the
 * exchanges or the refusals. Outside, duplicate, unlisted or miscategorised references, missing
 * exchanges, capture failures and inconsistent accounting all refuse.
 */
export function loadVerifiedExchanges(
  dir: string,
): { ok: true; exchanges: PrecheckExchange[] } | { ok: false; refusals: string[] } {
  const fail = (refusals: string[]) => ({ ok: false as const, refusals });
  let manifest: { files?: unknown };
  let index: Record<string, unknown>;
  let ledgerFile: Record<string, unknown>;
  try {
    manifest = readJson(dir, "evidence-manifest.json") as { files?: unknown };
    index = readJson(dir, "request-exchanges.json") as Record<string, unknown>;
    ledgerFile = readJson(dir, "request-ledger.json") as Record<string, unknown>;
  } catch {
    return fail(["INVALID_EVIDENCE:UNREADABLE"]);
  }
  const listed = new Map<string, unknown>();
  for (const f of Array.isArray(manifest.files)
    ? (manifest.files as Record<string, unknown>[])
    : []) {
    if (typeof f?.path === "string") listed.set(f.path, f.category);
  }
  if (!Array.isArray(index.missingExchangeSeqs) || !Array.isArray(index.captureFailures)) {
    return fail(["INVALID_EXCHANGE_REFERENCE:INDEX_MALFORMED"]);
  }
  if (index.missingExchangeSeqs.length > 0) return fail(["EVIDENCE_INCOMPLETE:MISSING_EXCHANGES"]);
  if (index.captureFailures.length > 0) return fail(["EVIDENCE_INCOMPLETE:CAPTURE_FAILURES"]);
  if (!Array.isArray(index.exchanges)) return fail(["INVALID_EXCHANGE_REFERENCE:INDEX_MALFORMED"]);
  const problems: string[] = [];
  const seqs = new Set<number>();
  const files = new Set<string>();
  for (const [i, raw] of (index.exchanges as unknown[]).entries()) {
    const x = (raw ?? {}) as Record<string, unknown>;
    const seq = x.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
      problems.push(`INVALID_EXCHANGE_REFERENCE:#${i}:SEQ`);
      continue;
    }
    // The only acceptable reference is the canonical, confined path for that sequence number.
    if (x.file !== precheckExchangePath(seq)) {
      problems.push(`INVALID_EXCHANGE_REFERENCE:#${i}:PATH`);
      continue;
    }
    if (listed.get(x.file) !== "RESPONSE") {
      problems.push(`INVALID_EXCHANGE_REFERENCE:#${i}:NOT_A_LISTED_RESPONSE`);
      continue;
    }
    if (seqs.has(seq) || files.has(x.file)) {
      problems.push(`INVALID_EXCHANGE_REFERENCE:#${i}:DUPLICATE`);
      continue;
    }
    seqs.add(seq);
    files.add(x.file);
  }
  for (const [p, category] of listed) {
    if (category === "RESPONSE" && !files.has(p))
      problems.push(`INVALID_EXCHANGE_REFERENCE:UNINDEXED:${p}`);
  }
  if (problems.length > 0) return fail(problems);

  // Accounting: the ledger and the index name exactly the same requests.
  const ledger = Array.isArray(ledgerFile.ledger)
    ? (ledgerFile.ledger as Record<string, unknown>[])
    : null;
  if (!ledger || ledgerFile.httpAttempts !== ledger.length)
    return fail(["LEDGER_MISMATCH:ACCOUNTING"]);
  const ledgerSeqs = ledger.map((e) => e.seq);
  const indexSeqs = [...seqs].sort((a, b) => a - b);
  if (JSON.stringify(ledgerSeqs) !== JSON.stringify(indexSeqs)) {
    return fail(["LEDGER_MISMATCH:SEQUENCE_SET"]);
  }
  // Only now are the (canonical, listed, verified) response files read.
  const exchanges: PrecheckExchange[] = [];
  for (const seq of indexSeqs) {
    let record: PrecheckExchange;
    try {
      record = readJson(dir, precheckExchangePath(seq)) as PrecheckExchange;
    } catch {
      return fail([`INVALID_EVIDENCE:UNREADABLE:${precheckExchangePath(seq)}`]);
    }
    const entry = ledger.find((e) => e.seq === seq)!;
    if (record.seq !== seq || LEDGER_FIELDS.some((k) => record[k] !== entry[k])) {
      return fail([`LEDGER_MISMATCH:EXCHANGE_${seq}`]);
    }
    exchanges.push(record);
  }
  return { ok: true, exchanges };
}

/** Every pre-Stage-B check, in order; nothing is substituted or retried. */
export function evaluatePilotHandoff(input: {
  readonly projectRoot: string;
  readonly precheckDir: string;
  readonly pilotOutDir: string;
  readonly pinnedCommit: string;
  /** Read only after validation, immediately before deciding (injected for tests). */
  readonly clock: () => number;
  readonly git: GitRunner;
}): HandoffResult {
  const refuse = (refusals: readonly string[]): HandoffResult => ({
    decision: "REFUSED",
    refusals,
    evaluatedAtIso: new Date(input.clock()).toISOString(),
  });
  const pin = checkPin(input.pinnedCommit, input.git);
  if (pin.length > 0) return refuse(pin);

  const precheckDir = path.resolve(input.projectRoot, input.precheckDir);
  if (!existsSync(precheckDir)) return refuse(["PRECHECK_EVIDENCE_MISSING"]);
  const evidence = verifyPrecheckEvidence(precheckDir);
  if (evidence.length > 0) return refuse(evidence.map((p) => `INVALID_EVIDENCE:${p}`));

  const loaded = loadVerifiedExchanges(precheckDir);
  if (!loaded.ok) return refuse(loaded.refusals);
  const exchanges = loaded.exchanges;
  let sealed: PrecheckSelection;
  try {
    sealed = readJson(precheckDir, "selection.json") as PrecheckSelection;
  } catch {
    return refuse(["INVALID_EVIDENCE:UNREADABLE"]);
  }
  if (sealed.outcome !== "TARGET_SELECTED" || !sealed.target) {
    return refuse([`PRECHECK_NO_TARGET:${sealed.outcome}`]);
  }
  const rederived = derivePrecheckSelection(exchanges, { complete: true }).selection;
  if (JSON.stringify(rederived) !== JSON.stringify(sealed)) {
    return refuse(["SELECTION_NOT_REPRODUCIBLE_FROM_SEALED_RESPONSES"]);
  }
  const t = sealed.target;
  if (
    !isCanonicalSolanaBase58(t.poolId) ||
    !isCanonicalSolanaBase58(t.mintAddress) ||
    t.poolId === t.mintAddress ||
    t.mintAddress === WSOL_MINT ||
    t.quoteMint !== WSOL_MINT ||
    t.orientation !== "CANDIDATE_BASE_WSOL_QUOTE"
  ) {
    return refuse(["TARGET_IDENTITY_INVALID"]);
  }

  const pilotOutDir = path.resolve(input.projectRoot, input.pilotOutDir);
  const root = path.join(input.projectRoot, ...EVIDENCE_ROOT_SEGMENTS);
  const rel = path.relative(root, pilotOutDir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
    return refuse(["PILOT_OUTPUT_INVALID"]);
  if (existsSync(pilotOutDir)) return refuse(["PILOT_OUTPUT_EXISTS"]);

  // Start window on the runner's own age source (PLANNING ESTIMATE; runtime checks decide).
  // The clock is read here, after every validation, immediately before deciding.
  const nowMs = input.clock();
  const evaluatedAtIso = new Date(nowMs).toISOString();
  const openTimeSec = t.market.runnerOpenTimeSec;
  const ageSecNow = Math.floor(nowMs / 1000) - openTimeSec;
  const opensAtMs = (openTimeSec + PLANNING_START_WINDOW.minAgeSec) * 1000;
  const closesAtMs = (openTimeSec + PLANNING_START_WINDOW.maxAgeSec) * 1000;
  const base = {
    poolId: t.poolId,
    mintAddress: t.mintAddress,
    ageSecNow,
    ageSource: "DEXSCREENER_PAIR_CREATED_AT",
    startWindow: {
      opensAtIso: new Date(opensAtMs).toISOString(),
      closesAtIso: new Date(closesAtMs).toISOString(),
      status: PLANNING_START_WINDOW.status,
    },
    pilotOutDir: path.relative(input.projectRoot, pilotOutDir).replace(/\\/g, "/"),
    evaluatedAtIso,
  };
  if (ageSecNow > PLANNING_START_WINDOW.maxAgeSec) {
    return { ...base, decision: "REFUSED", refusals: ["START_WINDOW_EXPIRED"] };
  }
  if (ageSecNow < PLANNING_START_WINDOW.minAgeSec) {
    const waitMs = opensAtMs - nowMs;
    if (waitMs > MAX_WAIT_MS) {
      return { ...base, decision: "REFUSED", refusals: ["START_WINDOW_TOO_FAR_AHEAD"] };
    }
    return { ...base, decision: "WAIT", refusals: ["START_WINDOW_NOT_YET_OPEN"], waitMs };
  }
  return { ...base, decision: "ALLOWED", refusals: [] };
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "pinned-commit": { type: "string" },
      "pin-only": { type: "boolean" },
      "precheck-dir": { type: "string" },
      "pilot-out-dir": { type: "string" },
    },
    strict: true,
  });
  const projectRoot = path.resolve(findWorkspaceRoot());
  const git = defaultGit(projectRoot);
  const pinnedCommit = String(values["pinned-commit"] ?? "");
  if (values["pin-only"] === true) {
    const problems = checkPin(pinnedCommit, git);
    console.log(
      JSON.stringify({
        decision: problems.length === 0 ? "PIN_OK" : "REFUSED",
        refusals: problems,
        evaluatedAtIso: new Date().toISOString(),
      }),
    );
    return problems.length === 0 ? 0 : 1;
  }
  const result = evaluatePilotHandoff({
    projectRoot,
    precheckDir: String(values["precheck-dir"] ?? ""),
    pilotOutDir: String(values["pilot-out-dir"] ?? ""),
    pinnedCommit,
    clock: () => Date.now(),
    git,
  });
  console.log(JSON.stringify(result));
  return result.decision === "ALLOWED" ? 0 : result.decision === "WAIT" ? 2 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("paper-pilot-handoff.ts")) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.log(
      JSON.stringify({
        decision: "REFUSED",
        refusals: [`HANDOFF_ERROR:${err instanceof Error ? err.message : String(err)}`],
      }),
    );
    process.exit(1);
  }
}
