import { FormulationBAnalysisError } from "./FormulationBAnalysisErrors.js";
import { formatFormulationBAnalysisReport } from "./FormulationBAnalysisFormatter.js";
import { loadFormulationBArchive } from "./FormulationBArchiveLoader.js";
import { analyzeFormulationBArchive } from "./FormulationBAnalysisService.js";
import type { FormulationBAnalysisFormat } from "./FormulationBAnalysisTypes.js";

export interface FormulationBCliOptions {
  readonly archiveRoot: string;
  readonly format: FormulationBAnalysisFormat;
}

export function parseFormulationBArgs(args: readonly string[]): FormulationBCliOptions {
  let archiveRoot: string | null = null;
  let format: FormulationBAnalysisFormat = "markdown";

  for (const arg of args) {
    if (arg === "--once") {
      continue;
    }
    if (arg.startsWith("--archive-root=")) {
      if (archiveRoot !== null) {
        throw new FormulationBAnalysisError(
          "FORMULATION_B_INVALID_SCOPE",
          "Multiple --archive-root options provided",
        );
      }
      const val = arg.substring("--archive-root=".length).trim();
      if (!val) {
        throw new FormulationBAnalysisError(
          "FORMULATION_B_INVALID_SCOPE",
          "Empty --archive-root provided",
        );
      }
      if (
        val.includes("..") ||
        val.includes("*") ||
        val.includes("?") ||
        val.includes("<") ||
        val.includes(">") ||
        val.includes("|")
      ) {
        throw new FormulationBAnalysisError(
          "FORMULATION_B_INVALID_SCOPE",
          `Disallowed path shape in --archive-root: ${val}`,
        );
      }
      archiveRoot = val;
    } else if (arg.startsWith("--format=")) {
      const val = arg.substring("--format=".length).trim();
      if (val === "markdown" || val === "json") {
        format = val;
      } else {
        throw new FormulationBAnalysisError(
          "FORMULATION_B_INVALID_SCOPE",
          `Unsupported --format: ${val}`,
        );
      }
    } else {
      throw new FormulationBAnalysisError(
        "FORMULATION_B_INVALID_SCOPE",
        `Unrecognized argument: ${arg}`,
      );
    }
  }

  if (!archiveRoot) {
    throw new FormulationBAnalysisError(
      "FORMULATION_B_INVALID_SCOPE",
      "Missing required --archive-root argument",
    );
  }

  return {
    archiveRoot,
    format,
  };
}

export function runFormulationBAnalysisCli(
  args: readonly string[],
  outStream: (msg: string) => void = console.log,
  errStream: (msg: string) => void = console.error,
): number {
  try {
    const opts = parseFormulationBArgs(args);
    const loaded = loadFormulationBArchive(opts.archiveRoot);
    const report = analyzeFormulationBArchive(loaded);
    const output = formatFormulationBAnalysisReport(report, opts.format);
    outStream(output);
    return 0;
  } catch (err: unknown) {
    if (err instanceof FormulationBAnalysisError) {
      errStream(err.message);
    } else if (err instanceof Error) {
      errStream(`FORMULATION_B_UNEXPECTED_ERROR: ${err.message}`);
    } else {
      errStream(`FORMULATION_B_UNEXPECTED_ERROR: ${String(err)}`);
    }
    return 1;
  }
}
