#!/usr/bin/env node
/**
 * NeXusTrade — subscription-only capability check for the configured Solana WebSocket endpoint.
 *
 * It establishes only whether `SOLANA_WS_URL` accepts one fixed `logsSubscribe` for the reviewed
 * AMM v4 fee destination at `confirmed` commitment. It says nothing about pool availability, makes
 * no HTTP or RPC API call, decodes no transaction, derives no candidate, and never reaches
 * validation, a handoff or Stage B. There is no reconnect, retry, fallback or follow-up.
 *
 * Bounds (fixed):
 * - One connection; at most two outgoing application frames: the subscribe request, then one
 *   `logsUnsubscribe` for the acknowledged id while still permitted. No client keepalive ping.
 * - One absolute 5,000 ms acquisition deadline, started before the transport is constructed and
 *   covering connection setup and the acknowledgement; it is never reset (not on open, not on
 *   intermediate messages). The unsubscribe acknowledgement is awaited only within it.
 * - At most 10 incoming application messages and 64 KiB of cumulative incoming payload;
 *   notifications count against both and are never decoded.
 * - At most 5,000 ms of settled cleanup after termination.
 * Local sealing and verification run afterwards and are overhead outside those bounds.
 *
 * Success requires a strictly validated JSON-RPC acknowledgement for request id 1 with a valid
 * subscription id, received after the subscribe request and before the deadline, with no
 * cancellation (during the probe or before sealing) and with cleanup settled. An unsubscribe
 * acknowledgement is recorded as observed or unobserved; sending it proves nothing.
 *
 * Frames keep their original bytes: lengths and digests are taken at receipt, before any decoding,
 * and messages are decoded as strict UTF-8 (invalid UTF-8 is malformed protocol data). At sealing,
 * credentials are redacted at byte level before UTF-8 or base64 storage, and original and stored
 * accounting are recorded separately.
 *
 * Importing this module performs no I/O. Help and the default dry run load no configuration, open
 * no transport and write nothing; `--verify` reads a sealed run offline. Acquisition needs the
 * explicit `--live` flag and the explicitly configured SOLANA_WS_URL, and remains AWAITING
 * SEPARATE OPERATOR APPROVAL.
 *
 * Exit codes: 0 help, dry run, or a sealed (or verified) confirmed capability; 1 invalid input,
 * configuration or output location (nothing opened or written), or an unexpected error; 3 sealed
 * or verified with integrity but not confirmed; 4 integrity failure; 5 sealing failed.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import {
  WsWebSocketTransport,
  type ISolanaKeepaliveWebSocketTransport,
} from "../candidate-scanner/RaydiumTransportObservationProbe.js";
import { getWebSocketTransportReadyState } from "../candidate-scanner/CandidateDecisionDiagnostic.js";
import {
  buildEscapedSecretRegex,
  redactSensitiveText,
} from "../candidate-scanner/SolanaTrackerBundlerCaptureTool.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import { loadDaemonEnvironment } from "./paper-trading-daemon.js";
import {
  PRECHECK_APPROVAL_STATUS,
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
} from "./fresh-amm-v4-precheck.js";
import { resolveSolanaEndpoints } from "./paper-single-candidate-diagnostic.js";

// ---------------------------------------------------------------------------------------------
// Fixed protocol and limits
// ---------------------------------------------------------------------------------------------

export const CAPABILITY_ROOT_SEGMENTS = ["data", "research", "capability-checks"] as const;
export const CAPABILITY_MANIFEST_KIND = "PAPER_SOLANA_SUBSCRIPTION_CAPABILITY_MANIFEST" as const;
export const CAPABILITY_PROBE_KIND = "PAPER_SOLANA_SUBSCRIPTION_CAPABILITY_PROBE" as const;
export const CAPABILITY_EVIDENCE_VERSION = 1 as const;
export const CAPABILITY_FILES = Object.freeze({
  plan: "plan.json",
  probe: "probe.json",
  manifest: "evidence-manifest.json",
});

export const CAPABILITY_LIMITS = Object.freeze({
  connections: 1,
  reconnects: 0,
  retries: 0,
  acquisitionDeadlineMs: 5_000,
  cleanupTimeoutMs: 5_000,
  maxOutgoingFrames: 2,
  maxIncomingMessages: 10,
  maxIncomingPayloadBytes: 65_536,
  clientKeepalivePings: 0,
  httpRequests: 0,
});

export const SUBSCRIBE_REQUEST_ID = 1 as const;
export const UNSUBSCRIBE_REQUEST_ID = 2 as const;
/** The one subscribe request, byte for byte. */
export const SUBSCRIBE_FRAME = JSON.stringify({
  jsonrpc: "2.0",
  id: SUBSCRIBE_REQUEST_ID,
  method: "logsSubscribe",
  params: [{ mentions: [RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION] }, { commitment: "confirmed" }],
});
export const unsubscribeFrame = (subscriptionId: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: UNSUBSCRIBE_REQUEST_ID,
    method: "logsUnsubscribe",
    params: [subscriptionId],
  });

export type CapabilityOutcome =
  | "SUBSCRIPTION_ACKNOWLEDGED"
  | "SUBSCRIPTION_REJECTED"
  | "ACK_TIMEOUT"
  | "TRANSPORT_ERROR"
  | "TRANSPORT_CLOSED"
  | "MALFORMED_RESPONSE"
  | "MISMATCHED_RESPONSE_ID"
  | "MESSAGE_LIMIT_EXCEEDED"
  | "PAYLOAD_LIMIT_EXCEEDED"
  | "OPERATOR_CANCELLED";

export type CapabilityPhase = "CONNECTING" | "AWAITING_ACK" | "AWAITING_UNSUBSCRIBE_ACK";

export type UnsubscribeStatus =
  | "NOT_SENT"
  | "SENT_UNOBSERVED"
  | "OBSERVED"
  | "REJECTED"
  | "SEND_FAILED";

export interface CapabilityFrame {
  readonly seq: number;
  readonly direction: "OUTGOING" | "INCOMING";
  readonly atMs: number;
  /** Length of the original bytes, taken at receipt (or dispatch) before any decoding. */
  readonly byteLength: number;
  /** SHA-256 of the original bytes, taken at receipt (or dispatch) before any decoding. */
  readonly originalSha256: string;
  /** The original bytes; null when they were not retained (over a limit). */
  readonly bytes: Buffer | null;
  readonly overflow: null | "MESSAGE_LIMIT" | "PAYLOAD_LIMIT";
}

/** Where a cancellation was observed: during the probe, or after it settled and before sealing. */
export type CancellationPhase = "DURING_PROBE" | "BEFORE_SEALING";

