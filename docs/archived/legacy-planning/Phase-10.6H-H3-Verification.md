# H3 Verification And Resumption Record

Current handoff update (2026-09-18): H3 was committed as `f8f8d4c`. The original closeout record below describes its pre-commit checkpoint. Main integration and V3/B.3 provenance are tracked separately in the [integration record](./Phase-10.6H-Main-Isolation-Integration.md).

Status: **Isolated engineering acceptance complete, 2026-09-17. Patch uncommitted and unmerged.**

## Authorization And Isolation

The user approved the [H3 checklist](./NeXusTrade-Phase-10.6H-H3-Detailed-Checklist.md), D1-D9 and
H3-00 through H3-06, at `f46eb26` on branch `isolation`. Initial working tree was clean. The user
reports that checklist committed/pushed but unmerged. Work stayed in `U:\Projects\H1s\isolation`.
No operational checkout, provider, archive, database or scheduler was inspected or changed.

The local isolation probe checked 866 dependency links, source/dependency roots and the native
SQLite module. Explicit realpath checks passed for `.tmp/h3`, `.tmp/h2` and the H3/H2/H1 Vitest
cache directories. SQLite probe used `:memory:`. Health persistence tests reuse unchanged H2
fixture helpers and native-open guards; fixture files are under the owned `.tmp/h2` directory and
cleaned afterward. No normal runtime/default database/environment bootstrap was used.

## Batch Completion

| Batch   | State    | Evidence                                                                                                                     |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| H3-AUTH | Complete | Explicit approval at f46eb26; no material policy deviation from D1-D9.                                                       |
| H3-00   | Complete | Dedicated environment-disabled allowlist, fake transport, dependency/import audit, native/fixture guards.                    |
| H3-01   | Complete | H-03 reproduced before changing code, then retained as a normal passing regression; constructor/retry inventory completed.   |
| H3-02   | Complete | Per-provider FIFO, atomic reservation, queue bound, cap binding, monotonic validation, wake cleanup and no-progress failure. |
| H3-03   | Complete | HTTP/retry controls, pre-dispatch accounting, post-admission timeout, cancellation races and resource cleanup.               |
| H3-04   | Complete | Registry sharing, Birdeye reservation/retry policy and legacy timing characterized; contract completed.                      |
| H3-05   | Complete | 98 H3 tests, 245 unchanged H1 tests, 194 unchanged H2 tests; required static/source checks pass.                             |
| H3-06   | Complete | Named matrix, source identity, limitation review and parent/roadmap/structure/post-V3 status sync.                           |

## Resume / Next Action

There is no remaining H3 implementation checklist item. Review the uncommitted patch and commit
when ready. H4 detailed planning is the next engineering package; its implementation is not
included here. No commit, push, fetch, merge, deployment or provider operation was performed.

Operational integration remains gated through final scheduled V3 collection, finality review,
evidence preservation, final identity binding and the approved analyzer report. September 18
alone is not merge authority. Compare main/isolation and revalidate any later integration changes
before a separately reviewed merge. H3 supplies no measurement-capability finding or candidate.

## Failure Probes And Checkpoints

- Initial baseline: four passed and one expected failure in three files. The old limiter admitted
  both queued limit-one callers at 60000 ms. H-03 was converted from `it.fails` to an ordinary
  passing regression after the FIFO change; no expected failures remain.
- Intermediate checkpoints: 21 core/audit tests; 31 after HTTP controls; 73 after caller suites;
  80 after registry/time/budget/health coverage; 89 after cleanup/default characterization;
  final 98 after additional adversarial validation. Checklist updates recorded batch progress.
- One intermediate type error (missing return on a typed drain path), one immediate-admission
  diagnostic mismatch, and one test type-import lint violation were fixed. Final checks pass.
- Repeated non-advancing early wake fails after two wakes instead of spinning. Rejected/throwing
  scheduler, invalid/backwards/throwing clock, conflicting cap, full queue and stale callback
  fixtures all settle without extra admission.

## Dedicated Harness Audit

