# Disclosure watcher (LIT pilot): followups (2026-10-23)

Spec `docs/superpowers/specs/2026-10-23-orion-disclosure-watcher-design.md` (section 15 holds every amendment made
during execution). Plan `docs/superpowers/plans/2026-10-23-orion-disclosure-watcher.md`. Branch `feat/disclosure-watcher`,
not merged, not pushed.

## Level-3 acceptance (the one paid run Mike approved, decision 5)

Scratch `ORION_HOME` seeded with a verified `.backup` of the live `orion.db` (2026-10-23 22:52Z), the branch build
(7ac5c26), `assets/`, `calibration/`, `personas/`, `skills/`, `.env`. Command:

```
disclosure_watch.py ingest --asset lit --url https://x.com/Lighter_xyz/status/2113065839352336774 \
  --dry-run --orion-home <scratch> --queue-file <scratch>/dev-queue.md --run-json <scratch>/run.json \
  --transcript <the Q3 fixture>
```

- Result: `check_acceptance.py` PASS on criteria 1–5, on the first run.
  1. Config proposal `metrics.unlocks_next_year.source.params.tranches = {first: 2027-01-29, every_months: 1, count: 36}`,
     cited inside 12:20–12:55, effect 6m 0.3485 → 0.3485 and 12m 0.3887 → 0.3887 (from == to).
  2. Dev finding `holder_flow` on `flow_usd.buyback`: Orion's Q3 buys $7,410,898 = 87.2% of the stated $8.5M (core's 87%),
     the Robinhood instance's share not seen in the buys; buys / DefiLlama revenue 75% in Q3, 57% in Oct 1–21.
  3. Dev finding `revenue` on `flow_usd.llama_revenue`: DefiLlama Q3 $9,846,397 vs stated $8.5M (+16%), likely gross of the
     Robinhood 50/50 split.
  4. Catalysts: CFTC DCM/DCO filing 2026-11-01..11-30 and review window to 2027-05-29; Lighter EVM mainnet by 2026-12-31;
     vanilla options + portfolio margin by 2026-12-31.
  5. No assumption change, no observation, outcome completed, dry run.
- Extras the analyst filed (allowed; listed for Mike): a third dev finding `supply` (the call's 109.8M LIT staked vs
  Orion's constant 0 `staked_supply`; it proposes a monitor-only staked level and says the valuation input should stay 0);
  catalysts for bigger wallet-distribution partnerships (by YE) and the first unlock tranche (2027-01-29, ~13.5M LIT).
- Cost: 9 requests; 30 uncached + 953,159 cache-read + 89,345 cache-write input tokens; 19,927 output; 1 search, 1 fetch;
  $1.05 estimated (Orion's price table). Wall time 3 min 18 s.
- Row counts on the scratch DB: observations 25,334, proposals 2, journal 38, assumption_sets 26 unchanged; agent_runs
  42 → 43 and documents 0 → 1 (as allowed). The live `orion.db` mtime/size were the same before and after.
- Artifacts: `~/.hermes/profiles/raymond/workspace/orion/disclosure-watcher/acceptance/2026-10-23-level3-{run.json,digest.txt,dev-queue.md}`.
- Bug found by this run and fixed in the watcher: `OrionCli._checked` treated the run row's `"error": null` as a failure,
  so the digest printed `est $?`. The paid run was not repeated for it (the cost is read from `agent runs show`).

## Targets unchanged (Task 14)

All 13 assets' `model whatif --as-of 2026-10-23T12:00:00.000Z --json` byte-identical between `main`'s dist (523bf63)
and the branch's dist (424b2ba) on `.backup` copies of the live DB. Migration 8 on the copy: schema 8, `agent_runs` 42 rows
and sequence 42 identical, integrity ok, `foreign_key_check` empty. Rerun by the controller on the final branch commit
(7ac5c26) against fresh backups: 13/13 identical again (aero, cake, crv, cvxcrv, hype, link, lit, pump, sdcrv, sky, uni,
vvv, ycrv). Repeat at merge time with the merge commit, as the skill's live-install rule says.

## Deviations from the plan (all recorded as rulings in spec section 15)

- A figure cited from a machine transcript, and every figure from a disclosure run, goes to the user: an `observation`
  proposal where the metric takes provisional data, an inert row otherwise (the plan said "always inert", which the
  commit path did not honour).
- `get_flow_total` sums active confirmed committed rows only and refuses `flow_conflict` on overlap (the plan included
  staged rows, which double-counted).
- Disclosure-run catalysts must cite the target document; a disclosure run needs the asset YAML at preflight.
- PUMP also uses `lit.unlocks_next_year` (`{url, allocations}`); its params are now validated too and pass; its hash is
  unchanged.

## Open items

Before enabling the cron job:
1. A permanently deleted post (tweet-result 404/tombstone) found by search counts as a failed fetch day and can raise a
   false 3-day alert; classify 404/tombstone as `irrelevant` first.
2. Create the job paused: `orion-disclosure-watch`, `40 9 * * *`, `no_agent: true`, script
   `orion-disclosure-watch.sh`, deliver `slack:C0CB7325YFK`, timeout 60 minutes. Enable on Mike's go.

At merge (Mike's go): backup, `whatif` baseline with the old dist, ff-merge, build, a read command to apply migration 8,
the migration checks, `cmp` of the 13 `whatif`s, push over HTTPS.

Deferred minors (none blocks the merge; triaged in the final review): document-store polish (`--published-at` not
ISO-validated, insert race behind the watcher's lock, meta not validated at the store layer), db→agent type imports of
`StoredCitation`/`Catalyst`, duplicate citations not deduped, `catalysts_due` not deduped, `adapter_params` can repeat
an entry, `paramsDoc` omits `url`, `--note` help text, `get_flow_total` excludes rows straddling the range (documented),
the watcher's window-closed catch-up stops once the next window opens, an error result overwrites the post's
`.run.json`, skill item 5 does not mention the converted-observation exception, spec 5.4's body wording is stale
(section 15 governs), a text-only post gets the "investor update" title.

Deferred minors, status (branch `fix/minors-2026-10-24`, kanban t_b3b09288, not merged; 13/13 `whatif` identical and
13/13 config hashes unchanged):
- Fixed: `--published-at` validated (CLI and store: an ISO date or a zoned instant); the insert yields to the
  `(asset_id, sha256)` unique index (`ON CONFLICT DO NOTHING`, then read back), so a racing writer gets `existing: true`;
  kind/meta validated at the store; `StoredCitation` lives in `src/db/documents.ts` (no db→agent import; `Catalyst` was
  already a db type); a citation given twice is stored once; `catalysts_due` lists a re-filed catalyst once, under the
  newest entry; `adapter_params` lists a metric and adapter once; `lit.unlocks_next_year` paramsDoc names `url`;
  `--note` help names every run type; review skill item 5 names the converted-observation exception; spec 5.4 says
  section 15 governs. Tool layer 1.1.0 → 1.1.1 (agent run config hash only).
- No change: `get_flow_total` excluding rows that straddle the range is the tool's documented contract.
- Open (outside the repo: `~/.hermes/profiles/raymond/workspace/orion/disclosure-watcher/bin/disclosure_watch.py`, not
  in this card's worktree): the window-closed catch-up stopping once the next window opens, an error result
  overwriting the post's `.run.json`, and a text-only post getting the "investor update" title.

For Mike, when he decides the Q3 unlock proposal: approving it moves only LIT's report dilution line (~136M → ~122–125M
next-365-day unlocks) and LIT's config hash; update the persona's "from 2026-12-29" line with it.
