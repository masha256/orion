# Disclosure watcher

The Orion disclosure watcher: it finds an issuer's material posts (in v1, Lighter's quarterly investor-call recording on
X), transcribes them, stores them in Orion and starts the analyst's `disclosure` run. On the server it runs as the
daemon's `disclosure_watch` job (`src/daemon/jobs/disclosureWatch.ts`); on staging that job runs it with `--dry-run`, `--dry-state <home>/disclosure/state/dry-seen.json` (each post reported once
across dry scans) and no Anthropic credential in its environment.

How it works, its commands, state and alert lines: [`docs/ops/disclosure-watcher.md`](../../docs/ops/disclosure-watcher.md).

- `bin/disclosure_watch.py`: the script (`scan`, `ingest`, `status`). `bin/check_acceptance.py`: the acceptance checker.
- `watch.yaml`: per-asset config. `requirements.txt`: the pinned Python dependencies (the server's `~/watcher-venv`).
- Environment: `ORION_DW_REPO` (the Orion release root; required for `scan` and `ingest`), `ORION_DW_BASE_DIR`
  (state, log, transcripts; default this directory), `ORION_DW_QUEUE`, `ORION_DW_CACHE`, `ORION_NODE`.
- Tests (no network): `python3 -m unittest discover -s tests` from this directory, with a Python that has PyYAML;
  `tests/tools/disclosureWatcher.test.ts` runs them in the suite (`ORION_WATCHER_PYTHON` picks the interpreter).

Never commit `state/`, `log/`, `transcripts/`, `cache/` or a dev queue from a local run (git-ignored).
