import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FORMULATION_B_PROTOCOL_PATH,
  FORMULATION_B_PROTOCOL_SHA256,
} from "./FormulationBAnalysisTypes.js";

export interface SyntheticUnitInput {
  readonly unitId: string;
  readonly canonicalMint: string;
  readonly anchorAt: string;
  readonly slotId: string;
  readonly momentum5mPct: number | null;
  readonly momentum15mPct: number | null;
  readonly return60mPct: number | null;
  readonly primaryLabel?: "POSITIVE_60M" | "NON_POSITIVE_60M" | "UNUSABLE_60M";
  readonly injectedLiquidity?: number;
}

export interface SyntheticArchiveOptions {
  readonly protocolSha256?: string;
  readonly finalOutcome?: string;
  readonly units?: readonly SyntheticUnitInput[];
  readonly safetyCounters?: Record<string, number>;
  readonly executionFlags?: Record<string, boolean>;
  readonly tamperArtifact?: "units" | "source-inventory" | "summary";
  readonly activeLock?: boolean;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function generateCanonicalMint(
  index: number,
  targetPartition: "DISCOVERY" | "VALIDATION",
  slotId: string,
): string {
  let counter = index;
  while (true) {
    const mint = `Mint${counter.toString().padStart(40, "0")}`;
    const digest = sha256(`formulation-b-exploratory-protocol.v1|${mint}|${slotId}`);
    const lastChar = digest[digest.length - 1] ?? "";
    const isEven = ["0", "2", "4", "6", "8", "a", "c", "e"].includes(lastChar);
    if (
      (targetPartition === "DISCOVERY" && isEven) ||
      (targetPartition === "VALIDATION" && !isEven)
    ) {
      return mint;
    }
    counter++;
  }
}

export function writeSyntheticArchive(
  targetDir: string,
  options: SyntheticArchiveOptions = {},
): string {
  mkdirSync(targetDir, { recursive: true });

  if (options.activeLock) {
    writeFileSync(path.join(targetDir, "collection.lock"), "active");
  }

  const rawUnits: Record<string, unknown>[] = [];
  const unitsInput = options.units ?? [];

  for (const u of unitsInput) {
    const splitDigest = sha256(
      `formulation-b-exploratory-protocol.v1|${u.canonicalMint}|${u.slotId}`,
    );
    const lastChar = splitDigest[splitDigest.length - 1] ?? "";
    const partition = ["0", "2", "4", "6", "8", "a", "c", "e"].includes(lastChar)
      ? "DISCOVERY"
      : "VALIDATION";

    const mom5m = u.momentum5mPct;
    const mom15m = u.momentum15mPct;
    const acc = mom5m !== null && mom15m !== null ? mom5m - mom15m : null;

    let primaryLabel = u.primaryLabel;
    if (!primaryLabel) {
      if (u.return60mPct === null) primaryLabel = "UNUSABLE_60M";
      else primaryLabel = u.return60mPct > 0 ? "POSITIVE_60M" : "NON_POSITIVE_60M";
    }

    const decisionTimeEvidence: Record<string, unknown> = {
      priceUsd: 1.0,
      momentum5mPct: mom5m,
      momentum15mPct: mom15m,
      momentumAccelerationPct: acc,
      assetAgeSeconds: 300,
    };

    if (u.injectedLiquidity !== undefined) {
      decisionTimeEvidence.liquidityUsd = u.injectedLiquidity;
    }

    rawUnits.push({
      unitId: u.unitId,
      canonicalMint: u.canonicalMint,
      anchorAt: u.anchorAt,
      slotId: u.slotId,
      partition,
      decisionTimeEvidence,
      forwardOutcomeLabels: {
        return60mPct: u.return60mPct,
        primaryLabel,
        return3mPct: 0.1,
        return5mPct: 0.2,
        return15mPct: 0.5,
      },
    });
  }

  // units.v1.ndjson
  let unitsNdjson = rawUnits.map((u) => JSON.stringify(u)).join("\n");
  if (options.tamperArtifact === "units") {
    unitsNdjson += "\nTAMPERED";
  }
  writeFileSync(path.join(targetDir, "units.v1.ndjson"), unitsNdjson);
  const unitsSha = sha256(unitsNdjson);

  // source-inventory.v1.json
  const sourceInventory = JSON.stringify(
    {
      sources: [
        {
          utcDate: "2026-09-01",
          category: "DISCOVERY",
          capability: "DISCOVER_TOKENS",
          outcomeCode: "OK",
          latencyBucket: "LT_100MS",
        },
      ],
    },
    null,
    2,
  );
  writeFileSync(path.join(targetDir, "source-inventory.v1.json"), sourceInventory);
  const sourceInvSha = sha256(sourceInventory);

  // collection-summary.v1.json
  const summary = JSON.stringify(
    {
      totalUnits: rawUnits.length,
      finalOutcome: options.finalOutcome ?? "COHORT_COMPLETE",
    },
    null,
    2,
  );
  writeFileSync(path.join(targetDir, "collection-summary.v1.json"), summary);
  const summarySha = sha256(summary);

  // cohort-manifest.v1.json
  const manifest = {
    protocolPath: FORMULATION_B_PROTOCOL_PATH,
    protocolSha256: options.protocolSha256 ?? FORMULATION_B_PROTOCOL_SHA256,
    finalOutcome: options.finalOutcome ?? "COHORT_COMPLETE",
    attemptedSlotCount: rawUnits.length,
    validUnitCount: rawUnits.length,
    distinctMintCount: new Set(rawUnits.map((u) => u.canonicalMint)).size,
    safetyCounters: options.safetyCounters ?? {
      clockDriftStops: 0,
      schemaIntegrityStops: 0,
      secretLeakageStops: 0,
      budgetExceededStops: 0,
    },
    executionFlags: options.executionFlags ?? {
      walletLoaded: false,
      transactionSigned: false,
      orderSubmitted: false,
    },
    finalFileHashes: {
      "units.v1.ndjson":
        options.tamperArtifact === "units"
          ? "0000000000000000000000000000000000000000000000000000000000000000"
          : unitsSha,
      "source-inventory.v1.json": sourceInvSha,
      "collection-summary.v1.json": summarySha,
    },
  };

  writeFileSync(path.join(targetDir, "cohort-manifest.v1.json"), JSON.stringify(manifest, null, 2));
  return targetDir;
}

/**
 * Builds a standard valid 96-unit cohort distributed over 8 dates
 * (48 Discovery, 48 Validation; exactly 12 units per date across 8 dates = 12.5% max date share).
 */
export function buildStandardSyntheticCohort(
  scenario:
    | "passing"
    | "validation_rejected"
    | "no_defensible"
    | "insufficient_mom"
    | "insufficient_size"
    | "concentration_breach" = "passing",
): SyntheticUnitInput[] {
  const units: SyntheticUnitInput[] = [];
  const dates = [
    "2026-09-01T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z",
    "2026-09-03T00:00:00.000Z",
    "2026-09-04T00:00:00.000Z",
    "2026-09-05T00:00:00.000Z",
    "2026-09-06T00:00:00.000Z",
    "2026-09-07T00:00:00.000Z",
    "2026-09-08T00:00:00.000Z",
  ];

  if (scenario === "insufficient_size") {
    // Generate only 60 units (below 72 minimum)
    for (let i = 0; i < 60; i++) {
      const targetPart = i % 2 === 0 ? "DISCOVERY" : "VALIDATION";
      const slotId = `slot-${i}`;
      const mint = generateCanonicalMint(i * 100, targetPart, slotId);
      const date = dates[i % 8] ?? "2026-09-01T00:00:00.000Z";
      units.push({
        unitId: `unit-${String(i).padStart(3, "0")}`,
        canonicalMint: mint,
        anchorAt: date,
        slotId,
        momentum5mPct: 5.0,
        momentum15mPct: 2.0,
        return60mPct: 1.5,
      });
    }
    return units;
  }

  let unitCounter = 0;
  // 96 total units across 8 dates: 12 units per date (6 Discovery, 6 Validation per date)
  for (let d = 0; d < 8; d++) {
    const date = dates[d] ?? "2026-09-01T00:00:00.000Z";
    const unitsOnDate =
      scenario === "concentration_breach" && d === 0
        ? 30
        : scenario === "concentration_breach"
          ? 9
          : 12;

    for (let u = 0; u < unitsOnDate; u++) {
      const targetPart: "DISCOVERY" | "VALIDATION" = u % 2 === 0 ? "DISCOVERY" : "VALIDATION";
      const slotId = `slot-${d}-${u}`;
      const mint = generateCanonicalMint(unitCounter * 100, targetPart, slotId);

      let mom5m: number | null = 5.0;
      let mom15m: number | null = 2.0;
      let ret60m: number | null = 1.0;

      // Acceleration: high acceleration if target high
      // In Discovery: 48 units. Q3 is top 12 units.
      // Make top 12 units have mom5m=15, mom15m=2 -> acc = 13.
      // Make comparison units have mom5m=3, mom15m=2 -> acc = 1.
      const isTopAcc = u < 3; // 3 per date * 8 dates = 24 top units (12 in Disc, 12 in Val)
      if (isTopAcc) {
        mom5m = 15.0;
        mom15m = 2.0; // acc = +13.0%
      } else {
        mom5m = 3.0;
        mom15m = 2.0; // acc = +1.0%
      }

      if (scenario === "insufficient_mom" && unitCounter < 20) {
        // Drop momentum for 20 units (~21% missingness, leaving ~79% availability < 90%)
        mom5m = null;
        mom15m = null;
      }

      if (scenario === "passing") {
        // Discovery: TopAcc -> 100% positive, Comp -> 30% positive (diff = +70% >= 20%)
        // Validation: TopAcc -> 80% positive, Comp -> 40% positive (diff = +40% > 0)
        if (isTopAcc) {
          ret60m = 5.0; // POSITIVE
        } else {
          ret60m = u % 3 === 0 ? 2.0 : -2.0; // ~33% positive
        }
      } else if (scenario === "validation_rejected") {
        // Discovery: TopAcc -> 100% positive, Comp -> 30% positive
        // Validation: TopAcc -> 10% positive, Comp -> 50% positive (diff = -40% <= 0)
        if (targetPart === "DISCOVERY") {
          ret60m = isTopAcc ? 5.0 : u % 3 === 0 ? 2.0 : -2.0;
        } else {
          ret60m = isTopAcc ? -5.0 : 5.0; // Validation fails
        }
      } else if (scenario === "no_defensible") {
        // Discovery: TopAcc -> 40% positive, Comp -> 40% positive (diff = 0 < 20%)
        ret60m = u % 2 === 0 ? 2.0 : -2.0;
      }

      units.push({
        unitId: `unit-${String(unitCounter).padStart(3, "0")}`,
        canonicalMint: mint,
        anchorAt: date,
        slotId,
        momentum5mPct: mom5m,
        momentum15mPct: mom15m,
        return60mPct: ret60m,
      });

      unitCounter++;
      if (scenario === "concentration_breach" && unitCounter >= 96) break;
    }
  }

  return units;
}
