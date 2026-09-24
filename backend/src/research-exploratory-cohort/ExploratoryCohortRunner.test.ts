import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXPLORATORY_COHORT_PROTOCOL_PATH,
  EXPLORATORY_COHORT_PROTOCOL_SHA256,
  EXPLORATORY_COHORT_PROTOCOL_VALIDATION_FINGERPRINT,
} from "./ExploratoryCohortConstants.js";
import { ExploratoryCohortArchiveService } from "./ExploratoryCohortArchiveService.js";
import { parseExploratoryCohortArgs } from "./ExploratoryCohortConfig.js";
import { ExploratoryCohortError } from "./ExploratoryCohortErrors.js";
import { parseExploratoryCohortLaunchRecord } from "./ExploratoryCohortLaunch.js";
import { ExploratoryCohortRunner } from "./ExploratoryCohortRunner.js";
import { isCanonicalSolanaMint } from "./ExploratoryCohortSelection.js";
import type {
  ExploratoryCohortClock,
  ExploratoryCohortGateway,
  ExploratoryCohortLaunchRecord,
  GatewayResult,
} from "./ExploratoryCohortTypes.js";

const roots: string[] = [];
const mint = "So11111111111111111111111111111111111111112";
const startAt = "2026-09-01T00:00:00.000Z";
const archiveRoot = "data/archive/phase10.6a/exploratory-cohort-v2-20260901-0000Z";

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true }));
});

