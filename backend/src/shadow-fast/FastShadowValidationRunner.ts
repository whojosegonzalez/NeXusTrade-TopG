import { loadResearchRunArchives } from "../research/ResearchRunArchiveLoader.js";
import { defaultShadowCalibrationConfig } from "../shadow-calibration/ShadowCalibrationConfig.js";
import { loadShadowCalibrationRuns } from "../shadow-calibration/ShadowRunLoader.js";
import type {
  FastShadowValidationRuntimeConfig,
  FastShadowValidationReport,
} from "./FastShadowValidationTypes.js";
import { FastShadowValidationService } from "./FastShadowValidationService.js";

export class FastShadowValidationRunner {
  constructor(
    private readonly options: {
      readonly config: FastShadowValidationRuntimeConfig;
      readonly clock?: () => number;
    },
  ) {}

  run(): FastShadowValidationReport {
    const archives = loadResearchRunArchives(this.options.config.runSources);
    const loaded = loadShadowCalibrationRuns({
      ...defaultShadowCalibrationConfig(),
      once: true,
      dbSources: archives.map((archive) => ({ label: archive.label, path: archive.databasePath })),
    });
    try {
      return new FastShadowValidationService({
        archives,
        runs: loaded.runs,
        ...(this.options.clock ? { clock: this.options.clock } : {}),
      }).generate();
    } finally {
      loaded.close();
    }
  }
}
