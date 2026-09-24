import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MeasurementCohortArchiveService } from "./MeasurementCohortArchiveService.js";
import { parseMeasurementCohortArgs } from "./MeasurementCohortConfig.js";
import { MeasurementCohortError } from "./MeasurementCohortErrors.js";
import {
  assertLaunchProtocolIdentity,
  measurementLaunchSchemaForTests,
} from "./MeasurementCohortLaunch.js";
import {
  measurementCompletionGatesPass,
  MeasurementCohortRunner,
} from "./MeasurementCohortRunner.js";
import {
  canonicalCandidates,
  partitionFor,
  selectCandidate,
  selectionHash,
} from "./MeasurementCohortSelection.js";
import type {
  MeasurementArchiveState,
  MeasurementCohortClock,
  MeasurementCohortGateway,
  MeasurementCohortLaunchRecord,
  MeasurementCohortUnit,
  MeasurementGatewayResult,
} from "./MeasurementCohortTypes.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("Phase 10.6A.2 isolated V3 measurement collector", () => {
  it("default-denies unsafe scope before a launch source or gateway can be used", () => {
    expect(() => parseMeasurementCohortArgs([])).toThrow(MeasurementCohortError);
    for (const option of [
      "--archive-root=data/archive/phase10.6a/measurement-v3-20260905-0000Z",
      "--provider=anything",
      "--scheduler=anything",
      "--paper",
      "--wallet",
      "--once",
      "--once",
    ]) {
      expect(() =>
        parseMeasurementCohortArgs([
          `--protocol=docs/research-protocols/phase10.6a-exploratory-cohort.v3.json`,
          "--launch=docs/research-launches/phase10.6a-measurement-v3-20260905-0000Z.json",
          "--once",
          option,
        ]),
      ).toThrow(MeasurementCohortError);
    }
  });

  it("accepts only the fixed non-secret launch identity", () => {
    const launch = launchFor("2026-09-05T00:00:00.000Z");
    expect(measurementLaunchSchemaForTests().parse(launch)).toEqual(launch);
    expect(() =>
      assertLaunchProtocolIdentity({ ...launch, protocolSha256: "0".repeat(64) }),
    ).toThrow(MeasurementCohortError);
  });

  it("selects and partitions by the pinned hash without measurement facts", () => {
    const candidates = canonicalCandidates([
      candidate("So11111111111111111111111111111111111111112"),
      candidate("11111111111111111111111111111111"),
      { ...candidate("bad"), sourceKind: "" },
    ]);
    const selected = selectCandidate(candidates, "SLOT_001");
    expect(selected).toBeDefined();
    expect(selectionHash(selected?.mint ?? "", "SLOT_001")).toHaveLength(64);
    expect(partitionFor(selected?.mint ?? "", "SLOT_001")).toMatch(/DISCOVERY|VALIDATION/);
  });

  it("runs the exact fake-clock discovery and four pre-anchor observations with no later observation", async () => {
    const anchor = new Date("2026-09-05T00:00:00.000Z");
    const clock = new FakeClock(new Date(anchor.valueOf() - 16 * 60 * 1000));
    const gateway = new FakeGateway(clock, [10, 11, 12, 15]);
    const { archive } = createArchive(anchor, clock);
    const result = await new MeasurementCohortRunner({
      launch: launchFor(anchor.toISOString()),
      archive,
      clock,
      gateway,
    }).runOnce();

    expect(gateway.calls).toEqual(["DISCOVERY:100", "MARKET", "MARKET", "MARKET", "MARKET"]);
    expect(result.invocationProviderCalls).toBe(5);
    expect(result.outcome).toBe("COLLECTING");
    const state = archive.open(anchor);
    expect(state.units).toHaveLength(1);
    expect(
      state.units[0]?.decisionTime.snapshots.map((snapshot) => snapshot.offsetMinutes),
    ).toEqual([-15, -10, -5, 0]);
    expect(state.units[0]?.decisionTime.market.liquidityUsd.value).toBe(100);
    expect(state.units[0]?.decisionTime.market.momentum5mPct.value).toBe(25);
    expect(state.units[0]?.decisionTime.market.momentum15mPct.value).toBe(50);
    archive.release();
  });

  it("retains missingness rather than dropping or replacing a valid technical unit", async () => {
    const anchor = new Date("2026-09-05T00:00:00.000Z");
    const clock = new FakeClock(new Date(anchor.valueOf() - 16 * 60 * 1000));
    const gateway = new FakeGateway(clock, [undefined, undefined, undefined, undefined]);
    const { archive } = createArchive(anchor, clock);
    await new MeasurementCohortRunner({
      launch: launchFor(anchor.toISOString()),
      archive,
      clock,
      gateway,
    }).runOnce();
    const state = archive.open(anchor);
    expect(state.units).toHaveLength(1);
    expect(state.units[0]?.decisionTime.market.liquidityUsd.availability).toBe(
      "UNAVAILABLE_AT_ANCHOR",
    );
    expect(state.units[0]?.decisionTime.market.momentum5mPct.availability).toBe(
      "UNAVAILABLE_AT_ANCHOR",
    );
    archive.release();
  });

  it("retains stale, provider-error, and invalid-value availability codes exactly", async () => {
    const cases = [
      { mode: "STALE" as const, price: 10, expected: "STALE_AT_ANCHOR" },
      { mode: "FAILURE" as const, price: 10, expected: "PROVIDER_ERROR" },
      { mode: "OK" as const, price: -1, expected: "INVALID_VALUE" },
    ];
    for (const item of cases) {
      const anchor = new Date("2026-09-05T00:00:00.000Z");
      const clock = new FakeClock(new Date(anchor.valueOf() - 16 * 60 * 1000));
      const gateway = new FakeGateway(
        clock,
        [item.price, item.price, item.price, item.price],
        item.mode,
      );
      const { archive } = createArchive(anchor, clock);
      await new MeasurementCohortRunner({
        launch: launchFor(anchor.toISOString()),
        archive,
        clock,
        gateway,
      }).runOnce();
      const state = archive.open(anchor);
      expect(state.units[0]?.decisionTime.market.liquidityUsd.availability).toBe(item.expected);
      expect(state.units[0]?.decisionTime.market.momentum15mPct.availability).toBe(item.expected);
      expect(JSON.stringify(state.sources)).not.toMatch(/https?:\/\/|bearer|api[_ -]?key/i);
      archive.release();
    }
  });

  it("refuses a simultaneous opener and a duplicate current slot without a provider call", async () => {
    const anchor = new Date("2026-09-05T00:00:00.000Z");
    const clock = new FakeClock(new Date(anchor.valueOf() - 16 * 60 * 1000));
    const { archive, root } = createArchive(anchor, clock);
    archive.open(anchor);
    const concurrent = new MeasurementCohortArchiveService(
      root,
      launchFor(anchor.toISOString()),
      () => clock.now(),
    );
    expect(() => concurrent.open(anchor)).toThrow(/active invocation/);
    archive.release();

    const gateway = new FakeGateway(clock, [10, 11, 12, 15]);
    await new MeasurementCohortRunner({
      launch: launchFor(anchor.toISOString()),
      archive,
      clock,
      gateway,
    }).runOnce();
    const before = gateway.calls.length;
    clock.set(new Date(anchor.valueOf() - 16 * 60 * 1000));
    await expect(
      new MeasurementCohortRunner({
        launch: launchFor(anchor.toISOString()),
        archive,
        clock,
        gateway,
      }).runOnce(),
    ).rejects.toMatchObject({ code: "MEASUREMENT_COHORT_ARCHIVE_CONFLICT" });
    expect(gateway.calls).toHaveLength(before);
  });

  it("fails closed for an unreadable active archive without changing it", () => {
    const anchor = new Date("2026-09-05T00:00:00.000Z");
    const clock = new FakeClock(new Date(anchor.valueOf() - 16 * 60 * 1000));
    const { archive, root } = createArchive(anchor, clock);
    archive.open(anchor);
    archive.release();
    const manifest = path.join(root, "cohort-manifest.v1.json");
    writeFileSync(manifest, "{broken", "utf8");
    const before = Buffer.from("{broken");
    expect(() => archive.open(anchor)).toThrow(/cannot be parsed/);
    expect(Buffer.from(requireFile(manifest))).toEqual(before);
  });

  it("closes a parseable stale lock only as V3 insufficiency", () => {
    const anchor = new Date("2026-09-05T00:00:00.000Z");
    const clock = new FakeClock(new Date(anchor.valueOf() - 16 * 60 * 1000));
    const { archive, root } = createArchive(anchor, clock);
    archive.open(anchor); // leave its lock to model an interrupted process
    clock.set(new Date(anchor.valueOf() + 61_000));
    const recovery = new MeasurementCohortArchiveService(
      root,
      launchFor(anchor.toISOString()),
      () => clock.now(),
    );
    const state = recovery.open(anchor);
    expect(recovery.recoveredStaleLock).toBe(true);
    expect(recovery.finalize(state, "MEASUREMENT_COHORT_DATA_INSUFFICIENT").manifest.outcome).toBe(
      "MEASUREMENT_COHORT_DATA_INSUFFICIENT",
    );
  });

  it("requires every frozen completion gate, including availability by partition", () => {
    const state = gateState();
    expect(measurementCompletionGatesPass(state)).toBe(true);
    const broken: MeasurementArchiveState = {
      ...state,
      units: state.units.map((unit, index) =>
        index < 10 && index % 2 === 0
          ? {
              ...unit,
              decisionTime: {
                ...unit.decisionTime,
                market: { ...unit.decisionTime.market, momentum5mPct: unavailable() },
              },
            }
          : unit,
      ),
    };
    expect(measurementCompletionGatesPass(broken)).toBe(false);
  });
});