describe("ExploratoryCohortRunner", () => {
  it("acquires the first-root lock before a second opener can write initial artifacts", () => {
    const root = createRoot();
    const clock = new FakeClock("2026-09-01T01:59:00.000Z");
    const first = new ExploratoryCohortArchiveService({
      root,
      archiveRoot,
      launch: launch(),
      now: () => clock.now(),
    });
    const second = new ExploratoryCohortArchiveService({
      root,
      archiveRoot,
      launch: launch(),
      now: () => clock.now(),
    });

    first.open("SLOT_001");
    const initialManifest = readFileSync(path.join(root, "cohort-manifest.v1.json"), "utf8");

    expectCode(() => second.open("SLOT_001"), "EXPLORATORY_COHORT_ARCHIVE_CONFLICT");
    expect(readFileSync(path.join(root, "cohort-manifest.v1.json"), "utf8")).toBe(initialManifest);
    expect(existsSync(path.join(root, "collection.lock"))).toBe(true);
  });

  it("collects one outcome-blind unit through the exact discovery capability with labels separate", async () => {
    const root = createRoot();
    const clock = new FakeClock("2026-09-01T01:59:00.000Z");
    const gateway = new FakeGateway(clock);
    const result = await createRunner(root, clock, gateway).run();

    expect(result).toMatchObject({ outcome: "COLLECTING", validUnitCount: 1, providerCalls: 7 });
    expect(gateway.discoveryLimits).toEqual([100]);
    const dexRequestTimes = gateway.requestTimes.DEXSCREENER;
    expect(dexRequestTimes).toHaveLength(6);
    expect((dexRequestTimes[1] as number) - (dexRequestTimes[0] as number)).toBeGreaterThanOrEqual(
      60_000,
    );
    const units = readFileSync(path.join(root, "units.v1.ndjson"), "utf8");
    expect(units).toContain('"laterObservations"');
    expect(units).toContain('"decisionTime"');
    expect((JSON.parse(units) as { laterObservations: unknown[] }).laterObservations).toHaveLength(
      4,
    );
    expect(units).not.toContain("RAW_PROVIDER_PAYLOAD");
    expect(existsSync(path.join(root, "collection.lock"))).toBe(false);
    const sources = JSON.parse(
      readFileSync(path.join(root, "source-inventory.v1.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(7);
    for (const source of sources) {
      const { sourceHash, ...sanitized } = source;
      expect(source).toMatchObject({ requestCount: 1, attemptCount: 1 });
      expect(sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(sourceHash).toBe(createHash("sha256").update(JSON.stringify(sanitized)).digest("hex"));
    }
  });

  it("fails closed without a provider call when the direct discovery capability is unavailable", async () => {
    const root = createRoot();
    const clock = new FakeClock("2026-09-01T01:59:00.000Z");
    const gateway = new FakeGateway(clock, false);
    const result = await createRunner(root, clock, gateway).run();

    expect(result).toMatchObject({ outcome: "HUMAN_REVIEW_REQUIRED", providerCalls: 0 });
    expect(gateway.callCount).toBe(0);
    expect(readFileSync(path.join(root, "collection-summary.v1.json"), "utf8")).toContain(
      "DIRECT_DISCOVERY_CAPABILITY_UNAVAILABLE",
    );
  });

  it("finalizes a stale crash lock as incomplete without making another provider call", async () => {
    const root = createRoot();
    const firstClock = new FakeClock("2026-09-01T01:59:00.000Z");
    await createRunner(root, firstClock, new FakeGateway(firstClock)).run();
    writeFileSync(
      path.join(root, "collection.lock"),
      JSON.stringify({
        archiveRoot,
        slotId: "SLOT_001",
        acquiredAt: "2026-09-01T00:00:00.000Z",
      }),
      "utf8",
    );
    const secondClock = new FakeClock("2026-09-01T03:59:00.000Z");
    const secondGateway = new FakeGateway(secondClock);
    const result = await createRunner(root, secondClock, secondGateway).run();

    expect(result.outcome).toBe("COHORT_INCOMPLETE");
    expect(secondGateway.callCount).toBe(0);
    expect(existsSync(path.join(root, "collection.lock"))).toBe(false);
    expect(readFileSync(path.join(root, "collection-summary.v1.json"), "utf8")).toContain(
      "STALE_LOCK_AFTER_INTERRUPTED_PROCESS",
    );
    const summary = JSON.parse(
      readFileSync(path.join(root, "collection-summary.v1.json"), "utf8"),
    ) as {
      partitionCounts: Record<string, number>;
      utcDateCounts: Record<string, number>;
      concentration: { distinctMintCount: number; maximumUtcDateSharePct: number };
      laterObservations: {
        totalCount: number;
        availabilityCounts: Record<string, number>;
        missingOrInvalidCount: number;
      };
      providerBudgetUse: Record<string, { used: number; cap: number }>;
      safetyCounters: { databaseReads: number; transactionSubmission: boolean };
      nonAuthorizingOutcome: string;
    };
    expect(Object.values(summary.partitionCounts)).toEqual([1]);
    expect(summary.utcDateCounts).toEqual({ "2026-09-01": 1 });
    expect(summary.concentration).toEqual({ distinctMintCount: 1, maximumUtcDateSharePct: 100 });
    expect(summary.laterObservations).toMatchObject({
      totalCount: 4,
      availabilityCounts: { OBSERVED_ON_TIME: 4 },
      missingOrInvalidCount: 0,
    });
    expect(summary.providerBudgetUse).toMatchObject({
      DISCOVERY: { used: 1, cap: 168 },
      LATER_OBSERVATION: { used: 4, cap: 672 },
    });
    expect(summary.safetyCounters).toMatchObject({
      databaseReads: 0,
      transactionSubmission: false,
    });
    expect(summary.nonAuthorizingOutcome).toContain("does not authorize");
  });

  it("finalizes a stale first-root lock with no initial artifacts without a provider call", async () => {
    const root = createRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "collection.lock"),
      JSON.stringify({
        archiveRoot,
        slotId: "SLOT_001",
        acquiredAt: "2026-09-01T00:00:00.000Z",
      }),
      "utf8",
    );
    const clock = new FakeClock("2026-09-01T01:59:00.000Z");
    const gateway = new FakeGateway(clock);
    const result = await createRunner(root, clock, gateway).run();

    expect(result.outcome).toBe("COHORT_INCOMPLETE");
    expect(gateway.callCount).toBe(0);
    expect(existsSync(path.join(root, "collection.lock"))).toBe(false);
    expect(readFileSync(path.join(root, "cohort-manifest.v1.json"), "utf8")).toContain(
      "STALE_LOCK_AFTER_INTERRUPTED_PROCESS",
    );
  });

  it("rejects fresh cross-process lock ownership before a provider call", async () => {
    const root = createRoot();
    const firstClock = new FakeClock("2026-09-01T01:59:00.000Z");
    await createRunner(root, firstClock, new FakeGateway(firstClock)).run();
    const clock = new FakeClock("2026-09-01T03:59:00.000Z");
    writeFileSync(
      path.join(root, "collection.lock"),
      JSON.stringify({ archiveRoot, slotId: "SLOT_001", acquiredAt: clock.now().toISOString() }),
      "utf8",
    );
    const gateway = new FakeGateway(clock);

    await expect(createRunner(root, clock, gateway).run()).rejects.toMatchObject({
      code: "EXPLORATORY_COHORT_ARCHIVE_CONFLICT",
    });
    expect(gateway.callCount).toBe(0);
  });

  it("records missing later labels without a call for each expired observation window", async () => {
    const root = createRoot();
    const clock = new LateFakeClock("2026-09-01T01:59:00.000Z");
    const gateway = new FakeGateway(clock);
    await createRunner(root, clock, gateway).run();

    expect(gateway.laterCallCount).toBe(2);
    expect(readFileSync(path.join(root, "units.v1.ndjson"), "utf8")).toContain(
      "WINDOW_EXPIRED_BEFORE_REQUEST",
    );
  });

  it("stops before a provider call when persisted provider counts conflict with source inventory", async () => {
    const root = createRoot();
    const firstClock = new FakeClock("2026-09-01T01:59:00.000Z");
    await createRunner(root, firstClock, new FakeGateway(firstClock)).run();
    const manifest = readManifest(root);
    manifest.providerCounts.DISCOVERY = 168;
    writeActiveManifest(root, manifest);
    const before = snapshotArchive(root);
    const clock = new FakeClock("2026-09-01T03:59:00.000Z");
    const gateway = new FakeGateway(clock);

    await expect(createRunner(root, clock, gateway).run()).rejects.toMatchObject({
      code: "EXPLORATORY_COHORT_DATA_QUALITY_STOP",
    });
    expect(gateway.callCount).toBe(0);
    expect(snapshotArchive(root)).toEqual(before);
  });

  it("ledgers elapsed missed external slots before the next normal provider call", async () => {
    const root = createRoot();
    const firstClock = new FakeClock("2026-09-01T01:59:00.000Z");
    await createRunner(root, firstClock, new FakeGateway(firstClock)).run();

    const secondClock = new FakeClock("2026-09-01T05:59:00.000Z");
    const secondGateway = new FakeGateway(secondClock);
    const result = await createRunner(root, secondClock, secondGateway).run();

    expect(result).toMatchObject({ slotId: "SLOT_003", invocationProviderCalls: 1 });
    const manifest = readManifest(root);
    expect(manifest.slots).toHaveLength(3);
    expect(manifest.slots[1]).toEqual({
      slotId: "SLOT_002",
      slotIndex: 1,
      anchorAt: "2026-09-01T04:00:00.000Z",
      state: "PAUSE_WINDOW",
      reason: "EXTERNAL_INVOCATION_MISSED",
      discoveryCounts: { returned: 0, canonical: 0, technicallyValid: 0 },
    });
    expect(secondGateway.discoveryLimits).toEqual([100]);
  });

  it("rejects a duplicate current-slot invocation without changing any archive artifact", async () => {
    const root = createRoot();
    const firstClock = new FakeClock("2026-09-01T01:59:00.000Z");
    await createRunner(root, firstClock, new FakeGateway(firstClock)).run();
    const before = snapshotArchive(root);
    const duplicateClock = new FakeClock("2026-09-01T01:59:00.000Z");
    const duplicateGateway = new FakeGateway(duplicateClock);

    await expect(createRunner(root, duplicateClock, duplicateGateway).run()).rejects.toMatchObject({
      code: "EXPLORATORY_COHORT_ARCHIVE_CONFLICT",
    });
    expect(duplicateGateway.callCount).toBe(0);
    expect(snapshotArchive(root)).toEqual(before);
  });

  it("fails closed without writes or provider calls when active evidence cannot be hash-validated", async () => {
    const root = createRoot();
    const firstClock = new FakeClock("2026-09-01T01:59:00.000Z");
    await createRunner(root, firstClock, new FakeGateway(firstClock)).run();
    const unitsPath = path.join(root, "units.v1.ndjson");
    writeFileSync(unitsPath, `${readFileSync(unitsPath, "utf8")}tampered\n`, "utf8");
    const before = snapshotArchive(root);
    const secondClock = new FakeClock("2026-09-01T03:59:00.000Z");
    const secondGateway = new FakeGateway(secondClock);

    await expect(createRunner(root, secondClock, secondGateway).run()).rejects.toMatchObject({
      code: "EXPLORATORY_COHORT_DATA_QUALITY_STOP",
    });
    expect(secondGateway.callCount).toBe(0);
    expect(snapshotArchive(root)).toEqual(before);
  });

  it("fails closed before a provider call when a parseable ledger contains a future slot", async () => {
    const root = createRoot();
    const firstClock = new FakeClock("2026-09-01T01:59:00.000Z");
    await createRunner(root, firstClock, new FakeGateway(firstClock)).run();
    const manifest = readManifest(root);
    manifest.slots.push({
      slotId: "SLOT_003",
      slotIndex: 2,
      anchorAt: "2026-09-01T06:00:00.000Z",
      state: "PAUSE_WINDOW",
      reason: "EXTERNAL_INVOCATION_MISSED",
      discoveryCounts: { returned: 0, canonical: 0, technicallyValid: 0 },
    });
    writeActiveManifest(root, manifest);
    const before = snapshotArchive(root);
    const secondClock = new FakeClock("2026-09-01T03:59:00.000Z");
    const secondGateway = new FakeGateway(secondClock);

    await expect(createRunner(root, secondClock, secondGateway).run()).rejects.toMatchObject({
      code: "EXPLORATORY_COHORT_DATA_QUALITY_STOP",
    });
    expect(secondGateway.callCount).toBe(0);
    expect(snapshotArchive(root)).toEqual(before);
  });

  it("finalizes the terminal normal slot by canonical index after earlier scheduler misses", async () => {
    const root = createRoot();
    const clock = new FakeClock("2026-09-14T23:59:00.000Z");
    const gateway = new FakeGateway(clock);
    const result = await createRunner(root, clock, gateway).run();

    expect(result).toMatchObject({ outcome: "COHORT_INCOMPLETE", slotId: "SLOT_168" });
    expect(readManifest(root).slots).toHaveLength(168);
    expect(existsSync(path.join(root, "collection.lock"))).toBe(false);
  });

  it("runs provider-free post-window closeout only for an existing active root", async () => {
    const root = createRoot();
    const firstClock = new FakeClock("2026-09-01T01:59:00.000Z");
    await createRunner(root, firstClock, new FakeGateway(firstClock)).run();
    const closeoutClock = new FakeClock("2026-09-15T01:01:00.000Z");
    const result = await createFinalizer(root, closeoutClock).run();

    expect(result).toMatchObject({
      mode: "FINALIZE_MISSED_SLOTS",
      outcome: "COHORT_INCOMPLETE",
      invocationProviderCalls: 0,
      databaseReads: 0,
      databaseWrites: 0,
      runtimeCalls: 0,
    });
    expect(readManifest(root).slots).toHaveLength(168);
    expect(readFileSync(path.join(root, "collection-summary.v1.json"), "utf8")).toContain(
      "POST_WINDOW_MISSED_SLOT_CLOSEOUT",
    );
    const beforeRepeat = snapshotArchive(root);
    const repeated = await createFinalizer(root, closeoutClock).run();
    expect(repeated).toMatchObject({ outcome: "COHORT_INCOMPLETE", invocationProviderCalls: 0 });
    expect(snapshotArchive(root)).toEqual(beforeRepeat);
  });

  it("rejects early or missing-root provider-free closeout without archive creation", async () => {
    const root = createRoot();
    const earlyClock = new FakeClock("2026-09-15T01:00:00.000Z");

    await expect(createFinalizer(root, earlyClock).run()).rejects.toMatchObject({
      code: "EXPLORATORY_COHORT_PRECONDITION_UNMET",
    });
    expect(existsSync(root)).toBe(false);

    const permittedClock = new FakeClock("2026-09-15T01:01:00.000Z");
    await expect(createFinalizer(root, permittedClock).run()).rejects.toMatchObject({
      code: "EXPLORATORY_COHORT_PRECONDITION_UNMET",
    });
    expect(existsSync(root)).toBe(false);
  });
});

describe("exploratory cohort guards", () => {
  it("accepts only the V2 CLI shape and rejects unsafe launch content", () => {
    expect(
      parseExploratoryCohortArgs([
        `--protocol=${EXPLORATORY_COHORT_PROTOCOL_PATH}`,
        `--archive-root=${archiveRoot}`,
        "--once",
      ]),
    ).toMatchObject({ archiveRoot, once: true });
    expect(
      parseExploratoryCohortArgs([
        `--protocol=${EXPLORATORY_COHORT_PROTOCOL_PATH}`,
        `--archive-root=${archiveRoot}`,
        "--finalize-missed-slots",
      ]),
    ).toMatchObject({ archiveRoot, mode: "FINALIZE_MISSED_SLOTS", once: false });
    expectCode(
      () =>
        parseExploratoryCohortArgs([
          `--protocol=${EXPLORATORY_COHORT_PROTOCOL_PATH}`,
          `--archive-root=${archiveRoot}`,
          "--once",
          "--finalize-missed-slots",
        ]),
      "EXPLORATORY_COHORT_INVALID_SCOPE",
    );
    expectCode(
      () =>
        parseExploratoryCohortArgs([
          `--protocol=${EXPLORATORY_COHORT_PROTOCOL_PATH}`,
          `--archive-root=${archiveRoot}`,
          "--once",
          "--wallet=anything",
        ]),
      "EXPLORATORY_COHORT_INVALID_SCOPE",
    );
    expectCode(
      () =>
        parseExploratoryCohortLaunchRecord({
          ...launch(),
          authorizationReference: "https://unsafe",
        }),
      "EXPLORATORY_COHORT_PRECONDITION_UNMET",
    );
    expect(isCanonicalSolanaMint(mint)).toBe(true);
    expect(isCanonicalSolanaMint("not-a-mint")).toBe(false);
  });

  it("keeps the collector free of database, session, strategy, paper, and execution imports", () => {
    const source = readFileSync(new URL("./ExploratoryCohortRunner.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /from\s+["'][^"']*(?:db|session|scanner|strategy|paper|wallet|terminal|watchlist)[^"']*["']/i,
    );
    expect(source).not.toMatch(/ProviderRegistry|QuoteProviderRouter|createPaperDatabaseContext/);
    const gatewaySource = readFileSync(
      new URL("./DirectExploratoryCohortGateway.ts", import.meta.url),
      "utf8",
    );
    expect(gatewaySource).not.toContain("onlyDirectRoutes");
  });
});

function createRoot(): string {
  const parent = mkdtempSync(path.join(os.tmpdir(), "nexustrade-phase10.6a-"));
  roots.push(parent);
  return path.join(parent, "archive");
}

function createRunner(
  root: string,
  clock: FakeClock,
  gateway: FakeGateway,
): ExploratoryCohortRunner {
  return new ExploratoryCohortRunner({
    config: parseExploratoryCohortArgs([
      `--protocol=${EXPLORATORY_COHORT_PROTOCOL_PATH}`,
      `--archive-root=${archiveRoot}`,
      "--once",
      "--format=json",
    ]),
    gateway,
    clock,
    loadLaunch: () => launch(),
    createArchive: (input) => new ExploratoryCohortArchiveService({ ...input, root }),
  });
}

function createFinalizer(root: string, clock: FakeClock): ExploratoryCohortRunner {
  return new ExploratoryCohortRunner({
    config: parseExploratoryCohortArgs([
      `--protocol=${EXPLORATORY_COHORT_PROTOCOL_PATH}`,
      `--archive-root=${archiveRoot}`,
      "--finalize-missed-slots",
      "--format=json",
    ]),
    clock,
    loadLaunch: () => launch(),
    createArchive: (input) => new ExploratoryCohortArchiveService({ ...input, root }),
  });
}

interface TestManifest extends Record<string, unknown> {
  readonly slots: Array<Record<string, unknown>>;
  readonly providerCounts: Record<string, number>;
  activeFileHashes?: Record<string, string>;
}

function readManifest(root: string): TestManifest {
  return JSON.parse(
    readFileSync(path.join(root, "cohort-manifest.v1.json"), "utf8"),
  ) as TestManifest;
}

function writeActiveManifest(root: string, manifest: TestManifest): void {
  const preimage = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "activeFileHashes"),
  );
  manifest.activeFileHashes = {
    ...activeFileHashes(manifest),
    "cohort-manifest.v1.json": createHash("sha256")
      .update(stableJsonForTest(preimage))
      .digest("hex"),
  };
  writeFileSync(path.join(root, "cohort-manifest.v1.json"), stableJsonForTest(manifest), "utf8");
}

function activeFileHashes(manifest: TestManifest): Record<string, string> {
  if (!manifest.activeFileHashes) throw new Error("Expected active archive file hashes.");
  return manifest.activeFileHashes;
}

function stableJsonForTest(value: unknown): string {
  return `${JSON.stringify(sortForTest(value), null, 2)}\n`;
}

function sortForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForTest);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortForTest(item)]),
  );
}

