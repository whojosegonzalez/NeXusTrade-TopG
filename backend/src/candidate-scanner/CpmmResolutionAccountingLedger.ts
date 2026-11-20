/**
 * CPMM resolution accounting ledger (assessment §8.38.17 item 13). Isolated and unwired.
 *
 * Turns CPMM resolution facts and ingestion results into explicit per-signature and
 * per-occurrence accounting, so that no notification given to the ledger can disappear.
 *
 * - The ledger calls only `adapter.getBinding` (at construction), `adapter.resolve` and
 *   `adapter.ingest`. It has no session reference, transport, timer, clock, abort controller,
 *   budget, queue or retry. It never stops the session, aborts a request or stops intake, and it
 *   writes nothing to the tracker except through `adapter.ingest`.
 * - Only fully ingested, replayable, bound target swaps count (`INGESTED`). Everything else stays
 *   visible and blocks. No-target-swap and failed-transaction outcomes stay policy-pending.
 * - It never establishes notification completeness, a quiet window or qualification.
 */
import { isValidSolanaSignature } from "./ExactPoolHistoryEnumerator.js";
import {
  RaydiumCpmmTransactionSourceAdapter,
  type CpmmAdapterBinding,
  type CpmmIngestionResult,
  type CpmmLifecycleGate,
  type CpmmResolutionFact,
} from "./RaydiumCpmmTransactionSourceAdapter.js";
import { MAX_BLOCK_TIME_SEC } from "./RaydiumCpmmSwapDecoder.js";
import type { RollingTradeFlowTracker, TradeEvent } from "./RollingTradeFlowTracker.js";

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

/** All injected positive safe integers. There are no defaults and no live values. */
export interface CpmmLedgerLimits {
  /** Unique signatures, PENDING included. */
  readonly maxSignatureRecords: number;
  /** Retained duplicate details per record; counts and aggregates stay exact. */
  readonly maxDuplicateDetailsPerRecord: number;
  /** Retained epoch metadata. */
  readonly maxEpochs: number;
}

export interface CpmmObservationEpoch {
  /** Safe integer >= 0, strictly increasing. */
  readonly epoch: number;
  /** HOST: when this epoch began observing (positive safe integer). */
  readonly observationStartMs: number;
}

/** Compact accounting input supplied by the owner. Not a cutoff proof. */
export interface CpmmAccountingCutoff {
  readonly slot: number;
  /** ON-CHAIN milliseconds. */
  readonly blockTimeMs: number;
  /** Asserted by the owner; not verified here. */
  readonly provenance: "ON_CHAIN_BLOCK_TIME" | "SYNTHETIC_FIXTURE";
}

export interface CpmmAccountingWindow {
  readonly epoch: number;
  /** ON-CHAIN milliseconds, inclusive. */
  readonly windowStartMs: number;
  /** ON-CHAIN milliseconds, exclusive. */
  readonly windowEndMs: number;
  readonly cutoff: CpmmAccountingCutoff;
  /** HOST: the owner's frozen receipt frontier for this window's decision input. */
  readonly receiptFrontierMs: number;
}

export interface CpmmNotificationEnvelope {
  /** Validated by the ledger, then again by the adapter. */
  readonly notification: unknown;
  /** The epoch the owner received it in. */
  readonly epoch: number;
  /** Must equal notification.receivedAtMs. */
  readonly hostReceivedAtMs: number;
}

export type CpmmAccountingDisposition =
  | "PENDING"
  | "INGESTED"
  | "INGESTION_INCOMPLETE"
  | "POLICY_PENDING"
  | "UNRESOLVED";

export type CpmmBlockingClass =
  // UNRESOLVED only
  | "TRANSACTION_UNAVAILABLE"
  | "RESPONSE_CONTRADICTED"
  | "DECODER_UNRESOLVED"
  | "EVIDENCE_UNVERIFIED"
  | "EVIDENCE_WITHHELD"
  | "CANCELLED"
  | "SESSION_ENDED"
  | "REQUEST_REFUSED"
  | "ADAPTER_CAPACITY_REFUSED"
  | "DUPLICATE_WITHOUT_ORIGINAL"
  | "VALIDATION_DISAGREEMENT"
  // INGESTION_INCOMPLETE only
  | "INGEST_STOPPED"
  | "INGEST_REJECTED"
  | "NOT_INGESTIBLE"
  // either
  | "EPOCH_CLOSED"
  | "BINDING_CONFLICT"
  | "ACCOUNTING_EXCEPTION"
  | "UNRECOGNIZED_OUTCOME";

export type CpmmPolicyPending =
  | "NO_TARGET_SWAP_POLICY_UNREVIEWED"
  | "FAILED_TRANSACTION_POLICY_UNREVIEWED";

export interface CpmmIngestionAccounting {
  readonly status: CpmmIngestionResult["status"] | "NOT_CALLED" | "EXCEPTION";
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly unattempted: number;
  /** After an exception or an unrecognised result; the four counts sum to total. */
  readonly indeterminate: number;
}

export interface CpmmDuplicateOccurrence {
  readonly occurrence: number;
  /** Receiving epoch. */
  readonly epoch: number;
  readonly hostReceivedAtMs: number;
  readonly notifiedSlot: number;
  readonly notifiedBlockTimeSec: number | null;
  /** Evaluated at receipt against the values known then (informational). */
  readonly agreement: "AGREES" | "SLOT_CONFLICT" | "BLOCK_TIME_CONFLICT";
  /** Informational; may be PENDING. */
  readonly firstDispositionAtReceipt: CpmmAccountingDisposition;
}

export interface CpmmSignatureAccountingRecord {
  readonly sequence: number;
  readonly signature: string;
  /** Receiving epoch of the first occurrence, for life. */
  readonly epoch: number;
  readonly hostReceivedAtMs: number;
  readonly notifiedSlot: number;
  readonly notifiedBlockTimeSec: number | null;
  readonly verifiedSlot: number | null;
  readonly verifiedBlockTimeSec: number | null;
  readonly disposition: CpmmAccountingDisposition;
  /** Null for PENDING, INGESTED and POLICY_PENDING. */
  readonly blockingClass: CpmmBlockingClass | null;
  readonly policyPending: CpmmPolicyPending | null;
  /** Verbatim fixed adapter kind and code; null while PENDING or after an exception. */
  readonly factKind: string | null;
  readonly factCode: string | null;
  readonly ingestion: CpmmIngestionAccounting;
  /**
   * True when any duplicate occurrence, in any epoch, claimed a slot or block time that differs
   * from this record's verified (otherwise notified) values, or from another claim. Derived from
   * bounded aggregates, never from the retained details; once true it stays true.
   */
  readonly metadataConflict: boolean;
  /** Exact. */
  readonly duplicateOccurrences: number;
  /** The first maxDuplicateDetailsPerRecord occurrences only. */
  readonly duplicateDetails: readonly CpmmDuplicateOccurrence[];
  readonly duplicateDetailsDropped: number;
}

export type CpmmInvalidCode =
  | "ENVELOPE_INVALID"
  | "GATE_INVALID"
  | "NOTIFICATION_INVALID"
  | "RECEIPT_TIME_DISAGREEMENT"
  | "RECEIPT_BEFORE_EPOCH_START"
  | "STALE_EPOCH"
  | "EPOCH_NOT_OPEN";

