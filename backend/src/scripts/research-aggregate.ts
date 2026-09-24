import { loadAppConfig } from "../config/env.js";
import { parseResearchAggregateArgs } from "../research/ResearchAggregateConfig.js";
import {
  formatResearchAggregateJson,
  formatResearchAggregateReport,
  writeResearchAggregateArtifacts,
} from "../research/ResearchAggregateReportFormatter.js";
import { ResearchAggregateRunner } from "../research/ResearchAggregateRunner.js";

async function runResearchAggregate(): Promise<void> {
  const researchConfig = parseResearchAggregateArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(`Research aggregate only runs in PAPER mode. Current mode: ${appConfig.mode}.`);
  }

  const report = new ResearchAggregateRunner({
    config: researchConfig,
  }).run();

  if (researchConfig.outputDir) {
    writeResearchAggregateArtifacts({
      report,
      outputDir: researchConfig.outputDir,
    });
  }

  if (!researchConfig.json) {
    console.log(`MODE: ${appConfig.mode}`);
    console.log(`Research aggregate once: ${researchConfig.once ? "yes" : "default one-shot"}`);
    console.log(
      `Runs: ${researchConfig.runSources.map((source) => source.label).join(", ") || "none"}`,
    );
    console.log(`Targets pct: ${researchConfig.targetPcts.join(",")}`);
    console.log(`Stops pct: ${researchConfig.stopPcts.join(",")}`);
    console.log(`Max holds minutes: ${researchConfig.maxHoldMinutes.join(",")}`);
    console.log("Database writes: disabled");
    console.log("Paper execution: disabled");
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");
  }

  console.log(
    researchConfig.json
      ? formatResearchAggregateJson(report)
      : formatResearchAggregateReport(report),
  );
}

runResearchAggregate().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown research aggregate failure.";
  console.error(message);
  process.exitCode = 1;
});
