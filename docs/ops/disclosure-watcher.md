# Disclosure watcher (Hermes side, LIT pilot)

When an issuer publishes something material (in v1: Lighter's quarterly investor-call recording on X), the watcher finds it, transcribes it, stores it in Orion, and has Orion's analyst read it in a `disclosure` run. What the analyst finds comes back as Orion proposals (the inbox), dev-queue entries (code and data-source work) and dated catalysts in the journal. Nothing changes a value on its own. Design: `docs/superpowers/specs/2026-10-23-orion-disclosure-watcher-design.md`, sections 8 to 10.

Status: this describes the pipeline as designed. The Orion side (`orion doc`, the `disclosure` run type) is in this repo; the Hermes script lives in the Hermes profile, not in git, and its cron job is created paused and enabled only on the owner's go after the merge.

## How it runs

1. A deterministic script on the Hermes host (no LLM call anywhere in it) runs once a day from cron. On a scan day it makes one keyless DuckDuckGo HTML search per asset, extracts X post ids, skips every id already in its state file, and classifies each new one by its public `tweet-result` JSON: the author must be the configured `user.id_str` (never the handle, which can change), the post at most 120 days old. A post with a video of at least `min_video_minutes` whose text matches `match_text` is a recording (`queued`); a post matching `announce_text` with no video is an `announcement` (logged only); anything else is `irrelevant`.
2. It processes at most one `queued` post per run, oldest first: download the audio, decode it to 16 kHz mono WAV, transcribe it with faster-whisper, write `[mm:ss] text` per segment, delete the audio.
3. It stores the transcript in Orion (`orion doc add ... --kind machine_transcript`) and checks that Orion's sha256 equals its own.
4. It starts the analyst: `orion agent run <asset> --type disclosure --doc <id> --json`. The tick never starts a `disclosure` run; only the watcher (or you, by hand) does.
5. The post-run step appends each new dev finding to the dev queue (deduped by fingerprint) and prints a digest, which is the Slack message.

Scan days: daily from the day after a quarter ends to quarter end plus `after_quarter_end_days` (35 for LIT); outside that window, Mondays only. On a day that is not a scan day the script exits 0 and prints nothing.

## Files and state

All under `~/.hermes/profiles/raymond/`:

| Path | What | Backed up |
|---|---|---|
| `workspace/orion/disclosure-watcher/bin/disclosure_watch.py` | the script (Hermes tools Python: stdlib, `yt-dlp`, `faster_whisper`, `numpy`) | yes (hourly to retrobot-raymond) |
| `workspace/orion/disclosure-watcher/watch.yaml` | per-asset config | yes |
| `workspace/orion/disclosure-watcher/state/<asset>.json` | dedupe and progress state | yes |
| `workspace/orion/disclosure-watcher/transcripts/<asset>/<post_id>.txt` + `.meta.json` | transcripts, as handed to `doc add` | yes |
| `workspace/orion/disclosure-watcher/log/<asset>.jsonl` | one line per run: candidates, decisions, errors | yes |
| `cache/disclosure-watch/` | audio and WAV while transcribing; deleted after the transcript is written | no |
| `scripts/orion-disclosure-watch.sh` | cron wrapper: loads Orion's `.env` (never printed), runs the script | no (as the tick wrappers) |
| `workspace/orion/dev-queue-revenue.md` | the dev queue the post-run step appends to | yes |

State files are written to a temp file and renamed. Per post id the state holds `{ status, kind, first_seen_at, updated_at, attempts, doc_id, doc_sha256, run_id, run_outcome, error }`, where `status` is one of `irrelevant`, `announcement`, `seeded`, `queued`, `transcribed`, `doc_added`, `run_done`, `run_failed`, `failed`. Plus `search: { last_ok_at, consecutive_failures }` and `windows: { "<YYYY>Q<n>": { found_post_id | null, closed_reported } }`. A known id is skipped whatever its status.

## Commands

The scan (what cron runs):

```
disclosure_watch.py scan
```

Review one post now, from a link (when the owner pastes a post link and asks for it to be reviewed; it skips discovery and the calendar but keeps the author check):

```
disclosure_watch.py ingest --asset lit --url <x post url> [--dry-run] [--orion-home <dir>] [--queue-file <path>]
                           [--transcript <file>] [--force]
```

- `--orion-home`: run the Orion commands against a scratch home (default: the live repo root).
- `--queue-file`: write dev findings to another file (default: the live queue).
- `--transcript <file>`: hand this transcript to `doc add` and skip download and ASR (tests, re-runs).
- `--dry-run`: pass `--dry-run` to `agent run`; the post-run step then writes only to an explicit `--queue-file` and prints the digest without the cron delivering it.
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
node dist/cli/index.js agent run <asset> --type disclosure --doc <doc_id> --json      # plus --dry-run in a dry run
node dist/cli/index.js agent runs show <run_id> --json                                # estimated_cost_usd for the digest
node dist/cli/index.js inbox <asset> --json                                           # proposal effects (numbers only)
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

Kinds: `machine_transcript | transcript | post | filing | article`. Documents are append-only: the same asset and text (same sha256) is not stored twice, and no command edits or deletes one. `--doc` is required for `disclosure` and refused for other run types (`doc_only_for_disclosure`); the document must belong to the asset (`doc_not_found`). A disclosure run has its own budget (`agent.budgets.disclosure` overrides it; default 25 requests, 1.2M input tokens, 3 web searches, 5 fetches, 5 proposals), about $1 to $3 a call, about $7 at worst. It is never offered `apply_assumption_change`: every value change it wants is a proposal, and every proposal, dev finding and catalyst cites the document.

## The digest and the dev queue

The digest is stdout, so it is the Slack message (#orion-ops):

```
ORION DISCLOSURE lit | LIT investor update 2026Q3 | posted 2026-10-22 | doc #<id> machine transcript, 41.5 min | <post url>
analyst disclosure run #<n> completed | <requests> requests, <input>k input | est $<cost>
proposals: #<id> config (12m target 0.37 -> 0.37) | decide from the next orion-lit DECISIONS block
dev findings (2, added to dev-queue-revenue.md): [holder_flow] <title> | [revenue] <title>
catalysts: 2026-11-01..2027-05-29 <event> | by 2026-12-31 <event> | by 2026-12-31 <event>
```

A run that did not complete prints `analyst disclosure run #<n> ended <outcome>: nothing filed; doc #<id> is stored; retry: ingest --force`. Replying to the digest does nothing: proposals are decided from the asset's daily DECISIONS block, which accepts only ids from its own latest inbox.

Each new dev finding is appended to `workspace/orion/dev-queue-revenue.md` under a heading `## LIT — <title> (disclosure watcher, <YYYY-MM-DD>, run #<n>, doc #<id>)` with a `<!-- dw:fp=<fingerprint> -->` marker; a fingerprint already in the file is skipped, so a re-run of the same document adds nothing. Entries marked "disclosure watcher" are machine-written leads: verify before building. Every model-written string is cleaned again on the Hermes side (control characters, length caps, Slack sequences `<@`, `<!`, `<#`, bare URLs).

## Alert lines

Always the first line of the message:

- `ORION DISCLOSURE ALERT lit: search failed 3 scan days running (<last error>)`
- `ORION DISCLOSURE ALERT lit: <step> failed for post <id>: <error>` (download, transcribe, doc add, run)
- `ORION DISCLOSURE lit: window 2026Q4 closed with no investor-call recording found` (information, once per window)

A search answered with HTTP 202 or an anomaly page is retried once after 60 seconds, then counts as a failed search day, never as "nothing found".

## The cron job

Job `orion-disclosure-watch`, created paused after merge; enabled on the owner's go:

```
40 9 * * *    scripts/orion-disclosure-watch.sh     # 09:40 PT, clear of the 05:05-06:05 tick window and its locks
```

`no_agent: true` (stdout goes to #orion-ops verbatim, `slack:C0CB7325YFK`), timeout 45 minutes. One run processes at most one post, so it stays inside the timeout. By design this job may start a paid analyst run, once per new call.

## Seeding

Before the first live scan, `state/lit.json` is seeded with the four known post ids as `seeded`: the Q1, Q2 and Q3 recordings and the Q3 announcement. The live watcher therefore does not re-review a call the manual review already covered. Acceptance runs use `ingest` on a scratch `--orion-home` and a scratch `--queue-file`, so the seed does not affect them.

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
    transcribe: { asr_model: small.en, initial_prompt: "Lighter, LIT, zkLighter, perps, buyback, Robinhood, staking, TVL, open interest" }
    run: { type: disclosure, auto: true }
```

To add an asset:

1. Add an entry: the author's numeric user id, a search phrase, the match and announcement patterns, a transcription glossary.
2. Seed its state file with the post ids already reviewed, as `seeded`.
3. On the Orion side, nothing but an issuer-disclosure paragraph in the asset's persona if it lacks one: the run type, the document store and the tools are asset-agnostic.

Assets that disclose in text rather than video need new `source` types in a later plan (`x_post`, `rss`, `page_watch`). Each is a small fetcher returning `(source_id, url, published_at, text | media_url)`; the dedupe, the store, the run and the post-run step do not change. The search engine is the shared weak point: a second keyless search source can be added as another `search` entry once one proves reliable, and the paste-a-link path always works.
