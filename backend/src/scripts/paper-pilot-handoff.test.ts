/**
 * Conditional handoff (offline): code/configuration pin, evidence integrity, re-derivation of the
 * sealed target, the start window on the runner's age source, and the pilot output directory.
 * SYNTHETIC precheck evidence and a fake git runner; no network.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER,
  PIN_PATHS,
  REVIEWED_RUNNER_COMMIT,
  checkPin,
  evaluatePilotHandoff,
  type GitRunner,
} from "./paper-pilot-handoff.js";
import {
  MATCH_PAIR_CREATED_AT_MS,
  MINT,
  NOW_SEC,
  POOL,
  key,
  precheckEnv,
  sig,
  standardScenario,
} from "./fresh-amm-v4-precheck.test-support.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const PINNED = "a".repeat(40);
const PRECHECK = "data/research/prechecks/handoff";
const PILOT = "data/research/single-candidate/pilot-01-test";
const RUNNER_OPEN_SEC = Math.floor(MATCH_PAIR_CREATED_AT_MS / 1000);
const atAge = (ageSec: number) => (RUNNER_OPEN_SEC + ageSec) * 1000;

type GitAnswer = { status: number; stdout: string };
function fakeGit(
  o: Partial<Record<"revParse" | "diffQuiet" | "status" | "nameStatus", GitAnswer>> = {},
) {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push([...args]);
    if (args[0] === "rev-parse") return o.revParse ?? { status: 0, stdout: PINNED };
    if (args[0] === "diff" && args[1] === "--quiet")
      return o.diffQuiet ?? { status: 0, stdout: "" };
    if (args[0] === "status") return o.status ?? { status: 0, stdout: "" };
    if (args[0] === "diff" && args[1] === "--name-status") {
      return (
        o.nameStatus ?? {
          status: 0,
          stdout: ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER.map((f) => `A\t${f}`).join("\n"),
        }
      );
    }
    return { status: 1, stdout: "" };
  };
  return { git, calls };
}

async function sealedPrecheck(scenario = standardScenario()) {
  const env = precheckEnv(scenario);
  roots.push(env.projectRoot);
  const r = await env.run("handoff");
  return { root: env.projectRoot, dir: r.outDir!, selection: r.selection! };
}

const evaluate = (
  root: string,
  nowMs: number,
  git: GitRunner = fakeGit().git,
  pilot = PILOT,
  precheck = PRECHECK,
) =>
  evaluatePilotHandoff({
    projectRoot: root,
    precheckDir: precheck,
    pilotOutDir: pilot,
    pinnedCommit: PINNED,
    nowMs,
    git,
  });

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** Rewrites one sealed file and its manifest entry consistently (integrity then still passes). */
function rewriteSealed(dir: string, rel: string, content: string) {
  writeFileSync(path.join(dir, rel), content);
  const manifestPath = path.join(dir, "evidence-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.files.find((f: { path: string }) => f.path === rel);
  entry.sha256 = sha256(content);
  entry.bytes = Buffer.byteLength(content);
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

describe("Stage A -> Stage B conditional handoff (offline)", () => {
  it("H-01: allows exactly the sealed identity inside the window, answers one bounded WAIT before it, and refuses after it", async () => {
    const { root } = await sealedPrecheck();
    const { git, calls } = fakeGit();
    const allowed = evaluate(root, atAge(300), git);
    expect(allowed).toMatchObject({
      decision: "ALLOWED",
      refusals: [],
      poolId: POOL,
      mintAddress: MINT,
      ageSecNow: 300,
      ageSource: "DEXSCREENER_PAIR_CREATED_AT",
      pilotOutDir: PILOT,
      startWindow: { status: expect.stringMatching(/^PLANNING_ESTIMATE/) },
    });
    // The pin compares the relevant paths with the pinned commit and the runner's surface with 6855efb.
    expect(
      calls.some(
        (c) => c[0] === "diff" && c[1] === "--quiet" && PIN_PATHS.every((p) => c.includes(p)),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.includes(REVIEWED_RUNNER_COMMIT) && c.includes(PINNED))).toBe(true);

    const wait = evaluate(root, NOW_SEC * 1000);
    expect(wait).toMatchObject({
      decision: "WAIT",
      refusals: ["START_WINDOW_NOT_YET_OPEN"],
      poolId: POOL,
    });
    expect(wait.waitMs).toBe(atAge(240) - NOW_SEC * 1000);
    expect(evaluate(root, atAge(761))).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_EXPIRED"],
    });
    expect(evaluate(root, atAge(-10))).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_TOO_FAR_AHEAD"],
    });
    expect(evaluate(root, atAge(760)).decision).toBe("ALLOWED");
    expect(evaluate(root, atAge(240)).decision).toBe("ALLOWED");
  });

  it("H-02: refuses changed, dirty or diverged code and configuration", async () => {
    const { root } = await sealedPrecheck();
    const now = atAge(300);
    const cases: [string, GitRunner, string][] = [
      [
        "unknown commit",
        fakeGit({ revParse: { status: 1, stdout: "" } }).git,
        "PINNED_COMMIT_UNKNOWN",
      ],
      [
        "changed",
        fakeGit({ diffQuiet: { status: 1, stdout: "" } }).git,
        "CODE_OR_CONFIGURATION_CHANGED",
      ],
      [
        "modified",
        fakeGit({ status: { status: 0, stdout: " M backend/src/x.ts\n" } }).git,
        "RELEVANT_FILES_DIRTY",
      ],
      [
        "untracked",
        fakeGit({ status: { status: 0, stdout: "?? backend/src/scripts/new.ts\n" } }).git,
        "RELEVANT_FILES_DIRTY",
      ],
      [
        "runner dependency modified",
        fakeGit({
          nameStatus: {
            status: 0,
            stdout: "M\tbackend/src/candidate-scanner/PaperRequestSession.ts",
          },
        }).git,
        "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/candidate-scanner/PaperRequestSession.ts",
      ],
      [
        "unexpected addition",
        fakeGit({ nameStatus: { status: 0, stdout: "A\tbackend/src/scripts/other.ts" } }).git,
        "REVIEWED_RUNNER_DEPENDENCY_CHANGED:backend/src/scripts/other.ts",
      ],
      [
        "allowed file deleted",
        fakeGit({
          nameStatus: { status: 0, stdout: `D\t${ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER[0]}` },
        }).git,
        `REVIEWED_RUNNER_DEPENDENCY_CHANGED:${ALLOWED_ADDITIONS_SINCE_REVIEWED_RUNNER[0]}`,
      ],
    ];
    for (const [label, git, refusal] of cases) {
      const r = evaluate(root, now, git);
      expect(r.decision, label).toBe("REFUSED");
      expect(r.refusals, label).toContain(refusal);
      expect(r.poolId, label).toBeUndefined(); // no identity is released
    }
    expect(checkPin("not-a-commit", fakeGit().git)).toEqual(["PINNED_COMMIT_INVALID"]);
  });

  it("H-03: refuses invalid or unreproducible evidence, a precheck without a target, and an unusable pilot directory", async () => {
    const { root, dir } = await sealedPrecheck();
    const now = atAge(300);
    const copy = (name: string) => {
      const target = path.join(root, "data/research/prechecks", name);
      cpSync(dir, target, { recursive: true });
      return { abs: target, rel: `data/research/prechecks/${name}` };
    };

    const tampered = copy("tampered");
    writeFileSync(path.join(tampered.abs, "selection.json"), "{}");
    expect(evaluate(root, now, undefined, PILOT, tampered.rel).refusals).toContain(
      "INVALID_EVIDENCE:MODIFIED:selection.json",
    );

    const extra = copy("extra");
    writeFileSync(path.join(extra.abs, "exchanges", "9999.json"), "{}");
    expect(evaluate(root, now, undefined, PILOT, extra.rel).refusals).toContain(
      "INVALID_EVIDENCE:UNLISTED:exchanges/9999.json",
    );

    // A substituted identity with a consistently rewritten manifest is not reproducible.
    const substituted = copy("substituted");
    const selection = readFileSync(path.join(substituted.abs, "selection.json"), "utf8");
    rewriteSealed(
      substituted.abs,
      "selection.json",
      selection.split(POOL).join(key("substituted-pool")),
    );
    expect(evaluate(root, now, undefined, PILOT, substituted.rel).refusals).toEqual([
      "SELECTION_NOT_REPRODUCIBLE_FROM_SEALED_RESPONSES",
    ]);

    // A sealed response edited to point elsewhere no longer reproduces the sealed selection.
    const edited = copy("edited-response");
    const tx = readFileSync(path.join(edited.abs, "exchanges", "0003.json"), "utf8");
    rewriteSealed(edited.abs, "exchanges/0003.json", tx.split(sig(104)).join(sig(777)));
    expect(evaluate(root, now, undefined, PILOT, edited.rel).decision).toBe("REFUSED");

    expect(
      evaluate(root, now, undefined, PILOT, "data/research/prechecks/missing").refusals,
    ).toEqual(["PRECHECK_EVIDENCE_MISSING"]);

    mkdirSync(path.join(root, PILOT), { recursive: true });
    expect(evaluate(root, now).refusals).toEqual(["PILOT_OUTPUT_EXISTS"]);
    expect(evaluate(root, now, undefined, "data/research/diagnostics/pilot").refusals).toEqual([
      "PILOT_OUTPUT_INVALID",
    ]);

    const none = await sealedPrecheck(
      standardScenario({
        transactions: [
          {
            signature: sig(103),
            slot: 998,
            blockTime: NOW_SEC - 60,
            feeDestination: key("not-the-fee-account"),
          },
          {
            signature: sig(104),
            slot: 997,
            blockTime: NOW_SEC - 120,
            feeDestination: key("not-the-fee-account"),
          },
        ],
      }),
    );
    expect(evaluate(none.root, now).refusals).toEqual([
      "PRECHECK_NO_TARGET:SAMPLE_PRODUCED_NO_SUITABLE_TARGET",
    ]);
  });
});
