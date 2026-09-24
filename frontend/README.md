# NeXusTrade Frontend

The Phase 10 local Research Dashboard and Archive Explorer is implemented as a local static viewer.

It inspects completed runs, cohorts, candidates, score attribution, and provider pressure while
preserving `PAPER` / shadow-only boundaries. Local phase/run/report-kind/provider-evidence filters
only change the display. The cohort view preserves member runs, recorded concentration, and gates;
the candidate view shows its archived decision, score, and threshold context before later labels. It
has no wallet, signing, submission, orders, fills, positions, `paper BUY`, live provider calls, or
runtime controls. Provider pressure uses a horizontal scroll region and keeps full archive-relative
source paths behind an expandable disclosure, so the evidence remains available without oversized
rows. The wide Decision-time facts table uses the same horizontal-scroll treatment while retaining
the separate later-outcome label.

The first-pass architecture is Vite + React + TypeScript with a one-way backend archive exporter.
It consumes structured reports before any archive-database fallback and does not parse terminal
transcripts. Generated data is ignored under `public/research-dashboard-data/`.

Generate the approved local Phase 9.28 / 9.29 evidence set, then launch the viewer:

```powershell
corepack pnpm dashboard:export -- --archive-root=data/archive --include-phase=phase9.28 --include-phase=phase9.29 --include-cohort=phase9.29/combined-valid-three-20260818-1539 --output-dir=frontend/public/research-dashboard-data
corepack pnpm dashboard:dev
```

The exporter performs zero external/provider/RPC HTTP calls and zero database writes. Browser
requests are limited to static assets on the local Vite server. See
[NeXusTrade-Phase-10-Detailed-Checklist.md](../docs/NeXusTrade-Phase-10-Detailed-Checklist.md)
for the full safety and verification contract.

The approved 2026-08-18 export produced 5 runs, 1 cohort, and 7 candidates. Its stable content
fingerprint was `b02e16f3c19f3f016ff94b2405c072606a207dba767d3e51d583110c9b6147e5`; the manifest's
generation time is deliberately excluded from that fingerprint. Verification passed with the
frontend test suite and `corepack pnpm dashboard:build`. Generated data is local-only and ignored;
refresh it only by rerunning the explicit export command above.
