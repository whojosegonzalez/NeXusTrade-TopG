import { readFileSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeasurementCohortAnalysisLoader } from "./MeasurementCohortAnalysisLoader.js";
import { parseMeasurementCohortAnalysisArgs } from "./MeasurementCohortAnalysisConfig.js";
import { MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH } from "./MeasurementCohortAnalysisIdentity.js";
import {
  cleanupFixtures,
  makeFinalFixture,
  loadFixture,
  rewriteInternalHashes,
  expectErrorCode,
  hash,
  source,
  countRawDates,
} from "./MeasurementCohortAnalysis.test-support.js";

type RecordValue = Record<string, unknown>;
type Fixture = ReturnType<typeof makeFinalFixture>;
interface Evidence {
  manifest: RecordValue;
  summary: RecordValue;
  units: RecordValue[];
  sources: RecordValue[];
}
const inconsistent = "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY";
const links: string[] = [];
afterEach(() => {
  for (const link of links.splice(0)) unlinkSync(link);
  cleanupFixtures();
});

export function record(value: unknown): RecordValue {
  return value as RecordValue;
}
function edit(fixture: Fixture, action: (evidence: Evidence) => void, recount = false): Fixture {
  const json = (name: string) =>
    JSON.parse(readFileSync(path.join(fixture.root, name), "utf8")) as unknown;
  const evidence: Evidence = {
    manifest: record(json("cohort-manifest.v1.json")),
    summary: record(json("collection-summary.v1.json")),
    sources: json("source-inventory.v1.json") as RecordValue[],
    units: readFileSync(path.join(fixture.root, "units.v1.ndjson"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => record(JSON.parse(line))),
  };
  action(evidence);
  if (recount) {
    const counts = {
      DISCOVERY: evidence.sources.filter((s) => s.category === "DISCOVERY").length,
      MARKET_CONTEXT: evidence.sources.filter((s) => s.category === "MARKET_CONTEXT").length,
    };
    evidence.manifest.providerCounts = counts;
    evidence.summary.providerCounts = counts;
    evidence.summary.validUnitCount = evidence.units.length;
    evidence.summary.slotCount = (evidence.manifest.slots as unknown[]).length;
    evidence.summary.dateCounts = countRawDates(evidence.units);
  }
  for (const [name, value] of [
    ["cohort-manifest.v1.json", evidence.manifest],
    ["collection-summary.v1.json", evidence.summary],
    ["source-inventory.v1.json", evidence.sources],
  ] as const) {
    writeFileSync(path.join(fixture.root, name), JSON.stringify(value));
  }
  writeFileSync(
    path.join(fixture.root, "units.v1.ndjson"),
    evidence.units.map((u) => JSON.stringify(u)).join("\n") + "\n",
  );
  return { ...fixture, identity: rewriteInternalHashes(fixture.root) };
}
function put(root: unknown, keys: readonly (string | number)[], value: unknown): void {
  let current = record(root);
  for (const key of keys.slice(0, -1)) current = record(current[String(key)]);
  const key = String(keys.at(-1));
  if (value === undefined) delete current[key];
  else current[key] = value;
}

describe("H1 strict parser", () => {
  it.each(
    [
      [],
      ["--once"],
      ["--format=markdown"],
      ["--format=json"],
      ["--", "--once", "--format=json"],
    ].map((args) => ({ args })),
  )("accepts supported arguments $args", ({ args }) => {
    expect(parseMeasurementCohortAnalysisArgs(args)).toEqual({
      once: args.includes("--once"),
      format: args.includes("--format=json") ? "json" : "markdown",
    });
  });
  it.each(
    [
      ["--format="],
      ["--format=JSON"],
      ["--format=csv"],
      ["--once=true"],
      ["--format", "json"],
      ["--format=json", "--format=json"],
      ["--once", "--once"],
      ["positional"],
      ["--config=x"],
    ].map((args) => ({ args })),
  )("rejects malformed arguments $args", ({ args }) => {
    expectErrorCode(
      () => parseMeasurementCohortAnalysisArgs(args),
      "MEASUREMENT_COHORT_ANALYSIS_INVALID_SCOPE",
    );
  });
});

describe("H1 final archive integrity", () => {
  const mutations: readonly [string, readonly (string | number)[], unknown][] = [
    ["collecting manifest", ["manifest", "outcome"], "COLLECTING"],
    ["quality-stop final state", ["manifest", "outcome"], "MEASUREMENT_COHORT_DATA_QUALITY_STOP"],
    ["wrong summary outcome", ["summary", "outcome"], "MEASUREMENT_COHORT_DATA_INSUFFICIENT"],
    ["wrong unit count", ["summary", "validUnitCount"], 95],
    ["wrong slot count", ["summary", "slotCount"], 95],
    ["wrong date count", ["summary", "dateCounts"], {}],
    ["wrong internal hash", ["manifest", "finalFileHashes", "units.v1.ndjson"], "0".repeat(64)],
    ["wrong archive root", ["manifest", "archiveRoot"], "data/archive/other/"],
    ["wrong launch root", ["manifest", "launch", "archiveRoot"], "data/archive/other/"],
    ["wrong launch start", ["manifest", "launch", "cohortStartAt"], "2026-09-05T21:00:00.000Z"],
    ["wrong launch protocol path", ["manifest", "launch", "protocolPath"], "other.json"],
    ["wrong launch protocol hash", ["manifest", "launch", "protocolSha256"], "0".repeat(64)],
    [
      "wrong launch validation fingerprint",
      ["manifest", "launch", "protocolValidationFingerprint"],
      "0".repeat(64),
    ],
    ["wrong authorization", ["manifest", "launch", "authorization"], "AUTOMATIC"],
    ["execution enabled", ["manifest", "executionDisabled"], false],
    ["duplicate slot", ["manifest", "slots", 1, "slotId"], "SLOT_001"],
    ["catch-up index", ["manifest", "slots", 1, "slotIndex"], 4],
    ["replacement anchor", ["manifest", "slots", 1, "anchorAt"], "2026-09-05T21:00:00.000Z"],
    ["count order", ["manifest", "slots", 0, "discoveryCounts", "canonical"], 2],
    ["missing selected mint", ["manifest", "slots", 0, "selectedMint"], undefined],
    [
      "selected without candidates",
      ["manifest", "slots", 0, "discoveryCounts", "technicallyValid"],
      0,
    ],
    ["replacement reason", ["manifest", "slots", 0, "reason"], "REPLACEMENT"],
    ["duplicate unit slot", ["units", 1, "slotId"], "SLOT_001"],
    ["wrong unit identity", ["units", 0, "unitId"], "0".repeat(24)],
    ["wrong selection hash", ["units", 0, "selection", "selectionHash"], "0".repeat(64)],
    ["wrong selection provenance", ["units", 0, "selection", "sourceKind"], "OTHER"],
    ["invalid selection time", ["units", 0, "selection", "firstObservedAt"], "yesterday"],
    ["wrong partition", ["units", 0, "partition"], "VALIDATION"],
    ["wrong unit anchor", ["units", 0, "anchorAt"], "2026-09-05T21:00:00.000Z"],
    [
      "invalid availability",
      ["units", 0, "decisionTime", "market", "liquidityUsd", "availability"],
      "UNKNOWN",
    ],
    ["invalid source provider", ["sources", 0, "provider"], "OTHER"],
    ["retry source", ["sources", 0, "attemptCount"], 2],
    ["multiple source requests", ["sources", 0, "requestCount"], 2],
    ["invalid latency", ["sources", 0, "latencyBucket"], "FAST"],
    ["unbounded source outcome", ["sources", 0, "outcomeCode"], "A".repeat(81)],
    ["invalid source date", ["sources", 0, "observedAt"], "today"],
  ];
  it.each(mutations)(
    "rejects %s with a matching external fixture identity",
    (name, keys, value) => {
      let fixture = edit(makeFinalFixture(), (evidence) => put(evidence, keys, value));
      // Preserve the deliberately wrong internal hash while binding only the external file bytes.
      if (name === "wrong internal hash") {
        const file = path.join(fixture.root, "cohort-manifest.v1.json");
        const manifest = record(JSON.parse(readFileSync(file, "utf8")));
        record(manifest.finalFileHashes)["units.v1.ndjson"] = "0".repeat(64);
        writeFileSync(file, JSON.stringify(manifest));
        fixture = {
          ...fixture,
          identity: {
            ...fixture.identity,
            artifacts: {
              ...fixture.identity.artifacts,
              "cohort-manifest.v1.json": hash(readFileSync(file)),
            },
          },
        };
      }
      expectErrorCode(() => loadFixture(fixture), inconsistent);
    },
  );

  it.each(["manifest", "summary"] as const)(
    "rejects every nonzero/true %s safety fact",
    (section) => {
      for (const field of [
        "databaseReads",
        "databaseWrites",
        "sessions",
        "orders",
        "fills",
        "positions",
        "walletLoaded",
        "transactionSigning",
        "transactionSubmission",
      ]) {
        const fixture = edit(makeFinalFixture(), (evidence) => {
          const safety = record(evidence[section].safety);
          safety[field] = typeof safety[field] === "boolean" ? true : 1;
        });
        expectErrorCode(() => loadFixture(fixture), inconsistent);
      }
    },
  );
  it.each([
    "laterObservations",
    "returnPct",
    "targetFirst",
    "stopFirst",
    "pnl",
    "mfe",
    "mae",
    "riskScore",
    "strategyScore",
    "strategyDecision",
  ])("quarantines %s in units and summary", (field) => {
    for (const section of ["units", "summary"] as const) {
      const fixture = edit(makeFinalFixture(), (evidence) =>
        put(evidence, section === "units" ? ["units", 0, field] : ["summary", field], 1),
      );
      expectErrorCode(
        () => loadFixture(fixture),
        "MEASUREMENT_COHORT_ANALYSIS_LABEL_QUARANTINE_VIOLATION",
      );
    }
  });
  it.each(["https://synthetic.invalid", "Bearer synthetic", "api_key synthetic"])(
    "quarantines unsafe content %s",
    (text) => {
      const fixture = edit(makeFinalFixture(), (e) =>
        put(e, ["manifest", "launch", "operator", "label"], text),
      );
      expectErrorCode(
        () => loadFixture(fixture),
        "MEASUREMENT_COHORT_ANALYSIS_LABEL_QUARANTINE_VIOLATION",
      );
    },
  );
  it.each(["DISCOVERY", "MARKET_CONTEXT"] as const)(
    "rejects a coherently counted %s cap excess",
    (category) => {
      const fixture = edit(
        makeFinalFixture(),
        (e) => {
          const cap = category === "DISCOVERY" ? 168 : 672;
          e.sources = e.sources.filter((s) => s.category !== category);
          for (let i = 0; i <= cap; i++)
            e.sources.push(
              source(
                category,
                category === "DISCOVERY" ? "DISCOVER_TOKENS" : "BEST_PAIR",
                "2026-09-04T20:44:00.000Z",
              ),
            );
        },
        true,
      );
      expectErrorCode(() => loadFixture(fixture), inconsistent);
    },
  );
  it("rejects more than the frozen unit cap even under an insufficient outcome", () => {
    expectErrorCode(() => loadFixture(makeFinalFixture({ unitCount: 97 })), inconsistent);
  });
  it("rejects a COMPLETE outcome when its objective gates fail", () => {
    const fixture = edit(makeFinalFixture({ unavailableLiquidity: 6 }), (e) => {
      e.manifest.outcome = e.summary.outcome = "COHORT_COMPLETE";
    });
    expectErrorCode(() => loadFixture(fixture), inconsistent);
  });
  it("rejects non-finite JSON numbers with a matching artifact identity", () => {
    const fixture = makeFinalFixture();
    const file = path.join(fixture.root, "units.v1.ndjson");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/"value":\d+(?:\.\d+)?/, '"value":1e400'),
    );
    expectErrorCode(
      () => loadFixture({ ...fixture, identity: rewriteInternalHashes(fixture.root) }),
      inconsistent,
    );
  });
  it("rejects more than 168 slots", () => {
    const fixture = edit(
      makeFinalFixture(),
      (e) => {
        const slots = e.manifest.slots as unknown[];
        while (slots.length < 169) slots.push(slots[0]);
      },
      true,
    );
    expectErrorCode(() => loadFixture(fixture), inconsistent);
  });
  it("rejects a duplicate mint even with repaired unit, selection, and slot references", () => {
    const fixture = edit(makeFinalFixture(), (e) => {
      const first = e.units[0]!;
      const second = e.units[1]!;
      second.canonicalMint = first.canonicalMint;
      second.unitId = hash(`${second.slotId}|${second.canonicalMint}`).slice(0, 24);
      const selection = hash(
        `phase10.6a-exploratory-cohort.v3|${second.canonicalMint}|${second.slotId}`,
      );
      record(second.selection).selectionHash = selection;
      second.partition = parseInt(selection.at(-1)!, 16) % 2 === 0 ? "DISCOVERY" : "VALIDATION";
      put(e, ["manifest", "slots", 1, "selectedMint"], first.canonicalMint);
    });
    expectErrorCode(() => loadFixture(fixture), inconsistent);
  });
  it("rejects a base58-shaped mint that is not 32 bytes", () => {
    const fixture = edit(makeFinalFixture(), (e) => {
      const unit = e.units[0]!;
      unit.canonicalMint = "A".repeat(32);
      unit.unitId = hash(`${unit.slotId}|${unit.canonicalMint}`).slice(0, 24);
      const selection = hash(
        `phase10.6a-exploratory-cohort.v3|${unit.canonicalMint}|${unit.slotId}`,
      );
      record(unit.selection).selectionHash = selection;
      unit.partition = parseInt(selection.at(-1)!, 16) % 2 === 0 ? "DISCOVERY" : "VALIDATION";
      put(e, ["manifest", "slots", 0, "selectedMint"], unit.canonicalMint);
    });
    expectErrorCode(() => loadFixture(fixture), inconsistent);
  });
  it.each(["NO_SELECTION", "SKIP_UNIT_WITH_REASON"])(
    "accepts a valid %s slot without creating a replacement unit",
    (state) => {
      const fixture = edit(
        makeFinalFixture(),
        (e) => {
          put(e, ["manifest", "slots", 1, "state"], state);
          put(
            e,
            ["manifest", "slots", 1, "selectedMint"],
            state === "NO_SELECTION" ? undefined : e.units[0]!.canonicalMint,
          );
          put(
            e,
            ["manifest", "slots", 1, "reason"],
            state === "NO_SELECTION" ? "NO_TECHNICALLY_VALID_CANONICAL_MINT" : "DUPLICATE_MINT",
          );
          e.units.splice(1, 1);
          e.sources.splice(6, 4);
          e.manifest.outcome = e.summary.outcome = "MEASUREMENT_COHORT_DATA_INSUFFICIENT";
        },
        true,
      );
      expect(loadFixture(fixture).validUnitCount).toBe(95);
    },
  );
  it("rejects category/capability mismatch after repairing its source hash", () => {
    const fixture = edit(makeFinalFixture(), (e) => {
      e.sources[0] = source("DISCOVERY", "BEST_PAIR", "2026-09-04T20:44:00.000Z");
    });
    expectErrorCode(() => loadFixture(fixture), inconsistent);
  });
  it("projects source dates in UTC when the timestamp includes an offset", () => {
    const fixture = edit(makeFinalFixture(), (e) => {
      e.sources[0] = source("DISCOVERY", "DISCOVER_TOKENS", "2026-09-04T23:44:00.000-07:00");
    });
    expect(loadFixture(fixture).sources[0]!.utcDate).toBe("2026-09-05");
  });
  it.each([
    "cohort-manifest.v1.json",
    "units.v1.ndjson",
    "source-inventory.v1.json",
    "collection-summary.v1.json",
  ])("rejects malformed JSON in %s", (name) => {
    const fixture = makeFinalFixture();
    writeFileSync(path.join(fixture.root, name), "{");
    if (name === "cohort-manifest.v1.json") {
      const identity = {
        ...fixture.identity,
        artifacts: { ...fixture.identity.artifacts, [name]: hash("{") },
      };
      expectErrorCode(() => loadFixture({ ...fixture, identity }), inconsistent);
    } else
      expectErrorCode(
        () => loadFixture({ ...fixture, identity: rewriteInternalHashes(fixture.root) }),
        inconsistent,
      );
  });
  it("rejects an injected wrong protocol identity", () => {
    const fixture = makeFinalFixture();
    const identity = {
      ...fixture.identity,
      protocolSha256: "0".repeat(64),
    } as unknown as Fixture["identity"];
    expectErrorCode(
      () => new MeasurementCohortAnalysisLoader({ identity }).load(fixture.root, fixture.repoRoot),
      inconsistent,
    );
  });
  it.each(["units.v1.ndjson", "protocol"])("rejects a real file symlink for %s", (name) => {
    const fixture = makeFinalFixture();
    const other = makeFinalFixture();
    const relative = name === "protocol" ? MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH : name;
    const file = path.join(name === "protocol" ? fixture.repoRoot : fixture.root, relative);
    const target = path.join(name === "protocol" ? other.repoRoot : other.root, relative);
    unlinkSync(file);
    symlinkSync(target, file, "file");
    links.push(file);
    expectErrorCode(() => loadFixture(fixture), inconsistent);
  });
});

