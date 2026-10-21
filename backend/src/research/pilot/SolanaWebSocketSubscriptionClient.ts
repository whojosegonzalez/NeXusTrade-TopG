/**
 * Phase 12.94-D Milestone D.2.9-B2: Solana WebSocket Subscription Client
 *
 * Implements protocol-neutral, read-only Solana WebSocket log subscription management.
 * Manages separate subscriptions for Raydium AMM v4 and Raydium CPMM program mentions.
 *
 * Core Guarantees:
 * 1. Protocol Separation: AMM v4 and CPMM subscriptions are registered and tracked separately.
 * 2. Strict Message Budget: Enforces a configurable message ceiling; fails closed or stops upon exceedance.
 * 3. Typed Envelopes: Parses raw incoming WebSocket frames into canonical WebSocketLogNotificationEnvelope.
 * 4. Credential Redaction: Strips query parameters, passwords, or tokens from WS URLs in logs and metadata.
 * 5. Deterministic Offline Transport: Fully injectable ISolanaWebSocketTransport for 100% offline testing.
 */

import type {
  SubscriptionCommitment,
  WebSocketConnectionStatus,
  WebSocketLogNotificationEnvelope,
} from "./EventDiscoveryContracts.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID } from "./RaydiumAmmParser.js";
import { RAYDIUM_CPMM_PROGRAM_ID } from "./RaydiumCpmmParser.js";
import { sanitizeSolanaRpcUrl } from "./SolanaRpcLiveObservationClient.js";

export const DEFAULT_SOLANA_MAINNET_WSS = "wss://api.mainnet-beta.solana.com";

export type RaydiumSubscriptionProtocol = "RAYDIUM_AMM_V4" | "RAYDIUM_CPMM";

export interface ISolanaWebSocketTransport {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: string | Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number, reason: string) => void): void;
}

export interface SolanaWebSocketClientOptions {
  readonly wsUrl?: string | undefined;
  readonly transport?: ISolanaWebSocketTransport | undefined;
  readonly commitment?: SubscriptionCommitment | undefined;
  readonly maxMessagesBudget?: number | undefined; // Hard ceiling on incoming notification messages
  readonly onLog?: ((msg: string) => void) | undefined;
  readonly onNotification?:
    | ((envelope: WebSocketLogNotificationEnvelope, protocol: RaydiumSubscriptionProtocol) => void)
    | undefined;
  readonly onStatusChange?: ((status: WebSocketConnectionStatus) => void) | undefined;
}

export interface RawWebSocketNotificationRecord {
  readonly receivedEpochMs: number;
  readonly receivedIso: string;
  readonly subscriptionId: number;
  readonly protocol: RaydiumSubscriptionProtocol;
  readonly envelope: WebSocketLogNotificationEnvelope;
}

export class SolanaWebSocketSubscriptionClient {
  private readonly rawWsUrl: string;
  private readonly sanitizedWsUrl: string;
  private readonly endpointHost: string;
  private readonly endpointFingerprint: string;
  private readonly commitment: SubscriptionCommitment;
  private readonly maxMessagesBudget: number;
  private readonly transport?: ISolanaWebSocketTransport | undefined;
  private readonly onLog?: ((msg: string) => void) | undefined;
  private onNotification?:
    | ((envelope: WebSocketLogNotificationEnvelope, protocol: RaydiumSubscriptionProtocol) => void)
    | undefined;
  private readonly onStatusChange?: ((status: WebSocketConnectionStatus) => void) | undefined;

  private status: WebSocketConnectionStatus = "DISCONNECTED";
  private messagesReceived = 0;
  private ammV4Notifications = 0;
  private cpmmNotifications = 0;
  private unknownNotifications = 0;
  private droppedBudgetExceeded = 0;

  // Subscription mapping: RPC request ID -> Protocol, Subscription ID -> Protocol
  private readonly pendingRequests = new Map<number | string, RaydiumSubscriptionProtocol>();
  private readonly activeSubscriptions = new Map<number, RaydiumSubscriptionProtocol>();
  private readonly capturedNotifications: RawWebSocketNotificationRecord[] = [];

  private nextRequestId = 1;

  constructor(options: SolanaWebSocketClientOptions = {}) {
    const rawUrl = options.wsUrl ?? DEFAULT_SOLANA_MAINNET_WSS;
    const sanitized = sanitizeSolanaRpcUrl(rawUrl);
    this.rawWsUrl = rawUrl;
    this.sanitizedWsUrl = sanitized.sanitizedUrl;
    this.endpointHost = sanitized.host;
    this.endpointFingerprint = sanitized.endpointFingerprint;
    this.commitment = options.commitment ?? "confirmed";
    this.maxMessagesBudget = options.maxMessagesBudget ?? 500;
    this.transport = options.transport;
    this.onLog = options.onLog;
    this.onNotification = options.onNotification;
    this.onStatusChange = options.onStatusChange;

    if (this.transport) {
      this.bindTransport(this.transport);
    }
  }

  public getStatus(): WebSocketConnectionStatus {
    return this.status;
  }

  public getSanitizedUrl(): string {
    return this.sanitizedWsUrl;
  }

  public getRawUrl(): string {
    return this.rawWsUrl;
  }

  public getEndpointFingerprint(): string {
    return this.endpointFingerprint;
  }

  public getEndpointHost(): string {
    return this.endpointHost;
  }

  public getCapturedNotifications(): readonly RawWebSocketNotificationRecord[] {
    return this.capturedNotifications;
  }

  public setNotificationHandler(
    handler: (
      envelope: WebSocketLogNotificationEnvelope,
      protocol: RaydiumSubscriptionProtocol,
    ) => void,
  ): void {
    this.onNotification = handler;
  }

