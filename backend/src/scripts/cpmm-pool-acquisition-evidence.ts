/** Item S, step 2: offline, unsigned evidence for a single supplied CPMM pool/mint. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { z } from "zod";
import {
  validateCpmmPoolAccountResponse,
  type CpmmPoolAccountAcquisitionResult,
} from "../candidate-scanner/CpmmPoolAccountAcquisition.js";
import type { PaperRequestLedgerEntry } from "../candidate-scanner/PaperRequestSession.js";
import {
  adaptRaydiumCpmmPoolState,
  WSOL_MINT,
} from "../candidate-scanner/RaydiumCpmmPoolStateAdapter.js";
import { isCanonicalSolanaBase58 } from "../research/pilot/RaydiumAmmParser.js";
import { parseRaydiumCpmmAccount } from "../research/pilot/RaydiumCpmmParser.js";
import {
  deriveEvidenceSecrets,
  EVIDENCE_REDACTED,
  EVIDENCE_REDACTED_PARTIAL,
  sanitizeEvidenceBytes,
  type EvidenceSanitizeScope,
} from "./evidence-credential-sanitizer.js";

const KIND = "CPMM_POOL_ACQUISITION_EVIDENCE_MANIFEST";
const VERSION = 1;
const ROOT = ["data", "research", "cpmm-acquisitions"] as const;
const MANIFEST = "evidence-manifest.json";
const FIXED_FILES = [
  "plan.json",
  "ledger.json",
  "report.json",
  "accounts.json",
  "adapter.json",
] as const;
const EXCHANGE_FILES = ["exchange-1.json", "exchange-2.json"] as const;
const DISCOVERY = "CPMM_POOL_VAULT_DISCOVERY";
const SNAPSHOT = "CPMM_POOL_ACCOUNT_SNAPSHOT";
const POSITIONS = ["POOL", "VAULT0", "VAULT1"] as const;
const MAX_BODY = 16_384;
const MAX_LEDGER = 256;
const MAX_FILE = 96 * 1024;
const MAX_TOTAL = 256 * 1024;
const MAX_DEPTH = 24;
const MAX_NODES = 8192;
const MAX_STRING = 64 * 1024;
const FLAGS = Object.freeze({
  notificationCompletenessEstablished: false,
  quietWindowEstablished: false,
  qualificationEligible: false,
  replayableCaptureEstablished: false,
  admissionEligible: false,
} as const);
const COMPONENTS = {
  acquisition: 1,
  responseValidator: 1,
  parser: 1,
  adapter: 1,
  session: 1,
} as const;
const LABELS = Object.freeze({
  targetSource: "SUPPLIED_TARGET",
  endpoint: "SOLANA_RPC",
  commitment: "confirmed",
  encoding: "base64",
  runtimeLifecycle: "NOT_REPLAYED",
  observationProvenance: "SUPPLIED_UNVERIFIED",
  gap: "OPEN_G3",
} as const);

export interface SealCpmmPoolAcquisitionInput {
  readonly projectRoot: string;
  readonly runId: string;
  readonly target: { readonly poolAddress: string; readonly candidateMint: string };
  /** Effective acquisition limits (after taking the stricter session limits). */
  readonly limits: {
    readonly deadlineMs: number;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
    readonly pacingMs: number;
  };
  /** Contiguous slice containing the acquisition's dispatches and any foreign activity. */
  readonly ledger: readonly PaperRequestLedgerEntry[];
  readonly result: CpmmPoolAccountAcquisitionResult;
  /** Caller-supplied only; nothing reads the environment or configuration. */
  readonly credentials: {
    readonly urls: readonly string[];
    readonly additional: readonly string[];
  };
}

type SealResult =
  | {
      readonly ok: true;
      readonly status: "SEALED";
      readonly outDir: string;
      readonly manifestSha256: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly outDir?: string;
      readonly failedFile?: string;
      readonly filesWritten?: readonly string[];
    };

type LinkStatus = "MISMATCH" | "MISSING_EVIDENCE" | "LIMITED_BY_REDACTION";
interface LinkIssue {
  readonly status: LinkStatus;
  readonly link: string;
}
export interface CpmmPoolAcquisitionVerification {
  readonly integrity: "VERIFIED" | "FAILED";
  readonly integrityCode?: string;
  readonly manifestSha256?: string;
  readonly recorded: Pick<
    Report,
    "outcome" | "code" | "stage" | "rpcErrorCode" | "sessionStopReason"
  > | null;
  readonly computed:
    | "NOT_EVALUATED"
    | "ACQUIRED_REPRODUCED"
    | "ACQUIRED_LIMITED"
    | "ACQUISITION_FAILED"
    | "ACQUIRED_CONTEXT_REFUSED"
    | "MISMATCH";
  readonly derivedCode?: string;
  readonly retained: {
    readonly ledgerEntries: number;
    readonly exchanges: readonly {
      readonly seq: number;
      readonly request: Payload["state"];
      readonly response: Payload["state"];
    }[];
    readonly accounts: readonly {
      readonly position: Account["position"];
      readonly data: Payload["state"];
    }[];
  } | null;
  readonly issues: readonly LinkIssue[];
  readonly labels: typeof LABELS;
  readonly flags: typeof FLAGS;
}

class Refused extends Error {}
function reject(code: string): never {
  throw new Refused(code);
}
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const isOwn = (o: object, key: PropertyKey) => Object.hasOwn(o, key);
const ownValue = (o: unknown, key: string): unknown =>
  o !== null && typeof o === "object" && !types.isProxy(o) && !types.isUint8Array(o)
    ? (Object.getOwnPropertyDescriptor(o, key)?.value as unknown)
    : undefined;
const arrayLength = (a: object) => ownValue(a, "length");
const getByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)!.get!;
const byteLength = (a: Uint8Array) => getByteLength.call(a) as number;
const getBackingBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "buffer",
)!.get!;

/**
 * First bound the entire graph; only then materialize plain snapshots. No caller getters, proxies,
 * toJSON, iterators or arbitrary constructors. JSON files also pass the bounded walk before Zod.
 */
function boundedGraph(value: unknown, copy = false): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (n: number) => {
    bytes += n;
    if (bytes > MAX_TOTAL) reject("STRUCTURE_LIMIT");
  };
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) reject("STRUCTURE_LIMIT");
    if (typeof v === "string") {
      if (v.length > MAX_STRING) reject("STRUCTURE_LIMIT");
      charge(Buffer.byteLength(v));
      return v;
    }
    if (typeof v === "bigint") {
      if (v > 2n ** 128n || v < -(2n ** 128n)) reject("STRUCTURE_LIMIT");
      return v;
    }
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v !== "object" || types.isProxy(v) || ancestors.has(v))
      reject("UNSUPPORTED_STRUCTURE");
    if (types.isUint8Array(v)) {
      const backing: unknown = getBackingBuffer.call(v);
      if (types.isSharedArrayBuffer(backing)) reject("UNSUPPORTED_STRUCTURE");
      const n = byteLength(v);
      if (n > MAX_BODY) reject("STRUCTURE_LIMIT");
      charge(n);
      if (!copy) return v;
      const own = Buffer.alloc(n);
      Uint8Array.prototype.set.call(own, v);
      return own;
    }
    const array = Array.isArray(v);
    const proto: unknown = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      reject("UNSUPPORTED_STRUCTURE");
    ancestors.add(v);
    const length = array ? arrayLength(v) : undefined;
    if (typeof length === "number" && length > MAX_NODES) reject("STRUCTURE_LIMIT");
    const keys = Reflect.ownKeys(v);
    if (keys.length > MAX_NODES || (array && length !== keys.length - 1)) reject("STRUCTURE_LIMIT");
    const out: Record<string, unknown> | unknown[] = array
      ? []
      : (Object.create(null) as Record<string, unknown>);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        key.length > 128 ||
        ["__proto__", "constructor", "prototype", "toJSON"].includes(key) ||
        (array && key !== String(i))
      )
        reject("UNSUPPORTED_STRUCTURE");
      charge(Buffer.byteLength(key));
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !isOwn(d, "value")) reject("UNSUPPORTED_STRUCTURE");
      const item = visit(d.value as unknown, depth + 1);
      if (copy) (out as Record<string, unknown>)[key] = item;
    }
    ancestors.delete(v);
    return copy ? out : v;
  };
  return visit(value, 0);
}

