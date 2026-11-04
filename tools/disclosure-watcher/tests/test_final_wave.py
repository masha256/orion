"""Final fix wave (B1-B7): the run JSON file and check_acceptance's runs-show shape, the agent-run timeout, Slack
hardening of model and error text, tweet-result failures toward the search alert, the window-closed catch-up, strict
fingerprints, and the guarded post-run log write.

No network, no ASR, no Orion: the same fakes as test_process.
"""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bin"))
sys.path.insert(0, str(ROOT / "tests"))

import disclosure_watch as dw  # noqa: E402
from test_process import (NOW, Q3, TODAY, Base, FakeHttp, FakeMedia, FakeOrion, completed_run,  # noqa: E402
                          fixture_text, run_fixture)

RECORDINGS = ["2039862458572001352", "2073044023661453589", "2113065839352336774"]
ANNOUNCEMENT = "2111481510230675531"
FOUR = sorted(RECORDINGS + [ANNOUNCEMENT])
FIFTH = "2111481514676637854"  # in the DuckDuckGo fixture, no tweet-result fixture
WINDOW_Q3_CLOSED = "ORION DISCLOSURE lit: window 2026Q3 closed with no investor-call recording found"
FP = "a" * 64


def ddg_ok():
    return 200, fixture_text("ddg-lighter.html")


def all_tweets():
    return {i: fixture_text(f"tweet-{i}.json") for i in FOUR}


class ScanHttp(FakeHttp):
    """post() always answers the DuckDuckGo fixture; get() answers tweet-result from the given bodies (else 503)."""

    def __init__(self, tweets=None):
        super().__init__(tweets=tweets, posts=[ddg_ok()])


class ScanBase(Base):
    def scan(self, today, tweets=None):
        return dw.run_scan(self.cfg, self.base, ScanHttp(tweets if tweets is not None else all_tweets()), today,
                           sleep=lambda s: None)

    def seed(self):
        st = self.state()
        for i in RECORDINGS:
            st.set(i, status="seeded", kind="recording")
        st.set(ANNOUNCEMENT, status="seeded", kind="announcement")
        st.set(FIFTH, status="irrelevant")  # every id known: no scan day is a failed tweet-result day
        st.save()


# ---------------------------------------------------------------- B1

