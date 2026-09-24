import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  EXPLORATORY_COHORT_LOCK_STALE_MS,
  EXPLORATORY_COHORT_PROVIDER_CAPS,
} from "./ExploratoryCohortConstants.js";
import { ExploratoryCohortError } from "./ExploratoryCohortErrors.js";
import type {
  ArchiveState,
  CohortManifest,
  ExploratoryCohortLaunchRecord,
} from "./ExploratoryCohortTypes.js";

const manifestName = "cohort-manifest.v1.json";
const unitsName = "units.v1.ndjson";
const sourcesName = "source-inventory.v1.json";
const summaryName = "collection-summary.v1.json";
const lockName = "collection.lock";

interface LockRecord {
  readonly archiveRoot: string;
  readonly slotId: string;
  readonly acquiredAt: string;
  readonly ownerId?: string;
}

export interface OpenArchiveResult {
  readonly state: ArchiveState;
  readonly staleLockFinalized: boolean;
}

export class ExploratoryCohortArchiveService {
  private readonly lockOwnerId = randomUUID();

  constructor(
    private readonly options: {
      readonly root: string;
      readonly archiveRoot: string;
      readonly launch: ExploratoryCohortLaunchRecord;
      readonly now: () => Date;
    },
  ) {}

  open(
    slotId: string,
    mode: "COLLECT_SLOT" | "FINALIZE_MISSED_SLOTS" = "COLLECT_SLOT",
  ): OpenArchiveResult {
    if (!existsSync(this.options.root)) {
      if (mode === "FINALIZE_MISSED_SLOTS") {
        throw precondition("Provider-free closeout requires an existing active archive root.");
      }
      mkdirSync(this.options.root, { recursive: true });
      this.writeLock({
        archiveRoot: this.options.archiveRoot,
        slotId,
        acquiredAt: this.options.now().toISOString(),
      });
      try {
        const initial = initialState(this.options.archiveRoot, this.options.launch);
        this.writeActiveState(initial);
        return { state: initial, staleLockFinalized: false };
      } catch (error: unknown) {
        this.removeOwnedLock();
        throw error;
      }
    }

    const lockPath = this.path(lockName);
    if (existsSync(lockPath)) {
      const staleState = this.finalizeStaleLockIfPresent(mode, slotId);
      if (staleState)
        return {
          state: staleState,
          staleLockFinalized: staleState.manifest.outcome !== "COLLECTING",
        };
      throw conflict("An active collector already owns this archive root.");
    }

    if (mode === "FINALIZE_MISSED_SLOTS") {
      const inspected = this.readState();
      if (inspected.manifest.outcome !== "COLLECTING") {
        return { state: inspected, staleLockFinalized: false };
      }
    }

    this.writeLock({
      archiveRoot: this.options.archiveRoot,
      slotId,
      acquiredAt: this.options.now().toISOString(),
    });
    try {
      const state = this.readState();
      if (state.manifest.outcome !== "COLLECTING") {
        if (mode === "FINALIZE_MISSED_SLOTS") {
          this.removeOwnedLock();
          return { state, staleLockFinalized: false };
        }
        throw conflict("The archive root is already finalized.");
      }
      if (mode === "COLLECT_SLOT" && state.manifest.slots.some((slot) => slot.slotId === slotId)) {
        throw conflict("The requested collection slot is already recorded.");
      }
      return { state, staleLockFinalized: false };
    } catch (error: unknown) {
      this.removeOwnedLock();
      throw error;
    }
  }

  checkpoint(state: ArchiveState): void {
    assertSafeArchiveValue(state);
    if (state.manifest.outcome !== "COLLECTING") {
      throw qualityStop("Only an active archive may receive an active checkpoint.");
    }
    this.writeActiveState(state);
  }

  commit(state: ArchiveState): void {
    assertSafeArchiveValue(state);
    if (state.manifest.outcome === "COLLECTING") {
      this.writeActiveState(state);
      this.removeOwnedLock();
      return;
    }
    this.writeFinalState(state);
    this.removeOwnedLock();
  }

  releaseOwnedLock(): void {
    this.removeOwnedLock();
  }

