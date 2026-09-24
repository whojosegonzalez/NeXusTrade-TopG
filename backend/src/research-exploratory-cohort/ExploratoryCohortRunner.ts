import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  EXPLORATORY_COHORT_COMPLETION_VALID_UNITS,
  EXPLORATORY_COHORT_LATER_HORIZONS,
  EXPLORATORY_COHORT_MAX_SLOTS,
  EXPLORATORY_COHORT_PROVIDER_CAPS,
} from "./ExploratoryCohortConstants.js";
import {
  resolveExploratoryCohortArchiveRoot,
  resolveExploratoryCohortProtocol,
} from "./ExploratoryCohortConfig.js";
import { ExploratoryCohortArchiveService } from "./ExploratoryCohortArchiveService.js";
import { ExploratoryCohortError } from "./ExploratoryCohortErrors.js";
import {
  assertExploratoryCohortProtocolBytes,
  loadExploratoryCohortLaunchRecord,
} from "./ExploratoryCohortLaunch.js";
import {
  assertExploratoryCohortStartWindow,
  canonicalExploratoryCohortSlot,
  deriveCurrentExploratoryCohortSlot,
  exploratoryCohortFinalizerEarliestAt,
  type ExploratoryCohortScheduleSlot,
} from "./ExploratoryCohortSchedule.js";
import { parseExploratoryCohortProtocol } from "../research-protocol/ResearchProtocolService.js";
import { selectExploratoryCohortUnit } from "./ExploratoryCohortSelection.js";
import type {
  ArchiveState,
  CohortUnit,
  CollectionResult,
  ExploratoryCohortClock,
  ExploratoryCohortConfig,
  ExploratoryCohortGateway,
  ExploratoryCohortInvocationMode,
  GatewayResult,
  LaterObservation,
  ProviderCategory,
  SafeFact,
  SlotRecord,
  SourceInventoryRecord,
} from "./ExploratoryCohortTypes.js";

const nextPermittedAction =
  "Preserve the archive unchanged and request a separate Phase 10.6B archive-only checklist. No strategy, PAPER execution, order, wallet, signing, or submission action is authorized." as const;

export class ExploratoryCohortRunner {
  private readonly lastRequestByProvider = new Map<"DEXSCREENER" | "JUPITER", number>();

  constructor(
    private readonly options: {
      readonly config: ExploratoryCohortConfig;
      readonly gateway?: ExploratoryCohortGateway;
      readonly clock: ExploratoryCohortClock;
      readonly loadLaunch?: typeof loadExploratoryCohortLaunchRecord;
      readonly createArchive?: (
        input: ConstructorParameters<typeof ExploratoryCohortArchiveService>[0],
      ) => ExploratoryCohortArchiveService;
    },
  ) {}

