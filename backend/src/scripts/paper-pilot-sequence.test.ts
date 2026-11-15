/**
 * Wrapper orchestration (offline): `Invoke-PilotSequence` from scripts/paper-pilot-sequence.core.ps1
 * runs in Windows PowerShell 5.1 against STUBBED hooks only. Every child (pin check, dry runs,
 * discovery, handoffs, Stage B, verifications), the wait, the wallet hash and path checks are
 * scripted per scenario, so no real watch, precheck, handoff or Stage B path is ever launched.
 * The driver is passed as an encoded command (no script file is executed) and loads the core from
 * its text.
 * The entry script is only parsed (its parameter sets), never run.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const CORE = fileURLToPath(
  new URL("../../../scripts/paper-pilot-sequence.core.ps1", import.meta.url),
);
const ENTRY = fileURLToPath(new URL("../../../scripts/paper-pilot-sequence.ps1", import.meta.url));

const PINNED = "a".repeat(40);
const WATCH_DIR = "data/research/prechecks/watch-run-01";
const PRECHECK_DIR = "data/research/prechecks/precheck-run-01";
const PILOT = "data/research/single-candidate/pilot-01";
const WALLET = "7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9";
const POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const OTHER = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const MANIFEST = "b".repeat(64);
const SCRIPTS = {
  Handoff: "backend/src/scripts/paper-pilot-handoff.ts",
  Precheck: "backend/src/scripts/fresh-amm-v4-precheck.ts",
  Watch: "backend/src/scripts/fresh-amm-v4-watch.ts",
  Runner: "backend/src/scripts/paper-single-candidate-diagnostic.ts",
};

type Step =
  | "PIN"
  | "DISCOVERY_DRY_RUN"
  | "DISCOVERY_LIVE"
  | "HANDOFF_FIRST"
  | "STAGE_B_DRY_RUN"
  | "HANDOFF_FINAL"
  | "STAGE_B_LIVE"
  | "STAGE_B_VERIFY"
  | "WATCH_VERIFY";
type ChildAnswer = { code: number; output: string } | { stop: true } | { none: true };

interface Scenario {
  name: string;
  mode?: "WATCH" | "PRECHECK";
  execute?: boolean;
  existing?: string[];
  wallet?: string[];
  children?: Partial<Record<Step, ChildAnswer>>;
  waitStops?: boolean;
  cancelAfter?: string;
}

interface Outcome {
  name: string;
  result: {
    Outcome: string;
    Failure: string | null;
    CheckFailures: string[];
    PoolId: string | null;
    MintAddress: string | null;
    ManifestSha256: string | null;
    Steps: string[];
  };
  calls: { step: string; args: string[] }[];
  waits: number[];
  logs: string[];
}

// ---------------------------------------------------------------------------------------------
// Scripted child answers
// ---------------------------------------------------------------------------------------------

const ok = (output = "SYNTHETIC ok"): ChildAnswer => ({ code: 0, output });
const exit = (code: number, output = "SYNTHETIC"): ChildAnswer => ({ code, output });
const pinOk: ChildAnswer = ok(JSON.stringify({ decision: "PIN_OK", refusals: [] }));
const decision = (
  d: Record<string, unknown>,
  o: { mode?: "WATCH" | "PRECHECK"; code?: number } = {},
): ChildAnswer => {
  const base: Record<string, unknown> = {
    refusals: [],
    poolId: POOL,
    mintAddress: MINT,
    pilotOutDir: PILOT,
    ageSecNow: 300,
    ageSource: "DEXSCREENER_PAIR_CREATED_AT",
    evaluatedAtIso: "2026-11-15T00:00:00.000Z",
    ...((o.mode ?? "WATCH") === "WATCH"
      ? { evidenceSource: "WATCH_EVIDENCE", manifestSha256: MANIFEST }
      : {}),
  };
  const merged = { ...base, ...d };
  const code = o.code ?? (merged.decision === "ALLOWED" ? 0 : merged.decision === "WAIT" ? 2 : 1);
  return { code, output: JSON.stringify(merged) };
};
const allowed = (d: Record<string, unknown> = {}, mode: "WATCH" | "PRECHECK" = "WATCH") =>
  decision({ decision: "ALLOWED", ...d }, { mode });
const wait = (waitMs: number) =>
  decision({ decision: "WAIT", refusals: ["START_WINDOW_NOT_YET_OPEN"], waitMs });
const refused = (refusal: string) =>
  ({
    code: 1,
    output: JSON.stringify({ decision: "REFUSED", refusals: [refusal], evaluatedAtIso: "x" }),
  }) as ChildAnswer;

const happy = (mode: "WATCH" | "PRECHECK" = "WATCH"): Partial<Record<Step, ChildAnswer>> => ({
  PIN: pinOk,
  DISCOVERY_DRY_RUN: ok("[DRY_RUN] plan"),
  DISCOVERY_LIVE: ok("[LIVE] sealed"),
  HANDOFF_FIRST: allowed({}, mode),
  STAGE_B_DRY_RUN: ok("[DRY_RUN] runner plan"),
  HANDOFF_FINAL: allowed({}, mode),
  STAGE_B_LIVE: ok("[LIVE] runner"),
  STAGE_B_VERIFY: ok("[VERIFY] ok"),
  WATCH_VERIFY: ok("[VERIFY] Integrity: OK"),
});
const withChildren = (over: Partial<Record<Step, ChildAnswer>>, mode?: "WATCH" | "PRECHECK") => ({
  ...happy(mode),
  ...over,
});

// ---------------------------------------------------------------------------------------------
// The PowerShell driver (stubs only)
// ---------------------------------------------------------------------------------------------

const DRIVER = String.raw`
$ErrorActionPreference = 'Stop'
. ([scriptblock]::Create([IO.File]::ReadAllText($env:PILOT_CORE)))
$scenarios = [IO.File]::ReadAllText($env:PILOT_SCENARIOS) | ConvertFrom-Json
$out = New-Object System.Collections.ArrayList
foreach ($sc in $scenarios) {
  $calls = New-Object System.Collections.ArrayList
  $waits = New-Object System.Collections.ArrayList
  $logs = New-Object System.Collections.ArrayList
  $walletIndex = @{ i = 0 }
  $prop = { param($o, $n) $p = $o.PSObject.Properties[$n]; if ($null -eq $p) { $null } else { $p.Value } }
  $hooks = @{
    RunChild = {
      param($Step, [string[]]$Arguments)
      [void]$calls.Add(@{ step = $Step; args = @($Arguments) })
      $a = & $prop $sc.children $Step
      if ($null -eq $a) { return @{ Code = 99; Output = 'UNSCRIPTED' } }
      if ($null -ne (& $prop $a 'stop')) { throw (New-Object System.OperationCanceledException "SYNTHETIC operator cancellation") }
      if ($null -ne (& $prop $a 'none')) { return $null }
      return @{ Code = [int]$a.code; Output = [string]$a.output }
    }
    Wait = {
      param([long]$Ms)
      [void]$waits.Add($Ms)
      if ($sc.waitStops) { throw (New-Object System.OperationCanceledException "SYNTHETIC operator cancellation") }
    }
    WalletHash = {
      $w = @($sc.wallet)
      $v = $w[[Math]::Min($walletIndex.i, $w.Count - 1)]
      $walletIndex.i++
      return $v
    }
    PathExists = { param($Path) @($sc.existing) -contains $Path }
    IsCancelled = {
      $after = & $prop $sc 'cancelAfter'
      if ($null -eq $after) { return $false }
      return @($calls | ForEach-Object { $_.step }) -contains $after -or ($after -eq 'WAIT' -and $waits.Count -gt 0)
    }
    Log = { param($Line) [void]$logs.Add([string]$Line) }
  }
  $config = @{
    Mode = $sc.mode; PinnedCommit = $sc.pinned; EvidenceOutDir = $sc.evidence; PilotOutDir = $sc.pilot
    Execute = [bool]$sc.execute; WalletSha256 = $sc.expectedWallet
    Scripts = @{ Handoff = $sc.scripts.Handoff; Precheck = $sc.scripts.Precheck; Watch = $sc.scripts.Watch; Runner = $sc.scripts.Runner }
  }
  try { $r = Invoke-PilotSequence -Config $config -Hooks $hooks } catch { $r = @{ Outcome = 'DRIVER_ERROR'; Failure = ($_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage); CheckFailures = @(); Steps = @() } }
  [void]$out.Add(@{ name = $sc.name; result = $r; calls = @($calls); waits = @($waits); logs = @($logs) })
}
# The entry script's parameters (parsed only; never run).
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PILOT_ENTRY, [ref]$tokens, [ref]$errors)
$params = @($ast.ParamBlock.Parameters | ForEach-Object {
  $p = $_
  $attrs = @($p.Attributes | Where-Object { $_.TypeName.Name -eq 'Parameter' })
  @{
    name = $p.Name.VariablePath.UserPath
    sets = @($attrs | ForEach-Object { @($_.NamedArguments | Where-Object { $_.ArgumentName -eq 'ParameterSetName' } | ForEach-Object { $_.Argument.Value }) })
    mandatory = @($attrs | ForEach-Object { @($_.NamedArguments | Where-Object { $_.ArgumentName -eq 'Mandatory' }) }).Count -gt 0
  }
})
$coreErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($env:PILOT_CORE, [ref]$tokens, [ref]$coreErrors)
$report = @{
  scenarios = @($out); entryParseErrors = @($errors).Count; coreParseErrors = @($coreErrors).Count
  entryParams = $params; defaultSet = [string]($ast.ParamBlock.Attributes | Where-Object { $_.TypeName.Name -eq 'CmdletBinding' } | ForEach-Object { $_.NamedArguments | Where-Object { $_.ArgumentName -eq 'DefaultParameterSetName' } | ForEach-Object { $_.Argument.Value } })
}
Write-Output ('PILOT_SEQUENCE_TEST_REPORT ' + ($report | ConvertTo-Json -Depth 10 -Compress))
`;

/**
 * A genuine PowerShell pipeline stop: a real `PipelineStoppedException` thrown from a stubbed hook,
 * so catch blocks are skipped and only finally blocks run (as when Ctrl+C stops the wrapper). It
 * does not deliver a console Ctrl+C to any native child. Configured through the environment:
 * where to stop, the discovery exit code, the final wallet hash and the watch verification code.
 */
