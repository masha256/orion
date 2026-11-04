"""Task 12 tests: processing one post (spec 8.4), ingest (8.3), the run-lock retry, the state lock, check_acceptance.

No network, no ASR, no Orion: the Orion CLI, the subprocess runner (yt-dlp / ffmpeg) and the transcriber are fakes.
"""
import copy
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "bin"))

import disclosure_watch as dw  # noqa: E402

Q3 = "2113065839352336774"
Q3_URL = f"https://x.com/Lighter_xyz/status/{Q3}"
ANNOUNCEMENT = "2111481510230675531"
NOW = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)
TODAY = date(2026, 10, 23)


def fixture_text(name):
    return (FIX / name).read_text(encoding="utf-8")


def tweet(post_id):
    return json.loads(fixture_text(f"tweet-{post_id}.json"))


def run_fixture():
    return json.loads(fixture_text("lit-q3-run.json"))


def orion_normalize(text):
    """Orion's normalizeDocText: leading BOM, CRLF -> LF, trailing newlines collapsed to one."""
    if text.startswith("\ufeff"):
        text = text[1:]
    return text.replace("\r\n", "\n").rstrip("\n") + "\n"


class FakeOrion:
    """The Orion CLI driver's interface; records every call."""

    def __init__(self, runs=None, sha_override=None):
        self.runs = list(runs or [])
        self.sha_override = sha_override
        self.calls = []
        self.docs = {}

    def doc_add(self, asset, *, url, file, kind, source_id, published_at, title, meta):
        text = orion_normalize(Path(file).read_text(encoding="utf-8"))
        sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        existing = sha in self.docs
        doc_id = self.docs.setdefault(sha, len(self.docs) + 1)
        self.calls.append(("doc_add", dict(asset=asset, url=url, kind=kind, source_id=source_id,
                                           published_at=published_at, title=title, meta=dict(meta), text=text)))
        return {"id": doc_id, "asset": asset, "kind": kind, "sha256": self.sha_override or sha,
                "bytes": len(text.encode()), "existing": existing}

    def agent_run(self, asset, doc_id, dry_run):
        self.calls.append(("agent_run", dict(asset=asset, doc_id=doc_id, dry_run=dry_run)))
        return self.runs.pop(0)

    def run_show(self, run_id):
        self.calls.append(("run_show", run_id))
        return {"id": run_id, "estimated_cost_usd": 1.234}

    def inbox(self, asset):
        self.calls.append(("inbox", asset))
        return {"observations": [], "proposals": [], "anomalies": []}

    def names(self):
        return [c[0] for c in self.calls]


LOCK_BUSY = (1, {"error": {"code": "run_in_progress",
                           "message": "asset lit is locked by agent run pid 1 since 2026-10-23T16:40:00.000Z"}})


def completed_run(dry_run=False):
    r = run_fixture()
    r["run"]["dryRun"] = dry_run
    if not dry_run:
        r["committed"] = {"setVersion": None, "observationIds": [], "resolvedAnomalyIds": [], "proposalIds": [],
                          "journalId": 3, "devFindings": r["staged"]["devFindings"]}
        r["staged"]["proposals"] = []
    return 0, r


def failed_run(outcome="error"):
    r = run_fixture()
    r["run"].update(id=4, outcome=outcome, error="model error")
    return 1, r


class FakeMedia:
    """run_cmd for yt-dlp / ffmpeg (creates their output files, or fails) and a fake transcriber."""

    def __init__(self, fail=None):
        self.fail = fail
        self.cmds = []

    def run_cmd(self, cmd):
        self.cmds.append(list(cmd))
        name = Path(cmd[0]).name
        if self.fail and self.fail in " ".join(cmd):
            return subprocess.CompletedProcess(cmd, 1, "", "ERROR: [twitter] boom: HTTP Error 404\n")
        if "yt-dlp" in name or "yt_dlp" in cmd:
            template = cmd[cmd.index("-o") + 1]
            Path(template.replace("%(ext)s", "m4a")).write_bytes(b"fake audio")
        elif name == "ffmpeg":
            Path(cmd[-1]).write_bytes(b"RIFF fake wav")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    @staticmethod
    def transcribe(wav_path, cfg):
        return [(0.0, " All right, hey everyone."), (12.4, "Robinhood ref share."), (6001.2, "Thanks.")]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.cfg = dw.load_config(ROOT / "watch.yaml")
        self.acfg = self.cfg["assets"]["lit"]
        self.queue = self.base / "queue.md"
        self.cache = self.base / "cache"
        self.media = FakeMedia()

    def tearDown(self):
        self.tmp.cleanup()

    def state(self):
        return dw.State.load(self.base / "state" / "lit.json")

    def opts(self, **kw):
        o = {"asset": "lit", "base_dir": self.base, "queue_file": str(self.queue), "cache_dir": self.cache,
             "run_cmd": self.media.run_cmd, "transcribe": self.media.transcribe, "today": TODAY, "now": NOW}
        o.update(kw)
        return o

    def ingest(self, orion, post_id=Q3, http=None, **kw):
        http = http or FakeHttp({post_id: fixture_text(f"tweet-{post_id}.json")})
        return dw.ingest(self.cfg, "lit", f"https://x.com/Lighter_xyz/status/{post_id}", orion, self.opts(http=http, **kw))