class TestRunJson(Base):
    def test_ingest_writes_the_raw_run_result_to_the_default_run_json(self):
        orion = FakeOrion(runs=[completed_run()])
        code, lines = self.ingest(orion)
        self.assertEqual(code, 0, lines)
        path = self.base / "transcripts" / "lit" / f"{Q3}.run.json"
        self.assertEqual(json.loads(path.read_text(encoding="utf-8")), completed_run()[1])

    def test_ingest_writes_to_an_explicit_run_json(self):
        orion = FakeOrion(runs=[completed_run()])
        target = self.base / "out" / "r.json"
        code, lines = self.ingest(orion, run_json=str(target))
        self.assertEqual(code, 0, lines)
        self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["run"]["id"], completed_run()[1]["run"]["id"])
        self.assertFalse((self.base / "transcripts" / "lit" / f"{Q3}.run.json").exists())

    def test_dry_run_default_sits_next_to_the_queue_file(self):
        qdir = self.base / "dry"
        qdir.mkdir()
        orion = FakeOrion(runs=[completed_run(dry_run=True)])
        src = self.base / "given.txt"
        src.write_text("[00:00] hello\n", encoding="utf-8")
        code, lines = self.ingest(orion, dry_run=True, transcript=str(src), orion_home=str(self.base / "oh"),
                                  queue_file=str(qdir / "queue.md"))
        self.assertEqual(code, 0, lines)
        data = json.loads((qdir / f"{Q3}.run.json").read_text(encoding="utf-8"))
        self.assertIs(data["run"]["dryRun"], True)
        self.assertFalse((self.base / "transcripts").exists())

    def test_a_failed_run_result_is_written_too(self):
        err = (1, {"error": {"code": "asset_not_found", "message": "no asset lit"}})
        code, lines = self.ingest(FakeOrion(runs=[err]))
        self.assertEqual(code, 1)
        self.assertEqual(json.loads((self.base / "transcripts" / "lit" / f"{Q3}.run.json").read_text()), err[1])

    def test_cli_has_the_run_json_flag(self):
        r = subprocess.run([sys.executable, str(ROOT / "bin" / "disclosure_watch.py"), "ingest", "--help"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("--run-json", r.stdout)


class TestCheckAcceptanceShapes(unittest.TestCase):
    SCRIPT = ROOT / "bin" / "check_acceptance.py"

    def run_check(self, data):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run.json"
            p.write_text(json.dumps(data))
            return subprocess.run([sys.executable, str(self.SCRIPT), str(p)], capture_output=True, text=True)

    def assert_all_pass(self, data):
        r = self.run_check(data)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for n in range(1, 6):
            self.assertRegex(r.stdout, rf"(?m)^PASS criterion {n}\b")

    def test_both_shapes_pass_on_the_fixture(self):
        fixture = run_fixture()
        self.assert_all_pass(fixture)  # the `agent run --json` shape
        self.assert_all_pass(fixture["run"])  # the run row, as `agent runs show --json` prints it (no top-level staged)

    def test_a_reshaped_runs_show_copy_passes(self):
        fixture = run_fixture()
        show = {**copy.deepcopy(fixture["run"]), "estimated_cost_usd": 1.23}
        show["summary"]["staged"] = copy.deepcopy(fixture["staged"])
        self.assertNotIn("staged", show)
        self.assert_all_pass(show)
        show["summary"]["staged"]["journal"]["catalysts"] = []
        r = self.run_check(show)
        self.assertEqual(r.returncode, 1)
        self.assertRegex(r.stdout, r"(?m)^FAIL criterion 4\b")


# ---------------------------------------------------------------- B2

class TestTimeout(unittest.TestCase):
    def test_agent_run_timeout_is_1800_s(self):
        self.assertEqual(dw.OrionCli("/r", "/h").timeout, 1800)


# ---------------------------------------------------------------- B3

class TestSlackHardening(Base):
    def test_angle_brackets_never_survive(self):
        out = dw.clean_model_text("<mailto:a@b|x>", 200)
        self.assertNotIn("<", out)
        self.assertNotIn(">", out)
        self.assertEqual(out, "\u2039mailto:a@b|x\u203a")
        for keep in (False, True):
            out = dw.clean_model_text("a < b > c <https://x.example|y> <tel:1>", 200, keep_newlines=keep)
            self.assertNotIn("<", out)
            self.assertNotIn(">", out)

    def test_broadcast_mentions_are_removed(self):
        self.assertEqual(dw.clean_model_text("ping @channel now", 200), "ping now")
        for s in ("@here x", "x @Everyone", "a @CHANNEL, b", "@here@channel"):
            out = dw.clean_model_text(s, 200).lower()
            for bad in ("@here", "@channel", "@everyone"):
                self.assertNotIn(bad, out, (s, out))

    def test_alert_from_stderr_prints_no_slack_sequence(self):
        class LoudMedia(FakeMedia):
            def run_cmd(self, cmd):
                self.cmds.append(list(cmd))
                return subprocess.CompletedProcess(cmd, 1, "", "ERROR: <!channel> boom @here <@U1> <mailto:a@b|x>\n")
        self.media = LoudMedia()
        code, lines = self.ingest(FakeOrion())
        self.assertEqual(code, 1)
        alert = lines[0]
        self.assertTrue(alert.startswith(f"ORION DISCLOSURE ALERT lit: download failed for post {Q3}: yt-dlp exit 1:"),
                        alert)
        for bad in ("<", ">", "!channel", "@here", "<@"):
            self.assertNotIn(bad, alert)
        self.assertNotIn("<!channel>", self.state().get(Q3)["error"])

    def test_orion_error_messages_are_cleaned(self):
        err = (1, {"error": {"code": "asset_not_found", "message": "no asset <!here> @everyone"}})
        code, lines = self.ingest(FakeOrion(runs=[err]))
        self.assertEqual(lines[0], f"ORION DISCLOSURE ALERT lit: run failed for post {Q3}: asset_not_found: no asset")
        busy = (1, {"error": {"code": "run_in_progress", "message": "locked <!channel> by @here pid 1"}})
        code, lines = self.ingest(FakeOrion(runs=[busy]), force=True)
        text = "\n".join(lines)
        self.assertIn("run_in_progress", text)
        for bad in ("<", ">", "@here", "!channel"):
            self.assertNotIn(bad, text)

    def test_one_line_is_cleaned_and_capped_at_300(self):
        self.assertEqual(dw._one_line("first\n<!channel> last @here line\n"), "last line")
        self.assertEqual(len(dw._one_line("x" * 1000)), 300)


# ---------------------------------------------------------------- B4

class TestTweetResultFailures(ScanBase):
    def test_a_day_where_every_tweet_result_fetch_failed_counts_toward_the_alert(self):
        # Search works, but every new id 503s at tweet-result: three such days alert, naming tweet-result.
        self.assertEqual(self.scan(date(2026, 10, 21), tweets={}), [])
        self.assertEqual(self.scan(date(2026, 10, 21), tweets={}), [])  # the same day again counts once
        self.assertEqual(self.state().data["search"]["consecutive_failures"], 1)
        self.assertEqual(self.scan(date(2026, 10, 22), tweets={}), [])
        out = self.scan(date(2026, 10, 23), tweets={})
        self.assertEqual(len(out), 1, out)
        self.assertTrue(out[0].startswith("ORION DISCLOSURE ALERT lit: search failed 3 scan days running ("), out)
        self.assertIn("tweet-result", out[0])
        self.assertEqual(self.state().data["posts"], {})
        # A day where one fetch works resets the count.
        self.scan(date(2026, 10, 24))
        self.assertEqual(self.state().data["search"]["consecutive_failures"], 0)

    def _gone_case(self, status, body, note):
        self.seed()
        st = self.state()
        del st.data["posts"][FIFTH]  # FIFTH is the only new id
        st.save()

        class GoneHttp(ScanHttp):
            def get(self, url):
                self.get_calls.append(url)
                return status, body
        http = GoneHttp({})
        self.assertEqual(dw.run_scan(self.cfg, self.base, http, date(2026, 10, 21), sleep=lambda s: None), [])
        self.assertEqual(len(http.get_calls), 1)
        st = self.state()
        rec = st.get(FIFTH)
        self.assertEqual(rec["status"], "irrelevant")
        self.assertIsNone(rec["kind"])
        self.assertIn(note, rec["error"])
        self.assertEqual(st.data["search"]["consecutive_failures"], 0)
        self.assertIsNone(st.data["search"].get("last_failed_day"))
        http2 = GoneHttp({})
        dw.run_scan(self.cfg, self.base, http2, date(2026, 10, 22), sleep=lambda s: None)
        self.assertEqual(http2.get_calls, [])  # deduped forever
        self.assertEqual(self.state().data["search"]["consecutive_failures"], 0)

    def test_a_404_post_is_irrelevant_not_a_failed_fetch(self):
        self._gone_case(404, "", "unavailable (404)")

    def test_a_tombstone_post_is_irrelevant_not_a_failed_fetch(self):
        self._gone_case(200, json.dumps({"__typename": "TweetTombstone", "tombstone": {"text": {"text": "gone"}}}),
                        "tombstone")

    def test_a_tombstone_key_or_empty_object_is_irrelevant(self):
        for body, note in ((json.dumps({"tombstone": {}}), "tombstone"), ("{}", "unavailable")):
            with self.subTest(body=body):
                self.assertRaisesRegex(dw.PostUnavailable, note, dw.fetch_post,
                                       ScanHttp({"1" * 19: body}), "1" * 19)

    def test_429_5xx_and_unparsable_bodies_are_fetch_failures_not_unavailable(self):
        for status, body in ((429, ""), (500, ""), (503, ""), (200, "<html>"), (200, "[]")):
            with self.subTest(status=status, body=body):
                with self.assertRaises(RuntimeError) as cm:
                    dw.fetch_post(type("H", (), {"get": lambda self, url: (status, body)})(), "1" * 19)
                self.assertNotIsInstance(cm.exception, dw.PostUnavailable)

    def test_a_503_on_every_new_id_still_counts_as_a_failed_day(self):
        for day in (21, 22):
            self.assertEqual(self.scan(date(2026, 10, day), tweets={}), [])  # unknown ids answer 503
        self.assertEqual(self.state().data["search"]["consecutive_failures"], 2)
        out = self.scan(date(2026, 10, 23), tweets={})
        self.assertEqual(len(out), 1, out)
        self.assertIn("HTTP 503", out[0])
        self.assertEqual(self.state().data["posts"], {})

    def test_some_fetches_failing_or_no_new_ids_is_not_a_failure(self):
        self.scan(date(2026, 10, 21))  # FIFTH 503s, the four others are fetched
        self.assertEqual(self.state().data["search"]["consecutive_failures"], 0)
        st = self.state()
        st.set(FIFTH, status="irrelevant")
        st.save()
        self.scan(date(2026, 10, 22), tweets={})  # every id known: nothing attempted
        self.assertEqual(self.state().data["search"]["consecutive_failures"], 0)


# ---------------------------------------------------------------- B5

class TestWindowClosedCatchUp(ScanBase):
    def test_a_missed_last_day_is_reported_once_by_the_next_scan(self):
        self.seed()
        st = self.state()
        st.data["windows"] = {}
        st.save()
        self.assertEqual(self.scan(date(2026, 11, 3)), [])
        # 2026-11-04 (the last day of the Q3 window) is missed; 2026-11-09 is the next Monday scan.
        self.assertEqual(self.scan(date(2026, 11, 9)), [WINDOW_Q3_CLOSED])
        self.assertEqual(self.scan(date(2026, 11, 16)), [])
        self.assertTrue(self.state().data["windows"]["2026Q3"]["closed_reported"])

    def test_no_report_before_the_last_day_or_when_found(self):
        self.seed()
        st = self.state()
        st.data["windows"] = {"2026Q3": {"found_post_id": Q3, "closed_reported": False}}
        st.save()
        self.assertEqual(self.scan(date(2026, 11, 9)), [])  # found: nothing to report
        self.assertEqual(self.scan(date(2027, 1, 4)), [])  # inside the Q4 window: Q4 has not ended


# ---------------------------------------------------------------- B6

class TestStrictFingerprint(unittest.TestCase):
    def test_fingerprint_must_be_exactly_64_lowercase_hex(self):
        self.assertEqual(dw._fingerprint({"fingerprint": FP}), FP)
        for bad in ("a" * 63, "a" * 65, "A" * 64, "g" + "a" * 64, "a" * 32 + "-" + "a" * 32, " " + FP, None, 12, ""):
            self.assertEqual(dw._fingerprint({"fingerprint": bad}), "", bad)

    def test_a_non_conforming_fingerprint_is_skipped_and_counted(self):
        with tempfile.TemporaryDirectory() as d:
            queue = Path(d) / "dev-queue-revenue.md"
            run = run_fixture()
            run["staged"]["devFindings"][0]["fingerprint"] = "g" + run["staged"]["devFindings"][0]["fingerprint"]
            meta = {"asset": "lit", "title": "LIT investor update 2026Q3", "url": "https://x.com/Lighter_xyz/status/1",
                    "posted": "2026-10-22", "doc_id": 1, "kind": "machine_transcript", "duration_s": 2491.6,
                    "asr_model": "small.en", "today": TODAY}
            digest = dw.post_run(run, {}, {}, {}, queue, meta)
            self.assertEqual(queue.read_text().count("<!-- dw:fp="), 1)
            self.assertIn("1 skipped (no fingerprint)", digest)


# ---------------------------------------------------------------- B7

class TestGuards(Base):
    def test_a_failing_log_write_does_not_hide_the_post_run_alert(self):
        qdir = self.base / "qdir"
        qdir.mkdir()  # the queue path is a directory: post_run raises
        (self.base / "log" / "lit.jsonl").mkdir(parents=True)  # and the log write raises too
        st = self.state()
        st.set(Q3, status="queued", kind="recording")
        st.save()
        orion = FakeOrion(runs=[completed_run()])
        lines = dw.process_post(Q3, self.acfg, self.state(), orion,
                                self.opts(http=FakeHttp({Q3: fixture_text(f"tweet-{Q3}.json")}), queue_file=str(qdir)))
        self.assertTrue(lines[0].startswith(f"ORION DISCLOSURE ALERT lit: post-run failed for post {Q3}: "), lines)
        self.assertEqual(self.state().get(Q3)["status"], "run_done")

    def test_criterion_1_skips_non_dict_edits(self):
        sys.path.insert(0, str(ROOT / "bin"))
        import check_acceptance as ca
        data = run_fixture()
        p = data["staged"]["proposals"][0]
        p["change"]["edits"] = ["not an edit", None, 3, *p["change"]["edits"]]
        ok, _why = ca.criterion_1(data, None)
        self.assertTrue(ok, _why)
        p["change"]["edits"] = ["not an edit", None]
        ok, why = ca.criterion_1(data, None)
        self.assertFalse(ok)
        self.assertIn("no staged config proposal", why)
        r = TestCheckAcceptanceShapes("run_check").run_check(data)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertRegex(r.stdout, r"(?m)^FAIL criterion 1\b")
        self.assertNotIn("Traceback", r.stderr)


if __name__ == "__main__":
    unittest.main()
