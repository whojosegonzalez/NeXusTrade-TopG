import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseResearchTruthingArgs } from "./ResearchTruthingConfig.js";

describe("ResearchTruthingConfig", () => {
  it("parses labeled archive runs and truthing options", () => {
    const runA = makeArchivePath("a");
    const runB = makeArchivePath("b");

    const config = parseResearchTruthingArgs([
      "--once",
      "--json",
      `--label-run=A:${runA}`,
      `--label-run=B:${runB}`,
      "--output-dir=data/archive/phase9.4A.1/smoke",
      "--dedupe-mode=first_per_mint",
      "--source-decisions=BUY,WATCH",
      "--min-score=50",
      "--target-pcts=10,25",
      "--stop-pcts=10,20",
      "--max-hold-minutes=60,15",
      "--top-limit=12",
      "--market-window-minutes=30",
      "--require-terminal-json=false",
      "--require-db=false",
      "--include-runner-cycles",
    ]);

    expect(config).toMatchObject({
      once: true,
      json: true,
      outputDir: "data/archive/phase9.4A.1/smoke",
      dedupeMode: "first_per_mint",
      sourceDecisions: ["BUY", "WATCH"],
      minScore: 50,
      targetPcts: [10, 25],
      stopPcts: [10, 20],
      maxHoldMinutes: [15, 60],
      topLimit: 12,
      marketWindowMinutes: 30,
      requireTerminalJson: false,
      requireDb: false,
      includeRunnerCycles: true,
    });
    expect(config.runSources).toEqual([
      { label: "A", path: runA },
      { label: "B", path: runB },
    ]);
  });

  it("rejects duplicate labels and missing archive paths", () => {
    const archivePath = makeArchivePath("duplicate");

    expect(() =>
      parseResearchTruthingArgs([`--label-run=T1:${archivePath}`, `--label-run=T1:${archivePath}`]),
    ).toThrow(/duplicate run label/i);

    expect(() => parseResearchTruthingArgs(["--label-run=Missing:Z:/not-here"])).toThrow(
      /archive path not found/i,
    );
  });
});

function makeArchivePath(label: string): string {
  const archivePath = mkdtempSync(path.join(os.tmpdir(), `nexustrade-truth-${label}-`));

  mkdirSync(archivePath, { recursive: true });

  return archivePath;
}
