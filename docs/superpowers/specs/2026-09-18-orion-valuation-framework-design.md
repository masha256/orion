# Orion: Token Valuation Framework Design

Date: 2026-09-18
Status: Draft for review
Scope: Umbrella framework design. Implementation plan #1 covers sub-project 1 only (see section 11). Sub-projects 2 to 4 each get a short follow-up spec that builds on this document.

## 1. Purpose

Orion is a Node.js CLI with a SQLite backend that produces 6-month and 12-month price targets for crypto tokens whose projects have genuine revenue and value capture. Targets are emitted as structured JSON signals for other systems to consume.

Specialized AI analyst personas maintain the assumptions behind each target. A deterministic engine does all the math. The first covered asset is VVV (Venice AI). The framework must extend to other assets mostly through configuration.

### Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Agent vs math | A deterministic engine computes targets. The agent chooses and justifies assumptions, triages data problems, researches gaps, and writes rationale. The agent never writes a target. |
| Agent runtime | Inside the Orion CLI, calling the Claude API. Cron-schedulable and unattended. |
| Methodology | Blended valuation modules, run per scenario (bear, base, bull), with module disagreement reported as a signal field. |
| Market conditions | Orion never forecasts the market. Each scenario carries an explicit regime multiplier that scales multiple-based modules only. |
| Governance | Bounded autonomy. In-range changes are applied by the agent with cited rationale. Out-of-range and structural changes become proposals for the user. |
| Personas | One lead sector-analyst persona per asset. A persona may cover many assets. |
| Data | Free sources first, manual entry for gaps, and the agent may research unstructured disclosures and record them as provisional observations with citations. |
| Generality | VVV is the only asset built in v1. HYPE and AERO are design-time contrast cases and ship as synthetic test fixtures. |
| Output | Versioned JSON signals are the product. Human-readable reporting stays thin. |
| Architecture | Shared code modules behind one interface, plus declarative per-asset config. Custom per-asset modules are allowed for unique mechanisms. |
| Staking yield | Not part of the price target. Reported as a separate staked-holder total-return track. |
| Config storage | Human-authored content lives in files in git. Machine-written state lives in SQLite. |

## 2. System shape

### 2.1 Pipeline

```
fetchers -> observations -> drivers -> scenario forecast -> modules -> blend -> signal
                                            ^
                                   assumption set (versioned)
                                            ^
                              agent (bounded) and user (CLI)
```

### 2.2 Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `db` | Schema, migrations, typed accessors | nothing |
| `config` | Load and validate `assets/*.yaml`, `personas/*.md`, `skills/*.md`; compute content hashes | nothing |
| `ingest` | Fetcher plugins that write raw observations | db, config |
| `drivers` | Pure functions from observations to the standard driver vocabulary | db (read) |
| `engine` | Supply forecast, scenario forecast, modules, blend. Pure: no I/O, no LLM, no clock | drivers, assumptions |
| `signals` | Build, validate, persist, and emit versioned signal JSON | engine output |
| `agent` | Persona runner over the Claude API with a guarded tool layer | all of the above, through the same functions the CLI uses |
| `cli` | Command surface | all |

### 2.3 Invariants

1. **Reproducibility.** A valuation run records a snapshot ID (the frozen set of observation IDs), an assumption-set version, an engine version, and a config hash. Replaying those four inputs yields a byte-identical engine output.
2. **The agent never writes a target.** It writes assumptions (within bounds), proposals, anomaly resolutions, provisional observations, and journal entries.
3. **The driver vocabulary is the cross-asset contract.** Modules read drivers and assumptions only. They never see raw metrics, contract addresses, or asset identifiers.
4. **Files versus database.** Anything a human authors is a file in git. Anything a machine writes is a row in SQLite. Runs record the hash of the files they used.
5. **No invented data.** Fetchers never interpolate or fabricate. Missing data is handled by staleness rules and signal status.

## 3. Valuation methodology

### 3.1 Driver vocabulary

Every driver value carries provenance: `onchain`, `api`, `manual`, `provisional`, or `derived` (with the worst provenance among its inputs).

