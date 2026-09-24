import path from "node:path";
import { fileURLToPath } from "node:url";

const researchProtocolDirectory = path.dirname(fileURLToPath(import.meta.url));

export function getResearchProtocolRepoRoot(): string {
  return path.resolve(researchProtocolDirectory, "..", "..", "..");
}
