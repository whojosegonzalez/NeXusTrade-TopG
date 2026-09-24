import { loadAppConfig } from "../config/env.js";
import {
  formatShadowThresholdJson,
  formatShadowThresholdReport,
  writeShadowThresholdArtifacts,
} from "../shadow-threshold/ShadowThresholdReportFormatter.js";
import { ShadowThresholdRunner } from "../shadow-threshold/ShadowThresholdRunner.js";
import { parseShadowThresholdArgs } from "../shadow-threshold/ShadowThresholdConfig.js";

const config = parseShadowThresholdArgs(process.argv.slice(2));
const appConfig = loadAppConfig();

if (appConfig.mode !== "PAPER") {
  throw new Error("Narrow threshold validation requires MODE=PAPER.");
}

const report = new ShadowThresholdRunner({ config }).run();
const artifactPaths = config.outputDir
  ? writeShadowThresholdArtifacts({ report, outputDir: config.outputDir })
  : [];

if (config.json) {
  console.log(formatShadowThresholdJson(report));
} else {
  console.log(formatShadowThresholdReport(report));
}

if (artifactPaths.length > 0) {
  console.log("\nOutput files:");
  artifactPaths.forEach((artifactPath) => console.log(`  ${artifactPath}`));
}
