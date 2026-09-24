import path from "node:path";
import { fileURLToPath } from "node:url";

const analysisDirectory = path.dirname(fileURLToPath(import.meta.url));

export function getExploratoryCohortAnalysisRepoRoot(): string {
  return path.resolve(analysisDirectory, "..", "..", "..");
}
