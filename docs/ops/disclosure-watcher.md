# Disclosure watcher (LIT pilot; the daemon's `disclosure_watch` job)

When an issuer publishes something material (in v1: Lighter's quarterly investor-call recording on X), the watcher finds it, transcribes it, stores it in Orion, and has Orion's analyst read it in a `disclosure` run. What the analyst finds comes back as Orion proposals (the inbox), dev-queue entries (code and data-source work) and dated catalysts in the journal. It makes no direct assumption change: value changes are proposals, and every figure it records waits for the user (a proposal where the metric takes provisional data, an inert row otherwise, whatever it cites). Design: `docs/superpowers/specs/2026-10-23-orion-disclosure-watcher-design.md`, sections 8 to 10.

Status: built; live on the Hermes host until cutover, then on the server. Since Phase 1.5c (D11) the watcher lives in
this repo, `tools/disclosure-watcher/`, ships in every release (`~/current/tools/disclosure-watcher/`, without its
tests) and runs as the daemon's daily `disclosure_watch` job. Its paths come from the environment, not from the Hermes
profile. Since Phase 1 the `disclosure` run is the only analyst run type, and a proposal's effect is always null: the
digest prints `no target effect`. Until cutover the Hermes cron job below keeps running the profile copy; at cutover
its state moves to the server (below) and the cron job is removed.

## How it runs

1. The daemon's `disclosure_watch` job (16:40 UTC daily: 08:40 PST / 09:40 PDT) runs the script's `scan` with the
   watcher venv's Python. The script is deterministic (no LLM call anywhere in it). On a scan day it makes one keyless
   DuckDuckGo HTML search per asset, extracts X post ids, skips every id already in its state file, and classifies each
   new one by its public `tweet-result` JSON: the author must be the configured `user.id_str` (never the handle, which
   can change), the post at most 120 days old. A post with a video of at least `min_video_minutes` whose text matches
   `match_text` is a recording (`queued`); a post matching `announce_text` with no video is an `announcement` (logged
   only); anything else is `irrelevant`.
2. It processes at most one `queued` post per run, oldest first: download the audio, decode it to 16 kHz mono WAV,
   transcribe it with faster-whisper, write `[mm:ss] text` per segment, delete the audio.
3. It stores the transcript in Orion (`orion doc add ... --kind machine_transcript`) and checks that Orion's sha256
   equals its own.
4. It starts the analyst: `orion agent run <asset> --type disclosure --doc <id> --json` (no `--out` since 1.5c). The
   daemon never starts a `disclosure` run itself; only the watcher (or you, by hand) does.
5. The post-run step appends each new dev finding to the dev queue (deduped by fingerprint) and prints a digest. The
   job posts the digest to the env's Slack channel (alert lines first); a non-zero exit fails the job with
   `ORION ALERT <env> disclosure_watch exit <code>: <last stderr line>`, a scan past 2 h is killed (`exit timeout`).

Scan days: daily from the day after a quarter ends to quarter end plus `after_quarter_end_days` (35 for LIT); outside
that window, Mondays only. On a day that is not a scan day the script exits 0 and prints nothing, and nothing is posted.

## The daemon job (`src/daemon/jobs/disclosureWatch.ts`)

```
<venv>/bin/python ~/current/tools/disclosure-watcher/bin/disclosure_watch.py scan --orion-home ~/home \
    [--dry-run --queue-file ~/home/disclosure/dev-queue.dry.md] [--dry-state ~/home/disclosure/state/dry-seen.json]
```

- Python: `$ORION_WATCHER_VENV/bin/python` (the unit sets `~/watcher-venv`, installed by `orion-host.sh --with-watcher`
  from `requirements.txt`: PyYAML, faster-whisper, numpy, yt-dlp pinned); `python3` from PATH when the venv has none.
- Environment: the job's env (the unit's variables over `~/shared/.env`) plus `ORION_DW_BASE_DIR=~/home/disclosure`,
  `ORION_DW_REPO=~/current` (the release root the Orion CLI runs from), `ORION_NODE` (the daemon's node) and
  `ORION_HOME=~/home`. The dev queue is `$ORION_DW_QUEUE`, default `<base>/dev-queue.md`; the audio cache
  `$ORION_DW_CACHE`, default `<base>/cache`. `watch.yaml` is always the one beside `bin/` (it ships in the release).
- yt-dlp: X changes its player often, so before the scan the job runs `<venv>/bin/pip install --upgrade yt-dlp` when
  `<venv>/.ytdlp-upgraded` is missing or a week old (the stamp is touched only after a good upgrade; a failed one is a
  warning and the scan runs with the installed one). The pin in `requirements.txt` is the install-time floor; a re-run
  of `orion-host.sh --with-watcher` after a pin change resets yt-dlp to it.
- **Prod** runs for real: with `ANTHROPIC_API_KEY` in the `.env` a new call costs one analyst run (about $1 to $3).
  Without a key it runs dry and the digest starts with `ORION ALERT prod disclosure_watch: no Anthropic credentials
  (ANTHROPIC_API_KEY) in the env file: the scan ran dry, nothing was filed`.
- **Staging** always runs dry (`--dry-run`): the Anthropic variables are removed from the watcher's environment whatever
  the `.env` holds, so it can never start a paid run. Findings go to `~/home/disclosure/dev-queue.dry.md`, and the posts
  a dry scan processed are remembered in `--dry-state` (`state/dry-seen.json`), so each is reported once, not every scan
  day. The real state file is never written by a dry run. A dry run still runs `doc add` against staging's own database
  (documents are append-only and deduped by sha256).

## Files and state

On the server, per Orion user (`orion-prod`; staging's copy is separate and dry):

| Path | What |
|---|---|
| `~/current/tools/disclosure-watcher/bin/disclosure_watch.py` | the script (`scan`, `ingest`, `status`); `bin/check_acceptance.py` the acceptance checker |
| `~/current/tools/disclosure-watcher/watch.yaml` | per-asset config (changes ship as a release) |
| `~/home/disclosure/state/<asset>.json` | dedupe and progress state |
| `~/home/disclosure/transcripts/<asset>/<post_id>.txt` + `.meta.json` (+ `.run.json`) | transcripts as handed to `doc add`, run results |
| `~/home/disclosure/log/<asset>.jsonl` | one line per run: candidates, decisions, errors |
| `~/home/disclosure/cache/` | audio and WAV while transcribing; deleted after the transcript is written |
| `~/home/disclosure/dev-queue.md` | the dev queue (prod); read it with `orion-remote dev-queue [n]` |
| `~/home/disclosure/dev-queue.dry.md`, `state/dry-seen.json` | staging's dry queue and dry-seen posts |
| `~/watcher-venv/` | the Python venv (`.ytdlp-upgraded` stamp) |

In a dev checkout the defaults are the watcher's own directory (`state/`, `log/`, `transcripts/`, `cache/`,
`dev-queue*.md` are git-ignored: never commit them). The Hermes-profile copy
(`~/.hermes/profiles/raymond/workspace/orion/disclosure-watcher/`, dev queue `workspace/orion/dev-queue-revenue.md`)
runs until cutover.

State files are written to a temp file and renamed. Per post id the state holds `{ status, kind, first_seen_at,
updated_at, attempts, doc_id, doc_sha256, run_id, run_outcome, error }`, where `status` is one of `irrelevant`,
`announcement`, `seeded`, `queued`, `transcribed`, `doc_added`, `run_done`, `run_failed`, `failed`. Plus `search: {
last_ok_at, consecutive_failures }` and `windows: { "<YYYY>Q<n>": { found_post_id | null, closed_reported } }`. A known
id is skipped whatever its status.

## Commands

The scan (what the daemon job runs; set `ORION_DW_REPO` to a release root or checkout to run it by hand):

```
disclosure_watch.py scan
```

Review one post now, from a link (when the owner pastes a post link and asks for it to be reviewed; it skips discovery and the calendar but keeps the author check):

```
disclosure_watch.py ingest --asset lit --url <x post url> [--dry-run] [--orion-home <dir>] [--queue-file <path>]
                           [--transcript <file>] [--force]
```

- `--orion-home`: run the Orion commands against a scratch home (default: `$ORION_HOME`).
- `--queue-file`: write dev findings to another file (default: `$ORION_DW_QUEUE`, else `<base>/dev-queue.md`).
- `--transcript <file>`: hand this transcript to `doc add` and skip download and ASR (tests, re-runs).
- `--dry-run`: pass `--dry-run` to `agent run`, write no state; needs an explicit `--queue-file` and `--orion-home`. `scan --dry-run --dry-state <file>` remembers the posts processed (staging).
- `--force`: re-run the analyst on an id already processed (on the stored document; the transcript is reused when its file exists). This is also how a `run_failed` post is retried.

A post with a video becomes a `machine_transcript` document; a post with no video becomes a `post` document from its text.

What the script runs for one post:

```
yt-dlp -f hls-audio-64000-Audio/bestaudio -o cache/disclosure-watch/<id>.%(ext)s <post url>
ffmpeg -i <audio> -ac 1 -ar 16000 -f wav <id>.wav
# WhisperModel(asr_model, device="cpu", compute_type="int8", cpu_threads=4)
# transcribe(array, vad_filter=True, beam_size=1, initial_prompt=<asset glossary from watch.yaml>)
node dist/cli/index.js doc add <asset> --url <post url> --file <txt> --kind machine_transcript --source-id x:<id> \
  --published-at <created_at> --title "<asset> investor update <YYYY>Q<n>" --meta asr_model=... --meta audio_sha256=... \
  --meta duration_s=... --meta transcribed_at=... --json
node dist/cli/index.js agent run <asset> --type disclosure --doc <doc_id> --json      # a dry run adds --dry-run
node dist/cli/index.js agent runs show <run_id> --json                                # estimated_cost_usd for the digest
node dist/cli/index.js inbox <asset> --json                                           # the filed proposals' kinds (effect is null since Phase 1)
```

- A `doc add` whose returned sha256 differs from the script's own marks the post `failed`. The script writes the transcript in the form Orion stores (no BOM, LF line ends, one trailing newline), so the two agree.
- `agent run` refused with `run_in_progress` (the asset's run lock is held, e.g. by a late tick or a manual run): the post stays `doc_added` and the next scan retries the run; the repeated `doc add` returns the existing row (`existing: true`). Any other non-zero exit records `run_failed` and is never retried automatically, because a retry costs money: use `ingest --force`.

## Orion-side commands

```
orion doc add <asset> --url <source url> --file <path> --kind <kind> [--published-at <ISO>] [--title <text>]
                      [--source-id <platform:id>] [--meta <key=value>]... [--json]
orion doc list [asset] [--json]                 # a re-transcription of the same URL is a new row; the older one shows superseded_by_newer
orion doc show <id> [--text] [--json]           # metadata and the kind's label; --text adds the stored text
orion agent run <asset> --type disclosure --doc <id> [--dry-run] [--json]
orion agent runs show <id>                      # outcome, dev findings with their citation labels, estimated cost
```

Kinds: `machine_transcript | transcript | post | filing | article`. Documents are append-only: the same asset and text (same sha256) is not stored twice, and no command edits or deletes one. `--type` accepts only `disclosure` (any other value: `invalid_run_type`), and `--doc` is required (`disclosure_needs_doc`); the document must belong to the asset (`doc_not_found`). A disclosure run has its own budget (`agent.budgets.disclosure` overrides it; default 25 requests, 1.2M input tokens, 40,000 output tokens, 3 web searches, 5 fetches, 5 proposals), about $1 to $3 a call, about $7 at worst. It is offered the nine disclosure tools (`get_observations`, `get_anomalies`, `get_journal`, `get_flow_total`, `resolve_anomaly`, `record_provisional_observation`, `propose_change`, `write_journal`, `record_dev_finding`) and nothing else: every value change it wants is a proposal, every figure it records waits for the user (a proposal where the metric takes provisional data, an inert row otherwise, whatever it cites), and every proposal, dev finding and catalyst cites the document (one exception: a proposal converted from a recorded figure carries that figure's own citation, which may be a page it fetched).

## The digest and the dev queue

The digest is stdout, which the daemon job posts (prod: #orion-ops; staging: #orion-staging):

```
ORION DISCLOSURE lit | LIT investor update 2026Q3 | posted 2026-10-22 | doc #<id> machine transcript, 41.5 min | <post url>
analyst disclosure run #<n> completed | <requests> requests, <input>k input | est $<cost>
proposals: #<id> config (no target effect) | decide from the next orion-lit DECISIONS block
dev findings (2, added to dev-queue.md): [holder_flow] <title> | [revenue] <title>
catalysts: 2026-11-01..2027-05-29 <event> | by 2026-12-31 <event> | by 2026-12-31 <event>
```

A run that did not complete prints `analyst disclosure run #<n> ended <outcome>: nothing filed; doc #<id> is stored; retry: ingest --force`. Replying to the digest does nothing: proposals are decided from the asset's daily DECISIONS block, which accepts only ids from its own latest inbox.

Each new dev finding is appended to the dev queue (on the server `~/home/disclosure/dev-queue.md`, `orion-remote dev-queue [n]` reads it) under a heading `## LIT — <title> (disclosure watcher, <YYYY-MM-DD>, run #<n>, doc #<id>)` with a `<!-- dw:fp=<fingerprint> -->` marker; a fingerprint already in the file is skipped, so a re-run of the same document adds nothing. Entries marked "disclosure watcher" are machine-written leads: verify before building. Every model-written string is cleaned again on the watcher side (control characters, length caps, Slack sequences `<@`, `<!`, `<#`, bare URLs).

## Alert lines

Always the first line of the message:

- `ORION DISCLOSURE ALERT lit: search failed 3 scan days running (<last error>)`
- `ORION DISCLOSURE ALERT lit: <step> failed for post <id>: <error>` (download, transcribe, doc add, run)
- `ORION DISCLOSURE lit: window 2026Q4 closed with no investor-call recording found` (information, once per window)

Every window that closed since the watcher started (`watch_since` in `state/<asset>.json`, else its first recorded
post) is reported, oldest first, on its last day or the first scan after it, so an outage past the next quarter end
still reports the old window. A window that ended before the watcher started is never reported.

A text-only post (no video) is stored as a `post` doc titled by the feed's `post_title` (`{date}` = the post's UTC
date; default `<ASSET> post <date>`), not by the call `title`. The raw run result goes to
`transcripts/<asset>/<post_id>.run.json`; a result that is not a completed run never replaces a completed one there
(a failed `--force` retry): it is written to `<post_id>.run.failed.json` and the output says so.

A search answered with HTTP 202 or an anomaly page is retried once after 60 seconds, then counts as a failed search day, never as "nothing found".

## Until cutover: the Hermes cron job

Job `orion-disclosure-watch` runs the profile copy:

```
40 9 * * *    scripts/orion-disclosure-watch.sh     # 09:40 PT
```

`no_agent: true` (stdout goes to #orion-ops verbatim, `slack:C0CB7325YFK`), timeout 45 minutes. It still passes
`--out` (accepted and ignored). At cutover (plan Rollout checklist step 6) it is paused, the profile's `state/lit.json`,
`transcripts/` and `log/` are copied into `~orion-prod/home/disclosure/` and the dev queue to
`~orion-prod/home/disclosure/dev-queue.md`, so the server's watcher does not re-review a call the Hermes one covered;
then the cron job and `orion-disclosure-watch.sh` are removed.

## Seeding

Before the first live scan, `state/lit.json` was seeded with the four known post ids as `seeded`: the Q1, Q2 and Q3
recordings and the Q3 announcement. The server inherits that state by the cutover copy above. Acceptance runs use
`ingest` on a scratch `--orion-home` and a scratch `--queue-file`, so the seed does not affect them.

## Tests

`python3 -m unittest discover -s tools/disclosure-watcher/tests` (a Python with PyYAML; no network: http, the Orion
driver, yt-dlp, ffmpeg and ASR are fakes). The vitest suite runs them too (`tests/tools/disclosureWatcher.test.ts`;
`ORION_WATCHER_PYTHON` picks the interpreter), and `tests/daemon/disclosureWatch.test.ts` covers the job.

## Adding an asset

`watch.yaml` carries everything asset-specific; the script has no asset names in code.

```yaml
assets:
  lit:
    orion_asset: lit
    author: { platform: x, handle: Lighter_xyz, user_id: "1604942990417580032" }
    window: { after_quarter_end_days: 35, outside: weekly_monday }
    feeds:
      - id: investor_call
        source: x_video                      # v1 implements x_video only; unknown types are refused at load
        search: 'Lighter_xyz "Investor Update" recording'
        match_text: '(?i)recording of our Q[1-4] Investor Update'
        announce_text: '(?i)investor call'
        min_video_minutes: 10
        doc_kind: machine_transcript
        title: 'LIT investor update {year}Q{quarter}'
        post_title: 'LIT post {date}'          # a text-only post (no video); {date} = its UTC date
    transcribe: { asr_model: small.en, initial_prompt: "Lighter, LIT, zkLighter, perps, buyback, Robinhood, staking, TVL, open interest" }
    run: { type: disclosure, auto: true }
```

To add an asset:

1. Add an entry to `tools/disclosure-watcher/watch.yaml` (a release ships it): the author's numeric user id, a search phrase, the match and announcement patterns, a transcription glossary.
2. Seed its state file (`~/home/disclosure/state/<asset>.json` on prod) with the post ids already reviewed, as `seeded`.
3. On the Orion side, nothing but an issuer-disclosure paragraph in the asset's persona if it lacks one: the run type, the document store and the tools are asset-agnostic.

Assets that disclose in text rather than video need new `source` types in a later plan (`x_post`, `rss`, `page_watch`). Each is a small fetcher returning `(source_id, url, published_at, text | media_url)`; the dedupe, the store, the run and the post-run step do not change. The search engine is the shared weak point: a second keyless search source can be added as another `search` entry once one proves reliable, and the paste-a-link path always works.
