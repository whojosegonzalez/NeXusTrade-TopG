import { spawn } from "node:child_process";
import fs from "node:fs";

const outStream = fs.createWriteStream("audit/verify-isolated-all.log", { encoding: "utf8" });
const child = spawn(process.execPath, ["scripts/verify-isolated.mjs", "all"], {
  stdio: ["inherit", "pipe", "pipe"],
  env: process.env,
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  outStream.write(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  outStream.write(chunk);
});

child.on("close", (code) => {
  outStream.end(() => {
    console.log(`\n[Runner] Complete. Exit code: ${code}`);
    process.exit(code ?? 0);
  });
});
