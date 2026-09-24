import { loadAppConfig } from "../config/env.js";
import { parseResearchTruthingArgs } from "../research-truthing/ResearchTruthingConfig.js";
import {
  formatResearchTruthingJson,
  formatResearchTruthingReport,
  writeResearchTruthingArtifacts,
} from "../research-truthing/ResearchTruthingReportFormatter.js";
import { ResearchTruthingRunner } from "../research-truthing/ResearchTruthingRunner.js";

async function runResearchTruthing(): Promise<void> {
  const researchConfig = parseResearchTruthingArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Research truthing only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const report = new ResearchTruthingRunner({
    config: researchConfig,
  }).run();

  if (researchConfig.outputDir) {
    writeResearchTruthingArtifacts({
      report,
      outputDir: researchConfig.outputDir,
    });
  }

  if (!researchConfig.json) {
    console.log(`MODE: ${appConfig.mode}`);
    console.log(`Research truthing once: ${researchConfig.once ? "yes" : "default one-shot"}`);
    console.log(
      `Runs: ${researchConfig.runSources.map((source) => source.label).join(", ") || "none"}`,
    );
    console.log(`Dedupe mode: ${researchConfig.dedupeMode}`);
    console.log("Live provider calls: disabled");
    console.log("Database writes: disabled");
    console.log("Paper execution: disabled");
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");
  }

  console.log(
    researchConfig.json ? formatResearchTruthingJson(report) : formatResearchTruthingReport(report),
  );
}

runResearchTruthing().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown research truthing failure.";
  console.error(message);
  process.exitCode = 1;
});
