/**
 * Vitest setup for explicit offline selections: installs the offline guard before any test file
 * loads and fails the test in which a refused request or credential-file read occurred, even if
 * the code under test swallowed the error.
 */
import { afterEach } from "vitest";
import { installOfflineGuard } from "./offline-test-guard.mjs";

const guard = installOfflineGuard();

afterEach(() => {
  const refused = guard.takeRefusals();
  if (refused.length > 0) throw new Error(`OFFLINE_GUARD_REFUSED: ${refused.join(", ")}`);
});
