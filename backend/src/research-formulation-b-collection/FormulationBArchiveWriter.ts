import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  FORMULATION_B_PROTOCOL_PATH,
  FORMULATION_B_PROTOCOL_SHA256,
  type FormulationBSafetyCounters,
  type FormulationBSourceRecord,
  type FormulationBUnitRecord,
} from "./FormulationBCollectionTypes.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export class FormulationBArchiveWriter {
  private readonly sources: FormulationBSourceRecord[] = [];

  public initArchive(archiveRoot: string, targetSlots: number, pid: number = 1): void {
    if (!existsSync(archiveRoot)) {
      mkdirSync(archiveRoot, { recursive: true });
    }

    const lockPayload = JSON.stringify(
      {
        pid,
        startedAt: new Date().toISOString(),
        protocolSha256: FORMULATION_B_PROTOCOL_SHA256,
        targetSlots,
      },
      null,
      2,
    );
    writeFileSync(path.join(archiveRoot, "collection.lock"), lockPayload);
  }

  public appendUnit(archiveRoot: string, unit: FormulationBUnitRecord): void {
    const line = JSON.stringify(unit) + "\n";
    appendFileSync(path.join(archiveRoot, "units.v1.ndjson"), line);
  }

  public recordSource(source: FormulationBSourceRecord): void {
    this.sources.push(source);
  }

  public finalizeArchive(
    archiveRoot: string,
    validUnits: readonly FormulationBUnitRecord[],
    safetyCounters: FormulationBSafetyCounters,
  ): void {
    const unitsPath = path.join(archiveRoot, "units.v1.ndjson");
    const unitsContent = existsSync(unitsPath) ? readFileSync(unitsPath, "utf8") : "";
    const unitsSha = sha256(unitsContent);

    // source-inventory.v1.json
    const sourceInventoryPath = path.join(archiveRoot, "source-inventory.v1.json");
    const sourceInventoryContent = JSON.stringify({ sources: this.sources }, null, 2);
    writeFileSync(sourceInventoryPath, sourceInventoryContent);
    const sourceInventorySha = sha256(sourceInventoryContent);

    // collection-summary.v1.json
    const summaryPath = path.join(archiveRoot, "collection-summary.v1.json");
    const summaryContent = JSON.stringify(
      {
        totalUnits: validUnits.length,
        finalOutcome: "COHORT_COMPLETE",
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    writeFileSync(summaryPath, summaryContent);
    const summarySha = sha256(summaryContent);

    const distinctMints = new Set(validUnits.map((u) => u.canonicalMint)).size;

    // cohort-manifest.v1.json
    const manifest = {
      protocolPath: FORMULATION_B_PROTOCOL_PATH,
      protocolSha256: FORMULATION_B_PROTOCOL_SHA256,
      finalOutcome: "COHORT_COMPLETE",
      attemptedSlotCount: validUnits.length,
      validUnitCount: validUnits.length,
      distinctMintCount: distinctMints,
      safetyCounters: {
        clockDriftStops: safetyCounters.clockDriftStops,
        schemaIntegrityStops: safetyCounters.schemaIntegrityStops,
        secretLeakageStops: safetyCounters.secretLeakageStops,
        budgetExceededStops: safetyCounters.budgetExceededStops,
      },
      executionFlags: {
        walletLoaded: false,
        transactionSigned: false,
        orderSubmitted: false,
      },
      finalFileHashes: {
        "units.v1.ndjson": unitsSha,
        "source-inventory.v1.json": sourceInventorySha,
        "collection-summary.v1.json": summarySha,
      },
    };

    const manifestPath = path.join(archiveRoot, "cohort-manifest.v1.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Release lock on clean finalization
    const lockPath = path.join(archiveRoot, "collection.lock");
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  }

  public recordAbnormalHalt(
    archiveRoot: string,
    outcomeCode: string,
    attemptedCount: number,
    validCount: number,
    safetyCounters: FormulationBSafetyCounters,
  ): void {
    const unitsPath = path.join(archiveRoot, "units.v1.ndjson");
    const unitsContent = existsSync(unitsPath) ? readFileSync(unitsPath, "utf8") : "";
    const unitsSha = sha256(unitsContent);

    const sourceInventoryPath = path.join(archiveRoot, "source-inventory.v1.json");
    const sourceInventoryContent = JSON.stringify({ sources: this.sources }, null, 2);
    writeFileSync(sourceInventoryPath, sourceInventoryContent);
    const sourceInventorySha = sha256(sourceInventoryContent);

    const summaryPath = path.join(archiveRoot, "collection-summary.v1.json");
    const summaryContent = JSON.stringify(
      {
        totalUnits: validCount,
        finalOutcome: outcomeCode,
        haltedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    writeFileSync(summaryPath, summaryContent);
    const summarySha = sha256(summaryContent);

    const manifest = {
      protocolPath: FORMULATION_B_PROTOCOL_PATH,
      protocolSha256: FORMULATION_B_PROTOCOL_SHA256,
      finalOutcome: outcomeCode,
      attemptedSlotCount: attemptedCount,
      validUnitCount: validCount,
      distinctMintCount: 0,
      safetyCounters: {
        clockDriftStops: safetyCounters.clockDriftStops,
        schemaIntegrityStops: safetyCounters.schemaIntegrityStops,
        secretLeakageStops: safetyCounters.secretLeakageStops,
        budgetExceededStops: safetyCounters.budgetExceededStops,
      },
      executionFlags: {
        walletLoaded: false,
        transactionSigned: false,
        orderSubmitted: false,
      },
      finalFileHashes: {
        "units.v1.ndjson": unitsSha,
        "source-inventory.v1.json": sourceInventorySha,
        "collection-summary.v1.json": summarySha,
      },
    };

    const manifestPath = path.join(archiveRoot, "cohort-manifest.v1.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    // Note: collection.lock intentionally preserved to fail closed
  }
}
