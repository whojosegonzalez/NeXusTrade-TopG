import {
  parseExploratoryCohortAnalysisArgs,
  resolveExploratoryCohortAnalysisArchive,
} from "./ExploratoryCohortAnalysisConfig.js";
import {
  formatExploratoryCohortAnalysisJson,
  formatExploratoryCohortAnalysisMarkdown,
} from "./ExploratoryCohortAnalysisFormatter.js";
import { getExploratoryCohortAnalysisRepoRoot } from "./ExploratoryCohortAnalysisPaths.js";
import { ExploratoryCohortAnalysisService } from "./ExploratoryCohortAnalysisService.js";
import type { ExploratoryCohortAnalysisV1 } from "./ExploratoryCohortAnalysisTypes.js";

export function runExploratoryCohortAnalysisCli(
  argv: readonly string[],
  write: (output: string) => void,
): ExploratoryCohortAnalysisV1 {
  const config = parseExploratoryCohortAnalysisArgs(argv);
  const repoRoot = getExploratoryCohortAnalysisRepoRoot();
  const archiveRoot = resolveExploratoryCohortAnalysisArchive(config, repoRoot);
  const analysis = new ExploratoryCohortAnalysisService().build(archiveRoot, repoRoot);
  write(
    config.format === "json"
      ? formatExploratoryCohortAnalysisJson(analysis)
      : formatExploratoryCohortAnalysisMarkdown(analysis),
  );
  return analysis;
}
