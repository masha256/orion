# Orion: price-weighted agent input budget, and a reserve request on exhaustion (design, 2026-10-24)

Status: **draft, waiting for Mike** (kanban t_46c152b5). Decisions owed are in section 10. Nothing is built.

Queue entry this closes: `workspace/orion/dev-queue-revenue.md`, "Agent budget counts cache reads at full weight"
(found on AERO deep run #44).

## 0. Summary

- **The problem.** The input budget is uncached + cache reads + cache writes, counted at the same weight. Cache reads
  are **86.9%** of all input tokens across the 43 runs, but only **13.9%** of the list-price cost of the 40 runs on
  the current model, `claude-opus-5-5` (M). The cap is
  really a limit on how many times a long context gets re-read, not on spend.
- **What it cost.** 3 of 43 runs ended `budget_exhausted`, all on the input cap. All 3 had at least 52% headroom left on
  a price-weighted count. Two of them lost work they had staged:
  - #44 (AERO deep) staged base `rev_growth_y1` 0.30 → 0.25 (12m $0.486 → $0.475).
  - #31 (VVV triage) staged an anomaly #6 resolution.
- **Recommendation.**
  - **Option A1:** count input in weighted units: uncached ×1, cache write ×1.25, cache read ×0.1.
  - Keep the per-type default numbers and the `input_tokens` key. No asset config hash moves, and ENGINE_VERSION
    stays put.
  - Add **R**: on exhaustion, one final reserve request in which only `write_journal` may run. Staged work then
    commits instead of being thrown away.
  - Every past completed run still completes, and all 3 exhausted runs would have kept going (M).
  - The worst-case input spend per run falls under A1 rather than rising (section 4).

M = measured from the live DB (read-only, `agent_runs` + `agent_transcripts.responses`, 2026-10-24). E = estimate.
C = a claim from elsewhere (the queue note, code comments).

## 1. How the budget works today (code, `main` @ 0739cd6)

- `src/config/agentPolicy.ts`: `RunBudgets.inputTokens` is "uncached input plus cache reads plus cache writes, summed
  over requests". The defaults are:

  | run type | requests | input | output | web searches | web fetches |
  |---|---|---|---|---|---|
  | weekly | 25 | 600k | 40k | 5 | 5 |
  | triage | 20 | 500k | 30k | 8 | 8 |
  | deep | 40 | 2M | 80k | 15 | 15 |
  | bootstrap | 60 | 3M | 100k | 30 | 30 |
  | disclosure | 25 | 1.2M | 40k | 3 | 5 |

- **All 13 assets** override `agent.budgets.weekly: { input_tokens: 2000000 }`. VVV got this override on 2026-09-21
  (`ebe7b87`, after its first dry run), and every asset onboarded since copied it. So the weekly cap that applies is
  2M, not 600k.
- `src/agent/loop.ts`: `exhausted()` runs **before** each request against the usage after the previous one. A request
  that starts under the cap may finish far over it.
- `budget_exhausted` commits nothing. The run's staged changes and its journal are lost (`run.ts`; the operating rules
  tell the analyst so).
- **One request can re-read the context many times.** Web search and fetch are server tools: inside one Messages API
  request the server loops, and every iteration re-reads the whole context. #44's 5th request read 993,790 cached
  tokens on its own; #17's 3rd read 789,449 (M, per-request usage).
- The persona model is `claude-opus-5-5` on all six personas.
  - Its list prices (`src/agent/cost.ts`): input $4, cache write $5 (1.25×), cache read $0.20 (**0.05×**), output
    $20 per MTok.
  - Runs 1–3 used `claude-opus-5`, whose cache read is $0.50 (0.1×).

## 2. What was measured: every run (M)

Weighted units = uncached + 1.25 × cache write + 0.1 × cache read. "Headroom" compares a run's total with the cap that
applied to it (weekly 2M by override; triage 500k, deep 2M, bootstrap 3M, disclosure 1.2M). USD is the list price from
`cost.ts` for the run's own model, output and $0.01 per search included.

