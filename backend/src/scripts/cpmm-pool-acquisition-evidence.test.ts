import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CpmmPoolAccountAcquisition } from "../candidate-scanner/CpmmPoolAccountAcquisition.js";
import { PaperRequestSession } from "../candidate-scanner/PaperRequestSession.js";
import {
  WSOL_MINT,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../candidate-scanner/RaydiumCpmmPoolStateAdapter.js";
import {
  FIXTURE_CPMM_POOL_ADDRESS as POOL,
  FIXTURE_CPMM_TOKEN_0_VAULT as VAULT0,
  FIXTURE_CPMM_TOKEN_1_VAULT as VAULT1,
  RAYDIUM_CPMM_AUTHORITY,
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
} from "../research/pilot/fixtures/AuthoritativeCpmmFixtures.js";
import {
  sealCpmmPoolAcquisitionEvidence,
  verifyCpmmPoolAcquisitionEvidence,
  type SealCpmmPoolAcquisitionInput,
} from "./cpmm-pool-acquisition-evidence.js";

const START = 80_000;
const S1 = 310_000_000;
const S2 = S1 + 4;
const MINT = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const URL = "https://rpc.invalid/local";
const SECRET = "synthetic-only-AE3-credential-47";
const ENDPOINT_SECRET = "synthetic-endpoint-query-47";
const AUTHORITY = RAYDIUM_CPMM_AUTHORITY;
const FIXED = ["plan.json", "ledger.json", "report.json", "accounts.json", "adapter.json"];
const MANIFEST = "evidence-manifest.json";
const BASE = ["data", "research", "cpmm-acquisitions"];
const FLAGS = {
  notificationCompletenessEstablished: false,
  quietWindowEstablished: false,
  qualificationEligible: false,
  replayableCaptureEstablished: false,
  admissionEligible: false,
};
const roots: string[] = [];
const sessions: PaperRequestSession[] = [];
beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.stop("TEST_CLEANUP");
  vi.useRealTimers();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cpmm-ae-"));
  roots.push(dir);
  return dir;
}
function account(data: Buffer, owner: string) {
  return {
    data: [data.toString("base64"), "base64"],
    owner,
    executable: false,
    lamports: 0,
    space: data.length,
    rentEpoch: Number(18_446_744_073_709_551_615n),
  };
}
type Mode =
  | "success"
  | "adapter"
  | "changed"
  | "rpc"
  | "cancel"
  | "cancelSetup"
  | "deadline"
  | "sessionStop"
  | "clockNaN"
  | "clockInf"
  | "clockNegativeInf"
  | "regressed"
  | "redact"
  | "encoded"
  | "encodedDuplicate"
  | "encodedObject"
  | "429"
  | "observerMissing"
  | "malformed"
  | "overflow";

