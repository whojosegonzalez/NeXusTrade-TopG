import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installOfflineGuard, isCredentialFile, isLoopbackHost } from "./offline-test-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoEnv = path.join(repoRoot, ".env");
// A directory that never exists outside the synthetic roots: only the name rules can decide here.
const absentDir = path.join(repoRoot, ".tmp", "offline-guard-absent-dir");

/**
 * Runs `fn` with every function the guard wraps replaced by an INERT recorder before the guard is
 * installed, so the guard saves and delegates to recorders. A guard defect can then only reach a
 * recorder: no credential file is read and no connection or DNS lookup is attempted.
 */
async function withInertOriginals(fn) {
  const calls = [];
  const inert =
    (name, result) =>
    (...args) => {
      calls.push({ name, args });
      return typeof result === "function" ? result() : result;
    };
  const real = {
    fetch: globalThis.fetch,
    connect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    loadEnvFile: process.loadEnvFile,
    readFileSync: fs.readFileSync,
    readFile: fs.readFile,
    openSync: fs.openSync,
    open: fs.open,
    createReadStream: fs.createReadStream,
    promisesReadFile: fs.promises.readFile,
    promisesOpen: fs.promises.open,
  };
  globalThis.fetch = inert("fetch", () => Promise.resolve(new Response("inert")));
  net.Socket.prototype.connect = function inertConnect(...args) {
    calls.push({ name: "connect", args });
    return this;
  };
  tls.connect = inert("tlsConnect", null);
  process.loadEnvFile = inert("loadEnvFile", undefined);
  fs.readFileSync = inert("readFileSync", "INERT");
  fs.readFile = inert("readFile", undefined);
  fs.openSync = inert("openSync", -1);
  fs.open = inert("open", undefined);
  fs.createReadStream = inert("createReadStream", null);
  fs.promises.readFile = inert("promises.readFile", () => Promise.resolve("INERT"));
  fs.promises.open = inert("promises.open", () => Promise.resolve(null));
  syncBuiltinESMExports();
  let guard;
  try {
    guard = installOfflineGuard();
    await fn({ calls, guard });
  } finally {
    guard?.restore();
    globalThis.fetch = real.fetch;
    net.Socket.prototype.connect = real.connect;
    tls.connect = real.tlsConnect;
    process.loadEnvFile = real.loadEnvFile;
    fs.readFileSync = real.readFileSync;
    fs.readFile = real.readFile;
    fs.openSync = real.openSync;
    fs.open = real.open;
    fs.createReadStream = real.createReadStream;
    fs.promises.readFile = real.promisesReadFile;
    fs.promises.open = real.promisesOpen;
    syncBuiltinESMExports();
  }
}

/** Calls `op` and expects a guard refusal with no call reaching the inert original. */
async function expectRefused(calls, label, op, kind = "credential-file") {
  const before = calls.length;
  await assert.rejects(
    async () => op(),
    (err) => err instanceof Error && err.message.includes(`OFFLINE_GUARD_REFUSED ${kind}`),
    label,
  );
  assert.deepEqual(calls.slice(before), [], `${label}: reached the saved implementation`);
}

/** Calls `op` and expects it to reach the inert original exactly once. */
async function expectAllowed(calls, label, op, name) {
  const before = calls.length;
  await op();
  assert.deepEqual(
    calls.slice(before).map((c) => c.name),
    [name],
    `${label}: should reach ${name}`,
  );
}