const STOP_DRIVER = String.raw`
$ErrorActionPreference = 'Stop'
. ([scriptblock]::Create([IO.File]::ReadAllText($env:PILOT_CORE)))
$calls = New-Object System.Collections.ArrayList
$logs = New-Object System.Collections.ArrayList
$wallet = @{ n = 0 }
$hooks = @{
  RunChild = {
    param($Step, [string[]]$Arguments)
    [void]$calls.Add($Step)
    if ($Step -eq $env:PILOT_STOP_AT) { throw (New-Object System.Management.Automation.PipelineStoppedException) }
    if ($Step -eq 'PIN') { return @{ Code = 0; Output = '{"decision":"PIN_OK","refusals":[]}' } }
    if ($Step -eq 'DISCOVERY_LIVE') { return @{ Code = [int]$env:PILOT_LIVE_CODE; Output = 'SYNTHETIC watch' } }
    if ($Step -eq 'WATCH_VERIFY') { return @{ Code = [int]$env:PILOT_WATCH_VERIFY_CODE; Output = 'SYNTHETIC verify' } }
    return @{ Code = 0; Output = 'SYNTHETIC' }
  }
  Wait = { param([long]$Ms) [void]$calls.Add('WAIT') }
  WalletHash = {
    [void]$calls.Add('WALLET')
    $wallet.n++
    if ($wallet.n -eq 1) { 'W' } else { $env:PILOT_FINAL_WALLET }
  }
  PathExists = { param($Path) $false }
  IsCancelled = { $false }
  Log = { param($Line) [void]$logs.Add([string]$Line) }
}
$config = @{
  Mode = 'WATCH'; PinnedCommit = ('a' * 40); EvidenceOutDir = 'data/research/prechecks/w'
  PilotOutDir = 'data/research/single-candidate/p'; Execute = $true; WalletSha256 = 'W'
  Scripts = @{ Handoff = 'h.ts'; Precheck = 'p.ts'; Watch = 'w.ts'; Runner = 'r.ts' }
}
try {
  $r = Invoke-PilotSequence -Config $config -Hooks $hooks
  [IO.File]::WriteAllText($env:PILOT_REPORT, 'RETURNED' + [char]10)
} finally {
  [IO.File]::AppendAllText($env:PILOT_REPORT, ('CALLS ' + ($calls -join ',')) + [char]10 + ($logs -join [char]10))
}
`;

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const MALFORMED: [string, ChildAnswer][] = [
  [
    "two lines",
    {
      code: 0,
      output: `${(allowed() as { output: string }).output}\n${(allowed() as { output: string }).output}`,
    },
  ],
  [
    "noise before JSON",
    { code: 0, output: `SYNTHETIC noise\n${(allowed() as { output: string }).output}` },
  ],
  ["not JSON", { code: 0, output: "ALLOWED pool " + POOL }],
  ["JSON array", { code: 0, output: "[1]" }],
  ["ALLOWED with exit 2", decision({ decision: "ALLOWED" }, { code: 2 })],
  [
    "REFUSED with exit 0",
    { code: 0, output: JSON.stringify({ decision: "REFUSED", refusals: ["X"] }) },
  ],
  ["unknown decision", { code: 0, output: JSON.stringify({ decision: "MAYBE", refusals: [] }) }],
  ["PIN_OK as a handoff decision", pinOk],
  ["missing manifest digest", allowed({ manifestSha256: undefined })],
  ["manifest digest not hex", allowed({ manifestSha256: "Z".repeat(64) })],
  ["wrong evidence source", allowed({ evidenceSource: "PRECHECK" })],
  ["other pilot directory", allowed({ pilotOutDir: "data/research/single-candidate/other" })],
  ["pool equals mint", allowed({ poolId: MINT })],
  ["pool not base58", allowed({ poolId: "0OIl" + POOL.slice(4) })],
  ["missing refusals", { code: 0, output: JSON.stringify({ decision: "ALLOWED", poolId: POOL }) }],
  ["ALLOWED with refusals", allowed({ refusals: ["X"] })],
  ["WAIT beyond 240 s", wait(300_000)],
  ["WAIT not an integer", wait(1.5)],
  ["WAIT with a different reason", decision({ decision: "WAIT", refusals: ["X"], waitMs: 1000 })],
];