### 2.1 Per run

The verdict columns simulate the loop's check-before-request on each run's own per-request usage:
- **ok**: a completed run would still complete.
- **EXH**: an exhausted run still stops where it did.
- **cont**: the stop no longer fires and the run would have gone on.

Columns:
- *x1.25-only* charges cache writes 1.25× and leaves cache reads at 1×.
- *units* is A1: the same cap numbers counted in weighted units.
- *recal* is units with tighter caps (section 5, table 5.2).
- *USD* is option C's caps (section 5, table 5.3).

| id | asset | type | outcome | req | uncached | cache read | cache write | output | raw | raw headroom | units | units headroom | USD | raw | x1.25-only | units | recal | USD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | vvv | weekly | completed (dry) | 5 | 24 | 480,014 | 62,398 | 13,618 | 542,436 | 73% | 126,023 | 94% | $1.00 | ok | ok | ok | ok | ok |
| 2 | vvv | weekly | completed | 15 | 44 | 1,139,073 | 76,568 | 27,792 | 1,215,685 | 39% | 209,661 | 90% | $1.77 | ok | ok | ok | ok | ok |
| 3 | vvv | deep | completed | 8 | 30 | 678,983 | 78,241 | 29,675 | 757,254 | 62% | 165,730 | 92% | $1.65 | ok | ok | ok | ok | ok |
| 4 | aero | bootstrap | completed | 2 | 18 | 193,126 | 44,655 | 4,920 | 237,799 | 92% | 75,149 | 97% | $0.41 | ok | ok | ok | ok | ok |
| 5 | hype | bootstrap | completed | 4 | 209 | 575,804 | 61,444 | 8,563 | 637,457 | 79% | 134,594 | 96% | $0.72 | ok | ok | ok | ok | ok |
| 6 | aero | weekly | completed | 6 | 36 | 946,196 | 87,963 | 15,406 | 1,034,195 | 48% | 204,609 | 90% | $0.98 | ok | ok | ok | ok | ok |
| 7 | vvv | weekly | completed | 7 | 30 | 628,293 | 71,521 | 14,785 | 699,844 | 65% | 152,261 | 92% | $0.81 | ok | ok | ok | ok | ok |
| 8 | crv | bootstrap | completed | 2 | 6 | 23,719 | 26,576 | 3,494 | 50,301 | 98% | 35,598 | 99% | $0.21 | ok | ok | ok | ok | ok |
| 9 | hype | weekly | completed | 4 | 24 | 470,380 | 81,677 | 11,666 | 552,081 | 72% | 149,158 | 93% | $0.79 | ok | ok | ok | ok | ok |
| 10 | ycrv | bootstrap | completed | 2 | 8 | 47,686 | 26,255 | 3,584 | 73,949 | 98% | 37,595 | 99% | $0.21 | ok | ok | ok | ok | ok |
| 11 | cvxcrv | bootstrap | completed | 2 | 12 | 171,333 | 46,718 | 4,060 | 218,063 | 93% | 75,543 | 97% | $0.36 | ok | ok | ok | ok | ok |
| 12 | sdcrv | bootstrap | completed | 2 | 6 | 39,565 | 42,629 | 3,671 | 82,200 | 97% | 57,249 | 98% | $0.29 | ok | ok | ok | ok | ok |
| 13 | vvv | weekly | completed | 5 | 18 | 342,684 | 60,870 | 13,858 | 403,572 | 80% | 110,374 | 94% | $0.69 | ok | ok | ok | ok | ok |
| 14 | aero | weekly | completed | 3 | 20 | 305,424 | 49,013 | 8,190 | 354,457 | 82% | 91,829 | 95% | $0.52 | ok | ok | ok | ok | ok |
| 15 | uni | bootstrap | completed | 2 | 8 | 49,881 | 27,137 | 3,251 | 77,026 | 97% | 38,917 | 99% | $0.21 | ok | ok | ok | ok | ok |
| 16 | cake | bootstrap | completed | 2 | 10 | 75,034 | 27,506 | 3,212 | 102,550 | 97% | 41,896 | 99% | $0.24 | ok | ok | ok | ok | ok |
| **17** | vvv | triage | **budget_exhausted** | 3 | 10,910 | 830,957 | 116,877 | 8,714 | 958,744 | **−92%** | 240,102 | 52% | $1.04 | EXH | EXH | cont | cont | cont |
| 18 | hype | weekly | completed | 8 | 37,272 | 1,152,890 | 106,821 | 21,543 | 1,296,983 | 35% | 286,087 | 86% | $1.39 | ok | ok | ok | ok | ok |
| 19 | crv | weekly | completed | 4 | 24 | 469,190 | 71,030 | 7,002 | 540,244 | 73% | 135,730 | 93% | $0.62 | ok | ok | ok | ok | ok |
| 20 | vvv | weekly | completed | 4 | 32 | 857,608 | 86,646 | 11,451 | 944,286 | 53% | 194,100 | 90% | $0.88 | ok | ok | ok | ok | ok |
| 21 | ycrv | weekly | completed | 3 | 14 | 170,325 | 38,958 | 4,818 | 209,297 | 90% | 65,744 | 97% | $0.36 | ok | ok | ok | ok | ok |
| 22 | cvxcrv | weekly | completed | 5 | 20 | 465,662 | 65,171 | 11,895 | 530,853 | 73% | 128,050 | 94% | $0.68 | ok | ok | ok | ok | ok |
| 23 | sdcrv | weekly | completed | 4 | 18 | 390,396 | 65,639 | 7,863 | 456,053 | 77% | 121,106 | 94% | $0.60 | ok | ok | ok | ok | ok |
| 24 | lit | bootstrap | completed | 2 | 8 | 48,854 | 26,873 | 3,799 | 75,735 | 97% | 38,485 | 99% | $0.22 | ok | ok | ok | ok | ok |
| 25 | link | bootstrap | completed | 4 | 10 | 73,745 | 27,345 | 3,613 | 101,100 | 97% | 41,566 | 99% | $0.22 | ok | ok | ok | ok | ok |
| 26 | sky | bootstrap | completed | 4 | 10 | 106,144 | 39,695 | 5,757 | 145,849 | 95% | 60,243 | 98% | $0.33 | ok | ok | ok | ok | ok |
| 27 | pump | bootstrap | completed | 2 | 14 | 126,540 | 29,056 | 4,952 | 155,610 | 95% | 48,988 | 98% | $0.29 | ok | ok | ok | ok | ok |
| 28 | aero | weekly | completed | 3 | 20 | 419,212 | 80,437 | 10,510 | 499,669 | 75% | 142,487 | 93% | $0.71 | ok | ok | ok | ok | ok |
| 29 | uni | weekly | completed | 7 | 28 | 497,904 | 53,560 | 11,750 | 551,492 | 72% | 116,768 | 94% | $0.62 | ok | ok | ok | ok | ok |
| 30 | cake | weekly | error (connection) | 0 | – | – | – | – | – | – | – | – | – | – | – | – | – | – |
| **31** | vvv | triage | **budget_exhausted** | 4 | 65,011 | 404,846 | 68,096 | 8,660 | 537,953 | **−8%** | 190,616 | 62% | $0.88 | EXH | EXH | cont | cont | cont |
| 32 | vvv | deep | completed | 9 | 20,708 | 1,175,192 | 95,607 | 18,076 | 1,291,507 | 35% | 257,736 | 87% | $1.24 | ok | ok | ok | ok | ok |
| 33 | hype | weekly | completed | 8 | 5,677 | 767,977 | 64,649 | 13,090 | 838,303 | 58% | 163,286 | 92% | $0.79 | ok | ok | ok | ok | ok |
| 34 | crv | weekly | completed | 7 | 23,200 | 811,258 | 83,128 | 16,429 | 917,586 | 54% | 208,236 | 90% | $1.05 | ok | ok | ok | ok | ok |
| 35 | vvv | triage | completed | 5 | 12 | 188,709 | 52,748 | 5,290 | 241,469 | 52% | 84,818 | 83% | $0.41 | ok | ok | ok | ok | ok |
| 36 | ycrv | weekly | completed | 4 | 14 | 178,543 | 40,132 | 5,321 | 218,689 | 89% | 68,033 | 97% | $0.35 | ok | ok | ok | ok | ok |
| 37 | cvxcrv | weekly | completed | 4 | 10 | 166,002 | 58,502 | 4,067 | 224,514 | 89% | 89,738 | 96% | $0.41 | ok | ok | ok | ok | ok |
| 38 | sdcrv | weekly | completed | 2 | 12 | 220,061 | 60,897 | 4,055 | 280,970 | 86% | 98,139 | 95% | $0.46 | ok | ok | ok | ok | ok |
| 39 | lit | weekly | completed | 9 | 28 | 633,358 | 76,248 | 12,740 | 709,634 | 65% | 158,674 | 92% | $0.77 | ok | ok | ok | ok | ok |
| 40 | link | weekly | completed | 3 | 20 | 306,672 | 47,380 | 7,001 | 354,072 | 82% | 89,912 | 96% | $0.49 | ok | ok | ok | ok | ok |
| 41 | sky | weekly | completed | 6 | 24 | 632,301 | 101,236 | 9,630 | 733,561 | 63% | 189,799 | 91% | $0.86 | ok | ok | ok | ok | ok |
| 42 | pump | weekly | completed | 3 | 24 | 507,546 | 71,987 | 10,144 | 579,557 | 71% | 140,762 | 93% | $0.68 | ok | ok | ok | ok | ok |
| 43 | lit | disclosure | completed | 7 | 4,132 | 725,180 | 89,345 | 20,606 | 818,657 | 32% | 188,331 | 84% | $1.03 | ok | ok | ok | ok | ok |
| **44** | aero | deep | **budget_exhausted** | 5 | 172,555 | 2,098,816 | 177,334 | 19,600 | 2,448,705 | **−22%** | 604,104 | 70% | $2.50 | EXH | EXH | cont | cont | cont |

