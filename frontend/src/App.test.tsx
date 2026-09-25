import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  DashboardCandidate,
  DashboardCohort,
  DashboardManifest,
  DashboardRun,
} from "@nexustrade/shared";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App.js";

const manifest: DashboardManifest = {
  contractVersion: "1",
  generatedAt: "2026-08-18T23:00:00.000Z",
  contentFingerprint: "a".repeat(64),
  archiveRoot: "data/archive",
  requestedPhaseIncludes: ["phase9.28", "phase9.29"],
  safety: {
    mode: "PAPER",
    shadowOnly: true,
    executionDisabled: true,
    buyScoreThreshold: 90,
    watchScoreThreshold: 70,
    providerCalls: false,
    databaseWrites: false,
    sessionCreation: false,
    walletLoaded: false,
    transactionSigning: false,
    transactionSubmission: false,
  },
  inputs: [],
  resources: {
    runs: { path: "runs.v1.json", sha256: "b".repeat(64), count: 1 },
    cohorts: { path: "cohorts.v1.json", sha256: "c".repeat(64), count: 1 },
    candidates: { path: "candidates.v1.json", sha256: "d".repeat(64), count: 1 },
  },
  skippedInputs: ["phase9.28/legacy-root-artifacts-20260818"],
  warnings: ["Outcome labels are later observations and are not entry inputs."],
};

const runs: readonly DashboardRun[] = [
  {
    id: "run:phase9-28-test1",
    phase: "phase9.28",
    archivePath: "phase9.28/test1",
    label: "Test1",
    mode: "PAPER",
    shadowOnly: true,
    safetyStatus: "PASS",
    startedAt: "2026-08-18T20:00:00.000Z",
    endedAt: "2026-08-18T22:00:00.000Z",
    cycleCount: 34,
    sourceReports: ["phase9.28/test1/runner-output/run.json"],
    reportKinds: ["TERMINAL_RUNNER_SUMMARY"],
    providerPressure: [
      {
        provider: "JUPITER",
        stage: "RUN_TOTAL",
        total: 4,
        liveUpstreamRows: 2,
        routerRows: 2,
        upstreamRateLimited: 2,
        upstreamErrors: 3,
        cacheHits: 1,
        cooldownSkips: 4,
        unavailable: 0,
        localDeferrals: 11,
        quoteBudgetDeferrals: 5,
        controllerDeferrals: 6,
        venueGuardSkips: 7,
        venueGuardAllows: 8,
        sourceReport: "phase9.28/test1/runner-output/run.json",
      },
      {
        provider: "BIRDEYE",
        stage: "RUN_TOTAL",
        total: 1,
        liveUpstreamRows: 1,
        routerRows: 0,
        upstreamRateLimited: 0,
        upstreamErrors: 0,
        cacheHits: 0,
        cooldownSkips: 0,
        unavailable: 0,
        localDeferrals: 0,
        sourceReport: "phase9.28/test1/runner-output/run.json",
      },
    ],
    warnings: [],
  },
  {
    id: "run:phase9-28-test2",
    phase: "phase9.28",
    archivePath: "phase9.28/test2",
    label: "Test2",
    mode: "PAPER",
    shadowOnly: true,
    safetyStatus: "PASS",
    startedAt: "2026-08-18T20:00:00.000Z",
    endedAt: "2026-08-18T22:00:00.000Z",
    cycleCount: 0,
    sourceReports: ["phase9.28/test2/runner-output/run.json"],
    reportKinds: ["TERMINAL_RUNNER_SUMMARY"],
    providerPressure: [],
    warnings: ["NOT_REPORTED"],
  },
];

const cohorts: readonly DashboardCohort[] = [
  {
    id: "cohort:phase9.29:F65E_ATTRIBUTION@v1",
    phase: "phase9.29",
    label: "F65E@v1 Phase 9.29 attribution",
    reportKind: "FAST_ENTRY_ATTRIBUTION_REPORT",
    memberRunIds: ["run:phase9-28-test1"],
    candidateCount: 7,
    exactCoverageCount: 7,
    labelCounts: { TARGET_FIRST: 3, STOP_FIRST: 3, MAX_HOLD: 1, NO_OBSERVATION: 0, AMBIGUOUS: 0 },
    conclusion: "NO_DEFENSIBLE_HYPOTHESIS",
    conclusionReason: "independence gates failed",
    concentration: {
      selectedRunSharesPct: { Test1: 100 },
      targetRunSharesPct: { Test1: 100 },
      nonTargetRunSharesPct: { Test1: 100 },
    },
    gates: [{ name: "independent_runs", passed: false, detail: "concentrated" }],
    sourceReport: "phase9.29/combined/report.json",
  },
];

const candidates: readonly DashboardCandidate[] = [
  {
    id: "run:phase9-28-test1:decision-1",
    runId: "run:phase9-28-test1",
    cohortId: cohorts[0].id,
    mintAddress: "Mint111",
    symbol: "EXAMPLE",
    decisionId: "decision-1",
    decidedAt: "2026-08-18T20:05:00.000Z",
    classification: "SKIP",
    classificationReason: "stored F65E membership",
    decisionFeatures: [
      {
        family: "SCORE_ATTRIBUTION",
        key: "score",
        value: 65,
        availability: "AVAILABLE_AT_DECISION_TIME",
        sourceKind: "DECISION_SNAPSHOT",
        sourcePath: "StrategyDecision.score",
      },
      {
        family: "QUOTE_IMPACT",
        key: "price_impact_bps",
        availability: "UNAVAILABLE_AT_DECISION_TIME",
        sourceKind: "DECISION_SNAPSHOT",
        sourcePath: "StrategyDecision.quote",
        unavailableReason: "NOT_REPORTED",
      },
    ],
    outcomeLabel: {
      label: "TARGET_FIRST",
      exactCoverage: [
        { horizonMinutes: 3, onTime: true },
        { horizonMinutes: 5, onTime: true },
        { horizonMinutes: 15, onTime: true },
      ],
      sourceReport: "phase9.29/combined/report.json",
      description: "Later observation; not an entry input.",
    },
  },
];

