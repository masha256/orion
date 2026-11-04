"""Deferred minors (2026-10-24): every closed window since the watcher started is reported (not only the latest), a
failed run never overwrites a completed run's JSON, and a text-only post gets its own title.

No network, no ASR, no Orion: the same fakes as test_process.
"""
import json
import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bin"))
sys.path.insert(0, str(ROOT / "tests"))

import disclosure_watch as dw  # noqa: E402
from test_final_wave import WINDOW_Q3_CLOSED, ScanBase  # noqa: E402
from test_process import Q3, Base, FakeHttp, FakeOrion, completed_run, fixture_text  # noqa: E402

WINDOW_Q4_CLOSED = "ORION DISCLOSURE lit: window 2026Q4 closed with no investor-call recording found"
WINDOW_Q2_CLOSED = "ORION DISCLOSURE lit: window 2026Q2 closed with no investor-call recording found"


class TestEveryClosedWindowIsReported(ScanBase):
    def fresh(self, since="2026-11-03"):
        """Seeded posts carry the real clock's first_seen_at, so the start day is pinned (None: no start day and no
        first_seen_at, so the first scan's day is the start)."""
        self.seed()
        st = self.state()
        st.data["windows"] = {}
        st.data.pop("watch_since", None)
        if since:
            st.data["watch_since"] = since
        else:
            for rec in st.data["posts"].values():
                rec["first_seen_at"] = None
        st.save()

    def test_first_scan_records_watch_since(self):
        self.fresh(since=None)
        self.scan(date(2026, 11, 3))
        self.assertEqual(self.state().data["watch_since"], "2026-11-03")
        self.scan(date(2026, 11, 9))
        self.assertEqual(self.state().data["watch_since"], "2026-11-03")  # set once

    def test_an_outage_past_the_next_quarter_end_still_reports_the_old_window(self):
        self.fresh()
        self.assertEqual(self.scan(date(2026, 11, 3)), [])
        # Down from 2026-11-04 until inside the Q4 window: Q3's window is no longer the latest one.
        self.assertEqual(self.scan(date(2027, 1, 4)), [WINDOW_Q3_CLOSED])
        self.assertEqual(self.scan(date(2027, 1, 11)), [])
        # Down again past the Q4 window's last day (2027-02-04): reported once, by the next scan.
        self.assertEqual(self.scan(date(2027, 2, 8)), [WINDOW_Q4_CLOSED])
        self.assertEqual(self.scan(date(2027, 2, 15)), [])

    def test_two_missed_windows_are_reported_oldest_first(self):
        self.fresh()
        self.scan(date(2026, 11, 3))
        self.assertEqual(self.scan(date(2027, 2, 8)), [WINDOW_Q3_CLOSED, WINDOW_Q4_CLOSED])

    def test_a_window_that_ended_before_the_watcher_started_is_never_reported(self):
        self.fresh(since=None)
        self.assertEqual(self.scan(date(2026, 11, 9)), [])  # Q3's window ended 2026-11-04
        self.assertEqual(self.scan(date(2027, 1, 4)), [])
        self.assertNotIn("2026Q2", self.state().data["windows"])

    def test_a_found_window_is_not_reported(self):
        self.fresh()
        st = self.state()
        st.data["windows"] = {"2026Q3": {"found_post_id": Q3, "closed_reported": False}}
        st.save()
        self.scan(date(2026, 11, 3))
        self.assertEqual(self.scan(date(2027, 2, 8)), [WINDOW_Q4_CLOSED])

    def test_an_existing_state_without_watch_since_starts_at_its_first_post(self):
        st = dw.State(None, {"posts": {"1": {"first_seen_at": "2026-10-23T22:29:44Z"},
                                       "2": {"first_seen_at": "2026-10-24T01:00:00Z"}}})
        self.assertEqual(dw.watch_since_of(st.data, date(2026, 11, 9)), date(2026, 10, 23))
        self.assertEqual(dw.watch_since_of({"posts": {}}, date(2026, 11, 9)), date(2026, 11, 9))
        self.assertEqual(dw.watch_since_of({"posts": {}, "watch_since": "2026-10-01"}, date(2026, 11, 9)),
                         date(2026, 10, 1))