`backend/vitest.h3.config.ts` disables environment loading/watch/public directory, has one worker,
uses a local cache, and includes only the following reviewed files. The runtime AST traversal
covers HTTP/retry/registry/adapter/config/quote dependencies, ignores type-only imports, rejects
runtime environment/dynamic loading in those paths, and allows only shared code plus vitest/zod.
The pre-expansion caller traversal visited 72 source files, with no dependency outside providers
and shared source. The guarded health path separately reuses H2's previously audited database
factory/migration/repository fixture boundary. The H3 guard test also proves an attempted default
SQLite path fails before opening it.

| Included tests (relative to backend/src/providers)                                                                   | Reason safe                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `http/providerRateLimiter.test.ts`, `http/ProviderHttpClient.test.ts`                                                | Existing injected clock/sleep/transport baseline.                                       |
| `ProviderRegistry.test.ts`, `config/providerConfig.test.ts`                                                          | Synthetic config only; construct/inspect registry without real transport.               |
| `birdeye/BirdeyeAdapter.test.ts`, `helius/HeliusAdapter.test.ts`, `raydium/RaydiumAdapter.test.ts`                   | Injected fake fetch with fixed Response payloads.                                       |
| `das/DasMetadataAdapter.test.ts`, `solana-rpc/SolanaRpcAdapter.test.ts`                                              | Stubbed HTTP method results.                                                            |
| `quotes/QuoteBudgetPlanner.test.ts`, `quotes/QuoteProviderRouter.test.ts`, `jupiter/JupiterDemandController.test.ts` | Pure planning, fake adapters and controlled policy fixtures.                            |
| `ProviderHealthService.test.ts`                                                                                      | Synthetic results, temporary guarded H2 SQLite fixture and cleanup; no normal database. |
| `h3/H3Admission.test.ts`, `H3Adversarial.test.ts`, `H3Controls.test.ts`                                              | Controlled clocks/sleepers, capacity/queue assertions and bounded fault injection.      |
| `h3/H3HttpControls.test.ts`, `H3TimeBudget.test.ts`                                                                  | Fake transport/body/backoff; fake wall time and timers; no real network.                |
| `h3/H3RegistryOwnership.test.ts`                                                                                     | Real registry/HTTP/limiter with constructor-injected synthetic transport.               |
| `h3/H3Boundary.test.ts`                                                                                              | Source read/import audit plus forbidden fetch/env/database failure probes.              |

Existing direct cohort factories were inventoried from isolated source only and never invoked.
No broad provider/collector test glob was enabled. New H3 tests are the only owned glob.

## Named Acceptance Matrix

All names below refer to passing cases in the final H3 suite unless a compatibility command is
specified. The invariant mapping is H3-INV-01: T01-T04; INV-02: T03/T05; INV-03: T06-T09;
INV-04: T10/T11; INV-05: T05/T12; INV-06: T04/T13; INV-07: T12-T15; INV-08: T14/T15.