| Group | Driver | Meaning |
|---|---|---|
| Business | `revenue_run_rate` | Annualized USD revenue of the project |
| Business | `usage_index` | Asset-defined usage measure, informational in v1 |
| Capture | `holder_flows[]` | List of revenue-funded value flows reaching token holders. Each has `id`, `kind` (`burn`, `buy_and_hold`, `fee_share`), trailing annualized USD (trailing 90 days by default, window configurable per flow), `capture_rule`, and `recipient_base` |
| Capture | `capture_rate` | Sum of holder flows divided by `revenue_run_rate` |
| Capture | `capture_rule` | `contractual`, `programmatic`, or `discretionary`, per flow |
| Supply | `effective_supply` | Total supply net of burned tokens |
| Supply | `circulating_supply` | Informational, plus available as an alternative supply basis |
| Supply | `emission_schedule` | Step function of gross emissions per year, including announced future changes |
| Supply | `scheduled_unlocks` | Dated token unlocks (vesting, warrants) |
| Supply | `staked_ratio`, `locked_ratio` | Share of effective supply staked, and share locked in longer-term sinks |
| Supply | `staker_emission_share` | Share of gross emissions paid to stakers |
| Supply | `real_staking_yield` | Staker APR in tokens minus gross inflation rate |
| Market | `price`, `market_cap`, `fdv` | Spot values |
| Market | `peer_multiples` | Multiples for the asset's configured peer set |

### 3.2 Methodological positions

1. **Emissions yield is not value.** Newly minted tokens paid to stakers are a transfer from non-stakers and appear only as dilution in the supply forecast. Only revenue-funded flows count as holder flows.
2. **Per-token values use forecast supply at the horizon**, on an `effective_total` basis by default. `supply_basis` is overridable per asset (`effective_total` or `circulating`).
3. **Known schedules are data, not assumptions.** An announced emission cut or a vesting unlock is an observation. The agent cannot assume it away.
4. **Token and equity are different claims.** Where a company equity layer exists, project revenue does not belong to the token. The `capture_rate` and `capture_rule` drivers make the token's actual claim explicit, and modules that use project revenue as a basis must be labeled as market-convention estimates.

### 3.3 Scenarios and assumptions

Three scenarios (`bear`, `base`, `bull`) and two horizons (`6m`, `12m`). Scenario probabilities default to 25/50/25 and are structural (proposal required to change).

Assumption keys, each set per scenario, each with `min` and `max` bounds defined in the asset YAML:

| Key | Meaning |
|---|---|
| `rev_growth_y1` | Revenue growth over the next 12 months |
| `growth_fade_years` | Years over which growth fades linearly to terminal |
| `terminal_growth` | Long-run growth rate |
| `capture_rate_terminal.<flow_id>` | Long-run capture rate for a holder flow |
| `capture_ramp_years.<flow_id>` | Years to move linearly from the current to the terminal capture rate |
| `discount_rate_base` | Discount rate for a contractual flow |
| `discount_premium_programmatic`, `discount_premium_discretionary` | Added to the base rate according to `capture_rule` |
| `multiple.<module_instance_id>` | Multiple applied by a `forward_multiple` instance |
| `regime_multiplier` | Market regime scaling of multiple-based modules |
| `staked_ratio_horizon` | Expected staked ratio at the horizon, for the total-return track |
| Module-specific keys | Declared by custom modules, for example `diem_target_supply_growth` |

Revenue path: revenue grows at `rev_growth_y1` over the first 12 months from now. The annual growth rate then fades linearly to `terminal_growth` over `growth_fade_years`. Each flow's capture rate moves linearly from its current trailing value to `capture_rate_terminal.<flow_id>` over `capture_ramp_years.<flow_id>`.

### 3.4 Supply forecast

```
S(H) = effective_supply_now
     + emissions over [now, H] from emission_schedule
     + scheduled_unlocks falling in [now, H]   (only when supply_basis = circulating)
     - tokens burned over [now, H]
```