class FakeHttp:
    def __init__(self, tweets=None, posts=None):
        self.tweets = dict(tweets or {})
        self.posts = list(posts or [])
        self.get_calls = []

    def get(self, url):
        self.get_calls.append(url)
        for post_id, body in self.tweets.items():
            if f"id={post_id}&" in url:
                return 200, body
        return 503, ""  # an id without a body is an outage (a 404 would mean the post is gone)

    def post(self, url, data):
        return self.posts[0]


class TestTranscriptFormat(Base):
    def test_format_transcript_matches_orion_rule(self):
        segs = [(0.0, " hello "), (59.99, "a\nb"), (61.0, "   "), (5999.0, "x"), (6001.0, "past the hour hundred")]
        text = dw.format_transcript(segs)
        self.assertTrue(text.endswith("\n") and not text.endswith("\n\n"))
        lines = text.rstrip("\n").split("\n")
        for line in lines:
            self.assertRegex(line, r"^\[\d{2,3}:\d{2}\] \S")
        self.assertEqual(lines, ["[00:00] hello", "[00:59] a b", "[99:59] x", "[100:01] past the hour hundred"])
        self.assertEqual(text, orion_normalize(text))

    def test_normalize_doc_text_matches_orion(self):
        self.assertEqual(dw.normalize_doc_text("\ufeff[00:00] a\r\n[00:01] b\n\n\n"), "[00:00] a\n[00:01] b\n")