const integer = z.number().int().safe().nonnegative();
const finite = z.number().finite().nonnegative();
const text = z.string().min(1).max(256);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const address = z.string().max(44).refine(isCanonicalSolanaBase58);
const target = z
  .object({ poolAddress: z.string().max(256), candidateMint: z.string().max(256) })
  .strict();
const limits = z
  .object({
    deadlineMs: integer,
    timeoutMs: integer.min(1).max(10_000),
    maxResponseBytes: integer.min(1).max(MAX_BODY),
    pacingMs: integer.min(2500),
  })
  .strict();
const runId = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .refine((id) => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id));
const rootPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (dir) =>
      path.isAbsolute(dir) &&
      !dir.includes("\0") &&
      !/^[\\/]{2}/.test(dir) &&
      (process.platform !== "win32" || /^[A-Za-z]:[\\/]/.test(dir)) &&
      (process.platform !== "win32" || !/[:<>"|?*]/.test(dir.slice(2))),
  );
const planSchema = z
  .object({
    runId,
    target,
    limits,
    purposes: z.tuple([z.literal(DISCOVERY), z.literal(SNAPSHOT)]),
    components: z
      .object({
        acquisition: z.literal(1),
        responseValidator: z.literal(1),
        parser: z.literal(1),
        adapter: z.literal(1),
        session: z.literal(1),
      })
      .strict(),
    labels: z
      .object({
        targetSource: z.literal(LABELS.targetSource),
        endpoint: z.literal(LABELS.endpoint),
        commitment: z.literal(LABELS.commitment),
        encoding: z.literal(LABELS.encoding),
        runtimeLifecycle: z.literal(LABELS.runtimeLifecycle),
        observationProvenance: z.literal(LABELS.observationProvenance),
        gap: z.literal(LABELS.gap),
      })
      .strict(),
    flags: z
      .object({
        notificationCompletenessEstablished: z.literal(false),
        quietWindowEstablished: z.literal(false),
        qualificationEligible: z.literal(false),
        replayableCaptureEstablished: z.literal(false),
        admissionEligible: z.literal(false),
      })
      .strict(),
  })
  .strict();
type Plan = z.infer<typeof planSchema>;

const numberTag = z.object({ $number: z.enum(["NaN", "+Infinity", "-Infinity", "-0"]) }).strict();
// Finite invalid values (e.g. fractions) are stored exactly as observed, not normalized.
const time = z.union([
  z
    .number()
    .finite()
    .refine((n) => !Object.is(n, -0)),
  numberTag,
]);
function encodeTime(n: number): z.infer<typeof time> {
  if (Number.isNaN(n)) return { $number: "NaN" };
  if (n === Infinity) return { $number: "+Infinity" };
  if (n === -Infinity) return { $number: "-Infinity" };
  if (Object.is(n, -0)) return { $number: "-0" };
  return n;
}
const ledgerFields = {
  seq: integer.min(1),
  lane: z.enum(["SOLANA_RPC", "RUGCHECK", "SOLANA_TRACKER", "DEXSCREENER"]),
  owner: z.enum(["FLOW", "SECURITY", "SPOT"]),
  purpose: text,
  requestedIdentity: text,
  jsonRpcId: z.union([integer.min(1), text]).nullable(),
  httpStatus: integer.min(100).max(599).nullable(),
  bodyComplete: z.boolean(),
  error: text.nullable(),
};
const rawNumber = z.custom<number>((v) => typeof v === "number");
const rawLedger = z
  .object({
    ...ledgerFields,
    dispatchedAtMs: rawNumber,
    completedAtMs: rawNumber.nullable(),
  })
  .strict();
const ledgerEntry = z
  .object({
    ...ledgerFields,
    dispatchedAtMs: time,
    completedAtMs: time.nullable(),
  })
  .strict();
type Ledger = z.infer<typeof ledgerEntry>;
const encodeEntry = (entry: z.infer<typeof rawLedger>): Ledger => ({
  ...entry,
  dispatchedAtMs: encodeTime(entry.dispatchedAtMs),
  completedAtMs: entry.completedAtMs === null ? null : encodeTime(entry.completedAtMs),
});
const bodyState = z.enum(["COMPLETE", "PARTIAL_OVERFLOW", "NOT_READ"]);
const bytes = z.custom<Buffer>((v) => Buffer.isBuffer(v));
const rawExchange = z
  .object({
    entry: rawLedger,
    requestBody: z.string().max(1024),
    bodyState,
    body: bytes.nullable(),
    observedBodyBytes: integer.nullable(),
    maxResponseBytes: integer.min(1).max(MAX_BODY),
  })
  .strict();
const stage = z.enum(["SETUP", "DISCOVERY", "SNAPSHOT", "ADAPTATION"]);
const reportSchema = z
  .object({
    outcome: z.enum(["ACQUIRED", "ACQUISITION_FAILED", "ACQUIRED_CONTEXT_REFUSED"]),
    stage,
    code: text,
    rpcErrorCode: z.number().int().safe().optional(),
    sessionStopReason: text.optional(),
    retainedExchanges: integer.max(2),
    contextSlot: integer.optional(),
    discoveryPoolBytesEqual: z.boolean().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const success = r.outcome === "ACQUIRED";
    if (
      success !== (r.code === "ACQUIRED") ||
      success !== (r.contextSlot !== undefined && r.discoveryPoolBytesEqual !== undefined) ||
      (!success && (r.contextSlot !== undefined || r.discoveryPoolBytesEqual !== undefined)) ||
      (r.outcome !== "ACQUISITION_FAILED" && r.stage !== "ADAPTATION") ||
      (success && (r.rpcErrorCode !== undefined || r.sessionStopReason !== undefined)) ||
      (r.rpcErrorCode !== undefined && r.code !== "RPC_ERROR")
    )
      ctx.addIssue({ code: "custom", message: "REPORT_OUTCOME" });
  });
type Report = z.infer<typeof reportSchema>;
const claimFields = {
  address,
  ownerProgramId: address,
  slot: integer,
  lamports: integer,
  rentEpoch: finite,
  space: integer.max(MAX_BODY).optional(),
};
const rawAccount = z.object({ ...claimFields, data: bytes }).strict();
const rawResult = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ACQUIRED"),
      stage: z.literal("ADAPTATION"),
      code: z.literal("ACQUIRED"),
      exchanges: z.array(rawExchange).max(2),
      contextSlot: integer,
      discoveryPoolBytesEqual: z.boolean(),
      input: z
        .object({
          target,
          poolAccount: rawAccount,
          vault0Account: rawAccount,
          vault1Account: rawAccount,
        })
        .strict(),
      adapted: z.custom<Record<string, unknown>>(
        (v) => v !== null && typeof v === "object" && !Array.isArray(v),
      ),
    })
    .strict(),
  refusalInput("ACQUISITION_FAILED"),
  refusalInput("ACQUIRED_CONTEXT_REFUSED"),
]);
function refusalInput<T extends "ACQUISITION_FAILED" | "ACQUIRED_CONTEXT_REFUSED">(outcome: T) {
  return z
    .object({
      outcome: z.literal(outcome),
      stage,
      code: text,
      exchanges: z.array(rawExchange).max(2),
      rpcErrorCode: z.number().int().safe().optional(),
      sessionStopReason: text.optional(),
    })
    .strict();
}
const sealInput = z
  .object({
    projectRoot: rootPath,
    runId,
    target,
    limits,
    ledger: z.array(rawLedger).max(MAX_LEDGER),
    result: rawResult,
    credentials: z
      .object({
        urls: z.array(z.string().min(1).max(4096)).max(16),
        additional: z.array(z.string().min(6).max(4096)).max(64),
      })
      .strict(),
  })
  .strict();

