import path from "node:path";
import { fileURLToPath } from "node:url";

const researchBriefDirectory = path.dirname(fileURLToPath(import.meta.url));

export function getResearchBriefRepoRoot(): string {
  return path.resolve(researchBriefDirectory, "..", "..", "..");
}