class TestProcess(Base):
    def test_sha_handshake(self):
        src = self.base / "given.txt"
        src.write_text("[00:00] first line\n[00:05] second line\n\n", encoding="utf-8")  # raw text ends in '\n\n'
        orion = FakeOrion(runs=[completed_run()])
        code, lines = self.ingest(orion, transcript=str(src))
        self.assertEqual(code, 0, lines)
        stored = (self.base / "transcripts" / "lit" / f"{Q3}.txt").read_bytes()
        self.assertEqual(stored, b"[00:00] first line\n[00:05] second line\n")
        rec = self.state().get(Q3)
        self.assertEqual(rec["doc_sha256"], hashlib.sha256(stored).hexdigest())
        self.assertEqual(rec["status"], "run_done")
        add = orion.calls[0][1]
        self.assertEqual((add["kind"], add["source_id"], add["title"], add["published_at"]),
                         ("machine_transcript", f"x:{Q3}", "LIT investor update 2026Q3", "2026-10-22T00:32:09.000Z"))
        for k in add["meta"]:
            self.assertRegex(k, r"^[a-z_]{1,32}$")  # Orion's META_KEY
        self.assertEqual(add["meta"]["asr_model"], "small.en")

    def test_sha_mismatch_fails_the_post(self):
        src = self.base / "given.txt"
        src.write_text("[00:00] first line\n\n", encoding="utf-8")
        orion = FakeOrion(runs=[completed_run()], sha_override="0" * 64)
        code, lines = self.ingest(orion, transcript=str(src))
        self.assertEqual(code, 1)
        self.assertEqual(self.state().get(Q3)["status"], "failed")
        self.assertNotIn("agent_run", orion.names())
        self.assertTrue(lines[0].startswith(f"ORION DISCLOSURE ALERT lit: doc add failed for post {Q3}: sha256 mismatch"),
                        lines)

    def test_transcribed_recording_is_doc_added_and_audio_removed(self):
        orion = FakeOrion(runs=[completed_run()])
        code, lines = self.ingest(orion)
        self.assertEqual(code, 0, lines)
        ytdlp, ffmpeg = self.media.cmds
        self.assertEqual(ytdlp[1:], ["-f", "hls-audio-64000-Audio/bestaudio", "-o", str(self.cache / f"{Q3}.%(ext)s"),
                                     Q3_URL])
        self.assertEqual(Path(ytdlp[0]).name, "yt-dlp")
        self.assertEqual(ffmpeg[0], "ffmpeg")
        self.assertEqual(ffmpeg[ffmpeg.index("-i") + 1], str(self.cache / f"{Q3}.m4a"))
        self.assertEqual(ffmpeg[-7:], ["-ac", "1", "-ar", "16000", "-f", "wav", str(self.cache / f"{Q3}.wav")])
        self.assertEqual(list(self.cache.iterdir()), [])  # audio and WAV deleted
        txt = (self.base / "transcripts" / "lit" / f"{Q3}.txt").read_text()
        self.assertEqual(txt, "[00:00] All right, hey everyone.\n[00:12] Robinhood ref share.\n[100:01] Thanks.\n")
        meta = json.loads((self.base / "transcripts" / "lit" / f"{Q3}.meta.json").read_text())
        for k in ("post_id", "url", "created_at", "duration_s", "asr_model", "audio_sha256", "transcript_sha256",
                  "transcribed_at"):
            self.assertIn(k, meta)
        self.assertEqual(meta["audio_sha256"], hashlib.sha256(b"fake audio").hexdigest())
        self.assertEqual(meta["duration_s"], 2491.6)
        self.assertEqual(self.state().window("2026Q3")["found_post_id"], Q3)  # carry-over: ingest marks the window

    def test_step_failure_alert_line(self):
        self.media = FakeMedia(fail="yt-dlp")
        orion = FakeOrion()
        code, lines = self.ingest(orion)
        self.assertEqual(code, 1)
        self.assertEqual(lines[0], f"ORION DISCLOSURE ALERT lit: download failed for post {Q3}: "
                                   "yt-dlp exit 1: ERROR: [twitter] boom: HTTP Error 404")
        rec = self.state().get(Q3)
        self.assertEqual(rec["status"], "failed")
        self.assertIn("download", rec["error"])
        self.assertEqual(orion.calls, [])
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_transcribe_failure_cleans_audio(self):
        def boom(wav, cfg):
            raise RuntimeError("model load failed")
        orion = FakeOrion()
        code, lines = self.ingest(orion, transcribe=boom)
        self.assertEqual(code, 1)
        self.assertEqual(lines[0], f"ORION DISCLOSURE ALERT lit: transcribe failed for post {Q3}: model load failed")
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_lock_busy_keeps_doc_added_and_retries_next_scan(self):
        orion = FakeOrion(runs=[LOCK_BUSY, completed_run()])
        code, lines = self.ingest(orion)
        rec = self.state().get(Q3)
        self.assertEqual(rec["status"], "doc_added")
        self.assertEqual(rec["doc_id"], 1)
        self.assertTrue(any("run_in_progress" in line for line in lines), lines)
        self.assertFalse(any(line.startswith("ORION DISCLOSURE ALERT") for line in lines), lines)
        n_cmds = len(self.media.cmds)

        http = FakeHttp(tweets={Q3: fixture_text(f"tweet-{Q3}.json")},
                        posts=[(200, fixture_text("ddg-lighter.html"))])
        out = dw.run_scan(self.cfg, self.base, http, TODAY, sleep=lambda s: None, now=NOW,
                          opts=self.opts(orion=orion))
        self.assertEqual(orion.names(), ["doc_add", "agent_run", "doc_add", "agent_run", "run_show"])
        self.assertEqual(orion.calls[2][1]["text"], orion.calls[0][1]["text"])  # same text: doc add is idempotent
        self.assertEqual(len(self.media.cmds), n_cmds)  # the stored transcript is reused, no new download
        rec = self.state().get(Q3)
        self.assertEqual((rec["status"], rec["doc_id"], rec["run_id"], rec["run_outcome"]), ("run_done", 1, 1, "completed"))
        self.assertTrue(out[0].startswith("ORION DISCLOSURE lit | LIT investor update 2026Q3"), out)

    def test_run_failure_is_not_retried_automatically(self):
        orion = FakeOrion(runs=[failed_run()])
        code, lines = self.ingest(orion)
        self.assertEqual(code, 1)
        rec = self.state().get(Q3)
        self.assertEqual((rec["status"], rec["run_id"], rec["run_outcome"]), ("run_failed", 4, "error"))
        self.assertIn("analyst disclosure run #4 ended error: nothing filed; doc #1 is stored; retry: ingest --force",
                      lines)
        http = FakeHttp(tweets={Q3: fixture_text(f"tweet-{Q3}.json")},
                        posts=[(200, fixture_text("ddg-lighter.html"))])
        dw.run_scan(self.cfg, self.base, http, TODAY, sleep=lambda s: None, now=NOW, opts=self.opts(orion=orion))
        self.assertEqual(orion.names().count("agent_run"), 1)
        self.assertEqual(self.state().get(Q3)["status"], "run_failed")

    def test_run_error_without_a_run_is_an_alert(self):
        orion = FakeOrion(runs=[(1, {"error": {"code": "asset_not_found", "message": "no asset lit"}})])
        code, lines = self.ingest(orion)
        self.assertEqual(code, 1)
        self.assertEqual(lines[0], f"ORION DISCLOSURE ALERT lit: run failed for post {Q3}: asset_not_found: no asset lit")
        self.assertEqual(self.state().get(Q3)["status"], "run_failed")

    def test_non_completed_run_digest(self):
        orion = FakeOrion(runs=[failed_run("budget_exhausted")])
        code, lines = self.ingest(orion)
        self.assertEqual(lines[1], "analyst disclosure run #4 ended budget_exhausted: nothing filed; doc #1 is stored; "
                                   "retry: ingest --force")
        self.assertFalse(self.queue.exists())

    def test_blocked_signal_exit_2_is_run_done(self):
        code, r = completed_run()
        orion = FakeOrion(runs=[(2, r)])
        code, lines = self.ingest(orion)
        self.assertEqual(code, 0)
        self.assertEqual(self.state().get(Q3)["status"], "run_done")

    def test_scan_processes_at_most_one_queued_post_oldest_first(self):
        st = self.state()
        st.set("2113065839352336774", status="queued", kind="recording")
        st.set("2073044023661453589", status="queued", kind="recording")
        st.save()
        tweets = {i: fixture_text(f"tweet-{i}.json") for i in ("2113065839352336774", "2073044023661453589")}
        http = FakeHttp(tweets=tweets, posts=[(200, fixture_text("ddg-lighter.html"))])
        orion = FakeOrion(runs=[completed_run()])
        dw.run_scan(self.cfg, self.base, http, TODAY, sleep=lambda s: None, now=NOW, opts=self.opts(orion=orion))
        st = self.state()
        self.assertEqual(st.get("2073044023661453589")["status"], "run_done")
        self.assertEqual(st.get("2113065839352336774")["status"], "queued")


