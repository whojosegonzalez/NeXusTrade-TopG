import { useEffect, useState } from "react";

import type {
  DashboardCandidate,
  DashboardCohort,
  DashboardRun,
  DashboardSafety,
} from "@nexustrade/shared";

import { loadDashboardData, type DashboardData } from "./dashboardData.js";
import { useLiveSessionState } from "./hooks/useLiveSessionState.js";
import { ActiveSessionView } from "./views/ActiveSessionView.js";
import { HistoryView } from "./views/HistoryView.js";
import { SettingsView } from "./views/SettingsView.js";

const outcomeLabels = ["TARGET_FIRST", "STOP_FIRST", "MAX_HOLD"] as const;

export type DashboardTab = "ACTIVE_SESSION" | "SETTINGS" | "HISTORY" | "ARCHIVE";

interface AppProps {
  readonly load?: () => Promise<DashboardData>;
  readonly defaultTab?: DashboardTab;
}

export function App({ load = loadDashboardData, defaultTab = "ACTIVE_SESSION" }: AppProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>(defaultTab);
  const liveState = useLiveSessionState();

  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState("ALL");
  const [runId, setRunId] = useState("ALL");
  const [reportKind, setReportKind] = useState("ALL");
  const [providerEvidence, setProviderEvidence] = useState("ALL");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();

  useEffect(() => {
    void load()
      .then((loaded) => {
        setData(loaded);
        setSelectedCandidateId(loaded.candidates[0]?.id);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not load local dashboard data.");
      });
  }, [load]);

  return (
    <main>
      <nav className="top-nav-bar" aria-label="Main Navigation">
        <button
          type="button"
          className={`nav-tab ${activeTab === "ACTIVE_SESSION" ? "active" : ""}`}
          onClick={() => setActiveTab("ACTIVE_SESSION")}
        >
          ⚡ Active Session
        </button>
        <button
          type="button"
          className={`nav-tab ${activeTab === "SETTINGS" ? "active" : ""}`}
          onClick={() => setActiveTab("SETTINGS")}
        >
          ⚙️ Settings & Control
        </button>
        <button
          type="button"
          className={`nav-tab ${activeTab === "HISTORY" ? "active" : ""}`}
          onClick={() => setActiveTab("HISTORY")}
        >
          📜 Past Sessions
        </button>
        <button
          type="button"
          className={`nav-tab ${activeTab === "ARCHIVE" ? "active" : ""}`}
          onClick={() => setActiveTab("ARCHIVE")}
        >
          🔬 Archive Explorer
        </button>
      </nav>

      {activeTab === "ACTIVE_SESSION" && (
        <ActiveSessionView
          session={liveState.activeSession}
          onSendCommand={liveState.sendCommand}
        />
      )}

      {activeTab === "SETTINGS" && (
        <SettingsView
          initialSettings={liveState.settings}
          walletTelemetry={liveState.walletTelemetry}
          onRefreshWallet={liveState.refreshWallet}
          onSaveSettings={liveState.setSettings}
        />
      )}

      {activeTab === "HISTORY" && <HistoryView sessions={liveState.historySessions} />}

      {activeTab === "ARCHIVE" &&
        (error ? (
          <section className="state-panel" aria-live="polite">
            <h1>Local dashboard data is unavailable</h1>
            <p>{error}</p>
            <p>Generate archive data locally, then refresh this read-only page.</p>
          </section>
        ) : !data ? (
          <section className="state-panel">Loading local research archive data…</section>
        ) : (
          <ArchiveExplorerView
            data={data}
            phase={phase}
            setPhase={setPhase}
            runId={runId}
            setRunId={setRunId}
            reportKind={reportKind}
            setReportKind={setReportKind}
            providerEvidence={providerEvidence}
            setProviderEvidence={setProviderEvidence}
            selectedCandidateId={selectedCandidateId}
            setSelectedCandidateId={setSelectedCandidateId}
          />
        ))}
    </main>
  );
}

