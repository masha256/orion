"""Task 12 tests: the post-run step (spec 8.5): dev-queue append, fingerprint dedupe, cleaning, the digest text."""
import copy
import json
import re
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "bin"))

import disclosure_watch as dw  # noqa: E402

URL = "https://x.com/Lighter_xyz/status/2113065839352336774"
FP_HOLDER = "217a33d3dc58418f67c15d9b1bab6062f26e67d300791516e2fd7695b9147366"
FP_REVENUE = "4abd7590d82085890aebd0074fbe2c989f7ce991dae317b83de1b59c19914b4f"
LABEL = ("machine transcript (small.en): names and numbers may be misheard; every figure in it is the speaker's dated "
         "claim, not a fact")

LINE1 = f"ORION DISCLOSURE lit | LIT investor update 2026Q3 | posted 2026-10-22 | doc #1 machine transcript, 41.5 min | {URL}"
CATALYSTS = ("catalysts: 2026-11-01..2027-05-29 CFTC DCM and DCO applications filed, then up to 180 days of review"
             " | by 2026-12-31 Vanilla options go live | by 2026-12-31 Lighter EVM mainnet")
FINDINGS = ("[holder_flow] Q3 buys miss the Robinhood instance | [revenue] DefiLlama's revenue overstates Lighter's Q3")

EXPECTED_QUEUE = f"""## LIT — Q3 buys miss the Robinhood instance (disclosure watcher, 2026-10-23, run #1, doc #1)
<!-- dw:fp={FP_HOLDER} -->
Source: {URL} (posted 2026-10-22), {LABEL}. Machine-written from the document by the analyst; verify before building.
- Category: holder_flow; metrics: flow_usd.buyback; a fix moves targets: up
- Claim: All trading revenue (8.5M USD in Q3, including about 1M USD from the 50-50 Robinhood ref share) goes to buybacks.
- Orion: Orion measures 7,410,898 USD of treasury buys in Q3 2026 (2026-07-01..09-30), against 8.5M USD disclosed.  (evidence: observation ids 1, 92)
- Quotes: "I should remind everyone that it's a 50-50 ref share." [05:20]; "100% of trading revenue is used for buybacks." [11:27]
- Proposed fix: Find where the Robinhood share is spent on LIT and add it to the holder flow.

## LIT — DefiLlama's revenue overstates Lighter's Q3 (disclosure watcher, 2026-10-23, run #1, doc #1)
<!-- dw:fp={FP_REVENUE} -->
Source: {URL} (posted 2026-10-22), {LABEL}. Machine-written from the document by the analyst; verify before building.
- Category: revenue; metrics: flow_usd.llama_revenue; a fix moves targets: none
- Claim: Lighter disclosed 8.5M USD of Q3 revenue, of which more than 1M USD came from the Robinhood split.
- Orion: DefiLlama's dailyRevenue sums to 9,846,397 USD for Q3 2026, against 8.5M USD disclosed.  (evidence: observation ids 93)
- Quotes: "So the total revenue of the quarter, 8.5 million," [04:22]; "already more than a million in fees attributed back to Lighter from the 50-50 split." [06:12]
- Proposed fix: Check how DefiLlama counts the Robinhood instance and label the proxy accordingly.
"""


def run_fixture():
    return json.loads((FIX / "lit-q3-run.json").read_text(encoding="utf-8"))


def post_meta(**kw):
    m = {"asset": "lit", "title": "LIT investor update 2026Q3", "url": URL, "posted": "2026-10-22", "doc_id": 1,
         "kind": "machine_transcript", "duration_s": 2491.6, "asr_model": "small.en", "today": date(2026, 10, 23)}
    m.update(kw)
    return m


EMPTY_INBOX = {"observations": [], "proposals": [], "anomalies": []}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.queue = Path(self.tmp.name) / "dev-queue-revenue.md"
        self.cfg = dw.load_config(ROOT / "watch.yaml")["assets"]["lit"]

    def tearDown(self):
        self.tmp.cleanup()

    def post_run(self, run, inbox=None, show=None, **meta):
        return dw.post_run(run, inbox or EMPTY_INBOX, show if show is not None else {"id": 1, "estimated_cost_usd": 1.234},
                           self.cfg, self.queue, post_meta(**meta))