| ID  | Named evidence                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T01 | Existing `providerRateLimiter.test.ts` sequential baseline; `H3Admission.test.ts` retained H-03 simultaneous-sleeper regression.                                                                                                                                                                       |
| T02 | H3Controls: “preserves FIFO across multiple windows and independent providers”; H3Adversarial: “preserves FIFO when an admitted caller immediately submits a newcomer”.                                                                                                                                |
| T03 | H3Controls head/all-waiter cancellation cases; H3Adversarial: “middle/tail cancellation frees the global bound without disturbing the head”; idle reuse and stale callbacks retain eligible order.                                                                                                     |
| T04 | H3Controls exact 59999/60000 boundary and late 70000 wait; H3Adversarial 60001 wait, invalid/backwards clock and non-advancing/stale wake cases; H3TimeBudget wall-clock jump case.                                                                                                                    |
| T05 | H3RegistryOwnership: “shares Jupiter and Raydium endpoints within a registry but isolates their provider budgets”; “creates distinct default instances and shares only an explicitly injected instance”.                                                                                               |
| T06 | H3HttpControls pre-abort, queued cancellation, “abort after synchronous admission prevents fetch without refunding the slot”; H3Adversarial immediate deadline recheck.                                                                                                                                |
| T07 | H3Controls deadline at capacity; H3HttpControls deadline before capacity, “starts transport timeout only after queue admission”, in-flight abort, and “timeout wins when it precedes caller cancellation”.                                                                                             |
| T08 | H3Controls queue-bound/scheduler rejection; H3Adversarial middle/tail cancellation frees global capacity, stale legacy sleeper, real wake timer cleanup and broken non-advancing sleeper.                                                                                                              |
| T09 | H3Controls invalid caps and unlimited cap binding; H3Adversarial invalid queue bounds and conflicting positive-cap preservation; H3HttpControls invalid wait inputs; H3Adversarial deadline recheck/throwing clock.                                                                                    |
| T10 | H3HttpControls: “429 retries reacquire admission and preserve linear backoff and numbering”, network retry/nonretryable HTTP error, post-admission timeout and ordinary success cleanup.                                                                                                               |
| T11 | H3HttpControls local rejection without dispatch/retry, queued/full/deadline cases, body-read cancellation with late rejection, retry-backoff cancellation, five success/error cleanup variants, explicit retry-owner validation.                                                                       |
| T12 | H3TimeBudget RPM/retry/Birdeye default snapshot and reservation/cache/refusal/retry characterization; unchanged Birdeye adapter, quote budget/router, Jupiter demand and config suites.                                                                                                                |
| T13 | H3TimeBudget invocation/queue/headers/body timing, caught body failure, malformed JSON fallback, Birdeye cache/retry fixture whose payload has no provider publication time. Time/budget contract inventories the unknown source-time and legacy observation proxies without adding a timing envelope. |
| T14 | H3Boundary runtime dependency audit and forbidden network/environment/default-database probes; H3TestSetup guards; local realpaths/native audit and owned fixture cleanup.                                                                                                                             |
| T15 | Audited caller files above, unchanged H1/H2 dedicated suites, type/lint/format/secret/diff checks and bounded changed-path review.                                                                                                                                                                     |

## Commands And Results

Commands were run from the isolated root. TEMP/TMP were set to `.tmp/h3` for compatibility
runs; health fixtures always use the explicit H2 root regardless of ambient temp settings.

| Command                                                                                                                               | Result                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `node node_modules/vitest/vitest.mjs run --config backend/vitest.h3.config.ts`                                                        | 98 passed, 20 files; no skips/expected failures. |
| `node node_modules/vitest/vitest.mjs run --config backend/vitest.measurement-analysis.config.ts`                                      | 245 passed, five files; unchanged suite.         |
| `node node_modules/vitest/vitest.mjs run --config backend/vitest.h2.config.ts`                                                        | 194 passed, 22 files; unchanged suite.           |
| `node node_modules/typescript/bin/tsc -p backend/tsconfig.json --noEmit`                                                              | Pass.                                            |
| `node node_modules/typescript/bin/tsc -p shared/tsconfig.json --noEmit`                                                               | Pass.                                            |
| `node node_modules/typescript/bin/tsc -p frontend/tsconfig.app.json --noEmit`                                                         | Pass.                                            |
| `node node_modules/typescript/bin/tsc --noEmit --module NodeNext --target ES2022 --skipLibCheck --strict backend/vitest.h3.config.ts` | Pass.                                            |
| `node node_modules/eslint/bin/eslint.js . --ignore-pattern .pnpm-store/** --ignore-pattern .tmp/**`                                   | Pass.                                            |
| `node node_modules/prettier/bin/prettier.cjs . --check --ignore-path .gitignore --ignore-path .prettierignore`                        | Pass.                                            |
| `node scripts/check-secrets.mjs`                                                                                                      | Pass.                                            |
| `git diff --check`                                                                                                                    | Pass.                                            |

Versions: Node 24.17.0, TypeScript 5.9.3, Vitest 4.1.11, better-sqlite3 12.11.1, SQLite 3.53.2.
No dependency manifest/lockfile changes or provisioning were needed in H3.

## Source Identity And Review

Base revision: `f46eb26`. SHA-256 source fingerprint:
`cb4e0aef4bc6606f9815b4452f5f3f526a6a5215515886dec95c60a26ca2e2ce`.
It covers the 14 files below: four HTTP runtime files, all nine H3 fixture/test/setup files and
H3 config. For reproduction, sort relative paths lexicographically, compute each file's raw-byte
SHA-256, then hash UTF-8 rows `path<TAB>hash<LF>` including the final newline. Documentation is
excluded to avoid self-reference; H1/H2 borrowed fixture helpers remain unchanged at the base.

