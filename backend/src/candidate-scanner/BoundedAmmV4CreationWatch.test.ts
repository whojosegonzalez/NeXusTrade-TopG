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

  constructor(options?: { initialReadyState?: number; underlyingSocketReadyState?: number }) {
    if (options?.initialReadyState !== undefined) {
      this.readyState = options.initialReadyState;
    }
    if (options?.underlyingSocketReadyState !== undefined) {
      this.underlyingSocket = { readyState: options.underlyingSocketReadyState };
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

  ping(data?: Buffer): void {
    this.sentPings.push(data ?? Buffer.alloc(0));
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
  }

  terminate(): void {
    this.terminateCalled = true;
    this.readyState = 3;
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

    expect(() => {
      new BoundedAmmV4CreationWatch({
        wssUrl: "",
        transportFactory: () => new MockKeepaliveTransport(),
      });
    }).toThrow("[WATCH_CONFIG_INVALID]");

    expect(() => {
      new BoundedAmmV4CreationWatch({
        wssUrl: "wss://valid.url",
        transportFactory: null as unknown as (url: string) => ISolanaKeepaliveWebSocketTransport,
      });
    }).toThrow("[WATCH_CONFIG_INVALID]");
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

    // Watch should still be running
    expect(transport!.closeCalls).toHaveLength(0);

    // Subsequent matching notification captures successfully
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 77,
          result: {
            context: { slot: 200 },
            value: { signature: VALID_SIG_B, err: null, logs: ["ok"] },
          },
        },
      }),
    );

    const result = await watchPromise;
    expect(result.status).toBe("NOTIFICATION_CAPTURED");
    expect(result.notification?.signature).toBe(VALID_SIG_B);
    expect(result.observations.rejectedNotificationsCount).toBe(1);
    expect(result.observations.messagesReceivedCount).toBe(3);
  });

  it("TC-08: failed on-chain transaction notification is recorded and does not capture", async () => {
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

    // Failed on-chain transaction (err is not null)
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

    // Subsequent successful transaction captures
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
    expect(result.observations.failedNotificationsCount).toBe(1);
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
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 12 }));

    // 1. Invalid signature (not 64-byte Ed25519)
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 12,
          result: {
            context: { slot: 100 },
            value: { signature: "InvalidShortSig", err: null, logs: [] },
          },
        },
      }),
    );

    // 2. Invalid slot (negative)
    transport!.emitMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 12,
          result: {
            context: { slot: -5 },
            value: { signature: VALID_SIG_A, err: null, logs: [] },
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
          subscription: 12,
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

  it("TC-10: keepalive ping/pong matches accurately at 20-second interval", async () => {
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

    // Advance 20 s -> first client ping is sent
    vEnv.advanceTime(20_000);
    expect(transport!.sentPings).toHaveLength(1);

    // Pong arrives 2 s later (within 10 s timeout)
    vEnv.advanceTime(2_000);
    transport!.emitPong();

    // Advance another 18 s (total 40 s from start) -> second client ping
    vEnv.advanceTime(18_000);
    expect(transport!.sentPings).toHaveLength(2);

    // Second pong arrives
    vEnv.advanceTime(1_000);
    transport!.emitPong();

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
    expect(result.observations.incomingControlFramesCount).toBe(2);
  });

  it("TC-11: unmatched pong deadline stops watch with KEEPALIVE_TIMEOUT (zero reconnects)", async () => {
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

    // Advance to first ping at 20 s
    vEnv.advanceTime(20_000);
    expect(transport!.sentPings).toHaveLength(1);

    // Advance 9,999 ms -> still within 10 s pong window
    vEnv.advanceTime(9_999);
    expect(transport!.closeCalls).toHaveLength(0);

    // Advance 2 ms -> exceeds 10,000 ms pong timeout
    vEnv.advanceTime(2);

    const result = await watchPromise;
    expect(result.status).toBe("KEEPALIVE_TIMEOUT");
    expect(result.reason).toContain("First unmatched pong deadline expired");
    expect(result.notification).toBeNull();
    expect(transport!.closeCalls).toHaveLength(1);
  });

  it("TC-12: exceeding max client pings (45) terminates with CLIENT_PING_LIMIT_EXCEEDED", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      limits: { maxClientPings: 3 }, // set small for test
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
    transport!.emitPong();
    // Ping 2
    vEnv.advanceTime(20_000);
    transport!.emitPong();
    // Ping 3
    vEnv.advanceTime(20_000);
    transport!.emitPong();

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
      limits: { maxIncomingControlFrames: 4 }, // small limit for test
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Send 2 server pings + 2 pongs = 4
    transport!.emitServerPing();
    transport!.emitPong();
    transport!.emitServerPing();
    transport!.emitPong();

    expect(transport!.closeCalls).toHaveLength(0);

    // 5th control frame exceeds ceiling
    transport!.emitPong();

    const result = await watchPromise;
    expect(result.status).toBe("CONTROL_FRAME_LIMIT_EXCEEDED");
    expect(result.observations.incomingControlFramesCount).toBe(5);
  });

  it("TC-14: exceeding max incoming application messages (100) terminates with MESSAGE_LIMIT_EXCEEDED", async () => {
    const vEnv = new VirtualTimerEnvironment();
    let transport: MockKeepaliveTransport;

    const watch = new BoundedAmmV4CreationWatch({
      wssUrl: "wss://api.mainnet-beta.solana.com",
      clock: vEnv.clock,
      timers: vEnv.getTimers(),
      limits: { maxIncomingMessages: 3 }, // small limit for test
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();

    // Msg 1 (ack)
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
    // Msg 2 (method ignored)
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", method: "other" }));
    // Msg 3 (method ignored)
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", method: "other" }));

    expect(transport!.closeCalls).toHaveLength(0);

    // Msg 4 exceeds 3
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
      limits: { maxPayloadBytes: 200 }, // 200 bytes for test
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();

    // Message of 120 bytes
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Message of 150 bytes exceeds 200 total
    const largeMessage = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: { padding: "X".repeat(150) },
    });
    transport!.emitMessage(largeMessage);

    const result = await watchPromise;
    expect(result.status).toBe("PAYLOAD_BYTE_CEILING_EXCEEDED");
    expect(result.observations.payloadBytesReceived).toBeGreaterThan(200);
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
      transport!.emitPong();
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
      timers: vEnv.getTimers(),
      limits: { pingIntervalMs: 2_000_000 }, // prevent keepalive from firing before 15m
      transportFactory: () => {
        transport = new MockKeepaliveTransport();
        return transport;
      },
    });

    const watchPromise = watch.start();
    transport!.emitOpen();
    transport!.emitMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

    // Manually advance clock past 900,000 ms without advancing virtual timer queue
    // (simulating delayed timer callback or event loop lag)
    vEnv.advanceTime(900_001);

    // Event arrives: checkAbsoluteDeadlines catches that deadline has passed
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

  it("TC-21: returned result and observations are deep-frozen and immutable", async () => {
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

    expect(() => {
      (result as unknown as { status: string }).status = "MUTATED";
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
        // Socket wrapper that exposes getUnderlyingSocket with readyState: 1 and never emits 'open'
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
});