Tokens burned depend on the price path, which depends on the target. The engine resolves this with a deterministic fixed-point iteration: start with a flat path at spot, compute the target, rebuild the path as a linear interpolation from spot to the target, and repeat until the target changes by less than 0.1 percent or 20 iterations have run. Non-convergence sets signal status to `degraded`.

### 3.5 Modules

Each module instance is declared in the asset YAML with `id`, `type`, `kind`, `params`, and (for estimates) `weight`.

Module interface:

```
{
  type,
  kind: "estimate" | "component",
  requiredDrivers: [...],
  assumptionKeys: [...],
  compute({ drivers, assumptions, scenario, horizon, supplyAtHorizon })
    -> { valuePerToken, breakdown }
}
```

- An **estimate** is a standalone estimate of the full per-token value. Estimates are blended by weight.
- A **component** is an additive value stream that no estimate already covers. Components are summed on top of the blend.

**`holder_cashflow` (estimate, regime independent).** Present value at the horizon of forecast holder flows:

```
F_k(t)  = revenue(t) * capture_rate_k(t)               for each flow k
r_k     = discount_rate_base + premium(capture_rule_k)
V       = sum over k of [ sum over t=1..N of F_k(H+t)/(1+r_k)^t  +  TV_k/(1+r_k)^N ]
TV_k    = F_k(H+N) * (1+g) / (r_k - g)
value   = V / S(H)
```

N is 5 years. `recipient_base` is recorded in the breakdown. When the base is `locked` or `staked`, the aggregate value is still divided by total forecast supply, because any token may opt in. This is conservative and is stated in the breakdown.

**`forward_multiple` (estimate, regime sensitive).** `basis` is `revenue` or `holder_flow`:

```
value = basis over the 12 months following H * multiple * regime_multiplier / S(H)
```

An asset may enable two instances, one per basis. A `revenue` basis instance on an asset with an equity layer is a market-convention estimate, labeled as such in the breakdown.

**`utility_claim` (component, custom to VVV initially).** Values the entitlement of staked VVV to mint DIEM. DIEM that already exists is value already distributed to whoever minted it, so this module values only future issuance capacity:

```
issuance(t)      = growth in DIEM target supply per year, from diem_target_supply_growth
net_value(t)     = issuance(t) * (diem_value - cost_of_locking)
cost_of_locking  = PV of the 20 percent emissions-yield haircut on the sVVV locked per DIEM
                   at the marginal mint rate on the curve
value            = PV of net_value over N years / S(H)
```

`diem_value` follows the param `diem_value_basis`: `market` (DIEM spot) or `intrinsic` (perpetuity of 365 USD per year times a utilization assumption, at a discount rate). The module moves into the shared set when a second asset needs a utility-claim mechanism.

### 3.6 Blend and derived outputs

```
target_scenario  = sum(weight_i * estimate_i) + sum(component_j)     weights sum to 1
expected_target  = sum(probability_s * target_s)
dispersion       = (max estimate - min estimate) / sum(weight_i * estimate_i), per scenario
upside_pct       = expected_target / spot - 1
staked_total_return_pct = (expected_target / spot) * (1 + y)^(H in years) - 1
    where y = gross emissions per year * staker_emission_share / (staked_ratio_horizon * S(H))
```

Asset-specific return variants (for VVV, DIEM-locked stake at 80 percent of normal yield) are emitted under `extras`.

### 3.7 Contrast cases

These are design-time tests of generality. Mechanism details come from memory and one confirming search, and must be re-verified before either asset is actually covered.

| Asset | What it forces into the design | Expressible as config only |
|---|---|---|
| VVV | Utility claim as an additive component, discretionary capture rule, equity layer, manual revenue, net inflation | No: needs the custom `utility_claim` module |
| HYPE | `buy_and_hold` or `burn` flow with a programmatic rule and capture near 100 percent, on-chain revenue, large `scheduled_unlocks` | Yes |
| AERO | `fee_share` flow with `recipient_base = locked`, emissions large enough that dilution dominates the supply forecast | Yes |

HYPE and AERO ship as fixture YAML configs with synthetic observations in the engine test suite.