test("credential-file classification covers Buffer, URL, case and Windows aliases", () => {
  const roots = [os.tmpdir()];
  for (const p of [
    repoEnv,
    Buffer.from(repoEnv),
    pathToFileURL(repoEnv),
    path.join(absentDir, ".ENV"),
    path.join(absentDir, ".Env.Local"),
    path.join(absentDir, ".env.local"),
    Buffer.from(path.join(absentDir, ".ENV")),
    path.join(repoRoot, "..", ".env"),
  ]) {
    assert.equal(isCredentialFile(p, roots), true, String(p));
  }
  if (process.platform === "win32") {
    // Windows opens these as the same file: trailing dots/spaces and the default data stream.
    for (const alias of [".env.", ".env ", ".env::$DATA", ".ENV.:$DATA", ".env.local:stream"]) {
      assert.equal(isCredentialFile(path.join(absentDir, alias), roots), true, alias);
    }
  }
  for (const p of [
    path.join(repoRoot, ".env.example"),
    path.join(repoRoot, ".ENV.EXAMPLE"),
    path.join(repoRoot, "package.json"),
    path.join(os.tmpdir(), "fixture", ".env"),
    path.join(os.tmpdir(), "fixture", ".ENV"),
    // Windows paths are case-insensitive, so a differently cased temporary root is the same root.
    ...(process.platform === "win32"
      ? [path.join(os.tmpdir().toUpperCase(), "fixture", ".env")]
      : []),
    Buffer.from(path.join(os.tmpdir(), "fixture", ".env")),
    3, // a file descriptor is not a path
  ]) {
    assert.equal(isCredentialFile(p, roots), false, String(p));
  }
  for (const host of [
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.8.9.10",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["203.0.113.1", "example.com", "128.0.0.1", "::ffff:203.0.113.1", ""]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test("a link inside a synthetic root cannot alias a credential file outside it", (t) => {
  // Synthetic target only: a credential-shaped file outside the temporary root, never a real one.
  const outside = path.join(repoRoot, ".tmp", `offline-guard-link-target-${process.pid}`);
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "offline-guard-link-"));
  const link = path.join(linkParent, "linked");
  try {
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, ".env"), "SYNTHETIC_ONLY=1\n");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch (err) {
      t.skip(`cannot create a directory link here (${err.code})`);
      return;
    }
    assert.equal(isCredentialFile(path.join(link, ".env"), [os.tmpdir()]), true);
    assert.equal(isCredentialFile(path.join(linkParent, "plain", ".env"), [os.tmpdir()]), false);
  } finally {
    fs.rmSync(linkParent, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("credential reads are refused for every path form before reaching the saved implementation", async () => {
  const cwd = process.cwd();
  process.chdir(repoRoot); // loadEnvFile's native default is ./.env
  try {
    await withInertOriginals(async ({ calls, guard }) => {
      const forms = [
        ["string", repoEnv],
        ["Buffer", Buffer.from(repoEnv)],
        ["URL", pathToFileURL(repoEnv)],
        ["uppercase", path.join(repoRoot, ".ENV")],
        ["mixed-case local", path.join(repoRoot, ".Env.Local")],
      ];
      if (process.platform === "win32") forms.push(["trailing dot", path.join(repoRoot, ".env.")]);
      await expectRefused(calls, "loadEnvFile()", () => process.loadEnvFile());
      await expectRefused(calls, "loadEnvFile(undefined)", () => process.loadEnvFile(undefined));
      for (const [label, p] of forms) {
        await expectRefused(calls, `loadEnvFile ${label}`, () => process.loadEnvFile(p));
        await expectRefused(calls, `readFileSync ${label}`, () => fs.readFileSync(p));
        await expectRefused(calls, `readFile ${label}`, () => fs.readFile(p, () => undefined));
        await expectRefused(calls, `openSync ${label}`, () => fs.openSync(p, "r"));
        await expectRefused(calls, `open ${label}`, () => fs.open(p, "r", () => undefined));
        await expectRefused(calls, `createReadStream ${label}`, () => fs.createReadStream(p));
        await expectRefused(calls, `promises.readFile ${label}`, () => fs.promises.readFile(p));
        await expectRefused(calls, `promises.open ${label}`, () => fs.promises.open(p, "r"));
      }
      // Synthetic fixtures under the temporary root, the example file and ordinary files pass.
      const synthetic = path.join(os.tmpdir(), "offline-guard-fixture", ".env");
      await expectAllowed(calls, "synthetic", () => fs.readFileSync(synthetic), "readFileSync");
      await expectAllowed(
        calls,
        "synthetic Buffer",
        () => fs.readFileSync(Buffer.from(synthetic)),
        "readFileSync",
      );
      await expectAllowed(
        calls,
        "example",
        () => fs.readFileSync(path.join(repoRoot, ".env.example")),
        "readFileSync",
      );
      await expectAllowed(
        calls,
        "loadEnvFile synthetic",
        () => process.loadEnvFile(synthetic),
        "loadEnvFile",
      );
      await expectAllowed(calls, "fd", () => fs.readFileSync(3), "readFileSync");
      assert.ok(guard.takeRefusals().length > 0);
    });
  } finally {
    process.chdir(cwd);
  }
});

test("external network attempts are refused before reaching the saved implementation", async () => {
  await withInertOriginals(async ({ calls, guard }) => {
    for (const url of [
      "https://api.mainnet-beta.solana.com/",
      "http://203.0.113.1:9/",
      new URL("https://example.com/"),
    ]) {
      await expectRefused(calls, `fetch ${url}`, () => fetch(url), "fetch");
    }
    const sock = () => new net.Socket();
    const external = [
      ["normalized array", (s) => s.connect([{ host: "203.0.113.1", port: 9 }, null])],
      ["options", (s) => s.connect({ host: "203.0.113.1", port: 9 })],
      ["port, host", (s) => s.connect(9, "203.0.113.1")],
      ["hostname", (s) => s.connect({ host: "example.com", port: 443 })],
      ["mapped IPv6", (s) => s.connect({ host: "::ffff:203.0.113.1", port: 9 })],
    ];
    for (const [label, op] of external) {
      await expectRefused(calls, `socket ${label}`, () => op(sock()), "socket");
    }
    await expectRefused(
      calls,
      "net.connect",
      () => net.connect({ host: "203.0.113.1", port: 9 }),
      "socket",
    );
    await expectRefused(
      calls,
      "tls.connect",
      () => tls.connect({ host: "203.0.113.1", port: 443 }),
      "tls",
    );
    await expectRefused(
      calls,
      "tls.connect port, host",
      () => tls.connect(443, "example.com"),
      "tls",
    );
    // Loopback and local IPC forms reach the (inert) saved implementation.
    await expectAllowed(calls, "fetch loopback", () => fetch("http://127.0.0.1:1/"), "fetch");
    for (const [label, op] of [
      ["array loopback", (s) => s.connect([{ host: "127.0.0.1", port: 1 }, null])],
      ["options loopback", (s) => s.connect({ host: "localhost", port: 1 })],
      ["default host", (s) => s.connect({ port: 1 })],
      ["port only", (s) => s.connect(1)],
      ["port, host loopback", (s) => s.connect(1, "::1")],
      ["ipc", (s) => s.connect({ path: "\\\\.\\pipe\\offline-guard-inert" })],
    ]) {
      await expectAllowed(calls, label, () => op(sock()), "connect");
    }
    await expectAllowed(
      calls,
      "tls loopback",
      () => tls.connect({ host: "127.0.0.1", port: 1 }),
      "tlsConnect",
    );
    assert.ok(guard.takeRefusals().length > 0);
  });
});

test("real loopback traffic passes through the installed guard (positive control)", async () => {
  const server = http.createServer((_req, res) => res.end("loopback-ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const guard = installOfflineGuard();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await res.text(), "loopback-ok");
    const body = await new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/" }, (r) => {
          let data = "";
          r.on("data", (c) => (data += c));
          r.on("end", () => resolve(data));
        })
        .on("error", reject);
    });
    assert.equal(body, "loopback-ok");
    assert.deepEqual(guard.takeRefusals(), []);
  } finally {
    guard.restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("restore reinstates exactly the previous implementations", () => {
  const before = [
    globalThis.fetch,
    net.Socket.prototype.connect,
    tls.connect,
    process.loadEnvFile,
    fs.readFileSync,
    fs.promises.readFile,
  ];
  const guard = installOfflineGuard();
  assert.notEqual(fs.readFileSync, before[4]);
  guard.restore();
  assert.deepEqual(
    [
      globalThis.fetch,
      net.Socket.prototype.connect,
      tls.connect,
      process.loadEnvFile,
      fs.readFileSync,
      fs.promises.readFile,
    ],
    before,
  );
});