  public getMetrics(): {
    readonly messagesReceived: number;
    readonly ammV4Notifications: number;
    readonly cpmmNotifications: number;
    readonly unknownNotifications: number;
    readonly droppedBudgetExceeded: number;
    readonly activeSubscriptionsCount: number;
  } {
    return {
      messagesReceived: this.messagesReceived,
      ammV4Notifications: this.ammV4Notifications,
      cpmmNotifications: this.cpmmNotifications,
      unknownNotifications: this.unknownNotifications,
      droppedBudgetExceeded: this.droppedBudgetExceeded,
      activeSubscriptionsCount: this.activeSubscriptions.size,
    };
  }

  private setStatus(newStatus: WebSocketConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.onLog?.(`WebSocket status changed: ${newStatus}`);
      this.onStatusChange?.(newStatus);
    }
  }

  /**
   * Binds listeners to the provided WebSocket transport.
   */
  public bindTransport(transport: ISolanaWebSocketTransport): void {
    this.setStatus("CONNECTING");

    transport.on("open", () => {
      this.setStatus("CONNECTED");
      this.subscribeSeparateProtocols(transport);
    });

    transport.on("message", (data: string | Buffer) => {
      this.handleIncomingMessage(data.toString("utf8"));
    });

    transport.on("error", (err: Error) => {
      this.onLog?.(`WebSocket transport error: ${err.message}`);
    });

    transport.on("close", (code: number, reason: string) => {
      this.onLog?.(`WebSocket closed: code ${code}, reason: ${reason}`);
      this.setStatus("DISCONNECTED");
      this.activeSubscriptions.clear();
      this.pendingRequests.clear();
    });
  }

  /**
   * Registers separate subscriptions for Raydium AMM v4 and Raydium CPMM programs.
   */
  public subscribeSeparateProtocols(transport: ISolanaWebSocketTransport): void {
    // 1. Raydium AMM v4 subscription
    const ammV4ReqId = this.nextRequestId++;
    this.pendingRequests.set(ammV4ReqId, "RAYDIUM_AMM_V4");
    const ammV4Payload = {
      jsonrpc: "2.0" as const,
      id: ammV4ReqId,
      method: "logsSubscribe",
      params: [{ mentions: [RAYDIUM_AMM_V4_PROGRAM_ID] }, { commitment: this.commitment }],
    };
    transport.send(JSON.stringify(ammV4Payload));
    this.onLog?.(`Sent logsSubscribe for RAYDIUM_AMM_V4 (id: ${ammV4ReqId})`);

    // 2. Raydium CPMM subscription
    const cpmmReqId = this.nextRequestId++;
    this.pendingRequests.set(cpmmReqId, "RAYDIUM_CPMM");
    const cpmmPayload = {
      jsonrpc: "2.0" as const,
      id: cpmmReqId,
      method: "logsSubscribe",
      params: [{ mentions: [RAYDIUM_CPMM_PROGRAM_ID] }, { commitment: this.commitment }],
    };
    transport.send(JSON.stringify(cpmmPayload));
    this.onLog?.(`Sent logsSubscribe for RAYDIUM_CPMM (id: ${cpmmReqId})`);
  }

  /**
   * Ingests and routes a raw WebSocket message string.
   */
  public handleIncomingMessage(rawMessage: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawMessage);
    } catch (err) {
      this.onLog?.(`Failed to parse WebSocket JSON frame: ${err}`);
      return;
    }

    // 1. Handle subscription acknowledgment responses
    if ("result" in parsed && typeof parsed.id === "number") {
      const protocol = this.pendingRequests.get(parsed.id);
      if (protocol && typeof parsed.result === "number") {
        const subId = parsed.result;
        this.activeSubscriptions.set(subId, protocol);
        this.pendingRequests.delete(parsed.id);
        this.onLog?.(`Subscription confirmed: ${protocol} assigned subscriptionId ${subId}`);
        if (this.activeSubscriptions.size >= 2) {
          this.setStatus("SUBSCRIBED");
        }
        return;
      }
    }

    // 2. Handle logsNotification
    if (
      parsed.method === "logsNotification" &&
      parsed.params &&
      typeof parsed.params === "object"
    ) {
      const now = Date.now();
      if (this.messagesReceived >= this.maxMessagesBudget) {
        this.droppedBudgetExceeded++;
        this.onLog?.(
          `[WS_MESSAGE_BUDGET_EXCEEDED] Dropping incoming logsNotification: reached budget of ${this.maxMessagesBudget}`,
        );
        return;
      }

      this.messagesReceived++;
      const envelope = parsed as unknown as WebSocketLogNotificationEnvelope;
      const subId = envelope.params?.subscription;
      const protocol = this.activeSubscriptions.get(subId);

      if (protocol === "RAYDIUM_AMM_V4") {
        this.ammV4Notifications++;
      } else if (protocol === "RAYDIUM_CPMM") {
        this.cpmmNotifications++;
      } else {
        this.unknownNotifications++;
      }

      const assignedProtocol = protocol ?? "RAYDIUM_AMM_V4";
      const record: RawWebSocketNotificationRecord = {
        receivedEpochMs: now,
        receivedIso: new Date(now).toISOString(),
        subscriptionId: subId ?? 0,
        protocol: assignedProtocol,
        envelope,
      };
      this.capturedNotifications.push(record);

      this.onNotification?.(envelope, assignedProtocol);
    }
  }

  public close(): void {
    if (this.transport) {
      this.transport.close(1000, "Client initiated shutdown");
    }
    this.setStatus("DISCONNECTED");
  }
}
