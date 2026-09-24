import { loadAppConfig } from "../config/env.js";
import { parseFastEntryAttributionArgs } from "../shadow-fast-attribution/FastEntryAttributionConfig.js";
import {
  formatFastEntryAttributionJson,
  formatFastEntryAttributionReport,
  writeFastEntryAttributionArtifacts,
} from "../shadow-fast-attribution/FastEntryAttributionFormatter.js";
import { FastEntryAttributionRunner } from "../shadow-fast-attribution/FastEntryAttributionRunner.js";

const config = parseFastEntryAttributionArgs(process.argv.slice(2));
const appConfig = loadAppConfig();
if (appConfig.mode !== "PAPER") {
  throw new Error("Fast-entry attribution requires MODE=PAPER.");
}

const report = new FastEntryAttributionRunner({ config }).run();
const files = config.outputDir
  ? writeFastEntryAttributionArtifacts({ report, outputDir: config.outputDir })
  : [];
console.log(
  config.json ? formatFastEntryAttributionJson(report) : formatFastEntryAttributionReport(report),
);
if (files.length > 0) {
  console.log("\nOutput files:");
  files.forEach((file) => console.log(`  ${file}`));
}
