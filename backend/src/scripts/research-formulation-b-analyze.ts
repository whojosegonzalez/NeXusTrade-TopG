import { runFormulationBAnalysisCli } from "../research-formulation-b-analysis/FormulationBAnalysisCli.js";

const exitCode = runFormulationBAnalysisCli(process.argv.slice(2));
if (exitCode !== 0) {
  process.exit(exitCode);
}