function scenarios(): Scenario[] {
  const list: Scenario[] = [
    { name: "inert watch", execute: false, children: happy() },
    { name: "inert precheck", mode: "PRECHECK", execute: false, children: happy("PRECHECK") },
    { name: "inert existing evidence", execute: false, existing: [WATCH_DIR], children: happy() },
    { name: "inert existing pilot", execute: false, existing: [PILOT], children: happy() },
    {
      name: "inert dry run fails",
      execute: false,
      children: withChildren({ DISCOVERY_DRY_RUN: exit(1) }),
    },
    { name: "pin refused", children: withChildren({ PIN: refused("RELEVANT_FILES_DIRTY") }) },
    {
      name: "pin malformed",
      children: withChildren({
        PIN: { code: 0, output: JSON.stringify({ decision: "REFUSED", refusals: ["X"] }) },
      }),
    },
    { name: "success", children: happy() },
    { name: "success precheck", mode: "PRECHECK", children: happy("PRECHECK") },
    { name: "wait then allowed", children: withChildren({ HANDOFF_FIRST: wait(120_000) }) },
    { name: "wait at the final check", children: withChildren({ HANDOFF_FINAL: wait(1_000) }) },
    {
      name: "expired at the first check",
      children: withChildren({ HANDOFF_FIRST: refused("START_WINDOW_EXPIRED") }),
    },
    {
      name: "expired at the final check",
      children: withChildren({ HANDOFF_FINAL: refused("START_WINDOW_EXPIRED") }),
    },
    { name: "watch not confirmed (exit 3)", children: withChildren({ DISCOVERY_LIVE: exit(3) }) },
    {
      name: "watch seal failure with failing evidence check",
      children: withChildren({ DISCOVERY_LIVE: exit(5), WATCH_VERIFY: exit(4) }),
    },
    {
      name: "watch child returns nothing",
      children: withChildren({ DISCOVERY_LIVE: { none: true } }),
    },
    { name: "cancel during the watch", children: withChildren({ DISCOVERY_LIVE: { stop: true } }) },
    {
      name: "cancel during the wait",
      waitStops: true,
      children: withChildren({ HANDOFF_FIRST: wait(5_000) }),
    },
    {
      name: "cancel observed after the wait",
      cancelAfter: "WAIT",
      children: withChildren({ HANDOFF_FIRST: wait(5_000) }),
    },
    {
      name: "cancel observed after the first handoff",
      cancelAfter: "HANDOFF_FIRST",
      children: happy(),
    },
    {
      name: "cancel observed after the Stage B dry run",
      cancelAfter: "STAGE_B_DRY_RUN",
      children: happy(),
    },
    {
      name: "cancel during the final handoff",
      children: withChildren({ HANDOFF_FINAL: { stop: true } }),
    },
    {
      name: "cancel observed after the final handoff",
      cancelAfter: "HANDOFF_FINAL",
      children: happy(),
    },
    { name: "cancel during Stage B", children: withChildren({ STAGE_B_LIVE: { stop: true } }) },
    {
      name: "identity changed",
      children: withChildren({ HANDOFF_FINAL: allowed({ poolId: OTHER }) }),
    },
    {
      name: "mint changed",
      children: withChildren({ HANDOFF_FINAL: allowed({ mintAddress: OTHER }) }),
    },
    {
      name: "manifest changed",
      children: withChildren({ HANDOFF_FINAL: allowed({ manifestSha256: "c".repeat(64) }) }),
    },
    {
      name: "precheck decision with watch fields",
      mode: "PRECHECK",
      children: withChildren(
        { HANDOFF_FIRST: allowed({ manifestSha256: MANIFEST }, "WATCH") },
        "PRECHECK",
      ),
    },
    { name: "Stage B dry run fails", children: withChildren({ STAGE_B_DRY_RUN: exit(1) }) },
    {
      name: "Stage B fails",
      children: withChildren({ STAGE_B_LIVE: exit(1), STAGE_B_VERIFY: exit(1) }),
    },
    { name: "final verification fails", children: withChildren({ STAGE_B_VERIFY: exit(1) }) },
    { name: "final wallet changed", wallet: [WALLET, "0".repeat(64)], children: happy() },
    { name: "wallet changed before discovery", wallet: ["0".repeat(64)], children: happy() },
    {
      name: "final checks fail after an earlier failure",
      wallet: [WALLET, "0".repeat(64)],
      children: withChildren({
        HANDOFF_FIRST: refused("START_WINDOW_EXPIRED"),
        WATCH_VERIFY: exit(4),
      }),
    },
  ];
  for (const [label, answer] of MALFORMED) {
    list.push({
      name: `malformed first: ${label}`,
      children: withChildren({ HANDOFF_FIRST: answer }),
    });
    list.push({
      name: `malformed final: ${label}`,
      children: withChildren({ HANDOFF_FINAL: answer }),
    });
  }
  return list;
}