function snapshotArchive(root: string): Record<string, string | undefined> {
  return Object.fromEntries(
    [
      "cohort-manifest.v1.json",
      "units.v1.ndjson",
      "source-inventory.v1.json",
      "collection-summary.v1.json",
      "collection.lock",
    ].map((name) => {
      const artifact = path.join(root, name);
      return [name, existsSync(artifact) ? readFileSync(artifact, "utf8") : undefined];
    }),
  );
}

function launch(): ExploratoryCohortLaunchRecord {
  return {
    contractVersion: "1",
    archiveRoot,
    cohortStartAt: startAt,
    protocolPath: EXPLORATORY_COHORT_PROTOCOL_PATH,
    protocolSha256: EXPLORATORY_COHORT_PROTOCOL_SHA256,
    protocolValidationFingerprint: EXPLORATORY_COHORT_PROTOCOL_VALIDATION_FINGERPRINT,
    authorization: "USER_AUTHORIZED_FOR_ONE_OBSERVATIONAL_COLLECTION",
    authorizationReference: "phase10_6a_approved",
  };
}

class FakeClock implements ExploratoryCohortClock {
  protected current: Date;

  constructor(value: string) {
    this.current = new Date(value);
  }

  now(): Date {
    return new Date(this.current);
  }

  async sleepUntil(target: Date): Promise<void> {
    if (target.getTime() > this.current.getTime()) this.current = new Date(target);
  }
}

