import {
  parseShadowCalibrationArgs,
  validateShadowCalibrationConfig,
} from "../shadow-calibration/ShadowCalibrationConfig.js";
import {
  formatShadowCalibrationJson,
  formatShadowCalibrationReport,
} from "../shadow-calibration/ShadowCalibrationReportFormatter.js";
import { ShadowCalibrationReportService } from "../shadow-calibration/ShadowCalibrationReportService.js";
import { loadShadowCalibrationRuns } from "../shadow-calibration/ShadowRunLoader.js";
import { loadAppConfig } from "../config/env.js";

async function runShadowCalibrationReport(): Promise<void> {
  const shadowCalibrationConfig = validateShadowCalibrationConfig(
    parseShadowCalibrationArgs(process.argv.slice(2)),
  );
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Shadow calibration only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const loadedRuns = loadShadowCalibrationRuns(shadowCalibrationConfig);

  try {
    const report = new ShadowCalibrationReportService({
      config: shadowCalibrationConfig,
      runs: loadedRuns.runs,
    }).generate();

    if (!shadowCalibrationConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log(
        `Shadow calibration once: ${shadowCalibrationConfig.once ? "yes" : "default one-shot"}`,
      );
      console.log(`Session: ${shadowCalibrationConfig.sessionId ?? "latest PAPER session"}`);
      console.log(
        `Datasets: ${
          shadowCalibrationConfig.dbSources.length > 0
            ? shadowCalibrationConfig.dbSources.map((source) => source.label).join(", ")
            : "active"
        }`,
      );
      console.log(`Targets pct: ${shadowCalibrationConfig.targetPcts.join(",")}`);
      console.log(`Stops pct: ${shadowCalibrationConfig.stopPcts.join(",")}`);
      console.log(`Max holds minutes: ${shadowCalibrationConfig.maxHoldMinutes.join(",")}`);
      console.log(`Source decisions: ${shadowCalibrationConfig.sourceDecisions.join(",")}`);
      console.log(`Minimum score: ${shadowCalibrationConfig.minScore}`);
      console.log(`Dedupe mode: ${shadowCalibrationConfig.dedupeMode}`);
      console.log("Database writes: disabled");
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    console.log(
      shadowCalibrationConfig.json
        ? formatShadowCalibrationJson(report)
        : formatShadowCalibrationReport(report),
    );
  } finally {
    loadedRuns.close();
  }
}

runShadowCalibrationReport().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown shadow calibration report failure.";
  console.error(message);
  process.exitCode = 1;
});
