import type { PositionRecord, SessionRecord } from "../db/schema/index.js";
import { isPositiveDecimal } from "./PaperMath.js";

export type PaperSellRejectionCode =
  | "MISSING_SELL_PRICE"
  | "POSITION_NOT_FOUND"
  | "POSITION_ALREADY_CLOSED"
  | "POSITION_NOT_OPEN"
  | "INVALID_POSITION_SIZE"
  | "MISSING_COST_BASIS"
  | "INSUFFICIENT_LIQUIDITY"
  | "QUOTE_UNAVAILABLE"
  | "INVALID_SESSION"
  | "SESSION_NOT_RUNNING"
  | "SESSION_NOT_PAPER"
  | "AMBIGUOUS_MINT_POSITION"
  | "MISSING_EXPLICIT_TRIGGER"
  | "STALE_PRICE"
  | "MISSING_DECIMALS";

export interface PaperSellValidationRejection {
  readonly code: PaperSellRejectionCode;
  readonly message: string;
  readonly context?: unknown;
}

export class PaperSellValidationService {
  validateSession(session: SessionRecord): PaperSellValidationRejection | undefined {
    if (session.mode !== "PAPER") {
      return {
        code: "SESSION_NOT_PAPER",
        message: `Paper sell requires a PAPER session. Session ${session.id} is ${session.mode}.`,
      };
    }

    if (session.status !== "RUNNING") {
      return {
        code: "SESSION_NOT_RUNNING",
        message: `Paper sell requires a RUNNING session. Session ${session.id} is ${session.status}.`,
      };
    }

    return undefined;
  }

  validatePosition(position: PositionRecord): PaperSellValidationRejection | undefined {
    if (position.status === "CLOSED") {
      return {
        code: "POSITION_ALREADY_CLOSED",
        message: `Position is already closed: ${position.id}.`,
      };
    }

    if (position.status !== "OPEN") {
      return {
        code: "POSITION_NOT_OPEN",
        message: `Position ${position.id} is ${position.status}, not OPEN.`,
      };
    }

    if (!isPositiveDecimal(position.tokensHeld)) {
      return {
        code: "INVALID_POSITION_SIZE",
        message: `Position ${position.id} has invalid tokensHeld.`,
        context: {
          tokensHeld: position.tokensHeld,
        },
      };
    }

    if (position.costBasisLamports <= 0) {
      return {
        code: "MISSING_COST_BASIS",
        message: `Position ${position.id} has invalid cost basis.`,
        context: {
          costBasisLamports: position.costBasisLamports,
        },
      };
    }

    return undefined;
  }
}
