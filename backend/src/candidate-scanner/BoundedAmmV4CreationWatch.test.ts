import { describe, it, expect } from "vitest";
import {
  BoundedAmmV4CreationWatch,
  DEFAULT_CREATION_WATCH_LIMITS,
  DEFAULT_WATCH_FEE_DESTINATION,
  type BoundedWatchTimers,
} from "./BoundedAmmV4CreationWatch.js";
import type { ISolanaKeepaliveWebSocketTransport } from "./RaydiumTransportObservationProbe.js";

const VALID_SIG_A =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const VALID_SIG_B =
  "QHREMqhWG7eahNuQ2EzQqSYKLy8WH9jVerfLRJTttyPorHxQJDzMMcB1142poqJHzYyVSsijoS1U9222QBV6AbM";

/**
 * Deterministic virtual timer queue that executes scheduled callbacks in virtual time.
 */
class VirtualTimerEnvironment {
  private currentTime: number;
  private timerIdCounter = 1;
  private timers = new Map<number, { dueTime: number; fn: () => void }>();

  constructor(startTime = 1_700_000_000_000) {
    this.currentTime = startTime;
  }

  clock = (): number => this.currentTime;

  getTimers(): BoundedWatchTimers {
    return {
      setTimeout: (fn: () => void, ms: number) => {
        const id = this.timerIdCounter++;
        this.timers.set(id, { dueTime: this.currentTime + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        if (typeof handle === "number") {
          this.timers.delete(handle);
        }
      },
    };
  }

  advanceTime(ms: number) {
    const targetTime = this.currentTime + ms;
    while (true) {
      let nextId: number | null = null;
      let nextDue = Infinity;
      for (const [id, timer] of this.timers.entries()) {
        if (timer.dueTime <= targetTime && timer.dueTime < nextDue) {
          nextDue = timer.dueTime;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.currentTime = timer.dueTime;
      timer.fn();
    }
    this.currentTime = targetTime;
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }
}

/**
 * Scriptable in-memory WebSocket mock matching ISolanaKeepaliveWebSocketTransport.
 */
class MockKeepaliveTransport implements ISolanaKeepaliveWebSocketTransport {
  readyState?: number; // optional, omitted when testing wrapper-only contracts
  sentMessages: string[] = [];
  sentPings: Buffer[] = [];
  closeCalls: { code?: number | undefined; reason?: string | undefined }[] = [];
  terminateCalled = false;

  autoCloseOnCloseCall = true;
  throwOnClose = false;
  throwOnTerminate = false;
  failToCloseOnTerminate = false;
  synchronousPongPayload?: Buffer | null = undefined;
  supportsPing = true;

  private listeners: {
    open: (() => void)[];
    message: ((data: string | Buffer) => void)[];
    pong: ((data: Buffer) => void)[];
    ping: ((data: Buffer) => void)[];
    error: ((err: Error) => void)[];
    close: ((code: number, reason: string) => void)[];
  } = {
    open: [],
    message: [],
    pong: [],
    ping: [],
    error: [],
    close: [],
  };

  private underlyingSocket?: { readyState: number } | undefined;

  constructor(options?: {
    initialReadyState?: number;
    underlyingSocketReadyState?: number;
    autoCloseOnCloseCall?: boolean;
    supportsPing?: boolean;
    throwOnClose?: boolean;
    throwOnTerminate?: boolean;
    failToCloseOnTerminate?: boolean;
    synchronousPongPayload?: Buffer | null;
  }) {
    if (options?.initialReadyState !== undefined) {
      this.readyState = options.initialReadyState;
    }
    if (options?.underlyingSocketReadyState !== undefined) {
      this.underlyingSocket = { readyState: options.underlyingSocketReadyState };
    }
    if (options?.autoCloseOnCloseCall !== undefined) {
      this.autoCloseOnCloseCall = options.autoCloseOnCloseCall;
    }
    if (options?.throwOnClose !== undefined) {
      this.throwOnClose = options.throwOnClose;
    }
    if (options?.throwOnTerminate !== undefined) {
      this.throwOnTerminate = options.throwOnTerminate;
    }
    if (options?.failToCloseOnTerminate !== undefined) {
      this.failToCloseOnTerminate = options.failToCloseOnTerminate;
    }
    if (options?.synchronousPongPayload !== undefined) {
      this.synchronousPongPayload = options.synchronousPongPayload;
    }
    if (options?.supportsPing === false) {
      this.supportsPing = false;
      // @ts-expect-error intentionally testing unsupported ping method
      this.ping = undefined;
    }
  }

  getUnderlyingSocket(): unknown {
    return this.underlyingSocket;
  }

  on: ISolanaKeepaliveWebSocketTransport["on"] = (event: string, listener: unknown): void => {
    if (event === "open") {
      this.listeners.open.push(listener as () => void);
    } else if (event === "message") {
      this.listeners.message.push(listener as (data: string | Buffer) => void);
    } else if (event === "pong") {
      this.listeners.pong.push(listener as (data: Buffer) => void);
    } else if (event === "ping") {
      this.listeners.ping.push(listener as (data: Buffer) => void);
    } else if (event === "error") {
      this.listeners.error.push(listener as (err: Error) => void);
    } else if (event === "close") {
      this.listeners.close.push(listener as (code: number, reason: string) => void);
    }
  };

  send(data: string): void {
    this.sentMessages.push(data);
  }

  ping?(data?: Buffer): void {
    if (!this.supportsPing) {
      throw new Error("ping is not supported");
    }
    const payload = data ?? Buffer.alloc(0);
    this.sentPings.push(payload);
    if (this.synchronousPongPayload !== undefined) {
      this.emitPong(this.synchronousPongPayload ?? payload);
    }
  }

  close(code?: number, reason?: string): void {
    if (this.throwOnClose) {
      throw new Error("Simulated close failure");
    }
    if (this.autoCloseOnCloseCall) {
      this.readyState = 3;
    }
    this.closeCalls.push({ code, reason });
  }

  terminate(): void {
    if (this.throwOnTerminate) {
      throw new Error("Simulated terminate failure");
    }
    this.terminateCalled = true;
    if (!this.failToCloseOnTerminate) {
      this.readyState = 3;
    }
  }

  // Test helpers to simulate incoming events
  emitOpen(): void {
    this.readyState = 1;
    for (const l of [...this.listeners.open]) l();
  }

  emitMessage(data: string | Buffer): void {
    for (const l of [...this.listeners.message]) l(data);
  }

  emitPong(data?: Buffer): void {
    for (const l of [...this.listeners.pong]) l(data ?? Buffer.alloc(0));
  }

  emitServerPing(data?: Buffer): void {
    for (const l of [...this.listeners.ping]) l(data ?? Buffer.alloc(0));
  }

  emitError(err: Error): void {
    for (const l of [...this.listeners.error]) l(err);
  }

  emitClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    for (const l of [...this.listeners.close]) l(code, reason);
  }
}

describe("BoundedAmmV4CreationWatch", () => {
  it("TC-01: construction is inert and validates configuration without performing I/O", () => {
    let factoryCalled = false;
    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      transportFactory: () => {
        factoryCalled = true;
        return new MockKeepaliveTransport();
      },
    });

    expect(factoryCalled).toBe(false);
    expect(watch.feeDestination).toBe(DEFAULT_WATCH_FEE_DESTINATION);
    expect(watch.limits).toEqual(DEFAULT_CREATION_WATCH_LIMITS);

    // Invalid wssUrl
    expect(() => {
      new BoundedAmmV4CreationWatch({
        wssUrl: "",
        transportFactory: () => new MockKeepaliveTransport(),
      });
    }).toThrow("[WATCH_CONFIG_INVALID]");

    // Invalid transportFactory
    expect(() => {
      new BoundedAmmV4CreationWatch({
        wssUrl: "wss://valid.url",
        transportFactory: null as unknown as (url: string) => ISolanaKeepaliveWebSocketTransport,
      });
    }).toThrow("[WATCH_CONFIG_INVALID]");

    // Invalid durations / limits: NaN, Infinity, negative, zero
    const invalidLimits = [
      { watchCeilingMs: NaN },
      { watchCeilingMs: Infinity },
      { watchCeilingMs: 0 },
      { watchCeilingMs: -100 },
      { ackTimeoutMs: 0 },
      { ackTimeoutMs: -1 },
      { ackTimeoutMs: NaN },
      { pingIntervalMs: 0 },
      { pingIntervalMs: -20 },
      { pongTimeoutMs: 0 },
      { pongTimeoutMs: -50 },
      { cleanupTimeoutMs: 0 },
      { maxPayloadBytes: 0 },
      { maxClientPings: 0 },
      { maxClientPings: 1.5 },
      { maxIncomingControlFrames: 0 },
      { maxIncomingControlFrames: -1 },
      { maxIncomingMessages: 0 },
      // pongTimeoutMs >= pingIntervalMs
      { pongTimeoutMs: 20_000, pingIntervalMs: 20_000 },
      { pongTimeoutMs: 25_000, pingIntervalMs: 20_000 },
    ];

    for (const limitOverride of invalidLimits) {
      expect(
        () =>
          new BoundedAmmV4CreationWatch({
            wssUrl: "wss://valid.url",
            transportFactory: () => new MockKeepaliveTransport(),
            limits: limitOverride,
          }),
        `Expected validation error for: ${JSON.stringify(limitOverride)}`,
      ).toThrow("[WATCH_CONFIG_INVALID]");
    }
  });

  it("TC-02: start() can only be called once per instance", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;
    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const promise = watch.start();
    expect(() => watch.start()).toThrow("[WATCH_ALREADY_STARTED]");

    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 42,
          result: {
            context: { slot: 300000000 },
            value: { signature: VALID_SIG_A, err: null, logs: ["invoke [1]"] },
          },
        },
      }),
    );

    const res = await promise;
    expect(res.status).toBe("NOTIFICATION_CAPTURED");
  });

  it("TC-03: happy path captures first qualifying notification, dispatches subscription, and closes cleanly", async () => {
    const vEnv = new VirtualTimerEnvironment(1_700_000_000_000);
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();

    // 1. Socket opens
    transport!.emitOpen();
    expect(transport!.sentMessages).toHaveLength(1);
    const sentSub = JSON.parse(transport!.sentMessages[0]!);
    expect(sentSub).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: [DEFAULT_WATCH_FEE_DESTINATION] }, { commitment: "confirmed" }],
    });

    // 2. Subscription ack arrives at +200 ms
    vEnv.advanceTime(200);
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 101 }));

    // 3. Qualifying creation notification arrives at +1,500 ms
    vEnv.advanceTime(1300);
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 101,
          result: {
            context: { slot: 305100200 },
            value: {
              signature: VALID_SIG_A,
              err: null,
              logs: ["Program 675kPX9... invoke [1]", "initialize2 success"],
            },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    expect(result.reason).toBe("First qualifying creation notification captured");
    expect(result.notification).not.toBeNull();
    expect(result.notification?.signature).toBe(VALID_SIG_A);
    expect(result.notification?.slot).toBe(305100200);
    expect(result.notification?.receivedAtMs).toBe(1_700_000_001_500);
    expect(result.notification?.logs).toEqual([
      "Program 675kPX9... invoke [1]",
      "initialize2 success",
    ]);
    expect(result.notification?.disclaimer).toContain("PROVISIONAL");

    // Transport closed cleanly
    expect(transport!.closeCalls).toHaveLength(1);
    expect(transport!.closeCalls[0]?.code).toBe(1000);

    // Observations
    expect(result.observations.subscriptionId).toBe(101);
    expect(result.observations.messagesReceivedCount).toBe(2);
    expect(result.observations.durationMs).toBe(1500);
    expect(result.observations.failedNotificationsCount).toBe(0);
    expect(result.observations.rejectedNotificationsCount).toBe(0);
    expect(result.observations.cleanupSettled).toBe(true);
    expect(result.observations.cleanupFailed).toBe(false);
  });

  it("TC-04: subscription ack timeout terminates within 5,000 ms if no ack arrives", async () => {
    const vEnv = new VirtualTimerEnvironment(1_700_000_000_000);
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();

    // Advance 4,999 ms -> still waiting
    vEnv.advanceTime(4999);
    expect(transport!.closeCalls).toHaveLength(0);

    // Advance past 5,000 ms ack deadline
    vEnv.advanceTime(2);
    const result = await watchPromise;

    expect(result.status).toBe("SUBSCRIBE_ACK_TIMEOUT");
    expect(result.reason).toContain("Subscription acknowledgement not received within 5000 ms");
    expect(result.notification).toBeNull();
    expect(transport!.closeCalls).toHaveLength(1);
  });

  it("TC-05: subscription rejection with provider error terminates with SUBSCRIBE_REJECTED", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();

    // Provider rejects subscription
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Subscription limit exceeded for account" },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("SUBSCRIBE_REJECTED");
    expect(result.reason).toContain("Subscription limit exceeded for account");
    expect(result.notification).toBeNull();
  });

  it("TC-06: malformed acknowledgement frames terminate fail-closed with MALFORMED_FRAME", async () => {
    const testCases = [
      { name: "invalid json", raw: "NOT_VALID_JSON" },
      { name: "not an object", raw: "[1, 2, 3]" },
      { name: "wrong jsonrpc version", raw: JSON.stringify({ jsonrpc: "1.0", id: 1, result: 1 }) },
      {
        name: "mismatched request id",
        raw: JSON.stringify({ jsonrpc: "2.0", id: 999, result: 1 }),
      },
      {
        name: "result not positive safe integer",
        raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: -5 }),
      },
      {
        name: "result string instead of number",
        raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "42" }),
      },
    ];

    for (const tc of testCases) {
      const vEnv = new VirtualTimerEnvironment();
      let transport: MockKeepaliveTransport;

      const watch = new BoundedAmmV4CreationWatch({
        wssUrl: "wss://api.mainnet-beta.solana.com",
        clock: vEnv.clock,
        timers: vEnv.getTimers(),
        transportFactory: () => {
          transport = new MockKeepaliveTransport();
          return transport;
        },
      });

      const watchPromise = watch.start();
      transport!.emitOpen();
      transport!.emitMessage(tc.raw);

      const result = await watchPromise;
      expect(result.status, `Failed for case: ${tc.name}`).toBe("MALFORMED_FRAME");
      expect(result.notification).toBeNull();
    }
  });

  it("TC-07: notification with wrong subscription ID is rejected and counted without terminating", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 77 }));

    // Unsolicited notification for subscription 999
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 999,
          result: {
            context: { slot: 100 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    expect(transport!.closeCalls).toHaveLength(0);

    // Matching notification arrives and captures
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 77,
          result: {
            context: { slot: 101 },
            value: { signature: VALID_SIG_B, err: null, logs: [] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    expect(result.notification?.signature).toBe(VALID_SIG_B);
    expect(result.observations.rejectedNotificationsCount).toBe(1);
  });

  it("TC-08: requires explicit successful transaction status (err === null); absent or non-null err does not qualify", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 55 }));

    // 1. Missing `err` property entirely -> does NOT qualify
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 55,
          result: {
            context: { slot: 298 },
            value: {
              signature: VALID_SIG_A,
              logs: ["invoke [1]"],
            },
          },
        },
      }),
    );
    expect(transport!.closeCalls).toHaveLength(0);

    // 2. `err: undefined` -> does NOT qualify
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 55,
          result: {
            context: { slot: 299 },
            value: {
              signature: VALID_SIG_A,
              err: undefined,
              logs: ["invoke [1]"],
            },
          },
        },
      }),
    );
    expect(transport!.closeCalls).toHaveLength(0);

    // 3. Failed on-chain transaction (err is an object) -> does NOT qualify
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 55,
          result: {
            context: { slot: 300 },
            value: {
              signature: VALID_SIG_A,
              err: { InstructionError: [0, { Custom: 1 }] },
              logs: ["Program 675k... failed"],
            },
          },
        },
      }),
    );
    expect(transport!.closeCalls).toHaveLength(0);

    // 4. Subsequent successful transaction (err === null) captures
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 55,
          result: {
            context: { slot: 301 },
            value: { signature: VALID_SIG_B, err: null, logs: ["success"] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    expect(result.notification?.signature).toBe(VALID_SIG_B);
    expect(result.observations.failedNotificationsCount).toBe(3);
  });

  it("TC-09: notification with invalid signature or slot is recorded as rejected", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // 1. Invalid slot (0)
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 0 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    // 2. Invalid base58 signature
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 100 },
            value: { signature: "NOT_A_VALID_SOLANA_SIG", err: null, logs: [] },
          },
        },
      }),
    );

    // 3. Valid notification arrives
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 101 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    expect(result.observations.rejectedNotificationsCount).toBe(2);
  });

  it("TC-10: keepalive ping/pong matches accurately with payload verification", async () => {
    const vEnv = new VirtualTimerEnvironment(1_700_000_000_000);
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Advance 20 s -> first client ping is sent
    vEnv.advanceTime(20_000);
    expect(transport!.sentPings).toHaveLength(1);
    expect(transport!.sentPings[0]!.toString("utf8")).toBe("topg-watch-1");

    // Pong arrives with matching payload
    vEnv.advanceTime(2_000);
    transport!.emitPong(transport!.sentPings[0]);

    // Advance another 18 s (total 40 s from start) -> second client ping
    vEnv.advanceTime(18_000);
    expect(transport!.sentPings).toHaveLength(2);
    expect(transport!.sentPings[1]!.toString("utf8")).toBe("topg-watch-2");

    // Second pong arrives with matching payload
    vEnv.advanceTime(1_000);
    transport!.emitPong(transport!.sentPings[1]);

    // Finally notification arrives
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 123 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    expect(result.observations.clientPingsSentCount).toBe(2);
    expect(result.observations.matchedPongsCount).toBe(2);
    expect(result.observations.pongsReceivedCount).toBe(2);
  });

  it("TC-10-R: pong matching reproduction: wrong payload does not clear deadline and causes KEEPALIVE_TIMEOUT", async () => {
    const vEnv = new VirtualTimerEnvironment(1_700_000_000_000);
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Advance 20 s -> ping 1 sent
    vEnv.advanceTime(20_000);
    expect(transport!.sentPings).toHaveLength(1);

    // Mismatched pong payload arrives at 22 s
    vEnv.advanceTime(2_000);
    transport!.emitPong(Buffer.from("WRONG_PAYLOAD"));

    // Advance past 30 s deadline (ping at 20s + 10s timeout = 30s)
    vEnv.advanceTime(9_000); // at 31 s

    // Attempt to deliver qualifying notification at 35 s
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 999 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("KEEPALIVE_TIMEOUT");
    expect(result.reason).toContain("First unmatched pong deadline expired");
    expect(result.notification).toBeNull();
    expect(result.observations.matchedPongsCount).toBe(0);
  });

  it("TC-10-S: synchronous mock replies match pong payload correctly without race condition", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport({
          synchronousPongPayload: null, // echoes exact ping payload synchronously
        });
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Advance 20s -> ping triggers synchronous pong reply
    vEnv.advanceTime(20_000);
    expect(transport!.sentPings).toHaveLength(1);

    // Notification arrives
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 100 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    expect(result.observations.matchedPongsCount).toBe(1);
  });

  it("TC-10-U: unsupported ping capability terminates with TRANSPORT_ERROR", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport({
          supportsPing: false,
        });
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Advance 20s -> ping attempt detects missing ping capability
    vEnv.advanceTime(20_000);

    const result = await watchPromise;
    expect(result.status).toBe("TRANSPORT_ERROR");
    expect(result.reason).toContain("Transport does not support keepalive ping capability");
  });

  it("TC-11: unmatched pong deadline stops watch with KEEPALIVE_TIMEOUT (zero reconnects)", async () => {
    const vEnv = new VirtualTimerEnvironment(1_700_000_000_000);
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Ping sent at 20 s
    vEnv.advanceTime(20_000);
    expect(transport!.sentPings).toHaveLength(1);

    // Advance past 10 s pong timeout (total 30 s from start) -> deadline expires
    vEnv.advanceTime(10_001);

    const result = await watchPromise;
    expect(result.status).toBe("KEEPALIVE_TIMEOUT");
    expect(result.reason).toContain("First unmatched pong deadline expired");
    expect(result.notification).toBeNull();
    expect(result.observations.matchedPongsCount).toBe(0);
  });

  it("TC-12: exceeding max client pings (45) terminates with CLIENT_PING_LIMIT_EXCEEDED", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      limits: { maxClientPings: 3 },
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Ping 1
    vEnv.advanceTime(20_000);
    transport!.emitPong(transport!.sentPings[0]);
    // Ping 2
    vEnv.advanceTime(20_000);
    transport!.emitPong(transport!.sentPings[1]);
    // Ping 3
    vEnv.advanceTime(20_000);
    transport!.emitPong(transport!.sentPings[2]);

    // Ping 4 triggers limit
    vEnv.advanceTime(20_000);

    const result = await watchPromise;
    expect(result.status).toBe("CLIENT_PING_LIMIT_EXCEEDED");
    expect(result.observations.clientPingsSentCount).toBe(3);
  });

  it("TC-13: exceeding max incoming control frames (128) terminates with CONTROL_FRAME_LIMIT_EXCEEDED", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      limits: { maxIncomingControlFrames: 5 },
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Emit 6 server pings
    for (let i = 0; i < 6; i++) {
      transport!.emitServerPing();
    }

    const result = await watchPromise;
    expect(result.status).toBe("CONTROL_FRAME_LIMIT_EXCEEDED");
    expect(result.observations.incomingControlFramesCount).toBe(6);
  });

  it("TC-14: exceeding max incoming application messages (100) terminates with MESSAGE_LIMIT_EXCEEDED", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      limits: { maxIncomingMessages: 3 },
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    // Message 1 (ack)
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
    // Message 2
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", method: "other" }));
    // Message 3
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", method: "other" }));
    // Message 4 -> triggers limit
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", method: "other" }));

    const result = await watchPromise;
    expect(result.status).toBe("MESSAGE_LIMIT_EXCEEDED");
    expect(result.observations.messagesReceivedCount).toBe(4);
  });

  it("TC-15: exceeding max payload byte ceiling (1 MiB) terminates with PAYLOAD_BYTE_CEILING_EXCEEDED", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      limits: { maxPayloadBytes: 500 },
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Send a frame that exceeds 500 bytes
    const largeFrame = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: { padding: "X".repeat(600) },
    });
    transport!.emitMessage(largeFrame);

    const result = await watchPromise;
    expect(result.status).toBe("PAYLOAD_BYTE_CEILING_EXCEEDED");
    expect(result.observations.payloadBytesReceived).toBeGreaterThan(500);
  });

  it("TC-16: 15-minute watch ceiling reached without creations exits with NO_QUALIFYING_NOTIFICATION_OBSERVED", async () => {
    const vEnv = new VirtualTimerEnvironment(1_700_000_000_000);
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Simulate 15 minutes (900,000 ms) in virtual time with keepalive cycles
    for (let i = 0; i < 44; i++) {
      vEnv.advanceTime(20_000);
      transport!.emitPong(transport!.sentPings[i]);
    }
    // Advance remaining time to 900,000 ms
    vEnv.advanceTime(20_000);

    const result = await watchPromise;
    expect(result.status).toBe("NO_QUALIFYING_NOTIFICATION_OBSERVED");
    expect(result.reason).toContain("no qualifying notification observed");
    expect(result.notification).toBeNull();
    expect(transport!.closeCalls).toHaveLength(1);
    expect(result.observations.durationMs).toBe(900_000);
  });

  it("TC-17: absolute deadline enforcement triggers on incoming message even if timer delayed", async () => {
    const vEnv = new VirtualTimerEnvironment(1_700_000_000_000);
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: {
        setTimeout: () => 123, // dummy timer that never fires
        clearTimeout: () => {},
      },
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Advance clock past 900,000 ms without firing timer
    vEnv.advanceTime(900_001);

    // Incoming message triggers deadline check
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 100 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NO_QUALIFYING_NOTIFICATION_OBSERVED");
  });

  it("TC-18: operator cancellation via AbortSignal terminates with OPERATOR_CANCELLED", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;
    const controller = new AbortController();

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      abortSignal: controller.signal,
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();

    controller.abort();

    const result = await watchPromise;
    expect(result.status).toBe("OPERATOR_CANCELLED");
    expect(result.reason).toContain("Operator abort signal triggered");
    expect(transport!.closeCalls).toHaveLength(1);
  });

  it("TC-19: premature transport close and transport error terminate cleanly", async () => {
    // 1. Error
    {
      const vEnv = new VirtualTimerEnvironment();
      let transport: MockKeepaliveTransport;
      const watch = new BoundedAmmV4CreationWatch({
        wssUrl: "wss://api.mainnet-beta.solana.com",
        clock: vEnv.clock,
        timers: vEnv.getTimers(),
        transportFactory: () => {
          transport = new MockKeepaliveTransport();
          return transport;
        },
      });
      const promise = watch.start();
      transport!.emitError(new Error("ECONNRESET: connection reset by peer"));
      const result = await promise;
      expect(result.status).toBe("TRANSPORT_ERROR");
      expect(result.reason).toContain("ECONNRESET");
    }

    // 2. Close
    {
      const vEnv = new VirtualTimerEnvironment();
      let transport: MockKeepaliveTransport;
      const watch = new BoundedAmmV4CreationWatch({
        wssUrl: "wss://api.mainnet-beta.solana.com",
        clock: vEnv.clock,
        timers: vEnv.getTimers(),
        transportFactory: () => {
          transport = new MockKeepaliveTransport();
          return transport;
        },
      });
      const promise = watch.start();
      transport!.emitClose(1006, "Abnormal closure");
      const result = await promise;
      expect(result.status).toBe("TRANSPORT_CLOSED");
      expect(result.reason).toContain("1006");
    }
  });

  it("TC-20: late events after completion cannot mutate the result", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 100 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    const originalMessagesCount = result.observations.messagesReceivedCount;
    const originalSignature = result.notification?.signature;

    // Inject late messages, pongs, pings, errors
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 200 },
            value: { signature: VALID_SIG_B, err: null, logs: [] },
          },
        },
      }),
    );
    transport!.emitPong();
    transport!.emitError(new Error("Late error"));

    expect(result.observations.messagesReceivedCount).toBe(originalMessagesCount);
    expect(result.notification?.signature).toBe(originalSignature);
  });

  it("TC-21: returned result, observations, and nested error arrays are deep-frozen and immutable", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Failed notification with nested InstructionError array and detail object
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 99 },
            value: {
              signature: VALID_SIG_A,
              err: {
                InstructionError: [0, "Custom"],
                Details: { nestedCode: 123 },
              },
              logs: ["fail"],
            },
          },
        },
      }),
    );

    // Qualifying notification captures
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 100 },
            value: { signature: VALID_SIG_A, err: null, logs: ["test"] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.notification)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(Object.isFrozen(result.observations.events)).toBe(true);
    expect(Object.isFrozen(result.observations.applicationFrames)).toBe(true);

    // Root immutability
    expect(() => {
      (result as unknown as { status: string }).status = "MUTATED";
    }).toThrow();

    // Deep immutability of nested error array in events
    const failedEvent = result.observations.events.find((e) => e.type === "NOTIFICATION_FAILED");
    expect(failedEvent).toBeDefined();
    const details = failedEvent!.details as {
      err: { InstructionError: unknown[]; Details: { nestedCode: number } };
    };

    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details.err)).toBe(true);
    expect(Object.isFrozen(details.err.InstructionError)).toBe(true);
    expect(Object.isFrozen(details.err.Details)).toBe(true);

    // Modifying nested error array throws in strict mode
    expect(() => {
      details.err.InstructionError.push("ILLEGAL_MUTATION");
    }).toThrow();

    expect(() => {
      (details.err.InstructionError as unknown as unknown[])[0] = 999;
    }).toThrow();

    expect(() => {
      details.err.Details.nestedCode = 999;
    }).toThrow();
  });

  it("TC-22: initializes reliably when socket is already open via getUnderlyingSocket().readyState === 1 without open event", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport({
          underlyingSocketReadyState: 1,
        });
        return transport;
      },
    });

    const watchPromise = watch.start();

    // Without emitting open, subscription should already be dispatched
    expect(transport!.sentMessages).toHaveLength(1);
    expect(JSON.parse(transport!.sentMessages[0]!).method).toBe("logsSubscribe");

    // Ack and notification complete normally
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 99 }));
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 99,
          result: {
            context: { slot: 12345 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
  });

  it("TC-23: retains accepted application frames completely without truncation, tracks byte accounting, and sanitizes WSS URL", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://user:supersecretpass@api.mainnet-beta.solana.com/?api-key=secretTokenKey12345",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();

    // Outgoing subscription frame is dispatched
    // Receive ack
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 10 }));

    // Send a 5,000-byte non-qualifying message (well within the default 1 MiB watch ceiling)
    const padding = "P".repeat(5000);
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 999, // wrong sub ID
          result: { padding },
        },
      }),
    );

    // Send qualifying notification
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 10,
          result: {
            context: { slot: 500 },
            value: { signature: VALID_SIG_A, err: null, logs: ["ok"] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");

    // Check application frames retention: every accepted frame is completely preserved
    const frames = result.observations.applicationFrames;
    expect(frames.length).toBe(4);

    // Frame 0: Outgoing subscription
    expect(frames[0]!.direction).toBe("OUTGOING");
    expect(frames[0]!.isComplete).toBe(true);
    expect(frames[0]!.payload).toContain("logsSubscribe");
    expect(frames[0]!.byteLength).toBeGreaterThan(0);

    // Frame 1: Incoming ack
    expect(frames[1]!.direction).toBe("INCOMING");
    expect(frames[1]!.isComplete).toBe(true);
    expect(frames[1]!.payload).toContain('"result":10');
    expect(frames[1]!.byteLength).toBeGreaterThan(0);

    // Frame 2: Incoming 5,000-byte message -> completely preserved without 4,096-byte truncation
    expect(frames[2]!.direction).toBe("INCOMING");
    expect(frames[2]!.isComplete).toBe(true);
    expect(frames[2]!.byteLength).toBeGreaterThan(5000);
    expect(frames[2]!.payload).not.toBeNull();
    expect(frames[2]!.payload!.length).toBeGreaterThan(5000);
    expect(() => JSON.parse(frames[2]!.payload!)).not.toThrow();

    // Frame 3: Incoming qualifying notification
    expect(frames[3]!.direction).toBe("INCOMING");
    expect(frames[3]!.isComplete).toBe(true);
    expect(frames[3]!.payload).toContain(VALID_SIG_A);

    // Verify WSS URL sanitization in event metadata
    const startedEvent = result.observations.events.find((e) => e.type === "WATCH_STARTED");
    expect(startedEvent).toBeDefined();
    const recordedUrl = String(startedEvent!.details?.wssUrl);
    expect(recordedUrl).toContain("[REDACTED]");
    expect(recordedUrl).not.toContain("supersecretpass");
    expect(recordedUrl).not.toContain("secretTokenKey12345");
  });

  it("TC-23-A: qualifying creation notification above 4,096 bytes retains complete frame and re-parses as valid JSON", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Construct a qualifying creation notification of ~6,249 bytes (50 detailed log entries)
    const logs50 = Array.from(
      { length: 50 },
      (_, i) =>
        `Program log: Instruction initialize2 step ${i} completed successfully with candidate account validation token swap path confirmed`,
    );

    const validLargeNotification = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 1,
        result: {
          context: { slot: 305100999 },
          value: {
            signature: VALID_SIG_A,
            err: null,
            logs: logs50,
          },
        },
      },
    });

    const expectedByteLength = Buffer.byteLength(validLargeNotification, "utf8");
    expect(expectedByteLength).toBeGreaterThan(4096);
    expect(expectedByteLength).toBeGreaterThan(6000);

    transport!.emitMessage(validLargeNotification);

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    expect(result.notification?.signature).toBe(VALID_SIG_A);

    // Check that the qualifying frame at index 2 is completely preserved without truncation
    const frames = result.observations.applicationFrames;
    expect(frames.length).toBe(3); // Frame 0: Outgoing sub, Frame 1: Ack, Frame 2: Qualifying notification
    const qualifyingFrame = frames[2]!;

    expect(qualifyingFrame.direction).toBe("INCOMING");
    expect(qualifyingFrame.isComplete).toBe(true);
    expect(qualifyingFrame.byteLength).toBe(expectedByteLength);
    expect(qualifyingFrame.payload).not.toBeNull();
    expect(qualifyingFrame.payload!.length).toBe(validLargeNotification.length);

    // Exact JSON re-parsing succeeds without SyntaxError
    const reparsed = JSON.parse(qualifyingFrame.payload!);
    expect(reparsed.method).toBe("logsNotification");
    expect(reparsed.params.result.value.signature).toBe(VALID_SIG_A);
    expect(reparsed.params.result.value.logs).toHaveLength(50);
  });

  it("TC-23-B: multibyte UTF-8 content maintains exact byte accounting and preserves complete characters", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Notification containing multibyte UTF-8 sequences (emoji, Greek, CJK, accents)
    const multibyteLog = "Initialisation de pool: «NeXusTrade™ 🚀» • 闪电 • 100% α-β-γ";
    const notificationJson = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 1,
        result: {
          context: { slot: 200 },
          value: {
            signature: VALID_SIG_A,
            err: null,
            logs: [multibyteLog],
          },
        },
      },
    });

    const expectedByteLength = Buffer.byteLength(notificationJson, "utf8");
    // Verify that multibyte byte count is strictly greater than string character length
    expect(expectedByteLength).toBeGreaterThan(notificationJson.length);

    transport!.emitMessage(notificationJson);

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");

    const qualifyingFrame = result.observations.applicationFrames[2]!;
    expect(qualifyingFrame.isComplete).toBe(true);
    expect(qualifyingFrame.byteLength).toBe(expectedByteLength);
    expect(Buffer.byteLength(qualifyingFrame.payload!, "utf8")).toBe(expectedByteLength);

    // Re-parsed payload matches exact characters without corruption
    const reparsed = JSON.parse(qualifyingFrame.payload!);
    expect(reparsed.params.result.value.logs[0]).toBe(multibyteLog);
  });

  it("TC-23-C: exact payload reconstruction and JSON re-parsing across all accepted session frames", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    // Rejected notification (wrong sub ID)
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 999,
          result: { context: { slot: 1 }, value: { signature: VALID_SIG_B, err: null, logs: [] } },
        },
      }),
    );

    // Qualifying notification
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 42,
          result: {
            context: { slot: 100 },
            value: { signature: VALID_SIG_A, err: null, logs: ["done"] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");

    // Every accepted frame must re-parse cleanly as valid JSON
    for (const frame of result.observations.applicationFrames) {
      expect(frame.isComplete).toBe(true);
      expect(frame.payload).not.toBeNull();
      const parsed = JSON.parse(frame.payload!);
      expect(parsed).toBeTypeOf("object");
      expect(parsed).not.toBeNull();
    }
  });

  it("TC-23-D: an over-ceiling frame stops before payload decoding and retains metadata only", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      limits: { maxPayloadBytes: 2500 },
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Send an incoming frame of 4,000 bytes (Buffer), exceeding 2,500 ceiling
    const rawOversizedBuffer = Buffer.alloc(4000, 0x41); // 4,000 bytes of 'A'
    transport!.emitMessage(rawOversizedBuffer);

    const result = await watchPromise;
    expect(result.status).toBe("PAYLOAD_BYTE_CEILING_EXCEEDED");

    const frames = result.observations.applicationFrames;
    expect(frames.length).toBe(3); // Outgoing sub, Ack, Over-ceiling frame

    // Frame 0: Outgoing sub -> complete
    expect(frames[0]!.isComplete).toBe(true);
    expect(frames[0]!.payload).not.toBeNull();

    // Frame 1: Ack -> complete
    expect(frames[1]!.isComplete).toBe(true);
    expect(frames[1]!.payload).not.toBeNull();

    // Frame 2: Over-ceiling frame -> metadata only, payload is null
    const overflowFrame = frames[2]!;
    expect(overflowFrame.direction).toBe("INCOMING");
    expect(overflowFrame.isComplete).toBe(false);
    expect(overflowFrame.payload).toBeNull();
    expect(overflowFrame.overflow).toBe(true);
    expect(overflowFrame.overflowReason).toBe("PAYLOAD_BYTE_CEILING_EXCEEDED");
    expect(overflowFrame.byteLength).toBe(4000);
  });

  it("TC-23-E: no accepted capture whose required frame was omitted (supports beyond hardcoded 128 limit)", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      limits: { maxIncomingMessages: 150 }, // configured above previous 128 hardcoded limit
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Send 130 non-matching notifications (wrong sub ID) -> messages 2 to 131
    for (let i = 0; i < 130; i++) {
      transport!.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 999,
            result: {
              context: { slot: i + 1 },
              value: { signature: VALID_SIG_B, err: null, logs: [] },
            },
          },
        }),
      );
    }

    // Message 132: valid qualifying creation notification
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 300000 },
            value: { signature: VALID_SIG_A, err: null, logs: ["success"] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");

    // All frames are preserved: 1 outgoing sub + 1 ack + 130 rejected + 1 qualifying = 133 frames
    const frames = result.observations.applicationFrames;
    expect(frames.length).toBe(133);

    // The qualifying creation notification is preserved at index 132 in full
    const qualifyingFrame = frames[132]!;
    expect(qualifyingFrame.isComplete).toBe(true);
    expect(qualifyingFrame.payload).not.toBeNull();
    expect(qualifyingFrame.payload).toContain(VALID_SIG_A);
    expect(qualifyingFrame.byteLength).toBe(Buffer.byteLength(qualifyingFrame.payload!, "utf8"));
  });

  it("TC-24: finishes bounded cleanup before resolving (immediate, delayed, forced, and close failure)", async () => {
    // 1. Immediate closure: transport close() synchronously sets readyState = 3
    {
      const vEnv = new VirtualTimerEnvironment();
      let transport: MockKeepaliveTransport;

      const watch = new BoundedAmmV4CreationWatch({
        wssUrl: "wss://api.mainnet-beta.solana.com",
        clock: vEnv.clock,
        timers: vEnv.getTimers(),
        transportFactory: () => {
          transport = new MockKeepaliveTransport({ autoCloseOnCloseCall: true });
          return transport;
        },
      });

      const promise = watch.start();
      transport!.emitOpen();
      transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      transport!.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 10 },
              value: { signature: VALID_SIG_A, err: null, logs: [] },
            },
          },
        }),
      );

      const res = await promise;
      expect(res.status).toBe("NOTIFICATION_CAPTURED");
      expect(res.observations.cleanupSettled).toBe(true);
      expect(res.observations.cleanupFailed).toBe(false);
      expect(vEnv.pendingTimerCount()).toBe(0);
    }

    // 2. Delayed closure: transport close() does not set readyState = 3 until emitClose fires later
    {
      const vEnv = new VirtualTimerEnvironment();
      let transport: MockKeepaliveTransport;

      const watch = new BoundedAmmV4CreationWatch({
        wssUrl: "wss://api.mainnet-beta.solana.com",
        clock: vEnv.clock,
        timers: vEnv.getTimers(),
        transportFactory: () => {
          transport = new MockKeepaliveTransport({ autoCloseOnCloseCall: false });
          return transport;
        },
      });

      let resolved = false;
      const promise = watch.start().then((r) => {
        resolved = true;
        return r;
      });

      transport!.emitOpen();
      transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      transport!.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 10 },
              value: { signature: VALID_SIG_A, err: null, logs: [] },
            },
          },
        }),
      );

      // Not resolved yet because socket close has not settled
      expect(resolved).toBe(false);

      // 500 ms later, close event emits
      vEnv.advanceTime(500);
      transport!.emitClose(1000, "Clean close");

      const res = await promise;
      expect(resolved).toBe(true);
      expect(res.status).toBe("NOTIFICATION_CAPTURED");
      expect(res.observations.cleanupSettled).toBe(true);
      expect(res.observations.cleanupFailed).toBe(false);
      expect(vEnv.pendingTimerCount()).toBe(0);
    }

    // 3. Forced cleanup: transport never emits close; cleanup timer forces terminate()
    {
      const vEnv = new VirtualTimerEnvironment();
      let transport: MockKeepaliveTransport;

      const watch = new BoundedAmmV4CreationWatch({
        wssUrl: "wss://api.mainnet-beta.solana.com",
        clock: vEnv.clock,
        timers: vEnv.getTimers(),
        limits: { cleanupTimeoutMs: 5_000 },
        transportFactory: () => {
          transport = new MockKeepaliveTransport({ autoCloseOnCloseCall: false });
          return transport;
        },
      });

      let resolved = false;
      const promise = watch.start().then((r) => {
        resolved = true;
        return r;
      });

      transport!.emitOpen();
      transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      transport!.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 10 },
              value: { signature: VALID_SIG_A, err: null, logs: [] },
            },
          },
        }),
      );

      expect(resolved).toBe(false);

      // Advance 5,000 ms -> cleanup timer calls terminate() which sets readyState 3
      vEnv.advanceTime(5_000);

      const res = await promise;
      expect(resolved).toBe(true);
      expect(transport!.terminateCalled).toBe(true);
      expect(res.observations.cleanupSettled).toBe(true);
      expect(res.observations.cleanupFailed).toBe(false);
      expect(vEnv.pendingTimerCount()).toBe(0);
    }

    // 4. Close failure: close() throws and terminate() fails to close
    {
      const vEnv = new VirtualTimerEnvironment();
      let transport: MockKeepaliveTransport;

      const watch = new BoundedAmmV4CreationWatch({
        wssUrl: "wss://api.mainnet-beta.solana.com",
        clock: vEnv.clock,
        timers: vEnv.getTimers(),
        transportFactory: () => {
          transport = new MockKeepaliveTransport({
            throwOnClose: true,
            failToCloseOnTerminate: true,
          });
          return transport;
        },
      });

      const promise = watch.start();
      transport!.emitOpen();
      transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      transport!.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 10 },
              value: { signature: VALID_SIG_A, err: null, logs: [] },
            },
          },
        }),
      );

      const res = await promise;
      expect(res.observations.cleanupSettled).toBe(true);
      expect(res.observations.cleanupFailed).toBe(true);
      expect(res.observations.cleanupFailureReason).toContain("Transport close threw");
      expect(vEnv.pendingTimerCount()).toBe(0);
    }
  });

  it("TC-25: zero remaining owned timers/listeners and preserved notification receipt time across delayed cleanup", async () => {
    const vEnv = new VirtualTimerEnvironment(1_700_000_000_000);
    let transport: MockKeepaliveTransport;
    const controller = new AbortController();

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      abortSignal: controller.signal,
      transportFactory: () => {
        transport = new MockKeepaliveTransport({ autoCloseOnCloseCall: false });
        return transport;
      },
    });

    const promise = watch.start();
    transport!.emitOpen();

    // Advance 1,000 ms to ack
    vEnv.advanceTime(1_000);
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Advance 4,000 ms to notification (t = 5,000 ms total)
    vEnv.advanceTime(4_000);
    const notificationArrivalEpochMs = vEnv.clock();
    expect(notificationArrivalEpochMs).toBe(1_700_000_005_000);

    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 1,
          result: {
            context: { slot: 777 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
          },
        },
      }),
    );

    // Delay cleanup closure by another 2,000 ms (t = 7,000 ms total)
    vEnv.advanceTime(2_000);
    expect(vEnv.clock()).toBe(1_700_000_007_000);

    // Socket finally closes
    transport!.emitClose(1000, "Delayed close settled");

    const result = await promise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");

    // CRITICAL: notification.receivedAtMs must preserve original receipt time (5,000 ms), NOT cleanup completion time (7,000 ms)
    expect(result.notification?.receivedAtMs).toBe(1_700_000_005_000);
    expect(result.observations.endedAtMs).toBe(1_700_000_005_000);

    // Verify zero owned timers remain active
    expect(vEnv.pendingTimerCount()).toBe(0);
  });
});
