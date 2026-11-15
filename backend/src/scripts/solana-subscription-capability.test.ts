/**
 * Subscription-only capability check (offline). Every dependency is injected and SYNTHETIC: a
 * scripted in-memory WebSocket transport and the shared virtual scheduler. Artifacts are written
 * only into this test's own OS temporary directories. No real network, socket, provider request,
 * credential or probe execution.
 */
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_EXIT_CODES,
  CAPABILITY_FILES,
  CAPABILITY_LIMITS,
  CAPABILITY_USAGE,
  SUBSCRIBE_FRAME,
  classifyIncoming,
  printableCapabilityError,
  runSubscriptionCapabilityCheck,
  unsubscribeFrame,
  verifySubscriptionCapabilityEvidence,
  type CapabilityDeps,
  type CapabilityRunResult,
} from "./solana-subscription-capability.js";
import type { ISolanaKeepaliveWebSocketTransport } from "../candidate-scanner/RaydiumTransportObservationProbe.js";
import { RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION } from "./fresh-amm-v4-precheck.js";
import { SOLANA_ENDPOINT_ERRORS } from "./paper-single-candidate-diagnostic.js";
import { START_MS, VirtualScheduler, drive } from "./fresh-amm-v4-precheck.test-support.js";

type Loose = ReturnType<typeof JSON.parse>;

const RPC_KEY = "SYNTHETIC-rpc-key-24680";
const WS_KEY = "SYNTHETIC-stream-key-1357911";
const RPC_URL = `https://rpc.synthetic.invalid/?api-key=${RPC_KEY}`;
const WS_URL = `wss://stream.synthetic.invalid/v2/${WS_KEY}`;
const SECRETS = [RPC_URL, WS_URL, RPC_KEY, WS_KEY];
const ENV = Object.freeze({ SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: WS_URL });
const RUN = "data/research/capability-checks/check-01";
const SUB_ID = 4242;
const DEADLINE = START_MS + 5_000;

