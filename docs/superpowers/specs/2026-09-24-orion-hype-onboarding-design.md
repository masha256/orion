# Orion sub-project 7: HYPE onboarding

Date: 2026-09-24. Status: executed, merged, calibrated and live (first signal 2026-10-03; the follow-ups note has the figures); planned (`docs/superpowers/plans/2026-09-24-orion-hype-onboarding.md`, generated from a per-task prototype and verified by extraction); section 11 records the planning amendments and section 12 the execution amendments.

Extends `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (section 3.7, the HYPE contrast case), `docs/superpowers/specs/2026-09-19-orion-ingestion-design.md` (sources, adapters, the HTTP transport), `docs/superpowers/specs/2026-09-22-orion-research-first-design.md` (the DefiLlama flow primary, the bootstrap, the inbox), and `docs/superpowers/specs/2026-09-23-orion-aero-onboarding-design.md` (the `flow_annualized` derived source, the onboarding sequence, the calibration method). Where this document and those differ, this one wins for the items it covers.

## 1. Purpose and scope

Cover HYPE (Hyperliquid) as Orion's third live asset, through configuration plus two small ingest additions. The user's rule applies: Claude drafts the asset file, the persona, and the calibration and asks only decision questions; nothing is entered by hand.

In scope:

1. `assets/hype.yaml`: every metric fetched but one, one holder flow, two modules, key-wide bounds; agent bands after calibration.
2. A POST method on the HTTP transport: the Hyperliquid info API is POST only.
3. Three `hype` adapters, none needing an RPC: effective supply, staked supply, and the annual emission rate, all from the info API.
4. A persona for perpetuals exchanges with a fee-funded buyback, `perp-exchange-analyst`.
5. The onboarding sequence: dry fetch, first tick and bootstrap, calibration by sweep, bands, first signal, the Hermes job line.

Out of scope: an on-chain cross-check of the flow from the Assistance Fund's balance (section 10); an unlock schedule (moot under the effective-total basis, section 1); any engine change; the HLP share and deployer shares (supply-side, not holder flows).

### Decisions made during brainstorming (2026-09-24)

- Approach: adapters over a POST-capable transport. Not a `method`/`body` extension of `http_json` (the supply needs a subtraction over a list, the stake a sum over validators, the emission rate a formula, so adapters are needed anyway) and not manual metrics researched by the bootstrap (weekly provisional rows for figures an API publishes).
- Flow kind: `burn`. The docs say fund HYPE is burned; the chain still counts it in total supply and the fund's balance grows daily. It behaves as a burn as long as nobody can spend it: the engine shrinks the supply forecast by the fund's purchases and today's effective supply nets the fund. The alternative, `buy_and_hold`, would leave the supply path unshrunk on the effective-total basis. Risk: repurposing of the fund by validator vote (section 10).
- Supply basis: `effective_total`, as for VVV and AERO: total supply minus the fund and the two dead addresses. The unvested contributor tokens are inside it, so no unlock schedule is needed (the engine adds scheduled unlocks on the circulating basis only).
- Modules: `holder_cashflow` 0.6, `forward_multiple` on holder flow 0.4; scenario probabilities 25/50/25. Revenue and the holder flow are one series (DefiLlama's revenue and holders revenue for `hyperliquid` are identical), so no revenue-basis multiple: it would price the same dollars twice.
- Persona: a new `perp-exchange-analyst`, not the DEX persona: the mechanisms (fee tiers, HIP-3 deployer shares, the fund, staking from a reserve) are an exchange's, and the chain is the protocol's own.

## 2. Reference data (as of 2026-09-24)

Gathered by the research pass of 2026-09-22 (`docs/research/tokens/hype.md`, the user's untracked folder) and live reads on 2026-09-24. Confidence: **A** read from the chain's API or an API that day, **B** reputable secondhand, **C** inferred or unverified. All values must be re-fetched by Orion; they are recorded here to justify design choices.

### 2.1 Facts that shaped the design

- [A] Price 92.36 USD (CoinGecko and DefiLlama's coins endpoint agree to the cent). Market cap 20.5B USD on CoinGecko's circulating figure; 87.9B USD on effective supply.
- [A] Supply, from the info API's `tokenDetails` for the HYPE token id `0x0d01dc56dcaaca66ad901c959b4011ec`: max 1,000,000,000; total 998,912,928; circulating 298,735,267 (the API's definition); future emissions reserve 411,315,831. Non-circulating balances listed by the API: 241,408,952 at `0x43e9abea1910387c4292bca4b94de81462f8a251` (unvested contributor and foundation tokens, attribution [C]), 47,451,201 at the Assistance Fund `0xfefefefefefefefefefefefefefefefefefefefe`, 1,674 at the zero address, 3 at `0x...dead`. Effective supply = total minus the fund and the two dead addresses = 951,460,050.
- [A] CoinGecko: circulating 222,445,714; total 955,307,079 (nets the fund by its own accounting, 0.4 percent above the figure above); max 1B. The two circulating definitions differ by 34 percent, so the circulating metric is informational and has no cross-check.
- [A] The Assistance Fund's HYPE balance from `spotClearinghouseState`: 47,451,201 HYPE, entry notional 1,315,861,195 USD (an average cost of 27.73 USD). The balance was 47,419,087 on 2026-09-22: it grows by about 16,000 HYPE a day.
- [A] Fees (docs, `trading/fees.md`, read 2026-09-24): "fees are entirely directed to the community (HLP, the assistance fund, and deployers)"; spot and HIP-3 deployers "may choose to keep up to 50% of trading fees generated by their deployed assets"; the fund "converts trading fees to HYPE in a fully automated manner as part of the L1 execution. HYPE in the assistance fund is burned, removing the tokens permanently from the circulating and total supply." The chain's form contradicts the last sentence: total supply is 998.9M and the fund's balance is listed and growing.
- [A] DefiLlama `hyperliquid` (parent of `hyperliquid-perps`, `hyperliquid-spot-orderbook`, `hyperliquid-hlp`), 2026-09-24: holders revenue 30d 57,216,066 USD, 1y 691,540,591, all time 1,274,061,500; revenue identical; fees 30d 73,385,371, 1y 915,512,812. The last 90 days sum to 140.5M USD (a 570M USD run rate); median day 1.38M, largest day 4.94M, the last twelve days 0.6M to 3.7M. Methodology (perps): "99% of fees go to Assistance Fund for buying HYPE tokens, excluding builders fees"; supply side "1% of fees go to HLP Vault suppliers, before 30 Aug 2025 it was 3% + fees for builders", plus HIP-3 deployer distributions and maker rebates. Methodology (spot): "97% of spot trading fees before 30 Aug 2025 and 99% thereafter go to Assistance Fund for buying HYPE tokens, excluding unit protocol fees; HYPE paid in successful HIP-1 token-deployment auctions is burned."
- [A] Staking (docs, `hypercore/staking.md`, read 2026-09-24): "the reward rate is inversely proportional to the square root of total HYPE staked. At 400M total HYPE staked, the reward rate is approximately 2.37% per year. Staking rewards come from the future emissions reserve." Total stake from `validatorSummaries`: 35 validators, stake summed 441,834,995 HYPE (the field is an integer in 8-decimal units). Rate at that stake: 2.37 percent times the square root of 400M over 441.8M = 2.255 percent; emissions about 9.96M HYPE a year. All of it goes to stakers: the staker emission share is 1.0 by construction.
- [B] Vesting: core-contributor tokens vest monthly after a one-year cliff from the 2024-11-29 genesis; the next release is dated 2026-10-06 (tokenomist); monthly sizes are not published ([C]: roughly 238M over about 24 months). Under the effective-total basis these tokens are already in supply.
- [B] Monthly holders revenue for perps fell from 107.5M USD (2025-08) to 37M to 58M USD a month through 2026 (DefiLlama chart, 2026-09-22).
- [A] Market multiple: effective supply times price is 87.9B USD, about 154 times the 90-day run rate and 127 times the trailing year. The user has heard that the calibrated base case will sit far below spot at any ordinary discount rate; the gap is the market's growth view and belongs in `rev_growth_y1` and the multiple.

### 2.2 Endpoints

| Read | Request | Field |
|---|---|---|
| Token details | POST `https://api.hyperliquid.xyz/info` body `{"type":"tokenDetails","tokenId":"0x0d01dc56dcaaca66ad901c959b4011ec"}` | `totalSupply` (string), `nonCirculatingUserBalances` (array of `[address, balance]` strings), `circulatingSupply`, `futureEmissions` |
| Fund balance | POST the same URL, body `{"type":"spotClearinghouseState","user":"0xfefefefefefefefefefefefefefefefefefefefe"}` | `balances[coin == "HYPE"].total` (string) |
| Validators | POST the same URL, body `{"type":"validatorSummaries"}` | `stake` per validator (integer, 8 decimals) |
| Price cross-check | GET `https://coins.llama.fi/prices/current/hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec` | `coins.hyperliquid:0x0d01dc56dcaaca66ad901c959b4011ec.price` |
| Flow | DefiLlama `hyperliquid`, `dailyHoldersRevenue` | daily series |

