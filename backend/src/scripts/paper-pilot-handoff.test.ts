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
  INHERITED_RUNTIME_CONFIGURATION,
  PIN_PATHS,
  RUNNER_DEPENDENCY_PATHS,
  REVIEWED_RUNNER_COMMIT,
  checkPin,
  evaluatePilotHandoff,
  loadVerifiedExchanges,
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
/**
 * Fake git. Path-aware options answer only when the queried pathspec includes the path, so a
 * refusal proves the path is part of the pin: changed (differs from the pinned commit), dirty
 * (modified in the working tree) or changedSinceRunner (modified since the reviewed runner).
 */
function fakeGit(
  o: Partial<Record<"revParse" | "diffQuiet" | "status" | "nameStatus", GitAnswer>> & {
    readonly changed?: readonly string[];
    readonly dirty?: readonly string[];
    readonly changedSinceRunner?: readonly string[];
    readonly onCall?: () => void;
  } = {},
) {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push([...args]);
    o.onCall?.();
    const queried = (p: string) => args.includes(p);
    if (args[0] === "rev-parse") return o.revParse ?? { status: 0, stdout: PINNED };
    if (args[0] === "diff" && args[1] === "--quiet") {
      if (o.changed?.some(queried)) return { status: 1, stdout: "" };
      return o.diffQuiet ?? { status: 0, stdout: "" };
    }
    if (args[0] === "status") {
      const dirty = (o.dirty ?? []).filter(queried);
      if (dirty.length > 0) return { status: 0, stdout: dirty.map((p) => ` M ${p}`).join("\n") };
      return o.status ?? { status: 0, stdout: "" };
    }
    if (args[0] === "diff" && args[1] === "--name-status" && o.changedSinceRunner) {
      return {
        status: 0,
        stdout: o.changedSinceRunner
          .filter(queried)
          .map((p) => `M\t${p}`)
          .join("\n"),
      };
    }
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
    clock: () => nowMs,
    git,
  });

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** Parsed JSON from sealed files (shape checked by the assertions). */
type Loose = ReturnType<typeof JSON.parse>;

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