const ack = (result: unknown = SUB_ID, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, result });
const rpcError = (code: number, message: string, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
const NOTIFICATION = JSON.stringify({
  jsonrpc: "2.0",
  method: "logsNotification",
  params: { subscription: SUB_ID, result: { value: { signature: "SYNTHETIC", logs: [] } } },
});

// ---------------------------------------------------------------------------------------------
// SYNTHETIC transport
// ---------------------------------------------------------------------------------------------

interface FakeOptions {
  /** When the transport opens (ms after start); null never. */
  openAtMs?: number | null;
  /** Reply to the subscribe request (after replyDelayMs); null no reply. */
  onSubscribe?: string | null;
  /** Reply to the unsubscribe request; null no reply. */
  onUnsubscribe?: string | null;
  replyDelayMs?: number;
  /** Extra scripted incoming messages (ms after start). */
  script?: readonly { atMs: number; data: string }[];
  throwOnClose?: boolean;
  /** close() does not close; terminate() does unless stayOpen. */
  slowClose?: boolean;
  stayOpen?: boolean;
  sendThrows?: boolean;
}

class FakeTransport implements ISolanaKeepaliveWebSocketTransport {
  readyState = 0;
  readonly sent: string[] = [];
  pings = 0;
  closeCalls = 0;
  private readonly listeners: Record<string, ((...args: never[]) => void)[]> = {};
  constructor(
    private readonly sched: VirtualScheduler,
    private readonly o: FakeOptions,
  ) {}
  on = ((event: string, listener: (...args: never[]) => void) => {
    (this.listeners[event] ??= []).push(listener);
  }) as ISolanaKeepaliveWebSocketTransport["on"];
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  send(data: string): void {
    if (this.o.sendThrows) throw new Error("SYNTHETIC send failure");
    this.sent.push(data);
    const reply = this.sent.length === 1 ? this.o.onSubscribe : this.o.onUnsubscribe;
    if (reply !== null && reply !== undefined) {
      this.sched.add(() => this.incoming(reply), this.o.replyDelayMs ?? 50, "harness");
    }
  }
  incoming(data: string): void {
    if (this.readyState === 1) this.emit("message", data);
  }
  close(): void {
    this.closeCalls++;
    if (this.o.throwOnClose) throw new Error("SYNTHETIC close failure");
    if (this.o.slowClose) return;
    this.readyState = 3;
    this.emit("close", 1000, "");
  }
  terminate(): void {
    if (this.o.stayOpen) return;
    this.readyState = 3;
    this.emit("close", 1006, "");
  }
  ping(): void {
    this.pings++;
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

function harness(o: FakeOptions & { env?: Record<string, string | undefined> } = {}) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "subscription-capability-test-"));
  roots.push(projectRoot);
  const sched = new VirtualScheduler(START_MS);
  const lines: string[] = [];
  const transports: FakeTransport[] = [];
  const urls: string[] = [];
  const controller = new AbortController();
  let loads = 0;
  for (const s of o.script ?? []) {
    sched.at(START_MS + s.atMs, () => transports[0]?.incoming(s.data));
  }
  const deps = (extra: Partial<CapabilityDeps> = {}): CapabilityDeps => ({
    env: o.env ?? ENV,
    loadEnvironment: () => {
      loads++;
    },
    createWebSocketTransport: (url: string) => {
      urls.push(url);
      const t = new FakeTransport(sched, o);
      transports.push(t);
      const openAt = o.openAtMs === undefined ? 100 : o.openAtMs;
      if (openAt !== null) sched.at(START_MS + openAt, () => t.open());
      return t;
    },
    clock: () => sched.now,
    timers: {
      setTimeout: (fn: () => void, ms: number) => sched.add(fn, ms, "provider"),
      clearTimeout: (h: unknown) => sched.clear(h),
    },
    projectRoot,
    signal: controller.signal,
    log: (line: string) => lines.push(line),
    ...extra,
  });
  const run = (args: readonly string[], extra: Partial<CapabilityDeps> = {}) =>
    drive(sched, runSubscriptionCapabilityCheck(args, deps(extra)));
  const abs = (rel: string) => path.join(projectRoot, ...rel.split("/"));
  return { projectRoot, sched, lines, transports, urls, controller, loads: () => loads, run, abs };
}
type Harness = ReturnType<typeof harness>;

const live = (h: Harness, extra: Partial<CapabilityDeps> = {}) =>
  h.run(["--out-dir", RUN, "--live"], extra);
const probeJson = (h: Harness): Loose =>
  JSON.parse(readFileSync(path.join(h.abs(RUN), CAPABILITY_FILES.probe), "utf8"));

function listFiles(dir: string): string[] {
  return readdirSync(dir);
}

function expectNoSecrets(h: Harness) {
  for (const line of h.lines) for (const s of SECRETS) expect(line.includes(s), line).toBe(false);
  let names: string[] = [];
  try {
    names = listFiles(h.abs(RUN));
  } catch {
    return;
  }
  for (const f of names) {
    const text = readFileSync(path.join(h.abs(RUN), f), "utf8");
    for (const s of SECRETS) expect(text.includes(s), `${s} in ${f}`).toBe(false);
  }
}