class FakeGateway implements ExploratoryCohortGateway {
  readonly quoteAvailable = true;
  readonly discoveryLimits: number[] = [];
  readonly requestTimes: Record<"DEXSCREENER" | "JUPITER", number[]> = {
    DEXSCREENER: [],
    JUPITER: [],
  };
  callCount = 0;
  laterCallCount = 0;

  constructor(
    private readonly clock: FakeClock,
    readonly available = true,
  ) {}

  async discover(limit: 100): Promise<
    GatewayResult<
      readonly {
        readonly mint: string;
        readonly sourceKind: string;
        readonly firstObservedAt: Date;
      }[]
    >
  > {
    this.callCount += 1;
    this.requestTimes.DEXSCREENER.push(this.clock.now().getTime());
    this.discoveryLimits.push(limit);
    return ok(this.clock, "DEXSCREENER", [
      { mint, sourceKind: "DEXSCREENER_TOKEN_PROFILE", firstObservedAt: this.clock.now() },
    ]);
  }

  async marketContext(): Promise<
    GatewayResult<{
      readonly observedAt: Date;
      readonly priceUsd?: number;
      readonly liquidityUsd?: number;
      readonly volume5mUsd?: number;
      readonly volume1hUsd?: number;
    }>
  > {
    this.callCount += 1;
    this.requestTimes.DEXSCREENER.push(this.clock.now().getTime());
    return ok(this.clock, "DEXSCREENER", {
      observedAt: this.clock.now(),
      priceUsd: 1,
      liquidityUsd: 2,
      volume5mUsd: 3,
      volume1hUsd: 4,
    });
  }