const payload = z.discriminatedUnion("state", [
  z.object({ state: z.literal("NOT_CAPTURED") }).strict(),
  z
    .object({
      state: z.literal("WITHHELD"),
      originalBytes: integer.max(MAX_BODY),
      originalSha256: hex,
    })
    .strict(),
  z
    .object({
      state: z.enum(["ORIGINAL", "REDACTED"]),
      originalBytes: integer.max(MAX_BODY),
      originalSha256: hex,
      storedBytes: integer.max(2 * MAX_BODY + 4096),
      storedSha256: hex,
      encoding: z.enum(["base64", "utf8"]),
      stored: z.string().max(MAX_STRING),
    })
    .strict(),
]);
type Payload = z.infer<typeof payload>;
const requestShape = z
  .object({
    keys: z.union([z.tuple([address]), z.tuple([address, address, address])]),
    minContextSlot: integer.optional(),
  })
  .strict();
type RequestShape = z.infer<typeof requestShape>;
const exchangeSchema = z
  .object({
    entry: ledgerEntry,
    requestShape: requestShape.nullable(),
    request: payload,
    bodyState,
    observedBodyBytes: integer.nullable(),
    maxResponseBytes: integer.min(1).max(MAX_BODY),
    response: payload,
  })
  .strict();
type Exchange = z.infer<typeof exchangeSchema>;
const accountSchema = z
  .object({ position: z.enum(POSITIONS), ...claimFields, data: payload })
  .strict();
type Account = z.infer<typeof accountSchema>;
const manifestSchema = z
  .object({
    kind: z.literal(KIND),
    version: z.literal(VERSION),
    runId,
    files: z
      .array(
        z
          .object({ path: z.string().max(32), bytes: integer.min(1).max(MAX_FILE), sha256: hex })
          .strict(),
      )
      .min(5)
      .max(7),
  })
  .strict();

function get<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : reject(code);
}

/** Deterministic JSON, also rejecting ambiguous or duplicate keys on disk by round-trip. */
function json(value: unknown): string {
  function sorted(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sorted);
    if (typeof v === "bigint") return { $bigint: v.toString() };
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sorted(x)]),
      );
    if (typeof v === "number" && !Number.isFinite(v)) reject("UNENCODED_NUMBER");
    return v;
  }
  return `${JSON.stringify(sorted(value))}\n`;
}
const equal = (a: unknown, b: unknown) => json(a) === json(b);

function parseJson(data: Buffer): unknown {
  const string = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  const parsed: unknown = JSON.parse(string);
  return boundedGraph(parsed);
}
function document(data: Buffer): unknown {
  const parsed = parseJson(data);
  if (json(parsed) !== data.toString("utf8")) reject("DOCUMENT_NOT_CANONICAL");
  return parsed;
}

/** JSON.parse keeps the last duplicate key. Don't store discarded raw strings we didn't scan. */
function hasDuplicateJsonKeys(text: string): boolean {
  const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]]/gs;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else {
      const keys = stack.at(-1);
      if (!keys) continue;
      let i = match.index + token.length;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] !== ":") continue;
      const key = JSON.parse(token) as string;
      if (keys.has(key)) return true;
      keys.add(key);
    }
  }
  return false;
}