describe("Handoff corrections (review of 6515fcb)", () => {
  it("H-04: the clock is read after validation; crossing the closing boundary during validation refuses", async () => {
    const { root } = await sealedPrecheck();
    // Invoked at age 759 s; the git checks take long enough to reach 763 s.
    let now = atAge(759);
    const { git } = fakeGit({
      onCall: () => {
        now = atAge(763);
      },
    });
    const r = evaluatePilotHandoff({
      projectRoot: root,
      precheckDir: PRECHECK,
      pilotOutDir: PILOT,
      pinnedCommit: PINNED,
      clock: () => now,
      git,
    });
    expect(r).toMatchObject({
      decision: "REFUSED",
      refusals: ["START_WINDOW_EXPIRED"],
      ageSecNow: 763,
    });
    expect(r.evaluatedAtIso).toBe(new Date(atAge(763)).toISOString());

    // The same applies to the opening boundary: validation ending inside the window allows.
    let early = atAge(239);
    const opening = fakeGit({
      onCall: () => {
        early = atAge(241);
      },
    });
    expect(
      evaluatePilotHandoff({
        projectRoot: root,
        precheckDir: PRECHECK,
        pilotOutDir: PILOT,
        pinnedCommit: PINNED,
        clock: () => early,
        git: opening.git,
      }),
    ).toMatchObject({ decision: "ALLOWED", ageSecNow: 241 });
  });

  it("H-05: every response reference is validated before any is read; outside files are never consumed", async () => {
    const { root, dir } = await sealedPrecheck();
    const now = atAge(300);
    const copy = (name: string) => {
      const abs = path.join(root, "data/research/prechecks", name);
      cpSync(dir, abs, { recursive: true });
      return { abs, rel: `data/research/prechecks/${name}` };
    };
    const editIndex = (abs: string, edit: (index: Loose) => void) => {
      const index = JSON.parse(readFileSync(path.join(abs, "request-exchanges.json"), "utf8"));
      edit(index);
      rewriteSealed(abs, "request-exchanges.json", JSON.stringify(index));
    };

    // The reviewer's reproduction: the signature exchange points outside the seal at an identical
    // response, with the index's manifest digest updated.
    for (const [name, content] of [
      ["outside-identical", readFileSync(path.join(dir, "exchanges", "0001.json"), "utf8")],
      ["outside-unreadable", "NOT JSON: reading this would fail differently"],
    ] as const) {
      const c = copy(name);
      writeFileSync(path.join(root, "outside-signatures.json"), content);
      editIndex(c.abs, (index) => {
        index.exchanges[0].file = "../../../../outside-signatures.json";
      });
      const r = evaluate(root, now, undefined, PILOT, c.rel);
      // Refused on the reference itself: the outside file was never read (an unreadable file
      // would otherwise have produced INVALID_EVIDENCE:UNREADABLE).
      expect(r.refusals, name).toContain("INVALID_EXCHANGE_REFERENCE:#0:PATH");
      expect(
        r.refusals.some((x) => x.includes("UNREADABLE")),
        name,
      ).toBe(false);
      expect(r.poolId, name).toBeUndefined();
    }

    const cases: [string, (abs: string) => void, string][] = [
      [
        "absolute",
        (abs) =>
          editIndex(abs, (i) => (i.exchanges[1].file = path.join(abs, "exchanges", "0002.json"))),
        "INVALID_EXCHANGE_REFERENCE:#1:PATH",
      ],
      [
        "duplicate",
        (abs) => editIndex(abs, (i) => i.exchanges.push({ ...i.exchanges[0] })),
        `INVALID_EXCHANGE_REFERENCE:#${4}:DUPLICATE`,
      ],
      [
        "unindexed response",
        (abs) => editIndex(abs, (i) => i.exchanges.pop()),
        "INVALID_EXCHANGE_REFERENCE:UNINDEXED:exchanges/0004.json",
      ],
      [
        "missing exchanges",
        (abs) => editIndex(abs, (i) => (i.missingExchangeSeqs = [5])),
        "EVIDENCE_INCOMPLETE:MISSING_EXCHANGES",
      ],
      [
        "capture failures",
        (abs) => editIndex(abs, (i) => (i.captureFailures = ["SYNTHETIC write failure"])),
        "EVIDENCE_INCOMPLETE:CAPTURE_FAILURES",
      ],
      [
        "ledger accounting",
        (abs) => {
          const l = JSON.parse(readFileSync(path.join(abs, "request-ledger.json"), "utf8"));
          l.httpAttempts = 5;
          rewriteSealed(abs, "request-ledger.json", JSON.stringify(l));
        },
        "LEDGER_MISMATCH:ACCOUNTING",
      ],
      [
        "ledger disagreement",
        (abs) => {
          const l = JSON.parse(readFileSync(path.join(abs, "request-ledger.json"), "utf8"));
          l.ledger[1].httpStatus = 500;
          rewriteSealed(abs, "request-ledger.json", JSON.stringify(l));
        },
        "LEDGER_MISMATCH:EXCHANGE_2",
      ],
    ];
    for (const [label, mutate, refusal] of cases) {
      const c = copy(label.replace(/ /g, "-"));
      mutate(c.abs);
      const r = evaluate(root, now, undefined, PILOT, c.rel);
      expect(r.decision, label).toBe("REFUSED");
      expect(r.refusals, label).toContain(refusal);
    }
    // The untouched seal still loads and allows.
    expect(loadVerifiedExchanges(dir)).toMatchObject({ ok: true });
    expect(evaluate(root, now).decision).toBe("ALLOWED");
  });

  it("H-06: inherited root runtime configuration is pinned; the secret environment file is not inspected", async () => {
    const { root } = await sealedPrecheck();
    const now = atAge(300);
    expect([...INHERITED_RUNTIME_CONFIGURATION]).toEqual([
      "tsconfig.base.json",
      ".npmrc",
      ".node-version",
      ".nvmrc",
    ]);
    for (const p of INHERITED_RUNTIME_CONFIGURATION) {
      expect(PIN_PATHS).toContain(p);
      expect(RUNNER_DEPENDENCY_PATHS).toContain(p);
    }
    expect(PIN_PATHS.some((p) => p.includes(".env"))).toBe(false);
    for (const p of INHERITED_RUNTIME_CONFIGURATION) {
      expect(evaluate(root, now, fakeGit({ changed: [p] }).git).refusals, p).toContain(
        "CODE_OR_CONFIGURATION_CHANGED",
      );
      expect(evaluate(root, now, fakeGit({ dirty: [p] }).git).refusals, p).toContain(
        "RELEVANT_FILES_DIRTY",
      );
      expect(evaluate(root, now, fakeGit({ changedSinceRunner: [p] }).git).refusals, p).toContain(
        `REVIEWED_RUNNER_DEPENDENCY_CHANGED:${p}`,
      );
    }
    // No git call ever names the environment file, and refusals carry codes, not file contents.
    const { git, calls } = fakeGit({ dirty: ["tsconfig.base.json"] });
    const r = evaluate(root, now, git);
    expect(calls.flat().some((a) => a.includes(".env"))).toBe(false);
    expect(r.refusals).toEqual(["RELEVANT_FILES_DIRTY"]);
  });
});
