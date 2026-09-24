import type {
  ResearchTruthingDedupeMode,
  ResearchTruthingLimitMetadata,
} from "./ResearchTruthingTypes.js";

export class ReportLimitTruthService {
  create(input: {
    readonly sectionName: string;
    readonly rowsAvailable: number;
    readonly rowsEvaluated: number;
    readonly rowsDisplayed: number;
    readonly displayLimit: number;
    readonly dedupeMode: ResearchTruthingDedupeMode;
  }): ResearchTruthingLimitMetadata {
    const omittedDisplayRows = Math.max(0, input.rowsAvailable - input.rowsDisplayed);

    return {
      sectionName: input.sectionName,
      rowsAvailable: input.rowsAvailable,
      rowsEvaluated: input.rowsEvaluated,
      rowsDisplayed: input.rowsDisplayed,
      displayLimit: input.displayLimit,
      displayTruncated: omittedDisplayRows > 0,
      omittedDisplayRows,
      dedupeMode: input.dedupeMode,
    };
  }
}
