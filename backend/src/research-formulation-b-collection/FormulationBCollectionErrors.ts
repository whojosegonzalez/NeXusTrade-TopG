export type FormulationBCollectionErrorCode =
  | "FORMULATION_B_COLLECTION_INVALID_SCOPE"
  | "FORMULATION_B_CLOCK_DRIFT_STOP"
  | "FORMULATION_B_SCHEMA_INTEGRITY_STOP"
  | "FORMULATION_B_SECRET_LEAKAGE_STOP"
  | "FORMULATION_B_RATE_LIMIT_STOP"
  | "FORMULATION_B_CONSECUTIVE_ERROR_STOP"
  | "FORMULATION_B_LIQUIDITY_PROHIBITION_STOP"
  | "FORMULATION_B_BUDGET_EXCEEDED_STOP"
  | "FORMULATION_B_ABORTED";

export class FormulationBCollectionError extends Error {
  public readonly code: FormulationBCollectionErrorCode;
  public readonly detail?: string | undefined;

  constructor(code: FormulationBCollectionErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "FormulationBCollectionError";
    this.code = code;
    this.detail = detail;
  }
}
