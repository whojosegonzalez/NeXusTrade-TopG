import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FormulationBAnalysisError } from "./FormulationBAnalysisErrors.js";
import {
  FORMULATION_B_PROTOCOL_PATH,
  FORMULATION_B_PROTOCOL_SHA256,
  type FormulationBArtifactName,
  type FormulationBUnitRecord,
  type FormulationBSourceRecord,
  type LoadedFormulationBArchive,
} from "./FormulationBAnalysisTypes.js";

const REQUIRED_ARTIFACTS: readonly FormulationBArtifactName[] = [
  "cohort-manifest.v1.json",
  "units.v1.ndjson",
  "source-inventory.v1.json",
  "collection-summary.v1.json",
];

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseJsonSafe<T>(content: string, errorDetail: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_SOURCE_INCONSISTENCY",
      `Malformed JSON in ${errorDetail}`,
    );
  }
}

export function loadFormulationBArchive(archiveRoot: string): LoadedFormulationBArchive {
  if (!existsSync(archiveRoot)) {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_INVALID_SCOPE",
      `Archive root not found: ${archiveRoot}`,
    );
  }

  const stat = lstatSync(archiveRoot);
  if (!stat.isDirectory()) {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_INVALID_SCOPE",
      `Archive root is not a directory: ${archiveRoot}`,
    );
  }

  const entries = readdirSync(archiveRoot);
  if (entries.includes("collection.lock")) {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_ARCHIVE_NOT_FINAL",
      "Active collection.lock found in archive",
    );
  }

  for (const required of REQUIRED_ARTIFACTS) {
    if (!entries.includes(required)) {
      throw new FormulationBAnalysisError(
        "FORMULATION_B_SOURCE_INCONSISTENCY",
        `Missing required artifact: ${required}`,
      );
    }
  }

  // Load and hash all artifacts
  const inventory: Record<FormulationBArtifactName, string> = {
    "cohort-manifest.v1.json": "",
    "units.v1.ndjson": "",
    "source-inventory.v1.json": "",
    "collection-summary.v1.json": "",
  };

  const rawContents: Record<FormulationBArtifactName, string> = {
    "cohort-manifest.v1.json": "",
    "units.v1.ndjson": "",
    "source-inventory.v1.json": "",
    "collection-summary.v1.json": "",
  };

  for (const artifact of REQUIRED_ARTIFACTS) {
    const filePath = path.join(archiveRoot, artifact);
    const content = readFileSync(filePath, "utf8");
    rawContents[artifact] = content;
    inventory[artifact] = sha256(content);
  }

  // Parse Manifest
  interface RawManifest {
    protocolPath?: string;
    protocolSha256?: string;
    finalOutcome?: string;
    finalFileHashes?: Record<string, string>;
    safetyCounters?: Record<string, number>;
    executionFlags?: Record<string, boolean>;
    attemptedSlotCount?: number;
    validUnitCount?: number;
    distinctMintCount?: number;
  }

  const manifest = parseJsonSafe<RawManifest>(
    rawContents["cohort-manifest.v1.json"],
    "cohort-manifest.v1.json",
  );

  if (!manifest.protocolSha256 || manifest.protocolSha256 !== FORMULATION_B_PROTOCOL_SHA256) {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_UNSUPPORTED_ARCHIVE",
      `Protocol SHA mismatch: expected ${FORMULATION_B_PROTOCOL_SHA256}, got ${manifest.protocolSha256}`,
    );
  }

  if (
    manifest.protocolPath &&
    !manifest.protocolPath.endsWith(path.basename(FORMULATION_B_PROTOCOL_PATH))
  ) {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_UNSUPPORTED_ARCHIVE",
      `Protocol path mismatch: expected ${FORMULATION_B_PROTOCOL_PATH}, got ${manifest.protocolPath}`,
    );
  }

  if (!manifest.finalOutcome) {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_ARCHIVE_NOT_FINAL",
      "Manifest missing finalOutcome",
    );
  }

  // Verify manifest finalFileHashes
  if (!manifest.finalFileHashes) {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_SOURCE_INCONSISTENCY",
      "Manifest missing finalFileHashes",
    );
  }

  for (const artifact of [
    "units.v1.ndjson",
    "source-inventory.v1.json",
    "collection-summary.v1.json",
  ] as const) {
    const expectedHash = manifest.finalFileHashes[artifact];
    const actualHash = inventory[artifact];
    if (!expectedHash || expectedHash !== actualHash) {
      throw new FormulationBAnalysisError(
        "FORMULATION_B_SOURCE_INCONSISTENCY",
        `Checksum mismatch for ${artifact}: expected ${expectedHash}, computed ${actualHash}`,
      );
    }
  }

  // Safety counters check
  if (manifest.safetyCounters) {
    for (const [key, val] of Object.entries(manifest.safetyCounters)) {
      if (val !== 0) {
        throw new FormulationBAnalysisError(
          "FORMULATION_B_SOURCE_INCONSISTENCY",
          `Nonzero safety counter: ${key}=${val}`,
        );
      }
    }
  }

  // Execution flags check
  if (manifest.executionFlags) {
    for (const [key, val] of Object.entries(manifest.executionFlags)) {
      if (val === true) {
        throw new FormulationBAnalysisError(
          "FORMULATION_B_SOURCE_INCONSISTENCY",
          `Execution flag enabled: ${key}=true`,
        );
      }
    }
  }

  interface RawUnitPayload {
    unitId?: unknown;
    canonicalMint?: unknown;
    slotId?: unknown;
    partition?: unknown;
    anchorAt?: unknown;
    decisionTimeEvidence?: {
      priceUsd?: unknown;
      momentum5mPct?: unknown;
      momentum15mPct?: unknown;
      momentumAccelerationPct?: unknown;
      assetAgeSeconds?: unknown;
      missingnessCode?: unknown;
      liquidityUsd?: unknown;
      quoteImpactBps?: unknown;
      poolReserveUsd?: unknown;
    };
    forwardOutcomeLabels?: {
      return60mPct?: unknown;
      primaryLabel?: unknown;
      return3mPct?: unknown;
      return5mPct?: unknown;
      return15mPct?: unknown;
    };
  }

  // Parse Units
  const unitLines = rawContents["units.v1.ndjson"]
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const units: FormulationBUnitRecord[] = [];
  const seenMints = new Set<string>();

  for (let idx = 0; idx < unitLines.length; idx++) {
    const rawLine = unitLines[idx];
    if (!rawLine) continue;
    const rawUnit = parseJsonSafe<RawUnitPayload>(rawLine, `units.v1.ndjson line ${idx + 1}`);

    if (
      typeof rawUnit.unitId !== "string" ||
      typeof rawUnit.canonicalMint !== "string" ||
      typeof rawUnit.slotId !== "string" ||
      (rawUnit.partition !== "DISCOVERY" && rawUnit.partition !== "VALIDATION") ||
      typeof rawUnit.anchorAt !== "string"
    ) {
      throw new FormulationBAnalysisError(
        "FORMULATION_B_SOURCE_INCONSISTENCY",
        `Unit record missing required identity fields at index ${idx}`,
      );
    }

    // Check for forbidden liquidity fields in raw input
    if (
      rawUnit.decisionTimeEvidence &&
      (rawUnit.decisionTimeEvidence.liquidityUsd !== undefined ||
        rawUnit.decisionTimeEvidence.quoteImpactBps !== undefined ||
        rawUnit.decisionTimeEvidence.poolReserveUsd !== undefined)
    ) {
      throw new FormulationBAnalysisError(
        "FORMULATION_B_SOURCE_INCONSISTENCY",
        `Forbidden liquidity field detected in decision-time inputs for unit ${rawUnit.unitId}`,
      );
    }

    // Verify deterministic split hash
    const splitHashPreimage = `formulation-b-exploratory-protocol.v1|${rawUnit.canonicalMint}|${rawUnit.slotId}`;
    const splitDigest = sha256(splitHashPreimage);
    const lastChar = splitDigest[splitDigest.length - 1] ?? "";
    const expectedPartition = ["0", "2", "4", "6", "8", "a", "c", "e"].includes(lastChar)
      ? "DISCOVERY"
      : "VALIDATION";

    if (rawUnit.partition !== expectedPartition) {
      throw new FormulationBAnalysisError(
        "FORMULATION_B_SOURCE_INCONSISTENCY",
        `Partition split mismatch for unit ${rawUnit.unitId}: expected ${expectedPartition}, recorded ${rawUnit.partition}`,
      );
    }

    // Canonical mint deduplication check within cohort
    if (seenMints.has(rawUnit.canonicalMint)) {
      throw new FormulationBAnalysisError(
        "FORMULATION_B_SOURCE_INCONSISTENCY",
        `Duplicate canonical mint detected in cohort: ${rawUnit.canonicalMint}`,
      );
    }
    seenMints.add(rawUnit.canonicalMint);

    const anchorDate = rawUnit.anchorAt.substring(0, 10);
    const primaryLabel =
      rawUnit.forwardOutcomeLabels?.primaryLabel === "POSITIVE_60M" ||
      rawUnit.forwardOutcomeLabels?.primaryLabel === "NON_POSITIVE_60M" ||
      rawUnit.forwardOutcomeLabels?.primaryLabel === "UNUSABLE_60M"
        ? rawUnit.forwardOutcomeLabels.primaryLabel
        : "UNUSABLE_60M";

    units.push({
      unitId: rawUnit.unitId,
      canonicalMint: rawUnit.canonicalMint,
      anchorAt: rawUnit.anchorAt,
      anchorDate,
      slotId: rawUnit.slotId,
      partition: rawUnit.partition,
      decisionTimeEvidence: {
        priceUsd:
          typeof rawUnit.decisionTimeEvidence?.priceUsd === "number"
            ? rawUnit.decisionTimeEvidence.priceUsd
            : null,
        momentum5mPct:
          typeof rawUnit.decisionTimeEvidence?.momentum5mPct === "number"
            ? rawUnit.decisionTimeEvidence.momentum5mPct
            : null,
        momentum15mPct:
          typeof rawUnit.decisionTimeEvidence?.momentum15mPct === "number"
            ? rawUnit.decisionTimeEvidence.momentum15mPct
            : null,
        momentumAccelerationPct:
          typeof rawUnit.decisionTimeEvidence?.momentumAccelerationPct === "number"
            ? rawUnit.decisionTimeEvidence.momentumAccelerationPct
            : null,
        assetAgeSeconds:
          typeof rawUnit.decisionTimeEvidence?.assetAgeSeconds === "number"
            ? rawUnit.decisionTimeEvidence.assetAgeSeconds
            : null,
        missingnessCode:
          typeof rawUnit.decisionTimeEvidence?.missingnessCode === "string"
            ? rawUnit.decisionTimeEvidence.missingnessCode
            : undefined,
      },
      forwardOutcomeLabels: {
        return60mPct:
          typeof rawUnit.forwardOutcomeLabels?.return60mPct === "number"
            ? rawUnit.forwardOutcomeLabels.return60mPct
            : null,
        primaryLabel,
        return3mPct:
          typeof rawUnit.forwardOutcomeLabels?.return3mPct === "number"
            ? rawUnit.forwardOutcomeLabels.return3mPct
            : undefined,
        return5mPct:
          typeof rawUnit.forwardOutcomeLabels?.return5mPct === "number"
            ? rawUnit.forwardOutcomeLabels.return5mPct
            : undefined,
        return15mPct:
          typeof rawUnit.forwardOutcomeLabels?.return15mPct === "number"
            ? rawUnit.forwardOutcomeLabels.return15mPct
            : undefined,
      },
    });
  }

  // Parse Source Inventory
  interface RawSourceItem {
    utcDate?: unknown;
    category?: unknown;
    capability?: unknown;
    outcomeCode?: unknown;
    latencyBucket?: unknown;
  }
  interface RawSourceInventory {
    sources?: RawSourceItem[];
  }
  const rawSourcesObj = parseJsonSafe<RawSourceInventory>(
    rawContents["source-inventory.v1.json"],
    "source-inventory.v1.json",
  );
  const sources: FormulationBSourceRecord[] = (rawSourcesObj.sources ?? []).map((s) => ({
    utcDate: String(s.utcDate ?? ""),
    category: String(s.category ?? ""),
    capability: String(s.capability ?? ""),
    outcomeCode: String(s.outcomeCode ?? ""),
    latencyBucket: String(s.latencyBucket ?? ""),
  }));

  return {
    archiveRoot,
    protocolSha256: manifest.protocolSha256,
    finalOutcome: manifest.finalOutcome,
    attemptedSlotCount: manifest.attemptedSlotCount ?? units.length,
    validUnitCount: units.length,
    distinctMintCount: seenMints.size,
    inventory,
    units,
    sources,
  };
}