class TestIngest(Base):
    def test_ingest_refuses_foreign_author(self):
        body = tweet(Q3)
        body["user"] = dict(body["user"], id_str="44196397", screen_name="Lighter_xyz")
        orion = FakeOrion()
        code, lines = self.ingest(orion, http=FakeHttp({Q3: json.dumps(body)}))
        self.assertEqual(code, 1)
        self.assertIn("not by the configured author", lines[0])
        self.assertEqual(orion.calls, [])
        self.assertIsNone(self.state().get(Q3))
        self.assertEqual(self.media.cmds, [])

    def test_ingest_text_only_post_becomes_post_doc(self):
        body = fixture_text("tweet-text-only.json")
        post_id = json.loads(body)["id_str"]
        orion = FakeOrion(runs=[completed_run()])
        code, lines = dw.ingest(self.cfg, "lit", f"https://x.com/Lighter_xyz/status/{post_id}", orion,
                                self.opts(http=FakeHttp({post_id: body})))
        self.assertEqual(code, 0, lines)
        add = orion.calls[0][1]
        self.assertEqual(add["kind"], "post")
        self.assertEqual(add["source_id"], f"x:{post_id}")
        self.assertTrue(add["text"].startswith("We're hosting our Q3 Investor Call on Wednesday, October 21"))
        self.assertIn("Q&A session", add["text"])  # HTML entities from tweet-result are decoded
        self.assertEqual(self.media.cmds, [])  # no download, no ASR
        self.assertEqual(self.state().get(post_id)["kind"], "post")
        self.assertIn(f"doc #1 post |", lines[0])

    def test_ingest_known_id_refused_without_force(self):
        st = self.state()
        st.set(Q3, status="seeded", kind="recording")
        st.save()
        orion = FakeOrion(runs=[completed_run()])
        code, lines = self.ingest(orion)
        self.assertEqual(code, 1)
        self.assertIn("already known (status seeded)", lines[0])
        self.assertIn("--force", lines[0])
        self.assertEqual(orion.calls, [])
        code, lines = self.ingest(orion, force=True)
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.state().get(Q3)["status"], "run_done")

    def test_force_reuses_the_stored_transcript(self):
        orion = FakeOrion(runs=[failed_run(), completed_run()])
        self.ingest(orion)
        n = len(self.media.cmds)
        code, lines = self.ingest(orion, force=True)
        self.assertEqual(code, 0, lines)
        self.assertEqual(len(self.media.cmds), n)
        self.assertEqual(orion.names(), ["doc_add", "agent_run", "doc_add", "agent_run", "run_show"])

    def test_dry_run_requires_an_explicit_queue_file(self):
        code, lines = dw.ingest(self.cfg, "lit", Q3_URL, FakeOrion(), self.opts(dry_run=True, queue_file=None))
        self.assertEqual(code, 2)
        self.assertIn("--dry-run needs an explicit --queue-file", lines[0])
        r = subprocess.run([sys.executable, str(ROOT / "bin" / "disclosure_watch.py"), "--base-dir", str(self.base),
                            "ingest", "--asset", "lit", "--url", Q3_URL, "--dry-run"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("--dry-run needs an explicit --queue-file", r.stderr)
        self.assertFalse((self.base / "state").exists())

    def test_dry_run_passes_dry_run_and_leaves_state_alone(self):
        st = self.state()
        st.set(Q3, status="seeded", kind="recording")
        st.save()
        before = (self.base / "state" / "lit.json").read_text()
        orion = FakeOrion(runs=[completed_run(dry_run=True)])
        src = self.base / "given.txt"
        src.write_text("[00:00] hello\n", encoding="utf-8")
        code, lines = self.ingest(orion, dry_run=True, transcript=str(src), orion_home=str(self.base / "oh"))
        self.assertEqual(code, 0, lines)
        self.assertEqual(orion.calls[1], ("agent_run", {"asset": "lit", "doc_id": 1, "dry_run": True}))
        self.assertEqual((self.base / "state" / "lit.json").read_text(), before)
        self.assertFalse((self.base / "transcripts").exists())
        self.assertIn("dry run: nothing filed", "\n".join(lines))

    def test_dry_run_requires_an_explicit_orion_home(self):
        # F2 (ruling 16): exit 2 before the lock or any state, like --queue-file.
        orion = FakeOrion(runs=[completed_run(dry_run=True)])
        code, lines = dw.ingest(self.cfg, "lit", Q3_URL, orion, self.opts(dry_run=True, orion_home=None))
        self.assertEqual(code, 2)
        self.assertIn("--dry-run needs an explicit --orion-home", lines[0])
        self.assertEqual(orion.calls, [])
        self.assertFalse((self.base / "state").exists())
        r = subprocess.run([sys.executable, str(ROOT / "bin" / "disclosure_watch.py"), "--base-dir", str(self.base),
                            "ingest", "--asset", "lit", "--url", Q3_URL, "--dry-run", "--queue-file", str(self.queue)],
                           capture_output=True, text=True, env={**os.environ, "ORION_DW_REPO": str(self.base / "norepo")})
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("--dry-run needs an explicit --orion-home", r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertFalse((self.base / "state").exists())
        self.assertFalse(self.queue.exists())

    def test_post_run_failure_is_an_alert_and_keeps_run_done(self):
        # F4: the queue path is a directory -> post_run raises; alert line first, a log entry, state stays run_done.
        qdir = self.base / "qdir"
        qdir.mkdir()
        orion = FakeOrion(runs=[completed_run()])
        code, lines = self.ingest(orion, queue_file=str(qdir))
        self.assertTrue(lines[0].startswith(f"ORION DISCLOSURE ALERT lit: post-run failed for post {Q3}: "), lines)
        self.assertEqual(self.state().get(Q3)["status"], "run_done")
        log = [json.loads(line) for line in (self.base / "log" / "lit.jsonl").read_text().splitlines()]
        pr = [e for e in log if e.get("post_run_failed")]
        self.assertEqual(len(pr), 1, log)
        self.assertEqual(pr[0]["post_run_failed"], Q3)
        self.assertIn("Errno", pr[0]["error"])

    def test_corrupt_meta_json_is_not_reused(self):
        # F4: an unreadable .meta.json does not crash the run; the post is transcribed again.
        tdir = self.base / "transcripts" / "lit"
        tdir.mkdir(parents=True)
        (tdir / f"{Q3}.txt").write_text("[00:00] stale\n", encoding="utf-8")
        (tdir / f"{Q3}.meta.json").write_text("{not json", encoding="utf-8")
        orion = FakeOrion(runs=[completed_run()])
        code, lines = self.ingest(orion)
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.state().get(Q3)["status"], "run_done")
        self.assertTrue(any("yt-dlp" in " ".join(c) or "yt_dlp" in c for c in self.media.cmds), self.media.cmds)
        self.assertNotIn("stale", orion.calls[0][1]["text"])
        json.loads((tdir / f"{Q3}.meta.json").read_text(encoding="utf-8"))  # rewritten

    def test_stop_after_doc_add(self):
        orion = FakeOrion()
        code, lines = self.ingest(orion, stop_after="doc-add")
        self.assertEqual(code, 0, lines)
        self.assertEqual(orion.names(), ["doc_add"])
        self.assertEqual(self.state().get(Q3)["status"], "doc_added")


class TestStateLock(Base):
    def test_second_run_waits_then_gives_up_with_an_alert(self):
        lock_path = self.base / "state" / "lit.lock"
        lock_path.parent.mkdir(parents=True)
        with open(lock_path, "w") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            code, lines = self.ingest(FakeOrion(), lock_timeout=0.3)
            out = dw.run_scan(self.cfg, self.base, FakeHttp(posts=[(200, "")]), TODAY, sleep=lambda s: None, now=NOW,
                              opts={"lock_timeout": 0.3})
        self.assertEqual(code, 1)
        self.assertRegex(lines[0], r"^ORION DISCLOSURE ALERT lit: another watcher run holds .*lit\.lock")
        self.assertRegex(out[0], r"^ORION DISCLOSURE ALERT lit: another watcher run holds .*lit\.lock")
        self.assertFalse((self.base / "state" / "lit.json").exists())


class TestCarryOvers(Base):
    def test_successful_search_clears_last_failed_day(self):
        st = self.state()
        st.data["search"].update(last_failed_day="2026-10-22", consecutive_failures=1)
        st.save()
        tweets = {i: fixture_text(f"tweet-{i}.json") for i in (Q3, ANNOUNCEMENT)}  # some fetches work (B4)
        http = FakeHttp(tweets=tweets, posts=[(200, fixture_text("ddg-lighter.html"))])
        dw.run_scan(self.cfg, self.base, http, TODAY, sleep=lambda s: None, now=NOW)
        s = self.state().data["search"]
        self.assertEqual(s["consecutive_failures"], 0)
        self.assertIsNone(s.get("last_failed_day"))

    def test_http_exception_is_a_network_error(self):
        import http.client
        h = dw.UrllibHttp()

        def raise_bad_status(req, timeout):
            raise http.client.RemoteDisconnected("Remote end closed connection without response")
        orig = dw.urllib.request.urlopen
        dw.urllib.request.urlopen = raise_bad_status
        try:
            with self.assertRaises(OSError):
                h.get("https://example.invalid/")
            with self.assertRaises(OSError):
                dw.UrllibHttp()._send(dw.urllib.request.Request("https://example.invalid/"))
        finally:
            dw.urllib.request.urlopen = orig

        def raise_incomplete(req, timeout):
            raise http.client.IncompleteRead(b"x")
        dw.urllib.request.urlopen = raise_incomplete
        try:
            with self.assertRaises(OSError):
                h.post("https://example.invalid/", {"q": "x"})
        finally:
            dw.urllib.request.urlopen = orig


class TestOrionCli(unittest.TestCase):
    """The real driver's command lines, against a fake `node` on PATH that echoes argv, cwd and ORION_HOME."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        (d / "bin").mkdir()
        node = d / "bin" / "node"
        node.write_text("#!/bin/sh\n"
                        "if [ -n \"$FAKE_NODE_OUT\" ]; then printf '%s' \"$FAKE_NODE_OUT\"; exit \"$FAKE_NODE_EXIT\"; fi\n"
                        f"exec {sys.executable} -c 'import json,os,sys; print(json.dumps("
                        "{\"argv\": sys.argv[1:], \"cwd\": os.getcwd(), \"home\": os.environ[\"ORION_HOME\"]}))' \"$@\"\n")
        node.chmod(0o755)
        self.repo, self.home = d / "repo", d / "home"
        self.repo.mkdir()
        self.env = {"PATH": f"{d / 'bin'}:{os.environ['PATH']}"}
        self.orion = dw.OrionCli(self.repo, self.home)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, fn, **env):
        old = {k: os.environ.get(k) for k in [*self.env, *env]}
        os.environ.update(self.env, **env)
        try:
            return fn()
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_command_lines(self):
        code, out = self.call(lambda: self.orion.agent_run("lit", 3, False))
        self.assertEqual(code, 0)
        self.assertEqual(out["argv"], ["dist/cli/index.js", "agent", "run", "lit", "--type", "disclosure", "--doc", "3",
                                       "--json"])  # no --out since Phase 1 (1.5c Task 11)
        self.assertEqual((out["cwd"], out["home"]), (str(self.repo), str(self.home)))
        code, out = self.call(lambda: self.orion.agent_run("lit", 3, True))
        self.assertEqual(out["argv"][-2:], ["--dry-run", "--json"])
        self.assertNotIn("--out", out["argv"])
        out = self.call(lambda: self.orion.doc_add("lit", url=Q3_URL, file="/t/x.txt", kind="machine_transcript",
                                                   source_id=f"x:{Q3}", published_at="2026-10-22T00:32:09.000Z",
                                                   title="LIT investor update 2026Q3", meta={"asr_model": "small.en"}))
        self.assertEqual(out["argv"], ["dist/cli/index.js", "doc", "add", "lit", "--url", Q3_URL, "--file", "/t/x.txt",
                                       "--kind", "machine_transcript", "--source-id", f"x:{Q3}", "--published-at",
                                       "2026-10-22T00:32:09.000Z", "--title", "LIT investor update 2026Q3",
                                       "--meta", "asr_model=small.en", "--json"])
        self.assertEqual(self.call(lambda: self.orion.run_show(5))["argv"][1:], ["agent", "runs", "show", "5", "--json"])
        self.assertEqual(self.call(lambda: self.orion.inbox("lit"))["argv"][1:], ["inbox", "lit", "--json"])

    def test_run_in_progress_shape_and_doc_add_errors(self):
        busy = json.dumps(LOCK_BUSY[1], indent=2)  # what guarded() prints under --json, with exit code 1
        code, out = self.call(lambda: self.orion.agent_run("lit", 3, False), FAKE_NODE_OUT=busy, FAKE_NODE_EXIT="1")
        self.assertEqual((code, out["error"]["code"]), (1, "run_in_progress"))
        bad = json.dumps({"error": {"code": "invalid_transcript", "message": "line 3 is not a segment"}})
        with self.assertRaisesRegex(dw.OrionCliError, "invalid_transcript: line 3"):
            self.call(lambda: self.orion.doc_add("lit", url=Q3_URL, file="/t", kind="post", source_id="x:1",
                                                 published_at="x", title="t", meta={}),
                      FAKE_NODE_OUT=bad, FAKE_NODE_EXIT="1")

    def test_run_show_null_error_field_is_success_and_feeds_the_digest_cost(self):
        # The real runs-show row always carries an `error` column (null on success); only an object is an error.
        row = json.dumps({"id": 43, "outcome": "completed", "error": None, "estimated_cost_usd": 1.05})
        show = self.call(lambda: self.orion.run_show(43), FAKE_NODE_OUT=row, FAKE_NODE_EXIT="0")
        self.assertEqual((show["id"], show["estimated_cost_usd"]), (43, 1.05))
        import test_postrun as tp
        with tempfile.TemporaryDirectory() as d:
            cfg = dw.load_config(ROOT / "watch.yaml")["assets"]["lit"]
            digest = dw.post_run(run_fixture(), tp.EMPTY_INBOX, show, cfg, Path(d) / "q.md", tp.post_meta())
        self.assertRegex(digest.split("\n")[1], r"^analyst disclosure run #\d+ completed \| .* \| est \$1\.05$")
        err = json.dumps({"error": {"code": "x", "message": "y"}})
        with self.assertRaisesRegex(dw.OrionCliError, "x: y"):
            self.call(lambda: self.orion.run_show(43), FAKE_NODE_OUT=err, FAKE_NODE_EXIT="0")


class TestCheckAcceptance(unittest.TestCase):
    SCRIPT = ROOT / "bin" / "check_acceptance.py"

    def run_check(self, data):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run.json"
            p.write_text(json.dumps(data))
            return subprocess.run([sys.executable, str(self.SCRIPT), str(p)], capture_output=True, text=True)

    def test_check_acceptance_passes_on_the_level2_fixture(self):
        r = self.run_check(run_fixture())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for n in range(1, 6):
            self.assertRegex(r.stdout, rf"(?m)^PASS criterion {n}\b")

    def test_check_acceptance_fails_on_wrong_tranche_date(self):
        data = run_fixture()
        data["staged"]["proposals"][0]["change"]["edits"][0]["value"]["first"] = "2026-12-29"
        r = self.run_check(data)
        self.assertEqual(r.returncode, 1)
        self.assertRegex(r.stdout, r"(?m)^FAIL criterion 1\b")
        for n in range(2, 6):
            self.assertRegex(r.stdout, rf"(?m)^PASS criterion {n}\b")

    def test_check_acceptance_other_failures(self):
        cases = {
            2: lambda d: d["staged"]["devFindings"][0].update(orionReading="Orion measures 6,100,000 USD against 8.5M."),
            3: lambda d: d["staged"]["devFindings"][1].update(claim="8.5M of revenue.", title="Revenue gap",
                                                              proposedFix="Look again."),
            4: lambda d: d["staged"]["journal"]["catalysts"][0].update(to="2027-06-30"),
            5: lambda d: d["run"].update(dryRun=False),
        }
        for n, mutate in cases.items():
            data = run_fixture()
            mutate(data)
            r = self.run_check(data)
            self.assertEqual(r.returncode, 1, (n, r.stdout))
            self.assertRegex(r.stdout, rf"(?m)^FAIL criterion {n}\b")

    def test_any_passing_candidate_passes_criteria_1_to_3(self):
        # F3: a wrong candidate first, the correct one second -> PASS.
        data = run_fixture()
        bad_p = copy.deepcopy(data["staged"]["proposals"][0])
        bad_p["change"]["edits"][0]["value"]["first"] = "2026-12-29"
        data["staged"]["proposals"].insert(0, bad_p)
        bad_cited = copy.deepcopy(data["staged"]["proposals"][1])  # right tranches, wrong locator
        for c in bad_cited["citations"]:
            c["locator"] = "01:00"
        data["staged"]["proposals"].insert(0, bad_cited)
        f_hold, f_rev = copy.deepcopy(data["staged"]["devFindings"])
        bad_hold = copy.deepcopy(f_hold)
        bad_hold["orionReading"] = "Orion measures 6,100,000 USD against 8.5M."
        bad_rev = copy.deepcopy(f_rev)
        bad_rev.update(claim="8.5M of revenue.", title="Revenue gap", proposedFix="Look again.")
        data["staged"]["devFindings"] = [bad_hold, bad_rev, f_hold, f_rev]
        r = self.run_check(data)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for n in range(1, 6):
            self.assertRegex(r.stdout, rf"(?m)^PASS criterion {n}\b")

    def test_first_failure_reason_reported_when_no_candidate_passes(self):
        data = run_fixture()
        bad_cited = copy.deepcopy(data["staged"]["proposals"][0])
        for c in bad_cited["citations"]:
            c["locator"] = "01:00"
        data["staged"]["proposals"] = [bad_cited]
        r = self.run_check(data)
        self.assertEqual(r.returncode, 1)
        self.assertRegex(r.stdout, r"(?m)^FAIL criterion 1: a tranches config proposal exists but cites")

    def test_locator_outside_range_fails_criterion_1(self):
        data = run_fixture()
        for c in data["staged"]["proposals"][0]["citations"]:
            c["locator"] = "12:56"
        r = self.run_check(data)
        self.assertEqual(r.returncode, 1)
        self.assertRegex(r.stdout, r"(?m)^FAIL criterion 1\b")


if __name__ == "__main__":
    unittest.main()
