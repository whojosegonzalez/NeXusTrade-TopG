import { createSystemExploratoryCohortClock } from "./ExploratoryCohortClock.js";
import { parseExploratoryCohortArgs } from "./ExploratoryCohortConfig.js";
import { createDirectExploratoryCohortGateway } from "./DirectExploratoryCohortGateway.js";
import { ExploratoryCohortRunner } from "./ExploratoryCohortRunner.js";
import type { CollectionResult } from "./ExploratoryCohortTypes.js";

export async function runExploratoryCohortCli(
  argv: readonly string[],
  write: (output: string) => void,
): Promise<CollectionResult> {
  const config = parseExploratoryCohortArgs(argv);
  const result = await new ExploratoryCohortRunner({
    config,
    ...(config.mode === "COLLECT_SLOT" ? { gateway: createDirectExploratoryCohortGateway() } : {}),
    clock: createSystemExploratoryCohortClock(),
  }).run();
  write(formatCollectionResult(result, config.format));
  return result;
}

export function formatCollectionResult(
  result: CollectionResult,
  format: "markdown" | "json",
): string {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  return [
    "# Exploratory Cohort Collection",
    "",
    `- Outcome: ${result.outcome}`,
    `- Archive root: ${result.archiveRoot}`,
    `- Invocation mode: ${result.mode}`,
    `- Valid units: ${result.validUnitCount}`,
    `- Provider calls (archive total): ${result.providerCalls}`,
    `- Provider calls (this invocation): ${result.invocationProviderCalls}`,
    `- Database reads/writes: ${result.databaseReads}/${result.databaseWrites}`,
    `- Runtime calls: ${result.runtimeCalls}`,
    "",
    result.nextPermittedAction,
    "",
  ].join("\n");
}
