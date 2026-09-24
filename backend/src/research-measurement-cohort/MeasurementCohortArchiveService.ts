import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  MEASUREMENT_COHORT_ARCHIVE_FILES,
  MEASUREMENT_COHORT_STALE_LOCK_GRACE_MS,
} from "./MeasurementCohortConstants.js";
import { MeasurementCohortError } from "./MeasurementCohortErrors.js";
import type {
  MeasurementArchiveState,
  MeasurementCohortLaunchRecord,
  MeasurementCohortManifest,
  MeasurementCohortOutcome,
  MeasurementCohortUnit,
  MeasurementSlotRecord,
  MeasurementSourceRecord,
} from "./MeasurementCohortTypes.js";

interface LockRecord {
  readonly token: string;
  readonly anchorAt: string;
}

/**
 * A small self-contained immutable archive implementation. It intentionally
 * does not share V2 source or state: the V3 launch is the only authority.
 */
export class MeasurementCohortArchiveService {
  private token: string | undefined;
  private staleRecovered = false;

  constructor(
    private readonly root: string,
    private readonly launch: MeasurementCohortLaunchRecord,
    private readonly now: () => Date,
  ) {}

  open(anchorAt: Date): MeasurementArchiveState {
    mkdirSync(this.root, { recursive: true });
    const lockPath = this.pathFor("lock");
    if (existsSync(lockPath)) return this.handleExistingLock(anchorAt);
    this.acquire(anchorAt);
    try {
      if (!existsSync(this.pathFor("manifest"))) {
        const state = initialState(this.root, this.launch);
        this.persistActive(state);
        return state;
      }
      return this.readActive();
    } catch (error) {
      this.release();
      if (error instanceof MeasurementCohortError) throw error;
      throw dataQuality("The active V3 archive cannot be parsed or structurally validated.");
    }
  }

  /** A stale root may only be terminally closed; it can never resume collection. */
  get recoveredStaleLock(): boolean {
    return this.staleRecovered;
  }

  checkpoint(
    state: MeasurementArchiveState,
    input: {
      readonly slot: MeasurementSlotRecord;
      readonly unit?: MeasurementCohortUnit;
      readonly sources: readonly MeasurementSourceRecord[];
    },
  ): MeasurementArchiveState {
    this.assertOwned();
    assertSafe(input);
    if (state.manifest.outcome !== "COLLECTING") {
      throw conflict("A final V3 archive is immutable.");
    }
    if (state.manifest.slots.some((slot) => slot.slotId === input.slot.slotId)) {
      throw conflict("The canonical V3 slot is already recorded.");
    }
    if (
      input.unit &&
      state.units.some((unit) => unit.canonicalMint === input.unit?.canonicalMint)
    ) {
      throw conflict("A V3 canonical mint is already recorded.");
    }
    const providerCounts = countProviders([...state.sources, ...input.sources]);
    const next: MeasurementArchiveState = {
      manifest: {
        ...state.manifest,
        slots: [...state.manifest.slots, input.slot],
        providerCounts,
      },
      units: input.unit ? [...state.units, input.unit] : state.units,
      sources: [...state.sources, ...input.sources],
    };
    this.persistActive(next);
    return next;
  }

  finalize(
    state: MeasurementArchiveState,
    outcome: Exclude<MeasurementCohortOutcome, "COLLECTING">,
  ): MeasurementArchiveState {
    this.assertOwned();
    if (state.manifest.outcome !== "COLLECTING")
      throw conflict("A final V3 archive cannot be finalized again.");
    const preFinal: MeasurementArchiveState = {
      ...state,
      manifest: { ...withoutActiveHashes(state.manifest), outcome },
    };
    const summary = summaryFor(preFinal);
    writeFileSync(this.pathFor("units"), canonicalNdjson(preFinal.units), "utf8");
    writeFileSync(this.pathFor("sourceInventory"), canonicalJson(preFinal.sources), "utf8");
    writeFileSync(this.pathFor("summary"), canonicalJson(summary), "utf8");
    const finalState: MeasurementArchiveState = {
      ...preFinal,
      manifest: {
        ...preFinal.manifest,
        finalFileHashes: {
          [MEASUREMENT_COHORT_ARCHIVE_FILES.units]: hashFile(this.pathFor("units")),
          [MEASUREMENT_COHORT_ARCHIVE_FILES.sourceInventory]: hashFile(
            this.pathFor("sourceInventory"),
          ),
          [MEASUREMENT_COHORT_ARCHIVE_FILES.summary]: hashFile(this.pathFor("summary")),
        },
      },
    };
    writeFileSync(this.pathFor("manifest"), canonicalJson(finalState.manifest), "utf8");
    this.release();
    return finalState;
  }

