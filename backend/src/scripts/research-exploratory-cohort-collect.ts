import { runExploratoryCohortCli } from "../research-exploratory-cohort/ExploratoryCohortCli.js";
import { formatExploratoryCohortError } from "../research-exploratory-cohort/ExploratoryCohortErrors.js";

runExploratoryCohortCli(process.argv.slice(2), (output) => process.stdout.write(output)).catch(
  (error: unknown) => {
    process.stderr.write(`${formatExploratoryCohortError(error)}\n`);
    process.exitCode = 1;
  },
);
