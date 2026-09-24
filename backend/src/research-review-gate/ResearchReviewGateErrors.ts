export const researchReviewGateErrorCodes = [
  "RESEARCH_REVIEW_INVALID_SCOPE",
  "RESEARCH_REVIEW_INVALID_RECORD",
  "RESEARCH_REVIEW_UNSUPPORTED_EVIDENCE",
  "RESEARCH_REVIEW_SOURCE_INCONSISTENCY",
] as const;

export type ResearchReviewGateErrorCode = (typeof researchReviewGateErrorCodes)[number];

export class ResearchReviewGateError extends Error {
  constructor(
    readonly code: ResearchReviewGateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchReviewGateError";
  }
}

export function formatResearchReviewGateError(error: unknown): string {
  if (error instanceof ResearchReviewGateError) return `${error.code}: ${error.message}`;
  return "RESEARCH_REVIEW_UNSUPPORTED_EVIDENCE: Research review gate failed closed on an unknown error.";
}