  release(): void {
    const token = this.token;
    if (!token) return;
    const lockPath = this.pathFor("lock");
    try {
      const lock = parseLock(readFileSync(lockPath, "utf8"));
      if (lock.token === token) rmSync(lockPath);
    } finally {
      this.token = undefined;
    }
  }

  private handleExistingLock(anchorAt: Date): MeasurementArchiveState {
    const lockPath = this.pathFor("lock");
    let lock: LockRecord;
    try {
      lock = parseLock(readFileSync(lockPath, "utf8"));
    } catch {
      throw dataQuality("The existing V3 lock is unreadable; no archive artifact was changed.");
    }
    const lockAnchor = new Date(lock.anchorAt);
    if (
      Number.isNaN(lockAnchor.valueOf()) ||
      this.now().valueOf() <= lockAnchor.valueOf() + MEASUREMENT_COHORT_STALE_LOCK_GRACE_MS
    ) {
      throw conflict("The V3 archive is already owned by an active invocation.");
    }
    let staleState: MeasurementArchiveState;
    try {
      staleState = this.readActive();
    } catch {
      throw dataQuality("The stale V3 archive is unreadable; no artifact was changed.");
    }
    // The stale lock is parseable and the state is proven consistent. Remove only
    // that exact observed lock before taking a new exclusive lock for closeout.
    if (parseLock(readFileSync(lockPath, "utf8")).token !== lock.token) {
      throw conflict("The V3 archive lock changed while stale closeout was being checked.");
    }
    rmSync(lockPath);
    this.acquire(anchorAt);
    this.staleRecovered = true;
    return staleState;
  }

  private acquire(anchorAt: Date): void {
    const token = randomUUID();
    try {
      writeFileSync(
        this.pathFor("lock"),
        canonicalJson({ token, anchorAt: anchorAt.toISOString() } satisfies LockRecord),
        { encoding: "utf8", flag: "wx" },
      );
      this.token = token;
    } catch {
      throw conflict("The V3 archive could not acquire its exclusive lock.");
    }
  }

  private readActive(): MeasurementArchiveState {
    const manifest = parseJson<MeasurementCohortManifest>(
      readFileSync(this.pathFor("manifest"), "utf8"),
    );
    const units = parseNdjson<MeasurementCohortUnit>(readFileSync(this.pathFor("units"), "utf8"));
    const sources = parseJson<readonly MeasurementSourceRecord[]>(
      readFileSync(this.pathFor("sourceInventory"), "utf8"),
    );
    const state = { manifest, units, sources } satisfies MeasurementArchiveState;
    assertState(state, this.root, this.launch);
    return state;
  }

  private persistActive(state: MeasurementArchiveState): void {
    this.assertOwned();
    const withoutHashes: MeasurementArchiveState = {
      ...state,
      manifest: withoutActiveHashes(state.manifest),
    };
    writeFileSync(this.pathFor("units"), canonicalNdjson(withoutHashes.units), "utf8");
    writeFileSync(this.pathFor("sourceInventory"), canonicalJson(withoutHashes.sources), "utf8");
    const manifest: MeasurementCohortManifest = {
      ...withoutHashes.manifest,
      activeFileHashes: {
        [MEASUREMENT_COHORT_ARCHIVE_FILES.units]: hashFile(this.pathFor("units")),
        [MEASUREMENT_COHORT_ARCHIVE_FILES.sourceInventory]: hashFile(
          this.pathFor("sourceInventory"),
        ),
      },
    };
    writeFileSync(this.pathFor("manifest"), canonicalJson(manifest), "utf8");
  }

  private assertOwned(): void {
    if (!this.token) throw conflict("The V3 archive operation does not own the exclusive lock.");
  }

  private pathFor(file: keyof typeof MEASUREMENT_COHORT_ARCHIVE_FILES): string {
    return path.join(this.root, MEASUREMENT_COHORT_ARCHIVE_FILES[file]);
  }
}

function initialState(
  root: string,
  launch: MeasurementCohortLaunchRecord,
): MeasurementArchiveState {
  return {
    manifest: {
      contractVersion: "1",
      archiveRoot: launch.archiveRoot,
      launch,
      executionDisabled: true,
      outcome: "COLLECTING",
      slots: [],
      providerCounts: { DISCOVERY: 0, MARKET_CONTEXT: 0 },
      safety: zeroSafety,
    },
    units: [],
    sources: [],
  };
}

const zeroSafety = {
  databaseReads: 0,
  databaseWrites: 0,
  sessions: 0,
  orders: 0,
  fills: 0,
  positions: 0,
  walletLoaded: false,
  transactionSigning: false,
  transactionSubmission: false,
} as const;