The info API is undocumented for rate limits; a tick posts three requests.

## 3. The asset file

`assets/hype.yaml`: `id: hype`, `symbol: HYPE`, `name: Hyperliquid`, no `chain` and no `ingest` (nothing is read over an RPC), `supply_basis: effective_total`, `external_ids: { coingecko: hyperliquid, defillama: hyperliquid, hyperliquid_info: "https://api.hyperliquid.xyz/info", hyperliquid_token: "0x0d01dc56dcaaca66ad901c959b4011ec" }`, `contracts: { assistance_fund: "0xfefefefefefefefefefefefefefefefefefefefe", unvested: "0x43e9abea1910387c4292bca4b94de81462f8a251", zero: "0x0000000000000000000000000000000000000000", dead: "0x000000000000000000000000000000000000dead" }` (named addresses for the adapters' params and the persona; `unvested` is documentation only).

| Metric | Type, unit | Source | Cross-check | Notes |
|---|---|---|---|---|
| `price_usd` | level, usd, critical, staleness 3 | coingecko `hyperliquid` price | http_json `coins.llama.fi/prices/current/hyperliquid:0x0d01...1ec`, path `coins.hyperliquid:0x0d01...1ec.price`, 2 percent | |
| `effective_supply` | level, tokens, critical, staleness 7 | adapter `hype.effective_supply`, params `{ subtract: [assistance_fund, zero, dead] }` | none (CoinGecko's total is 0.4 percent apart by a different accounting; a 1 percent check would pass today and fail on the next definitional change, so it stays out) | total minus the fund and the dead addresses |
| `circulating_supply` | level, tokens, staleness 14 | coingecko circulating_supply | none | CoinGecko's definition; informational under effective_total |
| `staked_supply` | level, tokens, staleness 7 | adapter `hype.staked_supply` | none | sum of validator stake |
| `staker_emission_share` | level, ratio, cadence event, staleness 400 | none: manual, researched by the bootstrap | none | 1.0 by construction (all staking rewards go to stakers); the docs page is the citation |
| `emission_rate_annual` | schedule, tokens_per_year, critical, staleness 45 | adapter `hype.emission_rate_annual` | none | the docs formula on staked supply, about 10M a year |
| `flow_usd.af_buyback` | flow, usd, daily, critical, staleness 4 | defillama slug `hyperliquid`, data_type `dailyHoldersRevenue`, backfill_days 90 | none | 99 percent of protocol fees, converted to HYPE by the fund |
| `revenue_run_rate_usd` | level, usd, critical, staleness 5 | derived `flow_annualized`, params `{ metric: flow_usd.af_buyback, days: 90 }` | none | 365/90 times the 90-day sum, matching the holder flow's window |

`holder_flows: [{ id: af_buyback, kind: burn, capture_rule: programmatic, recipient_base: all, metric: flow_usd.af_buyback, window_days: 90 }]`.

`modules: [{ id: hc, type: holder_cashflow, kind: estimate, weight: 0.6 }, { id: fm_holder_flow, type: forward_multiple, kind: estimate, weight: 0.4, params: { basis: holder_flow } }]`; `scenario_probabilities: { bear: 0.25, base: 0.5, bull: 0.25 }`; no `total_return_variants`; `peer_set: []`.

Assumption bounds (key-wide, before calibration): `rev_growth_y1 [-0.6, 3.0]`, `growth_fade_years [1, 10]`, `terminal_growth [0, 0.05]`, `capture_rate_terminal.af_buyback [0.5, 1.0]`, `capture_ramp_years.af_buyback [0, 4]`, `discount_rate_base [0.08, 0.35]`, `discount_premium_programmatic [0, 0.15]` (the flow's rule is programmatic, so the engine requires the key; AERO's contractual flow did not), `multiple.fm_holder_flow [3, 200]` (wide enough to express the market's current multiple; the user's views live inside), `regime_multiplier [0.4, 1.6]`, `staked_ratio_horizon [0.2, 0.8]` (0.46 today). Agent bands are added after calibration by the mirror rule (research-first spec 7.6; the VVV and AERO calibration notes).

`review_triggers`: `driver_deviation_pct: 25`, `provisional_move_pct: 25`; no `revenue_stale_move_pct` (there is no usage index); no calendar entries.

`agent`: defaults, with the weekly input budget raised to 2,000,000 as for VVV and AERO.

## 4. The POST method on the HTTP transport

`src/ingest/transport/http.ts`: `HttpTransport` gains `postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown>`. It sends the body as JSON with `content-type: application/json`, and shares GET's retries, timeout, response-size limit, and `HttpError` (status, URL, a truncated body). The fake transport used by tests gains the same method, routed by URL and body (a route may match the body's `type` field so one URL serves the three info API reads). No declarative source uses it: it exists for adapters.

## 5. The `hype` adapters

`src/ingest/adapters/hype.ts`, registered in the adapter registry beside VVV's and AERO's; `needsRpc: false` on all three. Each posts to the info API URL from `params.url` (default `external_ids.hyperliquid_info`, then the literal `https://api.hyperliquid.xyz/info`), and stamps the reading with the fetch time, `source: api`, detail naming the request type. Numbers arrive as decimal strings (`totalSupply`, balances) or 8-decimal integers (`stake`); each adapter parses with the finite-number guard and refuses by name (`invalid_response`) a missing field, a non-numeric string, or an empty validator list.

- `hype.effective_supply`: `tokenDetails` for `params.token_id` (default `external_ids.hyperliquid_token`). Value = `totalSupply` minus the balance of every address in `params.subtract` (contract names resolved through `ctx.contract`, matched case-insensitively against `nonCirculatingUserBalances`; an address absent from the list subtracts zero, so a fund emptied by a vote does not fail the read but shows as a supply jump the deviation trigger and the persona see). Refuses a result that is not positive.
- `hype.staked_supply`: `validatorSummaries`; value = the sum of `stake` over every entry divided by 10^8 (`params.decimals`, default 8). Refuses a sum of zero.
- `hype.emission_rate_annual`: the same read; `rate = params.anchor_rate * sqrt(params.anchor_stake / stake)` with defaults 0.0237 and 400,000,000; value = `rate * stake`, tokens per year, stored on the schedule metric as the step in force. Refuses a stake of zero. The formula is the docs' one sentence, so the anchor and the exponent's form are params, and a correction is a config edit.

Cross-checks: none exist for the three. The rate follows the stake daily; a jump in staked supply is an event the persona reads, not an anomaly.

## 6. The persona

`personas/perp-exchange-analyst.md`: frontmatter `name: perp-exchange-analyst`, `effort: high`, `temperament: skeptical, patient, specific`, `sectors: [perp-dex, exchange-buyback]`, default model. Body, in the register of the two existing personas:

- The token's claim is a programmatic buyback: about 99 percent of protocol trading fees are converted to HYPE by the Assistance Fund inside L1 execution, so the question is never whether value reaches the token but how durable the volume behind the fees is, and how much of each dollar of volume the protocol keeps as deployers and builders take their shares.
- Volume is the business. Perpetuals volume moves with the market's regime, with the exchange's share against centralised venues and newer on-chain ones, and with the HIP-3 markets deployed by third parties, whose deployers may keep up to half of their fees. A rising HIP-3 share with rising deployer shares lowers the protocol's cut per dollar of volume even as volume grows.
- The fund is the mechanism and the risk. The docs call its HYPE burned; the chain still lists the balance. It is a burn as long as nobody can spend it, and a validator vote could change that. The fund's status, the fee split, and the emissions formula are the three parameters to re-read from primary sources on every run.
- Emissions are the staking rewards from the reserve, all of it to stakers, at a rate that falls as more is staked; they are dilution, never value. Contributor tokens vest monthly; they are already in the effective supply, but they are float that can be sold.
- Aligned quote assets route a share of stablecoin reserve yield to the fund; small today, a line to watch.
- The working rules of the existing personas: change your mind by the amount the evidence supports; separate what is read from what is inferred; write for a reader who checks; say so when you do not know.

The four shipped skills load unchanged. `orion persona assign hype perp-exchange-analyst`.

## 7. Onboarding sequence

1. The code additions (sections 4 and 5) with their tests, on a feature branch.
2. `assets/hype.yaml` and the persona; `orion asset validate`; `orion persona assign`.
3. A dry fetch from a throwaway home with a fresh database: `orion data fetch hype --dry-run`. Expected: the 90-day backfill of the flow (about 90 rows), the three adapters' readings within a few percent of section 2.1, the price cross-check inside 2 percent.
4. The first real tick on this machine (`./run-daily.sh hype`). The fetch writes every metric but the staker share; the valuation is `blocked` (no assumption set); the cadence starts a bootstrap; its `manual_metrics` list holds `staker_emission_share`, which it records as a provisional row of 1.0 with the staking docs page as the citation; the user confirms it from the inbox.
5. Calibration as for VVV and AERO: a sensitivity sweep over the fetched data, priced packages, the user chooses; import the set; derive bands by the mirror rule and write them into the asset file; commit.
6. The next tick produces the first signal. The Hermes job gets a third scheduled line for `hype`, a few minutes after AERO's.

## 8. Testing

- Transport: `postJson` against a fake fetch: the body is sent as JSON with the content type set; a non-2xx status raises `HttpError` with the same fields as GET; retries and the size limit apply.
- Adapters: tests against recorded info API responses saved as fixtures (`tests/fixtures/hype/*.json`) with section 2.1's numbers: effective supply 951,460,050 from total 998,912,928 less the three listed balances; staked supply 441,834,995 from the 8-decimal integers; the emission rate pinned at the 400M anchor (9,480,000 a year) and at 441,834,995 (about 9.96M); refusals for a missing field, an empty validator list, a zero stake, an absent subtract address (subtracts zero, no refusal); the request bodies posted.
- The asset file, as VVV's and AERO's tests do: parses; `sourceIssues` empty; every required assumption key has bounds, including `discount_premium_programmatic`; the hash pinned; a full fetch on canned routes writes every metric but the staker share; with a synthetic set the valuation is `ok`.
- One live dry run against the info API, CoinGecko, and DefiLlama from a throwaway home (step 3 of section 7) is the user's checkpoint. No network in tests.
- `tests/fixtures/hype.yaml` stays a synthetic engine fixture; it is not replaced by the live file.

## 9. Build order

1. `postJson` on the transport and the fake (tests).
2. `hype` adapters (fixtures, registry, tests).
3. Asset file, persona, asset tests, README lines (commands for `hype`, the third Hermes line).
4. The user's checkpoints: dry fetch, first tick and the staker-share confirmation, calibration, bands, first signal.

## 10. Known limitations and risks

- **The fund can be repurposed.** A validator vote could spend or redirect the Assistance Fund; the `burn` decision assumes it will not. The effective-supply adapter subtracts whatever balance the API lists, so an emptied fund shows as a supply jump the deviation trigger and the persona see, not as a silent error.
- **The flow has one source.** DefiLlama's holders revenue is the only series; the fund's balance would give an on-chain check (daily balance change times price) but the transport keeps no history, so that needs a stored daily series of the balance, a later improvement. The methodology text is quoted in section 2.1 so a change is noticeable.
- **HIP-3 erodes capture.** Deployers may keep up to half of fees on their markets, and growth mode cuts protocol fees on those markets by 90 percent; the protocol's cut per dollar of volume falls as HIP-3 grows. `capture_rate_terminal.af_buyback` carries that view.
- **The emission formula is one sentence of the docs**, not code. Anchor and stake are params; if the chain publishes the rate, the adapter should read it instead.
- **The info API is undocumented for rate limits** and has no stated stability guarantee. A schema change fails the adapters by name; the failure-streak anomaly then fires and the signal goes `blocked`, the right behaviour.
- **Circulating supply is definitional.** CoinGecko's 222M against the API's 299M; informational under `effective_total`, single-sourced.
- **Contributor vesting sizes are unconfirmed.** Under the effective-total basis they do not change the per-token value; they are float and flow pressure the persona notes.
- **The run rate is a 90-day trailing figure**, so a sharp volume move shows with a lag of a quarter, as for AERO. Monthly holders revenue has already fallen by half from its 2025 peak; the calibration starts from the 90-day figure, and the packages should show the 30-day and 1-year alternatives.

## 11. Amendments made during planning (2026-09-24)

1. **The recorded fixtures are the tests' numbers (2.1, 8).** The info API replies recorded at 2026-09-24T23:40Z read total supply 998,909,900.86, fund 47,478,177.05, stake summed 440,716,882.75; section 2.1's figures came a few hours earlier and differ in the fifth digit. The tests pin the fixtures' arithmetic with wide sanity bounds; the effective supply nets 47,479,853.5 (the fund, the zero address, `0x...dead`).
2. **Grade B by design (8).** A manual row in force caps the data-quality grade at B, as VVV's manual revenue does, so HYPE's signal is `ok` at grade B once the staker share is confirmed, and `blocked` naming that metric before. Section 8's "the valuation is `ok`" stands; grade A is not reachable.
3. **One request serves two adapters (5).** The stake and the emission adapters post the same `validatorSummaries` body; the run cache, keyed by URL and body for a POST, answers the second from the first, so a tick posts two requests to the info API, not three.
4. **The token-details fixture drops the genesis block (8).** The API's reply carries 94,023 genesis balances (5 MB) that no adapter reads; the fixture keeps every other field.
5. **The fake transport routes a POST by body (4).** A function route receives the body, so one URL answers several request types in tests; the fake's call log records the method and the body.

## 12. Amendments made during execution (2026-09-25)

6. **The transport's shared behaviour is what GET has (4).** Section 4 said `postJson` shares GET's "response-size limit" and an `HttpError` carrying "a truncated body"; neither exists for GET: the transport reads a reply whole and `HttpError` carries the status and a message naming the URL. `postJson` shares the retries, the timeout, the host spacing, and that error. The one reply where a limit would matter is `tokenDetails`, about 5 MB with its genesis balances, parsed whole and held in the run cache for the run. Found by the Task 1 review.
7. **The backfill runs ten days beyond the run-rate window (3).** With `backfill_days` equal to the 90-day derived window, a first fetch made before DefiLlama has posted the newest complete day stores 89 days and writes no run rate (the planning dry run at 23:48Z did; the Task 3 dry run after the UTC rollover did not). `flow_usd.af_buyback` now backfills 100 days; the window stays 90; the config hash moved to `618c7918bda7e2ce6159597dd7e2b955f75f5ad646bdba116f4adf5f969767e5`. AERO keeps its 90/90 shape (already backfilled; a lagging day resolves the next morning within its staleness of 5). Found by the Task 3 review.
8. **Refusals and params the Task 2 review added (5).** A missing or malformed `nonCirculatingUserBalances` list, a `subtract` param that is not a list of strings, and a negative per-validator `stake` are refused by name; an address absent from a well-formed list still subtracts zero. `hype.emission_rate_annual` takes `exponent` (default 0.5, refused outside (0, 1]), so the docs' inverse square root is config, as section 5 intended. The stake is summed as JavaScript numbers: the raw sum (4.4e16 in 8-decimal units) is above 2^53, but each validator's stake is far below it and the float error is 8e-8 HYPE; a bigint sum is not warranted unless a single validator exceeds about 90M HYPE.
9. **The effective supply avoids the token-details reply (2.2, 5; 2026-10-02, the user's dry run).** `tokenDetails` carries 94,023 genesis balances (5 MB), and the info API served it at tens of KB a second on the user's link, so the adapter timed out three times while the small reads passed. `hype.effective_supply` now reads total supply from `spotMetaAndAssetCtxs` (300 KB; the token's pair against the quote token, USDC index 0 by default, carries `totalSupply`; param `quote_index`) and each subtracted address's balance from its `spotClearinghouseState` (3 to 15 KB; an address holding none counts as zero), so a tick posts five small requests, cached per run. The transport gains per-host timeouts (`hostTimeoutMs`, 60 seconds for the info API, the default 15 elsewhere). The refusals of amendment 8 carry over in the new shape (a malformed meta, a missing token, pair or context, a malformed balance list). The fixtures are the trimmed spot meta and the three whole clearinghouse states, recorded 2026-10-02 (total 998,891,801.49; fund 47,632,360.54); the config hash is unchanged (comments do not enter it).