  async run(): Promise<CollectionResult> {
    const protocolBytes = readFileSync(resolveExploratoryCohortProtocol(this.options.config));
    assertExploratoryCohortProtocolBytes(protocolBytes);
    assertPinnedProtocolSchema(protocolBytes);
    const launch = (this.options.loadLaunch ?? loadExploratoryCohortLaunchRecord)(
      this.options.config,
    );
    const root = resolveExploratoryCohortArchiveRoot(this.options.config);
    const archive = (
      this.options.createArchive ?? ((input) => new ExploratoryCohortArchiveService(input))
    )({
      root,
      archiveRoot: this.options.config.archiveRoot,
      launch,
      now: () => this.options.clock.now(),
    });
    if (this.options.config.mode === "FINALIZE_MISSED_SLOTS") {
      return this.finalizeMissedSlots(archive, launch.cohortStartAt);
    }

    const schedule = deriveCurrentExploratoryCohortSlot(
      launch.cohortStartAt,
      this.options.clock.now(),
    );
    assertExploratoryCohortStartWindow(schedule, this.options.clock.now());
    const opened = archive.open(schedule.slotId, "COLLECT_SLOT");
    if (opened.staleLockFinalized)
      return this.result(opened.state, providerCallCount(opened.state));
    let state = opened.state;
    const providerCallsAtOpen = providerCallCount(state);

    try {
      assertActiveLedgerForSchedule(state, launch.cohortStartAt, schedule.slotIndex);
      state = reconcileMissedSlots(state, launch.cohortStartAt, schedule.slotIndex);
      archive.checkpoint(state);

      const gateway = this.options.gateway;
      if (!gateway || !gateway.available) {
        state = finalizePrecondition(state, "DIRECT_DISCOVERY_CAPABILITY_UNAVAILABLE");
        archive.commit(state);
        return this.result(state, providerCallsAtOpen);
      }

      const discovery = await this.request(
        state,
        "DISCOVERY",
        "DEXSCREENER",
        "TOKEN_DISCOVERY",
        () => gateway.discover(100),
      );
      state = discovery.state;
      if (!discovery.result.ok || !discovery.result.value) {
        state = appendSlot(state, {
          slotId: schedule.slotId,
          slotIndex: schedule.slotIndex,
          anchorAt: schedule.anchorAt.toISOString(),
          state: "PAUSE_WINDOW",
          reason: `DISCOVERY_${discovery.result.outcomeCode}`,
          discoveryCounts: { returned: 0, canonical: 0, technicallyValid: 0 },
        });
        state = finalizeIfNeeded(state);
        archive.commit(state);
        return this.result(state, providerCallsAtOpen, schedule.slotId);
      }

      await this.options.clock.sleepUntil(schedule.anchorAt);
      const priorMints = new Set(state.units.map((unit) => unit.canonicalMint));
      const selection = selectExploratoryCohortUnit({
        candidates: discovery.result.value,
        slotIndex: schedule.slotIndex,
        slotId: schedule.slotId,
        anchorAt: schedule.anchorAt,
        priorMints,
      });
      if (!selection.candidate || !selection.partition) {
        state = appendSlot(state, selection.slotRecord);
        state = finalizeIfNeeded(state);
        archive.commit(state);
        return this.result(state, providerCallsAtOpen, schedule.slotId);
      }

      const market = await this.request(state, "MARKET_CONTEXT", "DEXSCREENER", "BEST_PAIR", () =>
        gateway.marketContext(selection.candidate?.mint as string),
      );
      state = market.state;
      const quote = gateway.quoteAvailable
        ? await this.request(state, "QUOTE_IMPACT", "JUPITER", "QUOTE_IMPACT", () =>
            gateway.quoteImpact(selection.candidate?.mint as string),
          )
        : { state, result: unavailableQuote(this.options.clock.now()) };
      state = quote.state;
      const marketValue = market.result.ok ? market.result.value : undefined;
      const anchorPriceUsd = marketValue?.priceUsd;
      if (
        !isPositiveFinite(anchorPriceUsd) ||
        Math.abs(market.result.observedAt.getTime() - schedule.anchorAt.getTime()) > 60_000
      ) {
        state = appendSlot(state, {
          ...selection.slotRecord,
          state: "SKIP_UNIT_WITH_REASON",
          reason: "MISSING_OR_STALE_REQUIRED_ANCHOR_PRICE",
        });
        state = finalizeIfNeeded(state);
        archive.commit(state);
        return this.result(state, providerCallsAtOpen, schedule.slotId);
      }

      const unit = await this.makeUnit({
        candidate: selection.candidate,
        partition: selection.partition,
        slotId: schedule.slotId,
        anchorAt: schedule.anchorAt,
        duplicateCount: selection.duplicateCount,
        anchorPriceUsd,
        market: market.result,
        quote: quote.result,
        state,
        gateway,
      });
      state = unit.state;
      state = {
        ...state,
        units: [...state.units, unit.unit],
      };
      state = appendSlot(state, {
        ...selection.slotRecord,
        state: "VALID_UNIT",
        reason: "VALID_REQUIRED_ANCHOR",
      });
      state = finalizeIfNeeded(state);
      archive.commit(state);
      return this.result(state, providerCallsAtOpen, schedule.slotId);
    } catch (error: unknown) {
      if (error instanceof ExploratoryCohortError) {
        if (error.code === "EXPLORATORY_COHORT_DATA_QUALITY_STOP") {
          archive.releaseOwnedLock();
          throw error;
        }
        const outcome = "COHORT_STOPPED_DATA_QUALITY" as const;
        state = {
          ...state,
          manifest: { ...state.manifest, outcome, interruptionReason: error.code },
        };
        archive.commit(state);
      }
      throw error;
    }
  }

