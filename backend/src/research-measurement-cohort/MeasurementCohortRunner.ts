import { createHash } from "node:crypto";

import type { MeasurementCohortArchiveService } from "./MeasurementCohortArchiveService.js";
import { MEASUREMENT_COHORT_TIMING } from "./MeasurementCohortConstants.js";
import { MeasurementCohortError } from "./MeasurementCohortErrors.js";
import {
  canonicalCandidates,
  partitionFor,
  selectCandidate,
  selectionHash,
} from "./MeasurementCohortSelection.js";
import type {
  MeasurementArchiveState,
  MeasurementAvailability,
  MeasurementCohortClock,
  MeasurementCohortGateway,
  MeasurementCohortLaunchRecord,
  MeasurementCohortUnit,
  MeasurementFact,
  MeasurementGatewayResult,
  MeasurementMarketContext,
  MeasurementSnapshot,
  MeasurementSourceRecord,
} from "./MeasurementCohortTypes.js";
import type { MeasurementCollectionResult } from "./MeasurementCohortTypes.js";

export class MeasurementCohortRunner {
  constructor(
    private readonly options: {
      readonly launch: MeasurementCohortLaunchRecord;
      readonly archive: MeasurementCohortArchiveService;
      readonly gateway: MeasurementCohortGateway;
      readonly clock: MeasurementCohortClock;
    },
  ) {}

  async runOnce(): Promise<MeasurementCollectionResult> {
    const slot = currentSlot(this.options.launch, this.options.clock.now());
    let state = this.options.archive.open(slot.anchorAt);
    if (this.options.archive.recoveredStaleLock) {
      state = this.options.archive.finalize(state, "MEASUREMENT_COHORT_DATA_INSUFFICIENT");
      return resultFor(state, 0, undefined);
    }
    if (state.manifest.outcome !== "COLLECTING") {
      this.options.archive.release();
      return resultFor(state, 0, undefined);
    }
    if (state.manifest.slots.some((record) => record.slotId === slot.slotId)) {
      this.options.archive.release();
      throw new MeasurementCohortError(
        "MEASUREMENT_COHORT_ARCHIVE_CONFLICT",
        "The current canonical V3 slot is already recorded.",
      );
    }

    const callsBefore = totalCalls(state);
    try {
      state = await this.collectSlot(state, slot);
      if (
        state.manifest.outcome === "COLLECTING" &&
        (state.units.length >= MEASUREMENT_COHORT_TIMING.plannedUnits ||
          slot.index === MEASUREMENT_COHORT_TIMING.maximumAttemptedSlots - 1)
      ) {
        state = this.options.archive.finalize(
          state,
          measurementCompletionGatesPass(state)
            ? "COHORT_COMPLETE"
            : "MEASUREMENT_COHORT_DATA_INSUFFICIENT",
        );
      }
      this.options.archive.release();
      return resultFor(state, totalCalls(state) - callsBefore, slot.slotId);
    } catch (error) {
      if (
        error instanceof MeasurementCohortError &&
        error.code === "MEASUREMENT_COHORT_DATA_QUALITY_STOP"
      ) {
        const stopped = this.options.archive.finalize(
          state,
          "MEASUREMENT_COHORT_DATA_QUALITY_STOP",
        );
        return resultFor(stopped, totalCalls(stopped) - callsBefore, slot.slotId);
      }
      this.options.archive.release();
      throw error;
    }
  }

