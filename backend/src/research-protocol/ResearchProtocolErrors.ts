export const researchProtocolErrorCodes = [
  "RESEARCH_PROTOCOL_INVALID_SCOPE",
  "RESEARCH_PROTOCOL_INVALID_RECORD",
  "RESEARCH_PROTOCOL_SOURCE_INCONSISTENCY",
] as const;

export type ResearchProtocolErrorCode = (typeof researchProtocolErrorCodes)[number];

export class ResearchProtocolError extends Error {
  constructor(
    readonly code: ResearchProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchProtocolError";
  }
}

export function formatResearchProtocolError(error: unknown): string {
  if (error instanceof ResearchProtocolError) return `${error.code}: ${error.message}`;
  return "RESEARCH_PROTOCOL_INVALID_RECORD: Research protocol validation failed closed.";
}
