import { types } from "node:util";
import { isCanonicalSolanaBase58 } from "../research/pilot/RaydiumAmmParser.js";
import { parseRaydiumCpmmAccount } from "../research/pilot/RaydiumCpmmParser.js";
import {
  PaperRequestSession,
  type PaperRequestDispatch,
  type PaperRequestExchange,
  type PaperRequestExchangeEvidence,
  type PaperRequestLedgerEntry,
  type PaperRequestSessionTimers,
} from "./PaperRequestSession.js";
import {
  WSOL_MINT,
  adaptRaydiumCpmmPoolState,
  type RaydiumCpmmPoolStateInput,
  type RaydiumCpmmPoolStateSuccess,
  type RaydiumCpmmPoolTarget,
  type RaydiumCpmmRawAccount,
} from "./RaydiumCpmmPoolStateAdapter.js";

const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16_384;
const MAX_DURATION_MS = 30_000;

const DISCOVERY = "CPMM_POOL_VAULT_DISCOVERY";
const SNAPSHOT = "CPMM_POOL_ACCOUNT_SNAPSHOT";
const POSITIONS = ["POOL", "VAULT0", "VAULT1"] as const;

export interface CpmmPoolAccountAcquisitionOptions {
  readonly session: PaperRequestSession;
  readonly url: string;
  readonly target: RaydiumCpmmPoolTarget;
  readonly deadlineMs: number;
  readonly timers: PaperRequestSessionTimers;
  readonly signal?: AbortSignal;
  /** Optional tighter ceilings; the session can also impose stricter limits. */
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** In memory only. The endpoint and request headers are not retained. */
export type CpmmPoolAccountExchange = Readonly<
  Pick<
    PaperRequestExchangeEvidence,
    "entry" | "requestBody" | "bodyState" | "body" | "observedBodyBytes" | "maxResponseBytes"
  >
>;

type Refusal = { readonly code: string; readonly rpcErrorCode?: number };
type Stage = "SETUP" | "DISCOVERY" | "SNAPSHOT" | "ADAPTATION";
type TimedRefusal = "CALLER_CANCELLED" | "ACQUISITION_DEADLINE_EXCEEDED";
type Completion = { readonly exchange: PaperRequestExchange } | { readonly refused: Refusal };

export type CpmmPoolAccountAcquisitionResult =
  | (Refusal & {
      readonly outcome: "ACQUISITION_FAILED" | "ACQUIRED_CONTEXT_REFUSED";
      readonly stage: Stage;
      readonly exchanges: readonly CpmmPoolAccountExchange[];
      readonly sessionStopReason?: string;
    })
  | {
      readonly outcome: "ACQUIRED";
      readonly stage: "ADAPTATION";
      readonly code: "ACQUIRED";
      readonly exchanges: readonly CpmmPoolAccountExchange[];
      readonly contextSlot: number;
      readonly discoveryPoolBytesEqual: boolean;
      readonly input: RaydiumCpmmPoolStateInput;
      readonly adapted: RaydiumCpmmPoolStateSuccess;
    };

interface DecodedAccount extends RaydiumCpmmRawAccount {
  readonly data: Buffer;
  readonly lamports: number;
  readonly rentEpoch: number;
  readonly space?: number;
}

type ResponseCheck =
  | { readonly ok: true; readonly slot: number; readonly accounts: readonly DecodedAccount[] }
  | ({ readonly ok: false } & Refusal);

type RequestedKeys = readonly [string] | readonly [string, string, string];

const owns = (record: object, key: string): boolean => Object.hasOwn(record, key);
const safeInteger = (n: unknown, min = 0): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= min;

/** Inspect descriptors before reading anything from a supplied option record. */
function dataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
      return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !owns(descriptor, "value")) return null;
    copy[key] = descriptor.value as unknown;
  }
  return required.every((key) => owns(copy, key)) ? copy : null;
}