  private async collectSlot(
    state: MeasurementArchiveState,
    slot: CanonicalSlot,
  ): Promise<MeasurementArchiveState> {
    assertBudget(state, "DISCOVERY");
    const discovery = await this.options.gateway.discover(100);
    const discoverySource = sourceRecord("DISCOVERY", "DISCOVER_TOKENS", discovery);
    const candidates = discovery.ok && discovery.value ? canonicalCandidates(discovery.value) : [];
    const selected = discovery.ok ? selectCandidate(candidates, slot.slotId) : undefined;
    const baseCounts = {
      returned: discovery.ok && discovery.value ? discovery.value.length : 0,
      canonical: candidates.length,
      technicallyValid: candidates.length,
    };
    if (!selected) {
      return this.options.archive.checkpoint(state, {
        slot: {
          slotId: slot.slotId,
          slotIndex: slot.index,
          anchorAt: slot.anchorAt.toISOString(),
          state: "NO_SELECTION",
          reason: discovery.ok
            ? "NO_TECHNICALLY_VALID_CANONICAL_MINT"
            : `DISCOVERY_${safeCode(discovery.outcomeCode)}`,
          discoveryCounts: baseCounts,
        },
        sources: [discoverySource],
      });
    }
    if (state.units.some((unit) => unit.canonicalMint === selected.mint)) {
      return this.options.archive.checkpoint(state, {
        slot: {
          slotId: slot.slotId,
          slotIndex: slot.index,
          anchorAt: slot.anchorAt.toISOString(),
          state: "SKIP_UNIT_WITH_REASON",
          reason: "DUPLICATE_MINT",
          discoveryCounts: baseCounts,
          selectedMint: selected.mint,
        },
        sources: [discoverySource],
      });
    }
    const snapshots: MeasurementSnapshot[] = [];
    const sources: MeasurementSourceRecord[] = [discoverySource];
    for (const offsetMinutes of MEASUREMENT_COHORT_TIMING.snapshotOffsetsMinutes) {
      const scheduledAt = new Date(slot.anchorAt.valueOf() + offsetMinutes * 60 * 1000);
      const snapshot = await this.collectSnapshot(state, selected.mint, scheduledAt, offsetMinutes);
      snapshots.push(snapshot.snapshot);
      if (snapshot.source) sources.push(snapshot.source);
    }
    const unit = buildUnit(
      selected.mint,
      selected.sourceKind,
      selected.firstObservedAt,
      slot,
      snapshots,
    );
    return this.options.archive.checkpoint(state, {
      slot: {
        slotId: slot.slotId,
        slotIndex: slot.index,
        anchorAt: slot.anchorAt.toISOString(),
        state: "VALID_UNIT",
        reason: "VALID_TECHNICAL_UNIT",
        discoveryCounts: baseCounts,
        selectedMint: selected.mint,
      },
      unit,
      sources,
    });
  }

  private async collectSnapshot(
    state: MeasurementArchiveState,
    mint: string,
    scheduledAt: Date,
    offsetMinutes: -15 | -10 | -5 | 0,
  ): Promise<{
    readonly snapshot: MeasurementCohortUnit["decisionTime"]["snapshots"][number];
    readonly source?: MeasurementSourceRecord;
  }> {
    await this.options.clock.sleepUntil(scheduledAt);
    if (
      this.options.clock.now().valueOf() >
      scheduledAt.valueOf() + MEASUREMENT_COHORT_TIMING.sourceFreshnessMs
    ) {
      return {
        snapshot: unavailableSnapshot(offsetMinutes, scheduledAt, "NOT_REQUESTED"),
      };
    }
    assertBudget(state, "MARKET_CONTEXT");
    const market = await this.options.gateway.marketContext(mint);
    const source = sourceRecord("MARKET_CONTEXT", "BEST_PAIR", market);
    return { snapshot: mapSnapshot(offsetMinutes, scheduledAt, market), source };
  }
}

interface CanonicalSlot {
  readonly index: number;
  readonly slotId: string;
  readonly anchorAt: Date;
}

function currentSlot(launch: MeasurementCohortLaunchRecord, now: Date): CanonicalSlot {
  const startAnchor = new Date(launch.cohortStartAt);
  const firstInvocation = startAnchor.valueOf() - MEASUREMENT_COHORT_TIMING.invocationLeadMs;
  const elapsed = now.valueOf() - firstInvocation;
  const index = Math.floor(elapsed / MEASUREMENT_COHORT_TIMING.slotDurationMs);
  const anchorAt = new Date(
    startAnchor.valueOf() + index * MEASUREMENT_COHORT_TIMING.slotDurationMs,
  );
  const invocationAt = anchorAt.valueOf() - MEASUREMENT_COHORT_TIMING.invocationLeadMs;
  if (
    Number.isNaN(startAnchor.valueOf()) ||
    index < 0 ||
    index >= MEASUREMENT_COHORT_TIMING.maximumAttemptedSlots ||
    now.valueOf() < invocationAt ||
    now.valueOf() > invocationAt + MEASUREMENT_COHORT_TIMING.sourceFreshnessMs
  ) {
    throw new MeasurementCohortError(
      "MEASUREMENT_COHORT_DATA_QUALITY_STOP",
      "The V3 invocation is outside the fixed anchor-minus-16-minute clock window.",
    );
  }
  return { index, slotId: `SLOT_${String(index + 1).padStart(3, "0")}`, anchorAt };
}