interface ArchiveExplorerViewProps {
  readonly data: DashboardData;
  readonly phase: string;
  readonly setPhase: (phase: string) => void;
  readonly runId: string;
  readonly setRunId: (runId: string) => void;
  readonly reportKind: string;
  readonly setReportKind: (kind: string) => void;
  readonly providerEvidence: string;
  readonly setProviderEvidence: (evidence: string) => void;
  readonly selectedCandidateId?: string | undefined;
  readonly setSelectedCandidateId: (id?: string) => void;
}

function ArchiveExplorerView({
  data,
  phase,
  setPhase,
  runId,
  setRunId,
  reportKind,
  setReportKind,
  providerEvidence,
  setProviderEvidence,
  selectedCandidateId,
  setSelectedCandidateId,
}: ArchiveExplorerViewProps) {
  const phases = [...new Set([...data.runs, ...data.cohorts].map((item) => item.phase))].sort();
  const reportKinds = [
    ...new Set([
      ...data.runs.flatMap((run) => run.reportKinds ?? ["NOT_REPORTED"]),
      ...data.cohorts.map((cohort) => cohort.reportKind ?? "NOT_REPORTED"),
    ]),
  ].sort();
  const runsById = new Map(data.runs.map((run) => [run.id, run]));
  const visibleRuns = data.runs.filter((run) => {
    const hasProviderEvidence = run.providerPressure.length > 0;
    return (
      (phase === "ALL" || run.phase === phase) &&
      (runId === "ALL" || run.id === runId) &&
      (reportKind === "ALL" || (run.reportKinds ?? ["NOT_REPORTED"]).includes(reportKind)) &&
      (providerEvidence === "ALL" ||
        (providerEvidence === "REPORTED" ? hasProviderEvidence : !hasProviderEvidence))
    );
  });
  const visibleCohorts = data.cohorts.filter(
    (cohort) =>
      (phase === "ALL" || cohort.phase === phase) &&
      (reportKind === "ALL" || (cohort.reportKind ?? "NOT_REPORTED") === reportKind),
  );
  const cohortsById = new Map(data.cohorts.map((cohort) => [cohort.id, cohort]));
  const visibleCandidates = data.candidates.filter((candidate) => {
    const candidateRun = runsById.get(candidate.runId);
    const candidateCohort = cohortsById.get(candidate.cohortId);
    return (
      (phase === "ALL" || candidateRun?.phase === phase) &&
      (runId === "ALL" || candidate.runId === runId) &&
      (reportKind === "ALL" ||
        (candidateRun?.reportKinds ?? ["NOT_REPORTED"]).includes(reportKind) ||
        (candidateCohort?.reportKind ?? "NOT_REPORTED") === reportKind)
    );
  });
  const selectedCandidate =
    visibleCandidates.find((candidate) => candidate.id === selectedCandidateId) ??
    visibleCandidates[0];

  return (
    <div>
      <header className="safety-banner">
        <div>
          <p className="eyebrow">Local research archive explorer</p>
          <h1>NeXusTrade Research Dashboard</h1>
        </div>
        <dl>
          <div>
            <dt>Mode</dt>
            <dd>PAPER / shadow-only</dd>
          </div>
          <div>
            <dt>Execution</dt>
            <dd>Disabled</dd>
          </div>
          <div>
            <dt>Baseline</dt>
            <dd>BUY 90 · WATCH 70</dd>
          </div>
          <div>
            <dt>Exported</dt>
            <dd>{new Date(data.manifest.generatedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </header>

      <section className="provenance" aria-label="Data provenance">
        <span>Archive root: {data.manifest.archiveRoot}</span>
        <span>
          Fingerprint: <code>{data.manifest.contentFingerprint}</code>
        </span>
        <span>Includes: {data.manifest.requestedPhaseIncludes.join(", ")}</span>
      </section>

      <section className="controls" aria-label="Archive filters">
        <label htmlFor="phase-filter">Display phase</label>
        <select
          id="phase-filter"
          value={phase}
          onChange={(event) => {
            setPhase(event.target.value);
            setRunId("ALL");
          }}
        >
          <option value="ALL">All included phases</option>
          {phases.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <label htmlFor="run-filter">Display run</label>
        <select id="run-filter" value={runId} onChange={(event) => setRunId(event.target.value)}>
          <option value="ALL">All displayed runs</option>
          {data.runs
            .filter((run) => phase === "ALL" || run.phase === phase)
            .map((run) => (
              <option key={run.id} value={run.id}>
                {run.label}
              </option>
            ))}
        </select>
        <label htmlFor="report-kind-filter">Report kind</label>
        <select
          id="report-kind-filter"
          value={reportKind}
          onChange={(event) => setReportKind(event.target.value)}
        >
          <option value="ALL">All report kinds</option>
          {reportKinds.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <label htmlFor="provider-evidence-filter">Provider pressure evidence</label>
        <select
          id="provider-evidence-filter"
          value={providerEvidence}
          onChange={(event) => setProviderEvidence(event.target.value)}
        >
          <option value="ALL">Reported and not reported</option>
          <option value="REPORTED">Reported</option>
          <option value="NOT_REPORTED">Not reported</option>
        </select>
        <p>Filters affect this local view only; they are not strategy inputs.</p>
      </section>

      <ArchiveLibrary runs={visibleRuns} />
      <OutcomeComparison cohorts={visibleCohorts} runs={data.runs} />
      <ProviderPressure runs={visibleRuns} />
      <CandidateInspector
        candidates={visibleCandidates}
        selected={selectedCandidate}
        onSelect={setSelectedCandidateId}
        safety={data.manifest.safety}
      />
    </div>
  );
}

function ArchiveLibrary({ runs }: { readonly runs: DashboardData["runs"] }) {
  return (
    <section aria-labelledby="archive-library-heading">
      <h2 id="archive-library-heading">Archived runs</h2>
      <table>
        <thead>
          <tr>
            <th>Phase</th>
            <th>Run</th>
            <th>Safety</th>
            <th>Cycles</th>
            <th>Recorded UTC</th>
            <th>Report kind</th>
            <th>Archive</th>
            <th>Structured source</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{run.phase}</td>
              <td>{run.label}</td>
              <td>{run.safetyStatus}</td>
              <td>{run.cycleCount}</td>
              <td>{formatDateRange(run.startedAt, run.endedAt)}</td>
              <td>{(run.reportKinds ?? ["NOT_REPORTED"]).join(", ")}</td>
              <td>
                <code>{run.archivePath}</code>
              </td>
              <td>
                {run.sourceReports.map((report) => (
                  <code key={report}>{report}</code>
                ))}
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={8}>No runs match the selected display filter.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function OutcomeComparison({
  cohorts,
  runs,
}: {
  readonly cohorts: readonly DashboardCohort[];
  readonly runs: readonly DashboardRun[];
}) {
  const runLabels = new Map(runs.map((run) => [run.id, run.label]));
  return (
    <section aria-labelledby="outcome-heading">
      <h2 id="outcome-heading">Outcome labels (later observations, not entry inputs)</h2>
      {cohorts.map((cohort) => (
        <OutcomeCohort key={cohort.id} cohort={cohort} runLabels={runLabels} />
      ))}
      {cohorts.length === 0 && <p>No supported outcome cohort was included in this export.</p>}
    </section>
  );
}

function OutcomeCohort({
  cohort,
  runLabels,
}: {
  readonly cohort: DashboardCohort;
  readonly runLabels: ReadonlyMap<string, string>;
}) {
  const maximum = Math.max(1, ...outcomeLabels.map((label) => cohort.labelCounts[label] ?? 0));
  return (
    <article className="cohort-card">
      <h3>{cohort.label}</h3>
      <p>
        <strong>{cohort.conclusion}</strong>: {cohort.conclusionReason}
      </p>
      <div className="outcome-bars" aria-label={`${cohort.label} label counts`}>
        {outcomeLabels.map((label) => {
          const count = cohort.labelCounts[label] ?? 0;
          return (
            <div key={label}>
              <span>{label}</span>
              <meter min="0" max={maximum} value={count}>
                {count}
              </meter>
              <b>{count}</b>
            </div>
          );
        })}
      </div>
      <table>
        <caption>Cohort evidence and provenance</caption>
        <thead>
          <tr>
            <th>Selected</th>
            <th>Exact 3/5/15 coverage</th>
            <th>Member runs</th>
            <th>Report kind</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{cohort.candidateCount}</td>
            <td>{cohort.exactCoverageCount}</td>
            <td>{cohort.memberRunIds.map((id) => runLabels.get(id) ?? id).join(", ")}</td>
            <td>{cohort.reportKind ?? "NOT_REPORTED"}</td>
            <td>
              <code>{cohort.sourceReport}</code>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="cohort-evidence-grid">
        <EvidenceList
          title="Selected source-run shares"
          values={cohort.concentration.selectedRunSharesPct}
        />
        <EvidenceList
          title="Target-first source-run shares"
          values={cohort.concentration.targetRunSharesPct}
        />
        <EvidenceList
          title="Non-target source-run shares"
          values={cohort.concentration.nonTargetRunSharesPct}
        />
      </div>
      <table>
        <caption>Pre-registered cohort gates</caption>
        <thead>
          <tr>
            <th>Gate</th>
            <th>Result</th>
            <th>Recorded detail</th>
          </tr>
        </thead>
        <tbody>
          {cohort.gates.map((gate) => (
            <tr key={gate.name}>
              <td>{gate.name}</td>
              <td>{gate.passed ? "PASS" : "NOT MET"}</td>
              <td>{gate.detail}</td>
            </tr>
          ))}
          {cohort.gates.length === 0 && (
            <tr>
              <td colSpan={3}>NOT_REPORTED</td>
            </tr>
          )}
        </tbody>
      </table>
    </article>
  );
}

function EvidenceList({
  title,
  values,
}: {
  readonly title: string;
  readonly values: Readonly<Record<string, number>>;
}) {
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  return (
    <section className="evidence-list">
      <h4>{title}</h4>
      {entries.length === 0 ? (
        <p>NOT_REPORTED</p>
      ) : (
        <ul>
          {entries.map(([label, value]) => (
            <li key={label}>
              {label}: {formatPercent(value)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProviderPressure({ runs }: { readonly runs: DashboardData["runs"] }) {
  const pressure = runs.flatMap((run) =>
    run.providerPressure.map((row) => ({ ...row, run: run.label })),
  );
  return (
    <section aria-labelledby="provider-heading">
      <h2 id="provider-heading">Provider pressure</h2>
      <div
        className="provider-table-scroll"
        role="region"
        aria-label="Provider pressure table; scroll horizontally for all columns"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Provider</th>
              <th>Stage</th>
              <th>Live upstream</th>
              <th>Upstream rate limits</th>
              <th>Upstream errors</th>
              <th>Cache</th>
              <th>Cooldown skips</th>
              <th>Budget deferrals</th>
              <th>Controller deferrals</th>
              <th>Venue guard (skip / allow)</th>
              <th>Unavailable</th>
              <th>Provenance</th>
            </tr>
          </thead>
          <tbody>
            {pressure.map((row) => (
              <tr key={`${row.run}-${row.provider}`}>
                <td>{row.run}</td>
                <td>{row.provider}</td>
                <td>{row.stage}</td>
                <td>{row.liveUpstreamRows}</td>
                <td>{row.upstreamRateLimited}</td>
                <td>{row.upstreamErrors}</td>
                <td>{row.cacheHits}</td>
                <td>{row.cooldownSkips}</td>
                <td>{formatCount(row.quoteBudgetDeferrals)}</td>
                <td>{formatCount(row.controllerDeferrals)}</td>
                <td>
                  {formatCount(row.venueGuardSkips)} / {formatCount(row.venueGuardAllows)}
                </td>
                <td>{row.unavailable}</td>
                <td>
                  <details className="provider-provenance">
                    <summary>Show source path</summary>
                    <code>{row.sourceReport}</code>
                  </details>
                </td>
              </tr>
            ))}
            {pressure.length === 0 && (
              <tr>
                <td colSpan={13}>NOT_REPORTED for the displayed runs.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Upstream outcomes, cache behavior, local controller/budget deferrals, and venue guards are
        intentionally separate. NOT_REPORTED is not zero.
      </p>
    </section>
  );
}

function CandidateInspector(input: {
  readonly candidates: readonly DashboardCandidate[];
  readonly selected?: DashboardCandidate;
  readonly onSelect: (candidateId: string) => void;
  readonly safety: DashboardSafety;
}) {
  return (
    <section aria-labelledby="candidate-heading">
      <h2 id="candidate-heading">Candidate inspector</h2>
      <label htmlFor="candidate-select">Archived candidate</label>
      <select
        id="candidate-select"
        value={input.selected?.id ?? ""}
        onChange={(event) => input.onSelect(event.target.value)}
      >
        {input.candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.symbol ?? candidate.mintAddress} · {candidate.decisionId}
          </option>
        ))}
      </select>
      {input.selected ? (
        <CandidateDetail candidate={input.selected} safety={input.safety} />
      ) : (
        <p>No candidate is available.</p>
      )}
    </section>
  );
}

function CandidateDetail({
  candidate,
  safety,
}: {
  readonly candidate: DashboardCandidate;
  readonly safety: DashboardSafety;
}) {
  const score = candidate.decisionFeatures.find((feature) => feature.key === "score")?.value;
  return (
    <article className="candidate-detail">
      <h3>{candidate.symbol ?? candidate.mintAddress}</h3>
      <dl className="candidate-context">
        <div>
          <dt>Original decision</dt>
          <dd>{candidate.classification}</dd>
        </div>
        <div>
          <dt>Original decision time</dt>
          <dd>{new Date(candidate.decidedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Original score</dt>
          <dd>{score === undefined ? "MISSING" : formatValue(score)}</dd>
        </div>
        <div>
          <dt>Original threshold context</dt>
          <dd>
            BUY {safety.buyScoreThreshold} · WATCH {safety.watchScoreThreshold}
          </dd>
        </div>
        <div className="candidate-reason">
          <dt>Recorded reason</dt>
          <dd>{candidate.classificationReason}</dd>
        </div>
      </dl>
      <div
        className="candidate-table-scroll"
        role="region"
        aria-label="Decision-time facts table; scroll horizontally for all columns"
        tabIndex={0}
      >
        <table>
          <caption>Decision-time facts</caption>
          <thead>
            <tr>
              <th>Family</th>
              <th>Fact</th>
              <th>Value</th>
              <th>Availability</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {candidate.decisionFeatures.map((feature) => (
              <tr key={`${feature.family}-${feature.key}`}>
                <td>{feature.family}</td>
                <td>{feature.key}</td>
                <td>{feature.value === undefined ? "MISSING" : formatValue(feature.value)}</td>
                <td>{feature.availability}</td>
                <td>
                  {feature.sourceKind}: {feature.sourcePath}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <aside className="outcome-label">
        <h4>Outcome label (not an entry input)</h4>
        <p>
          {candidate.outcomeLabel.label}; exact coverage:{" "}
          {candidate.outcomeLabel.exactCoverage
            .map((row) => `${row.horizonMinutes}m ${row.onTime ? "on time" : "late"}`)
            .join(", ")}
          .
        </p>
        <p>
          Source: <code>{candidate.outcomeLabel.sourceReport}</code>
        </p>
      </aside>
    </article>
  );
}

function formatValue(value: string | number | boolean | readonly string[]): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function formatCount(value: number | undefined): string {
  return value === undefined ? "NOT_REPORTED" : String(value);
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatDateRange(startedAt: string, endedAt: string): string {
  const format = (value: string) => value.replace(".000Z", "Z");
  return `${format(startedAt)} – ${format(endedAt)}`;
}
