import { formatResearchProtocolError } from "../research-protocol/ResearchProtocolErrors.js";
import { runResearchProtocolCli } from "../research-protocol/ResearchProtocolCli.js";

try {
  runResearchProtocolCli(process.argv.slice(2), (output) => process.stdout.write(output));
} catch (error: unknown) {
  process.stderr.write(`${formatResearchProtocolError(error)}\n`);
  process.exitCode = 1;
}
