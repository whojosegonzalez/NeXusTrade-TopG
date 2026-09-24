export const researchBriefErrorCodes = [
  "RESEARCH_BRIEF_INVALID_SCOPE",
  "RESEARCH_BRIEF_AMBIGUOUS_REPORT",
  "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
  "RESEARCH_BRIEF_SOURCE_INCONSISTENCY",
] as const;

export type ResearchBriefErrorCode = (typeof researchBriefErrorCodes)[number];

export class ResearchBriefError extends Error {
  constructor(
    readonly code: ResearchBriefErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchBriefError";
  }
}

export function formatResearchBriefError(error: unknown): string {
  if (error instanceof ResearchBriefError) return `${error.code}: ${error.message}`;
  return "RESEARCH_BRIEF_UNSUPPORTED_REPORT: Research brief failed closed on an unknown error.";
}