  private finalizeMissedSlots(
    archive: ExploratoryCohortArchiveService,
    cohortStartAt: string,
  ): CollectionResult {
    if (
      this.options.clock.now().getTime() <
      exploratoryCohortFinalizerEarliestAt(cohortStartAt).getTime()
    ) {
      throw precondition(
        "Provider-free closeout is not permitted before the fixed post-window boundary.",
      );
    }
    const opened = archive.open("FINALIZE_MISSED_SLOTS", "FINALIZE_MISSED_SLOTS");
    if (opened.staleLockFinalized || opened.state.manifest.outcome !== "COLLECTING") {
      return this.result(opened.state, providerCallCount(opened.state));
    }
    let state = opened.state;
    try {
      assertActiveLedgerForSchedule(state, cohortStartAt, EXPLORATORY_COHORT_MAX_SLOTS);
      state = reconcileMissedSlots(state, cohortStartAt, EXPLORATORY_COHORT_MAX_SLOTS);
      state = {
        ...state,
        manifest: {
          ...state.manifest,
          outcome: "COHORT_INCOMPLETE",
          interruptionReason: "POST_WINDOW_MISSED_SLOT_CLOSEOUT",
        },
      };
      archive.commit(state);
      return this.result(state, providerCallCount(state));
    } catch (error: unknown) {
      archive.releaseOwnedLock();
      throw error;
    }
  }

  private result(
    state: ArchiveState,
    providerCallsAtOpen: number,
    slotId?: string,
  ): CollectionResult {
    return resultFor(
      state,
      this.options.config.archiveRoot,
      this.options.config.mode,
      Math.max(0, providerCallCount(state) - providerCallsAtOpen),
      slotId,
    );
  }