function createArchive(
  anchor: Date,
  clock: FakeClock,
): { readonly archive: MeasurementCohortArchiveService; readonly root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "nexustrade-v3-measurement-"));
  roots.push(root);
  return {
    archive: new MeasurementCohortArchiveService(root, launchFor(anchor.toISOString()), () =>
      clock.now(),
    ),
    root,
  };
}

function launchFor(cohortStartAt: string): MeasurementCohortLaunchRecord {
  const stamp = `${cohortStartAt.slice(0, 10).replaceAll("-", "")}-${cohortStartAt.slice(11, 16).replace(":", "")}Z`;
  return {
    contractVersion: "1",
    archiveRoot: `data/archive/phase10.6a/measurement-v3-${stamp}/`,
    cohortStartAt,
    protocolPath: "docs/research-protocols/phase10.6a-exploratory-cohort.v3.json",
    protocolSha256: "dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458",
    protocolValidationFingerprint:
      "b992982000ac2e0fb51cd7944a979adc0114f77a6845b3d36a3d88b9eab3e4e6",
    authorization: "USER_AUTHORIZED_FOR_ONE_MEASUREMENT_ONLY_COLLECTION",
    authorizationReference: "synthetic fixture",
    operator: { kind: "EXTERNAL_OPERATOR", label: "synthetic fixture" },
  };
}