function requestBody(id: number, shape: RequestShape): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "getMultipleAccounts",
    params: [
      shape.keys,
      {
        commitment: "confirmed",
        encoding: "base64",
        ...(shape.minContextSlot === undefined ? {} : { minContextSlot: shape.minContextSlot }),
      },
    ],
  });
}
function extractRequest(body: string): RequestShape | null {
  try {
    const doc = z
      .object({
        params: z.tuple([z.unknown(), z.object({ minContextSlot: integer.optional() })]),
      })
      .parse(parseJson(Buffer.from(body)));
    const parsed = requestShape.safeParse({ keys: doc.params[0], ...doc.params[1] });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const NOT_CAPTURED = { state: "NOT_CAPTURED" } as const;
function withheld(data: Buffer): Payload {
  return { state: "WITHHELD", originalBytes: data.length, originalSha256: sha(data) };
}
function scrub(data: Buffer, secrets: readonly string[], scope: EvidenceSanitizeScope): Payload {
  const result = sanitizeEvidenceBytes(data, secrets, scope);
  if (result.status === "WITHHELD") return withheld(data);
  return {
    state: result.redacted ? "REDACTED" : "ORIGINAL",
    originalBytes: result.originalBytes,
    originalSha256: result.originalSha256,
    storedBytes: result.storedBytes,
    storedSha256: result.storedSha256,
    encoding: result.encoding,
    stored: result.stored,
  };
}
const JSON_SCOPE = { partial: false, parseJson: true };
const BINARY_SCOPE = { partial: false, parseJson: false };

/** Scan decoded account tuples even when the RPC envelope or a different account is invalid. */
function responseContainsOpaqueOrSensitiveAccounts(
  parsed: unknown,
  secrets: readonly string[],
): boolean {
  const opaqueOrSensitive = (v: unknown): boolean => {
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || v[1] !== "base64")
      return true;
    const decoded = Buffer.from(v[0], "base64");
    return (
      decoded.toString("base64") !== v[0] ||
      scrub(decoded, secrets, BINARY_SCOPE).state !== "ORIGINAL"
    );
  };
  const scan = (v: unknown): boolean => {
    if (Array.isArray(v))
      return v[1] === "base64" ? opaqueOrSensitive(v) : v.some((item: unknown) => scan(item));
    if (v !== null && typeof v === "object")
      return Object.entries(v).some(([key, item]) =>
        key === "data" ? opaqueOrSensitive(item) : scan(item),
      );
    return false;
  };
  return scan(parsed);
}
function scrubResponse(data: Buffer, partial: boolean, secrets: readonly string[]): Payload {
  // An incomplete or unparsable document cannot rule out hidden base64 account material.
  if (partial) return withheld(data);
  let parsed: unknown;
  try {
    parsed = parseJson(data);
  } catch {
    return withheld(data);
  }
  if (hasDuplicateJsonKeys(data.toString("utf8"))) return withheld(data);
  if (responseContainsOpaqueOrSensitiveAccounts(parsed, secrets)) return withheld(data);
  const result = scrub(data, secrets, JSON_SCOPE);
  if (result.state === "REDACTED") {
    let sanitized: unknown;
    try {
      sanitized = parseJson(Buffer.from(result.stored, result.encoding));
    } catch {
      return withheld(data);
    }
    if (responseContainsOpaqueOrSensitiveAccounts(sanitized, secrets)) return withheld(data);
  }
  return result;
}

type Decoded = Extract<ReturnType<typeof validateCpmmPoolAccountResponse>, { ok: true }>;
type AdapterResult = ReturnType<typeof adaptRaydiumCpmmPoolState>;
function parsePool(response: Decoded) {
  const pool = response.accounts[0]!;
  return parseRaydiumCpmmAccount(pool.data, pool.address, pool.ownerProgramId, response.slot);
}
function adapt(plan: Plan, response: Decoded): AdapterResult {
  return adaptRaydiumCpmmPoolState({
    target: plan.target,
    poolAccount: response.accounts[0]!,
    vault0Account: response.accounts[1]!,
    vault1Account: response.accounts[2]!,
  });
}
function decode(
  exchange: Pick<Exchange, "entry" | "requestShape" | "bodyState">,
  data: Buffer | null,
) {
  const { entry, requestShape: shape } = exchange;
  if (
    data === null ||
    exchange.bodyState !== "COMPLETE" ||
    entry.httpStatus !== 200 ||
    typeof entry.jsonRpcId !== "number" ||
    !shape
  )
    return null;
  return validateCpmmPoolAccountResponse(data, entry.jsonRpcId, shape.keys, shape.minContextSlot);
}

function prepare(input: SealCpmmPoolAcquisitionInput) {
  boundedGraph(input);
  // The descriptor walk above established that these accesses cannot invoke caller code.
  for (const [array, max] of [
    [ownValue(input, "ledger"), MAX_LEDGER],
    [ownValue(ownValue(input, "result"), "exchanges"), EXCHANGE_FILES.length],
    [ownValue(ownValue(input, "credentials"), "urls"), 16],
    [ownValue(ownValue(input, "credentials"), "additional"), 64],
  ] as const) {
    if (types.isProxy(array) || !Array.isArray(array) || array.length > max)
      reject("INPUT_INVALID");
  }
  const {
    projectRoot,
    runId: id,
    target,
    limits,
    ledger,
    result,
    credentials,
  } = get(sealInput, boundedGraph(input, true), "INPUT_INVALID");
  let secrets: readonly string[];
  try {
    secrets = deriveEvidenceSecrets(credentials.urls, credentials.additional);
  } catch {
    return reject("CREDENTIAL_INPUT_INVALID");
  }
  const plan = get(
    planSchema,
    {
      runId: id,
      target,
      limits,
      purposes: [DISCOVERY, SNAPSHOT],
      components: COMPONENTS,
      labels: LABELS,
      flags: FLAGS,
    },
    "INPUT_INVALID",
  );
  const exchanges: Exchange[] = result.exchanges.map((exchange) => {
    const shape = extractRequest(exchange.requestBody);
    if (
      !shape ||
      typeof exchange.entry.jsonRpcId !== "number" ||
      exchange.requestBody !== requestBody(exchange.entry.jsonRpcId, shape)
    )
      reject("REQUEST_STRUCTURE_INVALID");
    return {
      entry: encodeEntry(exchange.entry),
      requestShape: shape,
      request: scrub(Buffer.from(exchange.requestBody), secrets, JSON_SCOPE),
      bodyState: exchange.bodyState,
      observedBodyBytes: exchange.observedBodyBytes,
      maxResponseBytes: exchange.maxResponseBytes,
      response:
        exchange.body === null
          ? NOT_CAPTURED
          : scrubResponse(exchange.body, exchange.bodyState !== "COMPLETE", secrets),
    };
  });
  for (const exchange of exchanges) get(exchangeSchema, exchange, "EXCHANGE_INVALID");
  const record = result;
  const report = get(
    reportSchema,
    {
      outcome: record.outcome,
      code: record.code,
      stage: record.stage,
      retainedExchanges: exchanges.length,
      ...(record.outcome === "ACQUIRED"
        ? {
            contextSlot: record.contextSlot,
            discoveryPoolBytesEqual: record.discoveryPoolBytesEqual,
          }
        : { rpcErrorCode: record.rpcErrorCode, sessionStopReason: record.sessionStopReason }),
    },
    "REPORT_INVALID",
  );
  const second = exchanges.findIndex((e) => e.entry.purpose === SNAPSHOT);
  const snapshot = second < 0 ? null : decode(exchanges[second]!, result.exchanges[second]!.body);
  let adapter: unknown = null;
  let accounts: Account[] = [];
  if (record.outcome === "ACQUIRED") {
    if (!equal(record.input.target, plan.target)) reject("TARGET_BINDING_INVALID");
    const { poolAccount, vault0Account, vault1Account } = record.input;
    accounts = [poolAccount, vault0Account, vault1Account].map(({ data, ...rest }, i) => ({
      ...rest,
      position: POSITIONS[i]!,
      data: scrub(data, secrets, BINARY_SCOPE),
    }));
    adapter = record.adapted;
  } else if (
    report.outcome === "ACQUIRED_CONTEXT_REFUSED" &&
    snapshot?.ok &&
    snapshot.accounts.length === 3
  ) {
    accounts = snapshot.accounts.map(({ data, ...rest }, i) => ({
      ...rest,
      position: POSITIONS[i]!,
      data: scrub(data, secrets, BINARY_SCOPE),
    }));
    // Failed acquisitions don't expose a full adapter result. This is a pure derived claim,
    // never a replacement for the recorded outcome or its refusal code.
    adapter = adapt(plan, snapshot);
  }
  for (const account of accounts) get(accountSchema, account, "ACCOUNT_INVALID");
  get(adapterSchema, JSON.parse(json(adapter)) as unknown, "ADAPTER_INVALID");
  // Scan every final file (including metadata and the manifest) before the first write.
  const render = (file: string, value: unknown) => {
    const content = json(value);
    const data = Buffer.from(content);
    if (data.length > MAX_FILE) reject("FILE_LIMIT");
    if (scrubFile(data, secrets) !== "ORIGINAL") reject("RESIDUAL_CREDENTIAL");
    return { path: file, data, bytes: data.length, sha256: sha(data) };
  };
  const files = [
    render("plan.json", plan),
    render("ledger.json", ledger.map(encodeEntry)),
    render("report.json", report),
    render("accounts.json", accounts),
    render("adapter.json", adapter),
    ...exchanges.map((e, i) => render(EXCHANGE_FILES[i]!, e)),
  ];
  const manifest = render(MANIFEST, {
    kind: KIND,
    version: VERSION,
    runId: id,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  });
  if (files.reduce((sum, f) => sum + f.bytes, manifest.bytes) > MAX_TOTAL)
    reject("BUNDLE_BYTE_LIMIT");
  return { projectRoot, id, files, manifest };
}

const bigintTag = z.object({ $bigint: z.string().regex(/^(0|[1-9][0-9]{0,38})$/) }).strict();
const slotProvenance = z
  .object({
    poolSlot: integer,
    vault0Slot: integer,
    vault1Slot: integer,
    consistentSlot: integer,
  })
  .strict();
const adapterSchema = z
  .discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        poolAddress: address,
        candidateMint: address,
        wsolMint: z.literal(WSOL_MINT),
        orientation: z.enum(["TOKEN_0_BASE_WSOL_QUOTE", "TOKEN_1_BASE_WSOL_QUOTE"]),
        baseDecimals: integer,
        quoteDecimals: z.literal(9),
        baseVaultAddress: address,
        quoteVaultAddress: address,
        baseVaultRaw: bigintTag,
        quoteVaultRaw: bigintTag,
        baseTotalFeesRaw: bigintTag,
        quoteTotalFeesRaw: bigintTag,
        baseEffectiveReserveRaw: bigintTag,
        quoteEffectiveReserveRaw: bigintTag,
        baseEffectiveReserveApproxDecimal: finite,
        quoteEffectiveReserveApproxDecimal: finite,
        spotPriceSolApprox: finite,
        swapActivationTimeSec: bigintTag,
        poolStatus: integer,
        swapEnabledByStatus: z.boolean(),
        lpMint: address,
        lpSupply: bigintTag,
        verification: z
          .object({
            ownerVerified: z.literal(true),
            vaultAuthoritiesVerified: z.literal(true),
            tokenProgramsVerified: z.literal(true),
            authBumpVerified: z.literal(true),
            slotProvenance,
          })
          .strict(),
      })
      .strict(),
    z.object({ ok: z.literal(false), refusalCode: text, message: z.string().max(2048) }).strict(),
  ])
  .nullable();

