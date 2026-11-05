"""Task 11: config, discovery, classification, state, scan-day calendar, alerts.

No network: DuckDuckGo and tweet-result bodies are captured fixtures; http and sleep are fakes.
"""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "bin"))

import disclosure_watch as dw  # noqa: E402

RECORDINGS = ["2039862458572001352", "2073044023661453589", "2113065839352336774"]
ANNOUNCEMENT = "2111481510230675531"
FOUR = sorted(RECORDINGS + [ANNOUNCEMENT])
# The real 2026-10-23 DuckDuckGo page also lists a fifth Lighter_xyz status (a reply in the Q3 announcement thread).
FIFTH = "2111481514676637854"

ALERT_SEARCH = "ORION DISCLOSURE ALERT lit: search failed 3 scan days running (HTTP 202)"
WINDOW_Q3_CLOSED = "ORION DISCLOSURE lit: window 2026Q3 closed with no investor-call recording found"


def fixture_text(name):
    return (FIX / name).read_text(encoding="utf-8")


def tweet(post_id):
    return json.loads(fixture_text(f"tweet-{post_id}.json"))


class FakeHttp:
    """post() answers from a list (the last answer repeats); get() answers tweet-result by id (else 503)."""

    def __init__(self, posts=None, tweets=None):
        self.posts = list(posts or [])
        self.tweets = dict(tweets or {})
        self.post_calls = []
        self.get_calls = []

    def post(self, url, data):
        self.post_calls.append((url, dict(data)))
        if len(self.posts) > 1:
            return self.posts.pop(0)
        return self.posts[0]

    def get(self, url):
        self.get_calls.append(url)
        for post_id, body in self.tweets.items():
            if f"id={post_id}&" in url:
                return 200, body
        return 503, ""  # an id without a body is an outage (a 404 would mean the post is gone)


def ddg_ok():
    return 200, fixture_text("ddg-lighter.html")


def all_tweets():
    return {i: fixture_text(f"tweet-{i}.json") for i in FOUR}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.cfg = dw.load_config(ROOT / "watch.yaml")
        self.sleeps = []

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, http, today):
        # now = noon UTC of `today` (as under ORION_DW_TODAY), so the 120-day age check never follows the wall clock.
        return dw.run_scan(self.cfg, self.base, http, today, sleep=self.sleeps.append,
                           now=datetime.combine(today, datetime.min.time().replace(hour=12), tzinfo=timezone.utc))

    def state(self):
        return dw.State.load(self.base / "state" / "lit.json")


class TestConfig(Base):
    def test_watch_yaml_loads(self):
        lit = self.cfg["assets"]["lit"]
        self.assertEqual(lit["author"]["user_id"], "1604942990417580032")
        self.assertEqual(lit["feeds"][0]["source"], "x_video")
        self.assertEqual(lit["window"]["after_quarter_end_days"], 35)

    def test_unknown_source_type_refused_at_load(self):
        cfg = copy.deepcopy(self.cfg)
        cfg["assets"]["lit"]["feeds"][0]["source"] = "rss"
        cfg["assets"]["lit"]["feeds"][0]["id"] = "blog_feed"
        p = self.base / "w.yaml"
        import yaml
        p.write_text(yaml.safe_dump(cfg), encoding="utf-8")
        with self.assertRaises(ValueError) as cm:
            dw.load_config(p)
        self.assertIn("blog_feed", str(cm.exception))
        self.assertIn("rss", str(cm.exception))


class TestCalendar(Base):
    def test_scan_days(self):
        lit = self.cfg["assets"]["lit"]
        self.assertTrue(dw.is_scan_day(date(2026, 10, 21), lit))
        self.assertTrue(dw.is_scan_day(date(2026, 11, 4), lit))   # quarter end + 35
        self.assertFalse(dw.is_scan_day(date(2026, 11, 5), lit))  # Thursday, outside
        self.assertTrue(dw.is_scan_day(date(2026, 11, 9), lit))   # Monday
        self.assertTrue(dw.is_scan_day(date(2026, 10, 1), lit))   # quarter end + 1
        self.assertFalse(dw.is_scan_day(date(2026, 9, 30), lit))  # quarter end itself, a Wednesday

    def test_today_override_from_env(self):
        with mock.patch.dict(os.environ, {"ORION_DW_TODAY": "2026-11-05"}):
            self.assertEqual(dw.get_today(), date(2026, 11, 5))