## 4. VVV reference data (as of 2026-09-18)

Gathered by a research pass on 2026-09-18. Confidence: **A** confirmed that day from a primary source (contract call, contract log, Venice API, Venice docs or blog), **B** reputable secondhand, **C** inferred or unverified. All values must be re-fetched by Orion; they are recorded here to justify design choices.

### 4.1 Facts that shaped the design

- [A] Effective total supply 81.0M VVV (ERC-20 `totalSupply` 114.88M minus 33.88M held at the zero address). No max supply. Circulating about 48.1M to 48.4M. About 32.6M non-circulating, apparently in Venice-held wallets (wallet list is inferred, [B]).
- [A] Emissions 2.5M VVV per year since 2026-09-01, after six cuts from about 10M in 2025-08. A cut to 2.0M on 2026-10-01 is announced on the Venice blog and not yet on-chain.
- [A] Staked 33.96M VVV (41.9 percent of effective supply). Blended staking APR 6.97 percent. Unstake cooldown 7 days. Venice takes 0 percent of emissions on unlocked stake and 20 percent on DIEM-locked stake.
- [A] DIEM: supply 37,760, of which 75.5 percent staked for credits. 8.97M sVVV locked behind DIEM. Marginal mint rate about 500 VVV per DIEM, following `90 * e^(2 * (supply/target)^3)` against a target supply of 40,000. One staked DIEM gives 1 USD per day of API credit. DIEM trades freely (about 2,058 USD).
- [A] Burns are transfers to the zero address. Three channels: discretionary buybacks from revenue (share undisclosed), per-new-subscription burns (2, 5, or 10 USD), and 5 percent of credit purchases. August 2026 revenue-funded burns: 55,498 VVV, about 703k USD. Cumulative revenue-funded burns about 2.79M USD.
- [C] At August's pace burns are about 0.67M VVV per year against 2.5M emitted, so VVV is net inflationary. Burns are roughly 8 percent of a 100M USD revenue run rate. Both are derivations, not disclosures.
- [B] Revenue: over 70M USD annualized (TechCrunch, 2026-07-01), 100M USD annualized (founder post on X, 2026-08-17, read via press quote). Revenue settles off-chain. There is no revenue or usage API.
- [B] Series A of 65M USD at a 1B USD valuation closed 2026-07-01. Reported investor token terms (1.5M VVV vesting plus a 5M VVV warrant) are unconfirmed by Venice.
- [A] Spot 27.46 USD, market cap about 1.32B USD, FDV about 2.22B USD.

Design consequence: the `holder_cashflow` estimate for VVV will sit far below spot, and the `forward_multiple` revenue-basis estimate will sit near it. Dispersion is therefore a first-class signal field, and blend weights are structural.

### 4.2 Contracts on Base

| Contract | Address |
|---|---|
| VVV token | `0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf` |
| Staking / sVVV proxy | `0x321b7ff75154472B18EDb199033fF4D116F340Ff` |
| DIEM token | `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` |
| Burn sink | `0x0000000000000000000000000000000000000000` |
| Treasury Safe | `0x2D8CB8DC596daD0e1E34E2042E7ae6Df93B11524` |

### 4.3 Metric sources for VVV

| Metric | Primary | Cross-check |
|---|---|---|
| Effective supply, cumulative burned | `base-rpc`: `totalSupply()`, `balanceOf(0x0)` | `venice-api` `vvv_stats`, `vvv_burn_stats` |
| Burn flow in tokens | `base-rpc`: `Transfer` logs to the zero address | DefiLlama holders revenue (`/summary/fees/venice`) |
| Burn flow in USD, monthly | `venice-api` `vvv_burn_history` | DefiLlama |
| Staked, locked for DIEM | `base-rpc`: staking `totalSupply()`, `totalLockedStakedVVV()` | `venice-api` `vvv_stats` |
| Emission rate and history | `base-rpc`: `emissionRatePerSecond()`, `EmissionRateUpdated` logs | `venice-api` `vvv_staking_yield` |
| Venice share of emissions | `base-rpc`: `veniceEmissionsPercentage*()` | none |
| DIEM supply, staked DIEM, mint curve | `base-rpc`: DIEM `totalSupply()`, `totalStaked()`, staking `getDiemAmountOut()`, `diemSupply(i)`, `diemMintRates(i)` | `venice-api` `diem_stats` (its target-supply field looked stale) |
| Price, market cap, FDV (VVV and DIEM) | `coingecko`: ids `venice-token`, `diem` | `venice-api` `vvv_stats` |
| Revenue run rate, users, API calls, tokens processed | `manual` or agent-researched `provisional` | burn-derived revenue proxy |
| Future emission schedule, burn policy parameters, investor token terms | `manual` | none |