function assertState(
  state: MeasurementArchiveState,
  root: string,
  launch: MeasurementCohortLaunchRecord,
): void {
  if (
    state.manifest.contractVersion !== "1" ||
    state.manifest.archiveRoot !== launch.archiveRoot ||
    canonicalJson(state.manifest.launch) !== canonicalJson(launch) ||
    !state.manifest.executionDisabled ||
    canonicalJson(state.manifest.safety) !== canonicalJson(zeroSafety)
  ) {
    throw dataQuality("The V3 archive manifest identity or safety facts are inconsistent.");
  }
  const slotIds = new Set(state.manifest.slots.map((slot) => slot.slotId));
  const mints = new Set(state.units.map((unit) => unit.canonicalMint));
  if (
    slotIds.size !== state.manifest.slots.length ||
    mints.size !== state.units.length ||
    state.units.some((unit) => !slotIds.has(unit.slotId))
  ) {
    throw dataQuality("The V3 archive slot or canonical-mint ledger is inconsistent.");
  }
  if (state.manifest.activeFileHashes) {
    const expected = state.manifest.activeFileHashes;
    if (
      expected[MEASUREMENT_COHORT_ARCHIVE_FILES.units] !==
        hashFile(path.join(root, MEASUREMENT_COHORT_ARCHIVE_FILES.units)) ||
      expected[MEASUREMENT_COHORT_ARCHIVE_FILES.sourceInventory] !==
        hashFile(path.join(root, MEASUREMENT_COHORT_ARCHIVE_FILES.sourceInventory))
    ) {
      throw dataQuality("The active V3 archive hash inventory is inconsistent.");
    }
  }
  if (state.manifest.finalFileHashes) {
    for (const [name, expected] of Object.entries(state.manifest.finalFileHashes)) {
      if (expected !== hashFile(path.join(root, name))) {
        throw dataQuality("The final V3 archive hash inventory is inconsistent.");
      }
    }
  }
  assertSafe(state);
}

function countProviders(
  sources: readonly MeasurementSourceRecord[],
): Record<"DISCOVERY" | "MARKET_CONTEXT", number> {
  return {
    DISCOVERY: sources.filter((source) => source.category === "DISCOVERY").length,
    MARKET_CONTEXT: sources.filter((source) => source.category === "MARKET_CONTEXT").length,
  };
}

function withoutActiveHashes(manifest: MeasurementCohortManifest): MeasurementCohortManifest {
  const { activeFileHashes, ...withoutHashes } = manifest;
  void activeFileHashes;
  return withoutHashes;
}

function summaryFor(state: MeasurementArchiveState): Record<string, unknown> {
  return {
    contractVersion: "1",
    outcome: state.manifest.outcome,
    validUnitCount: state.units.length,
    slotCount: state.manifest.slots.length,
    providerCounts: state.manifest.providerCounts,
    safety: zeroSafety,
    dateCounts: Object.fromEntries(
      [...new Set(state.units.map((unit) => unit.anchorAt.slice(0, 10)))]
        .sort()
        .map((date) => [date, state.units.filter((unit) => unit.anchorAt.startsWith(date)).length]),
    ),
  };
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sort(value))}\n`;
}

function canonicalNdjson(values: readonly unknown[]): string {
  return (
    values.map((value) => JSON.stringify(sort(value))).join("\n") + (values.length > 0 ? "\n" : "")
  );
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
  );
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function parseNdjson<T>(value: string): readonly T[] {
  return value.trim() === ""
    ? []
    : value
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as T);
}

function parseLock(value: string): LockRecord {
  const parsed = parseJson<Partial<LockRecord>>(value);
  if (typeof parsed.token !== "string" || typeof parsed.anchorAt !== "string")
    throw new Error("invalid lock");
  return { token: parsed.token, anchorAt: parsed.anchorAt };
}

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertSafe(value: unknown): void {
  if (containsUnsafeValue(value)) {
    throw dataQuality("The V3 archive contains prohibited secret-like or network content.");
  }
}

function containsUnsafeValue(value: unknown): boolean {
  if (typeof value === "string") {
    return /\b(?:api[ _-]?key|private[ _-]?key|bearer|password)\b|https?:\/\//i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsUnsafeValue);
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some(containsUnsafeValue);
}

function conflict(message: string): MeasurementCohortError {
  return new MeasurementCohortError("MEASUREMENT_COHORT_ARCHIVE_CONFLICT", message);
}

function dataQuality(message: string): MeasurementCohortError {
  return new MeasurementCohortError("MEASUREMENT_COHORT_DATA_QUALITY_STOP", message);
}