function loadFile(dir: string, file: string, maxBytes: number, expectedSize?: number): Buffer {
  const name = path.join(dir, file);
  let prior;
  try {
    prior = lstatSync(name);
  } catch (e) {
    if (isMissing(e)) reject("FILE_MISSING");
    throw e;
  }
  if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1) reject("UNSAFE_FILE");
  if (prior.size < 1 || prior.size > maxBytes) reject("FILE_LIMIT");
  if (expectedSize !== undefined && prior.size !== expectedSize) reject("FILE_SIZE_MISMATCH");
  const fd = openSync(
    name,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const current = fstatSync(fd);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.ino !== prior.ino ||
      current.dev !== prior.dev ||
      current.size !== prior.size
    )
      reject("UNSAFE_FILE");
    const data = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < data.length) {
      const n = readSync(fd, data, offset, data.length - offset, offset);
      if (n === 0) reject("FILE_SIZE_MISMATCH");
      offset += n;
    }
    const after = fstatSync(fd);
    if (
      after.size !== current.size ||
      after.mtimeMs !== current.mtimeMs ||
      after.ctimeMs !== current.ctimeMs
    )
      reject("FILE_CHANGED_DURING_READ");
    return data;
  } finally {
    closeSync(fd);
  }
}

function loadBundle(dir: string) {
  if (!rootPath.safeParse(dir).success) reject("INVALID_BUNDLE_PATH");
  const full = path.resolve(dir);
  if (!runId.safeParse(path.basename(full)).success) reject("INVALID_BUNDLE_PATH");
  safeAncestors(full);
  const manifestData = loadFile(full, MANIFEST, 4096);
  const manifest = get(manifestSchema, document(manifestData), "MANIFEST_INVALID");
  const expected = [
    ...FIXED_FILES,
    ...EXCHANGE_FILES.slice(0, manifest.files.length - FIXED_FILES.length),
  ];
  if (
    manifest.runId !== path.basename(full) ||
    !equal(
      manifest.files.map((f) => f.path),
      expected,
    )
  )
    reject("MANIFEST_PATHS_INVALID");
  if (manifest.files.reduce((sum, f) => sum + f.bytes, manifestData.length) > MAX_TOTAL)
    reject("BUNDLE_BYTE_LIMIT");
  const names = new Set([MANIFEST, ...expected]);
  const iterator = opendirSync(full);
  try {
    for (let entry = iterator.readSync(); entry; entry = iterator.readSync()) {
      if (!names.delete(entry.name)) reject("EXTRA_FILE");
      if (!entry.isFile() || entry.isSymbolicLink()) reject("UNSAFE_FILE");
    }
  } finally {
    iterator.closeSync();
  }
  if (names.size) reject("FILE_MISSING");
  const files = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const data = loadFile(full, file.path, MAX_FILE, file.bytes);
    if (sha(data) !== file.sha256) reject("FILE_HASH_MISMATCH");
    files.set(file.path, data);
  }
  // Check the whole manifest and inventory before reading any claims as evidence.
  const doc = (key: string) => document(files.get(key)!);
  const plan = get(planSchema, doc("plan.json"), "PLAN_INVALID");
  if (plan.runId !== manifest.runId) reject("PLAN_RUN_ID_MISMATCH");
  return {
    manifestSha256: sha(manifestData),
    plan,
    ledger: get(z.array(ledgerEntry).max(MAX_LEDGER), doc("ledger.json"), "LEDGER_INVALID"),
    report: get(reportSchema, doc("report.json"), "REPORT_INVALID"),
    accounts: get(z.array(accountSchema).max(3), doc("accounts.json"), "ACCOUNTS_INVALID"),
    adapter: get(adapterSchema, doc("adapter.json"), "ADAPTER_INVALID"),
    exchanges: expected
      .slice(FIXED_FILES.length)
      .map((file) => get(exchangeSchema, doc(file), "EXCHANGE_INVALID")),
  };
}

