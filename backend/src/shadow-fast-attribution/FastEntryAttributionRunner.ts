import { loadResearchRunArchives } from "../research/ResearchRunArchiveLoader.js";
import { defaultShadowCalibrationConfig } from "../shadow-calibration/ShadowCalibrationConfig.js";
import { loadShadowCalibrationRuns } from "../shadow-calibration/ShadowRunLoader.js";
import { FastEntryAttributionService } from "./FastEntryAttributionService.js";
import type {
  FastEntryAttributionReport,
  FastEntryAttributionRuntimeConfig,
} from "./FastEntryAttributionTypes.js";

export class FastEntryAttributionRunner {
  constructor(
    private readonly options: {
      readonly config: FastEntryAttributionRuntimeConfig;
      readonly clock?: () => number;
    },
  ) {}

  run(): FastEntryAttributionReport {
    const archives = loadResearchRunArchives(this.options.config.runSources);
    const loaded = loadShadowCalibrationRuns({
      ...defaultShadowCalibrationConfig(),
      once: true,
      dbSources: archives.map((archive) => ({ label: archive.label, path: archive.databasePath })),
    });
    try {
      return new FastEntryAttributionService({
        archives,
        runs: loaded.runs,
        ...(this.options.clock ? { clock: this.options.clock } : {}),
      }).generate();
    } finally {
      loaded.close();
    }
  }
}
