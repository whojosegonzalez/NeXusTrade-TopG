/**
 * Phase 12.94-D Milestone D.3.3: Bounded AMM v4 Creation Watch Collector
 *
 * Implements a bounded, passive WebSocket notification collector for Raydium AMM v4
 * pool creation candidates.
 *
 * Design & Operational Invariants:
 * 1. Offline & Inert: Import and construction perform zero I/O, no network, no timer
 *    scheduling, and no filesystem access. All execution is triggered explicitly via start().
 * 2. Injected Dependencies: Operates entirely against an injected transport factory,
 *    clock, timers, and cancellation signal. Zero global networking or environment reads.
 * 3. Exactly One Subscription: Issues exactly one logsSubscribe mentioning the pinned
 *    fee destination (7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5). Zero reconnects, zero retries.
 * 4. Rigorous Acknowledgement Binding: Enforces request/subscription ID binding before
 *    processing notifications. Validates slot, canonical 64-byte Base58 signature
 *    (via isValidSolanaSignature), and transaction error status (strictly requires err === null).
 * 5. Bounded Accounting & Pong Matching: Enforces strict ceilings on watch duration (15 min),
 *    ack deadline (5 s), incoming messages (100), payload bytes (1 MiB), client keepalive pings (45),
 *    and incoming control frames (128). Pongs are verified byte-for-byte against the outstanding
 *    ping payload; unmatched pongs do not clear the deadline, and the first unmatched pong deadline
 *    stops the watch.
 * 6. Auditable Observations & Deep Immutability: Preserves a recursively cloned and frozen
 *    record of complete application frames (without arbitrary truncation), provider events, and
 *    accounting metrics. Over-ceiling frames retain bounded metadata only without decoding or copying
 *    oversized payloads. Does not claim cryptographic proof of market completeness.
 * 7. Single Capture & Settled Teardown: Captures at most the first qualifying notification and
 *    settles teardown within a bounded cleanup ceiling before resolving. Late events cannot mutate
 *    the completed result.
 */

import { isValidSolanaSignature } from "./ExactPoolHistoryEnumerator.js";
import { RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION } from "../scripts/fresh-amm-v4-precheck.js";
import type { ISolanaKeepaliveWebSocketTransport } from "./RaydiumTransportObservationProbe.js";
import { getWebSocketTransportReadyState } from "./CandidateDecisionDiagnostic.js";
import { sanitizeSolanaRpcUrl } from "../research/pilot/SolanaRpcLiveObservationClient.js";

export const DEFAULT_WATCH_FEE_DESTINATION = RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION;

export interface BoundedAmmV4CreationWatchLimits {
  /** Maximum lifetime of the watch session in milliseconds (default: 900,000 ms = 15 minutes). */
  readonly watchCeilingMs: number;
  /** Maximum time allowed for subscription request acknowledgement (default: 5,000 ms). */
  readonly ackTimeoutMs: number;
  /** Interval between client keepalive ping frames (default: 20,000 ms). */
  readonly pingIntervalMs: number;
  /** Maximum time to wait for a matching pong before terminating (default: 10,000 ms). */
  readonly pongTimeoutMs: number;
  /** Maximum number of client keepalive pings allowed (default: 45). */
  readonly maxClientPings: number;
  /** Maximum incoming control frames, counting received pings and pongs (default: 128). */
  readonly maxIncomingControlFrames: number;
  /** Maximum incoming WebSocket application messages (default: 100). */
  readonly maxIncomingMessages: number;
  /** Maximum cumulative application message payload in bytes (default: 1,048,576 = 1 MiB). */
  readonly maxPayloadBytes: number;
  /** Maximum time allowed for bounded teardown/cleanup (default: 5,000 ms). */
  readonly cleanupTimeoutMs: number;
}

export const DEFAULT_CREATION_WATCH_LIMITS: BoundedAmmV4CreationWatchLimits = Object.freeze({
  watchCeilingMs: 900_000,
  ackTimeoutMs: 5_000,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 10_000,
  maxClientPings: 45,
  maxIncomingControlFrames: 128,
  maxIncomingMessages: 100,
  maxPayloadBytes: 1_048_576,
  cleanupTimeoutMs: 5_000,
});

export type BoundedWatchTerminationStatus =
  | "NOTIFICATION_CAPTURED"
  | "NO_QUALIFYING_NOTIFICATION_OBSERVED"
  | "SUBSCRIBE_ACK_TIMEOUT"
  | "SUBSCRIBE_REJECTED"
  | "KEEPALIVE_TIMEOUT"
  | "MESSAGE_LIMIT_EXCEEDED"
  | "PAYLOAD_BYTE_CEILING_EXCEEDED"
  | "CONTROL_FRAME_LIMIT_EXCEEDED"
  | "CLIENT_PING_LIMIT_EXCEEDED"
  | "MALFORMED_FRAME"
  | "TRANSPORT_ERROR"
  | "TRANSPORT_CLOSED"
  | "OPERATOR_CANCELLED";