function assess(bundle: ReturnType<typeof loadBundle>): CpmmPoolAcquisitionVerification {
  const { plan, ledger, report, accounts, adapter, exchanges, manifestSha256 } = bundle;
  const issues: LinkIssue[] = [];
  const issue = (status: LinkStatus, link: string) => {
    issues.push({ status, link });
  };
  const mismatch = (link: string) => {
    issue("MISMATCH", link);
  };
  const missing = (link: string) => {
    issue("MISSING_EVIDENCE", link);
  };
  const check = (yes: boolean, link: string) => {
    if (!yes) mismatch(link);
  };
  const original = (body: Payload, link: string): Buffer | null => {
    if (body.state === "WITHHELD" || body.state === "NOT_CAPTURED") {
      missing(link);
      return null;
    }
    const data = Buffer.from(body.stored, body.encoding);
    if (
      data.toString(body.encoding) !== body.stored ||
      data.length !== body.storedBytes ||
      sha(data) !== body.storedSha256 ||
      (body.state === "ORIGINAL" &&
        (data.length !== body.originalBytes || sha(data) !== body.originalSha256)) ||
      (body.state === "REDACTED" &&
        (sha(data) === body.originalSha256 ||
          (!data.includes(EVIDENCE_REDACTED) && !data.includes(EVIDENCE_REDACTED_PARTIAL))))
    ) {
      mismatch(`${link}_PAYLOAD`);
      return null;
    }
    if (body.state === "REDACTED") {
      issue("LIMITED_BY_REDACTION", link);
      return null;
    }
    return data;
  };
  const validTime = (t: z.infer<typeof time> | null): number | undefined => {
    if (typeof t === "number" && Number.isSafeInteger(t) && t >= 0) return t;
    return t !== null && typeof t === "object" && t.$number === "-0" ? 0 : undefined;
  };
  const contextExpected = report.outcome !== "ACQUISITION_FAILED";
  const pureFailure =
    /^(RPC_ERROR|NOT_UTF8|NOT_JSON|ENVELOPE_.*|ID_.*|RESULT_SHAPE|CONTEXT_.*|VALUE_LENGTH_MISMATCH|ACCOUNT_.*|DISCOVERY_POOL_REFUSED:.*|DISCOVERY_VAULTS_INVALID|SNAPSHOT_POOL_REFUSED:.*|POOL_VAULTS_CHANGED)$/.test(
      report.code,
    );
  const failureNeedsExchange =
    pureFailure ||
    /^(EVIDENCE_.*|HTTP_429_RECEIVED|HTTP_REDIRECT_REJECTED|HTTP_STATUS_NOT_200|REQUEST_(ABORTED|TIMED_OUT)|NETWORK_ERROR|RESPONSE_(TOO_LARGE|INCOMPLETE)|.*_IN_FLIGHT)$/.test(
      report.code,
    );
  const validTarget =
    address.safeParse(plan.target.poolAddress).success &&
    address.safeParse(plan.target.candidateMint).success &&
    plan.target.candidateMint !== WSOL_MINT &&
    plan.target.poolAddress !== WSOL_MINT &&
    plan.target.candidateMint !== plan.target.poolAddress;
  if (ledger.some((e, i) => i > 0 && e.seq !== ledger[i - 1]!.seq + 1)) mismatch("LEDGER_WINDOW");

  // Lane limits describe the whole shared lane, regardless of acquisition ownership.
  const rpcEntries = ledger.filter((e) => e.lane === "SOLANA_RPC");
  for (let i = 1; i < rpcEntries.length; i++) {
    const previous = rpcEntries[i - 1]!;
    const start = validTime(previous.dispatchedAtMs);
    const end = validTime(previous.completedAtMs);
    const next = validTime(rpcEntries[i]!.dispatchedAtMs);
    if (start === undefined || next === undefined) missing("LANE_PACING_TIMING");
    else check(next - start >= plan.limits.pacingMs, "LANE_PACING");
    if (end === undefined || next === undefined) missing("LANE_SERIALIZATION_TIMING");
    else check(next >= end, "LANE_SERIALIZATION");
  }

  // The acquisition's observer bound each retained exchange to onDispatched's sequence.
  // Labels, even combined with lane/owner/target, cannot assign an unbound sequence.
  const owned = exchanges.map(({ entry }) => entry);
  const discoveryEntry = owned.find((e) => e.purpose === DISCOVERY);
  const snapshotEntry = owned.find((e) => e.purpose === SNAPSHOT);
  const requestedIdentityMatches = (e: Ledger) =>
    e.owner === "FLOW" &&
    e.lane === "SOLANA_RPC" &&
    e.requestedIdentity === plan.target.poolAddress &&
    typeof e.jsonRpcId === "number";
  check(
    owned.length <= plan.purposes.length &&
      owned.every((e) => e.purpose === DISCOVERY || e.purpose === SNAPSHOT) &&
      new Set(owned.map((e) => e.purpose)).size === owned.length &&
      (!discoveryEntry || !snapshotEntry || discoveryEntry.seq < snapshotEntry.seq),
    "OWNED_LEDGER_ORDER",
  );
  if (owned.length || contextExpected) check(validTarget, "SUPPLIED_TARGET");
  if (discoveryEntry && snapshotEntry) {
    check(
      typeof discoveryEntry.jsonRpcId === "number" &&
        typeof snapshotEntry.jsonRpcId === "number" &&
        snapshotEntry.jsonRpcId > discoveryEntry.jsonRpcId,
      "LEDGER_IDS",
    );
  }
  check(exchanges.length === report.retainedExchanges, "REPORT_RETENTION");
  for (const purpose of plan.purposes) {
    if (owned.some((e) => e.purpose === purpose)) continue;
    const possible =
      purpose === DISCOVERY
        ? report.stage !== "SETUP"
        : report.stage === "SNAPSHOT" || report.stage === "ADAPTATION";
    if (!possible) continue;
    const candidate = ledger.some(
      (e) =>
        e.purpose === purpose &&
        !owned.some((entry) => entry.seq === e.seq) &&
        requestedIdentityMatches(e) &&
        (purpose === DISCOVERY
          ? !snapshotEntry || e.seq < snapshotEntry.seq
          : !discoveryEntry || e.seq > discoveryEntry.seq),
    );
    const required =
      contextExpected ||
      report.stage === "ADAPTATION" ||
      (report.stage === "SNAPSHOT" && purpose === DISCOVERY) ||
      (report.stage === (purpose === DISCOVERY ? "DISCOVERY" : "SNAPSHOT") && failureNeedsExchange);
    if (candidate) missing(`${purpose}_OWNERSHIP_UNCERTAIN`);
    if (required || candidate) missing(`${purpose}_EXCHANGE`);
    if (required && !candidate) missing(`${purpose}_LEDGER`);
  }
  for (const entry of owned) {
    check(requestedIdentityMatches(entry), "LEDGER_IDENTITY");
    const start = validTime(entry.dispatchedAtMs);
    const end = validTime(entry.completedAtMs);
    if (start === undefined || end === undefined) {
      if (contextExpected) {
        if (entry.completedAtMs === null && start !== undefined) missing("LEDGER_COMPLETION");
        else mismatch("LEDGER_CLOCK");
      }
    } else if (contextExpected || report.code !== "ACQUISITION_CLOCK_REGRESSED") {
      check(end >= start, "LEDGER_CLOCK");
    }
    if (start !== undefined)
      check(plan.limits.deadlineMs - start >= plan.limits.timeoutMs, "DISPATCH_DEADLINE");
    if (contextExpected && end !== undefined)
      check(end < plan.limits.deadlineMs, "COMPLETION_DEADLINE");
  }

  const seen = new Set<number>();
  let lastSeq = 0;
  let discovery: Decoded | undefined;
  let discoveredVaults: readonly [string, string] | undefined;
  let snapshot: Decoded | undefined;
  let snapshotPool: ReturnType<typeof parsePool> | undefined;
  let derivedCode: string | undefined;
  let derivedStage: "DISCOVERY" | "SNAPSHOT" | undefined;
  let rpcErrorCode: number | undefined;
  const parseFailure = (step: "DISCOVERY" | "SNAPSHOT", code: string, rpc?: number) => {
    derivedStage ??= step;
    derivedCode ??= code;
    rpcErrorCode ??= rpc;
  };
  for (const exchange of exchanges) {
    const { entry, requestShape: shape, bodyState, observedBodyBytes, response } = exchange;
    const isDiscovery = entry.purpose === DISCOVERY;
    const step = isDiscovery ? "DISCOVERY" : "SNAPSHOT";
    check(
      ledger.some((e) => e.seq === entry.seq && equal(e, entry)) &&
        !seen.has(entry.seq) &&
        entry.seq > lastSeq,
      `${step}_LEDGER_BINDING`,
    );
    seen.add(entry.seq);
    lastSeq = entry.seq;
    check(exchange.maxResponseBytes === plan.limits.maxResponseBytes, `${step}_BODY_LIMIT`);

    const request = original(exchange.request, `${step}_REQUEST`);
    if (!shape || typeof entry.jsonRpcId !== "number") mismatch(`${step}_REQUEST_SHAPE`);
    else {
      const expectedBody = requestBody(entry.jsonRpcId, shape);
      if (exchange.request.state !== "NOT_CAPTURED")
        check(
          exchange.request.originalBytes === Buffer.byteLength(expectedBody) &&
            exchange.request.originalSha256 === sha(expectedBody) &&
            (request === null || request.toString("utf8") === expectedBody),
          `${step}_REQUEST_BINDING`,
        );
      check(
        shape.keys[0] === plan.target.poolAddress &&
          (isDiscovery
            ? shape.keys.length === 1 && shape.minContextSlot === undefined
            : shape.keys.length === 3 &&
              shape.minContextSlot !== undefined &&
              new Set(shape.keys).size === 3),
        `${step}_REQUEST_POSITIONS`,
      );
      if (!isDiscovery) {
        if (discovery) check(shape.minContextSlot === discovery.slot, "SNAPSHOT_MIN_CONTEXT_SLOT");
        if (discoveredVaults)
          check(equal(shape.keys.slice(1), discoveredVaults), "SNAPSHOT_DISCOVERED_VAULTS");
      }
    }

    const body = original(response, `${step}_RESPONSE`);
    const rawLength = response.state === "NOT_CAPTURED" ? null : response.originalBytes;
    check(
      entry.bodyComplete === (bodyState === "COMPLETE") &&
        (bodyState === "NOT_READ"
          ? observedBodyBytes === null && rawLength === null
          : observedBodyBytes !== null &&
            (bodyState === "COMPLETE"
              ? observedBodyBytes <= exchange.maxResponseBytes &&
                (rawLength === null || observedBodyBytes === rawLength)
              : observedBodyBytes > exchange.maxResponseBytes &&
                (rawLength === null || rawLength === exchange.maxResponseBytes))),
      `${step}_BODY_STATE`,
    );
    if (entry.error) parseFailure(step, entry.error);
    else if (entry.httpStatus !== null && entry.httpStatus !== 200)
      parseFailure(step, "HTTP_STATUS_NOT_200");
    const decoded = decode(exchange, body);
    if (!decoded) continue;
    if (!decoded.ok) {
      parseFailure(step, decoded.code, decoded.rpcErrorCode);
      continue;
    }
    if (
      (isDiscovery && decoded.accounts.length !== 1) ||
      (!isDiscovery && decoded.accounts.length !== 3)
    )
      continue; // Already contradicted by the request-position check.
    const pool = parsePool(decoded);
    if (isDiscovery) {
      discovery = decoded;
      if (!pool.ok) parseFailure(step, `DISCOVERY_POOL_REFUSED:${pool.category}`);
      else if (
        pool.state.token0Vault === plan.target.poolAddress ||
        pool.state.token1Vault === plan.target.poolAddress
      )
        parseFailure(step, "DISCOVERY_VAULTS_INVALID");
      else discoveredVaults = [pool.state.token0Vault, pool.state.token1Vault];
    } else {
      snapshot = decoded;
      snapshotPool = pool;
      if (!pool.ok) parseFailure(step, `SNAPSHOT_POOL_REFUSED:${pool.category}`);
      else if (!equal(shape?.keys.slice(1), [pool.state.token0Vault, pool.state.token1Vault]))
        parseFailure(step, "POOL_VAULTS_CHANGED");
    }
  }

  if (contextExpected) {
    if (accounts.length !== 3) missing("SNAPSHOT_ACCOUNTS");
    const shape = exchanges.find((e) => e.entry.purpose === SNAPSHOT)?.requestShape;
    const slots = accounts.map((a) => a.slot);
    if (shape?.minContextSlot !== undefined) {
      const floor = shape.minContextSlot;
      check(
        slots.every((s) => s >= floor) &&
          (report.contextSlot === undefined || report.contextSlot >= floor),
        "CLAIMED_SLOT_FLOOR",
      );
    }
    check(
      slots.every(
        (s) =>
          s === slots[0] &&
          (report.contextSlot === undefined || s === report.contextSlot) &&
          (snapshot === undefined || s === snapshot.slot),
      ),
      "ACCOUNT_COMMON_SLOT",
    );
    if (report.contextSlot !== undefined) {
      if (snapshot) check(snapshot.slot === report.contextSlot, "REPORT_CONTEXT_SLOT");
      if (discovery) check(report.contextSlot >= discovery.slot, "REPORT_SLOT_FLOOR");
      if (discovery && snapshot)
        check(
          report.discoveryPoolBytesEqual ===
            discovery.accounts[0]!.data.equals(snapshot.accounts[0]!.data),
          "DISCOVERY_POOL_EQUALITY",
        );
    }
    const originalAccounts = [];
    for (const [i, account] of accounts.entries()) {
      const pos = POSITIONS[i]!;
      check(
        account.position === pos &&
          (i !== 0 || account.address === plan.target.poolAddress) &&
          (!shape || account.address === shape.keys[i]) &&
          (!discoveredVaults || i === 0 || account.address === discoveredVaults[i - 1]),
        `${pos}_POSITION`,
      );
      const raw = original(account.data, `${pos}_DATA`);
      if (raw)
        originalAccounts.push({
          address: account.address,
          data: raw,
          ownerProgramId: account.ownerProgramId,
          slot: account.slot,
        });
      if (account.data.state !== "NOT_CAPTURED" && account.space !== undefined)
        check(account.space === account.data.originalBytes, `${pos}_SPACE`);
      const decoded = snapshot?.accounts[i];
      if (!decoded) continue;
      const { data, ...fields } = decoded;
      const metadata = {
        address: account.address,
        ownerProgramId: account.ownerProgramId,
        slot: account.slot,
        lamports: account.lamports,
        rentEpoch: account.rentEpoch,
        space: account.space,
      };
      const claim = account.data;
      check(equal(fields, metadata), `${pos}_METADATA`);
      if (claim.state !== "NOT_CAPTURED")
        check(
          claim.originalBytes === data.length && claim.originalSha256 === sha(data),
          `${pos}_DECODED_BYTES`,
        );
    }
    if (!adapter) missing("ADAPTER_RESULT");
    else if (adapter.ok) {
      const provenance = adapter.verification.slotProvenance;
      const slot = report.contextSlot ?? snapshot?.slot ?? slots[0];
      check(
        report.outcome === "ACQUIRED" &&
          adapter.poolAddress === plan.target.poolAddress &&
          adapter.candidateMint === plan.target.candidateMint,
        "ADAPTER_REPORT",
      );
      check(
        Object.values(provenance).every(
          (s) => s === provenance.consistentSlot && (slot === undefined || s === slot),
        ),
        "ADAPTER_COMMON_SLOT",
      );
      const vaults =
        adapter.orientation === "TOKEN_0_BASE_WSOL_QUOTE"
          ? [adapter.baseVaultAddress, adapter.quoteVaultAddress]
          : [adapter.quoteVaultAddress, adapter.baseVaultAddress];
      if (shape) check(equal(vaults, shape.keys.slice(1)), "ADAPTER_VAULTS");
    } else
      check(
        report.outcome === "ACQUIRED_CONTEXT_REFUSED" && report.code === adapter.refusalCode,
        "ADAPTER_REPORT",
      );
    if (snapshot && snapshotPool?.ok && derivedCode === undefined) {
      const actual = adapt(plan, snapshot);
      derivedCode = actual.ok ? "ACQUIRED" : actual.refusalCode;
      if (adapter) check(equal(actual, adapter), "ADAPTER_REDERIVATION");
    }
    // Retained account originals can contradict the adapter even when the response is unusable.
    // They are not a substitute for the response in the binding chain.
    if (adapter && originalAccounts.length === 3 && snapshot === undefined) {
      const actual = adaptRaydiumCpmmPoolState({
        target: plan.target,
        poolAccount: originalAccounts[0]!,
        vault0Account: originalAccounts[1]!,
        vault1Account: originalAccounts[2]!,
      });
      check(equal(actual, adapter), "ADAPTER_FROM_RETAINED_ACCOUNTS");
    }
    if (derivedCode !== undefined) check(derivedCode === report.code, "REPORT_OUTCOME_BINDING");
  } else {
    check(accounts.length === 0 && adapter === null, "FAILED_REPORT_CONTEXT");
    // Reproduce deterministic failures, not the timing/cancellation path that chose the outcome.
    if (pureFailure && derivedCode !== undefined)
      check(
        derivedCode === report.code &&
          derivedStage === report.stage &&
          (derivedCode !== "RPC_ERROR" || rpcErrorCode === report.rpcErrorCode),
        "REPORT_REFUSAL_BINDING",
      );
    if (
      pureFailure &&
      derivedCode === undefined &&
      exchanges.some(
        (e) =>
          e.entry.purpose === (report.stage === "SNAPSHOT" ? SNAPSHOT : DISCOVERY) &&
          e.response.state === "ORIGINAL",
      )
    )
      mismatch("REPORT_REFUSAL_BINDING");
    if (report.stage === "SETUP") check(owned.length === 0, "SETUP_DISPATCH");
    if (report.stage === "DISCOVERY")
      check(!owned.some((e) => e.purpose === SNAPSHOT), "DISCOVERY_DISPATCH");
    if (derivedCode === undefined && discoveredVaults && snapshot && snapshotPool?.ok) {
      const actual = adapt(plan, snapshot);
      derivedCode = actual.ok ? "ACQUIRED" : actual.refusalCode;
    }
  }
  const computed = issues.some((i) => i.status === "MISMATCH")
    ? "MISMATCH"
    : report.outcome !== "ACQUIRED"
      ? report.outcome
      : issues.length || derivedCode !== "ACQUIRED"
        ? "ACQUIRED_LIMITED"
        : "ACQUIRED_REPRODUCED";
  const { outcome, code, stage, rpcErrorCode: rpc, sessionStopReason } = report;
  return {
    integrity: "VERIFIED",
    manifestSha256,
    recorded: {
      outcome,
      code,
      stage,
      ...(rpc === undefined ? {} : { rpcErrorCode: rpc }),
      ...(sessionStopReason === undefined ? {} : { sessionStopReason }),
    },
    computed,
    ...(derivedCode === undefined ? {} : { derivedCode }),
    retained: {
      ledgerEntries: ledger.length,
      exchanges: exchanges.map((e) => ({
        seq: e.entry.seq,
        request: e.request.state,
        response: e.response.state,
      })),
      accounts: accounts.map((a) => ({ position: a.position, data: a.data.state })),
    },
    issues,
    labels: LABELS,
    flags: FLAGS,
  };
}