function expectSettled(h: Harness, r: CapabilityRunResult) {
  expect(h.sched.count("provider")).toBe(0);
  expect(h.transports.length).toBeLessThanOrEqual(1);
  for (const t of h.transports) expect(t.pings).toBe(0);
  expect(r.probe?.counts.clientPings ?? 0).toBe(0);
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe("Solana subscription-only capability check (offline)", () => {
  it("S-01: help, dry run and verify are inert; conflicting modes are refused", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const h = harness();
    expect(await h.run(["--help"])).toMatchObject({ mode: "HELP", exitCode: 0 });
    expect(h.lines[0]).toBe(CAPABILITY_USAGE);
    const dry = await h.run(["--out-dir", RUN]);
    expect(dry).toMatchObject({ mode: "DRY_RUN", exitCode: 0 });
    const plan = JSON.parse(h.lines.at(-1)!) as Loose;
    expect(plan).toMatchObject({
      kind: "PAPER_SOLANA_SUBSCRIPTION_CAPABILITY_PLAN",
      mode: "DRY_RUN",
      outDir: RUN,
      subscribeFrame: SUBSCRIBE_FRAME,
      limits: { ...CAPABILITY_LIMITS },
    });
    expect(CAPABILITY_LIMITS).toEqual({
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
    expect(JSON.parse(SUBSCRIBE_FRAME)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION] },
        { commitment: "confirmed" },
      ],
    });
    expect(await h.run(["--verify", RUN])).toMatchObject({
      mode: "VERIFY",
      exitCode: CAPABILITY_EXIT_CODES.INTEGRITY_FAILED,
    });
    expect(h.loads()).toBe(0);
    expect(h.transports).toEqual([]);
    expect(readdirSync(h.projectRoot)).toEqual([]);
    for (const args of [
      ["--help", "--live"],
      ["--verify", RUN, "--live"],
      ["--verify", RUN, "--out-dir", RUN],
      ["--live"],
      [],
      ["--out-dir", RUN, "--out-dir", RUN],
      ["--out-dir", RUN, "positional"],
      ["--out-dir", RUN, "--retry"],
      ["--verify", "data/research/prechecks/x"],
    ]) {
      await expect(h.run(args), args.join(" ")).rejects.toThrow(/^\[CLI_INVALID_ARG\]/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("S-02: output and configuration are refused before any transport; SOLANA_WS_URL must be explicit", async () => {
    const h = harness();
    for (const out of [
      "data/research/prechecks/check",
      "data/research/capability-checks",
      `${RUN}/nested`,
      "data/research/capability-checks/bad name",
      "../outside",
    ]) {
      await expect(h.run(["--out-dir", out, "--live"]), out).rejects.toThrow(
        /^\[CLI_INVALID_ARG\]/,
      );
    }
    mkdirSync(h.abs(RUN), { recursive: true });
    await expect(live(h)).rejects.toThrow(/^\[OUTPUT_EXISTS\]/);
    expect(h.loads()).toBe(0);
    for (const [env, message] of [
      [
        { SOLANA_RPC_URL: RPC_URL },
        /^\[MISSING_CONFIGURATION\] SOLANA_WS_URL \(ws or wss\) is required for the subscription capability check/,
      ],
      [
        { SOLANA_RPC_URL: "https://solana-mainnet.g.alchemy.com/v2/SYNTHETIC-alchemy-0000" },
        SOLANA_ENDPOINT_ERRORS.wsRequired,
      ],
      [
        { SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: "ws://stream.synthetic.invalid/x" },
        SOLANA_ENDPOINT_ERRORS.wsDowngrade,
      ],
      [
        { SOLANA_RPC_URL: RPC_URL, SOLANA_WS_URL: "https://stream.synthetic.invalid/x" },
        SOLANA_ENDPOINT_ERRORS.wsInvalid,
      ],
      [{ SOLANA_WS_URL: WS_URL }, SOLANA_ENDPOINT_ERRORS.rpc],
    ] as const) {
      const c = harness({ env });
      const err = await live(c).catch((e: unknown) => e);
      if (typeof message === "string") expect((err as Error).message).toBe(message);
      else expect((err as Error).message).toMatch(message);
      expect(printableCapabilityError(err)).toBe((err as Error).message);
      expect(c.loads()).toBe(1);
      expect(c.transports).toEqual([]);
      expect(readdirSync(c.projectRoot)).toEqual([]);
    }
    expect(printableCapabilityError(new Error(`[X] ${WS_URL}`))).toBe("[X]");
  });

  it("S-03: a valid acknowledgement, one unsubscribe and its acknowledgement confirm the capability", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const h = harness({ onSubscribe: ack(), onUnsubscribe: ack(true, 2) });
    const r = await live(h);
    expect(r).toMatchObject({
      mode: "LIVE",
      exitCode: CAPABILITY_EXIT_CODES.OK,
      probe: {
        outcome: "SUBSCRIPTION_ACKNOWLEDGED",
        acknowledgement: { subscriptionId: SUB_ID },
        unsubscribe: { status: "OBSERVED" },
        cancelled: false,
        cleanup: { settled: true, failed: false },
        capabilityConfirmed: true,
        reasons: [],
        counts: { outgoingFrames: 2, incomingMessages: 2, clientPings: 0 },
      },
      seal: { ok: true },
      verification: {
        integrity: { ok: true },
        outcome: "SUBSCRIPTION_ACKNOWLEDGED",
        capabilityConfirmed: true,
        subscriptionId: SUB_ID,
      },
    });
    expect(h.urls).toEqual([WS_URL]);
    expect(h.transports[0]!.sent).toEqual([SUBSCRIBE_FRAME, unsubscribeFrame(SUB_ID)]);
    expect(r.probe!.startedAtMs).toBe(START_MS);
    expect(r.probe!.deadlineAtMs).toBe(DEADLINE);
    expect(h.transports[0]!.readyState).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readdirSync(h.abs(RUN)).sort()).toEqual([
      "evidence-manifest.json",
      "plan.json",
      "probe.json",
    ]);
    expect(probeJson(h)).toMatchObject({
      endpoint: "SOLANA_WS_URL (configuration; never recorded)",
    });
    expect((await h.run(["--verify", RUN])).exitCode).toBe(CAPABILITY_EXIT_CODES.OK);
    expectNoSecrets(h);
    expectSettled(h, r);
  });

  it("S-04: an unobserved or rejected unsubscribe is recorded as such; the deadline is not extended for it", async () => {
    const silent = harness({ onSubscribe: ack(), onUnsubscribe: null });
    const a = await live(silent);
    expect(a.probe).toMatchObject({
      outcome: "SUBSCRIPTION_ACKNOWLEDGED",
      unsubscribe: { status: "SENT_UNOBSERVED", responseAtMs: null },
      endedAtMs: DEADLINE,
      capabilityConfirmed: true,
    });
    expect(a.verification?.capabilityConfirmed).toBe(true);
    expectSettled(silent, a);

    for (const reply of [ack(false, 2), rpcError(-32602, "Invalid subscription id", 2)]) {
      const h = harness({ onSubscribe: ack(), onUnsubscribe: reply });
      const r = await live(h);
      expect(r.probe?.unsubscribe.status, reply).toBe("REJECTED");
      expect(r.verification).toMatchObject({ integrity: { ok: true }, capabilityConfirmed: true });
    }
    // The unsubscribe is not sent once the deadline has passed; the acknowledgement arrived late.
    const late = harness({ onSubscribe: ack(), replyDelayMs: 5_000 });
    const l = await live(late);
    expect(l.probe).toMatchObject({
      outcome: "ACK_TIMEOUT",
      acknowledgement: null,
      unsubscribe: { status: "NOT_SENT" },
    });
    expect(late.transports[0]!.sent).toEqual([SUBSCRIBE_FRAME]);
  });

  it("S-05: a JSON-RPC rejection is recorded with its code; nothing else is sent", async () => {
    const h = harness({ onSubscribe: rpcError(-32601, "Method 'logsSubscribe' not found") });
    const r = await live(h);
    expect(r).toMatchObject({
      exitCode: CAPABILITY_EXIT_CODES.NOT_CONFIRMED,
      probe: {
        outcome: "SUBSCRIPTION_REJECTED",
        rejection: { code: -32601, message: "Method 'logsSubscribe' not found" },
        acknowledgement: null,
        unsubscribe: { status: "NOT_SENT" },
        capabilityConfirmed: false,
        reasons: ["OUTCOME:SUBSCRIPTION_REJECTED"],
      },
      verification: {
        integrity: { ok: true },
        outcome: "SUBSCRIPTION_REJECTED",
        capabilityConfirmed: false,
      },
    });
    expect(h.transports[0]!.sent).toEqual([SUBSCRIBE_FRAME]);
    expect((await h.run(["--verify", RUN])).exitCode).toBe(CAPABILITY_EXIT_CODES.NOT_CONFIRMED);
    expectSettled(h, r);
  });

  it("S-06: mismatched response ids and malformed responses never confirm", async () => {
    for (const reply of [
      ack(SUB_ID, 7),
      ack(true, 2),
      JSON.stringify({ jsonrpc: "2.0", id: "1", result: SUB_ID }),
    ]) {
      const h = harness({ onSubscribe: reply });
      const r = await live(h);
      expect(r.probe?.outcome, reply).toBe("MISMATCHED_RESPONSE_ID");
      expect(r.verification, reply).toMatchObject({
        integrity: { ok: true },
        capabilityConfirmed: false,
      });
    }
    const malformed = [
      "not json",
      "[1]",
      "42",
      JSON.stringify({ jsonrpc: "1.0", id: 1, result: SUB_ID }),
      JSON.stringify({ id: 1, result: SUB_ID }),
      ack("4242"),
      ack(-1),
      ack(1.5),
      ack(null),
      ack(Number.MAX_SAFE_INTEGER + 2),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: SUB_ID, error: { code: 1, message: "x" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: SUB_ID, extra: true }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "x" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: "-32601", message: "x" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "x", other: 1 } }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [] }),
      JSON.stringify({ jsonrpc: "2.0", method: "slotNotification", params: {} }),
    ];
    for (const reply of malformed) {
      const h = harness({ onSubscribe: reply });
      const r = await live(h);
      expect(r.probe?.outcome, reply).toBe("MALFORMED_RESPONSE");
      expect(r.probe?.acknowledgement, reply).toBeNull();
      expect(r.verification, reply).toMatchObject({
        integrity: { ok: true },
        capabilityConfirmed: false,
      });
      expect(r.exitCode, reply).toBe(CAPABILITY_EXIT_CODES.NOT_CONFIRMED);
    }
    // A second acknowledgement after a valid one is a protocol violation.
    const twice = harness({ onSubscribe: ack(), script: [{ atMs: 2_000, data: ack(SUB_ID + 1) }] });
    const t = await live(twice);
    expect(t.probe).toMatchObject({
      outcome: "MALFORMED_RESPONSE",
      acknowledgement: { subscriptionId: SUB_ID },
    });
    expect(t.verification?.capabilityConfirmed).toBe(false);
    // The classifier itself.
    expect(classifyIncoming(ack(), { unsubscribeSent: false })).toEqual({
      kind: "SUBSCRIBE_ACK",
      subscriptionId: SUB_ID,
    });
    expect(classifyIncoming(NOTIFICATION, { unsubscribeSent: false })).toEqual({
      kind: "NOTIFICATION",
    });
  });

  it("S-07: one absolute 5,000 ms deadline from before construction, never reset by open or messages", async () => {
    // Never opens: the deadline ends it, with nothing sent.
    const stalled = harness({ openAtMs: null });
    const s = await live(stalled);
    expect(s.probe).toMatchObject({
      outcome: "ACK_TIMEOUT",
      phaseAtEnd: "CONNECTING",
      endedAtMs: DEADLINE,
      openedAtMs: null,
      counts: { outgoingFrames: 0 },
      cleanup: { settled: true, failed: false },
    });
    expect(s.verification).toMatchObject({
      integrity: { ok: true },
      outcome: "ACK_TIMEOUT",
      capabilityConfirmed: false,
    });
    expectSettled(stalled, s);

    // Opens late and receives notifications: still ends at start + 5,000, not after open + 5,000.
    const late = harness({
      openAtMs: 4_000,
      onSubscribe: null,
      script: [
        { atMs: 4_200, data: NOTIFICATION },
        { atMs: 4_600, data: NOTIFICATION },
        { atMs: 5_200, data: ack() },
      ],
    });
    const l = await live(late);
    expect(l.probe).toMatchObject({
      outcome: "ACK_TIMEOUT",
      phaseAtEnd: "AWAITING_ACK",
      endedAtMs: DEADLINE,
      openedAtMs: START_MS + 4_000,
      acknowledgement: null,
      counts: { notifications: 2 },
    });
    expect(l.verification?.outcome).toBe("ACK_TIMEOUT");
    // An acknowledgement handled exactly at the deadline, before the deadline timer runs (as with
    // event-loop lag), decides nothing.
    const atDeadline = harness({ onSubscribe: null, script: [{ atMs: 5_000, data: ack() }] });
    const d = await live(atDeadline);
    expect(d.probe).toMatchObject({
      outcome: "ACK_TIMEOUT",
      acknowledgement: null,
      counts: { incomingMessages: 1 },
    });
    expect(d.verification).toMatchObject({ integrity: { ok: true }, outcome: "ACK_TIMEOUT" });
    // Opening at or after the deadline sends nothing.
    const tooLate = harness({ openAtMs: 6_000 });
    const t = await live(tooLate);
    expect(t.probe).toMatchObject({ outcome: "ACK_TIMEOUT", counts: { outgoingFrames: 0 } });
  });

  it("S-08: cancellation at any point is recorded and prevents a confirmed result", async () => {
    const before = harness({ onSubscribe: ack() });
    before.controller.abort();
    const b = await live(before);
    expect(b.probe).toMatchObject({
      outcome: "OPERATOR_CANCELLED",
      transportCreated: false,
      cancelled: true,
    });
    expect(before.transports).toEqual([]);
    expect(b.exitCode).toBe(CAPABILITY_EXIT_CODES.NOT_CONFIRMED);

    const connecting = harness({ openAtMs: 3_000 });
    connecting.sched.at(START_MS + 1_000, () => connecting.controller.abort());
    const c = await live(connecting);
    expect(c.probe).toMatchObject({
      outcome: "OPERATOR_CANCELLED",
      phaseAtEnd: "CONNECTING",
      counts: { outgoingFrames: 0 },
    });

    // After a valid acknowledgement, before the unsubscribe acknowledgement.
    const acked = harness({ onSubscribe: ack(), onUnsubscribe: null });
    acked.sched.at(START_MS + 1_000, () => acked.controller.abort());
    const a = await live(acked);
    expect(a.probe).toMatchObject({
      outcome: "OPERATOR_CANCELLED",
      acknowledgement: { subscriptionId: SUB_ID },
      capabilityConfirmed: false,
      reasons: ["OUTCOME:OPERATOR_CANCELLED", "CANCELLED"],
    });
    expect(a.verification).toMatchObject({ integrity: { ok: true }, capabilityConfirmed: false });

    // During cleanup of an otherwise confirmed run.
    const cleanup = harness({ onSubscribe: ack(), onUnsubscribe: ack(true, 2), slowClose: true });
    cleanup.sched.at(START_MS + 2_000, () => cleanup.controller.abort());
    const d = await live(cleanup);
    expect(d.probe).toMatchObject({
      outcome: "SUBSCRIPTION_ACKNOWLEDGED",
      cancelled: true,
      capabilityConfirmed: false,
      reasons: ["CANCELLED"],
    });
    expect(d.exitCode).toBe(CAPABILITY_EXIT_CODES.NOT_CONFIRMED);
    for (const r of [b, c, a, d]) expect(r.verification?.integrity.ok).toBe(true);
  });

  it("S-09: incoming messages and payload are bounded; notifications count without decoding", async () => {
    const many = harness({
      onSubscribe: null,
      script: Array.from({ length: 12 }, (_, i) => ({ atMs: 200 + i * 10, data: NOTIFICATION })),
    });
    const m = await live(many);
    expect(m.probe).toMatchObject({
      outcome: "MESSAGE_LIMIT_EXCEEDED",
      counts: { incomingMessages: 11, notifications: 10 },
    });
    expect(m.probe!.frames.at(-1)).toMatchObject({ overflow: "MESSAGE_LIMIT", payload: null });
    expect(m.verification).toMatchObject({
      integrity: { ok: true },
      outcome: "MESSAGE_LIMIT_EXCEEDED",
    });

    const big = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: { pad: "x".repeat(70_000) },
    });
    const large = harness({ onSubscribe: null, script: [{ atMs: 300, data: big }] });
    const l = await live(large);
    expect(l.probe).toMatchObject({
      outcome: "PAYLOAD_LIMIT_EXCEEDED",
      counts: { incomingMessages: 1 },
    });
    expect(l.probe!.frames.at(-1)).toMatchObject({ overflow: "PAYLOAD_LIMIT", payload: null });
    expect(
      readFileSync(path.join(large.abs(RUN), CAPABILITY_FILES.probe), "utf8").length,
    ).toBeLessThan(20_000);
    expect(l.verification?.outcome).toBe("PAYLOAD_LIMIT_EXCEEDED");
  });

  it("S-10: a failed cleanup is bounded to 5,000 ms and prevents a confirmed result", async () => {
    const h = harness({
      onSubscribe: ack(),
      onUnsubscribe: ack(true, 2),
      throwOnClose: true,
      stayOpen: true,
    });
    const r = await live(h);
    expect(r.probe).toMatchObject({
      outcome: "SUBSCRIPTION_ACKNOWLEDGED",
      cleanup: { settled: true, failed: true, forced: true },
      capabilityConfirmed: false,
      reasons: ["CLEANUP_FAILED"],
    });
    expect(r.probe!.cleanupEndedAtMs - r.probe!.endedAtMs).toBe(5_000);
    expect(r).toMatchObject({
      exitCode: CAPABILITY_EXIT_CODES.NOT_CONFIRMED,
      verification: { integrity: { ok: true }, capabilityConfirmed: false },
    });
    expect(h.sched.count("provider")).toBe(0);
    // A slow close that terminate() completes is a settled (forced) cleanup.
    const slow = harness({ onSubscribe: ack(), onUnsubscribe: ack(true, 2), slowClose: true });
    const s = await live(slow);
    expect(s.probe).toMatchObject({
      cleanup: { failed: false, forced: true },
      capabilityConfirmed: true,
    });
  });

  it("S-11: credential-bearing transport errors are redacted everywhere", async () => {
    const thrown = harness();
    const a = await live(thrown, {
      createWebSocketTransport: (url: string) => {
        throw new Error(`SYNTHETIC connect failure to ${url}`);
      },
    });
    expect(a.probe).toMatchObject({ outcome: "TRANSPORT_ERROR", transportCreated: false });
    expect(probeJson(thrown).detail).toBe(
      "transport construction failed: SYNTHETIC connect failure to [REDACTED]",
    );
    expectNoSecrets(thrown);
    expect(a.verification?.integrity.ok).toBe(true);

    const errored = harness({ onSubscribe: null });
    errored.sched.at(START_MS + 1_000, () =>
      errored.transports[0]!.emit(
        "error",
        new Error(`SYNTHETIC socket error at ${WS_URL} key ${WS_KEY}`),
      ),
    );
    const b = await live(errored);
    expect(b.probe?.outcome).toBe("TRANSPORT_ERROR");
    expect(probeJson(errored).detail).not.toContain(WS_KEY);
    expectNoSecrets(errored);

    // An echo of the key in a frame is redacted, and such a frame never confirms.
    const echo = harness({
      onSubscribe: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: `bad key ${WS_KEY}` },
      }),
    });
    const c = await live(echo);
    expect(c.probe?.outcome).toBe("SUBSCRIPTION_REJECTED");
    expectNoSecrets(echo);
    expect(c.verification?.capabilityConfirmed).toBe(false);

    const closed = harness({ onSubscribe: null });
    closed.sched.at(START_MS + 1_000, () => {
      const t = closed.transports[0]!;
      t.readyState = 3;
      t.emit("close", 1011, "");
    });
    expect((await live(closed)).probe?.outcome).toBe("TRANSPORT_CLOSED");
  });

  it("S-12: a write failure is explicit and never repeats the probe", async () => {
    const h = harness({ onSubscribe: ack(), onUnsubscribe: ack(true, 2) });
    let writes = 0;
    const r = await live(h, {
      writeFile: (file, content, options) => {
        writes++;
        if (file.endsWith(CAPABILITY_FILES.probe))
          throw new Error(`SYNTHETIC disk full near ${WS_KEY}`);
        writeFileSync(file, content, options);
      },
    });
    expect(r).toMatchObject({
      exitCode: CAPABILITY_EXIT_CODES.SEAL_FAILED,
      seal: { ok: false, status: "ARTIFACT_WRITE_FAILED" },
    });
    expect(r.verification).toBeUndefined();
    expect(writes).toBe(2);
    expect(h.transports).toHaveLength(1);
    expect(JSON.stringify(r.seal)).not.toContain(WS_KEY);
    expectNoSecrets(h);
    // An output directory that appears during the run is refused, also without a rerun.
    const raced = harness({ onSubscribe: ack(), onUnsubscribe: ack(true, 2) });
    raced.sched.at(START_MS + 200, () => mkdirSync(raced.abs(RUN), { recursive: true }));
    const s = await live(raced);
    expect(s).toMatchObject({
      exitCode: CAPABILITY_EXIT_CODES.SEAL_FAILED,
      seal: { ok: false, status: "OUTPUT_DIRECTORY_UNAVAILABLE" },
    });
    expect(raced.transports).toHaveLength(1);
  });

  it("S-13: offline verification fails closed on tampering and on forged outcomes", async () => {
    const h = harness({ onSubscribe: rpcError(-32601, "Method 'logsSubscribe' not found") });
    await live(h);
    const dir = h.abs(RUN);
    const probePath = path.join(dir, CAPABILITY_FILES.probe);
    const original = readFileSync(probePath, "utf8");
    // Tampering without updating the manifest.
    writeFileSync(probePath, original.replace("-32601", "-32602"));
    expect(verifySubscriptionCapabilityEvidence(dir).integrity.problems).toContain(
      `MODIFIED:${CAPABILITY_FILES.probe}`,
    );
    // A forged success with consistent hashes: the sealed frames still show the rejection.
    const forged = JSON.parse(original) as Loose;
    Object.assign(forged, {
      outcome: "SUBSCRIPTION_ACKNOWLEDGED",
      rejection: null,
      acknowledgement: { subscriptionId: SUB_ID, receivedAtMs: forged.rejection.receivedAtMs },
      capabilityConfirmed: true,
      reasons: [],
    });
    const forgedText = JSON.stringify(forged, null, 2) + "\n";
    writeFileSync(probePath, forgedText);
    const manifestPath = path.join(dir, CAPABILITY_FILES.manifest);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Loose;
    manifest.outcome = "SUBSCRIPTION_ACKNOWLEDGED";
    manifest.capabilityConfirmed = true;
    const entry = manifest.files.find((f: Loose) => f.path === CAPABILITY_FILES.probe);
    entry.sha256 = createHash("sha256").update(forgedText).digest("hex");
    entry.bytes = Buffer.byteLength(forgedText);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const v = verifySubscriptionCapabilityEvidence(dir);
    expect(v.integrity.ok).toBe(false);
    expect(v.integrity.problems).toEqual(
      expect.arrayContaining([
        "ACKNOWLEDGEMENT_MISMATCH",
        "REJECTION_MISMATCH",
        "OUTCOME_NOT_REPRODUCED",
      ]),
    );
    expect(v.capabilityConfirmed).toBe(false);
    // An extra file is refused.
    writeFileSync(path.join(dir, "extra.json"), "{}");
    expect(verifySubscriptionCapabilityEvidence(dir).integrity.problems).toContain(
      "UNLISTED:extra.json",
    );
  });
});
