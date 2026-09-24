import { formatResearchBriefError } from "../research-brief/ResearchBriefErrors.js";
import { runResearchBriefCli } from "../research-brief/ResearchBriefCli.js";

try {
  runResearchBriefCli(process.argv.slice(2), (output) => process.stdout.write(output));
} catch (error: unknown) {
  process.stderr.write(`${formatResearchBriefError(error)}\n`);
  process.exitCode = 1;
}
