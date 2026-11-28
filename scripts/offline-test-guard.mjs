/**
 * Offline guard for isolated test runs. Installed before a suite runs, it refuses:
 *   - fetch to any non-loopback host;
 *   - raw TCP/IPC connections other than loopback or local IPC, and TLS to non-loopback hosts;
 *   - reads of real credential files (.env and .env.* except .env.example) outside the temporary
 *     directories where tests write synthetic fixtures.
 * Every refusal is recorded so the owning test can fail explicitly even when the code under test
 * swallows the error. Only loopback traffic is allowed; nothing is proxied or retried.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const isInside = (file, dir) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export function isLoopbackHost(host) {
  return typeof host === "string" && LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** A real credential file: `.env` or `.env.*` (not `.env.example`) outside the synthetic roots. */
export function isCredentialFile(file, syntheticRoots) {
  if (typeof file !== "string" && !(file instanceof URL)) return false;
  const resolved = path.resolve(file instanceof URL ? fileURLToPath(file) : file);
  const base = path.basename(resolved);
  if (!/^\.env(\..+)?$/.test(base) || base === ".env.example") return false;
  return !syntheticRoots.some((root) => isInside(resolved, root));
}

export function installOfflineGuard(options = {}) {
  const syntheticRoots = (options.syntheticRoots ?? [os.tmpdir()]).map((r) => path.resolve(r));
  const refusals = [];
  const refuse = (kind, detail, ErrorType = Error) => {
    refusals.push(`${kind}:${detail}`);
    return new ErrorType(`OFFLINE_GUARD_REFUSED ${kind} ${detail}`);
  };
  const saved = {
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

  globalThis.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host = "";
    try {
      host = new URL(href).hostname;
    } catch {
      host = "";
    }
    if (isLoopbackHost(host) || isLoopbackHost(`[${host}]`)) return saved.fetch(input, init);
    throw refuse("fetch", href, TypeError);
  };

  net.Socket.prototype.connect = function guardedConnect(...args) {
    // net.connect()/createConnection() pass one normalized array: [options, callback].
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host = "localhost";
    if (first !== null && typeof first === "object") {
      if (typeof first.path === "string") return saved.connect.apply(this, args); // local IPC
      host = first.host ?? "localhost";
    } else if (typeof first === "string" && !/^\d+$/.test(first)) {
      return saved.connect.apply(this, args); // local IPC path
    } else if (typeof args[1] === "string") {
      host = args[1];
    }
    if (isLoopbackHost(host)) return saved.connect.apply(this, args);
    throw refuse("socket", `${host}:${typeof first === "object" ? first?.port : first}`);
  };

  tls.connect = (...args) => {
    const first = args[0];
    const host =
      first !== null && typeof first === "object"
        ? (first.host ?? first.servername ?? "localhost")
        : typeof args[1] === "string"
          ? args[1]
          : "localhost";
    if (isLoopbackHost(host)) return saved.tlsConnect(...args);
    throw refuse("tls", String(host));
  };

  const guardPath =
    (name, original) =>
    (file, ...rest) => {
      if (isCredentialFile(file, syntheticRoots)) throw refuse("credential-file", String(file));
      return original(file, ...rest);
    };
  process.loadEnvFile = guardPath("loadEnvFile", saved.loadEnvFile.bind(process));
  fs.readFileSync = guardPath("readFileSync", saved.readFileSync);
  fs.readFile = guardPath("readFile", saved.readFile);
  fs.openSync = guardPath("openSync", saved.openSync);
  fs.open = guardPath("open", saved.open);
  fs.createReadStream = guardPath("createReadStream", saved.createReadStream);
  const guardPromise =
    (name, original) =>
    async (file, ...rest) =>
      guardPath(name, original)(file, ...rest);
  fs.promises.readFile = guardPromise("promises.readFile", saved.promisesReadFile);
  fs.promises.open = guardPromise("promises.open", saved.promisesOpen);
  syncBuiltinESMExports();

  return {
    refusals,
    /** Returns and clears the refusals recorded since the last call. */
    takeRefusals: () => refusals.splice(0),
    restore() {
      globalThis.fetch = saved.fetch;
      net.Socket.prototype.connect = saved.connect;
      tls.connect = saved.tlsConnect;
      process.loadEnvFile = saved.loadEnvFile;
      fs.readFileSync = saved.readFileSync;
      fs.readFile = saved.readFile;
      fs.openSync = saved.openSync;
      fs.open = saved.open;
      fs.createReadStream = saved.createReadStream;
      fs.promises.readFile = saved.promisesReadFile;
      fs.promises.open = saved.promisesOpen;
      syncBuiltinESMExports();
    },
  };
}