class TestPostRun(Base):
    def test_post_run_appends_findings_and_prints_digest(self):
        digest = self.post_run(run_fixture())
        self.assertEqual(digest.split("\n"), [
            LINE1,
            "analyst disclosure run #1 completed | 5 requests, 0.5k input | est $1.23",
            "proposals: config (12m target 0.35 -> 0.35) | dry run: nothing filed",
            f"dev findings (2, added to dev-queue-revenue.md): {FINDINGS}",
            CATALYSTS,
        ])
        self.assertEqual(self.queue.read_text(encoding="utf-8"), EXPECTED_QUEUE)

    def test_post_run_appends_after_existing_text(self):
        self.queue.write_text("# Revenue dev queue\n\n## Existing item\nbody", encoding="utf-8")
        self.post_run(run_fixture())
        text = self.queue.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("# Revenue dev queue\n\n## Existing item\nbody\n\n## LIT — Q3 buys"), text[:120])
        self.assertTrue(text.endswith(EXPECTED_QUEUE))

    def test_post_run_dedupes_by_fingerprint(self):
        self.post_run(run_fixture())
        first = self.queue.read_text(encoding="utf-8")
        digest = self.post_run(run_fixture())
        self.assertEqual(self.queue.read_text(encoding="utf-8"), first)
        self.assertIn(f"dev findings (2, 0 added to dev-queue-revenue.md, 2 already there): {FINDINGS}", digest)

    def test_real_run_lists_filed_proposals_from_the_inbox(self):
        run = run_fixture()
        run["run"]["dryRun"] = False
        run["committed"] = {"setVersion": None, "observationIds": [], "resolvedAnomalyIds": [], "proposalIds": [12, 13],
                            "journalId": 3, "devFindings": run["staged"]["devFindings"]}
        inbox = {"observations": [], "anomalies": [], "proposals": [
            {"id": 12, "kind": "config", "persona": "p", "agent_run_id": 1, "filed_at": "x",
             "effect": {"6m": {"from": 0.31779, "to": 0.31779}, "12m": {"from": 0.37, "to": 0.37}}},
            {"id": 13, "kind": "observation", "persona": "p", "agent_run_id": 1, "filed_at": "x", "effect": None},
            {"id": 9, "kind": "config", "persona": "p", "agent_run_id": 0, "filed_at": "x", "effect": None}]}
        digest = self.post_run(run, inbox=inbox)
        self.assertIn("proposals: #12 config (12m target 0.37 -> 0.37), #13 observation (no target effect)"
                      " | decide from the next orion-lit DECISIONS block", digest.split("\n"))

    def test_no_proposals_no_findings_no_catalysts(self):
        run = run_fixture()
        run["staged"]["proposals"] = []
        run["staged"]["devFindings"] = []
        run["staged"]["journal"]["catalysts"] = []
        lines = self.post_run(run, show={}).split("\n")
        self.assertEqual(lines[1], "analyst disclosure run #1 completed | 5 requests, 0.5k input | est $?")
        self.assertEqual(lines[2:], ["proposals: none", "dev findings: none", "catalysts: none"])
        self.assertFalse(self.queue.exists())

    def test_non_completed_run_digest(self):
        run = run_fixture()
        run["run"].update(id=4, outcome="budget_exhausted")
        digest = self.post_run(run)
        self.assertEqual(digest.split("\n"), [
            LINE1, "analyst disclosure run #4 ended budget_exhausted: nothing filed; doc #1 is stored; retry: ingest --force"])
        self.assertFalse(self.queue.exists())

    def test_post_doc_first_line(self):
        digest = self.post_run(run_fixture(), kind="post", duration_s=None)
        self.assertTrue(digest.startswith("ORION DISCLOSURE lit | LIT investor update 2026Q3 | posted 2026-10-22 | "
                                          f"doc #1 post | {URL}\n"))
        self.assertIn("the issuer's own post: a dated claim. Machine-written", self.queue.read_text())

    def test_model_text_is_cleaned_in_queue_and_digest(self):
        run = run_fixture()
        f = run["staged"]["devFindings"][0]
        f["title"] = "Buys <!channel> miss\nRobinhood https://evil.example/a " + "x" * 200
        f["claim"] = "Line one <@U012AB>\nline two\x07 see http://t.co/abc"
        run["staged"]["journal"]["catalysts"][1]["event"] = "Options <#C0CB7325YFK|orion-ops> live"
        digest = self.post_run(run)
        q = self.queue.read_text()
        q_model = re.sub(r"<!-- dw:fp=[0-9a-f]{64} -->", "", q).replace(URL, "")  # our own marker and url aside
        for s in ("<!", "<@", "<#", "http", "\x07"):
            self.assertNotIn(s, digest.replace(URL, ""))
            self.assertNotIn(s, q_model)
        title = dw.clean_model_text(f["title"], 120)
        self.assertEqual(len(title), 120)
        self.assertTrue(title.startswith("Buys miss Robinhood xxx"))
        self.assertIn(f"## LIT — {title} (disclosure", q)
        self.assertIn("- Claim: Line one\n  line two see\n", q)  # continuation lines stay inside the list item
        self.assertIn("| by 2026-12-31 Options live |", digest)


