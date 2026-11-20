/**
 * CPMM pool WebSocket transport wrapper: synthetic offline tests (assessment §8.38.17 item 16).
 *
 * Every client is an injected fake constructor whose instances behave like `ws`'s
 * `EventEmitter`-based client (an `error` with no listener throws). No real `ws` client is
 * constructed and nothing opens a socket. W13 runs the real accepted owner over the wrapper.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_CPMM_POOL_ADDRESS,
  FIXTURE_CPMM_TOKEN_0_VAULT,
  FIXTURE_CPMM_TOKEN_1_VAULT,
  createAuthoritativeCpmmSplVaultBuffer,
  createAuthoritativeRaydiumCpmmBuffer,
} from "../research/pilot/fixtures/AuthoritativeCpmmFixtures.js";
import {
  CpmmPoolConnectionOwner,
  type CpmmConnectionOwnerLimits,
  type CpmmConnectionRunReport,
} from "./CpmmPoolConnectionOwner.js";
import { CpmmPoolNotificationCollector } from "./CpmmPoolNotificationCollector.js";
import { CpmmResolutionAccountingLedger } from "./CpmmResolutionAccountingLedger.js";
import { PaperRequestSession, type PaperRequestSessionTimers } from "./PaperRequestSession.js";
import {
  CANONICAL_CPMM_AUTH_BUMP,
  adaptRaydiumCpmmPoolState,
} from "./RaydiumCpmmPoolStateAdapter.js";
import {
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./RaydiumCpmmSwapDecoder.js";
import {
  RaydiumCpmmTransactionSourceAdapter,
  createCpmmExchangeEvidenceRecorder,
} from "./RaydiumCpmmTransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import {
  CpmmPoolWebSocketTransport,
  type CpmmPoolWebSocketTransportLimits,
  type CpmmWsClientConstructor,
  type CpmmWsClientEvent,
  type CpmmWsClientLike,
  type CpmmWsClientOptions,
  type CpmmWsTransportDiagnostics,
} from "./CpmmPoolWebSocketTransport.js";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const SECRET = "k3yS3cr3tWsAbCd1234";
const HOST = "rpc.example.test";
const ENDPOINT = `wss://${HOST}/ws?api-key=${SECRET}`;
const LIMITS: CpmmPoolWebSocketTransportLimits = {
  maxFrameBytes: 64,
  maxFragments: 4,
  maxBufferedChunks: 16,
  handshakeTimeoutMs: 4_000,
  closeTimeoutMs: 2_000,
};
const INT32_MAX = 2_147_483_647;

/** A credential-bearing error with an own, data-valued code (or none). */
function credError(code?: unknown): Error {
  const e = new Error(`connect failed for ${ENDPOINT} (${HOST}:443) key=${SECRET}`);
  if (code !== undefined) Object.defineProperty(e, "code", { value: code, enumerable: true });
  return e;
}

