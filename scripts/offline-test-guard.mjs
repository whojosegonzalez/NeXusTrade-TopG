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

const IS_WINDOWS = process.platform === "win32";
// Captured at load: realpath only stats a path (never reads content) and is not itself guarded.
const realpathNative = fs.realpathSync.native;

// path.relative compares case-insensitively on Windows, matching its file system.
const isInside = (file, dir) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Loopback only: localhost, 127.0.0.0/8, ::1, and IPv4-mapped 127.0.0.0/8 (brackets allowed). */
export function isLoopbackHost(host) {
  if (typeof host !== "string" || host === "") return false;
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("::ffff:")) h = h.slice("::ffff:".length);
  return net.isIPv4(h) && h.startsWith("127.");
}

/**
 * The path named by a supported fs path argument (string, Buffer/Uint8Array, file: URL), or null
 * for anything that is not a path (file descriptors, FileHandles, other values).
 */
export function pathArgument(file) {
  if (typeof file === "string") return file;
  if (file instanceof Uint8Array) return Buffer.from(file).toString("utf8");
  if (file instanceof URL) {
    if (file.protocol !== "file:") return null;
    try {
      return fileURLToPath(file);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The name a file system would open, compared case-insensitively on every platform (conservative
 * on case-sensitive systems). Windows also ignores trailing dots and spaces and addresses the same
 * file through a `:stream` suffix such as `::$DATA`.
 */
function openedName(resolved) {
  let base = path.basename(resolved);
  if (IS_WINDOWS) {
    const colon = base.indexOf(":");
    if (colon !== -1) base = base.slice(0, colon);
    base = base.replace(/[. ]+$/, "");
  }
  return base.toLowerCase();
}

const isCredentialName = (name) => /^\.env(\..+)?$/.test(name) && name !== ".env.example";

/**
 * A real credential file: `.env` or `.env.*` (not `.env.example`), by any supported path form or
 * Windows alias, outside the synthetic roots. Existing paths are also checked after resolving
 * symlinks, so a link inside a synthetic root cannot alias a real credential file.
 */
export function isCredentialFile(file, syntheticRoots) {
  const p = pathArgument(file);
  if (p === null) return false;
  const candidates = [path.resolve(p)];
  try {
    candidates.push(realpathNative(candidates[0]));
  } catch {
    // Missing or inaccessible: the lexical path alone decides.
  }
  return candidates.some(
    (c) => isCredentialName(openedName(c)) && !syntheticRoots.some((root) => isInside(c, root)),
  );
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
    if (isLoopbackHost(host)) return saved.fetch(input, init);
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
    // tls.connect(options), tls.connect(port[, host][, options]) or tls.connect(path[, options]).
    const first = args[0];
    if (first !== null && typeof first === "object" && typeof first.path === "string") {
      return saved.tlsConnect(...args); // local IPC
    }
    if (typeof first === "string" && !/^\d+$/.test(first)) return saved.tlsConnect(...args);
    const options =
      first !== null && typeof first === "object"
        ? first
        : args.find((a, i) => i > 0 && a !== null && typeof a === "object");
    const host =
      typeof args[1] === "string" && (typeof first === "number" || /^\d+$/.test(String(first)))
        ? args[1]
        : (options?.host ?? "localhost");
    if (isLoopbackHost(host)) return saved.tlsConnect(...args);
    throw refuse("tls", String(host));
  };

  const guardPath =
    (name, original) =>
    (file, ...rest) => {
      if (isCredentialFile(file, syntheticRoots)) {
        throw refuse("credential-file", String(pathArgument(file)));
      }
      return original(file, ...rest);
    };
  // process.loadEnvFile() and process.loadEnvFile(undefined) read the native default ./.env.
  process.loadEnvFile = (file, ...rest) => {
    const target = file === undefined ? path.resolve(process.cwd(), ".env") : file;
    if (isCredentialFile(target, syntheticRoots)) {
      throw refuse("credential-file", String(pathArgument(target)));
    }
    return saved.loadEnvFile.call(process, file, ...rest);
  };
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
