import {
  parseShadowEntryArgs,
  validateShadowEntryConfig,
} from "../shadow-entry/ShadowEntryConfig.js";
import {
  formatShadowEntryJson,
  formatShadowEntryReport,
} from "../shadow-entry/ShadowEntryReportFormatter.js";
import { ShadowEntryReportService } from "../shadow-entry/ShadowEntryReportService.js";
import { loadShadowEntryRuns } from "../shadow-entry/ShadowEntryCandidateLoader.js";
import { loadAppConfig } from "../config/env.js";

async function runShadowEntryReport(): Promise<void> {
  const shadowEntryConfig = validateShadowEntryConfig(parseShadowEntryArgs(process.argv.slice(2)));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Shadow entries only run in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const loadedRuns = loadShadowEntryRuns(shadowEntryConfig);

  try {
    const report = new ShadowEntryReportService({
      config: shadowEntryConfig,
      runs: loadedRuns.runs,
      candidates: loadedRuns.candidates,
    }).generate();

    if (!shadowEntryConfig.json) {
      console.log(`MODE: ${appConfig.mode}`);
      console.log(`Shadow entries once: ${shadowEntryConfig.once ? "yes" : "default one-shot"}`);
      console.log(`Session: ${shadowEntryConfig.sessionId ?? "latest PAPER session"}`);
      console.log(
        `Datasets: ${
          shadowEntryConfig.dbSources.length > 0
            ? shadowEntryConfig.dbSources.map((source) => source.label).join(", ")
            : "active"
        }`,
      );
      console.log(`Profiles: ${shadowEntryConfig.profileIds.join(",")}`);
      console.log(`Entry timings: ${shadowEntryConfig.entryTimingModes.join(",")}`);
      console.log(`Early drawdown modes: ${shadowEntryConfig.earlyDrawdownModes.join(",")}`);
      console.log("Database writes: disabled");
      console.log("Paper execution: disabled");
      console.log("Wallet loaded: no");
      console.log("Transaction signing: disabled");
      console.log("Transaction submission: disabled");
      console.log("");
    }

    console.log(
      shadowEntryConfig.json ? formatShadowEntryJson(report) : formatShadowEntryReport(report),
    );
  } finally {
    loadedRuns.close();
  }
}

runShadowEntryReport().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown shadow entries report failure.";
  console.error(message);
  process.exitCode = 1;
});
