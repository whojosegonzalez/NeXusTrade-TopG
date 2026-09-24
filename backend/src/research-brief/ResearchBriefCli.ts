import { type ResearchBriefFormat, parseResearchBriefArgs } from "./ResearchBriefConfig.js";
import { formatResearchBriefJson, formatResearchBriefMarkdown } from "./ResearchBriefFormatter.js";
import { ResearchBriefService } from "./ResearchBriefService.js";
import type { ResearchBriefV1 } from "./ResearchBriefTypes.js";

export function runResearchBriefCli(
  argv: readonly string[],
  write: (output: string) => void,
): ResearchBriefV1 {
  const config = parseResearchBriefArgs(argv);
  const brief = new ResearchBriefService({ config }).build();
  write(formatResearchBrief(brief, config.format));
  return brief;
}

export function formatResearchBrief(brief: ResearchBriefV1, format: ResearchBriefFormat): string {
  return format === "json" ? formatResearchBriefJson(brief) : formatResearchBriefMarkdown(brief);
}