async function genuine(
  mode: Mode = "success",
  options: { foreign?: boolean | "same-purpose" | "interleaved" } = {},
) {
  const projectRoot = root();
  const target = { poolAddress: POOL, candidateMint: MINT };
  const limits = {
    deadlineMs: START + 8000,
    timeoutMs: 1000,
    pacingMs: 2500,
    maxResponseBytes: 4096,
  };
  const acquisition = new CpmmPoolAccountAcquisition();
  const abort = new AbortController();
  const pool = createAuthoritativeRaydiumCpmmBuffer({
    authBump: 253,
    token0MintBase58: MINT,
    token1MintBase58: WSOL_MINT,
    mint0Decimals: 6,
    mint1Decimals: 9,
  });
  const snapshotPool = Buffer.from(pool);
  if (mode === "adapter") snapshotPool[328] = 254;
  if (mode === "changed")
    createAuthoritativeRaydiumCpmmBuffer({ token0VaultBase58: MINT }).copy(
      snapshotPool,
      72,
      72,
      104,
    );
  if (mode === "encoded" || mode === "encodedDuplicate") snapshotPool.write(SECRET, 500);
  const vault = (mintBase58: string) =>
    account(
      createAuthoritativeCpmmSplVaultBuffer({
        mintBase58,
        ownerBase58: AUTHORITY,
        rawAmount: 1_000_000_000n,
        state: 1,
      }),
      SPL_TOKEN_PROGRAM_ID,
    );
  let nextClock: number | undefined;
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    if (url === "https://rpc.invalid/foreign") return new Response("foreign");
    expect(url).toBe(URL);
    const request = JSON.parse(init!.body as string) as { id: number; params: [string[]] };
    const discovery = request.params[0].length === 1;
    if (discovery && mode === "encodedObject") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          context: { slot: S1 },
          value: [
            {
              ...account(pool, RAYDIUM_CPMM_PROGRAM_ID),
              data: { encoded: Buffer.from(SECRET).toString("base64") },
            },
          ],
        },
      });
    }
    if (!discovery) {
      if (mode === "clockNaN") nextClock = NaN;
      if (mode === "clockInf") nextClock = Infinity;
      if (mode === "clockNegativeInf") nextClock = -Infinity;
      if (mode === "regressed") nextClock = Date.now() - 1;
      if (mode === "429") return new Response(null, { status: 429 });
      if (mode === "overflow") return new Response("x".repeat(5000));
      if (mode === "malformed") return new Response("This is not JSON");
      if (mode === "rpc")
        return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32016 } });
    }
    const value = discovery
      ? [account(pool, RAYDIUM_CPMM_PROGRAM_ID)]
      : [account(snapshotPool, RAYDIUM_CPMM_PROGRAM_ID), vault(MINT), vault(WSOL_MINT)];
    const context = {
      slot: discovery ? S1 : S2,
      apiVersion: mode === "redact" && !discovery ? ENDPOINT_SECRET : "2.0.0",
    };
    const result = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { context, value } });
    if (mode === "encodedDuplicate" && !discovery) {
      const obsolete = JSON.stringify({ data: value[0]!.data }).slice(1, -1);
      const clean = JSON.stringify(account(pool, RAYDIUM_CPMM_PROGRAM_ID));
      return new Response(
        result.replace(JSON.stringify(value[0]), `{${obsolete},${clean.slice(1)}`),
      );
    }
    return new Response(result);
  });
  let interleaved: ReturnType<PaperRequestSession["dispatch"]> | undefined;
  const foreignRpc = (session: PaperRequestSession) => {
    const id = session.nextJsonRpcId();
    return session.dispatch({
      lane: "SOLANA_RPC",
      owner: "FLOW",
      purpose: "CPMM_POOL_VAULT_DISCOVERY",
      requestedIdentity: POOL,
      method: "POST",
      url: "https://rpc.invalid/foreign",
      jsonRpcId: id,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "getMultipleAccounts",
        params: [[POOL], { commitment: "confirmed", encoding: "base64" }],
      }),
    });
  };
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn,
    clock: () => {
      const reading = nextClock ?? Date.now();
      nextClock = undefined;
      return reading;
    },
    timers: { setTimeout, clearTimeout },
    limits: {
      lifetimeMs: 50_000,
      maxHttpAttempts: 8,
      requestTimeoutMs: 2000,
      lanes: {
        SOLANA_RPC: {
          maxAttempts: 4,
          pacingMs: limits.pacingMs,
          maxResponseBytes: limits.maxResponseBytes,
        },
        RUGCHECK: { maxAttempts: 1, pacingMs: 1, maxResponseBytes: 4096 },
        SOLANA_TRACKER: { maxAttempts: 1, pacingMs: 1, maxResponseBytes: 4096 },
        DEXSCREENER: { maxAttempts: 1, pacingMs: 1, maxResponseBytes: 4096 },
      },
    },
    onExchangeComplete(evidence) {
      if (mode !== "observerMissing") acquisition.onExchangeComplete(evidence);
      if (
        options.foreign === "interleaved" &&
        evidence.url === URL &&
        evidence.entry.purpose === "CPMM_POOL_VAULT_DISCOVERY"
      )
        interleaved = foreignRpc(session);
    },
  });
  sessions.push(session);
  session.open();
  if (options.foreign === "same-purpose") {
    await foreignRpc(session);
    await vi.advanceTimersByTimeAsync(2500);
  } else if (options.foreign === true) {
    await session.dispatch({
      lane: "RUGCHECK",
      owner: "SECURITY",
      purpose: "FOREIGN",
      requestedIdentity: MINT,
      method: "GET",
      url: "https://rpc.invalid/foreign",
    });
    session.nextJsonRpcId();
  }
  if (mode === "cancelSetup") abort.abort();
  const running = acquisition.acquire({
    session,
    target,
    url: URL,
    deadlineMs: limits.deadlineMs,
    timeoutMs: limits.timeoutMs,
    maxResponseBytes: limits.maxResponseBytes,
    signal: abort.signal,
    timers: {
      setTimeout,
      clearTimeout(handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
        if (mode === "cancel") abort.abort();
        if (mode === "deadline") vi.setSystemTime(limits.deadlineMs);
        if (mode === "sessionStop") session.stop("STOP_DURING_CLEANUP");
      },
    },
  });
  await vi.advanceTimersByTimeAsync(options.foreign === "interleaved" ? 6000 : 3000);
  const result = await running;
  if (interleaved) expect((await interleaved).dispatched).toBe(true);
  return {
    fetchFn,
    snapshotPool,
    input: {
      projectRoot,
      runId: "fixture",
      target,
      limits,
      result,
      ledger: session.getLedgerSince(0),
      credentials: {
        urls: [`https://rpc.invalid/?query=${ENDPOINT_SECRET}`],
        additional: [SECRET],
      },
    } satisfies SealCpmmPoolAcquisitionInput,
  };
}

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const read = <T>(dir: string, file: string): T =>
  JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;
const sortJson = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortJson)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, sortJson(item)]),
        )
      : v;
