import { parseFormulationBCollectionArgs } from "./FormulationBCollectionConfig.js";
import { FormulationBCollectionError } from "./FormulationBCollectionErrors.js";
import { FormulationBCollectionRunner } from "./FormulationBCollectionRunner.js";
import { FormulationBHttpProviderClient } from "./FormulationBHttpProviderClient.js";
import type { FormulationBProviderClient } from "./FormulationBCollectionTypes.js";

export async function runFormulationBCollectionCli(
  args: readonly string[],
  providerClient?: FormulationBProviderClient,
  outStream: (msg: string) => void = console.log,
  errStream: (msg: string) => void = console.error,
): Promise<number> {
  try {
    const config = parseFormulationBCollectionArgs(args);

    const client =
      providerClient ??
      new FormulationBHttpProviderClient({
        timeoutMs: config.requestTimeoutMs,
        rateLimitMs: config.rateLimitMs,
      });

    const runner = new FormulationBCollectionRunner(config, client);
    const result = await runner.run();

    outStream(
      JSON.stringify(
        {
          status: "SUCCESS",
          finalOutcome: result.finalOutcome,
          validUnits: result.validUnits,
          attemptedSlots: result.attemptedSlots,
          archiveRoot: result.archiveRoot,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (err: unknown) {
    if (err instanceof FormulationBCollectionError) {
      errStream(`[${err.code}] ${err.message}`);
    } else if (err instanceof Error) {
      errStream(`[FORMULATION_B_UNEXPECTED_ERROR] ${err.message}`);
    } else {
      errStream(`[FORMULATION_B_UNEXPECTED_ERROR] ${String(err)}`);
    }
    return 1;
  }
}