function readOptions(value: unknown): CpmmPoolAccountAcquisitionOptions | Refusal {
  const options = dataRecord(
    value,
    ["session", "url", "target", "deadlineMs", "timers"],
    ["signal", "timeoutMs", "maxResponseBytes"],
  );
  const invalid = { code: "OPTIONS_INVALID" };
  if (!options) return invalid;
  const { session, url, deadlineMs, signal, timeoutMs, maxResponseBytes } = options;
  const timers = dataRecord(options.timers, ["setTimeout", "clearTimeout"]);
  if (
    typeof session !== "object" ||
    session === null ||
    types.isProxy(session) ||
    Object.getPrototypeOf(session) !== PaperRequestSession.prototype ||
    typeof url !== "string" ||
    !safeInteger(deadlineMs) ||
    !timers ||
    typeof timers.setTimeout !== "function" ||
    typeof timers.clearTimeout !== "function" ||
    types.isProxy(timers.setTimeout) ||
    types.isProxy(timers.clearTimeout) ||
    (timeoutMs !== undefined && (!safeInteger(timeoutMs, 1) || timeoutMs > MAX_TIMEOUT_MS)) ||
    (maxResponseBytes !== undefined &&
      (!safeInteger(maxResponseBytes, 1) || maxResponseBytes > MAX_RESPONSE_BYTES))
  )
    return invalid;
  if (signal !== undefined) {
    if (
      typeof signal !== "object" ||
      signal === null ||
      types.isProxy(signal) ||
      Object.getPrototypeOf(signal) !== AbortSignal.prototype
    )
      return invalid;
    // Check the native brand without reading any own property on the signal.
    try {
      signalAborted(signal as AbortSignal);
    } catch {
      return invalid;
    }
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return invalid;
  } catch {
    return invalid;
  }
  const target = dataRecord(options.target, ["poolAddress", "candidateMint"]);
  if (!target) return invalid;
  const { poolAddress, candidateMint } = target;
  if (typeof candidateMint !== "string" || !isCanonicalSolanaBase58(candidateMint))
    return { code: "TARGET_INVALID:candidateMint" };
  if (candidateMint === WSOL_MINT) return { code: "CANDIDATE_MINT_IS_WSOL" };
  if (
    typeof poolAddress !== "string" ||
    !isCanonicalSolanaBase58(poolAddress) ||
    poolAddress === candidateMint ||
    poolAddress === WSOL_MINT
  )
    return { code: "TARGET_INVALID:poolAddress" };
  return {
    session: session as PaperRequestSession,
    url,
    deadlineMs,
    timers: timers as unknown as PaperRequestSessionTimers,
    target: { poolAddress, candidateMint },
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  };
}

const getAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const signalAborted = (signal: AbortSignal): boolean => getAborted.call(signal) as boolean;

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/** Validate original, bounded response bytes against the request, never against supplied accounts. */
export function validateCpmmPoolAccountResponse(
  bytes: Uint8Array,
  id: number,
  keys: RequestedKeys,
  minContextSlot?: number,
): ResponseCheck {
  const fail = (code: string): ResponseCheck => ({ ok: false, code });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("NOT_UTF8");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return fail("NOT_JSON");
  }
  if (!jsonRecord(envelope) || !onlyKeys(envelope, ["jsonrpc", "id", "result", "error"]))
    return fail("ENVELOPE_SHAPE");
  if (envelope.jsonrpc !== "2.0") return fail("ENVELOPE_VERSION");
  if (!owns(envelope, "id")) return fail("ID_MISSING");
  if (envelope.id !== id) return fail("ID_MISMATCH");
  if (owns(envelope, "result") === owns(envelope, "error")) return fail("ENVELOPE_RESULT_OR_ERROR");
  if (owns(envelope, "error")) {
    const rpcErrorCode = jsonRecord(envelope.error) ? envelope.error.code : undefined;
    return typeof rpcErrorCode === "number" && Number.isSafeInteger(rpcErrorCode)
      ? { ok: false, code: "RPC_ERROR", rpcErrorCode }
      : fail("RPC_ERROR");
  }
  const { result } = envelope;
  if (
    !jsonRecord(result) ||
    !onlyKeys(result, ["context", "value"]) ||
    !owns(result, "context") ||
    !owns(result, "value")
  )
    return fail("RESULT_SHAPE");
  const { context, value } = result;
  if (
    !jsonRecord(context) ||
    !onlyKeys(context, ["slot", "apiVersion"]) ||
    (owns(context, "apiVersion") && typeof context.apiVersion !== "string")
  )
    return fail("CONTEXT_SHAPE");
  const { slot } = context;
  if (!safeInteger(slot)) return fail("CONTEXT_SLOT_INVALID");
  if (minContextSlot !== undefined && slot < minContextSlot) return fail("CONTEXT_SLOT_REGRESSED");
  if (!Array.isArray(value) || value.length !== keys.length) return fail("VALUE_LENGTH_MISMATCH");
  const accounts: DecodedAccount[] = [];
  for (const [i, address] of keys.entries()) {
    const account: unknown = value[i];
    const pos = POSITIONS[i]!;
    if (account === null) return fail(`ACCOUNT_MISSING:${pos}`);
    if (
      !jsonRecord(account) ||
      !onlyKeys(account, ["data", "executable", "lamports", "owner", "rentEpoch", "space"])
    )
      return fail(`ACCOUNT_SHAPE:${pos}`);
    const { data, executable, lamports, owner, rentEpoch, space } = account;
    if (
      !Array.isArray(data) ||
      data.length !== 2 ||
      typeof data[0] !== "string" ||
      data[1] !== "base64"
    )
      return fail(`ACCOUNT_ENCODING:${pos}`);
    const decoded = Buffer.from(data[0], "base64");
    if (decoded.toString("base64") !== data[0]) return fail(`ACCOUNT_ENCODING:${pos}`);
    if (owns(account, "space") && space !== decoded.length)
      return fail(`ACCOUNT_SPACE_MISMATCH:${pos}`);
    if (typeof owner !== "string" || !isCanonicalSolanaBase58(owner))
      return fail(`ACCOUNT_OWNER_MALFORMED:${pos}`);
    if (executable !== false) return fail(`ACCOUNT_EXECUTABLE:${pos}`);
    if (!safeInteger(lamports)) return fail(`ACCOUNT_LAMPORTS_UNSAFE:${pos}`);
    // The u64-max rent exemption sentinel rounds in JSON; this metadata is not used in adaptation.
    if (typeof rentEpoch !== "number" || !Number.isFinite(rentEpoch) || rentEpoch < 0)
      return fail(`ACCOUNT_RENT_EPOCH_INVALID:${pos}`);
    accounts.push({
      address,
      data: decoded,
      ownerProgramId: owner,
      slot,
      lamports,
      rentEpoch,
      ...(space === undefined ? {} : { space: decoded.length }),
    });
  }
  return { ok: true, slot, accounts };
}

const DISPATCH_FIELDS = [
  "seq",
  "lane",
  "owner",
  "purpose",
  "requestedIdentity",
  "jsonRpcId",
  "dispatchedAtMs",
] as const;
const COMPLETION_FIELDS = ["completedAtMs", "httpStatus", "bodyComplete", "error"] as const;

interface EvidenceSlot {
  readonly requestBody: string;
  readonly url: string;
  readonly maxResponseBytes: number;
  dispatched?: PaperRequestLedgerEntry;
  record?: CpmmPoolAccountExchange;
  issue?: string;
  seen: boolean;
}

