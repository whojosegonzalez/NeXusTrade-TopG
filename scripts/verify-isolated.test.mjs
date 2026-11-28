import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerification, verificationPlan } from "./verify-isolated.mjs";

test("isolated plan contains exactly the audited suites and no operational command", () => {
  const plan = verificationPlan("tests");
  const vitest = plan.filter((step) => step.args[0].includes("vitest.mjs"));
  assert.deepEqual(
    vitest.map((step) => step.args.at(-1)),
    [
      "backend/vitest.measurement-analysis.config.ts",
      "backend/vitest.h2.config.ts",
      "backend/vitest.h3.config.ts",
      "backend/vitest.h4.config.ts",
      "scripts/vitest.handoff-watch.config.ts",
    ],
  );
  assert.ok(vitest.every((step) => step.args.slice(1, 3).join(" ") === "run --config"));
  assert.ok(
    plan.every(
      (step) => !step.args.some((arg) => /collect|migrate|reset|terminal|smoke/.test(arg)),
    ),
  );
});
test("the handoff/watch suite is an explicit offline selection with env-file loading disabled", async () => {
  const { default: config } = await import("./vitest.handoff-watch.config.ts");
  assert.equal(config.envDir, false);
  assert.deepEqual(config.test.include, [
    "src/scripts/paper-pilot-handoff.test.ts",
    "src/scripts/fresh-amm-v4-watch.test.ts",
  ]);
  assert.ok(config.test.include.every((p) => !/[*?{}[\]]/.test(p)));
  assert.equal(config.test.watch, false);
  assert.match(config.root.replaceAll("\\", "/"), /\/backend\/$/);
  const typecheck = verificationPlan("static").find((step) =>
    step.args.includes("backend/vitest.h4.config.ts"),
  );
  assert.ok(typecheck?.args.includes("scripts/vitest.handoff-watch.config.ts"));
});
test("first child failure stops subsequent commands with nonzero status", () => {
  let count = 0;
  assert.equal(
    runVerification(
      "all",
      (_command, _args, options) => {
        count++;
        assert.equal(options.shell, false);
        assert.match(options.env.TEMP, /isolated$/);
        return { status: 7 };
      },
      () => undefined,
    ),
    7,
  );
  assert.equal(count, 1);
});
test("spawn errors and signals fail closed", () => {
  assert.equal(
    runVerification(
      "tests",
      () => ({ error: new Error("synthetic") }),
      () => undefined,
    ),
    1,
  );
  assert.equal(
    runVerification(
      "tests",
      () => ({ signal: "SIGTERM", status: null }),
      () => undefined,
    ),
    1,
  );
});
test("invalid modes fail before execution", () => {
  assert.throws(() => verificationPlan("unsafe"), /INVALID_MODE/);
});
