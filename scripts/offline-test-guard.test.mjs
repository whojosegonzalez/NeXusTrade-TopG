import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { installOfflineGuard, isCredentialFile, isLoopbackHost } from "./offline-test-guard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Never an existing file: a credential-shaped path outside every synthetic root.
const forbiddenEnv = path.join(repoRoot, ".tmp", "offline-guard-nonexistent", ".env");

test("credential-file classification: real .env paths outside synthetic roots only", () => {
  const roots = [os.tmpdir()];
  assert.equal(isCredentialFile(path.join(repoRoot, ".env"), roots), true);
  assert.equal(isCredentialFile(path.join(repoRoot, "..", ".env"), roots), true);
  assert.equal(isCredentialFile(path.join(repoRoot, ".env.local"), roots), true);
  assert.equal(isCredentialFile(path.join(repoRoot, ".env.example"), roots), false);
  assert.equal(isCredentialFile(path.join(repoRoot, "package.json"), roots), false);
  assert.equal(isCredentialFile(path.join(os.tmpdir(), "fixture", ".env"), roots), false);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("api.mainnet-beta.solana.com"), false);
});

test("refuses external fetch, sockets, TLS and real credential reads; allows loopback and synthetic files", async () => {
  const server = http.createServer((_req, res) => res.end("loopback-ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const guard = installOfflineGuard();
  try {
    // External requests are refused before any connection or DNS lookup.
    await assert.rejects(
      fetch("https://api.mainnet-beta.solana.com/"),
      /OFFLINE_GUARD_REFUSED fetch/,
    );
    assert.throws(
      () => net.connect({ host: "203.0.113.1", port: 9 }),
      /OFFLINE_GUARD_REFUSED socket/,
    );
    assert.throws(
      () => tls.connect({ host: "203.0.113.1", port: 443 }),
      /OFFLINE_GUARD_REFUSED tls/,
    );
    // Loopback traffic is allowed.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await res.text(), "loopback-ok");
    // Real credential files are refused through every read path, including ESM named imports.
    assert.throws(() => process.loadEnvFile(forbiddenEnv), /credential-file/);
    assert.throws(() => fs.readFileSync(forbiddenEnv), /credential-file/);
    assert.throws(() => readFileSync(forbiddenEnv), /credential-file/);
    assert.throws(() => fs.openSync(forbiddenEnv, "r"), /credential-file/);
    assert.throws(() => fs.createReadStream(forbiddenEnv), /credential-file/);
    await assert.rejects(fs.promises.readFile(forbiddenEnv), /credential-file/);
    // Synthetic fixtures under the temporary root stay readable.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-guard-"));
    try {
      const synthetic = path.join(dir, ".env");
      fs.writeFileSync(synthetic, "SYNTHETIC_ONLY=1\n");
      assert.equal(fs.readFileSync(synthetic, "utf8"), "SYNTHETIC_ONLY=1\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(
      guard.takeRefusals().map((r) => r.split(":")[0]),
      ["fetch", "socket", "tls", ...Array(6).fill("credential-file")],
    );
    assert.deepEqual(guard.takeRefusals(), []);
  } finally {
    guard.restore();
    await new Promise((resolve) => server.close(resolve));
  }
  // Restored: the guard no longer intercepts.
  assert.equal(isCredentialFile(forbiddenEnv, [os.tmpdir()]), true);
  assert.throws(() => fs.readFileSync(forbiddenEnv), { code: "ENOENT" });
});