function mapSnapshot(
  offsetMinutes: -15 | -10 | -5 | 0,
  scheduledAt: Date,
  result: MeasurementGatewayResult<MeasurementMarketContext>,
): MeasurementCohortUnit["decisionTime"]["snapshots"][number] {
  if (!result.ok)
    return unavailableSnapshot(offsetMinutes, scheduledAt, "PROVIDER_ERROR", result.observedAt);
  if (
    Math.abs(result.observedAt.valueOf() - scheduledAt.valueOf()) >
    MEASUREMENT_COHORT_TIMING.sourceFreshnessMs
  ) {
    return unavailableSnapshot(offsetMinutes, scheduledAt, "STALE_AT_ANCHOR", result.observedAt);
  }
  const price = result.value?.priceUsd;
  const liquidity = result.value?.liquidityUsd;
  return {
    offsetMinutes,
    scheduledAt: scheduledAt.toISOString(),
    priceUsd:
      price === undefined
        ? unavailable("UNAVAILABLE_AT_ANCHOR", result.observedAt)
        : finitePositive(price)
          ? available(price, result.observedAt)
          : unavailable("INVALID_VALUE", result.observedAt),
    ...(offsetMinutes === 0
      ? {
          liquidityUsd:
            liquidity === undefined
              ? unavailable("UNAVAILABLE_AT_ANCHOR", result.observedAt)
              : finiteNonNegative(liquidity)
                ? available(liquidity, result.observedAt)
                : unavailable("INVALID_VALUE", result.observedAt),
        }
      : {}),
  };
}

function unavailableSnapshot(
  offsetMinutes: -15 | -10 | -5 | 0,
  scheduledAt: Date,
  availability: MeasurementAvailability,
  observedAt?: Date,
): MeasurementCohortUnit["decisionTime"]["snapshots"][number] {
  return {
    offsetMinutes,
    scheduledAt: scheduledAt.toISOString(),
    priceUsd: unavailable(availability, observedAt),
    ...(offsetMinutes === 0 ? { liquidityUsd: unavailable(availability, observedAt) } : {}),
  };
}

function buildUnit(
  mint: string,
  sourceKind: string,
  firstObservedAt: Date,
  slot: CanonicalSlot,
  snapshots: readonly MeasurementCohortUnit["decisionTime"]["snapshots"][number][],
): MeasurementCohortUnit {
  const byOffset = new Map(snapshots.map((snapshot) => [snapshot.offsetMinutes, snapshot]));
  const anchor = byOffset.get(0);
  const negative5 = byOffset.get(-5);
  const negative15 = byOffset.get(-15);
  if (!anchor || !negative5 || !negative15) {
    throw new MeasurementCohortError(
      "MEASUREMENT_COHORT_DATA_QUALITY_STOP",
      "The fixed V3 snapshot sequence is incomplete.",
    );
  }
  const liquidity = anchor.liquidityUsd ?? unavailable("NOT_REQUESTED");
  return {
    unitId: createHash("sha256").update(`${slot.slotId}|${mint}`).digest("hex").slice(0, 24),
    slotId: slot.slotId,
    anchorAt: slot.anchorAt.toISOString(),
    canonicalMint: mint,
    partition: partitionFor(mint, slot.slotId),
    selection: {
      sourceKind,
      firstObservedAt: firstObservedAt.toISOString(),
      selectionHash: selectionHash(mint, slot.slotId),
    },
    decisionTime: {
      snapshots,
      market: {
        liquidityUsd: liquidity,
        momentum5mPct: momentum(anchor.priceUsd, negative5.priceUsd),
        momentum15mPct: momentum(anchor.priceUsd, negative15.priceUsd),
      },
    },
  };
}

function momentum(
  anchor: MeasurementFact<number>,
  prior: MeasurementFact<number>,
): MeasurementFact<number> {
  if (anchor.availability !== "AVAILABLE_AT_ANCHOR")
    return unavailable(anchor.availability, timestamp(anchor));
  if (prior.availability !== "AVAILABLE_AT_ANCHOR")
    return unavailable(prior.availability, timestamp(prior));
  if (!finitePositive(anchor.value) || !finitePositive(prior.value))
    return unavailable("INVALID_VALUE");
  const value = (anchor.value / prior.value - 1) * 100;
  return Number.isFinite(value)
    ? {
        availability: "AVAILABLE_AT_ANCHOR",
        sourceCategory: "LOCAL",
        sourceIdentifier: "FORMULA",
        value,
      }
    : unavailable("INVALID_VALUE");
}

function available(value: number, observedAt: Date): MeasurementFact<number> {
  return {
    availability: "AVAILABLE_AT_ANCHOR",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    sourceTimestamp: observedAt.toISOString(),
    value,
  };
}

function unavailable(
  availability: MeasurementAvailability,
  observedAt?: Date,
): MeasurementFact<number> {
  return {
    availability,
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    ...(observedAt ? { sourceTimestamp: observedAt.toISOString() } : {}),
  };
}

function timestamp(fact: MeasurementFact<number>): Date | undefined {
  return fact.sourceTimestamp ? new Date(fact.sourceTimestamp) : undefined;
}

