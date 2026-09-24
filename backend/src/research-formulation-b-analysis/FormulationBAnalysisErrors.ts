export type FormulationBErrorCode =
  | "FORMULATION_B_INVALID_SCOPE"
  | "FORMULATION_B_UNSUPPORTED_ARCHIVE"
  | "FORMULATION_B_SOURCE_INCONSISTENCY"
  | "FORMULATION_B_ARCHIVE_NOT_FINAL";

export class FormulationBAnalysisError extends Error {
  public readonly code: FormulationBErrorCode;
  public readonly detail?: string | undefined;

  constructor(code: FormulationBErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "FormulationBAnalysisError";
    this.code = code;
    this.detail = detail;
  }
}
