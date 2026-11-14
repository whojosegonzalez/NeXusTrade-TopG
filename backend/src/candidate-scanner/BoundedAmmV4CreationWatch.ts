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
 *    (via isValidSolanaSignature), and transaction error status.
 * 5. Bounded Accounting: Enforces strict ceilings on watch duration (15 min), ack deadline (5 s),
 *    incoming messages (100), payload bytes (1 MiB), client keepalive pings (45), and incoming
 *    control frames (128). Unmatched pong deadline stops the watch immediately.
 * 6. Auditable Observations: Preserves an immutable, deep-frozen record of all raw provider events
 *    and accounting metrics. Does not claim cryptographic proof of market completeness.
 * 7. Single Capture & Bounded Teardown: Captures at most the first qualifying notification and
 *    terminates within a 5-second cleanup bound. Late events cannot mutate the completed result.
 */

import { isValidSolanaSignature } from "./ExactPoolHistoryEnumerator.js";
import { RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION } from "../scripts/fresh-amm-v4-precheck.js";
import type { ISolanaKeepaliveWebSocketTransport } from "./RaydiumTransportObservationProbe.js";
import { getWebSocketTransportReadyState } from "./CandidateDecisionDiagnostic.js";

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

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj as object)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
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

  private readonly events: BoundedWatchObservationEvent[] = [];

  private ackTimer: unknown = null;
  private overallTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimeoutTimer: unknown = null;
  private cleanupTimer: unknown = null;

  private resolveRunPromise: ((result: BoundedAmmV4CreationWatchResult) => void) | null = null;

  constructor(options: BoundedAmmV4CreationWatchOptions) {
    if (!options.wssUrl || typeof options.wssUrl !== "string") {
      throw new Error("[WATCH_CONFIG_INVALID] wssUrl must be a non-empty string");
    }
    if (typeof options.transportFactory !== "function") {
      throw new Error("[WATCH_CONFIG_INVALID] transportFactory must be a function");
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
    this.limits = Object.freeze({
      ...DEFAULT_CREATION_WATCH_LIMITS,
      ...(options.limits ?? {}),
    });
  }

  /**
   * Starts the bounded WebSocket creation watch.
   * Resolves when a qualifying notification is captured or when a stop condition is met.
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
        wssUrl: this.wssUrl,
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
        this.abortSignal.addEventListener(
          "abort",
          () => {
            this.terminate("OPERATOR_CANCELLED", "Operator abort signal triggered");
          },
          { once: true },
        );
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

    transport.on("pong", () => {
      this.handlePong();
    });

    transport.on("ping", () => {
      this.handleServerPing();
    });

    transport.on("error", (err: Error) => {
      this.terminate("TRANSPORT_ERROR", err.message);
    });

    transport.on("close", (code: number, reason: string) => {
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

    this.clientPingsSentCount++;
    this.pendingPongDeadlineAtMs = this.clock() + this.limits.pongTimeoutMs;

    this.recordEvent({
      type: "CLIENT_PING_SENT",
      details: {
        pingNumber: this.clientPingsSentCount,
        deadlineAtMs: this.pendingPongDeadlineAtMs,
      },
    });

    try {
      if (typeof this.transport?.ping === "function") {
        this.transport.ping(Buffer.from(`topg-watch-${this.clientPingsSentCount}`));
      }
    } catch (err) {
      this.terminate(
        "TRANSPORT_ERROR",
        `Failed to send ping frame: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // Arm single-shot pong timeout
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
  }

  private handlePong(): void {
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

    if (this.pendingPongDeadlineAtMs !== null) {
      if (this.clock() > this.pendingPongDeadlineAtMs) {
        this.terminate(
          "KEEPALIVE_TIMEOUT",
          "Pong received after matching pong deadline expired; zero reconnects",
        );
        return;
      }
      this.matchedPongsCount++;
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
      this.recordEvent({ type: "UNSOLICITED_PONG_RECEIVED" });
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

    const byteLength = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
    this.payloadBytesReceived += byteLength;
    this.messagesReceivedCount++;

    if (this.payloadBytesReceived > this.limits.maxPayloadBytes) {
      this.terminate(
        "PAYLOAD_BYTE_CEILING_EXCEEDED",
        `Received payload bytes (${this.payloadBytesReceived}) exceeded ceiling (${this.limits.maxPayloadBytes})`,
      );
      return;
    }

    if (this.messagesReceivedCount > this.limits.maxIncomingMessages) {
      this.terminate(
        "MESSAGE_LIMIT_EXCEEDED",
        `Incoming application messages (${this.messagesReceivedCount}) exceeded ceiling (${this.limits.maxIncomingMessages})`,
      );
      return;
    }

    const text = typeof data === "string" ? data : data.toString("utf8");
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

    // Explicit on-chain error check: failed transactions are recorded but not qualifying
    if ("err" in valueObj && valueObj.err !== null && valueObj.err !== undefined) {
      this.failedNotificationsCount++;
      this.recordEvent({
        type: "NOTIFICATION_FAILED",
        details: { reason: "ON_CHAIN_TRANSACTION_FAILED", slot, err: valueObj.err },
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

    // Capture first qualifying notification
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

    this.recordEvent({
      type: "WATCH_TERMINATED",
      details: { status, reason, endedAtMs: this.endedAtMs },
    });

    // Clear all scheduled timers
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

    // Close transport cleanly within cleanup bounds
    if (this.transport) {
      try {
        this.transport.close(1000, reason);
      } catch {
        // Ignore synchronous close exceptions during teardown
      }

      // Ensure cleanup ceiling enforces socket termination
      const transportToClean = this.transport;
      this.cleanupTimer = this.timers.setTimeout(() => {
        try {
          if (typeof (transportToClean as { terminate?: () => void }).terminate === "function") {
            (transportToClean as { terminate: () => void }).terminate();
          }
        } catch {
          // Ignore termination exceptions during cleanup
        }
      }, this.limits.cleanupTimeoutMs);
    }

    const durationMs = Math.max(0, this.endedAtMs - this.startedAtMs);
    const observations: BoundedWatchObservations = deepFreeze({
      startedAtMs: this.startedAtMs,
      endedAtMs: this.endedAtMs,
      durationMs,
      terminationStatus: status,
      terminationReason: reason,
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
      events: [...this.events],
    });

    const result: BoundedAmmV4CreationWatchResult = deepFreeze({
      status,
      reason,
      notification: this.capturedNotification,
      observations,
    });

    if (this.resolveRunPromise) {
      const resolve = this.resolveRunPromise;
      this.resolveRunPromise = null;
      resolve(result);
    }
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
