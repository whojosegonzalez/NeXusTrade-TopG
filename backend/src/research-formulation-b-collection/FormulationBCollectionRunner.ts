import { createHash } from "node:crypto";
import { FormulationBArchiveWriter } from "./FormulationBArchiveWriter.js";
import { FormulationBCollectionError } from "./FormulationBCollectionErrors.js";
import type {
  FormulationBCollectionConfig,
  FormulationBPartition,
  FormulationBProviderClient,
  FormulationBUnitRecord,
} from "./FormulationBCollectionTypes.js";
import { FormulationBMomentumCapture } from "./FormulationBMomentumCapture.js";
import { FormulationBOutcomeQueue } from "./FormulationBOutcomeQueue.js";
import { FormulationBSafetyMonitor } from "./FormulationBSafetyMonitor.js";
import { FormulationBTokenDiscovery } from "./FormulationBTokenDiscovery.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface FormulationBCollectionResult {
  readonly success: boolean;
  readonly archiveRoot: string;
  readonly attemptedSlots: number;
  readonly validUnits: number;
  readonly finalOutcome: string;
}

export class FormulationBCollectionRunner {
  private readonly safety: FormulationBSafetyMonitor;
  private readonly discovery: FormulationBTokenDiscovery;
  private readonly momentum: FormulationBMomentumCapture;
  private readonly outcomes: FormulationBOutcomeQueue;
  private readonly writer: FormulationBArchiveWriter;

  constructor(
    private readonly config: FormulationBCollectionConfig,
    provider: FormulationBProviderClient,
  ) {
    this.safety = new FormulationBSafetyMonitor();
    this.discovery = new FormulationBTokenDiscovery(provider, this.safety);
    this.momentum = new FormulationBMomentumCapture(provider, this.safety);
    this.outcomes = new FormulationBOutcomeQueue(provider, this.safety);
    this.writer = new FormulationBArchiveWriter();
  }

  public async run(): Promise<FormulationBCollectionResult> {
    const { archiveRoot, targetSlots, days, slotsPerDay } = this.config;
    this.writer.initArchive(archiveRoot, targetSlots);

    const validUnits: FormulationBUnitRecord[] = [];
    let attemptedSlots = 0;

    try {
      const now = new Date();
      const currentIso = now.toISOString();
      const currentUtcDate = currentIso.substring(0, 10);

      for (let d = 0; d < days; d++) {
        const dayMs = now.getTime() + d * 24 * 60 * 60 * 1000;
        const utcDate =
          days === 1 ? currentUtcDate : new Date(dayMs).toISOString().substring(0, 10);

        for (let s = 0; s < slotsPerDay; s++) {
          if (validUnits.length >= targetSlots) break;

          attemptedSlots++;
          const slotOffsetMs = s * (2 * 60 * 60 * 1000); // 2-hour interval spacing
          const anchorAt =
            days === 1 && s === 0 ? currentIso : new Date(dayMs + slotOffsetMs).toISOString();
          const slotId = `slot-${utcDate.replace(/-/g, "")}-${String(attemptedSlots).padStart(3, "0")}`;

          try {
            // 1. Discover Candidate
            const cand = await this.discovery.discoverNextCandidate(utcDate, slotId);
            if (!cand) {
              this.safety.recordSlotFailure();
              continue;
            }

            // 2. Deterministic Partition Split
            const splitPreimage = `formulation-b-exploratory-protocol.v1|${cand.canonicalMint}|${slotId}`;
            const splitDigest = sha256(splitPreimage);
            const lastChar = splitDigest[splitDigest.length - 1] ?? "";
            const isEven = ["0", "2", "4", "6", "8", "a", "c", "e"].includes(lastChar);
            const partition: FormulationBPartition = isEven ? "DISCOVERY" : "VALIDATION";

            // 3. Capture Decision Evidence
            const decisionFacts = await this.momentum.captureMomentumEvidence(
              cand.canonicalMint,
              anchorAt,
              utcDate,
              cand.assetAgeSeconds,
            );

            // 4. Capture Forward Outcomes
            const forwardOutcomes = await this.outcomes.evaluateForwardOutcomes(
              cand.canonicalMint,
              decisionFacts.priceUsd,
              anchorAt,
              utcDate,
            );

            const unitRecord: FormulationBUnitRecord = {
              unitId: `unit-${String(validUnits.length + 1).padStart(3, "0")}`,
              canonicalMint: cand.canonicalMint,
              anchorAt,
              anchorDate: utcDate,
              slotId,
              partition,
              decisionTimeEvidence: decisionFacts,
              forwardOutcomeLabels: forwardOutcomes,
            };

            validUnits.push(unitRecord);
            this.writer.appendUnit(archiveRoot, unitRecord);
            this.safety.recordSlotSuccess();
          } catch (slotErr: unknown) {
            this.safety.recordSlotFailure();
            if (slotErr instanceof FormulationBCollectionError) {
              throw slotErr;
            }
          }
        }
      }

      const minRequired = Math.min(72, targetSlots);
      if (validUnits.length < minRequired) {
        throw new FormulationBCollectionError(
          "FORMULATION_B_ABORTED",
          `Cohort sufficiency failure: only ${validUnits.length} valid units collected (< ${minRequired} minimum)`,
        );
      }

      this.writer.finalizeArchive(archiveRoot, validUnits, this.safety.safetyCounters);

      return {
        success: true,
        archiveRoot,
        attemptedSlots,
        validUnits: validUnits.length,
        finalOutcome: "COHORT_COMPLETE",
      };
    } catch (err: unknown) {
      const outcomeCode =
        err instanceof FormulationBCollectionError ? err.code : "FORMULATION_B_ABORTED";
      this.writer.recordAbnormalHalt(
        archiveRoot,
        outcomeCode,
        attemptedSlots,
        validUnits.length,
        this.safety.safetyCounters,
      );
      throw err;
    }
  }
}