function sourceRecord(
  category: "DISCOVERY" | "MARKET_CONTEXT",
  capability: "DISCOVER_TOKENS" | "BEST_PAIR",
  result: MeasurementGatewayResult<unknown>,
): MeasurementSourceRecord {
  const sanitized = {
    category,
    capability,
    outcomeCode: safeCode(result.outcomeCode),
    observedAt: result.observedAt.toISOString(),
    latencyBucket: latencyBucket(result.latencyMs),
  };
  return {
    category,
    provider: "DEXSCREENER",
    capability,
    requestCount: 1,
    attemptCount: 1,
    outcomeCode: sanitized.outcomeCode,
    observedAt: sanitized.observedAt,
    latencyBucket: sanitized.latencyBucket,
    sourceHash: createHash("sha256").update(JSON.stringify(sanitized)).digest("hex"),
  };
}

function assertBudget(
  state: MeasurementArchiveState,
  category: "DISCOVERY" | "MARKET_CONTEXT",
): void {
  const cap =
    category === "DISCOVERY"
      ? MEASUREMENT_COHORT_TIMING.discoveryCap
      : MEASUREMENT_COHORT_TIMING.marketContextCap;
  if (state.manifest.providerCounts[category] >= cap) {
    throw new MeasurementCohortError(
      "MEASUREMENT_COHORT_DATA_QUALITY_STOP",
      `The fixed V3 ${category} request cap is exhausted.`,
    );
  }
}

export function measurementCompletionGatesPass(state: MeasurementArchiveState): boolean {
  if (state.units.length !== MEASUREMENT_COHORT_TIMING.plannedUnits) return false;
  const distinctMints = new Set(state.units.map((unit) => unit.canonicalMint));
  if (
    distinctMints.size < MEASUREMENT_COHORT_TIMING.minimumDistinctMints ||
    distinctMints.size !== state.units.length
  )
    return false;
  const partitionUnits = (partition: "DISCOVERY" | "VALIDATION") =>
    state.units.filter((unit) => unit.partition === partition);
  const dates = new Set(state.units.map((unit) => unit.anchorAt.slice(0, 10)));
  if (dates.size < MEASUREMENT_COHORT_TIMING.minimumDates) return false;
  if (
    [...dates].some(
      (date) =>
        (state.units.filter((unit) => unit.anchorAt.startsWith(date)).length / state.units.length) *
          100 >
        MEASUREMENT_COHORT_TIMING.maximumDateSharePct,
    )
  )
    return false;
  return (["DISCOVERY", "VALIDATION"] as const).every((partition) => {
    const units = partitionUnits(partition);
    if (
      units.length < MEASUREMENT_COHORT_TIMING.minimumPartitionUnits ||
      new Set(units.map((unit) => unit.anchorAt.slice(0, 10))).size <
        MEASUREMENT_COHORT_TIMING.minimumPartitionDates
    )
      return false;
    return (["liquidityUsd", "momentum5mPct", "momentum15mPct"] as const).every((field) => {
      const available = units.filter(
        (unit) => unit.decisionTime.market[field].availability === "AVAILABLE_AT_ANCHOR",
      );
      return (
        (available.length / units.length) * 100 >=
          MEASUREMENT_COHORT_TIMING.minimumAvailabilityPct &&
        new Set(available.map((unit) => unit.anchorAt.slice(0, 10))).size >=
          MEASUREMENT_COHORT_TIMING.minimumPartitionDates
      );
    });
  });
}

function resultFor(
  state: MeasurementArchiveState,
  invocationProviderCalls: number,
  slotId: string | undefined,
): MeasurementCollectionResult {
  return {
    outcome: state.manifest.outcome,
    archiveRoot: state.manifest.archiveRoot,
    ...(slotId ? { slotId } : {}),
    validUnitCount: state.units.length,
    providerCalls: totalCalls(state),
    invocationProviderCalls,
    databaseReads: 0,
    databaseWrites: 0,
    runtimeCalls: 0,
    nextPermittedAction:
      "Do not schedule, extend, analyze, change strategy, enable PAPER, or use execution without separate explicit approval.",
  };
}

function totalCalls(state: MeasurementArchiveState): number {
  return state.manifest.providerCounts.DISCOVERY + state.manifest.providerCounts.MARKET_CONTEXT;
}

function finitePositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function latencyBucket(latencyMs: number): "LT_100MS" | "LT_1S" | "GE_1S" {
  return latencyMs < 100 ? "LT_100MS" : latencyMs < 1_000 ? "LT_1S" : "GE_1S";
}

function safeCode(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80) || "UNKNOWN";
}
