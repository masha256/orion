"""Phase 1.5c Task 11: the watcher in the repo, run by the daemon's disclosure_watch job.

Paths come from the environment (ORION_DW_BASE_DIR, ORION_DW_QUEUE, ORION_DW_CACHE), the Orion release from
ORION_DW_REPO (required for a real run), node from ORION_NODE; `agent run` gets no --out; `scan` gains --dry-run and
--queue-file. No network: the Orion driver, http, yt-dlp/ffmpeg and the transcriber are fakes.
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bin"))
sys.path.insert(0, str(ROOT / "tests"))

import disclosure_watch as dw  # noqa: E402
from test_process import NOW, Q3, TODAY, Base, FakeHttp, FakeOrion, completed_run, fixture_text  # noqa: E402

SCRIPT = ROOT / "bin" / "disclosure_watch.py"
DW_ENV = ("ORION_DW_BASE_DIR", "ORION_DW_QUEUE", "ORION_DW_CACHE", "ORION_DW_REPO", "ORION_NODE", "ORION_DW_TODAY")


def clean_env(**over):
    """os.environ without any ORION_DW_* / ORION_NODE value of the caller's shell, plus `over`."""
    env = {k: v for k, v in os.environ.items() if k not in DW_ENV}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(over)
    return env


def run_script(*args, env):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=60)