The per-request sums match the `agent_runs` totals exactly for every run (asserted in the probe).

**A correction to the queue note.** The note put #44 at "~$3–4". The measured figure at list price is **$2.50**:
uncached $0.69, cache writes $0.89, output $0.39, cache reads $0.42 and searches $0.11. Cache reads were 86% of #44's
input tokens and 17% of its cost.

### 2.2 By run type (M)

| type | runs | raw max | raw p50 | units max | units p50 | USD max | USD p50 | max single request, raw | max single request, units |
|---|---|---|---|---|---|---|---|---|---|
| weekly | 24 | 1,296,983 | 551,492 | 286,087 | 140,762 | $1.77 | $0.71 | 694,438 | 168,669 |
| deep | 3 | 2,448,705 | 1,291,507 | 604,104 | 257,736 | $2.50 | $1.65 | 1,182,254 | 291,828 |
| bootstrap | 12 | 637,457 | 102,550 | 134,594 | 48,988 | $0.72 | $0.29 | 494,130 | 91,493 |
| triage | 3 | 958,744 | 537,953 | 240,102 | 190,616 | $1.04 | $0.88 | 873,659 | 181,481 |
| disclosure | 1 | 818,657 | 818,657 | 188,331 | 188,331 | $1.03 | $1.03 | 354,138 | 72,846 |