  private async makeUnit(input: {
    readonly candidate: NonNullable<ReturnType<typeof selectExploratoryCohortUnit>["candidate"]>;
    readonly partition: NonNullable<ReturnType<typeof selectExploratoryCohortUnit>["partition"]>;
    readonly slotId: string;
    readonly anchorAt: Date;
    readonly duplicateCount: number;
    readonly anchorPriceUsd: number;
    readonly market: GatewayResult<{
      readonly observedAt: Date;
      readonly priceUsd?: number;
      readonly liquidityUsd?: number;
      readonly volume5mUsd?: number;
      readonly volume1hUsd?: number;
      readonly assetCreatedAt?: Date;
    }>;
    readonly quote: GatewayResult<{ readonly observedAt: Date; readonly priceImpactBps?: number }>;
    readonly state: ArchiveState;
    readonly gateway: ExploratoryCohortGateway;
  }): Promise<{ readonly unit: CohortUnit; readonly state: ArchiveState }> {
    let state = input.state;
    const laterObservations: LaterObservation[] = [];
    for (const horizon of EXPLORATORY_COHORT_LATER_HORIZONS) {
      const due = new Date(input.anchorAt.getTime() + horizon.minutesAfterAnchor * 60_000);
      const latest = new Date(due.getTime() + horizon.toleranceSeconds * 1_000);
      if (this.options.clock.now().getTime() > latest.getTime()) {
        laterObservations.push({
          minutesAfterAnchor: horizon.minutesAfterAnchor,
          availability: "MISSING",
          reason: "WINDOW_EXPIRED_BEFORE_REQUEST",
        });
        continue;
      }
      await this.options.clock.sleepUntil(due);
      if (this.options.clock.now().getTime() > latest.getTime()) {
        laterObservations.push({
          minutesAfterAnchor: horizon.minutesAfterAnchor,
          availability: "MISSING",
          reason: "WINDOW_EXPIRED_BEFORE_REQUEST",
        });
        continue;
      }
      const observation = await this.request(
        state,
        "LATER_OBSERVATION",
        "DEXSCREENER",
        "BEST_PAIR_LATER_LABEL",
        () => input.gateway.laterPrice(input.candidate.mint),
      );
      state = observation.state;
      const observedPrice = observation.result.value?.priceUsd;
      if (!observation.result.ok) {
        laterObservations.push({
          minutesAfterAnchor: horizon.minutesAfterAnchor,
          availability: "MISSING",
          observedAt: observation.result.observedAt.toISOString(),
          reason: observation.result.outcomeCode,
        });
      } else if (!isPositiveFinite(observedPrice)) {
        laterObservations.push({
          minutesAfterAnchor: horizon.minutesAfterAnchor,
          availability: "INVALID",
          observedAt: observation.result.observedAt.toISOString(),
          reason: "NON_POSITIVE_OR_INVALID_PRICE",
        });
      } else {
        laterObservations.push({
          minutesAfterAnchor: horizon.minutesAfterAnchor,
          availability:
            observation.result.observedAt.getTime() <= latest.getTime()
              ? "OBSERVED_ON_TIME"
              : "OBSERVED_LATE",
          observedAt: observation.result.observedAt.toISOString(),
          returnPct: ((observedPrice - input.anchorPriceUsd) / input.anchorPriceUsd) * 100,
          reason: "NUMERIC_RETURN",
        });
      }
    }

    const marketValue = input.market.value;
    const quoteValue = input.quote.value;
    return {
      state,
      unit: {
        unitId: `${input.slotId}:${input.candidate.mint}`,
        canonicalMint: input.candidate.mint,
        anchorAt: input.anchorAt.toISOString(),
        slotId: input.slotId,
        partition: input.partition,
        decisionTime: {
          discovery: available(
            input.candidate.sourceKind,
            "DISCOVERY",
            "TOKEN_PROFILE",
            input.candidate.firstObservedAt,
          ),
          market: {
            assetAgeSeconds: marketValue?.assetCreatedAt
              ? available(
                  Math.max(
                    0,
                    Math.floor(
                      (input.anchorAt.getTime() - marketValue.assetCreatedAt.getTime()) / 1_000,
                    ),
                  ),
                  "MARKET_CONTEXT",
                  "BEST_PAIR",
                  input.market.observedAt,
                )
              : missing("UNSUPPORTED", "MARKET_CONTEXT", "BEST_PAIR", input.market.observedAt),
            priceUsd: available(
              input.anchorPriceUsd,
              "MARKET_CONTEXT",
              "BEST_PAIR",
              input.market.observedAt,
            ),
            liquidityUsd: optionalMarketFact(marketValue?.liquidityUsd, input.market),
            volume5mUsd: optionalMarketFact(marketValue?.volume5mUsd, input.market),
            volume1hUsd: optionalMarketFact(marketValue?.volume1hUsd, input.market),
            momentum5mPct: missing(
              "UNSUPPORTED",
              "MARKET_CONTEXT",
              "BEST_PAIR",
              input.market.observedAt,
            ),
            momentum15mPct: missing(
              "UNSUPPORTED",
              "MARKET_CONTEXT",
              "BEST_PAIR",
              input.market.observedAt,
            ),
          },
          quote: {
            available:
              input.quote.ok && quoteValue?.priceImpactBps !== undefined
                ? available(true, "QUOTE_IMPACT", "QUOTE", input.quote.observedAt)
                : missing(
                    input.quote.outcomeCode === "NOT_REQUESTED"
                      ? "NOT_REQUESTED"
                      : "PROVIDER_ERROR",
                    "QUOTE_IMPACT",
                    "QUOTE",
                    input.quote.observedAt,
                  ),
            priceImpactBps:
              input.quote.ok && isFiniteNumber(quoteValue?.priceImpactBps)
                ? available(
                    quoteValue.priceImpactBps,
                    "QUOTE_IMPACT",
                    "QUOTE",
                    input.quote.observedAt,
                  )
                : missing(
                    input.quote.outcomeCode === "NOT_REQUESTED"
                      ? "NOT_REQUESTED"
                      : "UNAVAILABLE_AT_ANCHOR",
                    "QUOTE_IMPACT",
                    "QUOTE",
                    input.quote.observedAt,
                  ),
          },
          risk: { blockerCodes: missing("NOT_REQUESTED", "LOCAL", "NOT_REQUESTED") },
          attention: {
            repeatedAttentionCount: available(input.duplicateCount, "LOCAL", "SLOT_DEDUPLICATION"),
          },
        },
        laterObservations,
      },
    };
  }

