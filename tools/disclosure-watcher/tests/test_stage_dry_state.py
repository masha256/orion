"""Review wave 2 (staging watcher): a stage dry scan reports each post once.

Staging always scans dry, and a dry scan never writes the watcher's state, so before this every scan day found the same
posts new again and posted "the analyst run was skipped" for the same post daily. `scan --dry-state <file>` (the
daemon passes it on stage only) remembers the post ids a dry scan processed, apart from the real state.
No network: the Orion driver, http and the media tools are fakes.
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bin"))
sys.path.insert(0, str(ROOT / "tests"))

import disclosure_watch as dw  # noqa: E402
from test_platform import SCRIPT, clean_env, run_script  # noqa: E402
from test_process import NOW, Q3, TODAY, Base, FakeHttp, FakeOrion, fixture_text  # noqa: E402

NO_CREDENTIALS = (1, {"error": {"code": "no_credentials", "message": "no Anthropic credentials: set ANTHROPIC_API_KEY"}})
SKIPPED = f"ORION DISCLOSURE lit: dry run without Anthropic credentials: the analyst run was skipped for post {Q3}"


class TestStageDryState(Base):
    def _scan(self, orion, **opts):
        tweets = {i: fixture_text(f"tweet-{i}.json") for i in (Q3, "2111481510230675531")}
        http = FakeHttp(tweets=tweets, posts=[(200, fixture_text("ddg-lighter.html"))])
        return dw.run_scan(self.cfg, self.base, http, TODAY, sleep=lambda s: None, now=NOW,
                           opts={"orion": orion, **self.opts(), "dry_run": True, "queue_file": str(self.base / "dq.md"), **opts})

    def test_a_post_is_reported_once_across_dry_scans_with_a_dry_state(self):
        dry_state = self.base / "state" / "dry-seen.json"
        orion = FakeOrion(runs=[NO_CREDENTIALS])
        first = self._scan(orion, dry_state=str(dry_state))
        self.assertTrue(any(line.startswith(SKIPPED) for line in first), first)
        self.assertEqual(orion.names().count("agent_run"), 1)
        seen = json.loads(dry_state.read_text(encoding="utf-8"))
        self.assertIn(Q3, seen["lit"])
        # The real state is still never written by a dry scan.
        self.assertFalse((self.base / "state" / "lit.json").exists())
        # The next day: the same search results, nothing processed again, the skipped line not posted again.
        again = FakeOrion(runs=[])
        second = self._scan(again, dry_state=str(dry_state))
        self.assertFalse(any(line.startswith(SKIPPED) for line in second), second)
        self.assertNotIn("agent_run", again.names())
        self.assertNotIn("doc_add", again.names())
        self.assertEqual(list((self.base / "state").glob("*.tmp")), [])

    def test_without_a_dry_state_a_dry_scan_still_writes_nothing(self):
        orion = FakeOrion(runs=[NO_CREDENTIALS, NO_CREDENTIALS])
        self.assertTrue(any(line.startswith(SKIPPED) for line in self._scan(orion)))
        self.assertTrue(any(line.startswith(SKIPPED) for line in self._scan(orion)))  # prod's dry scan alerts daily
        self.assertFalse((self.base / "state" / "lit.json").exists())
        self.assertFalse((self.base / "state" / "dry-seen.json").exists())

    def test_dry_state_needs_dry_run(self):
        env = clean_env(ORION_DW_REPO=str(self.base))
        r = run_script("--base-dir", str(self.base), "scan", "--dry-state", str(self.base / "d.json"), env=env)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("--dry-state is for --dry-run scans only", r.stderr)
        self.assertTrue(SCRIPT.exists())


if __name__ == "__main__":
    unittest.main()