- **All 43 runs cost $30.75 at list price (M).** By asset: VVV $10.38 over 10 runs, AERO $5.11 over 5, HYPE $3.70 over
  4, and every other asset under $2.10.
- The deep and disclosure figures rest on 3 runs and 1 run. Treat their p50s as anecdotes.

### 2.3 Why the three runs stopped (M)

| run | the request that crossed | raw after it | what was staged and lost |
|---|---|---|---|
| #17 vvv triage | 3rd: 7 searches + 5 fetches, 789k cache read in one request | 959k vs 500k | nothing staged; the journal was lost |
| #31 vvv triage | 2nd: 3 searches + 4 fetches, 274k cache read; then two plain requests at ~65k each | 538k vs 500k | anomaly #6 resolution (a dust burn, correctly excluded) |
| #44 aero deep | 5th: 4 searches + 3 fetches, 994k cache read + 173k uncached | 2.45M vs 2M | base `rev_growth_y1` 0.30 → 0.25 (12m $0.486 → $0.475), with a full rationale |

- **Cost to finish, if the stop had not fired (E).** The context at the stop was ~137k tokens for #17, ~67k for #31
  and ~210k for #44.
  - This comes from transcript characters divided by the median chars/token of the runs' last plain requests (3.35).
    That ratio ranges from 1.7 to 7.5 across runs, so each context is good to about ±2×.
  - Completed runs typically end 2–4 plain requests after their heavy research request.
  - Three more requests at that context come to **~$0.25–0.35 per run** and ~30k–75k units.
  - Under A1, all three would still have had ≥ 52% of their cap left at that point.