  abortWithInterruption(state: ArchiveState, reason: string): ArchiveState {
    const interrupted: ArchiveState = {
      ...state,
      manifest: {
        ...state.manifest,
        outcome: "COHORT_INCOMPLETE",
        interruptionReason: reason,
      },
    };
    this.commit(interrupted);
    return interrupted;
  }

  private finalizeStaleLockIfPresent(
    mode: "COLLECT_SLOT" | "FINALIZE_MISSED_SLOTS",
    slotId: string,
  ): ArchiveState | undefined {
    let parsed: { readonly lock: LockRecord; readonly raw: string };
    try {
      const raw = readFileSync(this.path(lockName), "utf8");
      parsed = { lock: JSON.parse(raw) as LockRecord, raw };
    } catch {
      throw qualityStop("The archive lock is unreadable.");
    }
    const { lock } = parsed;
    const acquiredAt = Date.parse(lock.acquiredAt);
    if (
      lock.archiveRoot !== this.options.archiveRoot ||
      !Number.isFinite(acquiredAt) ||
      this.options.now().getTime() - acquiredAt <= EXPLORATORY_COHORT_LOCK_STALE_MS
    ) {
      return undefined;
    }
    const state = this.readStateOrEmptyStaleRoot();
    if (state.manifest.outcome !== "COLLECTING") {
      throw conflict("A finalized archive retains an invalid active lock.");
    }
    if (mode === "FINALIZE_MISSED_SLOTS") {
      this.removeSpecificStaleLock(parsed.raw);
      this.writeLock({
        archiveRoot: this.options.archiveRoot,
        slotId,
        acquiredAt: this.options.now().toISOString(),
      });
      return state;
    }
    const interrupted: ArchiveState = {
      ...state,
      manifest: {
        ...state.manifest,
        outcome: "COHORT_INCOMPLETE",
        interruptionReason: "STALE_LOCK_AFTER_INTERRUPTED_PROCESS",
      },
    };
    this.writeFinalState(interrupted);
    this.removeSpecificStaleLock(parsed.raw);
    return this.readState();
  }

  private readStateOrEmptyStaleRoot(): ArchiveState {
    const activeArtifactNames = [manifestName, unitsName, sourcesName];
    if (activeArtifactNames.every((name) => !existsSync(this.path(name)))) {
      return initialState(this.options.archiveRoot, this.options.launch);
    }
    return this.readState();
  }

  private readState(): ArchiveState {
    try {
      const manifest = JSON.parse(readFileSync(this.path(manifestName), "utf8")) as CohortManifest;
      const unitsRaw = readFileSync(this.path(unitsName), "utf8");
      const unitsText = unitsRaw.trim();
      const units =
        unitsText.length === 0 ? [] : unitsText.split("\n").map((line) => JSON.parse(line));
      const sourcesRaw = readFileSync(this.path(sourcesName), "utf8");
      const sources = JSON.parse(sourcesRaw) as ArchiveState["sources"];
      const summaryRaw = existsSync(this.path(summaryName))
        ? readFileSync(this.path(summaryName), "utf8")
        : undefined;
      const state = { manifest, units, sources };
      assertSafeArchiveValue(state);
      assertArchiveIdentity(state, this.options.archiveRoot, this.options.launch);
      assertStoredFileHashes(state, {
        [manifestName]: activeManifestPreimageHash(manifest),
        [unitsName]: sha256(unitsRaw),
        [sourcesName]: sha256(sourcesRaw),
        ...(summaryRaw === undefined ? {} : { [summaryName]: sha256(summaryRaw) }),
      });
      return { manifest, units, sources };
    } catch (error: unknown) {
      if (error instanceof ExploratoryCohortError) throw error;
      throw qualityStop("The active archive artifacts are unavailable or invalid.");
    }
  }

  private writeActiveState(state: ArchiveState): void {
    const units = canonicalUnits(state.units);
    const sources = stableJson([...state.sources].sort(compareSource));
    const manifestPreimage = withoutActiveFileHashes(state.manifest);
    const activeManifest: CohortManifest = {
      ...manifestPreimage,
      activeFileHashes: {
        [manifestName]: sha256(stableJson(manifestPreimage)),
        [unitsName]: sha256(units),
        [sourcesName]: sha256(sources),
      },
    };
    writeAtomically(this.path(unitsName), units);
    writeAtomically(this.path(sourcesName), sources);
    writeAtomically(this.path(manifestName), stableJson(activeManifest));
  }