def paths_in(env):
    """The module's path constants as a fresh interpreter (with `env`) sees them."""
    code = ("import json, sys; sys.path.insert(0, sys.argv[1]); import disclosure_watch as dw; "
            "print(json.dumps({k: str(getattr(dw, k)) for k in "
            "('BASE_DIR', 'DEFAULT_QUEUE', 'DEFAULT_CACHE', 'DEFAULT_CONFIG')}))")
    r = subprocess.run([sys.executable, "-c", code, str(ROOT / "bin")], capture_output=True, text=True, env=env,
                       timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


class TestPlatform(Base):
    def test_paths_from_env(self):
        # Unset: everything under the watcher's own directory (the script's parent's parent).
        self.assertEqual(paths_in(clean_env()), {
            "BASE_DIR": str(ROOT), "DEFAULT_QUEUE": str(ROOT / "dev-queue.md"), "DEFAULT_CACHE": str(ROOT / "cache"),
            "DEFAULT_CONFIG": str(ROOT / "watch.yaml")})
        # ORION_DW_BASE_DIR moves state, queue and cache; watch.yaml stays the one shipped beside the script.
        base = self.base / "home" / "disclosure"
        self.assertEqual(paths_in(clean_env(ORION_DW_BASE_DIR=str(base))), {
            "BASE_DIR": str(base), "DEFAULT_QUEUE": str(base / "dev-queue.md"), "DEFAULT_CACHE": str(base / "cache"),
            "DEFAULT_CONFIG": str(ROOT / "watch.yaml")})
        q, c = self.base / "q.md", self.base / "c"
        self.assertEqual(paths_in(clean_env(ORION_DW_BASE_DIR=str(base), ORION_DW_QUEUE=str(q), ORION_DW_CACHE=str(c))),
                         {"BASE_DIR": str(base), "DEFAULT_QUEUE": str(q), "DEFAULT_CACHE": str(c),
                          "DEFAULT_CONFIG": str(ROOT / "watch.yaml")})
        # The CLI's --base-dir default follows ORION_DW_BASE_DIR: `status` reads that state.
        st = dw.State(base / "state" / "lit.json", dw.State.empty_data())
        st.set(Q3, status="seeded", kind="recording")
        st.save()
        r = run_script("status", env=clean_env(ORION_DW_BASE_DIR=str(base)))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("lit: posts seeded 1", r.stdout)
        # A run's default queue is <base_dir>/dev-queue.md of that run (ORION_DW_QUEUE overrides).
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ORION_DW_QUEUE", None)
            self.assertEqual(dw.default_queue(self.base), self.base / "dev-queue.md")
            self.assertEqual(dw.default_cache(self.base), self.base / "cache")
            os.environ["ORION_DW_QUEUE"] = str(q)
            self.assertEqual(dw.default_queue(self.base), q)

    def test_repo_required_for_real_runs(self):
        msg = "set ORION_DW_REPO to the Orion release root"
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ORION_DW_REPO", None)
            with self.assertRaisesRegex(dw.UsageError, msg):
                dw.orion_for(None)
        # scan on a scan day (2026-10-23 is in the 2026Q3 window): refused before any search or state.
        r = run_script("--base-dir", str(self.base), "scan", env=clean_env(ORION_DW_TODAY="2026-10-23"))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn(msg, r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertFalse((self.base / "state").exists())
        # ingest too, once its own usage checks pass.
        r = run_script("--base-dir", str(self.base), "ingest", "--asset", "lit", "--url",
                       f"https://x.com/Lighter_xyz/status/{Q3}", env=clean_env())
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn(msg, r.stderr)
        self.assertFalse((self.base / "state").exists())
        # With ORION_DW_REPO set: the driver runs there, ORION_HOME = --orion-home (else $ORION_HOME, else the repo).
        with mock.patch.dict(os.environ, {"ORION_DW_REPO": "/srv/rel", "ORION_HOME": "/srv/home"}):
            o = dw.orion_for(None)
            self.assertEqual((o.repo, o.home), (Path("/srv/rel"), Path("/srv/home")))
            self.assertEqual(dw.orion_for("/h2").home, Path("/h2"))
        # `status` needs no Orion.
        r = run_script("--base-dir", str(self.base), "status", env=clean_env())
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_agent_run_has_no_out(self):
        calls = []

        def fake_run(cmd, **kw):
            calls.append((cmd, kw))
            return subprocess.CompletedProcess(cmd, 0, json.dumps(completed_run()[1]), "")

        with mock.patch.object(dw.subprocess, "run", fake_run), mock.patch.dict(os.environ, {"ORION_NODE": "/opt/n/node"}):
            o = dw.OrionCli("/srv/rel", "/srv/home")
            o.agent_run("lit", 7, False)
            o.agent_run("lit", 7, True)
        (real, kw), (dry, _) = calls
        self.assertEqual(real, ["/opt/n/node", "dist/cli/index.js", "agent", "run", "lit", "--type", "disclosure",
                                "--doc", "7", "--json"])
        self.assertEqual(dry, ["/opt/n/node", "dist/cli/index.js", "agent", "run", "lit", "--type", "disclosure",
                               "--doc", "7", "--dry-run", "--json"])
        self.assertEqual(kw["cwd"], Path("/srv/rel"))
        self.assertEqual(kw["env"]["ORION_HOME"], "/srv/home")
        self.assertNotIn("--out", real + dry)
        # Without ORION_NODE: `node` from PATH.
        calls.clear()
        with mock.patch.object(dw.subprocess, "run", fake_run), mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ORION_NODE", None)
            dw.OrionCli("/r", "/h").inbox("lit")
        self.assertEqual(calls[0][0], ["node", "dist/cli/index.js", "inbox", "lit", "--json"])

    def test_scan_dry_run_needs_queue_file(self):
        env = clean_env(ORION_DW_REPO=str(self.base / "norepo"), ORION_DW_TODAY="2026-10-23")
        r = run_script("--base-dir", str(self.base), "scan", "--dry-run", "--orion-home", str(self.base / "oh"), env=env)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("--dry-run needs an explicit --queue-file", r.stderr)
        r = run_script("--base-dir", str(self.base), "scan", "--dry-run", "--queue-file", str(self.queue), env=env)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("--dry-run needs an explicit --orion-home", r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertFalse((self.base / "state").exists())
        self.assertFalse(self.queue.exists())

    def _seed_queued(self):
        st = self.state()
        st.set(Q3, status="queued", kind="recording")
        st.data["watch_since"] = "2026-10-01"
        st.save()
        return (self.base / "state" / "lit.json").read_text(encoding="utf-8")

    def _scan(self, orion, **opts):
        tweets = {i: fixture_text(f"tweet-{i}.json") for i in (Q3, "2111481510230675531")}
        http = FakeHttp(tweets=tweets, posts=[(200, fixture_text("ddg-lighter.html"))])
        return dw.run_scan(self.cfg, self.base, http, TODAY, sleep=lambda s: None, now=NOW,
                           opts={"orion": orion, **self.opts(), **opts})

    def test_scan_dry_run_writes_no_state(self):
        before = self._seed_queued()
        orion = FakeOrion(runs=[completed_run(dry_run=True)])
        dry_queue = self.base / "dev-queue.dry.md"
        lines = self._scan(orion, dry_run=True, queue_file=str(dry_queue))
        self.assertEqual(orion.names()[:2], ["doc_add", "agent_run"])
        self.assertEqual(orion.calls[1][1]["dry_run"], True)
        text = "\n".join(lines)
        self.assertIn("dry run: nothing filed", text)
        # The state file, the log and the transcripts are untouched; findings go to the dry queue only.
        self.assertEqual((self.base / "state" / "lit.json").read_text(encoding="utf-8"), before)
        self.assertFalse((self.base / "log").exists())
        self.assertFalse((self.base / "transcripts").exists())
        self.assertFalse(self.queue.exists())
        self.assertTrue(dry_queue.exists())
        self.assertEqual(list((self.base / "state").glob("*.tmp")), [])
        # The same scan, not dry, writes them.
        orion = FakeOrion(runs=[completed_run()])
        self._scan(orion)
        self.assertEqual(self.state().get(Q3)["status"], "run_done")
        self.assertTrue((self.base / "log" / "lit.jsonl").exists())

    def test_dry_run_without_credentials_is_not_an_alert(self):
        # Staging runs dry with no Anthropic key: the analyst run is refused (no_credentials); that is no alert.
        self._seed_queued()
        err = (1, {"error": {"code": "no_credentials", "message": "no Anthropic credentials: set ANTHROPIC_API_KEY"}})
        orion = FakeOrion(runs=[err])
        lines = self._scan(orion, dry_run=True, queue_file=str(self.base / "dq.md"))
        self.assertFalse(any(line.startswith("ORION DISCLOSURE ALERT") for line in lines), lines)
        self.assertIn("ORION DISCLOSURE lit: dry run without Anthropic credentials: the analyst run was skipped for "
                      f"post {Q3}; doc #1 is stored", lines)
        # Not dry, the same refusal is an alert.
        orion = FakeOrion(runs=[err])
        lines = self._scan(orion)
        self.assertTrue(lines[0].startswith(f"ORION DISCLOSURE ALERT lit: run failed for post {Q3}: no_credentials"),
                        lines)

    def test_dry_run_refused_on_stage_is_not_an_alert(self):
        # I-4: Orion refuses every agent run on stage (agent_refused_stage), key or no key; the dry scan says so.
        self._seed_queued()
        err = (1, {"error": {"code": "agent_refused_stage", "message": "no agent runs on stage"}})
        lines = self._scan(FakeOrion(runs=[err]), dry_run=True, queue_file=str(self.base / "dq.md"))
        self.assertFalse(any(line.startswith("ORION DISCLOSURE ALERT") for line in lines), lines)
        self.assertIn("ORION DISCLOSURE lit: dry run on stage (agents never run on stage): the analyst run was skipped for "
                      f"post {Q3}; doc #1 is stored", lines)

    def test_venv_yt_dlp_comes_first(self):
        # The daemon upgrades the venv's yt-dlp weekly: the one beside the running interpreter wins over PATH.
        bindir = self.base / "venv" / "bin"
        bindir.mkdir(parents=True)
        (bindir / "yt-dlp").write_text("", encoding="utf-8")
        with mock.patch.object(dw.sys, "executable", str(bindir / "python")), \
                mock.patch.object(dw.shutil, "which", lambda name: "/usr/bin/yt-dlp"):
            self.assertEqual(dw._ytdlp(), str(bindir / "yt-dlp"))
        with mock.patch.object(dw.shutil, "which", lambda name: "/usr/bin/yt-dlp"), \
                mock.patch.object(dw.sys, "executable", str(self.base / "nobin" / "python")):
            self.assertEqual(dw._ytdlp(), "/usr/bin/yt-dlp")


if __name__ == "__main__":
    unittest.main()
