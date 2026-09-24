import { loadResearchRunArchives } from "../research/ResearchRunArchiveLoader.js";
import { defaultShadowCalibrationConfig } from "../shadow-calibration/ShadowCalibrationConfig.js";
import { loadShadowCalibrationRuns } from "../shadow-calibration/ShadowRunLoader.js";
import type {
  ShadowThresholdRuntimeConfig,
  ShadowThresholdReport,
} from "./ShadowThresholdTypes.js";
import { ShadowThresholdAnalysisService } from "./ShadowThresholdAnalysisService.js";

export class ShadowThresholdRunner {
  constructor(
    private readonly options: {
      readonly config: ShadowThresholdRuntimeConfig;
      readonly clock?: () => number;
    },
  ) {}

  run(): ShadowThresholdReport {
    const archives = loadResearchRunArchives(this.options.config.runSources);
    const loaded = loadShadowCalibrationRuns({
      ...defaultShadowCalibrationConfig(),
      once: true,
      dbSources: archives.map((archive) => ({
        label: archive.label,
        path: archive.databasePath,
      })),
    });

    try {
      return new ShadowThresholdAnalysisService({
        archives,
        runs: loaded.runs,
        ...(this.options.clock ? { clock: this.options.clock } : {}),
      }).generate();
    } finally {
      loaded.close();
    }
  }
}