class TestCleanModelText(unittest.TestCase):
    def test_clean_model_text_strips_slack_sequences_and_urls(self):
        s = "Hi <@U123> and <!here> see <#C1|ops> https://evil.example/x?y=1 done\x07\nnext\ttab"
        self.assertEqual(dw.clean_model_text(s, 200), "Hi and see done next tab")
        self.assertEqual(dw.clean_model_text(s, 200, keep_newlines=True), "Hi and see done\nnext tab")
        self.assertEqual(dw.clean_model_text("<!everyone> ping <@", 50), "ping")
        self.assertEqual(dw.clean_model_text("  " + "a" * 300, 120), "a" * 120)
        self.assertEqual(dw.clean_model_text(None, 10), "")
        self.assertEqual(dw.clean_model_text("a\u202eb\u0000c", 10), "abc")

    def test_invisible_chars_cannot_rejoin_a_slack_sequence_url_or_comment(self):
        # Fix round 1, F1: control/format chars are removed BEFORE the sequence and url patterns run.
        for s in ("a <\u200b!channel> b", "<\x07@U123> hi", "ht\u200btps://evil.example/x", "x <\u200b!-- dw:fp=abc -->",
                  "c <\u200b#C1|ops> d"):
            for keep in (False, True):
                out = dw.clean_model_text(s, 200, keep_newlines=keep)
                for bad in ("<!", "<@", "<#", "http", "<!--"):
                    self.assertNotIn(bad, out, (s, out))

    def test_html_comment_markers_are_stripped(self):
        for s in ("a --> b", "a <!-- b", "x <!--<!-- dw:fp=ab -->", "<<!--!-- y", "z --\u200b> w"):
            out = dw.clean_model_text(s, 200, keep_newlines=True)
            self.assertNotIn("<!--", out, (s, out))
            self.assertNotIn("-->", out, (s, out))


class TestFixRound1(Base):
    def test_finding_without_fingerprint_is_skipped_and_counted(self):
        # F5: no fingerprint -> not appended, counted as skipped in the digest line.
        run = run_fixture()
        del run["staged"]["devFindings"][1]["fingerprint"]
        digest = self.post_run(run)
        q = self.queue.read_text()
        self.assertEqual(q.count("<!-- dw:fp="), 1)
        self.assertIn(f"<!-- dw:fp={FP_HOLDER} -->", q)
        self.assertNotIn("DefiLlama's revenue overstates", q)
        self.assertIn(f"dev findings (2, 1 added to dev-queue-revenue.md, 1 skipped (no fingerprint)): {FINDINGS}",
                      digest.split("\n"))
        # a second call: the fingerprinted one is already there, the other one still skipped
        digest = self.post_run(run)
        self.assertIn(f"dev findings (2, 0 added to dev-queue-revenue.md, 1 already there, 1 skipped (no fingerprint)): "
                      f"{FINDINGS}", digest.split("\n"))
        self.assertEqual(self.queue.read_text(), q)

    def test_non_hex_fingerprint_counts_as_missing(self):
        run = run_fixture()
        run["staged"]["devFindings"][0]["fingerprint"] = "zz-qq!"  # no hex digit at all
        run["staged"]["devFindings"][1]["fingerprint"] = ""
        digest = self.post_run(run)
        self.assertFalse(self.queue.exists())
        self.assertIn(f"dev findings (2, 0 added to dev-queue-revenue.md, 2 skipped (no fingerprint)): {FINDINGS}",
                      digest.split("\n"))

    def test_model_lines_starting_with_hash_are_escaped(self):
        # F6: a claim line cannot open a markdown section.
        run = run_fixture()
        f = run["staged"]["devFindings"][0]
        f["claim"] = "# Not a heading\n## LIT — fake section\nplain\n  ### indented"
        f["orionReading"] = "ok\n#also"
        f["proposedFix"] = "#fix"
        self.post_run(run)
        q = self.queue.read_text()
        self.assertIn("- Claim: \\# Not a heading\n  \\## LIT — fake section\n  plain\n  \\### indented\n", q)
        self.assertIn("- Orion: ok\n  \\#also  (evidence", q)
        self.assertIn("- Proposed fix: \\#fix\n", q)
        headings = [line for line in q.split("\n") if re.match(r"^ {0,3}#", line)]
        self.assertEqual(len(headings), 2, headings)  # only our two section headings


if __name__ == "__main__":
    unittest.main()