let report: {
  scenarios: Outcome[];
  entryParseErrors: number;
  coreParseErrors: number;
  entryParams: { name: string; sets: string[] | string | null; mandatory: boolean }[];
  defaultSet: string;
};
const byName = new Map<string, Outcome>();

const runOn = process.platform === "win32" ? describe : describe.skip;

runOn("paper pilot sequence wrapper (offline orchestration, stubbed children)", () => {
  beforeAll(async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "pilot-sequence-test-"));
    try {
      const file = path.join(dir, "scenarios.json");
      writeFileSync(
        file,
        JSON.stringify(
          scenarios().map((s) => ({
            name: s.name,
            mode: s.mode ?? "WATCH",
            execute: s.execute ?? true,
            existing: s.existing ?? [],
            wallet: s.wallet ?? [WALLET],
            expectedWallet: WALLET,
            children: s.children ?? {},
            waitStops: s.waitStops ?? false,
            ...(s.cancelAfter ? { cancelAfter: s.cancelAfter } : {}),
            pinned: PINNED,
            evidence: (s.mode ?? "WATCH") === "WATCH" ? WATCH_DIR : PRECHECK_DIR,
            pilot: PILOT,
            scripts: SCRIPTS,
          })),
        ),
      );
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(DRIVER, "utf16le").toString("base64"),
        ],
        {
          encoding: "utf8",
          timeout: 50_000,
          env: { ...process.env, PILOT_CORE: CORE, PILOT_ENTRY: ENTRY, PILOT_SCENARIOS: file },
          windowsHide: true,
        },
      );
      const line = (r.stdout ?? "")
        .split(/\r?\n/)
        .find((l) => l.startsWith("PILOT_SEQUENCE_TEST_REPORT "));
      if (!line)
        throw new Error(`driver failed (exit ${r.status}): ${r.stderr ?? ""}${r.stdout ?? ""}`);
      report = JSON.parse(line.slice("PILOT_SEQUENCE_TEST_REPORT ".length));
      for (const s of report.scenarios) byName.set(s.name, s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 55_000);

  const get = (name: string) => {
    const s = byName.get(name);
    if (!s) throw new Error(`scenario missing: ${name}`);
    return s;
  };
  const steps = (name: string) => get(name).calls.map((c) => c.step);
  const LIVE_AFTER = ["STAGE_B_DRY_RUN", "HANDOFF_FINAL", "STAGE_B_LIVE"];
  const FINAL_CHECKS_WATCH = ["WATCH_VERIFY", "WALLET_AFTER"];

  it("P-01: both scripts parse; the entry has mutually exclusive precheck and watch modes", () => {
    expect(report.entryParseErrors).toBe(0);
    expect(report.coreParseErrors).toBe(0);
    expect(report.defaultSet).toBe("Precheck");
    const p = Object.fromEntries(report.entryParams.map((x) => [x.name, x]));
    expect(Object.keys(p).sort()).toEqual(
      ["Execute", "PilotOutDir", "PinnedCommit", "PrecheckOutDir", "Watch", "WatchOutDir"].sort(),
    );
    expect([p.PrecheckOutDir!.sets].flat()).toEqual(["Precheck"]);
    expect([p.Watch!.sets].flat()).toEqual(["Watch"]);
    expect([p.WatchOutDir!.sets].flat()).toEqual(["Watch"]);
    for (const n of ["PrecheckOutDir", "Watch", "WatchOutDir", "PinnedCommit", "PilotOutDir"]) {
      expect(p[n]!.mandatory, n).toBe(true);
    }
    expect(p.Execute!.mandatory).toBe(false);
  });

  it("P-02: without -Execute only the pin check and the discovery dry run run", () => {
    for (const [name, script, evidence] of [
      ["inert watch", SCRIPTS.Watch, WATCH_DIR],
      ["inert precheck", SCRIPTS.Precheck, PRECHECK_DIR],
    ] as const) {
      const s = get(name);
      expect(s.result.Outcome, name).toBe("INERT");
      expect(s.calls, name).toEqual([
        { step: "PIN", args: [SCRIPTS.Handoff, "--pinned-commit", PINNED, "--pin-only"] },
        { step: "DISCOVERY_DRY_RUN", args: [script, "--out-dir", evidence] },
      ]);
      expect(s.waits, name).toEqual([]);
      expect(s.result.Steps, name).not.toContain("WALLET_AFTER");
    }
    expect(get("inert watch").logs.join("\n")).toContain(
      "watched handoff recheck (same manifest, pool and mint)",
    );
    for (const name of ["inert existing evidence", "inert existing pilot"]) {
      expect(get(name).result.Outcome, name).toBe("STOPPED");
      expect(steps(name), name).toEqual(["PIN"]);
    }
    expect(get("inert dry run fails").result).toMatchObject({ Outcome: "STOPPED" });
    expect(get("pin refused").result.Failure).toContain("pin check");
    expect(steps("pin refused")).toEqual(["PIN"]);
    expect(get("pin malformed").result.Failure).toContain("malformed or inconsistent");
    expect(steps("pin malformed")).toEqual(["PIN"]);
  });

  it("P-03: a confirmed watch is handed off and Stage B runs once with the exact identity", () => {
    const s = get("success");
    expect(s.result).toMatchObject({
      Outcome: "COMPLETE",
      Failure: null,
      CheckFailures: [],
      PoolId: POOL,
      MintAddress: MINT,
      ManifestSha256: MANIFEST,
    });
    const handoff = [
      SCRIPTS.Handoff,
      "--pinned-commit",
      PINNED,
      "--watch-evidence-dir",
      WATCH_DIR,
      "--pilot-out-dir",
      PILOT,
    ];
    expect(s.calls).toEqual([
      { step: "PIN", args: [SCRIPTS.Handoff, "--pinned-commit", PINNED, "--pin-only"] },
      { step: "DISCOVERY_DRY_RUN", args: [SCRIPTS.Watch, "--out-dir", WATCH_DIR] },
      { step: "DISCOVERY_LIVE", args: [SCRIPTS.Watch, "--out-dir", WATCH_DIR, "--live"] },
      { step: "HANDOFF_FIRST", args: handoff },
      {
        step: "STAGE_B_DRY_RUN",
        args: [SCRIPTS.Runner, "--pool", POOL, "--mint", MINT, "--out-dir", PILOT],
      },
      { step: "HANDOFF_FINAL", args: handoff },
      {
        step: "STAGE_B_LIVE",
        args: [SCRIPTS.Runner, "--pool", POOL, "--mint", MINT, "--out-dir", PILOT, "--live"],
      },
      { step: "STAGE_B_VERIFY", args: [SCRIPTS.Runner, "--verify", PILOT] },
      { step: "WATCH_VERIFY", args: [SCRIPTS.Watch, "--verify", WATCH_DIR] },
    ]);
    expect(s.result.Steps.at(-1)).toBe("WALLET_AFTER");
    expect(s.waits).toEqual([]);
    // The precheck mode keeps its reviewed sequence (no watch fields, no watch verification).
    const p = get("success precheck");
    expect(p.result.Outcome).toBe("COMPLETE");
    expect(p.calls.map((c) => c.step)).toEqual([
      "PIN",
      "DISCOVERY_DRY_RUN",
      "DISCOVERY_LIVE",
      "HANDOFF_FIRST",
      "STAGE_B_DRY_RUN",
      "HANDOFF_FINAL",
      "STAGE_B_LIVE",
      "STAGE_B_VERIFY",
    ]);
    expect(p.calls[2]!.args).toEqual([SCRIPTS.Precheck, "--out-dir", PRECHECK_DIR, "--live"]);
    expect(p.calls[3]!.args).toEqual([
      SCRIPTS.Handoff,
      "--pinned-commit",
      PINNED,
      "--precheck-dir",
      PRECHECK_DIR,
      "--pilot-out-dir",
      PILOT,
    ]);
    expect(get("precheck decision with watch fields").result.Failure).toContain(
      "watch fields in a precheck decision",
    );
  });

  it("P-04: one bounded wait at most; a WAIT or refusal at either check ends the sequence", () => {
    const w = get("wait then allowed");
    expect(w.result.Outcome).toBe("COMPLETE");
    expect(w.waits).toEqual([121_000]);
    expect(steps("wait then allowed")).toContain("STAGE_B_LIVE");
    for (const name of ["wait at the final check", "expired at the final check"]) {
      const s = get(name);
      expect(s.result.Outcome, name).toBe("STOPPED");
      expect(steps(name), name).not.toContain("STAGE_B_LIVE");
      expect(s.result.Steps.slice(-2), name).toEqual(FINAL_CHECKS_WATCH);
    }
    expect(get("wait at the final check").waits).toEqual([]);
    const first = get("expired at the first check");
    expect(first.result.Failure).toContain("START_WINDOW_EXPIRED");
    for (const step of LIVE_AFTER) expect(steps("expired at the first check")).not.toContain(step);
  });

  it("P-05: only a confirmed watch continues; there is no fallback and no repetition", () => {
    for (const name of [
      "watch not confirmed (exit 3)",
      "watch seal failure with failing evidence check",
      "watch child returns nothing",
    ]) {
      const s = get(name);
      expect(s.result.Outcome, name).toBe("STOPPED");
      expect(
        steps(name).filter((x) => x === "DISCOVERY_LIVE"),
        name,
      ).toHaveLength(1);
      expect(steps(name), name).not.toContain("HANDOFF_FIRST");
      expect(
        s.calls.some((c) => c.args.includes(SCRIPTS.Precheck)),
        name,
      ).toBe(false);
      expect(s.result.Steps.slice(-2), name).toEqual(FINAL_CHECKS_WATCH);
    }
    const sealFail = get("watch seal failure with failing evidence check").result;
    expect(sealFail.Failure).toContain("did not confirm a selected target (exit 5)");
    expect(sealFail.CheckFailures).toEqual([
      "watch evidence integrity verification failed (exit 4)",
    ]);
    expect(get("watch child returns nothing").result.Failure).toContain("returned no exit code");
  });

  it("P-06: cancellation during a child, the wait or a check prevents every later live step", () => {
    const cases: [string, string[]][] = [
      ["cancel during the watch", ["HANDOFF_FIRST", ...LIVE_AFTER]],
      ["cancel during the wait", LIVE_AFTER],
      ["cancel observed after the wait", LIVE_AFTER],
      ["cancel observed after the first handoff", LIVE_AFTER],
      ["cancel observed after the Stage B dry run", ["HANDOFF_FINAL", "STAGE_B_LIVE"]],
      ["cancel during the final handoff", ["STAGE_B_LIVE"]],
      ["cancel observed after the final handoff", ["STAGE_B_LIVE"]],
    ];
    for (const [name, never] of cases) {
      const s = get(name);
      expect(s.result.Outcome, name).toBe("CANCELLED");
      expect(s.result.Failure, name).toMatch(/^\[PILOT_SEQUENCE_CANCELLED\]/);
      for (const step of never) expect(steps(name), `${name}: ${step}`).not.toContain(step);
      // Final offline checks still run.
      expect(s.result.Steps.slice(-2), name).toEqual(FINAL_CHECKS_WATCH);
      expect(steps(name), name).not.toContain("STAGE_B_VERIFY");
    }
    expect(get("cancel during the watch").result.Failure).toContain(
      "interrupted during DISCOVERY_LIVE",
    );
    expect(get("cancel during the wait").result.Failure).toContain("interrupted during WAIT");
    expect(get("cancel during the wait").waits).toEqual([6_000]);
    // Cancelled while Stage B ran: its evidence is still verified, with the wallet.
    const b = get("cancel during Stage B");
    expect(b.result.Outcome).toBe("CANCELLED");
    expect(b.result.Steps.slice(-3)).toEqual(["STAGE_B_VERIFY", "WATCH_VERIFY", "WALLET_AFTER"]);
  });

  it("P-07: identity or manifest changes and malformed handoff output stop before Stage B", () => {
    expect(get("identity changed").result.Failure).toContain(
      "identity changed between handoff checks",
    );
    expect(get("mint changed").result.Failure).toContain("identity changed between handoff checks");
    expect(get("manifest changed").result.Failure).toContain("sealed watch manifest changed");
    for (const name of ["identity changed", "mint changed", "manifest changed"]) {
      expect(steps(name), name).not.toContain("STAGE_B_LIVE");
    }
    for (const [label] of MALFORMED) {
      for (const which of ["first", "final"] as const) {
        const name = `malformed ${which}: ${label}`;
        const s = get(name);
        expect(s.result.Outcome, name).toBe("STOPPED");
        expect(s.result.Failure, name).toContain("malformed or inconsistent handoff output");
        expect(steps(name), name).not.toContain("STAGE_B_LIVE");
        if (which === "first") expect(steps(name), name).not.toContain("STAGE_B_DRY_RUN");
        expect(s.waits, name).toEqual([]);
        expect(s.result.Steps.slice(-2), name).toEqual(FINAL_CHECKS_WATCH);
      }
    }
  });

  it("P-08: Stage B dry-run failure, Stage B failure and failed final checks are reported without losing the original failure", () => {
    const dry = get("Stage B dry run fails");
    expect(dry.result.Failure).toContain("Stage B dry run failed");
    expect(steps("Stage B dry run fails")).not.toContain("HANDOFF_FINAL");
    expect(steps("Stage B dry run fails")).not.toContain("STAGE_B_LIVE");

    const b = get("Stage B fails");
    expect(b.result).toMatchObject({
      Outcome: "STOPPED",
      CheckFailures: ["Stage B integrity verification failed (exit 1)"],
    });
    expect(b.result.Failure).toContain("Stage B exited with 1");
    expect(steps("Stage B fails").filter((x) => x === "STAGE_B_LIVE")).toHaveLength(1);

    expect(get("final verification fails").result).toMatchObject({
      Outcome: "STOPPED",
      Failure:
        "[PILOT_SEQUENCE_REFUSED] final check failed: Stage B integrity verification failed (exit 1)",
    });
    expect(get("final wallet changed").result).toMatchObject({
      Outcome: "STOPPED",
      CheckFailures: ["wallet hash changed (final check)"],
    });
    const before = get("wallet changed before discovery");
    expect(before.result.Failure).toContain("wallet hash changed (before discovery)");
    expect(steps("wallet changed before discovery")).toEqual(["PIN", "DISCOVERY_DRY_RUN"]);

    const both = get("final checks fail after an earlier failure");
    expect(both.result.Failure).toContain("START_WINDOW_EXPIRED");
    expect(both.result.CheckFailures).toEqual([
      "watch evidence integrity verification failed (exit 4)",
      "wallet hash changed (final check)",
    ]);
  });
  it("P-09: a real PowerShell pipeline stop still reports the cancellation and every final-check failure, and no later step runs", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "pilot-sequence-stop-"));
    const stop = (name: string, env: Record<string, string>) => {
      const reportFile = path.join(dir, `${name}.txt`);
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(STOP_DRIVER, "utf16le").toString("base64"),
        ],
        {
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            PILOT_CORE: CORE,
            PILOT_REPORT: reportFile,
            PILOT_LIVE_CODE: "0",
            PILOT_FINAL_WALLET: "W",
            PILOT_WATCH_VERIFY_CODE: "0",
            ...env,
          },
          windowsHide: true,
        },
      );
      const [first, ...logs] = readFileSync(reportFile, "utf8").split(/\r?\n/);
      return { first: first!, logs };
    };
    const summary = (logs: string[]) =>
      logs.slice(logs.findIndex((l) => l.startsWith("[PILOT_SEQUENCE] Outcome: ")));
    const STOPPED_IN_WATCH =
      "[PILOT_SEQUENCE] [PILOT_SEQUENCE_CANCELLED] interrupted during DISCOVERY_LIVE";
    try {
      // A pipeline stop during the watch, with a final wallet mismatch.
      const wallet = stop("wallet", { PILOT_STOP_AT: "DISCOVERY_LIVE", PILOT_FINAL_WALLET: "X" });
      // The function never returned, and only the final checks followed the stopped watch.
      expect(wallet.first).toBe(
        "CALLS PIN,DISCOVERY_DRY_RUN,WALLET,DISCOVERY_LIVE,WATCH_VERIFY,WALLET",
      );
      expect(summary(wallet.logs)).toEqual([
        "[PILOT_SEQUENCE] Outcome: CANCELLED",
        STOPPED_IN_WATCH,
        "[PILOT_SEQUENCE] Final check failure: wallet hash changed (final check)",
      ]);

      // A pipeline stop during the watch, with a failed watch verification.
      const verify = stop("verify", {
        PILOT_STOP_AT: "DISCOVERY_LIVE",
        PILOT_WATCH_VERIFY_CODE: "4",
      });
      expect(verify.first).toBe(
        "CALLS PIN,DISCOVERY_DRY_RUN,WALLET,DISCOVERY_LIVE,WATCH_VERIFY,WALLET",
      );
      expect(summary(verify.logs)).toEqual([
        "[PILOT_SEQUENCE] Outcome: CANCELLED",
        STOPPED_IN_WATCH,
        "[PILOT_SEQUENCE] Final check failure: watch evidence integrity verification failed (exit 4)",
      ]);

      // A pipeline stop with passing final checks reports the cancellation alone.
      const clean = stop("clean", { PILOT_STOP_AT: "DISCOVERY_LIVE" });
      expect(summary(clean.logs)).toEqual([
        "[PILOT_SEQUENCE] Outcome: CANCELLED",
        STOPPED_IN_WATCH,
      ]);

      // A pipeline stop during the final checks keeps the original failure and reports the
      // interruption; the remaining checks do not run.
      const late = stop("late", { PILOT_LIVE_CODE: "3", PILOT_STOP_AT: "WATCH_VERIFY" });
      expect(late.first).toBe("CALLS PIN,DISCOVERY_DRY_RUN,WALLET,DISCOVERY_LIVE,WATCH_VERIFY");
      expect(summary(late.logs)).toEqual([
        "[PILOT_SEQUENCE] Outcome: STOPPED",
        "[PILOT_SEQUENCE] [PILOT_SEQUENCE_REFUSED] WATCH did not confirm a selected target (exit 3); sequence ends, no fallback, no retry",
        "[PILOT_SEQUENCE] Final check failure: final checks interrupted before they finished",
      ]);

      for (const r of [wallet, verify, clean, late]) {
        // Never a return, exactly one summary, and no later live step.
        expect(r.first.startsWith("RETURNED")).toBe(false);
        expect(r.logs.filter((l) => l.startsWith("[PILOT_SEQUENCE] Outcome: "))).toHaveLength(1);
        for (const step of [
          "HANDOFF_FIRST",
          "WAIT",
          "STAGE_B_DRY_RUN",
          "HANDOFF_FINAL",
          "STAGE_B_LIVE",
        ]) {
          expect(r.first.split(" ")[1]!.split(","), step).not.toContain(step);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 50_000);

  it("P-10: every ordinary path prints exactly one summary, from the core; the entry prints none", async () => {
    const { readFileSync } = await import("node:fs");
    for (const s of report.scenarios) {
      const outcomes = s.logs.filter((l) => l.startsWith("[PILOT_SEQUENCE] Outcome: "));
      expect(outcomes, s.name).toEqual([`[PILOT_SEQUENCE] Outcome: ${s.result.Outcome}`]);
      const at = s.logs.indexOf(outcomes[0]!);
      const expected = [
        ...(s.result.Failure ? [`[PILOT_SEQUENCE] ${s.result.Failure}`] : []),
        ...s.result.CheckFailures.map((f) => `[PILOT_SEQUENCE] Final check failure: ${f}`),
      ];
      // The summary closes the log: outcome, original failure, then each secondary failure once.
      expect(s.logs.slice(at + 1), s.name).toEqual(expected);
    }
    const entry = readFileSync(ENTRY, "utf8");
    expect(entry).not.toContain("Outcome:");
    expect(entry).not.toContain("Final check failure");
    expect(entry).toContain(
      "Log         = { param($Line) [Console]::Out.WriteLine([string]$Line) }",
    );
  });
});