export interface BoundedWatchObservationEvent {
  readonly type: string;
  readonly timestampMs: number;
  readonly details?: Record<string, unknown> | undefined;
}

export interface BoundedWatchCompleteFrame {
  readonly direction: "INCOMING" | "OUTGOING";
  readonly timestampMs: number;
  readonly byteLength: number;
  readonly payload: string;
  readonly isComplete: true;
  readonly overflow?: false | undefined;
  readonly overflowReason?: undefined;
}

export interface BoundedWatchOverflowFrameMetadata {
  readonly direction: "INCOMING";
  readonly timestampMs: number;
  readonly byteLength: number;
  readonly payload: null;
  readonly isComplete: false;
  readonly overflow: true;
  readonly overflowReason: "PAYLOAD_BYTE_CEILING_EXCEEDED" | "MESSAGE_LIMIT_EXCEEDED";
}

export type BoundedWatchApplicationFrame =
  | BoundedWatchCompleteFrame
  | BoundedWatchOverflowFrameMetadata;

export interface CapturedNotificationData {
  readonly signature: string;
  readonly slot: number;
  readonly receivedAtMs: number;
  readonly logs: readonly string[];
  readonly disclaimer: "PROVISIONAL: candidate discovered; does not establish pool creation, strategy eligibility, or qualified trading flow";
}

export interface BoundedWatchObservations {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly terminationStatus: BoundedWatchTerminationStatus;
  readonly terminationReason: string;
  readonly subscriptionId: number | null;
  readonly messagesReceivedCount: number;
  readonly payloadBytesReceived: number;
  readonly clientPingsSentCount: number;
  readonly serverPingsReceivedCount: number;
  readonly pongsReceivedCount: number;
  readonly matchedPongsCount: number;
  readonly incomingControlFramesCount: number;
  readonly failedNotificationsCount: number;
  readonly rejectedNotificationsCount: number;
  readonly cleanupSettled: boolean;
  readonly cleanupFailed: boolean;
  readonly cleanupFailureReason?: string | undefined;
  readonly applicationFrames: readonly BoundedWatchApplicationFrame[];
  readonly events: readonly BoundedWatchObservationEvent[];
}

export interface BoundedAmmV4CreationWatchResult {
  readonly status: BoundedWatchTerminationStatus;
  readonly reason: string;
  readonly notification: CapturedNotificationData | null;
  readonly observations: BoundedWatchObservations;
}

export interface BoundedWatchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BoundedAmmV4CreationWatchOptions {
  readonly wssUrl: string;
  readonly feeDestination?: string | undefined;
  readonly transportFactory: (url: string) => ISolanaKeepaliveWebSocketTransport;
  readonly clock?: (() => number) | undefined;
  readonly timers?: BoundedWatchTimers | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly limits?: Partial<BoundedAmmV4CreationWatchLimits> | undefined;
}

/**
 * Sanitizes or redacts credential-bearing WSS URLs for safe inclusion in event metadata.
 */
export function sanitizeWssUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "[REDACTED_WSS_URL]";
  }
  try {
    const sanitized = sanitizeSolanaRpcUrl(rawUrl);
    return sanitized.sanitizedUrl;
  } catch {
    return "[REDACTED_WSS_URL]";
  }
}

/**
 * Recursively deep-clones and freezes all nested structures, ensuring that
 * nested objects, arrays, and properties cannot be mutated.
 */
export function deepCloneAndFreeze<T>(input: T): T {
  if (input === null || typeof input !== "object") {
    return input;
  }
  if (Buffer.isBuffer(input)) {
    const copy = Buffer.from(input);
    return Object.freeze(copy) as unknown as T;
  }
  if (Array.isArray(input)) {
    const copy = input.map((item) => deepCloneAndFreeze(item));
    return Object.freeze(copy) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    copy[key] = deepCloneAndFreeze(val);
  }
  return Object.freeze(copy) as T;
}

export class BoundedAmmV4CreationWatch {
  readonly wssUrl: string;
  readonly feeDestination: string;
  readonly limits: BoundedAmmV4CreationWatchLimits;
  private readonly transportFactory: (url: string) => ISolanaKeepaliveWebSocketTransport;
  private readonly clock: () => number;
  private readonly timers: BoundedWatchTimers;
  private readonly abortSignal?: AbortSignal | undefined;

  private transport: ISolanaKeepaliveWebSocketTransport | null = null;
  private started = false;
  private terminated = false;
  private isOpenDispatched = false;

  private startedAtMs = 0;
  private endedAtMs = 0;
  private overallDeadlineAtMs = 0;
  private ackDeadlineAtMs = 0;
  private pendingPongDeadlineAtMs: number | null = null;
  private expectedPongPayload: Buffer | null = null;

