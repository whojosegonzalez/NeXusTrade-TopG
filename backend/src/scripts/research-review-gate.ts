import { formatResearchReviewGateError } from "../research-review-gate/ResearchReviewGateErrors.js";
import { runResearchReviewGateCli } from "../research-review-gate/ResearchReviewGateCli.js";

try {
  runResearchReviewGateCli(process.argv.slice(2), (output) => process.stdout.write(output));
} catch (error: unknown) {
  process.stderr.write(`${formatResearchReviewGateError(error)}\n`);
  process.exitCode = 1;
}