  private async request<T>(
    state: ArchiveState,
    category: ProviderCategory,
    provider: "DEXSCREENER" | "JUPITER",
    capability: string,
    action: () => Promise<GatewayResult<T>>,
  ): Promise<{ readonly state: ArchiveState; readonly result: GatewayResult<T> }> {
    const count = state.manifest.providerCounts[category] ?? 0;
    if (count >= EXPLORATORY_COHORT_PROVIDER_CAPS[category]) {
      throw new ExploratoryCohortError(
        "EXPLORATORY_COHORT_PROVIDER_BUDGET_EXHAUSTED",
        "A fixed provider category budget is exhausted.",
      );
    }
    const last = this.lastRequestByProvider.get(provider);
    if (last !== undefined) await this.options.clock.sleepUntil(new Date(last + 60_000));
    const startedAt = this.options.clock.now();
    this.lastRequestByProvider.set(provider, startedAt.getTime());
    const result = await action();
    return {
      state: {
        ...state,
        manifest: {
          ...state.manifest,
          providerCounts: { ...state.manifest.providerCounts, [category]: count + 1 },
        },
        sources: [...state.sources, sourceRecord(category, provider, capability, result)],
      },
      result,
    };
  }
}

function appendSlot(state: ArchiveState, slot: SlotRecord): ArchiveState {
  return {
    ...state,
    manifest: { ...state.manifest, slots: [...state.manifest.slots, slot] },
  };
}

function reconcileMissedSlots(
  state: ArchiveState,
  cohortStartAt: string,
  exclusiveEndIndex: number,
): ArchiveState {
  const represented = new Set(state.manifest.slots.map((slot) => slot.slotIndex));
  let next = state;
  for (let slotIndex = 0; slotIndex < exclusiveEndIndex; slotIndex += 1) {
    if (represented.has(slotIndex)) continue;
    const canonical = canonicalExploratoryCohortSlot(cohortStartAt, slotIndex);
    // A PAUSE_WINDOW records external availability only, never a candidate or an outcome label.
    next = appendSlot(next, {
      slotId: canonical.slotId,
      slotIndex,
      anchorAt: canonical.anchorAt.toISOString(),
      state: "PAUSE_WINDOW",
      reason: "EXTERNAL_INVOCATION_MISSED",
      discoveryCounts: { returned: 0, canonical: 0, technicallyValid: 0 },
    });
  }
  return next;
}

function assertActiveLedgerForSchedule(
  state: ArchiveState,
  cohortStartAt: string,
  exclusiveEndIndex: number,
): void {
  if (state.manifest.outcome !== "COLLECTING") {
    throw qualityStop(
      "Only a collecting archive may receive a normal collection or closeout action.",
    );
  }
  const validSlotMints = new Map<string, string | undefined>();
  for (const slot of state.manifest.slots) {
    let canonical: ExploratoryCohortScheduleSlot;
    try {
      canonical = canonicalExploratoryCohortSlot(cohortStartAt, slot.slotIndex);
    } catch {
      throw qualityStop("The archive slot ledger contains an out-of-range slot index.");
    }
    if (
      slot.slotIndex >= exclusiveEndIndex ||
      slot.slotId !== canonical.slotId ||
      slot.anchorAt !== canonical.anchorAt.toISOString() ||
      !["NO_SELECTION", "SKIP_UNIT_WITH_REASON", "VALID_UNIT", "PAUSE_WINDOW"].includes(slot.state)
    ) {
      throw qualityStop("The archive slot ledger is not canonical for this invocation.");
    }
    if (slot.state === "PAUSE_WINDOW") {
      if (
        slot.selectedMint !== undefined ||
        slot.discoveryCounts.returned !== 0 ||
        slot.discoveryCounts.canonical !== 0 ||
        slot.discoveryCounts.technicallyValid !== 0
      ) {
        throw qualityStop("A PAUSE_WINDOW row contains unsupported collection evidence.");
      }
    }
    if (slot.state === "VALID_UNIT") validSlotMints.set(slot.slotId, slot.selectedMint);
  }
  const unitIds = new Set<string>();
  for (const unit of state.units) {
    if (
      typeof unit.unitId !== "string" ||
      typeof unit.slotId !== "string" ||
      typeof unit.canonicalMint !== "string" ||
      unitIds.has(unit.unitId) ||
      validSlotMints.get(unit.slotId) !== unit.canonicalMint
    ) {
      throw qualityStop("A unit does not match one canonical VALID_UNIT slot.");
    }
    unitIds.add(unit.unitId);
  }
  if (unitIds.size !== validSlotMints.size) {
    throw qualityStop("A canonical VALID_UNIT slot is missing its unit evidence.");
  }
}