export const CPMM_INVALID_CODES: readonly CpmmInvalidCode[] = Object.freeze([
  "ENVELOPE_INVALID",
  "GATE_INVALID",
  "NOTIFICATION_INVALID",
  "RECEIPT_TIME_DISAGREEMENT",
  "RECEIPT_BEFORE_EPOCH_START",
  "STALE_EPOCH",
  "EPOCH_NOT_OPEN",
]);

export type CpmmAccountResult =
  | {
      /** First occurrence; the record is terminal. */
      readonly status: "RECORDED";
      readonly occurrence: number;
      readonly record: CpmmSignatureAccountingRecord;
    }
  | {
      /** No adapter call, request or ingestion. */
      readonly status: "DUPLICATE";
      readonly occurrence: number;
      readonly firstSequence: number;
      readonly detail: CpmmDuplicateOccurrence;
      readonly detailRetained: boolean;
    }
  | {
      /** No adapter call or request. */
      readonly status: "INVALID";
      readonly occurrence: number;
      /** Null when unattributed. */
      readonly epoch: number | null;
      readonly code: CpmmInvalidCode;
      /** NOTIFICATION_INVALID only: the adapter-identical fixed code. */
      readonly detail: string | null;
    }
  | {
      /** No adapter call or request. */
      readonly status: "CAPACITY_REFUSED";
      readonly occurrence: number;
      readonly epoch: number | null;
      readonly code: "RECORD_CAPACITY" | "EPOCH_CAPACITY";
    };

export type CpmmOpenEpochResult =
  | { readonly status: "OPENED"; readonly epoch: number }
  | {
      /** The previously open epoch is closed anyway (fail closed). */
      readonly status: "REFUSED";
      readonly code: "EPOCH_INVALID" | "EPOCH_NOT_INCREASING" | "EPOCH_CAPACITY";
    };

/** Exact counters that saturate at Number.MAX_SAFE_INTEGER; saturation is sticky and blocking. */
export interface CpmmLedgerCounters {
  /** Every account() call. */
  readonly occurrences: number;
  /** Epoch unreadable or not retained. */
  readonly unattributedOccurrences: number;
  readonly recordCapacityRefused: number;
  readonly epochCapacityRefused: number;
  readonly openEpochRefused: number;
  readonly saturated: boolean;
}

export interface CpmmEpochAccounting {
  readonly epoch: number;
  readonly observationStartMs: number;
  readonly state: "OPEN" | "CLOSED";
  /** firstOccurrences + duplicates.sameEpoch + duplicates.crossEpoch + Σ invalid + capacityRefused. */
  readonly occurrences: number;
  readonly firstOccurrences: number;
  readonly duplicates: { readonly sameEpoch: number; readonly crossEpoch: number };
  readonly invalid: Readonly<Record<CpmmInvalidCode, number>>;
  /** RECORD_CAPACITY attributed to this epoch. */
  readonly capacityRefused: number;
}

export interface CpmmAccountingGap {
  readonly epoch: number;
  readonly signature: string | null;
  /** Local observation uncertainty only; never a bound on on-chain time. */
  readonly timeBasis: "HOST_RECEIPT";
  /** The epoch's observationStartMs. */
  readonly startMs: number;
  /** The occurrence's receipt, or receiptFrontierMs for epoch-wide gaps. */
  readonly endMs: number;
  /** Fixed: `CPMM_${class or code}`. */
  readonly reason: string;
}

export interface CpmmWindowAccountingSummary {
  readonly binding: CpmmAdapterBinding;
  readonly window: CpmmAccountingWindow;
  readonly ledgerVersion: number;
  readonly epoch: CpmmEpochAccounting;
  readonly ledger: CpmmLedgerCounters;
  /** First records of this epoch placed in the window, or with unknown position. */
  readonly inWindow: Readonly<Record<CpmmAccountingDisposition, number>>;
  readonly inWindowByClass: Readonly<Partial<Record<CpmmBlockingClass, number>>>;
  readonly policyPending: { readonly noTargetSwap: number; readonly failedTransaction: number };
  /** From those first records only; references never add events again. */
  readonly events: Omit<CpmmIngestionAccounting, "status">;
  /** First records of this epoch with no verified time (counted in every window of the epoch). */
  readonly positionUnknown: number;
  /** First records of this epoch whose verified slot or time is after the cutoff (not blocking). */
  readonly afterCutoff: number;
  /**
   * Unit: distinct signatures. A signature counts once when its first record (if of this epoch)
   * or any duplicate occurrence received in this epoch is placed in the window (or has unknown
   * position) and was received after receiptFrontierMs. Exact for this unit, from each
   * (epoch, signature) aggregate's latest receipt, independent of retained details.
   */
  readonly lateInWindow: number;
  readonly crossEpochDuplicates: {
    readonly referencedIngested: number;
    readonly blocking: number;
  };
  readonly metadataConflicts: {
    /** Signatures referenced from this epoch whose claims conflict. */
    readonly references: number;
    /** Records of this epoch with a conflict from any epoch. */
    readonly records: number;
  };
  readonly otherEpochFirstRecords: number;
  readonly gaps: readonly CpmmAccountingGap[];
  readonly accountingComplete: boolean;
  readonly notificationCompletenessEstablished: false;
  readonly quietWindowEstablished: false;
  readonly qualificationEligible: false;
}

export type CpmmSummarizeResult =
  | { readonly status: "SUMMARY"; readonly summary: CpmmWindowAccountingSummary }
  | {
      readonly status: "WINDOW_INVALID";
      readonly code:
        | "WINDOW_SHAPE"
        | "WINDOW_BEYOND_CUTOFF"
        | "EPOCH_NOT_RETAINED"
        | "FRONTIER_BEFORE_EPOCH_START";
    };

export interface CpmmResolutionAccountingLedgerOptions {
  readonly binding: CpmmAdapterBinding;
  readonly adapter: RaydiumCpmmTransactionSourceAdapter;
  readonly tracker: RollingTradeFlowTracker;
  readonly limits: CpmmLedgerLimits;
}