class TestSearch(Base):
    def test_search_extracts_four_ids(self):
        http = FakeHttp(posts=[ddg_ok()])
        ids = dw.search_ids(http, self.cfg["assets"]["lit"], sleep=self.sleeps.append)
        self.assertTrue(set(FOUR) <= set(ids))
        self.assertEqual(ids, sorted(FOUR + [FIFTH]))
        self.assertEqual(len(http.post_calls), 1)
        url, data = http.post_calls[0]
        self.assertEqual(url, "https://html.duckduckgo.com/html/")
        self.assertEqual(data, {"q": 'Lighter_xyz "Investor Update" recording'})
        self.assertEqual(self.sleeps, [])

    def test_search_falls_back_to_bare_status_pattern(self):
        html = '<a href="https://x.com/lighter%5Fxyz/status/2113065839352336774">x</a>'
        ids = dw.search_ids(FakeHttp(posts=[(200, html)]), self.cfg["assets"]["lit"], sleep=self.sleeps.append)
        self.assertEqual(ids, ["2113065839352336774"])

    def test_search_202_retries_once_then_fails(self):
        http = FakeHttp(posts=[(202, "")])
        with self.assertRaises(dw.SearchFailed) as cm:
            dw.search_ids(http, self.cfg["assets"]["lit"], sleep=self.sleeps.append)
        self.assertEqual(len(http.post_calls), 2)
        self.assertEqual(self.sleeps, [60])
        self.assertEqual(str(cm.exception), "HTTP 202")

    def test_search_202_then_ok_succeeds(self):
        http = FakeHttp(posts=[(202, ""), ddg_ok()])
        ids = dw.search_ids(http, self.cfg["assets"]["lit"], sleep=self.sleeps.append)
        self.assertEqual(len(ids), 5)
        self.assertEqual(self.sleeps, [60])

    def test_search_429_and_5xx_fail(self):
        for code in (429, 500, 503):
            with self.assertRaises(dw.SearchFailed):
                dw.search_ids(FakeHttp(posts=[(code, "")]), self.cfg["assets"]["lit"], sleep=self.sleeps.append)

    def test_search_anomaly_page_fails(self):
        page = '<html><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></html>'
        with self.assertRaises(dw.SearchFailed) as cm:
            dw.search_ids(FakeHttp(posts=[(200, page)]), self.cfg["assets"]["lit"], sleep=self.sleeps.append)
        self.assertIn("anomaly", str(cm.exception))

    def test_search_page_without_ids_is_a_failure(self):
        # Review Focus 5: a changed HTML layout must count as a failure, never as "nothing found".
        page = "<html><body><div class='results'>No results.</div></body></html>"
        http = FakeHttp(posts=[(200, page)], tweets=all_tweets())
        with self.assertRaises(dw.SearchFailed):
            dw.search_ids(http, self.cfg["assets"]["lit"], sleep=self.sleeps.append)
        out = self.scan(FakeHttp(posts=[(200, page)], tweets=all_tweets()), date(2026, 10, 21))
        self.assertEqual(out, [])
        st = self.state()
        self.assertEqual(st.data["posts"], {})
        self.assertEqual(st.data["search"]["consecutive_failures"], 1)

    def test_network_error_is_a_search_failure(self):
        class Boom(FakeHttp):
            def post(self, url, data):
                self.post_calls.append(url)
                raise OSError("connection reset")
        http = Boom()
        with self.assertRaises(dw.SearchFailed):
            dw.search_ids(http, self.cfg["assets"]["lit"], sleep=self.sleeps.append)
        self.assertEqual(len(http.post_calls), 2)


class TestClassify(Base):
    def test_classify(self):
        lit = self.cfg["assets"]["lit"]

        def at(post, days):
            return dw.parse_created_at(post["created_at"]) + timedelta(days=days)

        for i in RECORDINGS:
            p = tweet(i)
            self.assertEqual(dw.classify(p, lit, at(p, 1)), "recording", i)
        a = tweet(ANNOUNCEMENT)
        self.assertEqual(dw.classify(a, lit, at(a, 1)), "announcement")

        foreign = tweet(RECORDINGS[2])
        foreign["user"]["id_str"] = "44196397"
        self.assertEqual(dw.classify(foreign, lit, at(foreign, 1)), "irrelevant")

        same_name_other_id = tweet(RECORDINGS[2])
        same_name_other_id["user"]["id_str"] = "1"
        same_name_other_id["user"]["screen_name"] = "Lighter_xyz"
        self.assertEqual(dw.classify(same_name_other_id, lit, at(same_name_other_id, 1)), "irrelevant")

        short = tweet(RECORDINGS[2])
        short["video"]["durationMs"] = 5 * 60000
        for m in short["mediaDetails"]:
            m["video_info"]["duration_millis"] = 5 * 60000
        self.assertEqual(dw.classify(short, lit, at(short, 1)), "irrelevant")

        old = tweet(RECORDINGS[2])
        self.assertEqual(dw.classify(old, lit, at(old, 200)), "irrelevant")
        self.assertEqual(dw.classify(old, lit, at(old, 119)), "recording")

        no_match = tweet(RECORDINGS[2])
        no_match["text"] = "A clip from our community AMA."
        self.assertEqual(dw.classify(no_match, lit, at(no_match, 1)), "irrelevant")


