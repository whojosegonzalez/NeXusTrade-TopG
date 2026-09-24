import { loadAppConfig } from "../config/env.js";
import { parseCounterfactualArgs } from "../research-counterfactual/CounterfactualConfig.js";
import {
  formatCounterfactualJson,
  formatCounterfactualReport,
  writeCounterfactualArtifacts,
} from "../research-counterfactual/CounterfactualReportFormatter.js";
import { CounterfactualRunner } from "../research-counterfactual/CounterfactualRunner.js";

function run(): void {
  const config = parseCounterfactualArgs(process.argv.slice(2));
  const appConfig = loadAppConfig();

  if (appConfig.mode !== "PAPER") {
    throw new Error(
      `Counterfactual research only runs in PAPER mode. Current mode: ${appConfig.mode}.`,
    );
  }

  const report = new CounterfactualRunner({ config }).run();

  if (config.outputDir) {
    writeCounterfactualArtifacts({ report, outputDir: config.outputDir });
  }

  if (!config.json) {
    console.log(`MODE: ${appConfig.mode}`);
    console.log(`Counterfactual research once: ${config.once ? "yes" : "default one-shot"}`);
    console.log(`Runs: ${config.runSources.map((source) => source.label).join(", ")}`);
    console.log("Provider calls: disabled");
    console.log("Database writes: disabled");
    console.log("Session creation: disabled");
    console.log("Paper execution: disabled");
    console.log("Wallet loaded: no");
    console.log("Transaction signing: disabled");
    console.log("Transaction submission: disabled");
    console.log("");
  }

  console.log(config.json ? formatCounterfactualJson(report) : formatCounterfactualReport(report));
}

try {
  run();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Unknown counterfactual research failure.",
  );
  process.exitCode = 1;
}