function finalizePrecondition(state: ArchiveState, reason: string): ArchiveState {
  return {
    ...state,
    manifest: { ...state.manifest, outcome: "HUMAN_REVIEW_REQUIRED", interruptionReason: reason },
  };
}

function finalizeIfNeeded(state: ArchiveState): ArchiveState {
  if (state.manifest.outcome !== "COLLECTING") return state;
  if (state.units.length >= EXPLORATORY_COHORT_COMPLETION_VALID_UNITS) {
    return {
      ...state,
      manifest: {
        ...state.manifest,
        outcome: completionGatesPass(state) ? "COHORT_COMPLETE" : "COHORT_INCOMPLETE",
      },
    };
  }
  if (state.manifest.slots.some((slot) => slot.slotIndex === EXPLORATORY_COHORT_MAX_SLOTS - 1)) {
    return { ...state, manifest: { ...state.manifest, outcome: "COHORT_INCOMPLETE" } };
  }
  if (state.units.length >= 24 && requiredAnchorMissingRate(state) > 0.25) {
    return { ...state, manifest: { ...state.manifest, outcome: "COHORT_STOPPED_DATA_QUALITY" } };
  }
  return state;
}

function completionGatesPass(state: ArchiveState): boolean {
  const dates = state.units.map((unit) => unit.anchorAt.slice(0, 10));
  const dateCounts = countValues(dates);
  const partitions = countValues(state.units.map((unit) => unit.partition));
  const partitionDates = {
    DISCOVERY: new Set(
      state.units
        .filter((unit) => unit.partition === "DISCOVERY")
        .map((unit) => unit.anchorAt.slice(0, 10)),
    ).size,
    VALIDATION: new Set(
      state.units
        .filter((unit) => unit.partition === "VALIDATION")
        .map((unit) => unit.anchorAt.slice(0, 10)),
    ).size,
  };
  return (
    state.units.length === EXPLORATORY_COHORT_COMPLETION_VALID_UNITS &&
    new Set(state.units.map((unit) => unit.canonicalMint)).size === state.units.length &&
    Object.keys(dateCounts).length >= 8 &&
    Object.values(dateCounts)
      .filter((count): count is number => count !== undefined)
      .every((count) => count / state.units.length <= 0.2) &&
    (partitions.DISCOVERY ?? 0) >= 32 &&
    (partitions.VALIDATION ?? 0) >= 32 &&
    partitionDates.DISCOVERY >= 4 &&
    partitionDates.VALIDATION >= 4
  );
}

function requiredAnchorMissingRate(state: ArchiveState): number {
  const attempted = state.manifest.slots.filter((slot) => slot.selectedMint).length;
  const missing = state.manifest.slots.filter(
    (slot) =>
      slot.state === "SKIP_UNIT_WITH_REASON" &&
      slot.reason === "MISSING_OR_STALE_REQUIRED_ANCHOR_PRICE",
  ).length;
  return attempted === 0 ? 0 : missing / attempted;
}

function countValues<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  return values.reduce<Partial<Record<T, number>>>(
    (counts, value) => ({
      ...counts,
      [value]: (counts[value] ?? 0) + 1,
    }),
    {},
  );
}

