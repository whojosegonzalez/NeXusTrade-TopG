import { runFormulationBCollectionCli } from "../research-formulation-b-collection/FormulationBCollectionCli.js";

const exitCode = await runFormulationBCollectionCli(process.argv.slice(2));
if (exitCode !== 0) {
  process.exit(exitCode);
}