/** A proxy that counts every trap it runs. */
function trapCounter<T extends object>(target: T): { proxy: T; traps: () => number } {
  let n = 0;
  const handler: ProxyHandler<T> = {};
  for (const trap of [
    "get",
    "set",
    "has",
    "ownKeys",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "defineProperty",
    "deleteProperty",
    "apply",
    "construct",
    "isExtensible",
    "preventExtensions",
    "setPrototypeOf",
  ] as const) {
    (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
      n++;
      return (Reflect[trap] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { proxy: new Proxy(target, handler), traps: () => n };
}

// ---------------------------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------------------------

type Cb = (err?: unknown) => void;
interface Script {
  constructThrows?: boolean;
  constructReturnsProxy?: boolean;
  onConstruct?: (c: FakeClient) => void;
  onThrows?: CpmmWsClientEvent;
  binaryTypeThrows?: boolean;
  readyStateThrows?: boolean;
  readyStateValue?: unknown;
  complete?: "sync" | "microtask" | "never" | "twice" | "fail";
  autoPong?: boolean;
  closeMode?: "sync" | "none";
  terminateCloses?: boolean;
  throwOn?: Partial<Record<"send" | "ping" | "pong" | "close" | "terminate", boolean>>;
  onSend?: (c: FakeClient, data: string) => void;
}

class FakeClient implements CpmmWsClientLike {
  public readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  public readonly calls: { name: string; args: unknown[] }[] = [];
  public readonly pending: Cb[] = [];
  public readonly binaryTypeSets: unknown[] = [];
  public removals = 0;
  #rs: unknown = 0;
  #binaryType = "nodebuffer";
  constructor(
    public readonly address: string,
    public readonly options: CpmmWsClientOptions,
    public readonly s: Script,
  ) {
    if (s.constructThrows) throw credError();
  }
  get readyState(): number {
    if (this.s.readyStateThrows) throw credError();
    return (this.s.readyStateValue ?? this.#rs) as number;
  }
  set rs(v: number) {
    this.#rs = v;
  }
  get binaryType(): string {
    return this.#binaryType;
  }
  set binaryType(v: string) {
    if (this.s.binaryTypeThrows) throw credError();
    this.binaryTypeSets.push(v);
    this.#binaryType = v;
  }
  on(event: CpmmWsClientEvent, listener: (...a: unknown[]) => void): this {
    this.calls.push({ name: `on:${event}`, args: [] });
    if (this.s.onThrows === event) throw credError();
    const ls = this.listeners.get(event) ?? [];
    ls.push(listener);
    this.listeners.set(event, ls);
    return this;
  }
  removeListener(): this {
    this.removals++;
    return this;
  }
  removeAllListeners(): this {
    this.removals++;
    return this;
  }
  /** EventEmitter semantics: an `error` with no listener is thrown. */
  emit(event: string, ...args: unknown[]): void {
    const ls = this.listeners.get(event) ?? [];
    if (event === "error" && ls.length === 0) throw args[0];
    for (const l of [...ls]) l(...args);
  }
  #complete(cb: Cb): void {
    switch (this.s.complete ?? "microtask") {
      case "sync":
        cb();
        return;
      case "never":
        this.pending.push(cb);
        return;
      case "twice":
        queueMicrotask(() => {
          cb();
          cb();
        });
        return;
      case "fail":
        queueMicrotask(() => cb(credError("ECONNRESET")));
        return;
      default:
        queueMicrotask(() => cb());
    }
  }
  send(data: string, cb: Cb): void {
    this.calls.push({ name: "send", args: [data] });
    if (this.s.throwOn?.send) throw credError();
    this.s.onSend?.(this, data);
    this.#complete(cb);
  }
  ping(data: Uint8Array, mask: boolean, cb: Cb): void {
    this.calls.push({ name: "ping", args: [data, mask] });
    if (this.s.throwOn?.ping) throw credError();
    this.#complete(cb);
    if (this.s.autoPong) {
      const echo = Buffer.from(data);
      queueMicrotask(() => this.emit("pong", echo));
    }
  }
  pong(data: Uint8Array, mask: boolean, cb: Cb): void {
    this.calls.push({ name: "pong", args: [data, mask] });
    if (this.s.throwOn?.pong) throw credError();
    this.#complete(cb);
  }
  close(...args: unknown[]): void {
    this.calls.push({ name: "close", args });
    if (this.s.throwOn?.close) throw credError();
    if ((this.s.closeMode ?? "sync") === "sync") this.finishClose(1000);
  }
  terminate(): void {
    this.calls.push({ name: "terminate", args: [] });
    if (this.s.throwOn?.terminate) throw credError();
    this.#rs = 2; // CLOSING: `ws` closes the socket asynchronously
    if (this.s.terminateCloses) this.finishClose(1006);
  }
  // --- test controls ---
  open(): void {
    this.#rs = 1;
    this.emit("open");
  }
  finishClose(code: unknown, reason: unknown = Buffer.from(`bye ${SECRET} ${ENDPOINT}`)): void {
    this.#rs = 3;
    this.emit("close", code, reason);
  }
  message(data: unknown, isBinary = false): void {
    this.emit("message", data, isBinary);
  }
}

function fakeCtor(s: Script = {}) {
  const instances: FakeClient[] = [];
  let attempts = 0;
  const ctor = class extends FakeClient {
    constructor(address: string, options: CpmmWsClientOptions) {
      attempts++;
      super(address, options, s);
      instances.push(this);
      s.onConstruct?.(this);
      if (s.constructReturnsProxy) return new Proxy(this, {});
    }
  };
  return {
    ctor: ctor as unknown as CpmmWsClientConstructor,
    instances,
    attempts: () => attempts,
  };
}

interface Rec {
  readonly events: { event: string; args: unknown[] }[];
  readonly off: (() => void)[];
}
function record(t: CpmmPoolWebSocketTransport): Rec {
  const r: Rec = { events: [], off: [] };
  for (const event of ["open", "message", "error", "close", "ping", "pong"] as const) {
    r.off.push(
      t.on(event as "message", (...args: unknown[]) => {
        r.events.push({ event, args });
      }),
    );
  }
  return r;
}

function make(s: Script = {}, limits: Partial<CpmmPoolWebSocketTransportLimits> = {}) {
  const f = fakeCtor(s);
  const t = new CpmmPoolWebSocketTransport({
    endpoint: ENDPOINT,
    clientConstructor: f.ctor,
    limits: { ...LIMITS, ...limits },
  });
  const rec = record(t);
  return {
    t,
    f,
    rec,
    get c(): FakeClient {
      return f.instances[0]!;
    },
  };
}

/** Started and open. */
function opened(s: Script = {}, limits: Partial<CpmmPoolWebSocketTransportLimits> = {}) {
  const m = make(s, limits);
  m.t.start();
  m.c.open();
  return m;
}

const thrown = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
};
const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const bytes = (n: number, fill = 7) => Buffer.alloc(n, fill);
const of = (rec: Rec, event: string) => rec.events.filter((e) => e.event === event);

function expectNoSecret(v: unknown, label = "value"): void {
  const text =
    typeof v === "string"
      ? v
      : v instanceof Error
        ? `${v.message}\n${v.stack ?? ""}\n${inspect(v, { showHidden: true, depth: 6 })}`
        : `${JSON.stringify(v)}\n${inspect(v, { showHidden: true, depth: 8 })}`;
  expect(text, label).not.toContain(SECRET);
  expect(text, label).not.toContain(HOST);
}

function expectDiagnosticsConserved(d: CpmmWsTransportDiagnostics): void {
  const m = d.messages;
  expect(m.received).toBe(
    m.delivered +
      m.refusedPayloadLimit +
      m.refusedRepresentation +
      m.suppressedAfterPayloadLimit +
      m.ignored,
  );
  expect(Object.isFrozen(d) && Object.isFrozen(d.messages) && Object.isFrozen(d.errors)).toBe(true);
  expectNoSecret(d, "diagnostics");
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("CPMM pool WebSocket transport wrapper (synthetic, offline)", () => {
  it("W1: construction is inert, validates every option and limit, and never quotes the endpoint", () => {
    const f = fakeCtor();
    const t = new CpmmPoolWebSocketTransport({
      endpoint: ENDPOINT,
      clientConstructor: f.ctor,
      limits: LIMITS,
    });
    expect(f.attempts()).toBe(0);
    expect(t.readyState).toBe(0);
    expect(t.diagnostics().lifecycle).toBe("DORMANT");
    // Every field is private: nothing is enumerable, serialised or inspected.
    expect(Object.keys(t)).toEqual([]);
    expect(JSON.stringify(t)).toBe("{}");
    expectNoSecret(inspect(t, { showHidden: true, depth: 8 }), "inspect");
    const base = () => ({ endpoint: ENDPOINT, clientConstructor: f.ctor, limits: { ...LIMITS } });
    const limitTrap = trapCounter({ ...LIMITS });
    const optionTrap = trapCounter(base());
    const getterLimits = { ...LIMITS };
    Object.defineProperty(getterLimits, "maxFragments", { get: () => 4, enumerable: true });
    const bad: [unknown, RegExp][] = [
      [null, /plain object/],
      [[], /plain object/],
      [new (class X {})(), /plain object/],
      [optionTrap.proxy, /plain object/],
      [{ ...base(), extra: 1 }, /exactly endpoint/],
      [{ endpoint: ENDPOINT, clientConstructor: f.ctor }, /exactly endpoint/],
      [{ ...base(), endpoint: `ws://${HOST}/?api-key=${SECRET}` }, /wss: URL/],
      [{ ...base(), endpoint: `https://${HOST}/?api-key=${SECRET}` }, /wss: URL/],
      [{ ...base(), endpoint: `ws+unix:/tmp/${SECRET}` }, /wss: URL/],
      [{ ...base(), endpoint: `${ENDPOINT}#frag` }, /wss: URL/],
      [{ ...base(), endpoint: `wss://` }, /wss: URL/],
      [{ ...base(), endpoint: `not a url ${SECRET}` }, /wss: URL/],
      [{ ...base(), endpoint: "" }, /wss: URL/],
      [{ ...base(), endpoint: 1 }, /wss: URL/],
      [{ ...base(), endpoint: `wss://${HOST}/${"a".repeat(9_000)}` }, /wss: URL/],
      [{ ...base(), clientConstructor: {} }, /clientConstructor/],
      [{ ...base(), limits: limitTrap.proxy }, /limits must be exactly/],
      [{ ...base(), limits: getterLimits }, /limits must be exactly/],
      [{ ...base(), limits: { ...LIMITS, extra: 1 } }, /limits must be exactly/],
    ];
    for (const k of Object.keys(LIMITS) as (keyof CpmmPoolWebSocketTransportLimits)[]) {
      for (const v of [0, -1, 1.5, INT32_MAX + 1, Number.NaN, "5", null]) {
        bad.push([{ ...base(), limits: { ...LIMITS, [k]: v } }, new RegExp(k)]);
      }
      const { [k]: _omit, ...missing } = LIMITS;
      void _omit;
      bad.push([{ ...base(), limits: missing }, /limits must be exactly/]);
      // The receiver's signed 32-bit range and the runtime timer range are accepted at the edge.
      expect(
        () => new CpmmPoolWebSocketTransport({ ...base(), limits: { ...LIMITS, [k]: INT32_MAX } }),
      ).not.toThrow();
    }
    for (const [options, re] of bad) {
      const e = thrown(() => new CpmmPoolWebSocketTransport(options as never));
      expect(e.message, String(re)).toMatch(re);
      expect(e.message.startsWith("[CPMM_WS_INIT] ")).toBe(true);
      expectNoSecret(e, String(re));
    }
    expect(limitTrap.traps()).toBe(0);
    expect(optionTrap.traps()).toBe(0);
    expect(f.attempts()).toBe(0);
  });

  it("W2: start() constructs exactly one client with the exact bounded options and six listeners", () => {
    const { t, f, c } = (() => {
      const m = make();
      m.t.start();
      return m;
    })();
    expect(f.attempts()).toBe(1);
    expect(c.address).toBe(ENDPOINT);
    expect(c.options).toEqual({
      allowSynchronousEvents: true,
      autoPong: false,
      closeTimeout: LIMITS.closeTimeoutMs,
      followRedirects: false,
      handshakeTimeout: LIMITS.handshakeTimeoutMs,
      maxBufferedChunks: LIMITS.maxBufferedChunks,
      maxFragments: LIMITS.maxFragments,
      maxPayload: LIMITS.maxFrameBytes,
      maxRedirects: 0,
      perMessageDeflate: false,
      skipUTF8Validation: false,
    });
    expect(Object.isFrozen(c.options)).toBe(true);
    // `error` is registered first; no upgrade, unexpected-response or redirect listener.
    expect(c.calls.map((x) => x.name)).toEqual([
      "on:error",
      "on:close",
      "on:open",
      "on:message",
      "on:ping",
      "on:pong",
    ]);
    expect([...c.listeners.keys()].sort()).toEqual(
      ["close", "error", "message", "open", "ping", "pong"].sort(),
    );
    expect(c.binaryTypeSets).toEqual(["nodebuffer"]);
    expect(t.diagnostics()).toMatchObject({ lifecycle: "ACTIVE", clientConstructions: 1 });
    expect(t.readyState).toBe(0);
    expect(JSON.stringify(t)).toBe("{}");
    expectNoSecret(inspect(t, { showHidden: true, depth: 8 }), "inspect after start");
  });

  it("W3: the single start attempt is reserved before construction, and failures are final", () => {
    // Re-entrant start() from the constructor, then a repeated start().
    let inner: Error | null = null;
    let readyDuring = -1;
    const box: { t?: CpmmPoolWebSocketTransport } = {};
    const f = fakeCtor({
      onConstruct: () => {
        inner = thrown(() => box.t!.start());
        readyDuring = box.t!.readyState;
      },
    });
    box.t = new CpmmPoolWebSocketTransport({
      endpoint: ENDPOINT,
      clientConstructor: f.ctor,
      limits: LIMITS,
    });
    box.t.start();
    expect(inner!.message).toBe("[CPMM_WS] ALREADY_STARTED");
    expect(readyDuring).toBe(0);
    expect(thrown(() => box.t!.start()).message).toBe("[CPMM_WS] ALREADY_STARTED");
    expect(f.attempts()).toBe(1);

    // A credential-bearing constructor failure: fixed error, no cause, no second attempt.
    const ct = make({ constructThrows: true });
    const e = thrown(() => ct.t.start());
    expect(e.message).toBe("[CPMM_WS] START_FAILED");
    expect("cause" in e).toBe(false);
    expectNoSecret(e, "constructor failure");
    expect(ct.t.readyState).toBe(3);
    expect(ct.t.diagnostics()).toMatchObject({
      lifecycle: "START_FAILED",
      startupFailure: "CONSTRUCTOR_THREW",
      startupCleanup: null,
      clientConstructions: 1,
    });
    expect(thrown(() => ct.t.start()).message).toBe("[CPMM_WS] ALREADY_STARTED");
    expect(ct.f.attempts()).toBe(1);
    expect(() => ct.t.close(1000)).not.toThrow();
    expect(() => ct.t.terminate()).not.toThrow();

    // An invalid constructor result (a proxy) is refused without touching it.
    const px = make({ constructReturnsProxy: true });
    expect(thrown(() => px.t.start()).message).toBe("[CPMM_WS] START_FAILED");
    expect(px.t.diagnostics().startupFailure).toBe("CONSTRUCTOR_RESULT_INVALID");
    expect(px.c.calls).toEqual([]);
    expect(px.t.readyState).toBe(3);
  });

  it("W3b: a listener-registration or binaryType failure after the client exists is cleaned up truthfully", () => {
    // A later registration fails: the error listener already exists, terminate() is attempted,
    // and readyState stays truthful (CLOSING) until the client's own close.
    const r = make({ onThrows: "message" });
    const e = thrown(() => r.t.start());
    expect(e.message).toBe("[CPMM_WS] START_FAILED");
    expectNoSecret(e);
    expect(r.t.diagnostics()).toMatchObject({
      lifecycle: "START_FAILED",
      startupFailure: "LISTENER_REGISTRATION_FAILED",
      startupCleanup: "TERMINATE_CALLED",
    });
    expect(r.c.calls.map((x) => x.name)).toEqual([
      "on:error",
      "on:close",
      "on:open",
      "on:message",
      "terminate",
    ]);
    expect(r.t.readyState).toBe(2);
    expect(() => r.c.emit("error", credError("ECONNRESET"))).not.toThrow();
    expect(of(r.rec, "error")).toEqual([{ event: "error", args: [] }]);
    expect(thrown(() => r.t.send("x", () => undefined)).message).toBe("[CPMM_WS] NOT_OPEN");
    r.c.finishClose(1006);
    expect(r.t.readyState).toBe(3);
    expect(of(r.rec, "close")).toEqual([{ event: "close", args: [1006] }]);
    expect(r.t.diagnostics().lifecycle).toBe("CLOSED");
    expect(thrown(() => r.t.start()).message).toBe("[CPMM_WS] ALREADY_STARTED");
    expect(r.f.attempts()).toBe(1);

    // binaryType assignment failing; terminate() throwing as well.
    const b = make({ binaryTypeThrows: true, throwOn: { terminate: true } });
    expect(thrown(() => b.t.start()).message).toBe("[CPMM_WS] START_FAILED");
    expect(b.t.diagnostics()).toMatchObject({
      startupFailure: "BINARY_TYPE_FAILED",
      startupCleanup: "TERMINATE_THREW",
    });
    expect(b.t.readyState).toBe(0); // the client never confirmed a close
    expect(b.c.listeners.get("error")?.length).toBe(1);

    // A terminate that closes synchronously during setup cleanup.
    const s = make({ onThrows: "pong", terminateCloses: true });
    expect(thrown(() => s.t.start()).message).toBe("[CPMM_WS] START_FAILED");
    expect(s.t.readyState).toBe(3);
    expect(s.t.diagnostics()).toMatchObject({
      lifecycle: "CLOSED",
      startupFailure: "LISTENER_REGISTRATION_FAILED",
    });

    // The very first registration failing: still a fixed failure and a cleanup attempt.
    const first = make({ onThrows: "error" });
    expect(thrown(() => first.t.start()).message).toBe("[CPMM_WS] START_FAILED");
    expect(first.c.calls.map((x) => x.name)).toEqual(["on:error", "terminate"]);
  });

  it("W4: dispose() releases a dormant wrapper, is idempotent, and is refused after startup", () => {
    const d = make();
    d.t.dispose();
    d.t.dispose();
    expect(d.t.readyState).toBe(3);
    expect(d.t.diagnostics().lifecycle).toBe("DISPOSED");
    expect(thrown(() => d.t.start()).message).toBe("[CPMM_WS] DISPOSED");
    expect(thrown(() => d.t.close(1000)).message).toBe("[CPMM_WS] DISPOSED");
    expect(thrown(() => d.t.terminate()).message).toBe("[CPMM_WS] DISPOSED");
    expect(d.f.attempts()).toBe(0);

    const s = make();
    s.t.start();
    expect(thrown(() => s.t.dispose()).message).toBe("[CPMM_WS] STARTED_USE_CLOSE");
    expect(s.c.calls.filter((x) => x.name === "close" || x.name === "terminate")).toEqual([]);
    expect(s.t.diagnostics().lifecycle).toBe("ACTIVE");

    const failed = make({ constructThrows: true });
    thrown(() => failed.t.start());
    expect(thrown(() => failed.t.dispose()).message).toBe("[CPMM_WS] STARTED_USE_CLOSE");
  });

  it("W5: owner listeners are truly detachable, contained and validated", () => {
    const m = make();
    const seen: string[] = [];
    const a = (): void => {
      seen.push("a");
      offB();
    };
    const offA = m.t.on("message", a);
    const offB = m.t.on("message", () => seen.push("b"));
    // The same function twice: two independent registrations.
    const twice = (): void => {
      seen.push("twice");
    };
    const off1 = m.t.on("message", twice);
    m.t.on("message", twice);
    m.t.on("message", () => {
      throw credError();
    });
    m.t.start();
    m.c.open();
    m.c.message(bytes(3));
    // b was removed during the dispatch and never ran.
    expect(seen).toEqual(["a", "twice", "twice"]);
    off1();
    off1();
    offA();
    m.c.message(bytes(3));
    expect(seen).toEqual(["a", "twice", "twice", "twice"]);
    expect(m.t.diagnostics().ownerListenerThrew).toBe(2);
    // Registration after start works; invalid registrations are refused.
    const late: unknown[] = [];
    m.t.on("pong", (p) => late.push(p));
    m.c.emit("pong", bytes(2));
    expect(late.length).toBe(1);
    expect(thrown(() => m.t.on("upgrade" as "open", () => undefined)).message).toBe(
      "[CPMM_WS] INVALID_ARGUMENT",
    );
    expect(thrown(() => m.t.on("open", 1 as never)).message).toBe("[CPMM_WS] INVALID_ARGUMENT");
  });

  it("W6: messages are copied byte-for-byte under exact bounds, through intrinsics only", () => {
    const m = opened();
    const deliver = (data: unknown, isBinary = false) => {
      const before = m.rec.events.length;
      m.c.message(data, isBinary);
      return m.rec.events.slice(before);
    };
    // A Buffer text frame: a fresh exact copy, independent of the source.
    const src = Buffer.from("hello world");
    let out = deliver(src);
    expect(out.length).toBe(1);
    const got = out[0]!.args[0] as Uint8Array;
    expect(out[0]!.args.length).toBe(1);
    expect(Object.getPrototypeOf(got)).toBe(Uint8Array.prototype);
    expect(got).not.toBe(src);
    expect(Buffer.from(got).toString()).toBe("hello world");
    src[0] = 0;
    expect(got[0]).toBe("h".charCodeAt(0));
    // A view with an offset copies only its own bytes.
    const big = Buffer.from("0123456789abcdef");
    out = deliver(big.subarray(3, 9));
    expect(Buffer.from(out[0]!.args[0] as Uint8Array).toString()).toBe("345678");
    // Exactly at the ceiling is delivered; one byte more is refused as a generic error.
    expect(deliver(bytes(64))[0]!.event).toBe("message");
    expect(deliver(bytes(65))).toEqual([{ event: "error", args: [] }]);
    // An ArrayBuffer.
    const ab = new Uint8Array([1, 2, 3]).buffer;
    expect([...(deliver(ab)[0]!.args[0] as Uint8Array)]).toEqual([1, 2, 3]);
    expect(deliver(new ArrayBuffer(65))).toEqual([{ event: "error", args: [] }]);
    // Fragments: concatenated once at the ceiling.
    const frag = deliver([bytes(30, 1), bytes(34, 2)]);
    expect((frag[0]!.args[0] as Uint8Array).length).toBe(64);
    // Over the ceiling: refused before the next element is read or anything is allocated.
    let reads = 0;
    const over: unknown[] = [bytes(40), bytes(40)];
    Object.defineProperty(over, 2, {
      get: () => {
        reads++;
        return bytes(1);
      },
      enumerable: true,
    });
    expect(deliver(over)).toEqual([{ event: "error", args: [] }]);
    // An accessor element (under the ceiling) is refused without running it.
    const accessor: unknown[] = [bytes(2)];
    Object.defineProperty(accessor, 1, {
      get: () => {
        reads++;
        return bytes(1);
      },
      enumerable: true,
    });
    expect(deliver(accessor)).toEqual([{ event: "error", args: [] }]);
    expect(reads).toBe(0);
    // Too many fragments, a hole, a subclass, an empty array and a proxy array (zero traps).
    expect(deliver([bytes(1), bytes(1), bytes(1), bytes(1), bytes(1)])[0]!.event).toBe("error");
    // eslint-disable-next-line no-sparse-arrays
    expect(deliver([bytes(1), , bytes(1)])[0]!.event).toBe("error");
    class Sub extends Array<unknown> {}
    expect(deliver(Sub.from([bytes(1)]))[0]!.event).toBe("error");
    expect(deliver([])[0]!.event).toBe("error");
    const arrTrap = trapCounter([bytes(1)]);
    expect(deliver(arrTrap.proxy)[0]!.event).toBe("error");
    expect(arrTrap.traps()).toBe(0);
    // Shadowed length is ignored (the genuine length is used); a proxied view runs no trap.
    const shadow = new Uint8Array(10).fill(9);
    Object.defineProperty(shadow, "byteLength", { value: 1 });
    Object.defineProperty(shadow, "length", { value: 1 });
    expect((deliver(shadow)[0]!.args[0] as Uint8Array).length).toBe(10);
    const viewTrap = trapCounter(new Uint8Array(4));
    expect(deliver(viewTrap.proxy)[0]!.event).toBe("error");
    expect(viewTrap.traps()).toBe(0);
    // Detached views and buffers, other typed arrays and non-byte values are refused.
    const det = new ArrayBuffer(8);
    const detView = new Uint8Array(det);
    structuredClone(det, { transfer: [det] });
    expect(deliver(detView)[0]!.event).toBe("error");
    expect(deliver(det)[0]!.event).toBe("error");
    for (const v of [
      "text",
      42,
      null,
      undefined,
      new Uint16Array(2),
      new Blob(["x"]),
      { byteLength: 2 },
    ]) {
      expect(deliver(v)[0]!.event, String(v)).toBe("error");
    }
    // Binary frames are delivered byte-for-byte and counted.
    expect((deliver(Buffer.from([0, 255]), true)[0]!.args[0] as Uint8Array)[1]).toBe(255);
    const d = m.t.diagnostics();
    expect(d.messages).toMatchObject({ binaryDelivered: 1, refusedPayloadLimit: 3 });
    expect(d.messages.refusedRepresentation).toBe(16);
    expectDiagnosticsConserved(d);
  });

  it("W7: a local payload refusal is latched, suppressed and reported as 1009 only on the actual close", () => {
    const m = opened();
    const limit = credError("WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
    m.c.emit("error", limit);
    expect(m.rec.events.filter((e) => e.event !== "open")).toEqual([]);
    expect(m.t.diagnostics()).toMatchObject({
      payloadLimitLatched: true,
      close: { observed: false },
    });
    // No close is manufactured; later application messages are not delivered.
    m.c.message(bytes(3));
    expect(of(m.rec, "message")).toEqual([]);
    expect(of(m.rec, "close")).toEqual([]);
    expect(m.t.readyState).toBe(1);
    m.c.finishClose(1006);
    expect(of(m.rec, "close")).toEqual([{ event: "close", args: [1009] }]);
    expect(m.t.diagnostics()).toMatchObject({
      close: { observed: true, rawCode: 1006, deliveredCode: 1009 },
      messages: { suppressedAfterPayloadLimit: 1 },
      errors: { PAYLOAD_LIMIT: 1 },
    });
    expectDiagnosticsConserved(m.t.diagnostics());

    // A peer 1009 without a local refusal reaches the owner as null; the raw code is kept.
    const p = opened();
    p.c.finishClose(1009);
    expect(of(p.rec, "close")).toEqual([{ event: "close", args: [null] }]);
    expect(p.t.diagnostics().close).toEqual({ observed: true, rawCode: 1009, deliveredCode: null });

    // Valid codes pass; invalid ones are null.
    for (const [code, want] of [
      [1000, 1000],
      [4999, 4999],
      [1006, 1006],
      [999, null],
      [5000, null],
      [1000.5, null],
      ["1000", null],
      [undefined, null],
    ] as const) {
      const x = opened();
      x.c.finishClose(code);
      expect(of(x.rec, "close"), String(code)).toEqual([{ event: "close", args: [want] }]);
      expect(x.t.diagnostics().close.rawCode).toBe(want);
    }

    // A payload-limit code behind a getter is unreadable, so it is not latched.
    const g = opened();
    const hostile = credError();
    let getterRuns = 0;
    Object.defineProperty(hostile, "code", {
      get: () => {
        getterRuns++;
        return "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      },
    });
    g.c.emit("error", hostile);
    expect(getterRuns).toBe(0);
    expect(of(g.rec, "error")).toEqual([{ event: "error", args: [] }]);
    expect(g.t.diagnostics()).toMatchObject({
      payloadLimitLatched: false,
      errors: { UNREADABLE: 1 },
    });
  });

  it("W8: local completions are forwarded exactly, and sends are refused unless open", () => {
    const results: boolean[] = [];
    const done = (f: boolean): void => {
      results.push(f);
    };
    // Synchronous completion.
    const s = opened({ complete: "sync" });
    s.t.send("a", done);
    expect(results).toEqual([false]);
    // Failure, never, twice, and a throwing done.
    const fl = opened({ complete: "fail" });
    fl.t.send("a", done);
    const tw = opened({ complete: "twice" });
    tw.t.send("a", done);
    const nv = opened({ complete: "never" });
    nv.t.send("a", done);
    const th = opened({ complete: "sync" });
    th.t.send("a", () => {
      throw credError();
    });
    return flush().then(() => {
      expect(results).toEqual([false, true, false, false]);
      expect(fl.t.diagnostics().completions).toMatchObject({ failed: 1, completed: 0 });
      expect(tw.t.diagnostics().completions).toMatchObject({ completed: 1, duplicate: 1 });
      expect(nv.t.diagnostics().completions).toMatchObject({ completed: 0, failed: 0 });
      expect(nv.c.pending.length).toBe(1);
      expect(th.t.diagnostics().completions.doneThrew).toBe(1);
      // An error argument is never inspected (a proxy runs no trap).
      const errTrap = trapCounter(credError());
      nv.c.pending[0]!(errTrap.proxy);
      expect(errTrap.traps()).toBe(0);
      expect(results.at(-1)).toBe(true);

      // Refusals without touching the client.
      const dormant = make();
      expect(thrown(() => dormant.t.send("a", done)).message).toBe("[CPMM_WS] NOT_STARTED");
      const connecting = make();
      connecting.t.start();
      expect(thrown(() => connecting.t.send("a", done)).message).toBe("[CPMM_WS] NOT_OPEN");
      expect(thrown(() => connecting.t.ping(new Uint8Array(8), done)).message).toBe(
        "[CPMM_WS] NOT_OPEN",
      );
      expect(connecting.c.calls.filter((x) => x.name === "send" || x.name === "ping")).toEqual([]);
      const o = opened();
      expect(thrown(() => o.t.send(1 as never, done)).message).toBe("[CPMM_WS] INVALID_ARGUMENT");
      expect(thrown(() => o.t.send("a", 1 as never)).message).toBe("[CPMM_WS] INVALID_ARGUMENT");
      // Control payloads: genuine, at most 125 bytes, copied, masked.
      for (const bad of [
        new Uint8Array(126),
        new Uint16Array(2),
        "x",
        trapCounter(new Uint8Array(2)).proxy,
      ]) {
        expect(thrown(() => o.t.ping(bad as never, done)).message).toBe(
          "[CPMM_WS] INVALID_ARGUMENT",
        );
        expect(thrown(() => o.t.pong(bad as never, done)).message).toBe(
          "[CPMM_WS] INVALID_ARGUMENT",
        );
      }
      const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      o.t.ping(payload, done);
      o.t.pong(new Uint8Array(125), done);
      payload[0] = 99;
      const ping = o.c.calls.find((x) => x.name === "ping")!;
      expect(ping.args[1]).toBe(true);
      expect(ping.args[0]).not.toBe(payload);
      expect([...(ping.args[0] as Uint8Array)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(o.c.calls.find((x) => x.name === "pong")!.args[1]).toBe(true);
      // Client exceptions become fixed, credential-free errors.
      const ct = opened({ throwOn: { send: true, ping: true, pong: true } });
      for (const [fn, code] of [
        [() => ct.t.send("a", done), "SEND_THREW"],
        [() => ct.t.ping(new Uint8Array(8), done), "PING_THREW"],
        [() => ct.t.pong(new Uint8Array(8), done), "PONG_THREW"],
      ] as const) {
        const e = thrown(fn);
        expect(e.message).toBe(`[CPMM_WS] ${code}`);
        expectNoSecret(e);
      }
      expect(ct.t.diagnostics().callsThrew).toMatchObject({ send: 1, ping: 1, pong: 1 });
      // After the actual close, nothing is sent.
      const closed = opened();
      closed.c.finishClose(1000);
      expect(thrown(() => closed.t.send("a", done)).message).toBe("[CPMM_WS] NOT_OPEN");
    });
  });

  it("W9: close, terminate and readyState are truthful pass-throughs", () => {
    const m = opened({ closeMode: "none" });
    m.t.close(1000);
    expect(m.c.calls.find((x) => x.name === "close")!.args).toEqual([1000]);
    expect(thrown(() => m.t.close(1001 as 1000)).message).toBe("[CPMM_WS] INVALID_ARGUMENT");
    expect(m.t.readyState).toBe(1);
    m.t.terminate();
    // CLOSING after terminate, until the client actually closes.
    expect(m.t.readyState).toBe(2);
    expect(of(m.rec, "close")).toEqual([]);
    m.c.finishClose(1006);
    expect(m.t.readyState).toBe(3);
    // After the close: no-ops that never reach the client.
    const before = m.c.calls.length;
    m.t.close(1000);
    m.t.terminate();
    expect(m.c.calls.length).toBe(before);
    // A synchronous close inside close() is delivered before close() returns, once, with no reason.
    const s = opened();
    s.t.close(1000);
    expect(of(s.rec, "close")).toEqual([{ event: "close", args: [1000] }]);
    // Before start.
    const d = make();
    expect(thrown(() => d.t.close(1000)).message).toBe("[CPMM_WS] NOT_STARTED");
    expect(thrown(() => d.t.terminate()).message).toBe("[CPMM_WS] NOT_STARTED");
    // Unreadable or invalid client states and throwing calls.
    const u = make({ readyStateThrows: true });
    u.t.start();
    expect(thrown(() => u.t.readyState).message).toBe("[CPMM_WS] STATE_UNREADABLE");
    const v = make({ readyStateValue: 7 });
    v.t.start();
    expect(thrown(() => v.t.readyState).message).toBe("[CPMM_WS] STATE_UNREADABLE");
    const ct = opened({ throwOn: { close: true, terminate: true } });
    for (const [fn, code] of [
      [() => ct.t.close(1000), "CLOSE_THREW"],
      [() => ct.t.terminate(), "TERMINATE_THREW"],
    ] as const) {
      const e = thrown(fn);
      expect(e.message).toBe(`[CPMM_WS] ${code}`);
      expectNoSecret(e);
    }
  });

  it("W10: credential-bearing failures from every source leave no trace", () => {
    const outputs: unknown[] = [];
    const ct = make({ constructThrows: true });
    outputs.push(
      thrown(() => ct.t.start()),
      ct.t.diagnostics(),
    );
    const cases: [unknown, boolean, string][] = [
      [credError("ECONNREFUSED"), false, "NETWORK"],
      [credError("ENOTFOUND"), false, "NETWORK"],
      [credError("CERT_HAS_EXPIRED"), false, "TLS"],
      [credError("ERR_SSL_WRONG_VERSION_NUMBER"), false, "TLS"],
      [credError(), false, "PRE_OPEN_UNCLASSIFIED"], // e.g. an unexpected server response
      [`Unexpected server response: 401 ${ENDPOINT}`, false, "PRE_OPEN_UNCLASSIFIED"],
      [credError("WS_ERR_INVALID_OPCODE"), true, "PROTOCOL"],
      [credError("WS_ERR_INVALID_UTF8"), true, "INVALID_UTF8"],
      [credError("WS_ERR_TOO_MANY_BUFFERED_PARTS"), true, "RECEIVER_LIMIT"],
      [credError(), true, "UNCLASSIFIED"],
      [credError(42), true, "UNREADABLE"],
      [credError("X".repeat(65)), true, "UNREADABLE"],
      [trapCounter(credError("ECONNREFUSED")).proxy, true, "UNREADABLE"],
    ];
    // An inherited code is not read (it is not the error's own data).
    const inherited = Object.create(credError("ECONNREFUSED")) as Error;
    cases.push([inherited, true, "UNCLASSIFIED"]);
    for (const [err, afterOpen, category] of cases) {
      const m = make();
      m.t.start();
      if (afterOpen) m.c.open();
      m.c.emit("error", err);
      expect(of(m.rec, "error"), category).toEqual([{ event: "error", args: [] }]);
      expect(m.t.diagnostics().errors[category as "NETWORK"], category).toBe(1);
      m.c.finishClose(1006);
      outputs.push(m.rec.events, m.t.diagnostics(), inspect(m.t, { showHidden: true }));
    }
    const thrower = opened({ throwOn: { send: true, close: true, terminate: true } });
    outputs.push(
      thrown(() => thrower.t.send("a", () => undefined)),
      thrown(() => thrower.t.close(1000)),
      thrown(() => thrower.t.terminate()),
      thrower.t.diagnostics(),
    );
    for (const o of outputs) expectNoSecret(o);
  });

  it("W11: a client error is always handled: after disposal of owner listeners, after close, and never by removing client listeners", () => {
    const m = opened();
    for (const off of m.rec.off) off();
    expect(() => m.c.emit("error", credError())).not.toThrow();
    m.c.finishClose(1000);
    expect(() => m.c.emit("error", credError())).not.toThrow();
    expect(() => m.c.emit("message", bytes(1))).not.toThrow();
    expect(m.c.removals).toBe(0);
    expect(m.t.diagnostics().eventsAfterRelease).toBe(2);
    // A setup failure after the error listener exists still handles later errors.
    const f = make({ binaryTypeThrows: true });
    thrown(() => f.t.start());
    expect(() => f.c.emit("error", credError())).not.toThrow();
    expect(f.c.removals).toBe(0);
  });

  it("W12: the actual close releases references even if an owner listener throws or re-enters", () => {
    const m = opened({ closeMode: "none" });
    const reentry: unknown[] = [];
    m.t.on("close", () => {
      reentry.push(m.t.readyState);
      m.t.close(1000);
      m.t.terminate();
      reentry.push(thrown(() => m.t.send("a", () => undefined)).message);
      throw credError();
    });
    let afterCalls = 0;
    m.t.on("close", () => {
      afterCalls++;
    });
    const calls = m.c.calls.length;
    m.c.finishClose(4000);
    expect(reentry).toEqual([3, "[CPMM_WS] NOT_OPEN"]);
    expect(afterCalls).toBe(1);
    expect(m.c.calls.length).toBe(calls);
    expect(m.t.diagnostics()).toMatchObject({ lifecycle: "CLOSED", ownerListenerThrew: 1 });
    // Later client events are only counted; listeners registered now are not retained.
    m.c.emit("message", bytes(1));
    m.c.emit("open");
    m.c.emit("close", 1000);
    let lateCalls = 0;
    m.t.on("message", () => lateCalls++);
    m.c.emit("message", bytes(1));
    expect(lateCalls).toBe(0);
    expect(of(m.rec, "close").length).toBe(1);
    expect(m.t.diagnostics().eventsAfterRelease).toBe(4);
  });

  it("W14: source boundary: only node:util and type imports; no network, file, env, console or parsing", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./CpmmPoolWebSocketTransport.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map((x) => x[0]);
    expect(imports).toEqual([
      'import { types as utilTypes } from "node:util";',
      'import type { CpmmOwnerTransport } from "./CpmmPoolConnectionOwner.js";',
    ]);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      /from "ws"/,
      /require\(/,
      /\bhttp\b/,
      /\bnet\b/,
      /\btls\b/,
      /\bdns\b/,
      /\bfs\b/,
      /process\./,
      /console\./,
      /fetch\(/,
      /JSON\.parse/,
      /setTimeout|setInterval|setImmediate/,
      /\.message\b/,
      /\.stack\b/,
      /removeAllListeners|removeListener/,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("W16: diagnostics are frozen, plain, fixed-code and conserved", () => {
    const m = opened();
    m.c.message(bytes(2));
    m.c.message(bytes(99));
    m.c.emit("ping", bytes(4));
    m.c.emit("pong", bytes(126));
    m.c.emit("error", credError("WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
    m.c.message(bytes(2));
    m.c.finishClose(1006);
    const d = m.t.diagnostics();
    expect(d).toMatchObject({
      lifecycle: "CLOSED",
      opened: true,
      messages: {
        received: 3,
        delivered: 1,
        deliveredBytes: 2,
        refusedPayloadLimit: 1,
        suppressedAfterPayloadLimit: 1,
      },
      control: { pingsDelivered: 1, refused: 1 },
      close: { rawCode: 1006, deliveredCode: 1009 },
    });
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect(m.t.diagnostics()).not.toBe(d);
    expectDiagnosticsConserved(d);
    expect(() => {
      (d as { lifecycle: string }).lifecycle = "X";
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// W13: the real accepted owner over the wrapper and a fake client
// ---------------------------------------------------------------------------------------------

const CANDIDATE = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OBS_START = 1_794_829_400_000;
const NOMINAL_END = OBS_START + 30_000;
const SUB_REQ = 7;
const UNSUB_REQ = 8;
const OWNER_LIMITS: CpmmConnectionOwnerLimits = {
  observationMs: 30_000,
  ackTimeoutMs: 5_000,
  unsubscribeAckTimeoutMs: 2_000,
  pingIntervalMs: 10_000,
  pongTimeoutMs: 2_000,
  maxPings: 3,
  maxPongReplies: 4,
  maxControlFrames: 16,
  maxControlPayloadBytes: 125,
  maxOutstandingResolutions: 4,
  maxRetainedUnprocessed: 4,
  drainMs: 15_000,
  cleanupTimeoutMs: 3_000,
};
const FRAME_BYTES = 4_096;
const RPC_URL = `https://${HOST}/?api-key=${SECRET}`;
const text = (v: unknown) => Buffer.from(JSON.stringify(v));

function adaptedPool() {
  const vault = (mint: string, raw: bigint) =>
    createAuthoritativeCpmmSplVaultBuffer({
      mintBase58: mint,
      ownerBase58: RAYDIUM_CPMM_AUTHORITY,
      rawAmount: raw,
      state: 1,
    });
  const r = adaptRaydiumCpmmPoolState({
    target: { poolAddress: FIXTURE_CPMM_POOL_ADDRESS, candidateMint: CANDIDATE },
    poolAccount: {
      address: FIXTURE_CPMM_POOL_ADDRESS,
      data: createAuthoritativeRaydiumCpmmBuffer({
        authBump: CANONICAL_CPMM_AUTH_BUMP,
        token0MintBase58: CANDIDATE,
        token1MintBase58: WSOL_MINT,
        mint0Decimals: 6,
        mint1Decimals: 9,
        status: 0,
        creatorFeeOn: 0,
        enableCreatorFee: false,
      }),
      ownerProgramId: RAYDIUM_CPMM_PROGRAM_ID,
      slot: 300_000_000,
    },
    vault0Account: {
      address: FIXTURE_CPMM_TOKEN_0_VAULT,
      data: vault(CANDIDATE, 10_000_000_000n),
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: 300_000_000,
    },
    vault1Account: {
      address: FIXTURE_CPMM_TOKEN_1_VAULT,
      data: vault(WSOL_MINT, 50_000_000_000n),
      ownerProgramId: SPL_TOKEN_PROGRAM_ID,
      slot: 300_000_000,
    },
  });
  if (!r.ok) throw new Error(`fixture refused: ${r.refusalCode}`);
  return r;
}

function ownerEnv(s: Script) {
  const state = { now: OBS_START };
  let nextTimer = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: PaperRequestSessionTimers = {
    setTimeout: (fn, ms) => {
      const id = ++nextTimer;
      queue.set(id, { at: state.now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (h) => {
      queue.delete(h as number);
    },
  };
  const lane = (maxAttempts: number, pacingMs: number, maxResponseBytes: number) => ({
    maxAttempts,
    pacingMs,
    maxResponseBytes,
  });
  const recorder = createCpmmExchangeEvidenceRecorder({ maxPendingEvidence: 8 });
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn: (async () => {
      throw new Error("UNSCRIPTED_REQUEST");
    }) as unknown as typeof fetch,
    limits: {
      lifetimeMs: 600_000,
      maxHttpAttempts: 4,
      requestTimeoutMs: 10_000,
      lanes: {
        SOLANA_RPC: lane(4, 2_500, 200_000),
        RUGCHECK: lane(0, 1, 1),
        SOLANA_TRACKER: lane(0, 1, 1),
        DEXSCREENER: lane(0, 1, 1),
      },
    },
    clock: () => state.now,
    timers,
    onExchangeComplete: (ev) => recorder.observe(ev),
  });
  recorder.bind(session);
  session.open();
  const pool = adaptedPool();
  const adapter = new RaydiumCpmmTransactionSourceAdapter({
    pool,
    session,
    evidence: recorder,
    rpcUrl: RPC_URL,
    secrets: [RPC_URL, SECRET],
    maxTrackedSignatures: 8,
    maxResponseBytes: 100_000,
  });
  const ledger = new CpmmResolutionAccountingLedger({
    binding: adapter.getBinding(),
    adapter,
    tracker: new RollingTradeFlowTracker({
      poolId: pool.poolAddress,
      tokenMint: pool.candidateMint,
      trackingStartedMs: OBS_START,
      clock: () => state.now,
    }),
    limits: { maxSignatureRecords: 8, maxDuplicateDetailsPerRecord: 2, maxEpochs: 4 },
  });
  const collector = new CpmmPoolNotificationCollector({
    binding: adapter.getBinding(),
    limits: {
      maxFrameBytes: FRAME_BYTES,
      maxEpochFrames: 64,
      maxEpochBytes: 65_536,
      maxRetainedFrameRecords: 64,
      maxRetainedNotifications: 16,
      maxEpochs: 4,
    },
    commitment: "confirmed",
  });
  const f = fakeCtor(s);
  const wrappers: CpmmPoolWebSocketTransport[] = [];
  const owner = new CpmmPoolConnectionOwner({
    session,
    collector,
    ledger,
    binding: adapter.getBinding(),
    transportFactory: () => {
      const w = new CpmmPoolWebSocketTransport({
        endpoint: ENDPOINT,
        clientConstructor: f.ctor,
        limits: {
          maxFrameBytes: FRAME_BYTES,
          maxFragments: 8,
          maxBufferedChunks: 64,
          handshakeTimeoutMs: OWNER_LIMITS.ackTimeoutMs - 1,
          closeTimeoutMs: OWNER_LIMITS.cleanupTimeoutMs,
        },
      });
      wrappers.push(w);
      return w;
    },
    timers,
    epoch: 1,
    subscribeRequestId: SUB_REQ,
    unsubscribeRequestId: UNSUB_REQ,
    limits: OWNER_LIMITS,
  });
  const to = async (t: number) => {
    for (;;) {
      await flush(4);
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of queue) {
        if (entry[1].at <= t && (!best || entry[1].at < best[1].at)) best = entry;
      }
      if (!best) break;
      queue.delete(best[0]);
      if (best[1].at > state.now) state.now = best[1].at;
      best[1].fn();
    }
    if (t > state.now) state.now = t;
    await flush(4);
  };
  return {
    owner,
    f,
    to,
    get c(): FakeClient {
      return f.instances[0]!;
    },
    get w(): CpmmPoolWebSocketTransport {
      return wrappers[0]!;
    },
  };
}

const ack = () => text({ jsonrpc: "2.0", id: SUB_REQ, result: 4242 });
const unsubAck = () => text({ jsonrpc: "2.0", id: UNSUB_REQ, result: true });

/** The run promise is wrapped (an async function returning it would await the whole run). */
async function startAndAck(
  e: ReturnType<typeof ownerEnv>,
): Promise<{ p: Promise<CpmmConnectionRunReport> }> {
  const p = e.owner.run();
  e.c.open();
  await e.to(OBS_START + 10);
  e.c.message(ack());
  await flush();
  return { p };
}

describe("W13: the real accepted owner over the wrapper (synthetic)", () => {
  it("W13a: a normal run is clean, with byte-exact frames and explicit pongs", async () => {
    const e = ownerEnv({ autoPong: true });
    const { p } = await startAndAck(e);
    e.c.emit("ping", Buffer.from([9, 9]));
    await e.to(NOMINAL_END);
    e.c.message(unsubAck());
    await e.to(NOMINAL_END + 10);
    const r = await p;
    expect(r.connectionRunClean).toBe(true);
    expect(r.outgoing.pongReplies).toMatchObject({ reserved: 1, completed: 1 });
    expect(r.outgoing.pongsMatched).toBe(2);
    expect(r.cleanup).toMatchObject({ status: "SETTLED", closeCode: 1000 });
    expect(e.c.calls.filter((x) => x.name === "send").length).toBe(2);
    expect(e.c.calls.find((x) => x.name === "close")!.args).toEqual([1000]);
    expect(e.w.diagnostics()).toMatchObject({ lifecycle: "CLOSED", clientConstructions: 1 });
    expectNoSecret(r, "report");
  });

  it("W13b: a latched local payload refusal ends ACQUISITION_LIMIT only at the actual close", async () => {
    const e = ownerEnv({ autoPong: true, closeMode: "none" });
    const { p } = await startAndAck(e);
    await e.to(OBS_START + 1_000);
    e.c.emit("error", credError("WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
    await e.to(OBS_START + 1_500);
    e.c.message(text({ late: true })); // suppressed while awaiting the close
    await e.to(OBS_START + 2_000);
    e.c.finishClose(1006);
    await e.to(OBS_START + 2_010);
    const r = await p;
    expect(r.terminal).toMatchObject({
      cause: "ACQUISITION_LIMIT",
      code: "TRANSPORT_PAYLOAD_LIMIT",
      atMs: OBS_START + 2_000,
    });
    expect(r.incoming.messageEvents).toBe(1); // the acknowledgement only
    expect(e.w.diagnostics().close).toEqual({ observed: true, rawCode: 1006, deliveredCode: 1009 });
    expectNoSecret(r, "report");
  });

  it("W13c: a peer 1009 without a local refusal is a plain transport close", async () => {
    const e = ownerEnv({ autoPong: true });
    const { p } = await startAndAck(e);
    e.c.finishClose(1009);
    const r = await p;
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_CLOSED" });
    expect(r.cleanup.closeCode).toBeNull();
    expect(e.w.diagnostics().close.rawCode).toBe(1009);
  });

  it("W13d: a wrapper-side size refusal is a generic transport error first", async () => {
    const e = ownerEnv({ autoPong: true });
    const { p } = await startAndAck(e);
    e.c.message(Buffer.alloc(FRAME_BYTES + 1, 0x20));
    const r = await p;
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "ERROR_EVENT" });
    expect(e.w.diagnostics().messages.refusedPayloadLimit).toBe(1);
  });

  it("W13e: a credential-bearing handshake failure before open ends TRANSPORT_ERROR", async () => {
    const e = ownerEnv({});
    const p = e.owner.run();
    e.c.emit("error", credError());
    e.c.finishClose(1006);
    const r = await p;
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "ERROR_EVENT" });
    expect(e.w.diagnostics().errors.PRE_OPEN_UNCLASSIFIED).toBe(1);
    expectNoSecret(r, "report");
  });

  it("W13f: a cleanup terminate reports FAILED_STILL_OPEN while the client is truthfully CLOSING", async () => {
    const e = ownerEnv({ autoPong: true, closeMode: "none" });
    const { p } = await startAndAck(e);
    await e.to(NOMINAL_END);
    e.c.message(unsubAck());
    await e.to(NOMINAL_END + OWNER_LIMITS.cleanupTimeoutMs);
    const r = await p;
    expect(r.terminal.cause).toBe("OBSERVATION_COMPLETED");
    expect(r.cleanup).toMatchObject({ status: "FAILED_STILL_OPEN", terminateAttempted: true });
    expect(e.w.readyState).toBe(2);
    // The actual close arrives later. The owner disposed its listeners at settlement, so it never
    // sees it (not even as a late event); the wrapper still releases its references.
    e.c.finishClose(1006);
    expect(e.owner.lateEvents().close).toBe(0);
    expect(e.w.readyState).toBe(3);
    expect(e.w.diagnostics()).toMatchObject({
      lifecycle: "CLOSED",
      close: { rawCode: 1006, deliveredCode: 1006 },
    });
  });

  it("W13g: a start failure after the client exists ends START_FAILED with no second construction", async () => {
    // The best-effort terminate leaves the client CLOSING; the owner's close() then closes it.
    const e = ownerEnv({ binaryTypeThrows: true });
    const r = await e.owner.run();
    expect(r.terminal).toMatchObject({ cause: "TRANSPORT_ERROR", code: "START_FAILED" });
    expect(r.cleanup).toMatchObject({ status: "SETTLED", closeCode: 1000 });
    expect(e.c.calls.map((x) => x.name).slice(-2)).toEqual(["terminate", "close"]);
    expect(e.f.attempts()).toBe(1);
    expect(e.w.readyState).toBe(3);
    expect(e.w.diagnostics()).toMatchObject({
      lifecycle: "CLOSED",
      startupFailure: "BINARY_TYPE_FAILED",
    });
    expectNoSecret(r, "report");
    // A synchronous close during the startup cleanup is a transport close first.
    const s = ownerEnv({ binaryTypeThrows: true, terminateCloses: true });
    expect((await s.owner.run()).terminal.cause).toBe("TRANSPORT_CLOSED");
    expect(s.f.attempts()).toBe(1);
  });
});