  private readonly requestId = 1;
  private subscriptionId: number | null = null;
  private capturedNotification: CapturedNotificationData | null = null;

  private messagesReceivedCount = 0;
  private payloadBytesReceived = 0;
  private clientPingsSentCount = 0;
  private serverPingsReceivedCount = 0;
  private pongsReceivedCount = 0;
  private matchedPongsCount = 0;
  private incomingControlFramesCount = 0;
  private failedNotificationsCount = 0;
  private rejectedNotificationsCount = 0;

  private cleanupSettled = false;
  private cleanupFailed = false;
  private cleanupFailureReason: string | undefined = undefined;
  private onCleanupCloseHook: (() => void) | null = null;

  private terminationStatus: BoundedWatchTerminationStatus = "NO_QUALIFYING_NOTIFICATION_OBSERVED";
  private terminationReason = "";

  private readonly events: BoundedWatchObservationEvent[] = [];
  private readonly applicationFrames: BoundedWatchApplicationFrame[] = [];

  private ackTimer: unknown = null;
  private overallTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimeoutTimer: unknown = null;
  private cleanupTimer: unknown = null;
  private abortListener: (() => void) | null = null;

  private resolveRunPromise: ((result: BoundedAmmV4CreationWatchResult) => void) | null = null;

  constructor(options: BoundedAmmV4CreationWatchOptions) {
    if (!options.wssUrl || typeof options.wssUrl !== "string") {
      throw new Error("[WATCH_CONFIG_INVALID] wssUrl must be a non-empty string");
    }
    if (typeof options.transportFactory !== "function") {
      throw new Error("[WATCH_CONFIG_INVALID] transportFactory must be a function");
    }
    if (
      options.feeDestination !== undefined &&
      (typeof options.feeDestination !== "string" || !options.feeDestination.trim())
    ) {
      throw new Error(
        "[WATCH_CONFIG_INVALID] feeDestination must be a non-empty string if provided",
      );
    }

    const limits = {
      ...DEFAULT_CREATION_WATCH_LIMITS,
      ...(options.limits ?? {}),
    };

    const validatePositiveFinite = (val: number, name: string) => {
      if (typeof val !== "number" || !Number.isFinite(val) || Number.isNaN(val) || val <= 0) {
        throw new Error(
          `[WATCH_CONFIG_INVALID] ${name} must be a positive finite number, got ${val}`,
        );
      }
    };

    const validatePositiveSafeInteger = (val: number, name: string) => {
      if (typeof val !== "number" || !Number.isSafeInteger(val) || val <= 0) {
        throw new Error(
          `[WATCH_CONFIG_INVALID] ${name} must be a positive safe integer, got ${val}`,
        );
      }
    };

    validatePositiveFinite(limits.watchCeilingMs, "watchCeilingMs");
    validatePositiveFinite(limits.ackTimeoutMs, "ackTimeoutMs");
    validatePositiveFinite(limits.pingIntervalMs, "pingIntervalMs");
    validatePositiveFinite(limits.pongTimeoutMs, "pongTimeoutMs");
    validatePositiveFinite(limits.cleanupTimeoutMs, "cleanupTimeoutMs");
    validatePositiveFinite(limits.maxPayloadBytes, "maxPayloadBytes");

    validatePositiveSafeInteger(limits.maxClientPings, "maxClientPings");
    validatePositiveSafeInteger(limits.maxIncomingControlFrames, "maxIncomingControlFrames");
    validatePositiveSafeInteger(limits.maxIncomingMessages, "maxIncomingMessages");

    if (limits.pongTimeoutMs >= limits.pingIntervalMs) {
      throw new Error(
        `[WATCH_CONFIG_INVALID] pongTimeoutMs (${limits.pongTimeoutMs}) must be strictly less than pingIntervalMs (${limits.pingIntervalMs})`,
      );
    }

    this.wssUrl = options.wssUrl;
    this.feeDestination = options.feeDestination ?? DEFAULT_WATCH_FEE_DESTINATION;
    this.transportFactory = options.transportFactory;
    this.clock = options.clock ?? (() => Date.now());
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.abortSignal = options.abortSignal;
    this.limits = Object.freeze(limits);
  }