  async quoteImpact(): Promise<
    GatewayResult<{ readonly observedAt: Date; readonly priceImpactBps?: number }>
  > {
    this.callCount += 1;
    this.requestTimes.JUPITER.push(this.clock.now().getTime());
    return ok(this.clock, "JUPITER", { observedAt: this.clock.now(), priceImpactBps: 12 });
  }

  async laterPrice(): Promise<GatewayResult<{ readonly priceUsd?: number }>> {
    this.callCount += 1;
    this.laterCallCount += 1;
    this.requestTimes.DEXSCREENER.push(this.clock.now().getTime());
    return ok(this.clock, "DEXSCREENER", { priceUsd: 1.1 });
  }
}

class LateFakeClock extends FakeClock {
  override async sleepUntil(target: Date): Promise<void> {
    if (target.getTime() > this.current.getTime()) {
      this.current = new Date(target.getTime() + 31_000);
    }
  }
}

function ok<T>(clock: FakeClock, provider: "DEXSCREENER" | "JUPITER", value: T): GatewayResult<T> {
  return { ok: true, value, observedAt: clock.now(), provider, outcomeCode: "OK", latencyMs: 1 };
}

function expectCode(action: () => unknown, code: ExploratoryCohortError["code"]): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ExploratoryCohortError);
    expect((error as ExploratoryCohortError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}