function sourceRecord<T>(
  category: ProviderCategory,
  provider: "DEXSCREENER" | "JUPITER",
  capability: string,
  result: GatewayResult<T>,
): SourceInventoryRecord {
  const sanitized: Omit<SourceInventoryRecord, "sourceHash"> = {
    attemptCount: 1,
    capability,
    category,
    latencyBucket:
      result.latencyMs < 100 ? "LT_100MS" : result.latencyMs < 1_000 ? "LT_1S" : "GE_1S",
    observedAt: result.observedAt.toISOString(),
    outcomeCode: result.outcomeCode.replace(/[^A-Z0-9_]/g, "_").slice(0, 40),
    provider,
    requestCount: 1,
  };
  return {
    ...sanitized,
    sourceHash: createHash("sha256").update(JSON.stringify(sanitized)).digest("hex"),
  };
}

function available<T>(
  value: T,
  sourceCategory: SafeFact<T>["sourceCategory"],
  sourceIdentifier: string,
  sourceTimestamp?: Date,
): SafeFact<T> {
  return {
    value,
    availability: "AVAILABLE_AT_ANCHOR",
    sourceCategory,
    sourceIdentifier,
    ...(sourceTimestamp ? { sourceTimestamp: sourceTimestamp.toISOString() } : {}),
  };
}

function missing<T>(
  availability: SafeFact<T>["availability"],
  sourceCategory: SafeFact<T>["sourceCategory"],
  sourceIdentifier: string,
  sourceTimestamp?: Date,
): SafeFact<T> {
  return {
    availability,
    sourceCategory,
    sourceIdentifier,
    ...(sourceTimestamp ? { sourceTimestamp: sourceTimestamp.toISOString() } : {}),
  };
}

function optionalMarketFact(
  value: number | undefined,
  result: GatewayResult<unknown>,
): SafeFact<number> {
  return isFiniteNumber(value)
    ? available(value, "MARKET_CONTEXT", "BEST_PAIR", result.observedAt)
    : missing(
        result.ok ? "UNAVAILABLE_AT_ANCHOR" : "PROVIDER_ERROR",
        "MARKET_CONTEXT",
        "BEST_PAIR",
        result.observedAt,
      );
}

function unavailableQuote(
  now: Date,
): GatewayResult<{ readonly observedAt: Date; readonly priceImpactBps?: number }> {
  return {
    ok: false,
    observedAt: now,
    provider: "JUPITER",
    outcomeCode: "NOT_REQUESTED",
    latencyMs: 0,
  };
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function resultFor(
  state: ArchiveState,
  archiveRoot: string,
  mode: ExploratoryCohortInvocationMode,
  invocationProviderCalls: number,
  slotId?: string,
): CollectionResult {
  return {
    outcome: state.manifest.outcome,
    archiveRoot,
    mode,
    ...(slotId ? { slotId } : {}),
    validUnitCount: state.units.length,
    providerCalls: providerCallCount(state),
    invocationProviderCalls,
    databaseReads: 0,
    databaseWrites: 0,
    runtimeCalls: 0,
    nextPermittedAction,
  };
}

function providerCallCount(state: ArchiveState): number {
  return Object.values(state.manifest.providerCounts).reduce((total, count) => total + count, 0);
}

function precondition(message: string): ExploratoryCohortError {
  return new ExploratoryCohortError("EXPLORATORY_COHORT_PRECONDITION_UNMET", message);
}

function qualityStop(message: string): ExploratoryCohortError {
  return new ExploratoryCohortError("EXPLORATORY_COHORT_DATA_QUALITY_STOP", message);
}

function assertPinnedProtocolSchema(bytes: Uint8Array): void {
  try {
    const protocol = parseExploratoryCohortProtocol(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
    if (protocol.contractVersion !== "2" || protocol.protocolId !== "EXPLORATORY_COHORT@v2") {
      throw new Error("unexpected protocol identity");
    }
  } catch {
    throw new ExploratoryCohortError(
      "EXPLORATORY_COHORT_PROTOCOL_INCONSISTENCY",
      "The pinned V2 protocol schema or source evidence is inconsistent.",
    );
  }
}