describe("H1 value, missingness and freshness", () => {
  it("accepts zero available liquidity under the nonnegative value contract", () => {
    const fixture = edit(makeFinalFixture(), (e) => {
      put(e, ["units", 0, "decisionTime", "snapshots", 3, "liquidityUsd", "value"], 0);
      put(e, ["units", 0, "decisionTime", "market", "liquidityUsd", "value"], 0);
    });
    expect(loadFixture(fixture).units[0]!.facts.LIQUIDITY.availability).toBe("AVAILABLE_AT_ANCHOR");
  });
  it("inherits unavailable prior momentum input and gives an unavailable current input precedence", () => {
    const prior = {
      availability: "PROVIDER_ERROR",
      sourceCategory: "MARKET_CONTEXT",
      sourceIdentifier: "BEST_PAIR",
      sourceTimestamp: "2026-09-04T20:55:00.000Z",
    };
    const fixture = edit(makeFinalFixture(), (e) => {
      put(e, ["units", 0, "decisionTime", "snapshots", 2, "priceUsd"], prior);
      put(e, ["units", 0, "decisionTime", "market", "momentum5mPct"], prior);
    });
    expect(loadFixture(fixture).units[0]!.facts.MOMENTUM_5M.availability).toBe("PROVIDER_ERROR");
    const current = {
      ...prior,
      availability: "STALE_AT_ANCHOR",
      sourceTimestamp: "2026-09-04T20:58:00.000Z",
    };
    const both = edit(fixture, (e) => {
      put(e, ["units", 0, "decisionTime", "snapshots", 3, "priceUsd"], current);
      put(e, ["units", 0, "decisionTime", "market", "momentum5mPct"], current);
      put(e, ["units", 0, "decisionTime", "market", "momentum15mPct"], current);
    });
    expect(loadFixture(both).units[0]!.facts.MOMENTUM_5M.availability).toBe("STALE_AT_ANCHOR");
    const wrong = edit(both, (e) =>
      put(e, ["units", 0, "decisionTime", "market", "momentum5mPct"], prior),
    );
    expectErrorCode(() => loadFixture(wrong), inconsistent);
  });
  it.each([-60001, -60000, 60000, 60001])(
    "enforces the signed %i ms freshness edge for price and liquidity",
    (delta) => {
      for (const field of ["priceUsd", "liquidityUsd"]) {
        const fixture = edit(makeFinalFixture(), (e) => {
          const unit = e.units[0]!;
          const snapshots = record(unit.decisionTime).snapshots as RecordValue[];
          const anchor = snapshots[3]!;
          const fact = record(anchor[field]);
          fact.sourceTimestamp = new Date(
            Date.parse(String(anchor.scheduledAt)) + delta,
          ).toISOString();
          if (field === "liquidityUsd")
            record(record(unit.decisionTime).market).liquidityUsd = fact;
        });
        if (Math.abs(delta) <= 60000) expect(loadFixture(fixture).validUnitCount).toBe(96);
        else expectErrorCode(() => loadFixture(fixture), inconsistent);
      }
    },
  );
  it.each([
    ["missing price", ["snapshots", 0, "priceUsd", "value"], undefined],
    ["zero price", ["snapshots", 0, "priceUsd", "value"], 0],
    ["negative price", ["snapshots", 0, "priceUsd", "value"], -1],
    ["null price", ["snapshots", 0, "priceUsd", "value"], null],
    ["string price", ["snapshots", 0, "priceUsd", "value"], "1"],
    ["missing timestamp", ["snapshots", 0, "priceUsd", "sourceTimestamp"], undefined],
    ["wrong market provenance", ["snapshots", 0, "priceUsd", "sourceCategory"], "LOCAL"],
    ["wrong formula provenance", ["market", "momentum5mPct", "sourceIdentifier"], "BEST_PAIR"],
    [
      "formula timestamp",
      ["market", "momentum5mPct", "sourceTimestamp"],
      "2026-09-04T21:00:00.000Z",
    ],
    ["wrong formula value", ["market", "momentum5mPct", "value"], 500],
    ["duplicate snapshot", ["snapshots", 0, "offsetMinutes"], -10],
    ["wrong snapshot time", ["snapshots", 0, "scheduledAt"], "2026-09-04T21:00:00.000Z"],
    ["non-anchor liquidity", ["snapshots", 0, "liquidityUsd"], {}],
  ] as const)("rejects %s", (_name, keys, value) => {
    const fixture = edit(makeFinalFixture(), (e) =>
      put(record(e.units[0]!.decisionTime), keys, value),
    );
    expectErrorCode(() => loadFixture(fixture), inconsistent);
  });
  it.each([undefined, -1, null, "5000"])("rejects matching invalid liquidity value %j", (value) => {
    const fixture = edit(makeFinalFixture(), (e) => {
      put(e, ["units", 0, "decisionTime", "snapshots", 3, "liquidityUsd", "value"], value);
      put(e, ["units", 0, "decisionTime", "market", "liquidityUsd", "value"], value);
    });
    expectErrorCode(() => loadFixture(fixture), inconsistent);
  });
  it.each([
    "NOT_REQUESTED",
    "UNAVAILABLE_AT_ANCHOR",
    "STALE_AT_ANCHOR",
    "BUDGET_EXHAUSTED",
    "PROVIDER_ERROR",
    "UNSUPPORTED",
    "INVALID_VALUE",
  ])(
    "preserves %s and rejects a retained value or mismatched inherited timestamp",
    (availability) => {
      const fixture = edit(makeFinalFixture(), (e) => {
        const fact = {
          availability,
          sourceCategory: "MARKET_CONTEXT",
          sourceIdentifier: "BEST_PAIR",
          sourceTimestamp: "2026-09-04T20:59:00.000Z",
        };
        put(e, ["units", 0, "decisionTime", "snapshots", 3, "priceUsd"], fact);
        put(e, ["units", 0, "decisionTime", "market", "momentum5mPct"], fact);
        put(e, ["units", 0, "decisionTime", "market", "momentum15mPct"], fact);
        e.manifest.outcome = e.summary.outcome = "MEASUREMENT_COHORT_DATA_INSUFFICIENT";
      });
      expect(loadFixture(fixture).units[0]!.facts.MOMENTUM_5M.availability).toBe(availability);
      const badTimestamp = edit(fixture, (e) =>
        put(
          e,
          ["units", 0, "decisionTime", "market", "momentum5mPct", "sourceTimestamp"],
          undefined,
        ),
      );
      expectErrorCode(() => loadFixture(badTimestamp), inconsistent);
      const retained = edit(fixture, (e) =>
        put(e, ["units", 0, "decisionTime", "snapshots", 3, "priceUsd", "value"], 1),
      );
      expectErrorCode(() => loadFixture(retained), inconsistent);
    },
  );
  it("accepts collector-defined INVALID_VALUE for finite price ratio overflow", () => {
    const fixture = edit(makeFinalFixture(), (e) => {
      put(e, ["units", 0, "decisionTime", "snapshots", 0, "priceUsd", "value"], 1e-300);
      put(e, ["units", 0, "decisionTime", "snapshots", 2, "priceUsd", "value"], 1e-300);
      put(e, ["units", 0, "decisionTime", "snapshots", 3, "priceUsd", "value"], 1e300);
      const fact = {
        availability: "INVALID_VALUE",
        sourceCategory: "MARKET_CONTEXT",
        sourceIdentifier: "BEST_PAIR",
      };
      put(e, ["units", 0, "decisionTime", "market", "momentum5mPct"], fact);
      put(e, ["units", 0, "decisionTime", "market", "momentum15mPct"], fact);
      e.manifest.outcome = e.summary.outcome = "MEASUREMENT_COHORT_DATA_INSUFFICIENT";
    });
    expect(loadFixture(fixture).units[0]!.facts.MOMENTUM_5M.availability).toBe("INVALID_VALUE");
  });
});