  private writeFinalState(state: ArchiveState): void {
    const units = canonicalUnits(state.units);
    const sources = stableJson([...state.sources].sort(compareSource));
    const summary = stableJson(makeSummary(state));
    writeAtomically(this.path(unitsName), units);
    writeAtomically(this.path(sourcesName), sources);
    writeAtomically(this.path(summaryName), summary);
    const manifestWithoutActiveHashes = withoutActiveFileHashes(state.manifest);
    const finalManifest: CohortManifest = {
      ...manifestWithoutActiveHashes,
      finalFileHashes: {
        [unitsName]: sha256(units),
        [sourcesName]: sha256(sources),
        [summaryName]: sha256(summary),
      },
    };
    writeAtomically(this.path(manifestName), stableJson(finalManifest));
  }

  private writeLock(lock: LockRecord): void {
    try {
      writeFileSync(this.path(lockName), stableJson({ ...lock, ownerId: this.lockOwnerId }), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch {
      throw conflict("Unable to exclusively acquire the archive root lock.");
    }
  }

  private removeOwnedLock(): void {
    const lockPath = this.path(lockName);
    if (!existsSync(lockPath)) return;
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
      if (lock.ownerId === this.lockOwnerId) rmSync(lockPath, { force: true });
    } catch {
      // Never remove an unreadable lock: this process cannot prove ownership.
    }
  }

  private removeSpecificStaleLock(expectedRaw: string): void {
    const lockPath = this.path(lockName);
    if (!existsSync(lockPath) || readFileSync(lockPath, "utf8") !== expectedRaw) {
      throw conflict("Archive lock ownership changed while stale recovery was in progress.");
    }
    rmSync(lockPath, { force: true });
  }

  private path(name: string): string {
    return path.join(this.options.root, name);
  }
}

function assertArchiveIdentity(
  state: ArchiveState,
  archiveRoot: string,
  launch: ExploratoryCohortLaunchRecord,
): void {
  const manifest = state.manifest;
  const { slots } = manifest;
  if (
    manifest.contractVersion !== "1" ||
    manifest.archiveRoot !== archiveRoot ||
    stableJson(manifest.launch) !== stableJson(launch) ||
    manifest.executionDisabled !== true ||
    !isLockedSafetyState(manifest.safety) ||
    !Array.isArray(slots) ||
    !Array.isArray(state.units) ||
    !Array.isArray(state.sources) ||
    ![
      "COLLECTING",
      "COHORT_COMPLETE",
      "COHORT_INCOMPLETE",
      "COHORT_STOPPED_DATA_QUALITY",
      "HUMAN_REVIEW_REQUIRED",
    ].includes(manifest.outcome)
  ) {
    throw qualityStop("The archive identity or structural contract is inconsistent.");
  }
  const providerCounts = manifest.providerCounts;
  for (const category of Object.keys(EXPLORATORY_COHORT_PROVIDER_CAPS)) {
    const value = providerCounts[category as keyof typeof providerCounts];
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value >
        EXPLORATORY_COHORT_PROVIDER_CAPS[category as keyof typeof EXPLORATORY_COHORT_PROVIDER_CAPS]
    ) {
      throw qualityStop("The archive provider counters are structurally inconsistent.");
    }
  }
  const slotIndexes = new Set<number>();
  const slotIds = new Set<string>();
  for (const slot of slots) {
    if (
      !Number.isInteger(slot.slotIndex) ||
      typeof slot.slotId !== "string" ||
      typeof slot.anchorAt !== "string" ||
      !Number.isInteger(slot.discoveryCounts?.returned) ||
      !Number.isInteger(slot.discoveryCounts?.canonical) ||
      !Number.isInteger(slot.discoveryCounts?.technicallyValid) ||
      slot.discoveryCounts.returned < 0 ||
      slot.discoveryCounts.canonical < 0 ||
      slot.discoveryCounts.technicallyValid < 0 ||
      slotIndexes.has(slot.slotIndex) ||
      slotIds.has(slot.slotId)
    ) {
      throw qualityStop("The archive slot ledger is structurally inconsistent.");
    }
    slotIndexes.add(slot.slotIndex);
    slotIds.add(slot.slotId);
  }
  const sourceCounts = Object.fromEntries(
    Object.keys(EXPLORATORY_COHORT_PROVIDER_CAPS).map((category) => [category, 0]),
  ) as Record<keyof typeof EXPLORATORY_COHORT_PROVIDER_CAPS, number>;
  for (const source of state.sources) {
    const category = source.category as keyof typeof EXPLORATORY_COHORT_PROVIDER_CAPS;
    if (
      !Object.hasOwn(sourceCounts, category) ||
      source.requestCount !== 1 ||
      source.attemptCount !== 1 ||
      (source.provider !== "DEXSCREENER" && source.provider !== "JUPITER") ||
      !/^[a-f0-9]{64}$/.test(source.sourceHash)
    ) {
      throw qualityStop("The archive source inventory is structurally inconsistent.");
    }
    const sanitized = {
      attemptCount: source.attemptCount,
      capability: source.capability,
      category: source.category,
      latencyBucket: source.latencyBucket,
      observedAt: source.observedAt,
      outcomeCode: source.outcomeCode,
      provider: source.provider,
      requestCount: source.requestCount,
    };
    if (
      createHash("sha256").update(JSON.stringify(sanitized)).digest("hex") !== source.sourceHash
    ) {
      throw qualityStop("The archive source inventory hash is inconsistent.");
    }
    sourceCounts[category] += 1;
  }
  for (const category of Object.keys(sourceCounts) as Array<keyof typeof sourceCounts>) {
    if (sourceCounts[category] !== manifest.providerCounts[category]) {
      throw qualityStop("The archive provider counts do not match its source inventory.");
    }
  }
}

