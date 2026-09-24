import type { Repositories } from "../db/repositories/index.js";
import type { SessionRecord, StrategyDecisionRecord } from "../db/schema/index.js";
import { parseJson } from "../db/utils/json.js";
import { resolveShadowSourceDecisions, type ShadowRuntimeConfig } from "./ShadowConfig.js";
import type { ShadowCandidate } from "./ShadowTypes.js";

const MINUTE_MS = 60_000;

export interface ShadowCandidateSelection {
  readonly session: SessionRecord;
  readonly candidates: readonly ShadowCandidate[];
  readonly skippedReasons: readonly string[];
}

export interface ShadowCandidateSelectorOptions {
  readonly config: ShadowRuntimeConfig;
  readonly repositories: Repositories;
  readonly clock?: () => number;
}

export class ShadowCandidateSelector {
  private readonly clock: () => number;

  constructor(private readonly options: ShadowCandidateSelectorOptions) {
    this.clock = options.clock ?? Date.now;
  }

  select(): ShadowCandidateSelection {
    const session = this.resolveSession();
    const sinceMs = this.clock() - this.options.config.sinceHours * 60 * MINUTE_MS;
    const sourceDecisions = new Set(resolveShadowSourceDecisions(this.options.config));
    const skippedReasons: string[] = [];
    const candidates: ShadowCandidate[] = [];

    const decisions = this.options.repositories.strategyDecisions
      .listStrategyDecisions(session.id, { limit: this.options.config.limit })
      .filter((decision) => decision.decidedAtMs >= sinceMs)
      .filter((decision) => this.shouldIncludeDecision(decision, sourceDecisions));

    for (const decision of decisions) {
      const candidate = this.buildCandidate(session, decision);

      if (!candidate.baselinePriceSol && !candidate.baselinePriceUsd) {
        skippedReasons.push(`${decision.id}: missing baseline price`);
        continue;
      }

      candidates.push(candidate);
    }

    return {
      session,
      candidates,
      skippedReasons,
    };
  }

  private resolveSession(): SessionRecord {
    if (this.options.config.sessionId) {
      const session = this.options.repositories.sessions.getSessionById(
        this.options.config.sessionId,
      );

      if (!session) {
        throw new Error(`Shadow session not found: ${this.options.config.sessionId}`);
      }

      if (session.mode !== "PAPER" || session.status !== "RUNNING") {
        throw new Error(
          `Shadow commands require a PAPER + RUNNING session. Session ${session.id} is ${session.mode}/${session.status}.`,
        );
      }

      return session;
    }

    for (const session of this.options.repositories.sessions.listSessions({
      mode: "PAPER",
      limit: 100,
    })) {
      if (
        session.status === "RUNNING" &&
        this.options.repositories.strategyDecisions.listStrategyDecisions(session.id, {
          limit: 1,
        }).length > 0
      ) {
        return session;
      }
    }

    throw new Error(
      "No RUNNING PAPER session with StrategyDecision rows was found. Run strategy evaluation first or pass --session-id.",
    );
  }

  private shouldIncludeDecision(
    decision: StrategyDecisionRecord,
    sourceDecisions: Set<StrategyDecisionRecord["decision"]>,
  ): boolean {
    if (!sourceDecisions.has(decision.decision)) {
      return false;
    }

    if (decision.decision === "BUY") {
      return true;
    }

    return (
      this.options.config.includeShadowScores &&
      (decision.score ?? -1) >= this.options.config.shadowScoreMin
    );
  }

  private buildCandidate(
    session: SessionRecord,
    decision: StrategyDecisionRecord,
  ): ShadowCandidate {
    const snapshot = readTokenRadarSnapshot(decision);
    const radar = this.options.repositories.tokenRadar.findRadarEntryByMint(
      session.id,
      decision.mintAddress,
    );
    const selectionMode = decision.decision === "BUY" ? "BUY" : "SHADOW_SCORE";

    return {
      decision,
      symbol: snapshot.symbol ?? radar?.symbol ?? undefined,
      name: snapshot.name ?? radar?.name ?? undefined,
      pairAddress: snapshot.pairAddress ?? radar?.pairAddress ?? undefined,
      baselinePriceSol: snapshot.priceSol ?? normalizeDecimalString(radar?.priceSol),
      baselinePriceUsd: snapshot.priceUsd ?? normalizeDecimalString(radar?.priceUsd),
      liquidityUsd: snapshot.liquidityUsd ?? normalizeDecimalString(radar?.liquidityUsd),
      volume1hUsd: snapshot.volume1hUsd ?? normalizeDecimalString(radar?.volume1hUsd),
      ageSeconds: snapshot.ageSeconds ?? radar?.ageSeconds ?? undefined,
      selectionMode,
    };
  }
}

interface TokenRadarSnapshot {
  readonly symbol?: string | undefined;
  readonly name?: string | undefined;
  readonly pairAddress?: string | undefined;
  readonly priceSol?: string | undefined;
  readonly priceUsd?: string | undefined;
  readonly liquidityUsd?: string | undefined;
  readonly volume1hUsd?: string | undefined;
  readonly ageSeconds?: number | undefined;
}

function readTokenRadarSnapshot(decision: StrategyDecisionRecord): TokenRadarSnapshot {
  if (!decision.inputSnapshotJson) {
    return {};
  }

  try {
    const parsed = parseJson<unknown>(decision.inputSnapshotJson);
    const tokenRadar = getRecord(getRecord(parsed)?.tokenRadar);

    if (!tokenRadar) {
      return {};
    }

    return {
      symbol: readString(tokenRadar, "symbol"),
      name: readString(tokenRadar, "name"),
      pairAddress: readString(tokenRadar, "pairAddress"),
      priceSol: normalizeDecimalString(readString(tokenRadar, "priceSol")),
      priceUsd: normalizeDecimalString(readString(tokenRadar, "priceUsd")),
      liquidityUsd: normalizeDecimalString(readString(tokenRadar, "liquidityUsd")),
      volume1hUsd: normalizeDecimalString(readString(tokenRadar, "volume1hUsd")),
      ageSeconds: readNumber(tokenRadar, "ageSeconds"),
    };
  } catch {
    return {};
  }
}

function normalizeDecimalString(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? value.trim() : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