class TestState(Base):
    def test_state_roundtrip_and_atomic_write(self):
        path = self.base / "state" / "lit.json"
        st = dw.State.load(path)
        self.assertIsNone(st.get("1"))
        st.set("1", status="queued", kind="recording")
        st.save()
        rec = dw.State.load(path).get("1")
        self.assertEqual(rec["status"], "queued")
        self.assertEqual(rec["kind"], "recording")
        self.assertEqual(rec["attempts"], 0)
        for field in ("first_seen_at", "updated_at", "doc_id", "doc_sha256", "run_id", "run_outcome", "error"):
            self.assertIn(field, rec)
        self.assertEqual(sorted(os.listdir(path.parent)), ["lit.json"])  # no temp file left behind

        with self.assertRaises(ValueError):
            st.set("2", status="done")

        before = path.read_bytes()
        st.set("3", status="irrelevant")
        with mock.patch("disclosure_watch.os.replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                st.save()
        self.assertEqual(path.read_bytes(), before)          # the old file is intact
        self.assertEqual(sorted(os.listdir(path.parent)), ["lit.json"])

    def test_statuses_exactly_as_spec(self):
        self.assertEqual(
            set(dw.STATUSES),
            {"irrelevant", "announcement", "seeded", "queued", "transcribed", "doc_added", "run_done",
             "run_failed", "failed"},
        )


class TestScan(Base):
    def seed(self):
        st = self.state()
        for i in RECORDINGS:
            st.set(i, status="seeded", kind="recording")
        st.set(ANNOUNCEMENT, status="seeded", kind="announcement")
        st.save()

    def test_dedupe_known_ids_are_skipped(self):
        self.seed()
        http = FakeHttp(posts=[ddg_ok()], tweets=all_tweets())
        self.assertEqual(self.scan(http, date(2026, 10, 22)), [])
        # Only the unknown fifth id is looked up; it 503s here, so it stays unknown (retried next run).
        self.assertEqual(len(http.get_calls), 1)
        self.assertIn(f"id={FIFTH}&", http.get_calls[0])
        st = self.state()
        for i in FOUR:
            self.assertEqual(st.get(i)["status"], "seeded")
        self.assertIsNone(st.get(FIFTH))

        http2 = FakeHttp(posts=[ddg_ok()], tweets={**all_tweets(), FIFTH: fixture_text(f"tweet-{RECORDINGS[2]}.json")})
        self.scan(http2, date(2026, 10, 23))
        self.assertEqual(len(http2.get_calls), 1)
        http3 = FakeHttp(posts=[ddg_ok()], tweets=all_tweets())
        self.scan(http3, date(2026, 10, 24))
        self.assertEqual(http3.get_calls, [])  # every id known now

    def test_new_recording_is_queued_and_marks_the_window(self):
        http = FakeHttp(posts=[ddg_ok()], tweets=all_tweets())
        with mock.patch.object(dw, "process_queued", wraps=dw.process_queued) as hook:
            self.assertEqual(self.scan(http, date(2026, 10, 22)), [])
            self.assertEqual(hook.call_count, 1)
        st = self.state()
        self.assertEqual(st.get("2113065839352336774")["status"], "queued")
        self.assertEqual(st.get("2113065839352336774")["kind"], "recording")
        self.assertEqual(st.get(ANNOUNCEMENT)["status"], "announcement")
        # The Q1 recording (2026-04-03) is older than 120 days on 2026-10-22: history, not queued.
        # The Q2 recording (2026-07-03, 111 days) is still inside the age limit (unseeded state).
        self.assertEqual(st.get("2039862458572001352")["status"], "irrelevant")
        self.assertEqual(st.get("2073044023661453589")["status"], "queued")
        self.assertEqual(st.data["windows"]["2026Q3"]["found_post_id"], "2113065839352336774")
        self.assertEqual(st.data["windows"]["2026Q2"]["found_post_id"], "2073044023661453589")
        self.assertEqual(st.data["search"]["consecutive_failures"], 0)
        self.assertIsNotNone(st.data["search"]["last_ok_at"])
        # On the window's last day nothing is printed: a recording was found.
        self.assertEqual(self.scan(FakeHttp(posts=[ddg_ok()], tweets=all_tweets()), date(2026, 11, 4)), [])
        log = (self.base / "log" / "lit.jsonl").read_text().splitlines()
        self.assertEqual(len(log), 2)
        self.assertEqual(json.loads(log[0])["decisions"]["2113065839352336774"], "queued")

    def test_not_a_scan_day_does_nothing(self):
        http = FakeHttp(posts=[ddg_ok()])
        self.assertEqual(self.scan(http, date(2026, 11, 5)), [])
        self.assertEqual(http.post_calls, [])
        self.assertFalse((self.base / "state" / "lit.json").exists())

    def test_three_failed_scan_days_print_the_alert_line(self):
        fail = lambda: FakeHttp(posts=[(202, "")])  # noqa: E731
        self.assertEqual(self.scan(fail(), date(2026, 10, 21)), [])
        self.assertEqual(self.scan(fail(), date(2026, 10, 21)), [])  # same day again: still one failed day
        self.assertEqual(self.state().data["search"]["consecutive_failures"], 1)
        self.assertEqual(self.scan(fail(), date(2026, 10, 22)), [])
        self.assertEqual(self.scan(fail(), date(2026, 10, 23)), [ALERT_SEARCH])
        self.assertEqual(self.state().data["posts"], {})  # a failed search never records anything
        # success resets the count
        self.scan(FakeHttp(posts=[ddg_ok()], tweets=all_tweets()), date(2026, 10, 24))
        self.assertEqual(self.state().data["search"]["consecutive_failures"], 0)
        self.assertEqual(self.scan(fail(), date(2026, 10, 25)), [])

    def test_window_closed_line_printed_once(self):
        self.seed()  # the seeded Q3 recording does not count as found by the watcher in this window
        st = self.state()
        st.set(FIFTH, status="irrelevant")  # known, so no scan day here is a failed tweet-result day (B4)
        st.data["windows"] = {}
        st.data["watch_since"] = "2026-10-01"  # pinned: seed() stamps first_seen_at with the real clock
        st.save()
        http = lambda: FakeHttp(posts=[ddg_ok()], tweets=all_tweets())  # noqa: E731
        self.assertEqual(self.scan(http(), date(2026, 11, 3)), [])
        self.assertEqual(self.scan(http(), date(2026, 11, 4)), [WINDOW_Q3_CLOSED])
        self.assertEqual(self.scan(http(), date(2026, 11, 4)), [])  # once
        self.assertEqual(self.scan(http(), date(2026, 11, 5)), [])
        self.assertEqual(self.scan(http(), date(2026, 11, 9)), [])
        self.assertTrue(self.state().data["windows"]["2026Q3"]["closed_reported"])

    def test_alert_line_comes_before_window_line(self):
        fail = lambda: FakeHttp(posts=[(202, "")])  # noqa: E731
        self.scan(fail(), date(2026, 11, 2))
        self.scan(fail(), date(2026, 11, 3))
        self.assertEqual(self.scan(fail(), date(2026, 11, 4)), [ALERT_SEARCH, WINDOW_Q3_CLOSED])


class TestCli(Base):
    def run_cli(self, *args, env=None):
        return subprocess.run([sys.executable, str(ROOT / "bin" / "disclosure_watch.py"), *args],
                              capture_output=True, text=True, env={**os.environ, **(env or {})})

    def test_ingest_refuses_a_url_without_a_post_id(self):
        # Was the Task 11 stub check ("not implemented yet"); ingest exists since Task 12. No network, no state.
        r = self.run_cli("--base-dir", str(self.base), "ingest", "--asset", "lit", "--url", "https://x.com/Lighter_xyz")
        self.assertEqual(r.returncode, 2)
        self.assertIn("not an X post url", r.stderr)
        self.assertFalse((self.base / "state").exists())

    def test_scan_on_a_non_scan_day_is_silent(self):
        r = self.run_cli("scan", "--base-dir", str(self.base),
                         env={"ORION_DW_TODAY": "2026-11-05", "ORION_DW_REPO": str(self.base / "norepo")})
        self.assertEqual((r.returncode, r.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