function put(dir: string, file: string, doc: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(sortJson(doc))}\n`);
  writeFileSync(path.join(dir, file), bytes);
  return bytes;
}
interface Manifest {
  files: { path: string; bytes: number; sha256: string }[];
}
function rewrite<T>(dir: string, file: string, change: (doc: T) => void): void {
  const doc = read<T>(dir, file);
  change(doc);
  const bytes = put(dir, file, doc);
  const manifest = read<Manifest>(dir, MANIFEST);
  Object.assign(manifest.files.find((f) => f.path === file)!, {
    bytes: bytes.length,
    sha256: digest(bytes),
  });
  put(dir, MANIFEST, manifest);
}
function sealed(input: SealCpmmPoolAcquisitionInput) {
  const result = sealCpmmPoolAcquisitionEvidence(input);
  if (!result.ok) throw new Error(result.code);
  expect(result.status).toBe("SEALED");
  return result;
}
interface Payload {
  state: string;
  originalBytes: number;
  originalSha256: string;
  stored: string;
  storedBytes: number;
  storedSha256: string;
  encoding: BufferEncoding;
}
interface Exchange {
  entry: {
    seq: number;
    lane: string;
    purpose: string;
    jsonRpcId: number;
    dispatchedAtMs: number;
    completedAtMs: unknown;
  };
  request: Payload;
  response: Payload;
  requestShape: { keys: string[]; minContextSlot?: number };
  observedBodyBytes: number;
}
function replacePayload(payload: Payload, stored: string | Buffer) {
  const bytes = Buffer.from(stored);
  const roundtrip = Buffer.from(bytes.toString("utf8")).equals(bytes);
  Object.assign(payload, {
    state: "ORIGINAL",
    originalBytes: bytes.length,
    storedBytes: bytes.length,
    originalSha256: digest(bytes),
    storedSha256: digest(bytes),
    encoding: roundtrip ? "utf8" : "base64",
    stored: bytes.toString(roundtrip ? "utf8" : "base64"),
  });
}
function replaceResponse(
  file: Exchange,
  change: (doc: {
    id: number;
    result: { context: { slot: number }; value: { data: string[] }[] };
  }) => void,
) {
  const doc = JSON.parse(file.response.stored) as Parameters<typeof change>[0];
  change(doc);
  replacePayload(file.response, JSON.stringify(doc));
  file.observedBodyBytes = file.response.originalBytes;
}
const issues = (status: string, link: string) => expect.arrayContaining([{ status, link }]);

// Decode persisted payload wrappers and base64 strings in their JSON, including opaque objects.
// Assertions use only booleans/digests, never the sensitive bytes or the decoded JSON.
function persistedContainsSecret(dir: string): boolean {
  const has = (bytes: Buffer) => bytes.includes(SECRET) || bytes.includes(ENDPOINT_SECRET);
  function inspect(value: unknown): boolean {
    if (typeof value === "string")
      return has(Buffer.from(value)) || has(Buffer.from(value, "base64"));
    if (Array.isArray(value)) return value.some(inspect);
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (
      typeof record.stored === "string" &&
      (record.encoding === "utf8" || record.encoding === "base64")
    ) {
      const decoded = Buffer.from(record.stored, record.encoding);
      if (has(decoded)) return true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded.toString("utf8")) as unknown;
      } catch {
        return false;
      } // Stored binary account bytes have already been checked.
      return inspect(parsed);
    }
    return Object.values(record).some(inspect);
  }
  return readdirSync(dir).some((name) => {
    const bytes = readFileSync(path.join(dir, name));
    return has(bytes) || inspect(JSON.parse(bytes.toString("utf8")) as unknown);
  });
}

describe("item S acquisition evidence", () => {
  it("opaque account-data object does not persist a decodable secret", async () => {
    const { input } = await genuine("encodedObject");
    expect(input.result).toMatchObject({
      outcome: "ACQUISITION_FAILED",
      code: "ACCOUNT_ENCODING:POOL",
    });
    const raw = input.result.exchanges[0]!.body!;
    const { outDir } = sealed(input);
    expect(persistedContainsSecret(outDir)).toBe(false);
    const { state, originalBytes, originalSha256 } = read<Exchange>(
      outDir,
      "exchange-1.json",
    ).response;
    expect({ state, originalBytes, originalSha256 }).toEqual({
      state: "WITHHELD",
      originalBytes: raw.length,
      originalSha256: digest(raw),
    });
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      recorded: { outcome: "ACQUISITION_FAILED", code: "ACCOUNT_ENCODING:POOL" },
      computed: "ACQUISITION_FAILED",
      issues: issues("MISSING_EVIDENCE", "DISCOVERY_RESPONSE"),
    });
  });

  it("a preceding same-purpose foreign RPC is not acquisition-owned", async () => {
    const { input } = await genuine("success", { foreign: "same-purpose" });
    expect(input.result.outcome).toBe("ACQUIRED");
    expect(input.result.exchanges.map((e) => e.entry.seq)).toEqual([2, 3]);
    expect(input.ledger.map((e) => [e.seq, e.purpose, e.jsonRpcId])).toEqual([
      [1, "CPMM_POOL_VAULT_DISCOVERY", 1],
      [2, "CPMM_POOL_VAULT_DISCOVERY", 2],
      [3, "CPMM_POOL_ACCOUNT_SNAPSHOT", 3],
    ]);
    const { outDir } = sealed(input);
    expect(read(outDir, "ledger.json")).toEqual(input.ledger);
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "ACQUIRED_REPRODUCED",
      issues: [],
    });
  });

  it("a preceding entry rewritten to RPC contradicts first-request pacing", async () => {
    const { input } = await genuine("success", { foreign: true });
    const { outDir } = sealed(input);
    rewrite<Exchange["entry"][]>(outDir, "ledger.json", (rows) => {
      expect(rows[0]!.dispatchedAtMs).toBe(rows[1]!.dispatchedAtMs);
      rows[0]!.lane = "SOLANA_RPC";
    });
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "MISMATCH",
      issues: issues("MISMATCH", "LANE_PACING"),
    });
  });

  it("ambiguous same-purpose rows do not become owned when the observer retained nothing", async () => {
    const { input } = await genuine("observerMissing", { foreign: "same-purpose" });
    expect(input.ledger).toHaveLength(2);
    expect(input.result).toMatchObject({ code: "EVIDENCE_NOT_RECORDED", exchanges: [] });
    const { outDir } = sealed(input);
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "ACQUISITION_FAILED",
      issues: [
        { status: "MISSING_EVIDENCE", link: "CPMM_POOL_VAULT_DISCOVERY_OWNERSHIP_UNCERTAIN" },
        { status: "MISSING_EVIDENCE", link: "CPMM_POOL_VAULT_DISCOVERY_EXCHANGE" },
      ],
    });
  });

  it("a recorded success with a missing snapshot exchange does not reproduce", async () => {
    const { input } = await genuine("success", { foreign: "same-purpose" });
    const { outDir } = sealed(input);
    const manifest = read<Manifest>(outDir, MANIFEST);
    manifest.files.pop();
    rmSync(path.join(outDir, "exchange-2.json"));
    put(outDir, MANIFEST, manifest);
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "MISMATCH",
      issues: issues("MISMATCH", "REPORT_RETENTION"),
    });
    rewrite<{ retainedExchanges: number }>(outDir, "report.json", (report) => {
      report.retainedExchanges = 1;
    });
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "ACQUIRED_LIMITED",
      issues: [
        { status: "MISSING_EVIDENCE", link: "CPMM_POOL_ACCOUNT_SNAPSHOT_OWNERSHIP_UNCERTAIN" },
        { status: "MISSING_EVIDENCE", link: "CPMM_POOL_ACCOUNT_SNAPSHOT_EXCHANGE" },
      ],
    });
  });

  it("a second sequence-correlated discovery violates the acquisition's one-dispatch-per-purpose bound", async () => {
    const { input } = await genuine();
    const { outDir } = sealed(input);
    const change = (entry: Exchange["entry"]) => {
      entry.purpose = "CPMM_POOL_VAULT_DISCOVERY";
    };
    rewrite<Exchange["entry"][]>(outDir, "ledger.json", (rows) => change(rows[1]!));
    rewrite<Exchange>(outDir, "exchange-2.json", (file) => change(file.entry));
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "MISMATCH",
      issues: issues("MISMATCH", "OWNED_LEDGER_ORDER"),
    });
  });

  it("valid interleaved RPC activity reproduces, but every adjacent RPC pair is checked", async () => {
    const { input } = await genuine("success", { foreign: "interleaved" });
    expect(input.result.outcome).toBe("ACQUIRED");
    expect(input.result.exchanges.map((e) => e.entry.seq)).toEqual([1, 3]);
    const { outDir } = sealed(input);
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "ACQUIRED_REPRODUCED",
      issues: [],
    });
    rewrite<Exchange["entry"][]>(outDir, "ledger.json", (rows) => {
      rows[1]!.dispatchedAtMs -= 1;
      rows[1]!.completedAtMs = null;
    });
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "MISMATCH",
      issues: expect.arrayContaining([
        { status: "MISMATCH", link: "LANE_PACING" },
        { status: "MISSING_EVIDENCE", link: "LANE_SERIALIZATION_TIMING" },
      ]),
    });
  });

  it("unavailable RPC dispatch time does not hide an independently provable serialization violation", async () => {
    const { input } = await genuine("success", { foreign: "same-purpose" });
    const { outDir } = sealed(input);
    rewrite<(Omit<Exchange["entry"], "dispatchedAtMs"> & { dispatchedAtMs: unknown })[]>(
      outDir,
      "ledger.json",
      (rows) => {
        rows[0]!.dispatchedAtMs = { $number: "NaN" };
        rows[0]!.completedAtMs = Number(rows[1]!.dispatchedAtMs) + 1;
      },
    );
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "VERIFIED",
      computed: "MISMATCH",
      issues: expect.arrayContaining([
        { status: "MISSING_EVIDENCE", link: "LANE_PACING_TIMING" },
        { status: "MISMATCH", link: "LANE_SERIALIZATION" },
      ]),
    });
  });
  it("AE1: real success reproduces in a separate unsigned bundle with an interleaved ledger window", async () => {
    const { input, fetchFn } = await genuine("success", { foreign: true });
    expect(input.result.outcome).toBe("ACQUIRED");
    const output = sealed(input);
    const manifest = read<Manifest>(output.outDir, MANIFEST);
    expect(manifest.files.map((f) => f.path)).toEqual([
      ...FIXED,
      "exchange-1.json",
      "exchange-2.json",
    ]);
    for (const file of manifest.files) {
      const data = readFileSync(path.join(output.outDir, file.path));
      expect(file).toMatchObject({ bytes: data.length, sha256: digest(data) });
    }
    expect(read(output.outDir, "adapter.json")).toMatchObject({
      baseVaultRaw: { $bigint: "1000000000" },
    });
    expect(read<Exchange>(output.outDir, "exchange-2.json").requestShape).toEqual({
      keys: [POOL, VAULT0, VAULT1],
      minContextSlot: S1,
    });
    const verified = verifyCpmmPoolAcquisitionEvidence(output.outDir);
    expect(verified).toMatchObject({
      integrity: "VERIFIED",
      manifestSha256: output.manifestSha256,
      recorded: { outcome: "ACQUIRED", code: "ACQUIRED", stage: "ADAPTATION" },
      derivedCode: "ACQUIRED",
      computed: "ACQUIRED_REPRODUCED",
      issues: [],
      retained: {
        ledgerEntries: 3,
        exchanges: [
          { seq: 2, request: "ORIGINAL", response: "ORIGINAL" },
          { seq: 3, request: "ORIGINAL", response: "ORIGINAL" },
        ],
        accounts: [
          { position: "POOL", data: "ORIGINAL" },
          { position: "VAULT0", data: "ORIGINAL" },
          { position: "VAULT1", data: "ORIGINAL" },
        ],
      },
      labels: {
        targetSource: "SUPPLIED_TARGET",
        runtimeLifecycle: "NOT_REPLAYED",
        observationProvenance: "SUPPLIED_UNVERIFIED",
        gap: "OPEN_G3",
      },
      flags: FLAGS,
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(existsSync(path.join(input.projectRoot, "data", "research", "cpmm-observations"))).toBe(
      false,
    );
    expect(sealCpmmPoolAcquisitionEvidence(input)).toMatchObject({
      ok: false,
      code: "OUTPUT_EXISTS",
    });
    expect(verifyCpmmPoolAcquisitionEvidence(output.outDir)).toEqual(verified);
  });

  it.each([
    ["adapter", "ACQUIRED_CONTEXT_REFUSED", "AUTH_BUMP_INVALID", "AUTH_BUMP_INVALID"],
    ["changed", "ACQUISITION_FAILED", "POOL_VAULTS_CHANGED", "POOL_VAULTS_CHANGED"],
    ["rpc", "ACQUISITION_FAILED", "RPC_ERROR", "RPC_ERROR"],
    ["cancel", "ACQUISITION_FAILED", "CALLER_CANCELLED", "ACQUIRED"],
    ["cancelSetup", "ACQUISITION_FAILED", "CALLER_CANCELLED", undefined],
    ["deadline", "ACQUISITION_FAILED", "ACQUISITION_DEADLINE_EXCEEDED", "ACQUIRED"],
    ["sessionStop", "ACQUISITION_FAILED", "REQUEST_SESSION_STOPPED", "ACQUIRED"],
    ["clockNaN", "ACQUISITION_FAILED", "ACQUISITION_CLOCK_INVALID", "ACQUIRED"],
    ["clockInf", "ACQUISITION_FAILED", "ACQUISITION_CLOCK_INVALID", "ACQUIRED"],
    ["clockNegativeInf", "ACQUISITION_FAILED", "ACQUISITION_CLOCK_INVALID", "ACQUIRED"],
    ["regressed", "ACQUISITION_FAILED", "ACQUISITION_CLOCK_REGRESSED", "ACQUIRED"],
    ["429", "ACQUISITION_FAILED", "HTTP_429_RECEIVED", "HTTP_429_RECEIVED"],
    ["observerMissing", "ACQUISITION_FAILED", "EVIDENCE_NOT_RECORDED", undefined],
    ["overflow", "ACQUISITION_FAILED", "RESPONSE_TOO_LARGE", "RESPONSE_TOO_LARGE"],
    ["malformed", "ACQUISITION_FAILED", "NOT_JSON", undefined],
  ] as const)(
    "AE1: genuine %s acquisition keeps its recorded outcome",
    async (mode, outcome, code, derivedCode) => {
      const { input } = await genuine(mode);
      expect(input.result).toMatchObject({ outcome, code });
      const { outDir } = sealed(input);
      const verified = verifyCpmmPoolAcquisitionEvidence(outDir);
      expect(verified).toMatchObject({
        integrity: "VERIFIED",
        recorded: { outcome, code },
        computed: outcome,
        flags: FLAGS,
      });
      expect(verified.derivedCode).toBe(derivedCode);
      if (mode === "rpc") expect(verified.recorded).toHaveProperty("rpcErrorCode", -32016);
      if (mode === "sessionStop")
        expect(verified.recorded).toHaveProperty("sessionStopReason", "STOP_DURING_CLEANUP");
      if (mode === "adapter") expect(read(outDir, "accounts.json")).toHaveLength(3);
      if (["429", "overflow", "malformed"].includes(mode))
        expect(verified.issues).toEqual(issues("MISSING_EVIDENCE", "SNAPSHOT_RESPONSE"));
      if (mode === "observerMissing")
        expect(verified.issues).toEqual(
          issues("MISSING_EVIDENCE", "CPMM_POOL_VAULT_DISCOVERY_EXCHANGE"),
        );
      const tags = {
        clockNaN: "NaN",
        clockInf: "+Infinity",
        clockNegativeInf: "-Infinity",
      } as const;
      if (mode === "clockNaN" || mode === "clockInf" || mode === "clockNegativeInf") {
        const tagged = { $number: tags[mode] };
        expect(read<Exchange>(outDir, "exchange-2.json").entry.completedAtMs).toEqual(tagged);
        expect(read<Exchange["entry"][]>(outDir, "ledger.json")[1]!.completedAtMs).toEqual(tagged);
      }
    },
  );

  it.each([
    [
      "response id",
      "REPORT_OUTCOME_BINDING",
      (d: string) =>
        rewrite<Exchange>(d, "exchange-2.json", (file) =>
          replaceResponse(file, (r) => {
            r.id++;
          }),
        ),
    ],
    [
      "request bytes",
      "SNAPSHOT_REQUEST_BINDING",
      (d: string) =>
        rewrite<Exchange>(d, "exchange-2.json", (file) =>
          replacePayload(file.request, file.request.stored.replace('"confirmed"', '"finalized"')),
        ),
    ],
    [
      "minimum slot rewritten with its digest",
      "SNAPSHOT_MIN_CONTEXT_SLOT",
      (d: string) =>
        rewrite<Exchange>(d, "exchange-2.json", (file) => {
          file.requestShape.minContextSlot = S1 - 1;
          replacePayload(file.request, file.request.stored.replace(String(S1), String(S1 - 1)));
        }),
    ],
    [
      "positions swapped",
      "VAULT0_POSITION",
      (d: string) =>
        rewrite<unknown[]>(d, "accounts.json", (rows) => {
          [rows[1], rows[2]] = [rows[2], rows[1]];
        }),
    ],
    [
      "account owner",
      "VAULT0_METADATA",
      (d: string) =>
        rewrite<{ ownerProgramId: string }[]>(d, "accounts.json", (rows) => {
          rows[1]!.ownerProgramId = RAYDIUM_CPMM_PROGRAM_ID;
        }),
    ],
    [
      "decoded account bytes",
      "POOL_DECODED_BYTES",
      (d: string) =>
        rewrite<{ data: Payload }[]>(d, "accounts.json", (rows) => {
          const bytes = Buffer.from(rows[0]!.data.stored, "base64");
          bytes[625] = 1;
          replacePayload(rows[0]!.data, bytes);
        }),
    ],
    [
      "common slot",
      "ACCOUNT_COMMON_SLOT",
      (d: string) =>
        rewrite<{ contextSlot: number }>(d, "report.json", (r) => {
          r.contextSlot = S2 - 1;
        }),
    ],
    [
      "adapter",
      "ADAPTER_REDERIVATION",
      (d: string) =>
        rewrite<{ baseVaultRaw: { $bigint: string } }>(d, "adapter.json", (a) => {
          a.baseVaultRaw.$bigint = "1000000001";
        }),
    ],
    [
      "ledger",
      "SNAPSHOT_LEDGER_BINDING",
      (d: string) =>
        rewrite<Exchange["entry"][]>(d, "ledger.json", (rows) => {
          rows[1]!.jsonRpcId++;
        }),
    ],
    [
      "pacing even if exchange agrees",
      "LANE_PACING",
      (d: string) => {
        const move = (entry: Exchange["entry"]) => {
          entry.dispatchedAtMs -= 1;
        };
        rewrite<Exchange["entry"][]>(d, "ledger.json", (rows) => move(rows[1]!));
        rewrite<Exchange>(d, "exchange-2.json", (e) => move(e.entry));
      },
    ],
    [
      "response bytes and digest",
      "POOL_DECODED_BYTES",
      (d: string) =>
        rewrite<Exchange>(d, "exchange-2.json", (file) =>
          replaceResponse(file, (r) => {
            const bytes = Buffer.from(r.result.value[0]!.data[0]!, "base64");
            bytes[620] = 1;
            r.result.value[0]!.data[0] = bytes.toString("base64");
          }),
        ),
    ],
    [
      "supplied plan target",
      "DISCOVERY_REQUEST_POSITIONS",
      (d: string) =>
        rewrite<{ target: { poolAddress: string } }>(d, "plan.json", (p) => {
          p.target.poolAddress = VAULT0;
        }),
    ],
  ] as const)(
    "AE2: hash-consistent %s is independently contradicted",
    async (_label, link, change) => {
      const { input } = await genuine();
      const { outDir } = sealed(input);
      change(outDir);
      expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
        integrity: "VERIFIED",
        recorded: { outcome: "ACQUIRED" },
        computed: "MISMATCH",
        issues: issues("MISMATCH", link),
      });
    },
  );

  it.each([
    "missing",
    "extra",
    "changed",
    "unsafe path",
    "hard link",
    "symlink",
    "file limit",
    "duplicate JSON",
  ] as const)("AE2: %s fails file integrity before re-derivation", async (mode) => {
    const { input } = await genuine();
    const { outDir } = sealed(input);
    const name = path.join(outDir, "plan.json");
    const manifest = read<Manifest>(outDir, MANIFEST);
    const original = readFileSync(name);
    if (mode === "missing") rmSync(name);
    if (mode === "extra") writeFileSync(path.join(outDir, "unlisted.json"), "{}");
    if (mode === "changed") {
      original[0] = 91;
      writeFileSync(name, original);
    }
    if (mode === "unsafe path") {
      manifest.files[0]!.path = "../plan.json";
      put(outDir, MANIFEST, manifest);
    }
    if (mode === "hard link") linkSync(name, path.join(input.projectRoot, "unlisted-copy"));
    if (mode === "symlink") {
      rmSync(name);
      const outside = path.join(input.projectRoot, "outside");
      mkdirSync(outside);
      symlinkSync(outside, name, "junction");
    }
    if (mode === "file limit") writeFileSync(name, Buffer.alloc(100_000));
    if (mode === "duplicate JSON") {
      const bytes = Buffer.from(`{"runId":"first",${original.toString("utf8").slice(1)}`);
      writeFileSync(name, bytes);
      Object.assign(manifest.files[0]!, { bytes: bytes.length, sha256: digest(bytes) });
      put(outDir, MANIFEST, manifest);
    }
    const code = {
      missing: "FILE_MISSING",
      extra: "EXTRA_FILE",
      changed: "FILE_HASH_MISMATCH",
      "unsafe path": "MANIFEST_PATHS_INVALID",
      "hard link": "UNSAFE_FILE",
      symlink: "UNSAFE_FILE",
      "file limit": "FILE_LIMIT",
      "duplicate JSON": "DOCUMENT_NOT_CANONICAL",
    }[mode];
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      integrity: "FAILED",
      integrityCode: code,
      computed: "NOT_EVALUATED",
      recorded: null,
      issues: mode === "missing" ? issues("MISSING_EVIDENCE", "BUNDLE") : [],
    });
  });

  it("AE3: genuine response redaction is limited but does not hide independently wrong claims", async () => {
    const { input } = await genuine("redact");
    const { outDir } = sealed(input);
    const exchange = read<Exchange>(outDir, "exchange-2.json");
    expect(exchange.response).toMatchObject({
      state: "REDACTED",
      originalSha256: digest(input.result.exchanges[1]!.body!),
    });
    expect(exchange.response.stored).toContain("[REDACTED]");
    expect(exchange.response.stored).not.toContain(ENDPOINT_SECRET);
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      computed: "ACQUIRED_LIMITED",
      recorded: { outcome: "ACQUIRED" },
      flags: FLAGS,
      issues: issues("LIMITED_BY_REDACTION", "SNAPSHOT_RESPONSE"),
    });
    rewrite<Exchange>(outDir, "exchange-2.json", (file) => {
      file.requestShape.minContextSlot = S1 - 1;
      replacePayload(file.request, file.request.stored.replace(String(S1), String(S1 - 1)));
    });
    rewrite<{ baseVaultRaw: { $bigint: string } }>(outDir, "adapter.json", (a) => {
      a.baseVaultRaw.$bigint = "1000000001";
    });
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      computed: "MISMATCH",
      issues: expect.arrayContaining([
        { status: "LIMITED_BY_REDACTION", link: "SNAPSHOT_RESPONSE" },
        { status: "MISMATCH", link: "SNAPSHOT_MIN_CONTEXT_SLOT" },
        { status: "MISMATCH", link: "ADAPTER_FROM_RETAINED_ACCOUNTS" },
      ]),
    });
  });

  it.each(["encoded", "encodedDuplicate"] as const)(
    "AE3: %s account credentials cannot survive inside response base64",
    async (mode) => {
      const { input, snapshotPool } = await genuine(mode);
      expect(input.result.outcome).toBe("ACQUIRED");
      const { outDir } = sealed(input);
      const response = read<Exchange>(outDir, "exchange-2.json").response;
      const rawResponse = input.result.exchanges[1]!.body!;
      expect(rawResponse.toString()).toContain(snapshotPool.toString("base64"));
      expect(rawResponse.includes(SECRET)).toBe(false);
      expect(persistedContainsSecret(outDir)).toBe(false);
      const { state, originalBytes, originalSha256 } = response;
      expect({ state, originalBytes, originalSha256 }).toEqual({
        state: "WITHHELD",
        originalBytes: rawResponse.length,
        originalSha256: digest(rawResponse),
      });
      if (mode === "encoded") {
        const account = read<{ data: Payload }[]>(outDir, "accounts.json")[0]!.data;
        expect(account).toMatchObject({ state: "REDACTED", originalSha256: digest(snapshotPool) });
        expect(Buffer.from(account.stored, account.encoding).includes(SECRET)).toBe(false);
      }
      for (const file of readdirSync(outDir)) {
        const body = readFileSync(path.join(outDir, file));
        expect(body.includes(SECRET)).toBe(false);
        expect(body.includes(snapshotPool.toString("base64"))).toBe(false);
      }
      expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
        integrity: "VERIFIED",
        computed: "ACQUIRED_LIMITED",
        issues: issues("MISSING_EVIDENCE", "SNAPSHOT_RESPONSE"),
      });
    },
  );

  it("AE3: absence of original bytes limits reproduction, yet response 2 can prove a different account digest", async () => {
    const { input } = await genuine();
    const { outDir } = sealed(input);
    rewrite<Exchange>(outDir, "exchange-1.json", (e) => {
      e.response = { state: "NOT_CAPTURED" } as Payload;
    });
    rewrite<{ data: Payload }[]>(outDir, "accounts.json", (rows) => {
      const { originalSha256, originalBytes } = rows[1]!.data;
      rows[1]!.data = { state: "WITHHELD", originalSha256, originalBytes } as Payload;
    });
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      computed: "ACQUIRED_LIMITED",
      derivedCode: "ACQUIRED",
      issues: expect.arrayContaining([
        { status: "MISSING_EVIDENCE", link: "DISCOVERY_RESPONSE" },
        { status: "MISSING_EVIDENCE", link: "VAULT0_DATA" },
      ]),
    });
    rewrite<{ data: Payload }[]>(outDir, "accounts.json", (rows) => {
      rows[1]!.data.originalSha256 = "0".repeat(64);
    });
    expect(verifyCpmmPoolAcquisitionEvidence(outDir)).toMatchObject({
      computed: "MISMATCH",
      issues: expect.arrayContaining([
        { status: "MISSING_EVIDENCE", link: "VAULT0_DATA" },
        { status: "MISMATCH", link: "VAULT0_DECODED_BYTES" },
      ]),
    });
  });

  it("AE3: refuses residual credentials in non-payload claims before touching output", async () => {
    const { input } = await genuine();
    expect(
      sealCpmmPoolAcquisitionEvidence({
        ...input,
        credentials: { urls: [], additional: [input.target.candidateMint] },
      }),
    ).toMatchObject({ ok: false, code: "RESIDUAL_CREDENTIAL" });
    expect(readdirSync(input.projectRoot)).toEqual([]);
  });

  it("bounds inputs and rejects malformed data without executing getters or proxy traps", async () => {
    const { input } = await genuine();
    const trap = vi.fn(() => {
      throw new Error("trap");
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const oversized = { ...input.result.exchanges[0]!, body: Buffer.alloc(16_385) };
    let deep: unknown = {};
    for (let i = 0; i < 30; i++) deep = { nested: deep };
    const cases = [
      [
        new Proxy(input, { get: trap, getPrototypeOf: trap, ownKeys: trap }),
        "UNSUPPORTED_STRUCTURE",
      ],
      [{ ...input, target: revoked.proxy }, "UNSUPPORTED_STRUCTURE"],
      [
        {
          ...input,
          get target() {
            return trap();
          },
        },
        "UNSUPPORTED_STRUCTURE",
      ],
      [{ ...input, result: { ...input.result, exchanges: [oversized] } }, "STRUCTURE_LIMIT"],
      [{ ...input, ledger: Array.from({ length: 257 }, () => input.ledger[0]) }, "INPUT_INVALID"],
      [
        { ...input, extra: Array.from({ length: 17 }, () => Buffer.alloc(16_384)) },
        "STRUCTURE_LIMIT",
      ],
      [
        {
          ...input,
          result: {
            ...input.result,
            exchanges: [
              {
                ...input.result.exchanges[0],
                body: new Uint8Array(new SharedArrayBuffer(4)),
              },
            ],
          },
        },
        "UNSUPPORTED_STRUCTURE",
      ],
      [{ ...input, deep }, "STRUCTURE_LIMIT"],
      [{ ...input, credentials: { urls: [], additional: [] } }, "CREDENTIAL_INPUT_INVALID"],
      [{ ...input, runId: "../outside" }, "INPUT_INVALID"],
      [{ ...input, result: { ...input.result, adapted: { ok: true } } }, "ADAPTER_INVALID"],
    ] as const;
    for (const [bad, code] of cases)
      expect(sealCpmmPoolAcquisitionEvidence(bad as SealCpmmPoolAcquisitionInput)).toMatchObject({
        ok: false,
        code,
      });
    expect(trap).not.toHaveBeenCalled();
    expect(readdirSync(input.projectRoot)).toEqual([]);
  });

  it.each([2, 8])(
    "never retries or claims to seal after a partial write at file %i",
    async (failAt) => {
      const { input } = await genuine();
      const names = [...FIXED, "exchange-1.json", "exchange-2.json", MANIFEST];
      let index = 0;
      const writer = vi.fn((fd: number, bytes: Buffer) => {
        if (++index === failAt) {
          writeFileSync(fd, bytes.subarray(0, 10));
          if (failAt === 2) throw new Error("injected failure after partial write");
          return; // silent short manifest write
        }
        writeFileSync(fd, bytes);
      });
      const dir = path.join(input.projectRoot, ...BASE, input.runId);
      expect(sealCpmmPoolAcquisitionEvidence(input, writer)).toMatchObject({
        ok: false,
        code: "WRITE_FAILED",
        outDir: dir,
        failedFile: names[failAt - 1],
        filesWritten: names.slice(0, failAt - 1),
      });
      expect(writer).toHaveBeenCalledTimes(failAt);
      expect(readFileSync(path.join(dir, names[failAt - 1]!))).toHaveLength(10);
      expect(verifyCpmmPoolAcquisitionEvidence(dir)).toMatchObject({
        integrity: "FAILED",
        computed: "NOT_EVALUATED",
      });
      expect(sealCpmmPoolAcquisitionEvidence(input, writer)).toMatchObject({
        ok: false,
        code: "OUTPUT_EXISTS",
      });
      expect(writer).toHaveBeenCalledTimes(failAt);
    },
  );
});
