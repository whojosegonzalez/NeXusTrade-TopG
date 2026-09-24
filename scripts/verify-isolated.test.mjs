import { test } from "node:test";
import assert from "node:assert/strict";
import { runVerification, verificationPlan } from "./verify-isolated.mjs";

test("isolated plan contains exactly the four audited suites and no operational command", () => {
  const plan = verificationPlan("tests");
  const vitest = plan.filter((step) => step.args[0].includes("vitest.mjs"));
  assert.deepEqual(
    vitest.map((step) => step.args.at(-1)),
    [
      "backend/vitest.measurement-analysis.config.ts",
      "backend/vitest.h2.config.ts",
      "backend/vitest.h3.config.ts",
      "backend/vitest.h4.config.ts",
    ],
  );
  assert.ok(
    plan.every(
      (step) => !step.args.some((arg) => /collect|migrate|reset|terminal|smoke/.test(arg)),
    ),
  );
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
