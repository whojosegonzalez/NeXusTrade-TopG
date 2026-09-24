import { loadAppConfig } from "../config/env.js";
import { parseResearchInterpretationArgs } from "../research-interpretation/ResearchInterpretationConfig.js";
import {
  formatResearchInterpretationJson,
  formatResearchInterpretationReport,
  writeResearchInterpretationArtifacts,
} from "../research-interpretation/ResearchInterpretationReportFormatter.js";
import { ResearchInterpretationRunner } from "../research-interpretation/ResearchInterpretationRunner.js";

async function runResearchInterpretation(): Promise<void> {
  const researchConfig = parseResearchInterpretationArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(
      `Research interpretation only runs in PAPER mode. Current mode: ${appConfig.mode}.`,
    );
  }

  const report = new ResearchInterpretationRunner({
    config: researchConfig,
  }).run();

  if (researchConfig.outputDir) {
    writeResearchInterpretationArtifacts({
      report,
      outputDir: researchConfig.outputDir,
    });
  }

  if (!researchConfig.json) {
    console.log(`MODE: ${appConfig.mode}`);
    console.log(
      `Research interpretation once: ${researchConfig.once ? "yes" : "default one-shot"}`,
    );
    console.log(
      `Runs: ${researchConfig.runSources.map((source) => source.label).join(", ") || "none"}`,
    );
    console.log(`Dedupe mode: ${researchConfig.dedupeMode}`);
    console.log("Database writes: disabled");
    console.log("Paper execution: disabled");
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");
  }

  console.log(
    researchConfig.json
      ? formatResearchInterpretationJson(report)
      : formatResearchInterpretationReport(report),
  );
}

runResearchInterpretation().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown research interpretation failure.";
  console.error(message);
  process.exitCode = 1;
});
