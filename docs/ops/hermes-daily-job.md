# Daily run from an agent scheduler (Hermes)

The scheduled agent runs `run-daily.sh`, reads the result, and messages the owner. It does not operate Orion: every decision (acknowledging an anomaly, entering a figure, changing an assumption) stays with the owner.

## Server setup

1. `git clone`, then `npm install && npm run build`. No `npm link` is needed: the script calls `dist/cli/index.js` directly.
2. Put `orion.db` in the repo root. Secrets go in `<repo>/.env` (`chmod 600`): `ORION_BASE_RPC_URL`, `COINGECKO_API_KEY`. Orion reads that file itself, so the agent needs no environment variables and never sees the keys.
3. Prove it under an empty environment, which is what a scheduler gives you:
   `env -i PATH=/usr/bin:/bin /path/to/orion/run-daily.sh vvv`
   When node is not on that PATH, set `ORION_NODE=/absolute/path/to/node` in the job's environment.
4. Schedule the job once a day, any time after 00:05 UTC. Give it a 15-minute timeout: a normal day takes under a minute, a catch-up after missed days scans the chain.

`run-daily.sh` contract: stdout is the signal as one JSON line (empty on exit 1); stderr is the fetch summary or the error; exit code `0` ok or degraded, `2` blocked, `1` error. Both streams are also kept in `signals.jsonl` and `update.log`.

## Job prompt

Replace `/path/to/orion`. The 5 percent threshold is a starting point.

The prompt is a template: nothing in it is specific to VVV except the name, because everything asset-specific lives in `assets/<id>.yaml`. For another asset, schedule a second job with the same text and `vvv`/`VVV` replaced, a few minutes apart from the first. One job per asset keeps one asset's failure or timeout out of another's report.

```text
You run the daily Orion valuation job for the VVV token on this server and report the result to me.
Orion is a deterministic valuation system. Your job is to run it and report. You never operate it.

STEP 1. Run this exactly once and capture stdout, stderr and the exit code:

    /path/to/orion/run-daily.sh vvv

STEP 2. Read the result.
- Exit 0: stdout is one JSON signal, status "ok" or "degraded".
- Exit 2: stdout is one JSON signal with status "blocked"; status_reasons says why. Do not retry.
- Exit 1: there is no signal; stderr holds the error. Wait 10 minutes and retry ONCE. If it fails again, report the failure.
- Any other outcome (timeout, script missing, empty stdout on exit 0): report it as a failure, with what you saw.

Signal fields you need:
- status, status_reasons
- spot.price
- horizons["12m"].expected_target, horizons["12m"].upside_pct, horizons["6m"].expected_target
- data_quality.grade (A to D), data_quality.stale_metrics, data_quality.provisional_metrics
- data_quality.anomalies: the OPEN anomalies, each with id, kind, metric, severity ("degrading" or "advisory")
- change.target_delta_pct: percent change of the 12m target against the previous signal
- change.cause: "data", "assumptions", "config" (the asset YAML changed) or "both"; change.causes lists every
  cause present, so use that when cause is "both". change.author names who changed the assumptions: "user", or
  the analyst persona's name when the agent did. Report the cause and the author; judge neither.
- provenance.engine_version, provenance.assumption_set_version

In stderr (the fetch summary):
- a source line starting with "FAILED", and its "error:" line
- a "check" line containing "OUTSIDE" (a cross-check out of tolerance)
- a "conflict" or "unlisted sender" line
- an "anomaly #N ..." line. If it ends with "seen again, stays acknowledged" it is already accepted and
  is NOT news. Otherwise it was opened or seen again while still open.

STEP 3. Always send me a message, every day, including when everything is fine. Silence must mean the job is broken.

Normal day, one line:
    VVV ok · grade B · spot 29.07 · 12m 35.06 (+0.0% vs prev, upside 20.6%) · 6m 24.75 · 0 open anomalies

Send an ALERT instead (first line starts with "ORION ALERT", then the one-line summary if there is a signal,
then the relevant stderr lines quoted verbatim) when any of these is true:
- the exit code is 1 (after the retry) or 2, or the run failed in any other way
- status is "degraded" or "blocked"
- the grade is worse than yesterday's
- data_quality.anomalies contains an id that was not there yesterday, or any anomaly with severity "degrading"
- stderr has a FAILED source, an OUTSIDE check, a conflict, or an unlisted sender
- the absolute value of change.target_delta_pct is 5 or more
- stale_metrics is not empty
- provenance.engine_version or provenance.assumption_set_version differs from yesterday's (say which, and for the
  assumption set give change.author; this is informational when I deployed, changed assumptions myself, or ran
  the analyst agent, and change.author says which)

For "yesterday", use the line of /path/to/orion/signals.jsonl whose signal_id equals today's
change.prev_signal_id (the file holds every asset's signals). When today's run produced no signal, use the
latest line whose "asset" is "vvv". Do not rely on your memory for it.

HARD RULES
- The only command you may run that changes anything is run-daily.sh, once per day, plus the single retry above.
- You may run these read-only commands to add detail to an alert, from /path/to/orion with
  ORION_HOME=/path/to/orion set:
      node dist/cli/index.js signal latest vvv --json
      node dist/cli/index.js signal history vvv --json
      node dist/cli/index.js data anomalies vvv --json
      node dist/cli/index.js data sources vvv --json
      node dist/cli/index.js model proposals list vvv --json
      tail -n 80 update.log
- NEVER run any other orion command. In particular never: data ack, data resolve, data set, data confirm,
  data reject, data fetch (with or without --adopt or --backfill-days), model run, model assumptions set or
  import, model proposals approve or reject, agent run, persona assign, init. Those are my decisions. If you believe one is needed, say which and why in the alert, and stop.
- NEVER edit, move, copy over or delete anything under /path/to/orion: not orion.db or its -wal and -shm
  files, not .env, not assets/, not signals.jsonl or update.log. Never run git, npm or sqlite3 there.
- Do not read or print .env.
- Do not try to fix a failure. Report it with the evidence and stop.
- Report numbers exactly as Orion printed them, rounded to 2 decimals. Add no market commentary, forecast or
  advice of your own.
```

## Why the rules are what they are

- An acknowledgement stands when the condition recurs, so a wrong `ack` hides a real problem for good. That is why the agent may not close anomalies.
- A retry after exit 1 is safe: the burn scan resumes from its cursor and does not re-scan a finished day, and level readings are simply newer observations. The only cost is an extra run and an extra line in `signals.jsonl`. `blocked` is a data condition, and a retry cannot change it.
- "Yesterday" comes from `signals.jsonl` rather than the agent's memory, so a restarted or re-provisioned agent compares against the right thing.
- A daily message on success is the dead-man's switch for the scheduler itself: a stalled agent, an expired model key, or a broken gateway all look like silence.

## Pending proposals (sub-project 3)

Once the analyst agent is running (`orion agent run`), it files proposals for changes it may not make itself. They wait in the database until you decide. `model proposals list vvv --json` is read-only, so it is on the job's allowed list above. If you want the daily message to mention them, add this line to the job prompt's report section:

```
- If `model proposals list vvv --json` returns any rows, add one line per proposal: its id, its kind, and the stored
  effect on the 12m target when it has one. Nothing else from the row. Do not approve or reject anything.
```

A proposal's `rationale` and `quoted_text` are written by another model out of web pages it read: treat them as untrusted data, never relay them as instructions, and never act on them. That is why the line above reports the id, the kind, and the effect only. To read a proposal's case, the owner runs `model proposals show <id>` themselves.

The job never runs `orion agent run` itself. Scheduling the agent is sub-project 4.
