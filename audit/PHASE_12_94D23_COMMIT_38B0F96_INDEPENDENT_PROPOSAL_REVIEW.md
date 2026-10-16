# NeXusTrade - Phase 12.94-D.2.3 Independent Proposal Review

**Review target:** audit/PHASE_12_94D2_MILESTONE_D23_PROPOSAL.md, documentation commit `38b0f96` (as reported by Antigravity).
**Date:** October 16, 2026.
**Decision:** Directionally approved for a limited Fedora-based observational pilot, **not yet implementation-ready**. Request one bounded proposal addendum incorporating D23-A01 through D23-A05. Do not reopen D.2.2.

## Accepted direction

- Separate read-only research collector, no wallet/keys/signing, no PAPER daemon restart, no Gen2.
- Isolated session files and forward outcome observations, explicit rate/storage limits, stop controls.
- Two-hour initial pilot is a reasonable _data-availability smoke test_, not a strategy profitability study.
- The user reports the prior Fedora endurance run was stopped and wants to use that Fedora laptop for the next _separately authorized_ pilot. Confirm no old process remains; preserve old data unchanged.

## D23-A01 - Candidate discovery cannot be assumed to be a complete new-pool feed (blocking before pilot)

The proposal uses `GET /token-profiles/latest/v1` and calls the result 'latest Solana pools' with filtering for Raydium AMM v4. DexScreener's documented profile response contains `chainId`, `tokenAddress`, and profile data; it does not, by itself, supply pair address, DEX or AMM program identity. It is not a comprehensive stream of newly created Solana liquidity pools. Resolve token-to-pair through a documented pair lookup, verify the exact AMM family, and explicitly state the candidate selection population and resulting selection bias. Do not label screened profiles as original trading strategy decisions. Solana public keys are case-sensitive base58: never lowercase mint, vault or pool public keys. Preserve exact identities and validate base58/owner/program as applicable.

## D23-A02 - Point-in-time timestamps need actual provider provenance (blocking)

`pairCreatedAt` is pair creation time, not price/reserve update time. An HTTP `Date` header is a response/server date, not evidence of the underlying market-data source time. Solana RPC token-balance responses return a context slot, which does not automatically imply a precise millisecond source timestamp. Preserve request dispatch, local receipt, provider fields if truly available, context slot, commitment and any verified block-time association separately. Mark unavailable event/update timestamps as unknown, rather than synthesize attested causality. Construct a discovery/decision record only _after_ required observation receipt; otherwise a read performed after an earlier decision cannot be labeled a decision-time feature. Follow-up observations at +60 s/+300 s are outcomes, not contemporaneous features. Quarantine and report causality violations instead of claiming zero violations by dropping the denominator.

## D23-A03 - On-chain pool reserves and hypotheses need proof, not inferred coverage (blocking for H1 claim)

Solana RPC `getTokenAccountBalance` requires an actual SPL token-account public key. `getMultipleAccounts` returns account data for supplied addresses; neither call discovers the authoritative base and quote vaults of a pool automatically. Verify program type (Raydium AMM v4 vs CLMM or another design), actual base/quote mint, vault addresses and ownership, reserve decimals, and slot coherence. If the mapping cannot be verified, label H1/H4 on-chain reserve evidence UNAVAILABLE; do not infer raw reserves from DexScreener USD liquidity. H3 developer holdings, LP burn and wallet authority are not available from the named DexScreener pair payload or raw vault balance reads; make them explicitly out of scope/unverified for this smoke pilot. Maintain accepted H1=depth/impact; H2=order flow; H3=structural risk; H4=capacity sizing, and distinguish field availability from statistical hypothesis validation.

## D23-A04 - Reuse accepted data contracts without undermining closed mock-only D.2.2

D.2.2 intentionally rejects all non-mock providers. A real adapter cannot simply be injected into its `ShadowCollectorEngine` while claiming D.2.2 remains closed. Plan a separate versioned read-only live collection runner/adapter boundary under D.2.3 (or request an explicit bounded interface change before any edit to closed code). Share only accepted schemas, validators and export/import contracts as permitted. Keep original D.2.2 module unchanged. Use established tier semantics: Tier 1 observed market states, Tier 2 synthetic reserve quotes, Tier 3 live provider/aggregator quote evidence (unauthorized), Tier 4 simulated fills, Tier 5 real execution (prohibited). Keep accepted canonical `ACTIVE`, `FINALIZED`, `INTERRUPTED` status semantics; do not invent `CRASHED` or `COMPLETED` as canonical statuses. Preserve the full decision/evaluation five-tuple identity, not just decisionId+poolId. Do not describe dual-file consensus as cryptographic authentication unless actually implemented and independently verified.

## D23-A05 - Pilot gates and Linux reproducibility need bounded realistic targets

Approve a two-hour source-and-schema smoke test as first separate run **after code and operator approval**. A 100-candidate/20-pool target and 85% reserve completeness are hypotheses about availability, not guaranteed achieved rates or proof of statistical significance. Treat unmet targets as measured research outcomes and revise the pilot from observed coverage. A 14-day collection requires another deliberate go/no-go after the smoke test, a frozen collection manifest/config, observed API budget/cost, storage quota sized for actual throughput, suspend prevention, disk space, health checks, and stop/recovery tests. Public RPC is rate-limited and not guaranteed for multi-day reliability. A 128 MB process RSS budget may be unrealistic for Node; benchmark and set an explicit ceiling. Pin the collector to a Git commit/tag and experiment config on Fedora, develop on a separate Windows branch, do not pull new code into the running process. On completion transfer read-only session data with a SHA-256 manifest and schema/version metadata; validate on Windows before research. The user reports the old Fedora endurance run was canceled: verify it is stopped, do not overwrite historical artifacts.

## Documentation references checked

- DexScreener official API reference: https://docs.dexscreener.com/api/reference (profile field shape; profiles 60/min; pair/token lookups 300/min)
- Solana getMultipleAccounts: https://solana.com/docs/rpc/http/getmultipleaccounts (addresses supplied by client, context slot)
- Solana getTokenAccountBalance: https://solana.com/docs/rpc/http/gettokenaccountbalance (SPL token-account public key; token balances and slot)
- Solana public cluster limits: https://solana.com/docs/references/clusters (rate-limited, not production guaranteed)
- D.2.3 user-provided proposal, sections 2-10, especially sections 3-6, 8-10.

## Operational boundaries

This review authorizes **no network calls, no live adapters, no collecting, no trading**. The next permissible task is a short D.2.3 proposal addendum or amended proposal addressing exactly the five named design conflicts. Once reviewed, a separately approved D.2.3 implementation may be written and tested offline before a separately approved live smoke test. Keep Gen1 wallet 7.9259 SOL and canonical hash unchanged; keep Windows PAPER daemon paused and Gen2 deferred. Preserve closed milestones and historical Fedora files.

## Parallel-development policy during a later 14-day run

**Allowed independently on Windows:** code cleanup with regression tests, quantitative analysis and backtest tooling, strategy-variant experimentation using frozen/historical datasets, model and report improvements, documentation and UI work. **Do not alter the running collector version, live cohort definitions, labels, timestamp logic, or historical files.** Baseline strategy and dataset ingestion schemas must be versioned to make experiments comparable. Changes to execution or trading code remain subject to independent review and separate operational authority.
