import {
  parseResearchReviewGateArgs,
  type ResearchReviewGateConfig,
} from "./ResearchReviewGateConfig.js";
import {
  formatResearchReviewGateJson,
  formatResearchReviewGateMarkdown,
} from "./ResearchReviewGateFormatter.js";
import { ResearchReviewGateService } from "./ResearchReviewGateService.js";
import type { ResearchReviewGateV1 } from "./ResearchReviewGateTypes.js";

export function runResearchReviewGateCli(
  argv: readonly string[],
  write: (output: string) => void,
): ResearchReviewGateV1 {
  const config = parseResearchReviewGateArgs(argv);
  const gate = new ResearchReviewGateService({ config }).build();
  write(formatResearchReviewGate(gate, config));
  return gate;
}

export function formatResearchReviewGate(
  gate: ResearchReviewGateV1,
  config: ResearchReviewGateConfig,
): string {
  return config.format === "json"
    ? formatResearchReviewGateJson(gate)
    : formatResearchReviewGateMarkdown(gate);
}