The Venice JSON API (`https://outerface.venice.ai/api/app/vvv/`) is undocumented and unauthenticated. It may change without notice, so it is never the sole source for a required driver except monthly burn USD, which has DefiLlama as a fallback.

**Revenue proxy.** Credit burns times 20 estimates credit purchases; subscription burns divided by the per-tier amount estimates new paid subscriptions. It needs burn category labels, which come from an unofficial community source (venicestats.com) or from classifying burn sizes on-chain. It is a low-confidence sanity check on disclosed revenue and is never the primary revenue driver.

## 5. Data model

### 5.1 Files (human-authored, in git)

```
assets/vvv.yaml          contracts, external ids, supply_basis, metric definitions
                         (unit, fetcher, cadence, staleness limit, tolerance, allow_provisional,
                         criticality), driver mappings, module instances and weights,
                         scenario probabilities, assumption bounds, review triggers, peer set
personas/<name>.md       frontmatter (name, model, temperament, sectors) + system prompt
skills/<name>.md         frontmatter (name, description, run_types) + instructions
```

Approved structural proposals are applied by Orion editing the YAML; the user commits the change.

### 5.2 SQLite tables (machine-written)

History tables are append-only.

| Table | Contents |
|---|---|
| `coverage` | asset id, lead persona name |
| `observations` | asset, metric key, observed-at, value, source, status (`confirmed`, `provisional`, `rejected`), citation URL, quoted text, fetched-at, `superseded_by` |
| `anomalies` | asset, metric, the disagreeing observation ids, magnitude, status (`open`, `resolved`, `acknowledged`), resolution note |
| `fetch_runs` | fetcher, asset, started, ended, outcome, error |
| `assumption_sets` | asset, version, parent version, author (`user` or persona name), rationale, created-at |
| `assumptions` | set id, key, scenario, value |
| `assumption_evidence` | assumption change, cited observation ids |
| `proposals` | asset, persona, change (JSON), rationale, status, decided-at |
| `snapshots` | asset, created-at, observation ids |
| `valuation_runs` | asset, snapshot id, assumption-set id, engine version, config hash, output JSON |
| `signals` | run id, schema version, status, payload JSON, emitted-at |
| `agent_runs` | persona, asset, run type, trigger, config hash, transcript, token usage, outcome |
| `journal` | asset, persona, created-at, entry (running thesis and open questions) |

## 6. Ingestion

Fetcher interface: `{ id, provides: [metricKeys], fetch(asset, ctx) -> Observation[] }`.

v1 fetchers: `base-rpc` (viem), `venice-api`, `coingecko`, `defillama`, `manual`.

Rules:

- **Primary plus cross-check.** When sources disagree beyond the metric's tolerance, an anomaly is written. The primary value is still stored.
- **Provisional data.** Agent-researched observations are stored as `provisional` with a citation URL and the quoted text. They are excluded from the live signal until `orion data confirm`. A metric with `allow_provisional: true` lets unattended runs use them, and the signal's data-quality grade reflects it. VVV's revenue metric ships with `allow_provisional: true`.
- **Staleness.** Each metric has a limit. A stale metric downgrades the signal and triggers an agent review.
- **Isolation.** Each fetcher fails independently. A failure is recorded in `fetch_runs` and the last good observation remains in force until it goes stale.

## 7. Agent layer