function candidate(mint: string) {
  return {
    mint,
    sourceKind: "DEXSCREENER_TOKEN_PROFILE",
    firstObservedAt: new Date("2026-09-04T23:44:00.000Z"),
  };
}

class FakeClock implements MeasurementCohortClock {
  constructor(private value: Date) {}
  now(): Date {
    return new Date(this.value);
  }
  async sleepUntil(target: Date): Promise<void> {
    if (target.valueOf() > this.value.valueOf()) this.value = new Date(target);
  }
  set(value: Date): void {
    this.value = new Date(value);
  }
}

class FakeGateway implements MeasurementCohortGateway {
  readonly calls: string[] = [];
  private index = 0;
  constructor(
    private readonly clock: FakeClock,
    private readonly prices: readonly (number | undefined)[],
    private readonly mode: "OK" | "STALE" | "FAILURE" = "OK",
  ) {}
  async discover(
    limit: 100,
  ): Promise<MeasurementGatewayResult<readonly ReturnType<typeof candidate>[]>> {
    this.calls.push(`DISCOVERY:${limit}`);
    return {
      ok: true,
      value: [candidate("So11111111111111111111111111111111111111112")],
      observedAt: this.clock.now(),
      outcomeCode: "OK",
      latencyMs: 1,
    };
  }
  async marketContext(): Promise<
    MeasurementGatewayResult<{
      readonly observedAt: Date;
      readonly priceUsd?: number;
      readonly liquidityUsd?: number;
    }>
  > {
    this.calls.push("MARKET");
    const price = this.prices[this.index++];
    const observedAt = new Date(this.clock.now().valueOf() + (this.mode === "STALE" ? 61_000 : 0));
    if (this.mode === "FAILURE")
      return { ok: false, observedAt, outcomeCode: "TIMEOUT", latencyMs: 1 };
    return {
      ok: true,
      value: {
        observedAt,
        ...(price === undefined ? {} : { priceUsd: price, liquidityUsd: price < 0 ? -1 : 100 }),
      },
      observedAt,
      outcomeCode: "OK",
      latencyMs: 1,
    };
  }
}

function gateState(): MeasurementArchiveState {
  const units: MeasurementCohortUnit[] = Array.from({ length: 96 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 5 + Math.floor(index / 8), 0, (index % 8) * 2));
    const available = {
      availability: "AVAILABLE_AT_ANCHOR",
      sourceCategory: "LOCAL",
      sourceIdentifier: "FORMULA",
      value: 1,
    } as const;
    return {
      unitId: String(index),
      slotId: `SLOT_${index}`,
      anchorAt: date.toISOString(),
      canonicalMint: `Mint${index}`,
      partition: index % 2 === 0 ? "DISCOVERY" : "VALIDATION",
      selection: {
        sourceKind: "SYNTHETIC",
        firstObservedAt: date.toISOString(),
        selectionHash: "a".repeat(64),
      },
      decisionTime: {
        snapshots: [],
        market: { liquidityUsd: available, momentum5mPct: available, momentum15mPct: available },
      },
    };
  });
  return {
    manifest: {
      contractVersion: "1",
      archiveRoot: "synthetic",
      launch: launchFor("2026-09-05T00:00:00.000Z"),
      executionDisabled: true,
      outcome: "COLLECTING",
      slots: [],
      providerCounts: { DISCOVERY: 0, MARKET_CONTEXT: 0 },
      safety: {
        databaseReads: 0,
        databaseWrites: 0,
        sessions: 0,
        orders: 0,
        fills: 0,
        positions: 0,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      },
    },
    units,
    sources: [],
  };
}

function unavailable() {
  return {
    availability: "UNAVAILABLE_AT_ANCHOR",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
  } as const;
}

function requireFile(file: string): string {
  return readFileSync(file, "utf8");
}