export interface SubscriptionProbeResult {
  readonly outcome: CapabilityOutcome;
  readonly detail: string | null;
  readonly phaseAtEnd: CapabilityPhase;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly endedAtMs: number;
  readonly cleanupEndedAtMs: number;
  readonly transportCreated: boolean;
  readonly openedAtMs: number | null;
  readonly acknowledgement: {
    readonly subscriptionId: number;
    readonly receivedAtMs: number;
  } | null;
  readonly rejection: {
    readonly code: number;
    readonly message: string;
    readonly receivedAtMs: number;
  } | null;
  readonly unsubscribe: {
    readonly status: UnsubscribeStatus;
    readonly sentAtMs: number | null;
    readonly responseAtMs: number | null;
    readonly errorCode: number | null;
  };
  readonly frames: readonly CapabilityFrame[];
  readonly counts: {
    readonly incomingMessages: number;
    readonly incomingPayloadBytes: number;
    readonly outgoingFrames: number;
    readonly notifications: number;
    readonly clientPings: 0;
  };
  readonly cancelled: boolean;
  readonly cancellationPhase: CancellationPhase | null;
  readonly cleanup: {
    readonly settled: boolean;
    readonly failed: boolean;
    readonly forced: boolean;
    readonly reason: string | null;
  };
  readonly capabilityConfirmed: boolean;
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Pure message classification (shared by the probe and the offline verifier)
// ---------------------------------------------------------------------------------------------

export type ClassifiedMessage =
  | { readonly kind: "SUBSCRIBE_ACK"; readonly subscriptionId: number }
  | { readonly kind: "SUBSCRIBE_ERROR"; readonly code: number; readonly message: string }
  | { readonly kind: "UNSUBSCRIBE_ACK" }
  | { readonly kind: "UNSUBSCRIBE_REJECTED"; readonly code: number | null }
  | { readonly kind: "NOTIFICATION" }
  | { readonly kind: "MISMATCHED_ID" }
  | { readonly kind: "MALFORMED"; readonly reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Strict JSON-RPC 2.0 classification of one incoming message. A response is exactly
 * {jsonrpc, id, result} or {jsonrpc, id, error:{code, message[, data]}}. The subscribe result must
 * be a non-negative safe integer; the unsubscribe result must be a boolean. Notifications are
 * recognised by their method only; their parameters are never decoded.
 */
export function classifyIncoming(
  text: string,
  expect: { readonly unsubscribeSent: boolean },
): ClassifiedMessage {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return { kind: "MALFORMED", reason: "NOT_JSON" };
  }
  if (!isRecord(m)) return { kind: "MALFORMED", reason: "NOT_AN_OBJECT" };
  if (m.jsonrpc !== "2.0") return { kind: "MALFORMED", reason: "NOT_JSON_RPC_2_0" };
  const hasId = "id" in m;
  if (!hasId) {
    if (m.method === "logsNotification" && isRecord(m.params)) return { kind: "NOTIFICATION" };
    return { kind: "MALFORMED", reason: "UNEXPECTED_NOTIFICATION" };
  }
  if ("method" in m) return { kind: "MALFORMED", reason: "REQUEST_FROM_SERVER" };
  const keys = Object.keys(m).sort();
  const isResult = keys.join(",") === "id,jsonrpc,result";
  const isError = keys.join(",") === "error,id,jsonrpc";
  const errorOf = (): { code: number; message: string } | null => {
    const e = m.error;
    if (!isRecord(e) || !Number.isSafeInteger(e.code) || typeof e.message !== "string") return null;
    if (Object.keys(e).some((k) => k !== "code" && k !== "message" && k !== "data")) return null;
    return { code: e.code as number, message: e.message };
  };
  if (m.id === SUBSCRIBE_REQUEST_ID) {
    if (isResult) {
      const r = m.result;
      return typeof r === "number" && Number.isSafeInteger(r) && r >= 0
        ? { kind: "SUBSCRIBE_ACK", subscriptionId: r }
        : { kind: "MALFORMED", reason: "SUBSCRIPTION_ID_INVALID" };
    }
    if (isError) {
      const e = errorOf();
      return e ? { kind: "SUBSCRIBE_ERROR", ...e } : { kind: "MALFORMED", reason: "ERROR_INVALID" };
    }
    return { kind: "MALFORMED", reason: "RESPONSE_SHAPE_INVALID" };
  }
  if (m.id === UNSUBSCRIBE_REQUEST_ID && expect.unsubscribeSent) {
    if (isResult) {
      if (m.result === true) return { kind: "UNSUBSCRIBE_ACK" };
      if (m.result === false) return { kind: "UNSUBSCRIBE_REJECTED", code: null };
      return { kind: "MALFORMED", reason: "UNSUBSCRIBE_RESULT_INVALID" };
    }
    if (isError) {
      const e = errorOf();
      return e
        ? { kind: "UNSUBSCRIBE_REJECTED", code: e.code }
        : { kind: "MALFORMED", reason: "ERROR_INVALID" };
    }
    return { kind: "MALFORMED", reason: "RESPONSE_SHAPE_INVALID" };
  }
  return { kind: "MISMATCHED_ID" };
}

/** Strict UTF-8 decoding: null for any invalid sequence (never replacement characters). */
export function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Classification of the original bytes: invalid UTF-8 is malformed protocol data. */
export function classifyIncomingBytes(
  bytes: Uint8Array,
  expect: { readonly unsubscribeSent: boolean },
): ClassifiedMessage {
  const text = decodeStrictUtf8(bytes);
  return text === null
    ? { kind: "MALFORMED", reason: "INVALID_UTF8" }
    : classifyIncoming(text, expect);
}

// ---------------------------------------------------------------------------------------------
// The probe (injected transport, clock, timers and cancellation)
// ---------------------------------------------------------------------------------------------

export interface CapabilityTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SubscriptionProbeOptions {
  readonly wsUrl: string;
  readonly transportFactory: (url: string) => ISolanaKeepaliveWebSocketTransport;
  readonly clock?: (() => number) | undefined;
  readonly timers?: CapabilityTimers | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export function runSubscriptionProbe(
  o: SubscriptionProbeOptions,
): Promise<SubscriptionProbeResult> {
  const clock = o.clock ?? (() => Date.now());
  const timers: CapabilityTimers = o.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const L = CAPABILITY_LIMITS;
  // The absolute deadline starts here, before the transport is constructed; it is never reset.
  const startedAtMs = clock();
  const deadlineAtMs = startedAtMs + L.acquisitionDeadlineMs;

  return new Promise((resolve) => {
    const frames: CapabilityFrame[] = [];
    let phase: CapabilityPhase = "CONNECTING";
    let done = false;
    let outcome: CapabilityOutcome | null = null;
    let detail: string | null = null;
    let endedAtMs = startedAtMs;
    let transport: ISolanaKeepaliveWebSocketTransport | null = null;
    let openedAtMs: number | null = null;
    let acknowledgement: SubscriptionProbeResult["acknowledgement"] = null;
    let rejection: SubscriptionProbeResult["rejection"] = null;
    let unsubscribe: {
      -readonly [K in keyof SubscriptionProbeResult["unsubscribe"]]: SubscriptionProbeResult["unsubscribe"][K];
    } = {
      status: "NOT_SENT",
      sentAtMs: null,
      responseAtMs: null,
      errorCode: null,
    };
    let incomingMessages = 0;
    let incomingPayloadBytes = 0;
    let outgoingFrames = 0;
    let notifications = 0;
    let cancelled = false;
    const cleanup = { settled: false, failed: false, forced: false, reason: null as string | null };
    let deadlineTimer: unknown = null;
    let cleanupTimer: unknown = null;
    let resolved = false;
    /** Set before terminate(), whose close event may arrive synchronously. */
    let forcing = false;

    const onAbort = () => {
      cancelled = true;
      if (!done) finish("OPERATOR_CANCELLED", "Operator cancellation");
    };
    const detachAbort = () => o.abortSignal?.removeEventListener("abort", onAbort);

    const settle = (failed: boolean, forced: boolean, reason: string | null) => {
      if (resolved) return;
      resolved = true;
      if (cleanupTimer !== null) timers.clearTimeout(cleanupTimer);
      cleanupTimer = null;
      cleanup.settled = true;
      cleanup.failed = failed;
      cleanup.forced = forced;
      cleanup.reason = reason;
      detachAbort();
      const cleanupEndedAtMs = clock();
      const reasons: string[] = [];
      const finalOutcome = outcome as CapabilityOutcome;
      if (finalOutcome !== "SUBSCRIPTION_ACKNOWLEDGED") reasons.push(`OUTCOME:${finalOutcome}`);
      if (cancelled) reasons.push("CANCELLED");
      if (cleanup.failed) reasons.push("CLEANUP_FAILED");
      resolve({
        outcome: finalOutcome,
        detail,
        phaseAtEnd: phase,
        startedAtMs,
        deadlineAtMs,
        endedAtMs,
        cleanupEndedAtMs,
        transportCreated: transport !== null,
        openedAtMs,
        acknowledgement,
        rejection,
        unsubscribe: { ...unsubscribe },
        frames: frames.map((f) => ({ ...f })),
        counts: {
          incomingMessages,
          incomingPayloadBytes,
          outgoingFrames,
          notifications,
          clientPings: 0,
        },
        cancelled,
        cancellationPhase: cancelled ? "DURING_PROBE" : null,
        cleanup: { ...cleanup },
        capabilityConfirmed: reasons.length === 0,
        reasons,
      });
    };
    const isClosed = () => transport === null || getWebSocketTransportReadyState(transport) === 3;

    /** Terminates once; then closes and waits at most the cleanup ceiling for the close. */
    function finish(result: CapabilityOutcome, why: string | null) {
      if (done) return;
      done = true;
      outcome = result;
      detail = why;
      endedAtMs = clock();
      if (deadlineTimer !== null) timers.clearTimeout(deadlineTimer);
      deadlineTimer = null;
      if (isClosed()) {
        settle(false, false, null);
        return;
      }
      cleanupTimer = timers.setTimeout(() => {
        cleanupTimer = null;
        forcing = true;
        try {
          transport?.terminate?.();
        } catch {
          // Reported below if the transport is still open.
        }
        if (isClosed()) settle(false, true, null);
        else settle(true, true, `Transport did not close within ${L.cleanupTimeoutMs} ms`);
      }, L.cleanupTimeoutMs);
      try {
        transport?.close(1000, "capability check complete");
      } catch (err) {
        cleanup.reason = `close threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (isClosed()) settle(false, false, null);
    }

    const send = (text: string): boolean => {
      if (outgoingFrames >= L.maxOutgoingFrames || transport === null) return false;
      try {
        transport.send(text);
      } catch (err) {
        finish(
          "TRANSPORT_ERROR",
          `send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
      outgoingFrames++;
      const bytes = Buffer.from(text, "utf8");
      frames.push({
        seq: frames.length + 1,
        direction: "OUTGOING",
        atMs: clock(),
        byteLength: bytes.length,
        originalSha256: sha256(bytes),
        bytes,
        overflow: null,
      });
      return true;
    };

    const onOpen = () => {
      if (done || openedAtMs !== null) return;
      openedAtMs = clock();
      if (clock() >= deadlineAtMs) return; // the deadline timer decides
      phase = "AWAITING_ACK";
      send(SUBSCRIBE_FRAME);
    };

    const onMessage = (data: string | Buffer) => {
      if (done) return;
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      incomingMessages++;
      incomingPayloadBytes += bytes.length;
      const atMs = clock();
      const overflow =
        incomingMessages > L.maxIncomingMessages
          ? ("MESSAGE_LIMIT" as const)
          : incomingPayloadBytes > L.maxIncomingPayloadBytes
            ? ("PAYLOAD_LIMIT" as const)
            : null;
      // Length and digest of the original bytes, before any decoding.
      frames.push({
        seq: frames.length + 1,
        direction: "INCOMING",
        atMs,
        byteLength: bytes.length,
        originalSha256: sha256(bytes),
        bytes: overflow === null ? bytes : null,
        overflow,
      });
      if (overflow === "MESSAGE_LIMIT") {
        finish("MESSAGE_LIMIT_EXCEEDED", `More than ${L.maxIncomingMessages} incoming messages`);
        return;
      }
      if (overflow === "PAYLOAD_LIMIT") {
        finish("PAYLOAD_LIMIT_EXCEEDED", `More than ${L.maxIncomingPayloadBytes} incoming bytes`);
        return;
      }
      if (atMs >= deadlineAtMs) return; // the deadline timer decides
      const c = classifyIncomingBytes(bytes, {
        unsubscribeSent: unsubscribe.status !== "NOT_SENT",
      });
      switch (c.kind) {
        case "NOTIFICATION":
          notifications++;
          return;
        case "SUBSCRIBE_ACK":
          if (phase !== "AWAITING_ACK") {
            finish("MALFORMED_RESPONSE", "Unexpected subscribe response");
            return;
          }
          acknowledgement = { subscriptionId: c.subscriptionId, receivedAtMs: atMs };
          phase = "AWAITING_UNSUBSCRIBE_ACK";
          if (!o.abortSignal?.aborted && clock() < deadlineAtMs && !isClosed()) {
            if (send(unsubscribeFrame(c.subscriptionId))) {
              const sentAtMs = (frames[frames.length - 1] as CapabilityFrame).atMs;
              unsubscribe = { ...unsubscribe, status: "SENT_UNOBSERVED", sentAtMs };
            } else if (!done) {
              unsubscribe = { ...unsubscribe, status: "SEND_FAILED" };
            }
          }
          if (!done && unsubscribe.status !== "SENT_UNOBSERVED") {
            finish("SUBSCRIPTION_ACKNOWLEDGED", null);
          }
          return;
        case "SUBSCRIBE_ERROR":
          if (phase !== "AWAITING_ACK") {
            finish("MALFORMED_RESPONSE", "Unexpected subscribe response");
            return;
          }
          rejection = { code: c.code, message: c.message, receivedAtMs: atMs };
          finish("SUBSCRIPTION_REJECTED", `JSON-RPC error ${c.code}`);
          return;
        case "UNSUBSCRIBE_ACK":
          unsubscribe = { ...unsubscribe, status: "OBSERVED", responseAtMs: atMs };
          finish("SUBSCRIPTION_ACKNOWLEDGED", null);
          return;
        case "UNSUBSCRIBE_REJECTED":
          unsubscribe = {
            ...unsubscribe,
            status: "REJECTED",
            responseAtMs: atMs,
            errorCode: c.code,
          };
          finish("SUBSCRIPTION_ACKNOWLEDGED", null);
          return;
        case "MISMATCHED_ID":
          finish("MISMATCHED_RESPONSE_ID", "A response id matched no pending request");
          return;
        default:
          finish("MALFORMED_RESPONSE", c.reason);
      }
    };

    // Arm the absolute deadline before anything else can happen.
    deadlineTimer = timers.setTimeout(() => {
      deadlineTimer = null;
      if (phase === "AWAITING_UNSUBSCRIBE_ACK") finish("SUBSCRIPTION_ACKNOWLEDGED", null);
      else finish("ACK_TIMEOUT", `Acquisition deadline reached while ${phase}`);
    }, L.acquisitionDeadlineMs);
    if (o.abortSignal?.aborted) {
      cancelled = true;
      finish("OPERATOR_CANCELLED", "Operator cancellation before the transport was created");
      return;
    }
    o.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      transport = o.transportFactory(o.wsUrl);
    } catch (err) {
      finish(
        "TRANSPORT_ERROR",
        `transport construction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const t = transport;
    t.on("open", onOpen);
    t.on("message", onMessage);
    t.on("error", (err: Error) => {
      if (!done) finish("TRANSPORT_ERROR", err instanceof Error ? err.message : String(err));
    });
    t.on("close", (code: number) => {
      if (!done) finish("TRANSPORT_CLOSED", `Transport closed (code ${code})`);
      else if (!resolved && isClosed()) settle(false, forcing, null);
    });
    if (getWebSocketTransportReadyState(t) === 1) onOpen();
  });
}

// ---------------------------------------------------------------------------------------------
// Sealing (exclusive create; reviewed redaction primitive) and offline verification
// ---------------------------------------------------------------------------------------------

/** Credential values to redact from both configured URLs (the sealer's literal-value rule). */
export function credentialSecrets(urls: readonly string[]): string[] {
  const secrets = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    secrets.add(raw);
    try {
      const u = new URL(raw);
      if (u.username) secrets.add(u.username);
      if (u.password) secrets.add(u.password);
      for (const v of u.searchParams.values()) if (v.length >= 6) secrets.add(v);
      for (const seg of u.pathname.split("/")) if (seg.length >= 16) secrets.add(seg);
    } catch {
      // Not a URL: the whole value is the secret.
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/**
 * Byte-level credential redaction (the reviewed sealers' pattern): bytes are mapped one-to-one to
 * Latin-1, each secret's UTF-8 bytes are replaced in literal and `\u00XX`-escaped form with the
 * reviewed `buildEscapedSecretRegex`, and the result is mapped back. No keyword heuristics, so
 * protocol bytes without a credential are never altered.
 */
export function redactCredentialBytes(bytes: Buffer, secrets: readonly string[]): Buffer {
  let text = bytes.toString("latin1");
  for (const s of secrets) {
    if (s.length < 4) continue;
    const latin1 = Buffer.from(s, "utf8").toString("latin1");
    text = text.split(latin1).join("[REDACTED]");
    try {
      text = text.replace(buildEscapedSecretRegex(latin1), "[REDACTED]");
    } catch {
      // A secret that cannot form a pattern is still replaced literally above.
    }
  }
  return Buffer.from(text, "latin1");
}

export type CapabilityFileWriter = (
  file: string,
  content: string,
  options: { readonly encoding: "utf8"; readonly flag: "wx" },
) => void;

export type SealCapabilityResult =
  | { readonly ok: true; readonly outDir: string; readonly manifestSha256: string }
  | {
      readonly ok: false;
      readonly status: "OUTPUT_DIRECTORY_UNAVAILABLE" | "SEAL_REFUSED" | "ARTIFACT_WRITE_FAILED";
      readonly reason: string;
    };

export function sealSubscriptionCapabilityEvidence(input: {
  readonly outDir: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly result: SubscriptionProbeResult;
  readonly secrets: readonly string[];
  readonly writeFile?: CapabilityFileWriter | undefined;
}): SealCapabilityResult {
  const redact = (t: string) => redactSensitiveText(t, input.secrets);
  const r = input.result;
  // Original accounting (taken at receipt) and stored accounting (after byte-level redaction) are
  // kept apart; the stored bytes are UTF-8 text when valid UTF-8, otherwise base64.
  let residual = false;
  const frames = r.frames.map((f) => {
    const base = {
      seq: f.seq,
      direction: f.direction,
      atMs: f.atMs,
      originalBytes: f.byteLength,
      originalSha256: f.originalSha256,
      overflow: f.overflow,
    };
    if (f.bytes === null) {
      return {
        ...base,
        storedEncoding: null,
        storedBytes: null,
        storedSha256: null,
        payload: null,
        payloadRedacted: false,
      };
    }
    const stored = redactCredentialBytes(f.bytes, input.secrets);
    for (const secret of input.secrets) {
      if (secret.length >= 4 && stored.includes(Buffer.from(secret, "utf8"))) residual = true;
    }
    const text = decodeStrictUtf8(stored);
    return {
      ...base,
      storedEncoding: text === null ? "base64" : "utf8",
      storedBytes: stored.length,
      storedSha256: sha256(stored),
      payload: text ?? stored.toString("base64"),
      payloadRedacted: !stored.equals(f.bytes),
    };
  });
  const probe = {
    kind: CAPABILITY_PROBE_KIND,
    version: CAPABILITY_EVIDENCE_VERSION,
    endpoint: "SOLANA_WS_URL (configuration; never recorded)",
    limits: CAPABILITY_LIMITS,
    subscribeFrame: SUBSCRIBE_FRAME,
    ...r,
    detail: r.detail === null ? null : redact(r.detail),
    rejection:
      r.rejection === null ? null : { ...r.rejection, message: redact(r.rejection.message) },
    cleanup: { ...r.cleanup, reason: r.cleanup.reason === null ? null : redact(r.cleanup.reason) },
    frames,
  };
  if (residual) {
    return {
      ok: false,
      status: "SEAL_REFUSED",
      reason: "a credential would be persisted in a stored frame",
    };
  }
  const contents: [string, string][] = [
    [CAPABILITY_FILES.plan, redact(JSON.stringify(input.plan, null, 2)) + "\n"],
    [CAPABILITY_FILES.probe, redact(JSON.stringify(probe, null, 2)) + "\n"],
  ];
  for (const [name, text] of contents) {
    for (const s of input.secrets) {
      if (s.length >= 4 && text.includes(s)) {
        return {
          ok: false,
          status: "SEAL_REFUSED",
          reason: `a credential would be persisted in ${name}`,
        };
      }
    }
  }
  try {
    mkdirSync(path.dirname(input.outDir), { recursive: true });
    mkdirSync(input.outDir);
  } catch (err) {
    return {
      ok: false,
      status: "OUTPUT_DIRECTORY_UNAVAILABLE",
      reason: redact(err instanceof Error ? err.message : String(err)),
    };
  }
  const write = input.writeFile ?? ((f, c, opts) => writeFileSync(f, c, opts));
  try {
    const files = contents.map(([name, text]) => {
      write(path.join(input.outDir, name), text, { encoding: "utf8", flag: "wx" });
      return { path: name, sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") };
    });
    const manifest =
      JSON.stringify(
        {
          kind: CAPABILITY_MANIFEST_KIND,
          version: CAPABILITY_EVIDENCE_VERSION,
          outcome: r.outcome,
          capabilityConfirmed: r.capabilityConfirmed,
          files,
        },
        null,
        2,
      ) + "\n";
    write(path.join(input.outDir, CAPABILITY_FILES.manifest), manifest, {
      encoding: "utf8",
      flag: "wx",
    });
    return { ok: true, outDir: input.outDir, manifestSha256: sha256(manifest) };
  } catch (err) {
    return {
      ok: false,
      status: "ARTIFACT_WRITE_FAILED",
      reason: redact(err instanceof Error ? err.message : String(err)),
    };
  }
}

export interface CapabilityVerification {
  readonly integrity: { readonly ok: boolean; readonly problems: readonly string[] };
  readonly outcome: CapabilityOutcome | null;
  readonly capabilityConfirmed: boolean;
  readonly subscriptionId: number | null;
  readonly manifestSha256: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const isSafeTime = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isSafeCount = isSafeTime;
const OUTCOMES: readonly string[] = [
  "SUBSCRIPTION_ACKNOWLEDGED",
  "SUBSCRIPTION_REJECTED",
  "ACK_TIMEOUT",
  "TRANSPORT_ERROR",
  "TRANSPORT_CLOSED",
  "MALFORMED_RESPONSE",
  "MISMATCHED_RESPONSE_ID",
  "MESSAGE_LIMIT_EXCEEDED",
  "PAYLOAD_LIMIT_EXCEEDED",
  "OPERATOR_CANCELLED",
];
const UNSUBSCRIBE_STATUSES: readonly string[] = [
  "NOT_SENT",
  "SENT_UNOBSERVED",
  "OBSERVED",
  "REJECTED",
  "SEND_FAILED",
];

interface StoredFrame {
  readonly seq: number;
  readonly direction: "OUTGOING" | "INCOMING";
  readonly atMs: number;
  readonly originalBytes: number;
  readonly overflow: null | "MESSAGE_LIMIT" | "PAYLOAD_LIMIT";
  /** The stored bytes (after redaction); null for an over-limit frame. */
  readonly stored: Buffer | null;
  readonly redacted: boolean;
}

/**
 * Schema, digest and byte accounting of one sealed frame. Returns the frame, or a problem.
 * An unredacted frame's stored bytes must be exactly its original bytes (length and digest).
 */
function storedFrame(raw: unknown, index: number, startedAtMs: number): StoredFrame | string {
  const bad = (what: string) => `FRAME_INVALID:${index + 1}:${what}`;
  if (!isRecord(raw)) return bad("NOT_AN_OBJECT");
  if (raw.seq !== index + 1) return bad("SEQ");
  if (raw.direction !== "OUTGOING" && raw.direction !== "INCOMING") return bad("DIRECTION");
  if (!isSafeTime(raw.atMs) || raw.atMs < startedAtMs) return bad("TIME");
  if (!isSafeCount(raw.originalBytes)) return bad("ORIGINAL_BYTES");
  if (typeof raw.originalSha256 !== "string" || !HEX64.test(raw.originalSha256)) {
    return bad("ORIGINAL_DIGEST");
  }
  const overflow = raw.overflow;
  if (overflow !== null && overflow !== "MESSAGE_LIMIT" && overflow !== "PAYLOAD_LIMIT") {
    return bad("OVERFLOW");
  }
  if (overflow !== null && raw.direction === "OUTGOING") return bad("OVERFLOW");
  if (typeof raw.payloadRedacted !== "boolean") return bad("REDACTION_FLAG");
  const base = {
    seq: raw.seq,
    direction: raw.direction,
    atMs: raw.atMs,
    originalBytes: raw.originalBytes,
    overflow,
  } as const;
  if (overflow !== null) {
    if (
      raw.payload !== null ||
      raw.storedEncoding !== null ||
      raw.storedBytes !== null ||
      raw.storedSha256 !== null ||
      raw.payloadRedacted !== false
    ) {
      return bad("OVERFLOW_PAYLOAD_RETAINED");
    }
    return { ...base, stored: null, redacted: false };
  }
  if (typeof raw.payload !== "string") return bad("PAYLOAD");
  let stored: Buffer;
  if (raw.storedEncoding === "utf8") {
    stored = Buffer.from(raw.payload, "utf8");
  } else if (raw.storedEncoding === "base64") {
    stored = Buffer.from(raw.payload, "base64");
    if (stored.toString("base64") !== raw.payload) return bad("BASE64_NOT_CANONICAL");
    if (decodeStrictUtf8(stored) !== null) return bad("BASE64_FOR_TEXT");
  } else {
    return bad("ENCODING");
  }
  if (raw.storedBytes !== stored.length) return bad("STORED_BYTES");
  if (raw.storedSha256 !== sha256(stored)) return bad("STORED_DIGEST");
  if (raw.payloadRedacted === false) {
    if (stored.length !== raw.originalBytes || raw.storedSha256 !== raw.originalSha256) {
      return bad("UNREDACTED_DIFFERS_FROM_ORIGINAL");
    }
  } else if (raw.storedSha256 === raw.originalSha256) {
    return bad("REDACTION_FLAG");
  }
  return { ...base, stored, redacted: raw.payloadRedacted };
}

interface Replay {
  readonly problems: string[];
  readonly subscribeAtMs: number | null;
  readonly ack: { subscriptionId: number; receivedAtMs: number } | null;
  readonly rejection: { code: number; message: string; receivedAtMs: number } | null;
  readonly unsubscribe: {
    status: UnsubscribeStatus;
    sentAtMs: number | null;
    responseAtMs: number | null;
    errorCode: number | null;
  };
  readonly counts: {
    incomingMessages: number;
    incomingPayloadBytes: number;
    outgoingFrames: number;
    notifications: number;
  };
  /** The outcome the frames themselves decide, if any. */
  readonly terminal: CapabilityOutcome | null;
  readonly decisiveRedacted: boolean;
  readonly lastAtMs: number | null;
}

/**
 * Replays the sealed frames in order with the probe's own rules: the exact subscribe request
 * first (after the transport opened, before the deadline), an acknowledgement only after it, the
 * unsubscribe only for the acknowledged id, nothing after a terminating frame, and the fixed
 * incoming limits. Frames at or after the deadline are counted but decide nothing.
 */
function replayFrames(
  frames: readonly StoredFrame[],
  startedAtMs: number,
  openedAtMs: number | null,
): Replay {
  const L = CAPABILITY_LIMITS;
  const deadlineAtMs = startedAtMs + L.acquisitionDeadlineMs;
  const problems: string[] = [];
  let subscribeAtMs: number | null = null;
  let ack: Replay["ack"] = null;
  let rejection: Replay["rejection"] = null;
  const unsubscribe: Replay["unsubscribe"] = {
    status: "NOT_SENT",
    sentAtMs: null,
    responseAtMs: null,
    errorCode: null,
  };
  const counts = {
    incomingMessages: 0,
    incomingPayloadBytes: 0,
    outgoingFrames: 0,
    notifications: 0,
  };
  let terminal: CapabilityOutcome | null = null;
  let awaitingUnsubscribeDecision = false;
  let decisiveRedacted = false;
  let previousAtMs = startedAtMs;
  for (const f of frames) {
    if (f.atMs < previousAtMs) problems.push(`FRAME_ORDER_INVALID:${f.seq}`);
    previousAtMs = f.atMs;
    if (terminal !== null) {
      problems.push(`FRAME_AFTER_TERMINATION:${f.seq}`);
      break;
    }
    if (awaitingUnsubscribeDecision) {
      awaitingUnsubscribeDecision = false;
      if (f.direction !== "OUTGOING") {
        // The probe ends at once when it does not send the unsubscribe.
        terminal = "SUBSCRIPTION_ACKNOWLEDGED";
        problems.push(`FRAME_AFTER_TERMINATION:${f.seq}`);
        break;
      }
    }
    if (f.direction === "OUTGOING") {
      counts.outgoingFrames++;
      const text = f.stored === null || f.redacted ? null : decodeStrictUtf8(f.stored);
      if (counts.outgoingFrames === 1) {
        if (
          text !== SUBSCRIBE_FRAME ||
          openedAtMs === null ||
          f.atMs < openedAtMs ||
          f.atMs >= deadlineAtMs
        ) {
          problems.push("SUBSCRIBE_REQUEST_INVALID");
        }
        subscribeAtMs = f.atMs;
      } else if (counts.outgoingFrames === 2) {
        if (
          ack === null ||
          unsubscribe.status !== "NOT_SENT" ||
          text !== unsubscribeFrame(ack.subscriptionId) ||
          f.atMs < ack.receivedAtMs ||
          f.atMs >= deadlineAtMs
        ) {
          problems.push("UNSUBSCRIBE_REQUEST_INVALID");
        }
        unsubscribe.status = "SENT_UNOBSERVED";
        unsubscribe.sentAtMs = f.atMs;
      } else {
        problems.push("TOO_MANY_OUTGOING_FRAMES");
      }
      continue;
    }
    counts.incomingMessages++;
    counts.incomingPayloadBytes += f.originalBytes;
    const expectedOverflow =
      counts.incomingMessages > L.maxIncomingMessages
        ? "MESSAGE_LIMIT"
        : counts.incomingPayloadBytes > L.maxIncomingPayloadBytes
          ? "PAYLOAD_LIMIT"
          : null;
    if (f.overflow !== expectedOverflow) problems.push(`OVERFLOW_ACCOUNTING_INVALID:${f.seq}`);
    if (expectedOverflow !== null) {
      terminal =
        expectedOverflow === "MESSAGE_LIMIT" ? "MESSAGE_LIMIT_EXCEEDED" : "PAYLOAD_LIMIT_EXCEEDED";
      continue;
    }
    if (f.atMs >= deadlineAtMs || f.stored === null) continue;
    const c = classifyIncomingBytes(f.stored, {
      unsubscribeSent: unsubscribe.status !== "NOT_SENT",
    });
    if (f.redacted && c.kind !== "NOTIFICATION") decisiveRedacted = true;
    switch (c.kind) {
      case "NOTIFICATION":
        counts.notifications++;
        break;
      case "SUBSCRIBE_ACK":
        if (
          subscribeAtMs === null ||
          ack !== null ||
          rejection !== null ||
          f.atMs < subscribeAtMs
        ) {
          terminal = "MALFORMED_RESPONSE";
        } else {
          ack = { subscriptionId: c.subscriptionId, receivedAtMs: f.atMs };
          awaitingUnsubscribeDecision = true;
        }
        break;
      case "SUBSCRIBE_ERROR":
        if (
          subscribeAtMs === null ||
          ack !== null ||
          rejection !== null ||
          f.atMs < subscribeAtMs
        ) {
          terminal = "MALFORMED_RESPONSE";
        } else {
          rejection = { code: c.code, message: c.message, receivedAtMs: f.atMs };
          terminal = "SUBSCRIPTION_REJECTED";
        }
        break;
      case "UNSUBSCRIBE_ACK":
        unsubscribe.status = "OBSERVED";
        unsubscribe.responseAtMs = f.atMs;
        terminal = "SUBSCRIPTION_ACKNOWLEDGED";
        break;
      case "UNSUBSCRIBE_REJECTED":
        unsubscribe.status = "REJECTED";
        unsubscribe.responseAtMs = f.atMs;
        unsubscribe.errorCode = c.code;
        terminal = "SUBSCRIPTION_ACKNOWLEDGED";
        break;
      case "MISMATCHED_ID":
        terminal = "MISMATCHED_RESPONSE_ID";
        break;
      default:
        terminal = "MALFORMED_RESPONSE";
    }
  }
  if (awaitingUnsubscribeDecision) terminal = "SUBSCRIPTION_ACKNOWLEDGED";
  return {
    problems,
    subscribeAtMs,
    ack,
    rejection,
    unsubscribe,
    counts,
    terminal,
    decisiveRedacted,
    lastAtMs: frames.length > 0 ? (frames[frames.length - 1] as StoredFrame).atMs : null,
  };
}

/**
 * Fail-closed offline verification: integrity of the sealed files, then the complete, ordered
 * proof re-derived from the sealed frames, and every recorded fact, time, counter and digest
 * checked against it. Malformed records are verification failures; nothing here throws.
 */
export function verifySubscriptionCapabilityEvidence(dir: string): CapabilityVerification {
  const problems: string[] = [];
  let manifestSha256: string | null = null;
  const fail = (): CapabilityVerification => ({
    integrity: { ok: false, problems: [...problems] },
    outcome: null,
    capabilityConfirmed: false,
    subscriptionId: null,
    manifestSha256,
  });
  try {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) problems.push("OUTPUT_DIRECTORY_INVALID");
    } catch {
      problems.push("OUTPUT_DIRECTORY_MISSING");
    }
    if (problems.length > 0) return fail();
    let manifest: unknown;
    try {
      const manifestBytes = readFileSync(path.join(dir, CAPABILITY_FILES.manifest));
      manifestSha256 = sha256(manifestBytes);
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      problems.push("MANIFEST_MISSING_OR_INVALID");
      return fail();
    }
    if (
      !isRecord(manifest) ||
      manifest.kind !== CAPABILITY_MANIFEST_KIND ||
      manifest.version !== CAPABILITY_EVIDENCE_VERSION ||
      !Array.isArray(manifest.files)
    ) {
      problems.push("MANIFEST_KIND_INVALID");
      return fail();
    }
    const expected: readonly string[] = [CAPABILITY_FILES.plan, CAPABILITY_FILES.probe];
    const entries = manifest.files as unknown[];
    if (
      entries.length !== expected.length ||
      entries.some(
        (f, i) =>
          !isRecord(f) ||
          f.path !== expected[i] ||
          typeof f.sha256 !== "string" ||
          !HEX64.test(f.sha256) ||
          !isSafeCount(f.bytes),
      )
    ) {
      problems.push("MANIFEST_FILES_INVALID");
      return fail();
    }
    for (const name of readdirSync(dir)) {
      const st = lstatSync(path.join(dir, name));
      if (st.isSymbolicLink() || !st.isFile()) problems.push(`UNEXPECTED_ENTRY:${name}`);
      else if (name !== CAPABILITY_FILES.manifest && !expected.includes(name)) {
        problems.push(`UNLISTED:${name}`);
      }
    }
    const texts = new Map<string, Buffer>();
    for (const f of entries as Record<string, unknown>[]) {
      const name = f.path as string;
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.join(dir, name));
      } catch {
        problems.push(`MISSING:${name}`);
        continue;
      }
      if (sha256(bytes) !== f.sha256 || bytes.length !== f.bytes) {
        problems.push(`MODIFIED:${name}`);
        continue;
      }
      texts.set(name, bytes);
    }
    if (problems.length > 0) return fail();

    let p: unknown;
    try {
      JSON.parse((texts.get(CAPABILITY_FILES.plan) as Buffer).toString("utf8"));
      p = JSON.parse((texts.get(CAPABILITY_FILES.probe) as Buffer).toString("utf8"));
    } catch {
      problems.push("EVIDENCE_NOT_JSON");
      return fail();
    }
    if (
      !isRecord(p) ||
      p.kind !== CAPABILITY_PROBE_KIND ||
      p.version !== CAPABILITY_EVIDENCE_VERSION
    ) {
      problems.push("PROBE_KIND_INVALID");
      return fail();
    }
    if (JSON.stringify(p.limits) !== JSON.stringify(CAPABILITY_LIMITS))
      problems.push("LIMITS_MISMATCH");
    if (p.subscribeFrame !== SUBSCRIBE_FRAME) problems.push("SUBSCRIBE_FRAME_RECORD_INVALID");
    const outcome = p.outcome;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
      problems.push("OUTCOME_INVALID");
      return fail();
    }
    if (manifest.outcome !== outcome || manifest.capabilityConfirmed !== p.capabilityConfirmed) {
      problems.push("MANIFEST_SUMMARY_MISMATCH");
    }

    // Times.
    const startedAtMs = p.startedAtMs;
    if (!isSafeTime(startedAtMs)) {
      problems.push("TIMES_INVALID:START");
      return fail();
    }
    const deadlineAtMs = startedAtMs + CAPABILITY_LIMITS.acquisitionDeadlineMs;
    const openedAtMs = p.openedAtMs === null ? null : p.openedAtMs;
    if (p.deadlineAtMs !== deadlineAtMs) problems.push("TIMES_INVALID:DEADLINE");
    if (openedAtMs !== null && (!isSafeTime(openedAtMs) || openedAtMs < startedAtMs)) {
      problems.push("TIMES_INVALID:OPENED");
    }
    if (!isSafeTime(p.endedAtMs) || p.endedAtMs < startedAtMs) problems.push("TIMES_INVALID:ENDED");
    if (
      !isSafeTime(p.cleanupEndedAtMs) ||
      !isSafeTime(p.endedAtMs) ||
      p.cleanupEndedAtMs < p.endedAtMs ||
      p.cleanupEndedAtMs > p.endedAtMs + CAPABILITY_LIMITS.cleanupTimeoutMs
    ) {
      problems.push("TIMES_INVALID:CLEANUP");
    }

    // Frames: schema, digests and byte accounting, then the ordered replay.
    if (!Array.isArray(p.frames)) {
      problems.push("FRAMES_INVALID");
      return fail();
    }
    const frames: StoredFrame[] = [];
    for (const [i, raw] of (p.frames as unknown[]).entries()) {
      const f = storedFrame(raw, i, startedAtMs);
      if (typeof f === "string") problems.push(f);
      else frames.push(f);
    }
    if (problems.length > 0) return fail();
    const replay = replayFrames(frames, startedAtMs, openedAtMs as number | null);
    problems.push(...replay.problems);
    if (replay.lastAtMs !== null && isSafeTime(p.endedAtMs) && p.endedAtMs < replay.lastAtMs) {
      problems.push("TIMES_INVALID:ENDED_BEFORE_LAST_FRAME");
    }
    if (frames.length > 0 && p.transportCreated !== true) problems.push("TRANSPORT_RECORD_INVALID");
    if (openedAtMs !== null && p.transportCreated !== true)
      problems.push("TRANSPORT_RECORD_INVALID");

    // Recorded facts against the replay.
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const ack = p.acknowledgement;
    if (
      !same(
        ack === null
          ? null
          : isRecord(ack)
            ? { subscriptionId: ack.subscriptionId, receivedAtMs: ack.receivedAtMs }
            : ack,
        replay.ack,
      ) ||
      (isRecord(ack) && Object.keys(ack).length !== 2)
    ) {
      problems.push("ACKNOWLEDGEMENT_MISMATCH");
    }
    const rej = p.rejection;
    if (
      (rej === null) !== (replay.rejection === null) ||
      (isRecord(rej) &&
        replay.rejection !== null &&
        (rej.code !== replay.rejection.code ||
          rej.receivedAtMs !== replay.rejection.receivedAtMs ||
          (!replay.decisiveRedacted && rej.message !== replay.rejection.message))) ||
      (rej !== null && !isRecord(rej))
    ) {
      problems.push("REJECTION_MISMATCH");
    }
    const unsub = isRecord(p.unsubscribe) ? p.unsubscribe : null;
    const statusMatches =
      unsub !== null &&
      typeof unsub.status === "string" &&
      UNSUBSCRIBE_STATUSES.includes(unsub.status) &&
      (unsub.status === replay.unsubscribe.status ||
        (unsub.status === "SEND_FAILED" &&
          replay.unsubscribe.status === "NOT_SENT" &&
          replay.ack !== null));
    if (
      !statusMatches ||
      unsub?.sentAtMs !== replay.unsubscribe.sentAtMs ||
      unsub?.responseAtMs !== replay.unsubscribe.responseAtMs ||
      unsub?.errorCode !== replay.unsubscribe.errorCode
    ) {
      problems.push("UNSUBSCRIBE_MISMATCH");
    }
    if (
      !same(p.counts, {
        incomingMessages: replay.counts.incomingMessages,
        incomingPayloadBytes: replay.counts.incomingPayloadBytes,
        outgoingFrames: replay.counts.outgoingFrames,
        notifications: replay.counts.notifications,
        clientPings: 0,
      })
    ) {
      problems.push("COUNTS_MISMATCH");
    }

    // The outcome must follow from the frames.
    const endedAtDeadline = isSafeTime(p.endedAtMs) && p.endedAtMs >= deadlineAtMs;
    const outcomeReproduced =
      replay.terminal !== null
        ? outcome === replay.terminal
        : outcome === "ACK_TIMEOUT"
          ? replay.ack === null && endedAtDeadline
          : outcome === "SUBSCRIPTION_ACKNOWLEDGED"
            ? replay.ack !== null &&
              replay.unsubscribe.status === "SENT_UNOBSERVED" &&
              endedAtDeadline
            : outcome === "TRANSPORT_ERROR" ||
              outcome === "TRANSPORT_CLOSED" ||
              outcome === "OPERATOR_CANCELLED";
    if (!outcomeReproduced) problems.push("OUTCOME_NOT_REPRODUCED");

    // Cancellation, cleanup, reasons and the confirmation itself.
    const cleanup = isRecord(p.cleanup) ? p.cleanup : null;
    const cancelled = p.cancelled;
    const phase = p.cancellationPhase;
    if (
      typeof cancelled !== "boolean" ||
      (cancelled ? phase !== "DURING_PROBE" && phase !== "BEFORE_SEALING" : phase !== null) ||
      (outcome === "OPERATOR_CANCELLED" && phase !== "DURING_PROBE")
    ) {
      problems.push("CANCELLATION_RECORD_INVALID");
    }
    if (
      cleanup === null ||
      cleanup.settled !== true ||
      typeof cleanup.failed !== "boolean" ||
      typeof cleanup.forced !== "boolean"
    ) {
      problems.push("CLEANUP_RECORD_INVALID");
    }
    const expectedReasons = [
      ...(outcome !== "SUBSCRIPTION_ACKNOWLEDGED" ? [`OUTCOME:${outcome}`] : []),
      ...(cancelled === true ? ["CANCELLED"] : []),
      ...(cleanup?.failed === true ? ["CLEANUP_FAILED"] : []),
    ];
    if (!same(p.reasons, expectedReasons)) problems.push("REASONS_MISMATCH");
    if (p.capabilityConfirmed !== (expectedReasons.length === 0))
      problems.push("CONFIRMATION_MISMATCH");
    if (problems.length > 0) return fail();
    return {
      integrity: { ok: true, problems: [] },
      outcome: outcome as CapabilityOutcome,
      // A redacted decisive frame cannot be re-derived exactly, so it never confirms.
      capabilityConfirmed:
        expectedReasons.length === 0 &&
        replay.ack !== null &&
        replay.subscribeAtMs !== null &&
        !replay.decisiveRedacted,
      subscriptionId: replay.ack?.subscriptionId ?? null,
      manifestSha256,
    };
  } catch {
    problems.push("EVIDENCE_RECORD_MALFORMED");
    return fail();
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export const CAPABILITY_EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID: 1,
  NOT_CONFIRMED: 3,
  INTEGRITY_FAILED: 4,
  SEAL_FAILED: 5,
});

export const CAPABILITY_USAGE = [
  "Usage: solana-subscription-capability [--help] | --out-dir <dir> [--live] | --verify <dir>",
  "  --help            Print this usage and the plan (nothing loaded, opened or written).",
  "  --out-dir <dir>   A new directory directly inside data/research/capability-checks/ (default: dry run).",
  "  --live            One subscription-only check against SOLANA_WS_URL (separate approval required).",
  "  --verify <dir>    Verify a sealed check offline (no configuration, no network).",
  "Exit codes: 0 confirmed or informational, 1 invalid input or error, 3 not confirmed,",
  "            4 integrity failure, 5 sealing failed.",
].join("\n");

export function buildCapabilityPlan(outDirRelative: string, mode: "DRY_RUN" | "LIVE") {
  return {
    kind: "PAPER_SOLANA_SUBSCRIPTION_CAPABILITY_PLAN",
    mode,
    approval: PRECHECK_APPROVAL_STATUS,
    outDir: outDirRelative,
    endpoint: "SOLANA_WS_URL (configuration; required explicitly; never printed)",
    subscribeFrame: SUBSCRIBE_FRAME,
    limits: CAPABILITY_LIMITS,
    sequence: [
      "Validate the new output directory and the explicit SOLANA_WS_URL before any transport",
      "Start the absolute 5,000 ms acquisition deadline, then construct one transport",
      "On open: send the one logsSubscribe; accept only a strictly validated acknowledgement for id 1",
      "If acknowledged in time and still permitted: send one logsUnsubscribe; record its acknowledgement as observed or unobserved",
      "Close; at most 5,000 ms of settled cleanup; then seal and verify locally (overhead outside the bounds)",
    ],
    boundaries: [
      "No HTTP or RPC API call, no validation, no handoff, no Stage B, no keepalive ping",
      "No reconnect, retry, fallback or automatic follow-up; notifications are counted, never decoded",
      "Says nothing about pool availability; account entitlement and quota are not verified by it",
    ],
  };
}

export interface CapabilityDeps {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly loadEnvironment?: (() => void) | undefined;
  readonly createWebSocketTransport?:
    | ((wsUrl: string) => ISolanaKeepaliveWebSocketTransport)
    | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: CapabilityTimers | undefined;
  readonly projectRoot?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** Offline tests only: replaces the exclusive writer (to force a write failure). */
  readonly writeFile?: CapabilityFileWriter | undefined;
}

export interface CapabilityRunResult {
  readonly mode: "HELP" | "DRY_RUN" | "LIVE" | "VERIFY";
  readonly exitCode: number;
  readonly planDigestSha256?: string | undefined;
  readonly outDir?: string | undefined;
  readonly probe?: SubscriptionProbeResult | undefined;
  readonly seal?: SealCapabilityResult | undefined;
  readonly verification?: CapabilityVerification | undefined;
}

const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const cliError = (message: string) => new Error(`[CLI_INVALID_ARG] ${message}`);
const OWN_ERROR_CODES = new Set([
  "CLI_INVALID_ARG",
  "OUTPUT_EXISTS",
  "MISSING_CONFIGURATION",
  "INVALID_CONFIGURATION",
]);
const errorCode = (err: unknown) =>
  /^\[([A-Z0-9_]+)\]/.exec(err instanceof Error ? err.message : "")?.[1] ?? "UNEXPECTED_ERROR";
/** Errors raised here carry fixed text only; anything else prints its code. */
export const printableCapabilityError = (err: unknown): string =>
  OWN_ERROR_CODES.has(errorCode(err)) && err instanceof Error ? err.message : `[${errorCode(err)}]`;

export async function runSubscriptionCapabilityCheck(
  rawArgs: readonly string[],
  deps: CapabilityDeps = {},
): Promise<CapabilityRunResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let values: Record<string, string | boolean | undefined>;
  let tokens: readonly { kind: string; name?: string }[] = [];
  try {
    ({ values, tokens = [] } = parseArgs({
      args: [...rawArgs],
      options: {
        help: { type: "boolean" },
        live: { type: "boolean" },
        "out-dir": { type: "string" },
        verify: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    }));
  } catch (err) {
    throw cliError(err instanceof Error ? err.message : String(err));
  }
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== "option" || t.name === undefined) continue;
    if (seen.has(t.name)) throw cliError(`--${t.name} may be given only once`);
    seen.add(t.name);
  }
  const sha = (s: string) => sha256(s);
  if (values.help === true) {
    if (seen.size > 1) throw cliError("--help cannot be combined with other options");
    const planJson = JSON.stringify(
      buildCapabilityPlan("<new directory inside data/research/capability-checks/>", "DRY_RUN"),
    );
    log(CAPABILITY_USAGE);
    log("[HELP] No configuration loaded, no transport opened, nothing written.");
    log(planJson);
    return { mode: "HELP", exitCode: CAPABILITY_EXIT_CODES.OK, planDigestSha256: sha(planJson) };
  }
  const projectRoot = path.resolve(deps.projectRoot ?? findWorkspaceRoot());
  const root = path.join(projectRoot, ...CAPABILITY_ROOT_SEGMENTS);
  if (values.verify !== undefined) {
    if (values.live === true || values["out-dir"] !== undefined) {
      throw cliError("--verify cannot be combined with --live or --out-dir");
    }
    const dir = path.resolve(projectRoot, String(values.verify));
    if (values.verify === "" || path.dirname(dir) !== root) {
      throw cliError(
        `--verify must name a run directly inside ${CAPABILITY_ROOT_SEGMENTS.join("/")}/`,
      );
    }
    const v = verifySubscriptionCapabilityEvidence(dir);
    log(
      `[VERIFY] Integrity: ${v.integrity.ok ? "OK" : `FAILED (${v.integrity.problems.join(", ")})`}`,
    );
    log(`[VERIFY] Outcome: ${v.outcome ?? "UNKNOWN"}`);
    log(`[VERIFY] Capability: ${v.capabilityConfirmed ? "CONFIRMED" : "NOT CONFIRMED"}`);
    return {
      mode: "VERIFY",
      exitCode: !v.integrity.ok
        ? CAPABILITY_EXIT_CODES.INTEGRITY_FAILED
        : v.capabilityConfirmed
          ? CAPABILITY_EXIT_CODES.OK
          : CAPABILITY_EXIT_CODES.NOT_CONFIRMED,
      verification: v,
    };
  }
  const rawOut = typeof values["out-dir"] === "string" ? values["out-dir"] : "";
  if (rawOut === "") throw cliError("--out-dir is required (a new directory)");
  const outDir = path.resolve(projectRoot, rawOut);
  if (path.dirname(outDir) !== root || !RUN_NAME.test(path.basename(outDir))) {
    throw cliError(
      `--out-dir must be a new directory directly inside ${CAPABILITY_ROOT_SEGMENTS.join("/")}/ (letters, digits, '.', '_', '-')`,
    );
  }
  const rel = path.relative(projectRoot, outDir).replace(/\\/g, "/");
  if (existsSync(outDir))
    throw new Error(`[OUTPUT_EXISTS] ${rel} already exists; refusing to overwrite`);
  const mode = values.live === true ? "LIVE" : "DRY_RUN";
  const plan = buildCapabilityPlan(rel, mode);
  const planJson = JSON.stringify(plan);
  const planDigestSha256 = sha(planJson);
  if (mode === "DRY_RUN") {
    log("[DRY_RUN] No configuration loaded, no transport opened, nothing written.");
    log(`[DRY_RUN] Live execution: ${PRECHECK_APPROVAL_STATUS}`);
    log(`[DRY_RUN] Plan digest (sha256): ${planDigestSha256}`);
    log(planJson);
    return { mode, exitCode: CAPABILITY_EXIT_CODES.OK, planDigestSha256 };
  }

  // Explicit live path: configuration is loaded only here and validated before any transport.
  (deps.loadEnvironment ?? loadDaemonEnvironment)();
  const endpoints = resolveSolanaEndpoints(deps.env ?? process.env);
  if (!endpoints.ok) throw new Error(endpoints.error);
  if (endpoints.wsSource !== "SOLANA_WS_URL") {
    throw new Error(
      "[MISSING_CONFIGURATION] SOLANA_WS_URL (ws or wss) is required for the subscription capability check; no WebSocket endpoint is derived",
    );
  }
  const secrets = credentialSecrets([endpoints.rpcUrl, endpoints.wsUrl]);
  const redact = (t: string) => redactSensitiveText(t, secrets);
  log(`[LIVE] ${PRECHECK_APPROVAL_STATUS}`);
  log(`[LIVE] Plan digest (sha256): ${planDigestSha256}`);
  const probe = await runSubscriptionProbe({
    wsUrl: endpoints.wsUrl,
    transportFactory: (url) =>
      deps.createWebSocketTransport
        ? deps.createWebSocketTransport(url)
        : new WsWebSocketTransport(url),
    clock: deps.clock,
    timers: deps.timers,
    abortSignal: deps.signal,
  });
  log(`[LIVE] Outcome: ${probe.outcome}${probe.detail ? ` (${redact(probe.detail)})` : ""}`);
  log(
    `[LIVE] Unsubscribe: ${probe.unsubscribe.status}; cleanup ${probe.cleanup.failed ? "FAILED" : "settled"}`,
  );
  // Cancellation is rechecked here, after every callback above and immediately before sealing. A
  // cancellation observed now keeps the probe's evidence (including a valid acknowledgement) but
  // seals the overall run as cancelled and not confirmed. Sealing itself is not interrupted.
  const cancelledBeforeSealing = deps.signal?.aborted === true && !probe.cancelled;
  const result: SubscriptionProbeResult = cancelledBeforeSealing
    ? {
        ...probe,
        cancelled: true,
        cancellationPhase: "BEFORE_SEALING",
        capabilityConfirmed: false,
        reasons: [
          ...(probe.outcome !== "SUBSCRIPTION_ACKNOWLEDGED" ? [`OUTCOME:${probe.outcome}`] : []),
          "CANCELLED",
          ...(probe.cleanup.failed ? ["CLEANUP_FAILED"] : []),
        ],
      }
    : probe;
  const seal = sealSubscriptionCapabilityEvidence({
    outDir,
    plan,
    result,
    secrets,
    writeFile: deps.writeFile,
  });
  if (cancelledBeforeSealing) {
    log(
      "[LIVE] Cancelled after the probe settled and before sealing: sealed as cancelled; not confirmed.",
    );
  }
  if (!seal.ok) {
    log(`[LIVE] Sealing FAILED: ${seal.status} (no rerun)`);
    return {
      mode,
      exitCode: CAPABILITY_EXIT_CODES.SEAL_FAILED,
      planDigestSha256,
      outDir: rel,
      probe: result,
      seal,
    };
  }
  const verification = verifySubscriptionCapabilityEvidence(outDir);
  log(`[LIVE] Evidence sealed: ${rel} (manifest sha256 ${seal.manifestSha256})`);
  log(
    `[LIVE] Integrity: ${verification.integrity.ok ? "OK" : "FAILED"}; capability ${verification.capabilityConfirmed ? "CONFIRMED" : "NOT CONFIRMED"}`,
  );
  return {
    mode,
    exitCode: !verification.integrity.ok
      ? CAPABILITY_EXIT_CODES.INTEGRITY_FAILED
      : verification.capabilityConfirmed
        ? CAPABILITY_EXIT_CODES.OK
        : CAPABILITY_EXIT_CODES.NOT_CONFIRMED,
    planDigestSha256,
    outDir: rel,
    probe: result,
    seal,
    verification,
  };
}

if (process.argv[1] && process.argv[1].endsWith("solana-subscription-capability.ts")) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  runSubscriptionCapabilityCheck(process.argv.slice(2), { signal: controller.signal })
    .then((r) => {
      process.removeListener("SIGINT", onSignal);
      process.exit(r.exitCode);
    })
    .catch((err: unknown) => {
      process.removeListener("SIGINT", onSignal);
      console.error("[SOLANA_SUBSCRIPTION_CAPABILITY_ERROR]", printableCapabilityError(err));
      process.exit(CAPABILITY_EXIT_CODES.INVALID);
    });
}