### 7.1 Personas and skills

A persona is a markdown file: role, sector expertise, temperament, and model (default: the latest Claude model, overridable). Skills are markdown instruction documents, each declaring the run types that load it. Initial skills: `assumption-review`, `anomaly-triage`, `disclosure-research`, `tokenomics-audit`, `peer-multiple-selection`.

### 7.2 Run types

`orion agent run <asset> --type weekly|triage|deep`

| Type | When | Purpose |
|---|---|---|
| `weekly` | Scheduled weekly | Review driver changes against assumptions, research stale manual metrics, adjust within bounds |
| `triage` | Event-triggered | Resolve a specific anomaly, threshold breach, or new provisional observation |
| `deep` | Scheduled monthly | Re-underwrite the full thesis, review peer set and multiples, file structural proposals |

Run steps: build the context pack (driver changes since the last run, open anomalies, stale metrics, current assumptions with bounds, last signal, journal), run the tool-use loop, commit a new assumption-set version if anything changed, run the engine, emit a signal with a rationale summary.

### 7.3 Tools

| Group | Tools |
|---|---|
| Read | `get_drivers`, `get_observations`, `get_anomalies`, `get_assumptions`, `get_signal_history` |
| Think | `run_whatif(overrides)`: engine output, nothing persisted |
| Write | `apply_assumption_change`, `propose_change`, `resolve_anomaly`, `record_provisional_observation`, `write_journal` |
| Research | web search and web fetch |

### 7.4 Guardrails (enforced in the tool layer, not the prompt)

- An out-of-bounds value is converted into a proposal.
- **Max step per run:** one run may move an assumption by at most a configured fraction of its range (default 25 percent).
- Every assumption change must cite at least one observation id as evidence.
- Any open anomaly on the asset blocks all assumption writes for that asset until it is resolved or acknowledged.
- Module weights, module enablement, scenario probabilities, bounds, and `supply_basis` are proposal-only.
- Each run has a token budget and a turn budget.
- All writes in a run are staged in one transaction and commit only on a clean finish.
- Tool inputs are schema-validated.

Web content fetched during research is untrusted data. It can yield provisional observations with citations; it can never issue instructions to the agent, and nothing from it bypasses the guardrails above.

## 8. Cadence

| Loop | Cadence | Cost |
|---|---|---|
| Ingest | Daily, with per-metric cadence in the asset YAML | Free |
| Engine re-run and signal | After every ingest | Free |
| Agent `weekly` | Weekly per asset | Tokens |
| Agent `deep` | Monthly per asset | Tokens |
| Agent `triage` | On trigger | Tokens |

Triggers, with per-asset thresholds in YAML: open anomaly, a driver deviating from its assumption-implied path by more than a threshold (default 25 percent), a staleness breach on a critical metric, a new provisional observation, and a dated event on the asset calendar (for VVV, the 2026-10-01 emission cut).

**Who evaluates triggers.** Orion does, not the user. After each ingest and engine re-run, the scheduled job evaluates the trigger conditions and, when one fires, launches a `triage` run with the trigger as context. Automatic evaluation is delivered in sub-project 4; until then the user checks `orion data anomalies` and launches triage manually.

**One process.** CLI commands are thin wrappers over library functions. The scheduled entry point (`orion tick`, sub-project 4) runs ingest, engine, trigger evaluation, and any triggered agent run as in-process function calls in sequence. It never spawns a second `orion` process. A failed agent run is caught and rolled back, and the data-only signal for that tick is still emitted. A per-asset run lock (a SQLite row) prevents overlapping runs; a run that finds the lock held exits cleanly with a `run_in_progress` outcome.

**Manual triage.** The user can launch a triage run at any time for events Orion's data cannot see (an announcement, a funding round, an outage): `orion agent run <asset> --type triage --note "<text or url>"`. The note is a lead for the agent to verify through research, not a fact. It cannot itself be cited as evidence for an assumption change.

Cadence follows how often fundamental information arrives. Assets with daily on-chain revenue tighten thresholds; the calendar stays the same.

