import { loadAppConfig } from "../config/env.js";
import { parseFastShadowValidationArgs } from "../shadow-fast/FastShadowValidationConfig.js";
import {
  formatFastShadowValidationJson,
  formatFastShadowValidationReport,
  writeFastShadowValidationArtifacts,
} from "../shadow-fast/FastShadowValidationFormatter.js";
import { FastShadowValidationRunner } from "../shadow-fast/FastShadowValidationRunner.js";

const config = parseFastShadowValidationArgs(process.argv.slice(2));
const appConfig = loadAppConfig();
if (appConfig.mode !== "PAPER") {
  throw new Error("Fast exit validation requires MODE=PAPER.");
}
const report = new FastShadowValidationRunner({ config }).run();
const files = config.outputDir
  ? writeFastShadowValidationArtifacts({ report, outputDir: config.outputDir })
  : [];
console.log(
  config.json ? formatFastShadowValidationJson(report) : formatFastShadowValidationReport(report),
);
if (files.length) {
  console.log("\nOutput files:");
  files.forEach((file) => console.log(`  ${file}`));
}