function isLockedSafetyState(value: CohortManifest["safety"]): boolean {
  return (
    value?.databaseReads === 0 &&
    value.databaseWrites === 0 &&
    value.sessions === 0 &&
    value.orders === 0 &&
    value.fills === 0 &&
    value.positions === 0 &&
    value.walletLoaded === false &&
    value.transactionSigning === false &&
    value.transactionSubmission === false
  );
}

function assertStoredFileHashes(
  state: ArchiveState,
  actualHashes: Readonly<Record<string, string>>,
): void {
  const expected =
    state.manifest.outcome === "COLLECTING"
      ? state.manifest.activeFileHashes
      : state.manifest.finalFileHashes;
  const requiredNames =
    state.manifest.outcome === "COLLECTING"
      ? [manifestName, unitsName, sourcesName]
      : [unitsName, sourcesName, summaryName];
  if (!expected || requiredNames.some((name) => typeof expected[name] !== "string")) {
    throw qualityStop("The archive file-hash contract is unavailable.");
  }
  for (const name of requiredNames) {
    const actual = actualHashes[name];
    if (actual === undefined)
      throw qualityStop("The archive file is unavailable for hash validation.");
    if (actual !== expected[name]) {
      throw qualityStop("The archive file-hash contract is inconsistent.");
    }
  }
}

function activeManifestPreimageHash(manifest: CohortManifest): string {
  return sha256(stableJson(withoutActiveFileHashes(manifest)));
}

function withoutActiveFileHashes(
  manifest: CohortManifest,
): Omit<CohortManifest, "activeFileHashes"> {
  return Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== "activeFileHashes"),
  ) as Omit<CohortManifest, "activeFileHashes">;
}

function initialState(archiveRoot: string, launch: ExploratoryCohortLaunchRecord): ArchiveState {
  return {
    manifest: {
      contractVersion: "1",
      archiveRoot,
      launch,
      executionDisabled: true,
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
      outcome: "COLLECTING",
      slots: [],
      providerCounts: {
        ...EXPLORATORY_COHORT_PROVIDER_CAPS,
        DISCOVERY: 0,
        MARKET_CONTEXT: 0,
        QUOTE_IMPACT: 0,
        LATER_OBSERVATION: 0,
      },
    },
    units: [],
    sources: [],
  };
}