  /**
   * Starts the bounded WebSocket creation watch.
   * Resolves only after closure or bounded forced cleanup settles.
   */
  start(): Promise<BoundedAmmV4CreationWatchResult> {
    if (this.started) {
      throw new Error("[WATCH_ALREADY_STARTED] Watch instance can only be started once");
    }
    this.started = true;
    this.startedAtMs = this.clock();
    this.overallDeadlineAtMs = this.startedAtMs + this.limits.watchCeilingMs;
    this.ackDeadlineAtMs = this.startedAtMs + this.limits.ackTimeoutMs;

    this.recordEvent({
      type: "WATCH_STARTED",
      details: {
        wssUrl: sanitizeWssUrl(this.wssUrl),
        feeDestination: this.feeDestination,
        watchCeilingMs: this.limits.watchCeilingMs,
      },
    });

    return new Promise<BoundedAmmV4CreationWatchResult>((resolve) => {
      this.resolveRunPromise = resolve;

      if (this.abortSignal?.aborted) {
        this.terminate("OPERATOR_CANCELLED", "Abort signal was already triggered at start");
        return;
      }

      if (this.abortSignal) {
        this.abortListener = () => {
          this.terminate("OPERATOR_CANCELLED", "Operator abort signal triggered");
        };
        this.abortSignal.addEventListener("abort", this.abortListener, { once: true });
      }

      this.overallTimer = this.timers.setTimeout(() => {
        this.terminate(
          "NO_QUALIFYING_NOTIFICATION_OBSERVED",
          `Watch duration ceiling reached (${this.limits.watchCeilingMs} ms) with no qualifying notification observed`,
        );
      }, this.limits.watchCeilingMs);

      this.ackTimer = this.timers.setTimeout(() => {
        if (this.subscriptionId === null) {
          this.terminate(
            "SUBSCRIBE_ACK_TIMEOUT",
            `Subscription acknowledgement not received within ${this.limits.ackTimeoutMs} ms deadline`,
          );
        }
      }, this.limits.ackTimeoutMs);

      try {
        this.transport = this.transportFactory(this.wssUrl);
      } catch (err) {
        this.terminate(
          "TRANSPORT_ERROR",
          `Transport factory threw on instantiation: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      this.bindTransportListeners(this.transport);

      // Check if transport is already open (readyState === 1) or exposed via underlying socket
      const readyState = getWebSocketTransportReadyState(this.transport);
      if (readyState === 1 /* OPEN */) {
        this.handleOpen();
      }
    });
  }

  private bindTransportListeners(transport: ISolanaKeepaliveWebSocketTransport): void {
    transport.on("open", () => {
      this.handleOpen();
    });

    transport.on("message", (data: string | Buffer) => {
      this.handleMessage(data);
    });

    transport.on("pong", (data?: Buffer) => {
      this.handlePong(data);
    });

    transport.on("ping", () => {
      this.handleServerPing();
    });

    transport.on("error", (err: Error) => {
      this.terminate("TRANSPORT_ERROR", err.message);
    });

    transport.on("close", (code: number, reason: string) => {
      if (this.terminated) {
        if (this.onCleanupCloseHook) {
          const hook = this.onCleanupCloseHook;
          this.onCleanupCloseHook = null;
          hook();
        }
        return;
      }
      this.terminate(
        "TRANSPORT_CLOSED",
        `Transport closed prematurely (code: ${code}${reason ? `, reason: ${reason}` : ""})`,
      );
    });
  }

  private handleOpen(): void {
    if (this.terminated || this.isOpenDispatched) return;
    this.isOpenDispatched = true;

    if (this.checkAbsoluteDeadlines()) return;

    this.recordEvent({ type: "TRANSPORT_OPENED" });

    // 1. Dispatch exactly one logsSubscribe mentioning the pinned fee destination
    const subscribeFrame = JSON.stringify({
      jsonrpc: "2.0",
      id: this.requestId,
      method: "logsSubscribe",
      params: [{ mentions: [this.feeDestination] }, { commitment: "confirmed" }],
    });

    const subscribeByteLength = Buffer.byteLength(subscribeFrame, "utf8");
    this.recordCompleteFrame("OUTGOING", subscribeFrame, subscribeByteLength);

    try {
      this.transport?.send(subscribeFrame);
      this.recordEvent({
        type: "SUBSCRIBE_DISPATCHED",
        details: { requestId: this.requestId, feeDestination: this.feeDestination },
      });
    } catch (err) {
      this.terminate(
        "TRANSPORT_ERROR",
        `Failed to send subscription frame: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // 2. Schedule client keepalive pings
    this.scheduleNextKeepalivePing();
  }

  private scheduleNextKeepalivePing(): void {
    if (this.terminated) return;
    this.pingTimer = this.timers.setTimeout(() => {
      this.sendKeepalivePing();
    }, this.limits.pingIntervalMs);
  }

  private sendKeepalivePing(): void {
    if (this.terminated) return;
    if (this.checkAbsoluteDeadlines()) return;

    if (this.clientPingsSentCount >= this.limits.maxClientPings) {
      this.terminate(
        "CLIENT_PING_LIMIT_EXCEEDED",
        `Exceeded client keepalive ping ceiling (${this.limits.maxClientPings})`,
      );
      return;
    }

    // If a previous pong deadline is still pending and passed:
    if (this.pendingPongDeadlineAtMs !== null && this.clock() >= this.pendingPongDeadlineAtMs) {
      this.terminate(
        "KEEPALIVE_TIMEOUT",
        `Unmatched pong deadline expired (${this.limits.pongTimeoutMs} ms) before subsequent ping`,
      );
      return;
    }

    if (typeof this.transport?.ping !== "function") {
      this.terminate(
        "TRANSPORT_ERROR",
        "Transport does not support keepalive ping capability (ping method is missing)",
      );
      return;
    }

    this.clientPingsSentCount++;
    const pingPayload = Buffer.from(`topg-watch-${this.clientPingsSentCount}`);
    this.expectedPongPayload = pingPayload;
    this.pendingPongDeadlineAtMs = this.clock() + this.limits.pongTimeoutMs;

    this.recordEvent({
      type: "CLIENT_PING_SENT",
      details: {
        pingNumber: this.clientPingsSentCount,
        deadlineAtMs: this.pendingPongDeadlineAtMs,
        expectedPayload: pingPayload.toString("utf8"),
      },
    });

    // Arm single-shot pong timeout BEFORE dispatch so synchronous mock replies work correctly
    if (this.pongTimeoutTimer !== null) {
      this.timers.clearTimeout(this.pongTimeoutTimer);
    }
    this.pongTimeoutTimer = this.timers.setTimeout(() => {
      if (this.pendingPongDeadlineAtMs !== null && this.clock() >= this.pendingPongDeadlineAtMs) {
        this.terminate(
          "KEEPALIVE_TIMEOUT",
          `First unmatched pong deadline expired (${this.limits.pongTimeoutMs} ms); zero reconnects`,
        );
      }
    }, this.limits.pongTimeoutMs);

    // Schedule subsequent ping
    this.scheduleNextKeepalivePing();

    try {
      this.transport.ping(pingPayload);
    } catch (err) {
      this.terminate(
        "TRANSPORT_ERROR",
        `Failed to send ping frame: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  private handlePong(data?: Buffer | string | unknown): void {
    if (this.terminated) return;
    if (this.checkAbsoluteDeadlines()) return;

    this.pongsReceivedCount++;
    this.incomingControlFramesCount++;

    if (this.incomingControlFramesCount > this.limits.maxIncomingControlFrames) {
      this.terminate(
        "CONTROL_FRAME_LIMIT_EXCEEDED",
        `Exceeded maximum incoming control frames ceiling (${this.limits.maxIncomingControlFrames})`,
      );
      return;
    }

    // Convert data to Buffer for payload comparison
    let receivedBuffer: Buffer | null = null;
    if (Buffer.isBuffer(data)) {
      receivedBuffer = data;
    } else if (typeof data === "string") {
      receivedBuffer = Buffer.from(data, "utf8");
    } else if (data instanceof Uint8Array) {
      receivedBuffer = Buffer.from(data);
    }

    const isMatch =
      this.expectedPongPayload !== null &&
      receivedBuffer !== null &&
      receivedBuffer.equals(this.expectedPongPayload);

    if (isMatch) {
      if (this.pendingPongDeadlineAtMs !== null && this.clock() > this.pendingPongDeadlineAtMs) {
        this.terminate(
          "KEEPALIVE_TIMEOUT",
          "Pong received after matching pong deadline expired; zero reconnects",
        );
        return;
      }
      this.matchedPongsCount++;
      this.expectedPongPayload = null;
      this.pendingPongDeadlineAtMs = null;
      if (this.pongTimeoutTimer !== null) {
        this.timers.clearTimeout(this.pongTimeoutTimer);
        this.pongTimeoutTimer = null;
      }
      this.recordEvent({
        type: "PONG_MATCHED",
        details: { matchedCount: this.matchedPongsCount },
      });
    } else {
      // Unrelated, stale, or unsolicited pong: does NOT clear deadline
      this.recordEvent({
        type: "UNSOLICITED_OR_UNMATCHED_PONG_RECEIVED",
        details: {
          hasOutstandingPing: this.expectedPongPayload !== null,
          payloadReceived: receivedBuffer
            ? receivedBuffer.toString("utf8")
            : typeof data === "string"
              ? data
              : null,
        },
      });
    }
  }

  private handleServerPing(): void {
    if (this.terminated) return;
    if (this.checkAbsoluteDeadlines()) return;

    this.serverPingsReceivedCount++;
    this.incomingControlFramesCount++;

    if (this.incomingControlFramesCount > this.limits.maxIncomingControlFrames) {
      this.terminate(
        "CONTROL_FRAME_LIMIT_EXCEEDED",
        `Exceeded maximum incoming control frames ceiling (${this.limits.maxIncomingControlFrames})`,
      );
      return;
    }

    this.recordEvent({ type: "SERVER_PING_RECEIVED" });
  }

  private handleMessage(data: string | Buffer): void {
    if (this.terminated) return;
    if (this.checkAbsoluteDeadlines()) return;

    const incomingByteLength =
      typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;

    // Check payload byte ceiling BEFORE decoding or copying payload
    if (this.payloadBytesReceived + incomingByteLength > this.limits.maxPayloadBytes) {
      this.payloadBytesReceived += incomingByteLength;
      this.messagesReceivedCount++;

      this.recordOverflowMetadata("INCOMING", incomingByteLength, "PAYLOAD_BYTE_CEILING_EXCEEDED");

      this.terminate(
        "PAYLOAD_BYTE_CEILING_EXCEEDED",
        `Received payload bytes (${this.payloadBytesReceived}) exceeded ceiling (${this.limits.maxPayloadBytes})`,
      );
      return;
    }

    // Check incoming messages ceiling BEFORE decoding or copying payload
    if (this.messagesReceivedCount + 1 > this.limits.maxIncomingMessages) {
      this.payloadBytesReceived += incomingByteLength;
      this.messagesReceivedCount++;

      this.recordOverflowMetadata("INCOMING", incomingByteLength, "MESSAGE_LIMIT_EXCEEDED");

      this.terminate(
        "MESSAGE_LIMIT_EXCEEDED",
        `Incoming application messages (${this.messagesReceivedCount}) exceeded ceiling (${this.limits.maxIncomingMessages})`,
      );
      return;
    }

    // Accepted within ceilings: update accounting, decode payload to string, and retain complete frame
    this.payloadBytesReceived += incomingByteLength;
    this.messagesReceivedCount++;

    const text = typeof data === "string" ? data : data.toString("utf8");
    this.recordCompleteFrame("INCOMING", text, incomingByteLength);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.terminate(
        "MALFORMED_FRAME",
        `Invalid JSON text: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.terminate("MALFORMED_FRAME", "Incoming message is not a valid JSON object");
      return;
    }

    const msg = parsed as Record<string, unknown>;

    // Case 1: Subscription acknowledgement pending
    if (this.subscriptionId === null) {
      if (msg.jsonrpc !== "2.0") {
        this.terminate(
          "MALFORMED_FRAME",
          `Acknowledgement frame does not specify jsonrpc 2.0 (got ${String(msg.jsonrpc)})`,
        );
        return;
      }

      if (msg.id !== this.requestId) {
        this.terminate(
          "MALFORMED_FRAME",
          `Acknowledgement id mismatch (expected ${this.requestId}, got ${String(msg.id)})`,
        );
        return;
      }

      if ("error" in msg && msg.error !== null && msg.error !== undefined) {
        this.terminate(
          "SUBSCRIBE_REJECTED",
          `Subscription request rejected by RPC provider: ${JSON.stringify(msg.error)}`,
        );
        return;
      }

      if (typeof msg.result !== "number" || !Number.isSafeInteger(msg.result) || msg.result <= 0) {
        this.terminate(
          "MALFORMED_FRAME",
          `Subscription acknowledgement result must be positive safe integer, got ${String(msg.result)}`,
        );
        return;
      }

      this.subscriptionId = msg.result;
      if (this.ackTimer !== null) {
        this.timers.clearTimeout(this.ackTimer);
        this.ackTimer = null;
      }

      this.recordEvent({
        type: "SUBSCRIBE_ACKNOWLEDGED",
        details: { subscriptionId: this.subscriptionId },
      });
      return;
    }

    // Case 2: Post-acknowledgement message processing (notifications)
    if (msg.jsonrpc !== "2.0") {
      this.terminate(
        "MALFORMED_FRAME",
        `Notification message does not specify jsonrpc 2.0 (got ${String(msg.jsonrpc)})`,
      );
      return;
    }

    if (msg.method !== "logsNotification") {
      this.recordEvent({
        type: "UNEXPECTED_METHOD_IGNORED",
        details: { method: String(msg.method) },
      });
      return;
    }

    if (!msg.params || typeof msg.params !== "object" || Array.isArray(msg.params)) {
      this.terminate("MALFORMED_FRAME", "logsNotification params must be an object");
      return;
    }

    const params = msg.params as Record<string, unknown>;

    // Subscription binding check
    if (params.subscription !== this.subscriptionId) {
      this.rejectedNotificationsCount++;
      this.recordEvent({
        type: "NOTIFICATION_REJECTED",
        details: {
          reason: "WRONG_SUBSCRIPTION_ID",
          expected: this.subscriptionId,
          received: params.subscription,
        },
      });
      return;
    }

    if (!params.result || typeof params.result !== "object" || Array.isArray(params.result)) {
      this.terminate("MALFORMED_FRAME", "logsNotification params.result must be an object");
      return;
    }

    const resultObj = params.result as Record<string, unknown>;
    const context = resultObj.context as { slot?: unknown } | undefined;
    const slot = context?.slot;

    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
      this.rejectedNotificationsCount++;
      this.recordEvent({
        type: "NOTIFICATION_REJECTED",
        details: { reason: "INVALID_SLOT", slot },
      });
      return;
    }

    if (!resultObj.value || typeof resultObj.value !== "object" || Array.isArray(resultObj.value)) {
      this.terminate("MALFORMED_FRAME", "logsNotification params.result.value must be an object");
      return;
    }

    const valueObj = resultObj.value as Record<string, unknown>;

    // Explicit on-chain status check: require err === null; absent, undefined, or non-null status must not qualify
    if (!("err" in valueObj) || valueObj.err !== null) {
      this.failedNotificationsCount++;
      this.recordEvent({
        type: "NOTIFICATION_FAILED",
        details: {
          reason: "NON_NULL_OR_MISSING_TRANSACTION_ERROR",
          slot,
          err:
            "err" in valueObj && valueObj.err !== undefined
              ? valueObj.err
              : "ABSENT_OR_UNDEFINED_ERR",
        },
      });
      return;
    }

    const sig = valueObj.signature;
    if (!isValidSolanaSignature(sig)) {
      this.rejectedNotificationsCount++;
      this.recordEvent({
        type: "NOTIFICATION_REJECTED",
        details: { reason: "INVALID_SIGNATURE", slot, signature: sig },
      });
      return;
    }

    const logs = Array.isArray(valueObj.logs)
      ? valueObj.logs.filter((l: unknown): l is string => typeof l === "string")
      : [];

    // Capture first qualifying notification (preserves original receipt time)
    const receivedAtMs = this.clock();
    this.capturedNotification = Object.freeze({
      signature: sig,
      slot,
      receivedAtMs,
      logs: Object.freeze([...logs]),
      disclaimer:
        "PROVISIONAL: candidate discovered; does not establish pool creation, strategy eligibility, or qualified trading flow",
    });

    this.recordEvent({
      type: "NOTIFICATION_QUALIFYING",
      details: { slot, signature: sig, receivedAtMs },
    });

    this.terminate("NOTIFICATION_CAPTURED", "First qualifying creation notification captured");
  }

  private checkAbsoluteDeadlines(): boolean {
    if (this.terminated) return true;
    const now = this.clock();

    if (now >= this.overallDeadlineAtMs) {
      this.terminate(
        "NO_QUALIFYING_NOTIFICATION_OBSERVED",
        `Watch duration ceiling reached (${this.limits.watchCeilingMs} ms) with no qualifying notification observed`,
      );
      return true;
    }

    if (this.subscriptionId === null && now >= this.ackDeadlineAtMs) {
      this.terminate(
        "SUBSCRIBE_ACK_TIMEOUT",
        `Subscription acknowledgement not received within ${this.limits.ackTimeoutMs} ms deadline`,
      );
      return true;
    }

    if (this.pendingPongDeadlineAtMs !== null && now >= this.pendingPongDeadlineAtMs) {
      this.terminate(
        "KEEPALIVE_TIMEOUT",
        `Unmatched pong deadline expired (${this.limits.pongTimeoutMs} ms) before event handling; zero reconnects`,
      );
      return true;
    }

    return false;
  }

  private terminate(status: BoundedWatchTerminationStatus, reason: string): void {
    if (this.terminated) return;
    this.terminated = true;
    this.endedAtMs = this.clock();
    this.terminationStatus = status;
    this.terminationReason = reason;

    this.recordEvent({
      type: "WATCH_TERMINATED",
      details: { status, reason, endedAtMs: this.endedAtMs },
    });

    // Remove AbortSignal listener immediately
    if (this.abortSignal && this.abortListener) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
      this.abortListener = null;
    }

    // Clear all operating timers
    if (this.ackTimer !== null) {
      this.timers.clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.overallTimer !== null) {
      this.timers.clearTimeout(this.overallTimer);
      this.overallTimer = null;
    }
    if (this.pingTimer !== null) {
      this.timers.clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimeoutTimer !== null) {
      this.timers.clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }

    this.settleCleanup();
  }

  private settleCleanup(): void {
    const readyState = getWebSocketTransportReadyState(this.transport);
    if (!this.transport || readyState === 3 /* CLOSED */) {
      this.cleanupSettled = true;
      this.cleanupFailed = false;
      this.recordEvent({ type: "CLEANUP_SETTLED" });
      this.finishAndResolve();
      return;
    }

    let resolved = false;
    const markSettled = (failed: boolean, failureReason?: string) => {
      if (resolved) return;
      resolved = true;
      this.cleanupSettled = true;
      this.cleanupFailed = failed;
      if (failureReason) {
        this.cleanupFailureReason = failureReason;
      }
      if (this.cleanupTimer !== null) {
        this.timers.clearTimeout(this.cleanupTimer);
        this.cleanupTimer = null;
      }
      if (failed) {
        this.recordEvent({
          type: "CLEANUP_FAILED",
          details: { reason: failureReason ?? "UNKNOWN_CLEANUP_FAILURE" },
        });
      } else {
        this.recordEvent({ type: "CLEANUP_SETTLED" });
      }
      this.finishAndResolve();
    };

    // Arm cleanup deadline timer
    this.cleanupTimer = this.timers.setTimeout(() => {
      this.cleanupTimer = null;
      // If still not closed, try forced termination
      try {
        if (typeof (this.transport as { terminate?: () => void })?.terminate === "function") {
          (this.transport as { terminate: () => void }).terminate();
        }
      } catch (err) {
        this.recordEvent({
          type: "TRANSPORT_TERMINATE_ERROR",
          details: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      const stateAfterTerminate = getWebSocketTransportReadyState(this.transport);
      if (stateAfterTerminate === 3) {
        this.recordEvent({
          type: "CLEANUP_FORCE_TERMINATED",
          details: { timeoutMs: this.limits.cleanupTimeoutMs },
        });
        markSettled(false);
      } else {
        markSettled(
          true,
          `Transport failed to close within cleanup ceiling (${this.limits.cleanupTimeoutMs} ms)`,
        );
      }
    }, this.limits.cleanupTimeoutMs);

    // Call close cleanly
    try {
      this.transport.close(1000, this.terminationReason);
    } catch (err) {
      this.recordEvent({
        type: "TRANSPORT_CLOSE_ERROR",
        details: { error: err instanceof Error ? err.message : String(err) },
      });
      try {
        if (typeof (this.transport as { terminate?: () => void })?.terminate === "function") {
          (this.transport as { terminate: () => void }).terminate();
        }
      } catch {
        // ignore
      }
      const stateAfterErr = getWebSocketTransportReadyState(this.transport);
      if (stateAfterErr === 3) {
        markSettled(false);
      } else {
        markSettled(
          true,
          `Transport close threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // If close() synchronously set readyState to 3:
    if (getWebSocketTransportReadyState(this.transport) === 3) {
      markSettled(false);
      return;
    }

    // Otherwise, wait for transport's 'close' event
    this.onCleanupCloseHook = () => {
      markSettled(false);
    };
  }

  private finishAndResolve(): void {
    if (!this.resolveRunPromise) return;

    const durationMs = Math.max(0, this.endedAtMs - this.startedAtMs);
    const observations: BoundedWatchObservations = {
      startedAtMs: this.startedAtMs,
      endedAtMs: this.endedAtMs,
      durationMs,
      terminationStatus: this.terminationStatus,
      terminationReason: this.terminationReason,
      subscriptionId: this.subscriptionId,
      messagesReceivedCount: this.messagesReceivedCount,
      payloadBytesReceived: this.payloadBytesReceived,
      clientPingsSentCount: this.clientPingsSentCount,
      serverPingsReceivedCount: this.serverPingsReceivedCount,
      pongsReceivedCount: this.pongsReceivedCount,
      matchedPongsCount: this.matchedPongsCount,
      incomingControlFramesCount: this.incomingControlFramesCount,
      failedNotificationsCount: this.failedNotificationsCount,
      rejectedNotificationsCount: this.rejectedNotificationsCount,
      cleanupSettled: this.cleanupSettled,
      cleanupFailed: this.cleanupFailed,
      ...(this.cleanupFailureReason ? { cleanupFailureReason: this.cleanupFailureReason } : {}),
      applicationFrames: [...this.applicationFrames],
      events: [...this.events],
    };

    const result: BoundedAmmV4CreationWatchResult = {
      status: this.terminationStatus,
      reason: this.terminationReason,
      notification: this.capturedNotification,
      observations,
    };

    const deepFrozenResult = deepCloneAndFreeze(result);

    const resolve = this.resolveRunPromise;
    this.resolveRunPromise = null;
    resolve(deepFrozenResult);
  }

  private recordCompleteFrame(
    direction: "INCOMING" | "OUTGOING",
    payload: string,
    byteLength: number,
  ): void {
    this.applicationFrames.push(
      Object.freeze({
        direction,
        timestampMs: this.clock(),
        byteLength,
        payload,
        isComplete: true as const,
      }),
    );
  }

  private recordOverflowMetadata(
    direction: "INCOMING",
    byteLength: number,
    overflowReason: "PAYLOAD_BYTE_CEILING_EXCEEDED" | "MESSAGE_LIMIT_EXCEEDED",
  ): void {
    this.applicationFrames.push(
      Object.freeze({
        direction,
        timestampMs: this.clock(),
        byteLength,
        payload: null,
        isComplete: false as const,
        overflow: true as const,
        overflowReason,
      }),
    );
  }

  private recordEvent(event: {
    type: string;
    details?: Record<string, unknown> | undefined;
  }): void {
    this.events.push(
      Object.freeze({
        type: event.type,
        timestampMs: this.clock(),
        details: event.details ? Object.freeze({ ...event.details }) : undefined,
      }),
    );
  }
}