```text
backend/src/providers/h3/H3Admission.test.ts	3fe8d75a256279e5124406e871c5306c0e25b0b5b75d96b57d2e880c39886f65
backend/src/providers/h3/H3Adversarial.test.ts	bf41929913c7ec01710ae20e5031e8e08f460a830702da9048be88f8a3bf3ed8
backend/src/providers/h3/H3Boundary.test.ts	f42e1bd81fe05087669ee8f61b1f31b79f8f07973e5ada4351a0b3e4562a287c
backend/src/providers/h3/H3Controls.test.ts	e94173200a685a1a9ebb162422d801ccacd510580d0257fea7b5e57856b5f362
backend/src/providers/h3/H3FakeScheduler.ts	09f26df58150151a4ec1e4f2ea6ffe6c601c49ec35aa9b3b1d53804d953c44cb
backend/src/providers/h3/H3HttpControls.test.ts	17e9ac3e4388e224b5d46bd51df7991a33fc2a287ff88e2cf9060b5eeb194ffa
backend/src/providers/h3/H3RegistryOwnership.test.ts	32fa55290cb6d9bdd053a8c4c178e6fb430c4d7db03479a35bb57331408b2686
backend/src/providers/h3/H3TestSetup.ts	91fb73d0c3fb44f19d33a6fee5eefa5ed311c161876ff75882a8b229bd83bb5b
backend/src/providers/h3/H3TimeBudget.test.ts	6c461c6ae0290bbdbd3f0f27494bdb821fb097027eba0d4fc204bf3682ecf8c8
backend/src/providers/http/ProviderHttpClient.ts	68f378d10c127a79a1c0fa6a7e45a00a997ae4797dcb92dfd62fad6973c04e65
backend/src/providers/http/providerAbort.ts	78349ea51e76a45bec54a0a1bb09de0f19298f637b7d5657dc34fb319debc599
backend/src/providers/http/providerRateLimiter.ts	08fe9ea5228f8cc60747406f38b82d0436562c9a4911a78f6bef6c24b417b289
backend/src/providers/http/providerRetry.ts	9018c616f25b2a9c355ece5028ff993e4cac1e8205cbfa3ac2197d026a5f73ab
backend/vitest.h3.config.ts	4272315b89f0aa236640264de84539bb2339266c810e2e345a3a316efd5da0e3
```

Only the four HTTP-layer runtime files, H3 harness/fixtures and five H3/parent/handoff documents
plus the new verification/contract documents belong to this patch. No frozen protocol, launch,
collector source, archive, scheduler, schema, migration, shared-result definition, dependency
manifest/lockfile or H1/H2 test/harness was edited. The HTTP layer is a shared dependency of
cohort code: this is precisely why the isolated patch must not be deployed during frozen V3.

Review confirmed atomic reserve-before-resolve, eligible FIFO, same-provider cap binding,
independent provider queues, cancellation/deadline priority, no admission refund after grant,
no phantom pre-fetch HTTP attempt, bounded failures, timer/listener cleanup, unchanged ordinary
retry/fallback/config semantics and the explicit limits in the contract.

## Known Limits / Deferred Work

See [time/budget contract](./Phase-10.6H-H3-Provider-Time-And-Budget-Contract.md). In particular:

- Scope is one limiter instance, not account/host/process-wide or distributed enforcement.
- Cancellation controls are HTTP/retry opt-in, not a new end-to-end adapter/router protocol.
- Birdeye logical reservations are not wire-request or billed-CU caps. Its existing successful
  adapter mapping can drop HTTP attempt details; the characterization reports actual fake fetch
  count separately. Complete adapter attempt propagation is deferred.
- Legacy wall-clock latency and fetchedAt meanings remain, including headers/body asymmetry,
  unknown provider source time and frozen V3's observation-proxy naming. No backfill or envelope
  migration is implemented.
- Legacy injected sleepers/transports may ignore abort; owned timers/listeners are cleaned and
  stale callbacks/late rejection are handled, but arbitrary injected work cannot be forcibly stopped.

These are declared scope limits, not incomplete H3 implementation items. Any policy/schema or
research change needs its own versioned design and applicable approval.