## 9. Signal schema v1

```
{
  schema_version: 1,
  signal_id, asset, generated_at,
  status: "ok" | "degraded" | "blocked",
  status_reasons: [...],
  spot: { price, ts },
  horizons: {
    "6m": {
      expected_target, upside_pct,
      scenarios: { bear|base|bull: { target, probability } },
      modules:   { <instance_id>: { type, kind, weight, value, breakdown } },
      dispersion,
      staked_total_return_pct,
      extras: { ... }
    },
    "12m": { ... }
  },
  data_quality: { grade, stale_metrics, provisional_metrics, open_anomalies },
  change: { prev_signal_id, target_delta_pct, cause: "data"|"assumptions"|"both"|"none", rationale },
  provenance: { run_id, snapshot_id, assumption_set_version, engine_version, config_hash }
}
```

Data-quality grade:

| Grade | Condition |
|---|---|
| A | All required drivers from `onchain` or `api`, fresh, no open anomalies |
| B | Some required drivers from confirmed `manual` observations, all fresh |
| C | A provisional observation is in use, or a non-critical metric is stale |
| D | A critical metric is stale, or an anomaly is open on a critical metric |

Status: `blocked` when a required driver is missing (horizons omitted, reasons listed); `degraded` for grade D or supply-forecast non-convergence; otherwise `ok`. A signal is always emitted so consumers never have to interpret silence. Breaking schema changes increment `schema_version`.

v1 delivery is stdout and JSONL file. Webhooks belong to sub-project 4.

## 10. CLI surface

Every command supports `--json`.

```
orion init
orion asset    list | show <id> | validate [id]
orion persona  list | show <name> | assign <asset> <name>
orion data     fetch [asset] | set <asset> <metric> <value> --source --at
               | confirm <obs> | reject <obs> | show <asset> [metric] | anomalies [asset]
orion model    run <asset> | whatif <asset> --set key=value
               | assumptions show|set|history <asset>
               | proposals list|approve|reject
               | replay <run_id>
orion agent    run <asset> --type weekly|triage|deep [--note <text>] | runs list|show
orion signal   latest <asset> | history <asset> | emit <asset> [--out file]
```

## 11. Build order

Each sub-project has its own spec (this document for the first), plan, and implementation cycle.

1. **Core and engine.** `db`, `config`, `drivers`, `engine`, `signals`, CLI, and the `manual` fetcher. Goal: a reproducible VVV signal from hand-entered data, with HYPE and AERO fixtures passing. Includes first calibration of VVV assumption values and bounds with the user.
2. **Ingestion.** `base-rpc`, `venice-api`, `coingecko`, `defillama` fetchers, cross-checks, anomalies, staleness, revenue proxy.
3. **Agent.** Persona runner, tool layer with guardrails, skills, journal, research with provisional observations.
4. **Scheduling and delivery.** Cron entry points, triggers, webhook delivery.

## 12. Testing

- **Engine.** Golden tests over fixture snapshots. Property tests: more emissions lowers per-token value, higher growth raises the target, a regime multiplier leaves `holder_cashflow` unchanged. HYPE and AERO fixture configs prove config-only extensibility. A replay test asserts byte-identical output for a stored run.
- **Drivers.** Unit tests from fixture observations, including provenance propagation.
- **Fetchers.** Tests against recorded responses. One opt-in live smoke command.
- **Agent.** Guardrails (bounds, max step, evidence requirement, anomaly block, transaction rollback) tested with no LLM. The loop tested with a scripted fake model. CI makes no live API calls.
- **Signals.** Schema validation on every emitted signal, including `blocked` and `degraded` cases.

## 13. Stack

Node 22+, TypeScript, better-sqlite3, commander, zod, yaml, viem, vitest, Anthropic SDK.

## 14. Out of scope for v1

- Forecasting BTC or the overall market.
- Relative (pair) targets against a benchmark.
- Analyst committees or multi-persona debate.
- Paid data providers.
- Human-facing research reports beyond a plain CLI summary.
- Trade execution. Orion emits signals only and is not investment advice.