function observe(slot: EvidenceSlot, evidence: PaperRequestExchangeEvidence): void {
  const { dispatched } = slot;
  if (!dispatched || evidence.entry.seq !== dispatched.seq) return;
  if (slot.seen) {
    slot.issue = "EVIDENCE_DUPLICATED";
    return;
  }
  slot.seen = true;
  const mismatch = DISPATCH_FIELDS.find((key) => evidence.entry[key] !== dispatched[key]);
  if (mismatch) {
    slot.issue = `EVIDENCE_ENTRY_MISMATCH:${mismatch}`;
    return;
  }
  if (
    evidence.method !== "POST" ||
    evidence.url !== slot.url ||
    evidence.requestBody !== slot.requestBody ||
    evidence.maxResponseBytes !== slot.maxResponseBytes ||
    (evidence.body !== null &&
      (!Buffer.isBuffer(evidence.body) || evidence.body.length > slot.maxResponseBytes))
  ) {
    slot.issue = "EVIDENCE_BODY_MISMATCH";
    return;
  }
  // Copy exactly once, and only after matching a bound dispatch and checking the byte ceiling.
  const { entry, body, bodyState, observedBodyBytes, maxResponseBytes } = evidence;
  slot.record = Object.freeze({
    entry: Object.freeze({ ...entry }),
    requestBody: slot.requestBody,
    body: body === null ? null : Buffer.from(body),
    bodyState,
    observedBodyBytes,
    maxResponseBytes,
  });
}

/** One target, one use. Wire onExchangeComplete into the shared session at construction. */
export class CpmmPoolAccountAcquisition {
  #started = false;
  #active: EvidenceSlot | undefined;