function makeSummary(state: ArchiveState): Record<string, unknown> {
  const partitionCounts = countBy(state.units.map((unit) => unit.partition));
  const utcDateCounts = countBy(state.units.map((unit) => unit.anchorAt.slice(0, 10)));
  const laterAvailabilityCounts = countBy(
    state.units.flatMap((unit) =>
      unit.laterObservations.map((observation) => observation.availability),
    ),
  );
  const maximumUtcDateCount = Math.max(
    0,
    ...Object.values(utcDateCounts).filter((value): value is number => value !== undefined),
  );
  const maximumUtcDateSharePct =
    state.units.length === 0
      ? 0
      : Number(((maximumUtcDateCount / state.units.length) * 100).toFixed(6));

  return {
    contractVersion: "1",
    outcome: state.manifest.outcome,
    validUnitCount: state.units.length,
    attemptedSlotCount: state.manifest.slots.length,
    partitionCounts,
    utcDateCounts,
    concentration: {
      distinctMintCount: new Set(state.units.map((unit) => unit.canonicalMint)).size,
      maximumUtcDateSharePct,
    },
    laterObservations: {
      totalCount: state.units.reduce((total, unit) => total + unit.laterObservations.length, 0),
      availabilityCounts: laterAvailabilityCounts,
      missingOrInvalidCount:
        (laterAvailabilityCounts.MISSING ?? 0) + (laterAvailabilityCounts.INVALID ?? 0),
    },
    providerCounts: state.manifest.providerCounts,
    providerBudgetUse: Object.fromEntries(
      Object.entries(EXPLORATORY_COHORT_PROVIDER_CAPS).map(([category, cap]) => [
        category,
        {
          used: state.manifest.providerCounts[
            category as keyof typeof state.manifest.providerCounts
          ],
          cap,
        },
      ]),
    ),
    interruptionReason: state.manifest.interruptionReason,
    executionDisabled: true,
    safetyCounters: state.manifest.safety,
    nonAuthorizingOutcome:
      "This observational archive does not authorize strategy changes, further collection, analysis, validation, PAPER execution, or any execution action.",
    nextPermittedAction:
      "Preserve this observational archive unchanged. No strategy, Phase 10.6B analysis, PAPER execution, or execution action is authorized.",
  };
}

function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  return values.reduce<Partial<Record<T, number>>>(
    (counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }),
    {},
  );
}

function canonicalUnits(units: readonly ArchiveState["units"][number][]): string {
  const sorted = [...units].sort((left, right) => left.unitId.localeCompare(right.unitId));
  return (
    sorted.map((unit) => JSON.stringify(sortValue(unit))).join("\n") +
    (sorted.length > 0 ? "\n" : "")
  );
}

function writeAtomically(target: string, contents: string): void {
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, target);
}

function assertSafeArchiveValue(value: unknown): void {
  if (typeof value === "string") {
    if (
      /https?:\/\/|authorization|bearer\s+|api[ _-]?key|private[ _-]?key|password|secret|raw.*payload/i.test(
        value,
      )
    ) {
      throw qualityStop("Archive content contains forbidden unsafe text.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertSafeArchiveValue);
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(assertSafeArchiveValue);
  }
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function compareSource(
  left: ArchiveState["sources"][number],
  right: ArchiveState["sources"][number],
): number {
  return `${left.category}|${left.observedAt}|${left.capability}`.localeCompare(
    `${right.category}|${right.observedAt}|${right.capability}`,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function conflict(message: string): ExploratoryCohortError {
  return new ExploratoryCohortError("EXPLORATORY_COHORT_ARCHIVE_CONFLICT", message);
}

function qualityStop(message: string): ExploratoryCohortError {
  return new ExploratoryCohortError("EXPLORATORY_COHORT_DATA_QUALITY_STOP", message);
}

function precondition(message: string): ExploratoryCohortError {
  return new ExploratoryCohortError("EXPLORATORY_COHORT_PRECONDITION_UNMET", message);
}