- Under every re-weighted option the three runs **continue**, but what they would then have done is unknown: no run is
  replayed. "cont" means the observed stop no longer fires. It does not mean the run would have succeeded.

## 3. Options for what the input cap counts

| | **A. Weighted units** (recommended) | **B. Raw cap kept + units cap added** | **C. USD cap** | **D. Units + USD cap** |
|---|---|---|---|---|
| What is counted | uncached ×1 + cache write ×1.25 + cache read ×0.1 (Anthropic's standard ratios, fixed in code) | as A, plus today's raw sum as a backstop | list-price USD of the whole run (input, output, searches) from `cost.ts` | both A and C |
| Model-dependent | no | no | yes: a persona model change or a price-table edit changes the room | yes |
| Unknown model | n/a | n/a | `estimateCostUsd` returns null: the run must refuse in preflight (new error) | as C |
| Schema change | **A1:** none (`input_tokens` is counted in units). **A2:** rename the key to `input_units` | new optional `input_units` override (no default) | new optional `max_usd` override (no default) | both |
| Asset config hashes | **A1: none move.** A2: all 13 move (the weekly override is renamed) | none, but the 13 weekly 2M raw overrides still bind, so weekly runs keep today's limit unless the YAMLs change (13 moves) | none | none |
| What the analyst sees | `input_units_left` instead of `input_tokens_left` | both | `usd_left` | both |
| Past runs | 40/40 completed still ok; 3/3 exhausted continue | same as A, apart from the weekly raw 2M (no run came near it: max 1.30M) | same as A at the caps in 5.3 | same |
| Build size (E) | small: `loop.ts`, `agentPolicy.ts` comment, tool-result key, operating-rules line, tests | A + a second check and second override key | small + preflight refusal + price-table coupling | largest |

**Recommendation: A1.**
- **Cache reads at ×0.1, not ×0.05.** The ratios are model-independent, and they never need a price table to decide
  whether a run may continue. That keeps `cost.ts` the display-only estimate its header says it is. ×0.1 overstates
  opus-5-5's cache reads 2×, which errs on the safe side.
- **C is honest about dollars but couples behaviour to a hand-kept price table.** A missed price update would silently
  widen or narrow every budget. A also bounds dollars well enough on its own (section 4).
- **D buys nothing A plus the existing output and request caps don't already give.**

## 4. Worst-case spend per run: today vs A1 (E, list price, opus-5-5)

The input bound is the cap times the dearest input kind:
- Today a raw token can be a cache write: cap × $5/MTok.
- Under A1, one unit is at most $4/MTok: uncached $4; a cache write is 1.25 units for $5; a cache read is 0.1 units for
  $0.20, i.e. $2 per MTok-unit.

Add the output cap at $20/MTok and searches at $0.01 each. Overshoot is excluded: the last request can cross the cap by
up to one request, at most 1.18M raw or 292k units observed (#44's 5th request, ≈ $1.0).

| type (cap in force) | today: input + output + search | A1, same numbers |
|---|---|---|
| weekly (2M, override) | $10.00 + $0.80 + $0.05 = **$10.85** | $8.00 + $0.80 + $0.05 = **$8.85** |
| triage (500k) | $2.50 + $0.60 + $0.08 = **$3.18** | $2.00 + $0.60 + $0.08 = **$2.68** |
| deep (2M) | $10.00 + $1.60 + $0.15 = **$11.75** | $8.00 + $1.60 + $0.15 = **$9.75** |
| bootstrap (3M) | $15.00 + $2.00 + $0.30 = **$17.30** | $12.00 + $2.00 + $0.30 = **$14.30** |
| disclosure (1.2M) | $6.00 + $0.80 + $0.03 = **$6.83** | $4.80 + $0.80 + $0.03 = **$5.63** |

- **The worst case falls under A1 with the same numbers.** What changes is the typical case: a cache-heavy run gets
  about 5–10× more requests before the input cap binds.
- In practice the `requests` cap (25/20/40/60/25) and the output cap then bind.
- **Realistic ceiling (E):** a weekly run that uses all 25 requests at a 200k-token context reads ~5M cached tokens.
  That is 500k units, about $1.00 of cache reads plus ~$1.5 of writes and output: **~$2.5**, against $1.77 for the
  dearest weekly so far.

## 5. Per-run-type defaults

### 5.1 Keep the numbers (recommended with A1)

| type | cap | observed max (units) | headroom over max |
|---|---|---|---|
| weekly | 2M (override; default 600k) | 286,087 | 7.0× (2.1× against the 600k default) |
| triage | 500k | 240,102 (#17, exhausted) | 2.1× |
| deep | 2M | 604,104 (#44, exhausted) | 3.3× |
| bootstrap | 3M | 134,594 | 22× |
| disclosure | 1.2M | 188,331 | 6.4× |

- Changing no number keeps uncached-input room identical (×1) and leaves every config hash alone.
- **The 13 weekly 2M overrides become unnecessary.** Weekly peaks at 286k units, against the 600k default. Removing them
  tightens weekly's worst case from $8.85 to $3.25 (E).
- Removing them moves all 13 asset hashes: re-pin 13 tests, and each asset's next signal lists "config" with no target
  move. My recommendation is to remove them later, in the next change that already touches all 13 YAMLs, and not in
  this build.

### 5.2 Tighter recalibration (alternative)

Caps at about 2–3× the observed max units, with the bootstrap and disclosure caps kept above their run comments'
worst cases:

| type | units cap | observed max | worst case (A, E) |
|---|---|---|---|
| weekly | 600k (needs the 13 overrides removed: 13 hash moves) | 286k | $3.25 |
| triage | 400k | 240k | $2.28 |
| deep | 1.2M | 604k | $6.55 |
| bootstrap | 1.5M | 135k | $8.30 |
| disclosure | 800k | 188k | $4.03 |

Every past run passes (simulated, M). Not recommended now:
- deep, triage and disclosure have 3, 3 and 1 runs of history;
- the two deep and triage stops that started this ran at 2–3× their typical size;
- tightening again would re-create the problem on the next research-heavy run.

### 5.3 USD caps (option C, if picked)

weekly $3, triage $2, deep $6, bootstrap $12, disclosure $4. These were chosen against the observed maxima ($1.77,
$1.04, $2.50, $0.72, $1.03) and the run-type comments in `agentPolicy.ts` (bootstrap "$8–12", disclosure "$1–3, ~$7
worst"). All 43 past runs pass; the 3 exhausted runs continue (M).

## 6. Option R: one reserve request on exhaustion

**Mechanism.**
- When `exhausted()` fires on the requests, input or output cap, the loop sends one more request instead of stopping.
- A web-budget overrun is a per-request server-loop overspend, so R covers it too. The loop does not run R after
  `refused`, `error`, `max_tokens`, `model_context_window_exceeded` or `no_journal`.
- **The request.** The same system prompt and tool list, so it is a cache hit; changing the tool list would invalidate
  the cached prefix and bill the whole context uncached.
- A user message is appended: "Budget spent (<which>). Call write_journal now. It records your thesis and commits what
  you staged. Any other tool call ends the run and nothing is saved."
- `runTool` refuses every client tool but `write_journal` in this turn.
- If the response used a server tool (`web_search_requests` or `web_fetch_requests` > 0), or called any other tool, the
  run ends `budget_exhausted` as today.
- `maxTokens` for this request is 16k: adaptive thinking needs room, and a journal is short.
- **Why not force `tool_choice`.** It would be the cleaner way to force the call, but the client sends
  `thinking: {type: 'adaptive'}`, and as far as I know a forced tool choice is not accepted with thinking on. The plan
  must check this against the SDK docs; if it is accepted, use it.
- **Outcome.** A journal staged in R commits through the normal path: config-reload hash check, `AgentConflict`, and
  valuation if the signal moves. The outcome is `completed`, with `summary_json.reserve = { reason: "<which budget>" }`
  and `error` null.
  - Recommended: no new outcome value. `agent_runs.outcome` has a CHECK constraint, so a new value such as
    `completed_on_reserve` needs a table-rebuild migration.
  - The tick report and `agent show` print "finished on reserve after <which>".
- **Cost (E): ~$0.05–0.15 per use.** One cached read of a 70k–210k context at $0.20/MTok, a few k cache-write tokens,
  and ≤ 16k output (≤ $0.32 if all used). R is not counted against any cap; it is bounded by being exactly one request.
- **What it would have saved.** #44 commits the `rev_growth_y1` cut, #31 the anomaly #6 resolution, and #17 only its
  journal.
- **When R runs.** Always on exhaustion (recommended), even with nothing staged, because the journal is the next run's
  memory. The alternative is to run R only when something is staged.
- **Operating rules.** Line 39 says "If a budget runs out, nothing from this run is saved". With R that is false.
  - Recommended text: "If a budget runs out you get one last request, in which you may only write the journal; plan to
    finish well before that."
  - The alternative is to leave the rule as is, so the analyst keeps pacing as if there were no reserve. That leaves a
    false statement in the prompt; not recommended.
  - Either text changes `sha256(OPERATING_RULES)`, which feeds the agent run's `configHash`. That hash is provenance
    only; it moves no asset hash.

R is independent of A, B, C and D. It is worth having even under A1, because a run can still overshoot the request or
output caps.

## 7. Hashes and versions

| | A1 | A2 | B | C | R |
|---|---|---|---|---|---|
| Asset config hashes (`sha256(canonicalJson(config))`) | unchanged | 13 move | unchanged | unchanged | unchanged |
| Asset test hash pins | none | 13 re-pins | none | none | none |
| ENGINE_VERSION (1.3.0) | unchanged: the valuation engine never reads budgets | unchanged | unchanged | unchanged | unchanged |
| VVV golden / signals | byte-identical | byte-identical | byte-identical | byte-identical | byte-identical |
| `TOOL_LAYER_VERSION` (1.1.0) | → 1.2.0 (the budget key in tool results changes) | → 1.2.0 | → 1.2.0 | → 1.2.0 | → 1.2.0, or one bump if built together |
| `OPERATING_RULES` text | the "tokens" wording → "input units" | same | same | "dollars" | per section 6 |
| DB migration | none | none | none | none | none (outcome stays `completed`) |
| Tick report schema | unchanged (`usage.input_tokens` stays the raw sum: it is reporting) | same | same | same | `agent.reserve` added as optional |

`TOOL_LAYER_VERSION` and `OPERATING_RULES` feed only `agent_runs.config_hash` (provenance), so neither re-pins an asset
test.

## 8. Test plan

- **`tests/agent/loop.test.ts`:**
  - Units: 10 uncached + 600 cache read + 400 cache write = 570 units. A cap of 571 continues and 570 stops with
    detail `input units (570)`.
  - `input_units_left` in tool results, never negative.
  - Requests, output and web-budget tests unchanged apart from the key name.
- **Regression from the live runs:** a fixture with #44's, #17's and #31's per-request usage (the numbers in section 2,
  no transcript content).
  - Under A1 with the default budgets, none of the three stops at its observed point.
  - The same fixture under today's raw rule stops exactly where the live run did. This proves the fixture reproduces
    the incident.
- **R:**
  - Exhaustion → one extra request whose last user message is the reserve text.
  - `write_journal` in R → `finished` with `reserve` set.
  - Any other client tool in R → refused, then `budget_exhausted`.
  - A server tool in R → `budget_exhausted`.
  - R never follows `refused`, `error` or `no_journal`.
  - Exactly one R per run.
- **`tests/agent/run.test.ts`:** R commits the staged changes and the journal; `summary_json.reserve` is set; outcome
  `completed`; a config change during the run still gives `conflict`.
- **`tests/config/agentPolicy.test.ts`:** default numbers unchanged; the `input_tokens` override is still accepted and
  read as units (A1); an unknown key is still refused.
- **Full suite** (`npx vitest run --maxWorkers=2` and `npm run typecheck`) with **no asset hash re-pin**. Any pin moving
  means stop: under A1 and R none may move.
- **No paid run in acceptance.** Everything runs against the mock `ModelClient`.
  - AERO's next scheduled deep is the first live use, ~2026-11-23: deep is every 30 days and a failed attempt resets
    the cadence (`dueRunType`).
  - A manual re-run of AERO's deep to recover the lost `rev_growth_y1` change is a paid run and needs Mike's go
    (decision 5).

## 9. Files (A1 + R)

- `src/agent/loop.ts`: `inputSpent` → weighted units; `budgetLeft` key; the R path.
- `src/config/agentPolicy.ts`: field comment (and the `inputUnits` rename internally, with the YAML key left as is).
- `src/agent/prompt.ts`: the budget lines of `OPERATING_RULES`.
- `src/agent/run.ts`: `summary_json.reserve`; `TOOL_LAYER_VERSION` 1.2.0.
- `src/agent/model.ts`: per-request `maxTokens` override for R (and `tool_choice` if the SDK check allows it).
- `src/app/tick.ts` and `src/app/tickReport.ts`: optional `agent.reserve`.
- `src/cli/commands/agent.ts`: show units and reserve.
- Tests per section 8, plus a followups note.

## 10. Decisions Mike owes

1. **Counting.**
   - (a) A1, recommended: weighted units in place, same key, no hash moves.
   - (b) A2: the same, with the key renamed to `input_units` (13 hash re-pins).
   - (c) C: a USD cap.
   - (d) B or D: both caps.
2. **Defaults.**
   - (a) Keep the numbers, recommended: the worst cases fall, as in section 4.
   - (b) The tighter set in 5.2.
3. **The 13 weekly 2M overrides.**
   - (a) Leave them now and remove them with the next all-asset YAML change, recommended.
   - (b) Remove them in this build (13 re-pins; weekly worst case $8.85 → $3.25).
4. **Reserve request R.**
   - (a) Build it, run it on every exhaustion, and change the operating-rule line. Recommended, ~$0.05–0.15 per use
     (E).
   - (b) Build it, but run it only when something is staged.
   - (c) Don't build it.
5. **AERO's lost deep change (#44, `rev_growth_y1` 0.30 → 0.25).**
   - (a) Wait for the next scheduled deep (~2026-11-23) after this merges, recommended: no extra spend.
   - (b) A manual paid deep re-run after the merge, ~$1.5–3 (E).
   - (c) File it now as a manual proposal from #44's staged rationale.

## 11. Out of scope

- A projected pre-request check: stop when the units so far plus the last request's size would cross the cap. It would
  tame the one-request overshoot but needs a size guess; revisit if overshoot shows up again.
- The per-request `max_uses` on the web tools equals the run's whole web budget, which is why one request can spend 7
  searches. Unchanged here.
- The tick report's `usage.input_tokens` stays the raw sum.
- The run-lock TTL (2h) is unaffected: the longest run so far took 7.2 minutes (M).