/** Read-only; file integrity is checked before any semantic comparison. No runtime is replayed. */
export function verifyCpmmPoolAcquisitionEvidence(dir: string): CpmmPoolAcquisitionVerification {
  try {
    return assess(loadBundle(dir));
  } catch (e) {
    const integrityCode =
      e instanceof Refused ? e.message : isMissing(e) ? "FILE_MISSING" : "BUNDLE_UNREADABLE";
    return {
      integrity: "FAILED",
      integrityCode,
      recorded: null,
      retained: null,
      computed: "NOT_EVALUATED",
      issues:
        integrityCode === "FILE_MISSING" ? [{ status: "MISSING_EVIDENCE", link: "BUNDLE" }] : [],
      labels: LABELS,
      flags: FLAGS,
    };
  }
}

function scrubFile(data: Buffer, secrets: readonly string[]) {
  const check = sanitizeEvidenceBytes(data, secrets, JSON_SCOPE);
  return check.status === "WITHHELD" ? "WITHHELD" : check.redacted ? "REDACTED" : "ORIGINAL";
}

function isMissing(e: unknown): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT";
}
function safeDirectory(dir: string, create = false): void {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (e) {
    if (!create || !isMissing(e)) throw e;
    mkdirSync(dir, { mode: 0o700 });
    stat = lstatSync(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) reject("UNSAFE_DIRECTORY");
}
function safeAncestors(dir: string): void {
  const resolved = path.resolve(dir);
  const { root } = path.parse(resolved);
  let current = root;
  safeDirectory(current);
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    safeDirectory(current);
  }
}