/** Saturating increment: exact up to Number.MAX_SAFE_INTEGER, then stuck and flagged. */
export function cpmmSaturatingIncrement(value: number): {
  readonly value: number;
  readonly saturated: boolean;
} {
  return value >= Number.MAX_SAFE_INTEGER
    ? { value: Number.MAX_SAFE_INTEGER, saturated: true }
    : { value: value + 1, saturated: false };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const ZERO_INGESTION: CpmmIngestionAccounting = Object.freeze({
  status: "NOT_CALLED",
  total: 0,
  accepted: 0,
  rejected: 0,
  unattempted: 0,
  indeterminate: 0,
});

const DISPOSITIONS: readonly CpmmAccountingDisposition[] = [
  "PENDING",
  "INGESTED",
  "INGESTION_INCOMPLETE",
  "POLICY_PENDING",
  "UNRESOLVED",
];

const NOTIFICATION_KEYS = new Set(["signature", "slot", "receivedAtMs", "blockTime"]);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own string-keyed data properties into a null-prototype record (no accessors, no setters). */
function readDataRecord(v: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(v)) return null;
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== "string") return null;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d)) return null;
    Object.defineProperty(out, k, {
      value: d.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return out;
}

function exactKeys(r: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(r);
  return own.length === keys.length && keys.every((k) => hasOwn(r, k));
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isSafeNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isSafePositive = (v: unknown): v is number => isSafeNonNegative(v) && v >= 1;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

interface ValidNotification {
  readonly signature: string;
  readonly slot: number;
  readonly receivedAtMs: number;
  readonly blockTime?: number | null;
}

/** The adapter's notification rules and fixed codes, applied to a copy. */
function validateNotification(v: unknown): ValidNotification | string {
  let r: Record<string, unknown> | null;
  try {
    r = readDataRecord(v);
  } catch {
    return "NOTIFICATION_UNREADABLE";
  }
  if (!r) return "NOTIFICATION_NOT_PLAIN_DATA";
  for (const k of Object.keys(r)) if (!NOTIFICATION_KEYS.has(k)) return "UNKNOWN_KEY";
  if (!isValidSolanaSignature(r.signature)) return "SIGNATURE_INVALID";
  if (!isSafeNonNegative(r.slot)) return "SLOT_INVALID";
  if (!hasOwn(r, "receivedAtMs")) return "RECEIVED_AT_MISSING";
  if (!isSafePositive(r.receivedAtMs)) return "RECEIVED_AT_INVALID";
  const bt = r.blockTime;
  if (
    bt !== undefined &&
    bt !== null &&
    !(typeof bt === "number" && Number.isSafeInteger(bt) && bt > 0 && bt <= MAX_BLOCK_TIME_SEC)
  ) {
    return "BLOCK_TIME_INVALID";
  }
  return Object.freeze({
    signature: r.signature as string,
    slot: r.slot as number,
    receivedAtMs: r.receivedAtMs as number,
    ...(bt !== undefined ? { blockTime: bt as number | null } : {}),
  });
}

interface CallerGate {
  readonly signal?: AbortSignal;
  readonly refusal?: () => unknown;
}

/** The adapter's gate rules. */
function validateGate(gate: unknown): CallerGate | null {
  if (gate === undefined) return {};
  let r: Record<string, unknown> | null;
  try {
    r = readDataRecord(gate);
  } catch {
    return null;
  }
  if (!r) return null;
  for (const k of Object.keys(r)) if (k !== "signal" && k !== "refusal") return null;
  if (r.signal !== undefined && !(r.signal instanceof AbortSignal)) return null;
  if (r.refusal !== undefined && typeof r.refusal !== "function") return null;
  return {
    ...(r.signal !== undefined ? { signal: r.signal as AbortSignal } : {}),
    ...(r.refusal !== undefined ? { refusal: r.refusal as () => unknown } : {}),
  };
}

const notifiedBlockTime = (n: ValidNotification): number | null =>
  typeof n.blockTime === "number" ? n.blockTime : null;

// ---------------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------------

interface RecordState {
  readonly sequence: number;
  readonly signature: string;
  readonly epoch: number;
  readonly hostReceivedAtMs: number;
  readonly notifiedSlot: number;
  readonly notifiedBlockTimeSec: number | null;
  verifiedSlot: number | null;
  verifiedBlockTimeSec: number | null;
  disposition: CpmmAccountingDisposition;
  blockingClass: CpmmBlockingClass | null;
  policyPending: CpmmPolicyPending | null;
  factKind: string | null;
  factCode: string | null;
  ingestion: CpmmIngestionAccounting;
  duplicateOccurrences: number;
  readonly duplicateDetails: CpmmDuplicateOccurrence[];
}

/** Bounded per (receiving epoch, signature) aggregate of duplicate occurrences. */
interface ReferenceAggregate {
  occurrences: number;
  latestReceiptMs: number;
  minSlot: number;
  maxSlot: number;
  minBlockTime: number | null;
  maxBlockTime: number | null;
}

interface EpochState {
  readonly epoch: number;
  readonly observationStartMs: number;
  state: "OPEN" | "CLOSED";
  occurrences: number;
  firstOccurrences: number;
  sameEpoch: number;
  crossEpoch: number;
  readonly invalid: Record<CpmmInvalidCode, number>;
  capacityRefused: number;
  /** At most one entry per first record. */
  readonly references: Map<number, ReferenceAggregate>;
}

type Mapped = {
  disposition: Exclude<CpmmAccountingDisposition, "PENDING">;
  blockingClass: CpmmBlockingClass | null;
  policyPending: CpmmPolicyPending | null;
  ingestion: CpmmIngestionAccounting;
  verifiedSlot: number | null;
  verifiedBlockTimeSec: number | null;
};

const unresolved = (
  blockingClass: CpmmBlockingClass,
  ingestion: CpmmIngestionAccounting = ZERO_INGESTION,
): Mapped => ({
  disposition: "UNRESOLVED",
  blockingClass,
  policyPending: null,
  ingestion,
  verifiedSlot: null,
  verifiedBlockTimeSec: null,
});

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

export class CpmmResolutionAccountingLedger {
  private readonly binding: CpmmAdapterBinding;
  private readonly adapter: RaydiumCpmmTransactionSourceAdapter;
  private readonly tracker: RollingTradeFlowTracker;
  private readonly limits: CpmmLedgerLimits;

  private readonly recordList: RecordState[] = [];
  private readonly bySignature = new Map<string, RecordState>();
  private readonly epochMap = new Map<number, EpochState>();
  private openEpochNumber: number | null = null;
  private newestEpoch: number | null = null;
  private epochCapacityExhausted = false;

  private versionValue = 0;
  private occurrenceCount = 0;
  private unattributed = 0;
  private recordCapacityRefused = 0;
  private epochCapacityRefused = 0;
  private openEpochRefused = 0;
  private saturated = false;

  constructor(options: CpmmResolutionAccountingLedgerOptions) {
    const fail = (msg: string): never => {
      throw new Error(`[CPMM_LEDGER_INIT] ${msg}`);
    };
    const o = readDataRecord(options);
    if (!o) throw new Error("[CPMM_LEDGER_INIT] options must be a plain object of data");
    if (!exactKeys(o, ["binding", "adapter", "tracker", "limits"])) {
      fail("options must have exactly binding, adapter, tracker and limits");
    }
    if (!(o.adapter instanceof RaydiumCpmmTransactionSourceAdapter)) {
      fail("adapter must be a RaydiumCpmmTransactionSourceAdapter");
    }
    const adapter = o.adapter as RaydiumCpmmTransactionSourceAdapter;
    const b = readDataRecord(o.binding);
    if (
      !b ||
      !exactKeys(b, ["poolAddress", "candidateMint"]) ||
      typeof b.poolAddress !== "string" ||
      typeof b.candidateMint !== "string"
    ) {
      fail("binding must be exactly { poolAddress, candidateMint }");
    }
    const binding = Object.freeze({
      poolAddress: b!.poolAddress as string,
      candidateMint: b!.candidateMint as string,
    });
    const ab = adapter.getBinding();
    if (ab.poolAddress !== binding.poolAddress || ab.candidateMint !== binding.candidateMint) {
      fail("adapter binding disagrees with binding");
    }
    const tracker = o.tracker as RollingTradeFlowTracker;
    let trackerOk = false;
    try {
      trackerOk =
        typeof tracker?.getPoolId === "function" &&
        typeof tracker.getTokenMint === "function" &&
        typeof tracker.ingestTrade === "function" &&
        tracker.getPoolId() === binding.poolAddress &&
        tracker.getTokenMint() === binding.candidateMint;
    } catch {
      trackerOk = false;
    }
    if (!trackerOk) fail("tracker identity disagrees with binding");
    const l = readDataRecord(o.limits);
    if (!l || !exactKeys(l, ["maxSignatureRecords", "maxDuplicateDetailsPerRecord", "maxEpochs"])) {
      fail("limits must be exactly maxSignatureRecords, maxDuplicateDetailsPerRecord, maxEpochs");
    }
    for (const k of ["maxSignatureRecords", "maxDuplicateDetailsPerRecord", "maxEpochs"]) {
      if (!isSafePositive(l![k])) fail(`${k} must be a positive safe integer`);
    }
    this.binding = binding;
    this.adapter = adapter;
    this.tracker = tracker;
    this.limits = Object.freeze({
      maxSignatureRecords: l!.maxSignatureRecords as number,
      maxDuplicateDetailsPerRecord: l!.maxDuplicateDetailsPerRecord as number,
      maxEpochs: l!.maxEpochs as number,
    });
  }

  public get version(): number {
    return this.versionValue;
  }

  // --- counters -----------------------------------------------------------------------------------

  private inc(value: number): number {
    const r = cpmmSaturatingIncrement(value);
    if (r.saturated) this.saturated = true;
    return r.value;
  }

  private bumpVersion(): void {
    this.versionValue = this.inc(this.versionValue);
  }

  // --- epochs ---------------------------------------------------------------------------------------

  /** Synchronous and re-entrant safe. Any refusal closes the open epoch (fail closed). */
  public openEpoch(epoch: CpmmObservationEpoch): CpmmOpenEpochResult {
    this.bumpVersion();
    const previous =
      this.openEpochNumber === null ? undefined : this.epochMap.get(this.openEpochNumber);
    if (previous) previous.state = "CLOSED";
    this.openEpochNumber = null;
    const refuse = (
      code: "EPOCH_INVALID" | "EPOCH_NOT_INCREASING" | "EPOCH_CAPACITY",
    ): CpmmOpenEpochResult => {
      this.openEpochRefused = this.inc(this.openEpochRefused);
      return Object.freeze({ status: "REFUSED", code });
    };
    let r: Record<string, unknown> | null = null;
    try {
      r = readDataRecord(epoch);
    } catch {
      r = null;
    }
    if (
      !r ||
      !exactKeys(r, ["epoch", "observationStartMs"]) ||
      !isSafeNonNegative(r.epoch) ||
      !isSafePositive(r.observationStartMs)
    ) {
      return refuse("EPOCH_INVALID");
    }
    const n = r.epoch;
    if (this.newestEpoch !== null && n <= this.newestEpoch) return refuse("EPOCH_NOT_INCREASING");
    if (this.epochMap.size >= this.limits.maxEpochs) {
      this.epochCapacityExhausted = true;
      return refuse("EPOCH_CAPACITY");
    }
    const invalid = Object.fromEntries(CPMM_INVALID_CODES.map((c) => [c, 0])) as Record<
      CpmmInvalidCode,
      number
    >;
    this.epochMap.set(n, {
      epoch: n,
      observationStartMs: r.observationStartMs as number,
      state: "OPEN",
      occurrences: 0,
      firstOccurrences: 0,
      sameEpoch: 0,
      crossEpoch: 0,
      invalid,
      capacityRefused: 0,
      references: new Map(),
    });
    this.openEpochNumber = n;
    this.newestEpoch = n;
    return Object.freeze({ status: "OPENED", epoch: n });
  }

  // --- account ------------------------------------------------------------------------------------

  /**
   * One call per notification. The synchronous part (validation, duplicate and capacity checks,
   * and the PENDING write) runs before any await. Never rejects.
   */
  public account(
    envelope: CpmmNotificationEnvelope,
    gate?: CpmmLifecycleGate,
  ): Promise<CpmmAccountResult> {
    try {
      return this.accountSync(envelope, gate);
    } catch {
      // Unreachable by construction; still accounted, never thrown.
      this.unattributed = this.inc(this.unattributed);
      return Promise.resolve(
        Object.freeze({
          status: "INVALID",
          occurrence: this.occurrenceCount,
          epoch: null,
          code: "ENVELOPE_INVALID",
          detail: null,
        }),
      );
    }
  }

  private accountSync(
    envelope: CpmmNotificationEnvelope,
    gate: CpmmLifecycleGate | undefined,
  ): Promise<CpmmAccountResult> {
    // 1. One occurrence, one version increment (PENDING creation belongs to it).
    this.occurrenceCount = this.inc(this.occurrenceCount);
    this.bumpVersion();
    const occurrence = this.occurrenceCount;
    const done = (r: CpmmAccountResult) => Promise.resolve(deepFreeze(r));
    const invalid = (
      ep: EpochState | null,
      code: CpmmInvalidCode,
      detail: string | null = null,
    ): Promise<CpmmAccountResult> => {
      if (ep) {
        ep.occurrences = this.inc(ep.occurrences);
        ep.invalid[code] = this.inc(ep.invalid[code]);
      } else {
        this.unattributed = this.inc(this.unattributed);
      }
      return done({ status: "INVALID", occurrence, epoch: ep ? ep.epoch : null, code, detail });
    };

    // 2. Envelope.
    let env: Record<string, unknown> | null = null;
    try {
      env = readDataRecord(envelope);
    } catch {
      env = null;
    }
    if (
      !env ||
      !exactKeys(env, ["notification", "epoch", "hostReceivedAtMs"]) ||
      !isSafeNonNegative(env.epoch) ||
      !isSafePositive(env.hostReceivedAtMs)
    ) {
      return invalid(null, "ENVELOPE_INVALID");
    }
    const epochNumber = env.epoch;
    const hostReceivedAtMs = env.hostReceivedAtMs;

    // 3. Epoch.
    const ep = this.epochMap.get(epochNumber);
    if (!ep) {
      const beyondNewest = this.newestEpoch === null || epochNumber > this.newestEpoch;
      if (beyondNewest && this.epochCapacityExhausted && this.openEpochNumber === null) {
        this.unattributed = this.inc(this.unattributed);
        this.epochCapacityRefused = this.inc(this.epochCapacityRefused);
        return done({
          status: "CAPACITY_REFUSED",
          occurrence,
          epoch: null,
          code: "EPOCH_CAPACITY",
        });
      }
      return invalid(null, beyondNewest ? "EPOCH_NOT_OPEN" : "STALE_EPOCH");
    }
    if (ep.state !== "OPEN" || this.openEpochNumber !== epochNumber) {
      return invalid(ep, "STALE_EPOCH");
    }

    // 4. Gate.
    const callerGate = validateGate(gate);
    if (callerGate === null) return invalid(ep, "GATE_INVALID");

    // 5. Notification (a frozen copy is what the adapter later receives).
    const n = validateNotification(env.notification);
    if (typeof n === "string") return invalid(ep, "NOTIFICATION_INVALID", n);

    // 6. Receipt agreement.
    if (n.receivedAtMs !== hostReceivedAtMs) return invalid(ep, "RECEIPT_TIME_DISAGREEMENT");
    if (hostReceivedAtMs < ep.observationStartMs) return invalid(ep, "RECEIPT_BEFORE_EPOCH_START");

    // 7. Known signature: a duplicate occurrence, accounted where received.
    const first = this.bySignature.get(n.signature);
    if (first) return done(this.recordDuplicate(first, ep, n, occurrence));

    // 8. Record capacity (before the adapter: no reservation, no request).
    if (this.recordList.length >= this.limits.maxSignatureRecords) {
      ep.occurrences = this.inc(ep.occurrences);
      ep.capacityRefused = this.inc(ep.capacityRefused);
      this.recordCapacityRefused = this.inc(this.recordCapacityRefused);
      return done({
        status: "CAPACITY_REFUSED",
        occurrence,
        epoch: ep.epoch,
        code: "RECORD_CAPACITY",
      });
    }

    // 9. First occurrence: PENDING, written synchronously.
    const rec: RecordState = {
      sequence: this.recordList.length + 1,
      signature: n.signature,
      epoch: ep.epoch,
      hostReceivedAtMs,
      notifiedSlot: n.slot,
      notifiedBlockTimeSec: notifiedBlockTime(n),
      verifiedSlot: null,
      verifiedBlockTimeSec: null,
      disposition: "PENDING",
      blockingClass: null,
      policyPending: null,
      factKind: null,
      factCode: null,
      ingestion: ZERO_INGESTION,
      duplicateOccurrences: 0,
      duplicateDetails: [],
    };
    this.recordList.push(rec);
    this.bySignature.set(rec.signature, rec);
    ep.occurrences = this.inc(ep.occurrences);
    ep.firstOccurrences = this.inc(ep.firstOccurrences);
    return this.resolveFirst(rec, n, callerGate, occurrence);
  }

  /** The ledger-owned epoch refusal composed with the caller's gate. */
  private composeGate(
    caller: CallerGate,
    epochNumber: number,
    witness: { epochClosed: boolean },
  ): CpmmLifecycleGate {
    return {
      ...(caller.signal ? { signal: caller.signal } : {}),
      refusal: () => {
        let callerRefused = false;
        try {
          const r = caller.refusal?.();
          callerRefused = r !== null && r !== undefined;
        } catch {
          callerRefused = true;
        }
        // The caller runs first, so a re-entrant openEpoch() from its callback is seen here.
        if (this.openEpochNumber !== epochNumber) {
          witness.epochClosed = true;
          return "EPOCH_CLOSED";
        }
        return callerRefused ? "CALLER_REFUSAL" : null;
      },
    };
  }

  private async resolveFirst(
    rec: RecordState,
    n: ValidNotification,
    caller: CallerGate,
    occurrence: number,
  ): Promise<CpmmAccountResult> {
    const witness = { epochClosed: false };
    const gate = this.composeGate(caller, rec.epoch, witness);
    let fact: CpmmResolutionFact | null = null;
    let mapped: Mapped;
    let ingestCalledFor = -1;
    try {
      fact = await this.adapter.resolve(n, gate);
      mapped = this.map(fact, n, gate, witness, (total) => {
        ingestCalledFor = total;
      });
    } catch {
      mapped =
        ingestCalledFor >= 0
          ? {
              disposition: "INGESTION_INCOMPLETE",
              blockingClass: "ACCOUNTING_EXCEPTION",
              policyPending: null,
              ingestion: {
                status: "EXCEPTION",
                total: ingestCalledFor,
                accepted: 0,
                rejected: 0,
                unattempted: 0,
                indeterminate: ingestCalledFor,
              },
              verifiedSlot: null,
              verifiedBlockTimeSec: null,
            }
          : unresolved("ACCOUNTING_EXCEPTION");
    }
    // The single PENDING-to-terminal transition (only this continuation writes it).
    rec.disposition = mapped.disposition;
    rec.blockingClass = mapped.blockingClass;
    rec.policyPending = mapped.policyPending;
    rec.ingestion = Object.freeze({ ...mapped.ingestion });
    rec.verifiedSlot = mapped.verifiedSlot;
    rec.verifiedBlockTimeSec = mapped.verifiedBlockTimeSec;
    rec.factKind = fact && typeof fact.kind === "string" ? fact.kind : null;
    rec.factCode = fact && typeof fact.code === "string" ? fact.code : null;
    this.bumpVersion();
    return deepFreeze({ status: "RECORDED", occurrence, record: this.snapshotRecord(rec) });
  }

  /** Total mapping of one adapter fact (and at most one ingest call) to a terminal outcome. */
  private map(
    fact: CpmmResolutionFact,
    n: ValidNotification,
    gate: CpmmLifecycleGate,
    witness: { epochClosed: boolean },
    onIngest: (total: number) => void,
  ): Mapped {
    if (!fact || typeof fact !== "object") return unresolved("UNRECOGNIZED_OUTCOME");
    const kind = fact.kind;
    const code = fact.code;
    if (kind === "INVALID_NOTIFICATION" || kind === "INVALID_GATE") {
      return unresolved("VALIDATION_DISAGREEMENT");
    }
    // Every fact that names a notification must name the ledger's copy.
    const fn = fact.notification;
    if (fn !== null) {
      if (
        !fn ||
        fn.signature !== n.signature ||
        fn.slot !== n.slot ||
        fn.receivedAtMs !== n.receivedAtMs ||
        (typeof fn.blockTime === "number" ? fn.blockTime : null) !== notifiedBlockTime(n)
      ) {
        return unresolved("BINDING_CONFLICT");
      }
    }
    // Verified metadata: decoded kinds only, past every pre-decoding check.
    const decodedPreconditions =
      fn !== null &&
      fact.replay === "DECODER_REPLAYABLE" &&
      fact.decoder !== null &&
      fact.exchange !== null &&
      fact.exchange.evidence === "VERIFIED" &&
      fact.postAwaitCheck !== null &&
      fact.postAwaitCheck.passed === true;
    const positioned = (m: Omit<Mapped, "verifiedSlot" | "verifiedBlockTimeSec">): Mapped => ({
      ...m,
      verifiedSlot: decodedPreconditions ? n.slot : null,
      verifiedBlockTimeSec: decodedPreconditions ? notifiedBlockTime(n) : null,
    });
    const witnessOr = (fallback: CpmmBlockingClass) =>
      unresolved(witness.epochClosed ? "EPOCH_CLOSED" : fallback);
    switch (kind) {
      case "RESOLVED_SWAPS":
        return this.mapSwaps(fact, n, gate, witness, decodedPreconditions, onIngest);
      case "RESOLVED_NO_TARGET_SWAP":
        return positioned({
          disposition: "POLICY_PENDING",
          blockingClass: null,
          policyPending: "NO_TARGET_SWAP_POLICY_UNREVIEWED",
          ingestion: ZERO_INGESTION,
        });
      case "RECORDED_FAILED_TRANSACTION":
        return positioned({
          disposition: "POLICY_PENDING",
          blockingClass: null,
          policyPending: "FAILED_TRANSACTION_POLICY_UNREVIEWED",
          ingestion: ZERO_INGESTION,
        });
      case "UNRESOLVED":
        return positioned({
          disposition: "UNRESOLVED",
          blockingClass: "DECODER_UNRESOLVED",
          policyPending: null,
          ingestion: ZERO_INGESTION,
        });
      case "TRANSACTION_NOT_FOUND":
      case "RPC_ERROR":
      case "HTTP_ERROR":
      case "TRANSPORT_FAILED":
        return unresolved("TRANSACTION_UNAVAILABLE");
      case "MALFORMED_RESPONSE":
      case "SIGNATURE_MISMATCH":
      case "METADATA_CONTRADICTION":
        return unresolved("RESPONSE_CONTRADICTED");
      case "EVIDENCE_MISSING":
      case "EVIDENCE_MISMATCH":
        return unresolved("EVIDENCE_UNVERIFIED");
      case "EVIDENCE_NOT_REPLAYABLE":
        return unresolved("EVIDENCE_WITHHELD");
      case "CANCELLED_IN_FLIGHT":
        return unresolved("CANCELLED");
      case "SESSION_STOPPED_IN_FLIGHT":
        return unresolved("SESSION_ENDED");
      case "TRACKING_CAPACITY_REACHED":
        return unresolved("ADAPTER_CAPACITY_REFUSED");
      case "DUPLICATE_NOTIFICATION":
        return unresolved("DUPLICATE_WITHOUT_ORIGINAL");
      case "REQUEST_REFUSED":
        switch (code) {
          case "CALLER_REFUSAL":
            return witnessOr("CANCELLED");
          case "CALLER_CANCELLED":
            return unresolved("CANCELLED");
          case "LIFETIME_EXPIRED":
          case "REQUEST_SESSION_STOPPED":
            return unresolved("SESSION_ENDED");
          case "HTTP_ATTEMPT_CEILING_REACHED":
          case "SOLANA_RPC_ATTEMPT_CEILING_REACHED":
          case "BUDGET_MANAGER_DENIED":
          case "REQUEST_SESSION_NOT_OPEN":
          case "UNRECOGNIZED_SESSION_CODE":
            return unresolved("REQUEST_REFUSED");
          default:
            return unresolved("UNRECOGNIZED_OUTCOME");
        }
      case "LATE_RESPONSE":
        switch (code) {
          case "LIFECYCLE_REFUSED":
            return witnessOr("CANCELLED");
          case "CALLER_CANCELLED":
            return unresolved("CANCELLED");
          case "SESSION_STOPPED":
          case "ABSOLUTE_DEADLINE":
          case "SESSION_NOT_OPEN":
          case "LIFECYCLE_CHECK_FAILED":
            return unresolved("SESSION_ENDED");
          default:
            return unresolved("UNRECOGNIZED_OUTCOME");
        }
      default:
        return unresolved("UNRECOGNIZED_OUTCOME");
    }
  }

  private mapSwaps(
    fact: CpmmResolutionFact,
    n: ValidNotification,
    gate: CpmmLifecycleGate,
    witness: { epochClosed: boolean },
    decodedPreconditions: boolean,
    onIngest: (total: number) => void,
  ): Mapped {
    const events: readonly TradeEvent[] = Array.isArray(fact.events) ? fact.events : [];
    const total = events.length;
    // Binding: every event names this signature, pool, mint and slot, and one on-chain time.
    let blockTimeSec: number | null = null;
    let bound = decodedPreconditions && total > 0;
    for (const e of events) {
      if (!bound) break;
      const bt = e?.blockTimeSec;
      bound =
        e.signature === n.signature &&
        e.poolId === this.binding.poolAddress &&
        e.tokenMint === this.binding.candidateMint &&
        e.slot === n.slot &&
        typeof bt === "number" &&
        Number.isSafeInteger(bt) &&
        bt > 0 &&
        (blockTimeSec === null || bt === blockTimeSec) &&
        e.timestampProvenance === "ON_CHAIN_BLOCK_TIME" &&
        e.eventTimestampMs === bt * 1000 &&
        e.receiptTimestampMs === n.receivedAtMs;
      if (bound) blockTimeSec = bt as number;
    }
    const nbt = notifiedBlockTime(n);
    if (bound && nbt !== null && nbt !== blockTimeSec) bound = false;
    if (!bound) return unresolved("BINDING_CONFLICT");
    const verified = { verifiedSlot: n.slot, verifiedBlockTimeSec: blockTimeSec };
    const incomplete = (
      blockingClass: CpmmBlockingClass,
      ingestion: CpmmIngestionAccounting,
    ): Mapped => ({
      disposition: "INGESTION_INCOMPLETE",
      blockingClass,
      policyPending: null,
      ingestion,
      ...verified,
    });
    if (fact.ingestible !== true) {
      return incomplete("NOT_INGESTIBLE", { ...ZERO_INGESTION, total, unattempted: total });
    }
    onIngest(total);
    const r = this.adapter.ingest(fact, this.tracker, gate);
    if (r?.status === "NOT_INGESTIBLE") {
      // Refused before any event (total 0 by contract): nothing ingested, everything unattempted.
      const none = { ...ZERO_INGESTION, status: r.status, total, unattempted: total };
      return r.code === "FOREIGN_FACT"
        ? unresolved("BINDING_CONFLICT", none)
        : incomplete("NOT_INGESTIBLE", none);
    }
    const counts = [r?.total, r?.accepted, r?.rejected, r?.unattempted];
    if (
      !counts.every(isSafeNonNegative) ||
      r.total !== total ||
      r.accepted + r.rejected + r.unattempted !== total
    ) {
      return incomplete("UNRECOGNIZED_OUTCOME", {
        status: "EXCEPTION",
        total,
        accepted: 0,
        rejected: 0,
        unattempted: 0,
        indeterminate: total,
      });
    }
    const ingestion: CpmmIngestionAccounting = {
      status: r.status,
      total,
      accepted: r.accepted,
      rejected: r.rejected,
      unattempted: r.unattempted,
      indeterminate: 0,
    };
    if (r.status === "COMPLETE" && r.code === null && r.accepted === total) {
      return {
        disposition: "INGESTED",
        blockingClass: null,
        policyPending: null,
        ingestion,
        ...verified,
      };
    }
    switch (r.code) {
      case "TRACKER_IDENTITY_MISMATCH":
        return unresolved("BINDING_CONFLICT", ingestion);
      case "LIFECYCLE_STOPPED":
        return incomplete(
          witness.epochClosed && r.stopCheck?.cause === "LIFECYCLE_REFUSED"
            ? "EPOCH_CLOSED"
            : "INGEST_STOPPED",
          ingestion,
        );
      case null:
        return r.status === "PARTIAL" || r.status === "NONE_ACCEPTED"
          ? incomplete("INGEST_REJECTED", ingestion)
          : incomplete("UNRECOGNIZED_OUTCOME", ingestion);
      default:
        return incomplete("UNRECOGNIZED_OUTCOME", ingestion);
    }
  }

  // --- duplicates ---------------------------------------------------------------------------------

  private referenceValues(first: RecordState): { slot: number; blockTime: number | null } {
    return {
      slot: first.verifiedSlot ?? first.notifiedSlot,
      blockTime: first.verifiedBlockTimeSec ?? first.notifiedBlockTimeSec,
    };
  }

  private recordDuplicate(
    first: RecordState,
    ep: EpochState,
    n: ValidNotification,
    occurrence: number,
  ): CpmmAccountResult {
    const bt = notifiedBlockTime(n);
    const ref = this.referenceValues(first);
    const agreement: CpmmDuplicateOccurrence["agreement"] =
      n.slot !== ref.slot
        ? "SLOT_CONFLICT"
        : bt !== null && ref.blockTime !== null && bt !== ref.blockTime
          ? "BLOCK_TIME_CONFLICT"
          : "AGREES";
    ep.occurrences = this.inc(ep.occurrences);
    if (first.epoch === ep.epoch) ep.sameEpoch = this.inc(ep.sameEpoch);
    else ep.crossEpoch = this.inc(ep.crossEpoch);
    // Bounded aggregate per (receiving epoch, signature): independent of retained details.
    const agg = ep.references.get(first.sequence);
    if (!agg) {
      ep.references.set(first.sequence, {
        occurrences: 1,
        latestReceiptMs: n.receivedAtMs,
        minSlot: n.slot,
        maxSlot: n.slot,
        minBlockTime: bt,
        maxBlockTime: bt,
      });
    } else {
      agg.occurrences = this.inc(agg.occurrences);
      agg.latestReceiptMs = Math.max(agg.latestReceiptMs, n.receivedAtMs);
      agg.minSlot = Math.min(agg.minSlot, n.slot);
      agg.maxSlot = Math.max(agg.maxSlot, n.slot);
      if (bt !== null) {
        agg.minBlockTime = agg.minBlockTime === null ? bt : Math.min(agg.minBlockTime, bt);
        agg.maxBlockTime = agg.maxBlockTime === null ? bt : Math.max(agg.maxBlockTime, bt);
      }
    }
    first.duplicateOccurrences = this.inc(first.duplicateOccurrences);
    const detail: CpmmDuplicateOccurrence = {
      occurrence,
      epoch: ep.epoch,
      hostReceivedAtMs: n.receivedAtMs,
      notifiedSlot: n.slot,
      notifiedBlockTimeSec: bt,
      agreement,
      firstDispositionAtReceipt: first.disposition,
    };
    const detailRetained = first.duplicateDetails.length < this.limits.maxDuplicateDetailsPerRecord;
    if (detailRetained) first.duplicateDetails.push(Object.freeze({ ...detail }));
    return {
      status: "DUPLICATE",
      occurrence,
      firstSequence: first.sequence,
      detail,
      detailRetained,
    };
  }

  /** Conflict of one aggregate against the first record's current reference values. */
  private aggregateConflicts(first: RecordState, agg: ReferenceAggregate): boolean {
    const ref = this.referenceValues(first);
    if (agg.minSlot !== ref.slot || agg.maxSlot !== ref.slot) return true;
    if (agg.minBlockTime === null || agg.maxBlockTime === null) return false;
    if (agg.minBlockTime !== agg.maxBlockTime) return true;
    return ref.blockTime !== null && agg.minBlockTime !== ref.blockTime;
  }

  private recordConflicted(rec: RecordState): boolean {
    for (const ep of this.epochMap.values()) {
      const agg = ep.references.get(rec.sequence);
      if (agg && this.aggregateConflicts(rec, agg)) return true;
    }
    return false;
  }

  // --- snapshots ----------------------------------------------------------------------------------

  private snapshotRecord(rec: RecordState): CpmmSignatureAccountingRecord {
    return deepFreeze({
      sequence: rec.sequence,
      signature: rec.signature,
      epoch: rec.epoch,
      hostReceivedAtMs: rec.hostReceivedAtMs,
      notifiedSlot: rec.notifiedSlot,
      notifiedBlockTimeSec: rec.notifiedBlockTimeSec,
      verifiedSlot: rec.verifiedSlot,
      verifiedBlockTimeSec: rec.verifiedBlockTimeSec,
      disposition: rec.disposition,
      blockingClass: rec.blockingClass,
      policyPending: rec.policyPending,
      factKind: rec.factKind,
      factCode: rec.factCode,
      ingestion: { ...rec.ingestion },
      metadataConflict: this.recordConflicted(rec),
      duplicateOccurrences: rec.duplicateOccurrences,
      duplicateDetails: rec.duplicateDetails.map((d) => ({ ...d })),
      duplicateDetailsDropped: rec.duplicateOccurrences - rec.duplicateDetails.length,
    });
  }

  private snapshotEpoch(ep: EpochState): CpmmEpochAccounting {
    return deepFreeze({
      epoch: ep.epoch,
      observationStartMs: ep.observationStartMs,
      state: ep.state,
      occurrences: ep.occurrences,
      firstOccurrences: ep.firstOccurrences,
      duplicates: { sameEpoch: ep.sameEpoch, crossEpoch: ep.crossEpoch },
      invalid: { ...ep.invalid },
      capacityRefused: ep.capacityRefused,
    });
  }

  public records(): readonly CpmmSignatureAccountingRecord[] {
    return Object.freeze(this.recordList.map((r) => this.snapshotRecord(r)));
  }

  public epochs(): readonly CpmmEpochAccounting[] {
    return Object.freeze([...this.epochMap.values()].map((e) => this.snapshotEpoch(e)));
  }

  public counters(): CpmmLedgerCounters {
    return Object.freeze({
      occurrences: this.occurrenceCount,
      unattributedOccurrences: this.unattributed,
      recordCapacityRefused: this.recordCapacityRefused,
      epochCapacityRefused: this.epochCapacityRefused,
      openEpochRefused: this.openEpochRefused,
      saturated: this.saturated,
    });
  }

  // --- summaries ----------------------------------------------------------------------------------

  /** A pure snapshot; when it is called never affects membership or lateness. */
  public summarize(window: CpmmAccountingWindow): CpmmSummarizeResult {
    const shape = (): CpmmSummarizeResult =>
      Object.freeze({ status: "WINDOW_INVALID", code: "WINDOW_SHAPE" });
    let w: Record<string, unknown> | null = null;
    let c: Record<string, unknown> | null = null;
    try {
      w = readDataRecord(window);
      c = w ? readDataRecord(w.cutoff) : null;
    } catch {
      return shape();
    }
    if (
      !w ||
      !c ||
      !exactKeys(w, ["epoch", "windowStartMs", "windowEndMs", "cutoff", "receiptFrontierMs"]) ||
      !exactKeys(c, ["slot", "blockTimeMs", "provenance"]) ||
      !isSafeNonNegative(w.epoch) ||
      !isSafeNonNegative(w.windowStartMs) ||
      !isSafeNonNegative(w.windowEndMs) ||
      (w.windowEndMs as number) <= (w.windowStartMs as number) ||
      !isSafePositive(w.receiptFrontierMs) ||
      !isSafeNonNegative(c.slot) ||
      !isSafeNonNegative(c.blockTimeMs) ||
      (c.provenance !== "ON_CHAIN_BLOCK_TIME" && c.provenance !== "SYNTHETIC_FIXTURE")
    ) {
      return shape();
    }
    // Input consistency only (it does not establish cutoff provenance): the cutoff must cover the
    // whole window. The window end is exclusive, so windowEndMs === cutoff.blockTimeMs is accepted:
    // every in-window time is then strictly before the cutoff block time.
    if ((w.windowEndMs as number) > (c.blockTimeMs as number)) {
      return Object.freeze({ status: "WINDOW_INVALID", code: "WINDOW_BEYOND_CUTOFF" });
    }
    const ep = this.epochMap.get(w.epoch as number);
    if (!ep) return Object.freeze({ status: "WINDOW_INVALID", code: "EPOCH_NOT_RETAINED" });
    const frontier = w.receiptFrontierMs as number;
    if (frontier < ep.observationStartMs) {
      return Object.freeze({ status: "WINDOW_INVALID", code: "FRONTIER_BEFORE_EPOCH_START" });
    }
    const start = w.windowStartMs as number;
    const end = w.windowEndMs as number;
    const cutoffSlot = c.slot as number;
    const cutoffMs = c.blockTimeMs as number;
    const provenance = c.provenance as CpmmAccountingCutoff["provenance"];
    const frozenWindow: CpmmAccountingWindow = {
      epoch: ep.epoch,
      windowStartMs: start,
      windowEndMs: end,
      cutoff: { slot: cutoffSlot, blockTimeMs: cutoffMs, provenance },
      receiptFrontierMs: frontier,
    };

    type Placement = "IN" | "OUT" | "AFTER_CUTOFF" | "UNKNOWN";
    const place = (rec: RecordState): Placement => {
      if (rec.verifiedSlot === null || rec.verifiedBlockTimeSec === null) return "UNKNOWN";
      const t = rec.verifiedBlockTimeSec * 1000;
      if (rec.verifiedSlot > cutoffSlot || t > cutoffMs) return "AFTER_CUTOFF";
      return t >= start && t < end ? "IN" : "OUT";
    };

    const inWindow = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<
      CpmmAccountingDisposition,
      number
    >;
    const byClass: Partial<Record<CpmmBlockingClass, number>> = {};
    const policyPending = { noTargetSwap: 0, failedTransaction: 0 };
    const events = { total: 0, accepted: 0, rejected: 0, unattempted: 0, indeterminate: 0 };
    const gaps: CpmmAccountingGap[] = [];
    const late = new Set<number>();
    let positionUnknown = 0;
    let afterCutoff = 0;
    let otherEpochFirstRecords = 0;
    let inWindowFirstRecords = 0;
    let blockingRecords = 0;
    let conflictedRecords = 0;
    const gap = (signature: string | null, endMs: number, reason: string) =>
      gaps.push({
        epoch: ep.epoch,
        signature,
        timeBasis: "HOST_RECEIPT",
        startMs: ep.observationStartMs,
        endMs,
        reason: `CPMM_${reason}`,
      });

    for (const rec of this.recordList) {
      if (rec.epoch !== ep.epoch) {
        otherEpochFirstRecords++;
        continue;
      }
      const conflicted = this.recordConflicted(rec);
      if (conflicted) {
        // A conflict on any record of this epoch blocks every window of the epoch.
        conflictedRecords++;
        gap(rec.signature, rec.hostReceivedAtMs, "METADATA_CONFLICT");
      }
      const p = place(rec);
      if (p === "AFTER_CUTOFF") {
        afterCutoff++;
        continue;
      }
      if (p === "OUT") continue;
      if (p === "UNKNOWN") positionUnknown++;
      else inWindowFirstRecords++;
      inWindow[rec.disposition]++;
      if (rec.blockingClass) byClass[rec.blockingClass] = (byClass[rec.blockingClass] ?? 0) + 1;
      if (rec.policyPending === "NO_TARGET_SWAP_POLICY_UNREVIEWED") policyPending.noTargetSwap++;
      if (rec.policyPending === "FAILED_TRANSACTION_POLICY_UNREVIEWED") {
        policyPending.failedTransaction++;
      }
      events.total += rec.ingestion.total;
      events.accepted += rec.ingestion.accepted;
      events.rejected += rec.ingestion.rejected;
      events.unattempted += rec.ingestion.unattempted;
      events.indeterminate += rec.ingestion.indeterminate;
      if (rec.disposition !== "INGESTED") {
        blockingRecords++;
        gap(
          rec.signature,
          rec.hostReceivedAtMs,
          rec.blockingClass ?? rec.policyPending ?? rec.disposition,
        );
      }
      if (rec.hostReceivedAtMs > frontier && !late.has(rec.sequence)) {
        late.add(rec.sequence);
        gap(rec.signature, rec.hostReceivedAtMs, "LATE_IN_WINDOW");
      }
    }

    // References: duplicates received in this epoch (bounded aggregates, never details).
    let referencedIngested = 0;
    let crossBlocking = 0;
    let conflictingReferences = 0;
    for (const [sequence, agg] of ep.references) {
      const first = this.recordList[sequence - 1]!;
      const conflicted = this.aggregateConflicts(first, agg);
      if (conflicted) {
        conflictingReferences++;
        gap(first.signature, agg.latestReceiptMs, "DUPLICATE_METADATA_CONFLICT");
      }
      const p = place(first);
      if (p === "OUT" || p === "AFTER_CUTOFF") continue;
      if (agg.latestReceiptMs > frontier && !late.has(sequence)) {
        late.add(sequence);
        gap(first.signature, agg.latestReceiptMs, "LATE_IN_WINDOW");
      }
      if (first.epoch === ep.epoch) continue; // accounted by the first record itself
      if (p === "IN" && first.disposition === "INGESTED" && !conflicted) {
        referencedIngested++; // visible, non-blocking; never counts events or non-emptiness
      } else {
        crossBlocking++;
        gap(first.signature, agg.latestReceiptMs, "CROSS_EPOCH_DUPLICATE_BLOCKING");
      }
    }

    // Epoch-wide gaps for each non-zero blocking counter.
    for (const code of CPMM_INVALID_CODES) if (ep.invalid[code] > 0) gap(null, frontier, code);
    if (ep.capacityRefused > 0) gap(null, frontier, "RECORD_CAPACITY");
    const counters = this.counters();
    if (counters.unattributedOccurrences > 0) gap(null, frontier, "UNATTRIBUTED_OCCURRENCES");
    if (counters.recordCapacityRefused > 0) gap(null, frontier, "LEDGER_RECORD_CAPACITY");
    if (counters.epochCapacityRefused > 0) gap(null, frontier, "LEDGER_EPOCH_CAPACITY");
    if (counters.openEpochRefused > 0) gap(null, frontier, "OPEN_EPOCH_REFUSED");
    if (counters.saturated) gap(null, frontier, "COUNTER_SATURATED");

    const invalidTotal = CPMM_INVALID_CODES.reduce((s, k) => s + ep.invalid[k], 0);
    const accountingComplete =
      provenance === "ON_CHAIN_BLOCK_TIME" &&
      inWindowFirstRecords > 0 &&
      blockingRecords === 0 &&
      positionUnknown === 0 &&
      late.size === 0 &&
      crossBlocking === 0 &&
      conflictingReferences === 0 &&
      conflictedRecords === 0 &&
      invalidTotal === 0 &&
      ep.capacityRefused === 0 &&
      counters.unattributedOccurrences === 0 &&
      counters.recordCapacityRefused === 0 &&
      counters.epochCapacityRefused === 0 &&
      counters.openEpochRefused === 0 &&
      !counters.saturated;

    return deepFreeze({
      status: "SUMMARY",
      summary: {
        binding: { ...this.binding },
        window: frozenWindow,
        ledgerVersion: this.versionValue,
        epoch: this.snapshotEpoch(ep),
        ledger: counters,
        inWindow,
        inWindowByClass: byClass,
        policyPending,
        events,
        positionUnknown,
        afterCutoff,
        lateInWindow: late.size,
        crossEpochDuplicates: { referencedIngested, blocking: crossBlocking },
        metadataConflicts: { references: conflictingReferences, records: conflictedRecords },
        otherEpochFirstRecords,
        gaps,
        accountingComplete,
        notificationCompletenessEstablished: false,
        quietWindowEstablished: false,
        qualificationEligible: false,
      },
    });
  }
}