class TestFailedRunKeepsTheCompletedRunJson(Base):
    def path(self, suffix=".run.json"):
        return self.base / "transcripts" / "lit" / f"{Q3}{suffix}"

    def test_a_failed_retry_goes_to_run_failed_json(self):
        code, lines = self.ingest(FakeOrion(runs=[completed_run()]))
        self.assertEqual(code, 0, lines)
        good = json.loads(self.path().read_text(encoding="utf-8"))
        err = (1, {"error": {"code": "no_credentials", "message": "ANTHROPIC_API_KEY is not set"}})
        code, lines = self.ingest(FakeOrion(runs=[err]), force=True)
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(self.path().read_text(encoding="utf-8")), good)
        self.assertEqual(json.loads(self.path(".run.failed.json").read_text(encoding="utf-8")), err[1])
        self.assertTrue(any(".run.failed.json" in line for line in lines), lines)

    def test_a_non_completed_run_retry_goes_to_run_failed_json(self):
        self.ingest(FakeOrion(runs=[completed_run()]))
        good = json.loads(self.path().read_text(encoding="utf-8"))
        bad = completed_run()
        bad = (bad[0], dict(bad[1], run=dict(bad[1]["run"], outcome="budget_exhausted", error="input cap")))
        self.ingest(FakeOrion(runs=[bad]), force=True)
        self.assertEqual(json.loads(self.path().read_text(encoding="utf-8")), good)
        self.assertEqual(json.loads(self.path(".run.failed.json").read_text(encoding="utf-8"))["run"]["outcome"],
                         "budget_exhausted")

    def test_a_completed_run_replaces_a_failed_one(self):
        err = (1, {"error": {"code": "no_credentials", "message": "no key"}})
        self.ingest(FakeOrion(runs=[err]))
        self.assertEqual(json.loads(self.path().read_text(encoding="utf-8")), err[1])  # nothing better to keep
        code, lines = self.ingest(FakeOrion(runs=[completed_run()]), force=True)
        self.assertEqual(code, 0, lines)
        self.assertEqual(json.loads(self.path().read_text(encoding="utf-8")), completed_run()[1])


class TestTextOnlyPostTitle(Base):
    def test_text_only_post_gets_the_post_title(self):
        body = fixture_text("tweet-text-only.json")
        post_id = json.loads(body)["id_str"]
        orion = FakeOrion(runs=[completed_run()])
        code, lines = dw.ingest(self.cfg, "lit", f"https://x.com/Lighter_xyz/status/{post_id}", orion,
                                self.opts(http=FakeHttp({post_id: body})))
        self.assertEqual(code, 0, lines)
        self.assertEqual(orion.calls[0][1]["title"], "LIT post 2026-10-17")
        self.assertIn("| LIT post 2026-10-17 |", lines[0])

    def test_recording_keeps_the_investor_update_title(self):
        orion = FakeOrion(runs=[completed_run()])
        code, lines = self.ingest(orion)
        self.assertEqual(code, 0, lines)
        self.assertEqual(orion.calls[0][1]["title"], "LIT investor update 2026Q3")

    def test_default_post_title_without_config(self):
        feed = {"title": "X investor update {year}Q{quarter}"}
        self.assertEqual(dw.post_title(feed, "lit", "2026-10-17T15:36:36.000Z"), "LIT post 2026-10-17")
        feed["post_title"] = "Lighter post {date}"
        self.assertEqual(dw.post_title(feed, "lit", "2026-10-17T15:36:36.000Z"), "Lighter post 2026-10-17")


if __name__ == "__main__":
    unittest.main()