/** A test writer can inject I/O faults, but receives only an already exclusively created fd. */
export function sealCpmmPoolAcquisitionEvidence(
  input: SealCpmmPoolAcquisitionInput,
  write: (fd: number, data: Buffer) => void = writeFileSync,
): SealResult {
  let ready: ReturnType<typeof prepare>;
  try {
    ready = prepare(input);
  } catch (e) {
    return { ok: false, code: e instanceof Refused ? e.message : "SEAL_INPUT_OR_SANITIZER_FAILED" };
  }
  const { projectRoot, id, files, manifest } = ready;
  const outDir = path.resolve(projectRoot, ...ROOT, id);
  try {
    safeAncestors(projectRoot);
    let dir = path.resolve(projectRoot);
    for (const part of ROOT) {
      dir = path.join(dir, part);
      safeDirectory(dir, true);
    }
    mkdirSync(outDir, { mode: 0o700 });
  } catch (e) {
    return {
      ok: false,
      code:
        e instanceof Refused
          ? e.message
          : e instanceof Error && (e as NodeJS.ErrnoException).code === "EEXIST"
            ? "OUTPUT_EXISTS"
            : "OUTPUT_UNAVAILABLE",
      outDir,
    };
  }
  const filesWritten: string[] = [];
  for (const file of [...files, manifest]) {
    try {
      const fd = openSync(path.join(outDir, file.path), "wx", 0o600);
      try {
        write(fd, file.data);
        if (fstatSync(fd).size !== file.bytes) reject("SHORT_WRITE");
      } finally {
        closeSync(fd);
      }
    } catch {
      return { ok: false, code: "WRITE_FAILED", outDir, failedFile: file.path, filesWritten };
    }
    filesWritten.push(file.path);
  }
  return { ok: true, status: "SEALED", outDir, manifestSha256: manifest.sha256 };
}