  public readonly onExchangeComplete = (evidence: PaperRequestExchangeEvidence): void => {
    if (this.#active) observe(this.#active, evidence);
  };

  public async acquire(
    input: CpmmPoolAccountAcquisitionOptions,
  ): Promise<CpmmPoolAccountAcquisitionResult> {
    const exchanges: CpmmPoolAccountExchange[] = [];
    let stage: Stage = "SETUP";
    const fail = (
      { code, rpcErrorCode }: Refusal,
      session?: PaperRequestSession,
      contextRefused = false,
    ): CpmmPoolAccountAcquisitionResult => {
      const sessionStopReason = session?.getStopReason();
      return {
        code,
        stage,
        exchanges: Object.freeze(exchanges),
        outcome: contextRefused ? "ACQUIRED_CONTEXT_REFUSED" : "ACQUISITION_FAILED",
        ...(rpcErrorCode === undefined ? {} : { rpcErrorCode }),
        ...(sessionStopReason ? { sessionStopReason } : {}),
      };
    };
    if (this.#started) return fail({ code: "ALREADY_STARTED" });
    this.#started = true;
    const options = readOptions(input);
    if ("code" in options) return fail(options);
    const { session, url, target, deadlineMs, signal, timers } = options;
    const timeoutMs = Math.min(
      options.timeoutMs ?? MAX_TIMEOUT_MS,
      session.limits.requestTimeoutMs,
    );
    const maxResponseBytes = Math.min(
      options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      session.limits.lanes.SOLANA_RPC.maxResponseBytes,
    );
    if (deadlineMs - session.now() > MAX_DURATION_MS) return fail({ code: "OPTIONS_INVALID" });

    const abort = new AbortController();
    let interrupted: TimedRefusal | "REQUEST_SESSION_STOPPED" | undefined;
    let stopQueueWait: (() => void) | undefined;
    const interrupt = (code: TimedRefusal) => {
      interrupted ??= session.getStopReason() === null ? code : "REQUEST_SESSION_STOPPED";
      abort.abort();
      stopQueueWait?.();
    };
    const cancel = () => interrupt("CALLER_CANCELLED");

    const checkTime = (beforeDispatch: boolean, now = session.now()): string | null => {
      if (interrupted) return interrupted;
      if (signal && signalAborted(signal)) return "CALLER_CANCELLED";
      if (now >= deadlineMs || (beforeDispatch && timeoutMs > deadlineMs - now))
        return "ACQUISITION_DEADLINE_EXCEEDED";
      return null;
    };
    const checkState = (): string | null => {
      const now = session.now();
      const timeRefusal = checkTime(false, now);
      if (timeRefusal) return timeRefusal;
      if (!session.isOpen())
        return session.getStopReason() === null
          ? "REQUEST_SESSION_NOT_OPEN"
          : "REQUEST_SESSION_STOPPED";
      const sessionDeadline = session.getDeadlineMs();
      return sessionDeadline !== null && now >= sessionDeadline ? "LIFETIME_EXPIRED" : null;
    };

    const request = async (
      purpose: typeof DISCOVERY | typeof SNAPSHOT,
      keys: RequestedKeys,
      minContextSlot?: number,
    ): Promise<ResponseCheck> => {
      const reject = (code: string): ResponseCheck => ({ ok: false, code });
      const prior = checkTime(true);
      if (prior) return reject(prior);
      const id = session.nextJsonRpcId();
      const requestBody = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "getMultipleAccounts",
        params: [
          keys,
          {
            commitment: "confirmed",
            encoding: "base64",
            ...(minContextSlot === undefined ? {} : { minContextSlot }),
          },
        ],
      });
      const slot: EvidenceSlot = { url, requestBody, maxResponseBytes, seen: false };
      this.#active = slot;
      let queueRefusal: string | undefined;
      const queue = new Promise<Completion>((resolve) => {
        stopQueueWait = () => {
          if (slot.dispatched) return; // The session abort race completes and supplies in-flight evidence.
          queueRefusal = interrupted ?? "ACQUISITION_DEADLINE_EXCEEDED";
          resolve({ refused: { code: queueRefusal } });
        };
      });
      const dispatch: PaperRequestDispatch = {
        lane: "SOLANA_RPC",
        owner: "FLOW",
        purpose,
        requestedIdentity: target.poolAddress,
        url,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        jsonRpcId: id,
        timeoutMs,
        maxResponseBytes,
        refusal: () => queueRefusal ?? checkTime(true),
        waitSignals: [abort.signal],
        linkSignals: () => [abort.signal],
        onDispatched: (entry) => {
          slot.dispatched = { ...entry };
        },
      };
      // The session may still be awaiting a previous request in its lane. Bound our own wait,
      // not the session's queue: the queued dispatch later sees the sticky refusal above.
      const complete = async (): Promise<Completion> => {
        try {
          return { exchange: await session.dispatch(dispatch) };
        } catch {
          return { refused: { code: "DISPATCH_EXCEPTION" } };
        }
      };
      try {
        const completion = await Promise.race([queue, complete()]);
        if (slot.record) exchanges.push(slot.record);
        const late = checkState();
        if ("refused" in completion) return reject(late ?? completion.refused.code);
        const { exchange } = completion;
        if (exchange.error === "REQUEST_ABORTED") {
          if (interrupted === "CALLER_CANCELLED") return reject("CALLER_CANCELLED_IN_FLIGHT");
          if (interrupted === "ACQUISITION_DEADLINE_EXCEEDED")
            return reject("DEADLINE_EXCEEDED_IN_FLIGHT");
          if (session.getStopReason() !== null) return reject("SESSION_STOPPED_IN_FLIGHT");
        }
        // A terminal exchange (e.g. 429) can itself stop the session; keep its original cause.
        if (exchange.error) return reject(exchange.error);
        if (late) return reject(late);
        if (exchange.status !== 200) return reject("HTTP_STATUS_NOT_200");
        if (!exchange.ok || !exchange.bodyComplete) return reject("RESPONSE_INCOMPLETE");
        if (slot.issue) return reject(slot.issue);
        if (!slot.record || !exchange.entry) return reject("EVIDENCE_NOT_RECORDED");
        for (const key of [...DISPATCH_FIELDS, ...COMPLETION_FIELDS]) {
          if (slot.record.entry[key] !== exchange.entry[key])
            return reject(`EVIDENCE_ENTRY_MISMATCH:${key}`);
        }
        const { body, bodyState, observedBodyBytes } = slot.record;
        if (
          bodyState !== "COMPLETE" ||
          body === null ||
          observedBodyBytes !== body.length ||
          body.toString("utf8") !== exchange.text
        )
          return reject("EVIDENCE_BODY_MISMATCH");
        return validateCpmmPoolAccountResponse(body, id, keys, minContextSlot);
      } finally {
        stopQueueWait = undefined;
        this.#active = undefined;
      }
    };

    const setupRefusal = checkState();
    if (setupRefusal) return fail({ code: setupRefusal }, session);
    const timer = timers.setTimeout(
      () => interrupt("ACQUISITION_DEADLINE_EXCEEDED"),
      Math.max(0, deadlineMs - session.now()),
    );
    try {
      if (signal)
        AbortSignal.prototype.addEventListener.call(signal, "abort", cancel, { once: true });
      stage = "DISCOVERY";
      const discovery = await request(DISCOVERY, [target.poolAddress]);
      if (!discovery.ok) return fail(discovery, session);
      const afterDiscovery = checkState();
      if (afterDiscovery) return fail({ code: afterDiscovery }, session);
      const pool = discovery.accounts[0]!;
      const parsed = parseRaydiumCpmmAccount(
        pool.data,
        pool.address,
        pool.ownerProgramId,
        pool.slot,
      );
      if (!parsed.ok) return fail({ code: `DISCOVERY_POOL_REFUSED:${parsed.category}` }, session);
      const { token0Vault, token1Vault } = parsed.state;
      // The parser already guarantees distinct, canonical vault keys.
      if (token0Vault === pool.address || token1Vault === pool.address)
        return fail({ code: "DISCOVERY_VAULTS_INVALID" }, session);

      stage = "SNAPSHOT";
      const snapshot = await request(
        SNAPSHOT,
        [pool.address, token0Vault, token1Vault],
        discovery.slot,
      );
      if (!snapshot.ok) return fail(snapshot, session);
      const afterSnapshot = checkState();
      if (afterSnapshot) return fail({ code: afterSnapshot }, session);
      const [poolAccount, vault0Account, vault1Account] = snapshot.accounts;
      const confirmed = parseRaydiumCpmmAccount(
        poolAccount!.data,
        poolAccount!.address,
        poolAccount!.ownerProgramId,
        snapshot.slot,
      );
      if (!confirmed.ok)
        return fail({ code: `SNAPSHOT_POOL_REFUSED:${confirmed.category}` }, session);
      if (
        confirmed.state.token0Vault !== token0Vault ||
        confirmed.state.token1Vault !== token1Vault
      )
        return fail({ code: "POOL_VAULTS_CHANGED" }, session);

      stage = "ADAPTATION";
      const adapterInput = {
        target,
        poolAccount: poolAccount!,
        vault0Account: vault0Account!,
        vault1Account: vault1Account!,
      };
      const adapted = adaptRaydiumCpmmPoolState(adapterInput);
      if (!adapted.ok) return fail({ code: adapted.refusalCode }, session, true);
      if (adapted.verification.slotProvenance.consistentSlot !== snapshot.slot)
        return fail({ code: "SLOT_BINDING_MISMATCH" }, session);
      const discoveryPoolBytesEqual = pool.data.equals(poolAccount!.data);
      const beforeSuccess = checkState();
      if (beforeSuccess) return fail({ code: beforeSuccess }, session);
      return {
        outcome: "ACQUIRED",
        code: "ACQUIRED",
        stage,
        exchanges: Object.freeze(exchanges),
        contextSlot: snapshot.slot,
        discoveryPoolBytesEqual,
        input: adapterInput,
        adapted,
      };
    } finally {
      timers.clearTimeout(timer);
      if (signal) AbortSignal.prototype.removeEventListener.call(signal, "abort", cancel);
    }
  }
}