describe("App", () => {
  afterEach(() => {
    cleanup();
  });
  it("renders traceable cohort, provider, and decision evidence using local-only filters on ARCHIVE tab", async () => {
    render(
      <App load={async () => ({ manifest, runs, cohorts, candidates })} defaultTab="ARCHIVE" />,
    );

    expect(await screen.findByText("PAPER / shadow-only")).toBeDefined();
    expect(screen.getByText("NO_DEFENSIBLE_HYPOTHESIS")).toBeDefined();
    expect(screen.getByText("Outcome label (not an entry input)")).toBeDefined();
    expect(screen.getByText("SCORE_ATTRIBUTION")).toBeDefined();
    expect(screen.getByText("MISSING")).toBeDefined();
    expect(screen.getByText(/StrategyDecision\.quote/)).toBeDefined();
    expect(screen.getByText("Cohort evidence and provenance")).toBeDefined();
    expect(screen.getByText("Selected source-run shares")).toBeDefined();
    expect(screen.getAllByText("Test1: 100.00%")).toHaveLength(3);
    expect(screen.getByText("Pre-registered cohort gates")).toBeDefined();
    expect(screen.getByText("NOT MET")).toBeDefined();
    expect(screen.getByText("Upstream rate limits")).toBeDefined();
    expect(
      screen.getByRole("region", {
        name: "Provider pressure table; scroll horizontally for all columns",
      }),
    ).toHaveClass("provider-table-scroll");
    expect(
      screen.getByRole("row", { name: /Test1.*JUPITER.*RUN_TOTAL.*2.*3.*1.*4.*5.*6.*7 \/ 8/ }),
    ).toBeDefined();
    expect(
      screen.getByRole("row", { name: /Test1.*BIRDEYE.*RUN_TOTAL.*NOT_REPORTED.*NOT_REPORTED/ }),
    ).toBeDefined();
    const sourcePathDisclosure = screen.getAllByText("Show source path")[0]?.closest("details");
    expect(sourcePathDisclosure).not.toHaveAttribute("open");
    expect(screen.getAllByText("phase9.28/test1/runner-output/run.json")).toHaveLength(3);
    expect(screen.getAllByText(/2026-08-18T20:00:00Z.*2026-08-18T22:00:00Z/)).toHaveLength(2);
    expect(screen.getByText("Original decision")).toBeDefined();
    expect(screen.getByText("Original score")).toBeDefined();
    expect(screen.getByText("Original threshold context")).toBeDefined();
    expect(
      screen.getByRole("region", {
        name: "Decision-time facts table; scroll horizontally for all columns",
      }),
    ).toHaveClass("candidate-table-scroll");
    expect(screen.getAllByText("BUY 90 · WATCH 70")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Provider pressure evidence"), {
      target: { value: "NOT_REPORTED" },
    });
    expect(screen.getByRole("row", { name: /Test2.*PASS.*0/ })).toBeDefined();
    expect(screen.queryByRole("row", { name: /Test1.*PASS.*34/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("Provider pressure evidence"), {
      target: { value: "ALL" },
    });
    fireEvent.change(screen.getByLabelText("Report kind"), {
      target: { value: "TERMINAL_RUNNER_SUMMARY" },
    });
    expect(screen.getByRole("row", { name: /Test1.*PASS.*34/ })).toBeDefined();

    fireEvent.change(screen.getByLabelText("Report kind"), {
      target: { value: "FAST_ENTRY_ATTRIBUTION_REPORT" },
    });
    expect(screen.getByText("F65E@v1 Phase 9.29 attribution")).toBeDefined();
    expect(screen.getAllByText("FAST_ENTRY_ATTRIBUTION_REPORT")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Report kind"), {
      target: { value: "ALL" },
    });
    fireEvent.change(screen.getByLabelText("Display run"), {
      target: { value: "run:phase9-28-test1" },
    });
    expect(screen.queryByRole("row", { name: /Test2.*PASS.*0/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("Display phase"), {
      target: { value: "phase9.29" },
    });
    expect(screen.getByText("F65E@v1 Phase 9.29 attribution")).toBeDefined();
    expect(screen.queryByRole("row", { name: /Test1.*PASS.*34/ })).toBeNull();
  });

  it("navigates across all 4 top-level tabs", async () => {
    render(<App load={async () => ({ manifest, runs, cohorts, candidates })} />);

    // Default tab is Active Session
    expect(screen.getByTestId("active-session-view")).toBeDefined();

    // Switch to Settings tab
    const settingsTab = screen.getByText("⚙️ Settings & Control");
    fireEvent.click(settingsTab);
    expect(screen.getByTestId("settings-view")).toBeDefined();

    // Switch to Past Sessions tab
    const historyTab = screen.getByText("📜 Past Sessions");
    fireEvent.click(historyTab);
    expect(screen.getByTestId("history-view")).toBeDefined();

    // Switch to Archive Explorer tab
    const archiveTab = screen.getByText("🔬 Archive Explorer");
    fireEvent.click(archiveTab);
    expect(await screen.findByText("PAPER / shadow-only")).toBeDefined();
  });
});
