#!/usr/bin/env python3
"""Orion disclosure watcher (Hermes side). Deterministic, no LLM calls.

Spec: docs/superpowers/specs/2026-10-23-orion-disclosure-watcher-design.md, section 8 (Hermes side) and 10 (watch.yaml).

Subcommands:
  scan    the cron path: scan-day check, search, dedupe, classify, record states, process one queued post (8.4, 8.5)
  ingest  the paste-a-link trigger (8.3)
  status  print the state summary per asset

Everything asset-specific lives in watch.yaml; this file holds no asset names.
Orion is driven through its CLI (`$ORION_NODE dist/cli/index.js ... --json`, cwd = $ORION_DW_REPO, the Orion release
root; ORION_HOME = the home). On the server the daemon's disclosure_watch job runs `scan` (docs/ops/disclosure-watcher.md).

Paths from the environment: ORION_DW_BASE_DIR (state/, log/, transcripts/; default this watcher's directory),
ORION_DW_QUEUE (the dev queue; default <base_dir>/dev-queue.md), ORION_DW_CACHE (audio while transcribing; default
<base_dir>/cache). watch.yaml is always the one beside bin/.
"""
import argparse
import contextlib
import fcntl
import hashlib
import html
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path

import yaml

# The watcher's own directory (bin/, watch.yaml, tests/): in a release, <release>/tools/disclosure-watcher.
WATCHER_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = WATCHER_DIR / "watch.yaml"


def default_queue(base_dir):
    """The dev queue a run appends to (spec 8.5): $ORION_DW_QUEUE, else <base_dir>/dev-queue.md."""
    return Path(os.environ.get("ORION_DW_QUEUE") or Path(base_dir) / "dev-queue.md")


def default_cache(base_dir):
    """Audio and WAV while transcribing (8.1): $ORION_DW_CACHE, else <base_dir>/cache."""
    return Path(os.environ.get("ORION_DW_CACHE") or Path(base_dir) / "cache")


# The state, log and transcripts directory: $ORION_DW_BASE_DIR (the daemon sets <ORION_HOME>/disclosure), else WATCHER_DIR.
BASE_DIR = Path(os.environ.get("ORION_DW_BASE_DIR") or WATCHER_DIR)
DEFAULT_QUEUE = default_queue(BASE_DIR)
DEFAULT_CACHE = default_cache(BASE_DIR)
REPO_REQUIRED = "set ORION_DW_REPO to the Orion release root"

SUPPORTED_SOURCES = ("x_video",)
SUPPORTED_OUTSIDE = ("weekly_monday",)
STATUSES = ("irrelevant", "announcement", "seeded", "queued", "transcribed", "doc_added", "run_done",
            "run_failed", "failed")
POST_FIELDS = ("status", "kind", "first_seen_at", "updated_at", "attempts", "doc_id", "doc_sha256", "run_id",
               "run_outcome", "error")
MAX_POST_AGE_DAYS = 120
SEARCH_URL = "https://html.duckduckgo.com/html/"
TWEET_RESULT_URL = "https://cdn.syndication.twimg.com/tweet-result?id={id}&token=a"
SEARCH_RETRY_WAIT_S = 60
SEARCH_ALERT_DAYS = 3
USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/141.0.0.0 Safari/537.36")
# Markers of DuckDuckGo's bot-check ("anomaly") page.
ANOMALY_MARKERS = re.compile(r"anomaly-modal|anomaly\.js|bots use DuckDuckGo too", re.I)


class SearchFailed(Exception):
    """The search gave no usable answer. Never read as 'nothing found'."""


class UsageError(Exception):
    """A command line or environment the watcher refuses before doing anything (exit 2)."""


class PostUnavailable(RuntimeError):
    """tweet-result says the post is gone (HTTP 404, a tombstone, or an empty answer): a fact about that post, not an
    outage. The scan records such an id as irrelevant (deduped forever) and never counts it as a failed fetch."""


# ---------------------------------------------------------------- config

def load_config(path):
    """Load watch.yaml; refuse unknown feed source types (ValueError naming the asset and feed)."""
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if not isinstance(cfg, dict) or not isinstance(cfg.get("assets"), dict) or not cfg["assets"]:
        raise ValueError(f"{path}: no 'assets' mapping")
    for name, asset in cfg["assets"].items():
        for key in ("author", "window", "feeds"):
            if key not in asset:
                raise ValueError(f"asset {name}: missing '{key}'")
        if not str(asset["author"].get("user_id", "")).isdigit():
            raise ValueError(f"asset {name}: author.user_id must be the numeric X user id")
        outside = asset["window"].get("outside")
        if outside not in SUPPORTED_OUTSIDE:
            raise ValueError(f"asset {name}: unknown window.outside {outside!r}")
        for feed in asset["feeds"]:
            src = feed.get("source")
            if src not in SUPPORTED_SOURCES:
                raise ValueError(f"asset {name} feed {feed.get('id')!r}: unknown source type {src!r} "
                                 f"(supported: {', '.join(SUPPORTED_SOURCES)})")
    return cfg


# ---------------------------------------------------------------- calendar

def get_today():
    """Today's local date; ORION_DW_TODAY=YYYY-MM-DD overrides (tests and the Task 13 wrapper check)."""
    override = os.environ.get("ORION_DW_TODAY")
    if override:
        return date.fromisoformat(override)
    return date.today()


def last_quarter_end(d):
    """The latest quarter end strictly before d."""
    for y in (d.year, d.year - 1):
        for m, day in ((12, 31), (9, 30), (6, 30), (3, 31)):
            qe = date(y, m, day)
            if qe < d:
                return qe
    raise AssertionError("unreachable")


def window_of(d, asset_cfg):
    """(key, last_day) of the post-quarter window containing d, else None. Key '<YYYY>Q<n>' = the quarter that ended."""
    qe = last_quarter_end(d)
    days = asset_cfg["window"]["after_quarter_end_days"]
    if 1 <= (d - qe).days <= days:
        return f"{qe.year}Q{(qe.month - 1) // 3 + 1}", qe + timedelta(days=days)
    return None


def latest_window(d, asset_cfg):
    """(key, last_day) of the window after the latest quarter end before d, whether or not it has ended yet."""
    qe = last_quarter_end(d)
    return f"{qe.year}Q{(qe.month - 1) // 3 + 1}", qe + timedelta(days=asset_cfg["window"]["after_quarter_end_days"])


def closed_windows(today, since, asset_cfg):
    """[(key, last_day)] oldest first: every post-quarter window whose last day is in [since, today]. A window that
    ended before the watcher started (since) is never one: the watcher could not have looked for its recording."""
    out, d = [], today + timedelta(days=1)
    while True:
        key, last_day = latest_window(d, asset_cfg)
        if last_day < since:
            return out[::-1]
        if last_day <= today:
            out.append((key, last_day))
        d = last_quarter_end(d)  # the window before: from the quarter end itself, so last_quarter_end steps back


def watch_since_of(data, today):
    """The day the watcher started on this asset: state's watch_since, else the first post it recorded, else today."""
    if data.get("watch_since"):
        return date.fromisoformat(data["watch_since"])
    seen = [r.get("first_seen_at") for r in data.get("posts", {}).values() if r.get("first_seen_at")]
    return min(date.fromisoformat(s[:10]) for s in seen) if seen else today


def is_scan_day(today, cfg):
    """Daily from quarter end + 1 to quarter end + after_quarter_end_days; outside the window, Mondays only."""
    if window_of(today, cfg) is not None:
        return True
    return today.weekday() == 0


# ---------------------------------------------------------------- http

class UrllibHttp:
    """The real http dependency: get(url) / post(url, data) -> (status, text). Network errors raise OSError."""

    def __init__(self, timeout=30):
        self.timeout = timeout

    def _send(self, req):
        try:
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.status, r.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode("utf-8", "replace")
        except http.client.HTTPException as e:  # IncompleteRead, BadStatusLine, ...: a network error like OSError
            raise OSError(f"{type(e).__name__}: {e}") from e

    def get(self, url):
        return self._send(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}))

    def post(self, url, data):
        body = urllib.parse.urlencode(data).encode()
        return self._send(urllib.request.Request(url, data=body, headers={
            "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"}))


# ---------------------------------------------------------------- discovery

def extract_status_ids(html, handle):
    """Status ids of <handle>'s posts in a result page; the bare status pattern is the fallback."""
    ids = re.findall(r"(?:x|twitter)\.com(?:/|%2F)" + re.escape(handle) + r"(?:/|%2F)status(?:/|%2F)(\d{15,20})",
                     html, re.I)
    if not ids:
        ids = re.findall(r"status(?:/|%2F)(\d{15,20})", html, re.I)
    return sorted(set(ids), key=int)


def _search_once(http, query, handle):
    try:
        status, text = http.post(SEARCH_URL, {"q": query})
    except OSError as e:
        raise SearchFailed(f"network error: {e}") from e
    if status != 200:
        raise SearchFailed(f"HTTP {status}")
    if ANOMALY_MARKERS.search(text or ""):
        raise SearchFailed("anomaly page")
    ids = extract_status_ids(text or "", handle)
    if not ids:
        raise SearchFailed("no status ids in result page")
    return ids


def search_ids(http, cfg, sleep=time.sleep):
    """One search per feed of the asset; any failed answer waits 60 s and retries once, then raises SearchFailed."""
    handle = cfg["author"]["handle"]
    found = set()
    for feed in cfg["feeds"]:
        try:
            ids = _search_once(http, feed["search"], handle)
        except SearchFailed:
            sleep(SEARCH_RETRY_WAIT_S)
            ids = _search_once(http, feed["search"], handle)
        found.update(ids)
    return sorted(found, key=int)


def fetch_post(http, post_id):
    """tweet-result JSON for a post id. Raises PostUnavailable when the post is gone (HTTP 404, a tombstone body, or an
    empty object with no id_str), else RuntimeError for an outage (network error, 429, 5xx, ...) or an unparsable
    answer (the id stays unknown and is retried next run)."""
    try:
        status, text = http.get(TWEET_RESULT_URL.format(id=post_id))
    except OSError as e:
        raise RuntimeError(f"tweet-result {post_id}: network error: {e}") from e
    if status == 404:
        raise PostUnavailable(f"tweet-result {post_id}: unavailable (404)")
    if status != 200:
        raise RuntimeError(f"tweet-result {post_id}: HTTP {status}")
    try:
        post = json.loads(text)
    except ValueError as e:
        raise RuntimeError(f"tweet-result {post_id}: not JSON") from e
    if isinstance(post, dict) and (post.get("__typename") == "TweetTombstone" or "tombstone" in post):
        raise PostUnavailable(f"tweet-result {post_id}: unavailable (tombstone)")
    if isinstance(post, dict) and not post.get("id_str") and not post.get("user") and not post.get("created_at"):
        raise PostUnavailable(f"tweet-result {post_id}: unavailable (empty answer)")
    if not isinstance(post, dict) or "user" not in post or "created_at" not in post:
        raise RuntimeError(f"tweet-result {post_id}: no post in answer ({str(post.get('__typename', '?'))[:40]})"
                           if isinstance(post, dict) else f"tweet-result {post_id}: unexpected answer")
    return post


# ---------------------------------------------------------------- classification

def parse_created_at(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def video_duration_ms(post):
    """Longest video duration in the post (ms), or None when the post has no video."""
    durations = []
    video = post.get("video")
    if isinstance(video, dict) and video.get("durationMs") is not None:
        durations.append(int(video["durationMs"]))
    for m in post.get("mediaDetails") or []:
        ms = (m.get("video_info") or {}).get("duration_millis")
        if ms is not None:
            durations.append(int(ms))
    if durations:
        return max(durations)
    return 0 if video else None


def classify(post, cfg, now):
    """'recording' | 'announcement' | 'irrelevant' for a tweet-result post, by the asset's author and feeds."""
    if str((post.get("user") or {}).get("id_str")) != str(cfg["author"]["user_id"]):
        return "irrelevant"
    if now - parse_created_at(post["created_at"]) > timedelta(days=MAX_POST_AGE_DAYS):
        return "irrelevant"
    text = post.get("text") or ""
    duration = video_duration_ms(post)
    for feed in cfg["feeds"]:
        if feed["source"] != "x_video":
            continue
        if (duration is not None and duration >= feed["min_video_minutes"] * 60000
                and re.search(feed["match_text"], text)):
            return "recording"
    for feed in cfg["feeds"]:
        if feed["source"] == "x_video" and duration is None and re.search(feed["announce_text"], text):
            return "announcement"
    return "irrelevant"


# ---------------------------------------------------------------- state

def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class State:
    """state/<asset>.json: posts by id (spec 8.1 fields), search health, windows. Written tmp + os.replace."""

    def __init__(self, path, data):
        self.path = None if path is None else Path(path)
        self.data = data

    @classmethod
    def load(cls, path):
        path = Path(path)
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        data.setdefault("posts", {})
        data.setdefault("search", {})
        data["search"].setdefault("last_ok_at", None)
        data["search"].setdefault("consecutive_failures", 0)
        data.setdefault("windows", {})
        return cls(path, data)

    def get(self, post_id):
        return self.data["posts"].get(str(post_id))

    def set(self, post_id, **fields):
        unknown = set(fields) - set(POST_FIELDS)
        if unknown:
            raise ValueError(f"unknown state fields: {sorted(unknown)}")
        if "status" in fields and fields["status"] not in STATUSES:
            raise ValueError(f"unknown status {fields['status']!r}")
        now = utc_now_iso()
        rec = self.data["posts"].get(str(post_id))
        if rec is None:
            if "status" not in fields:
                raise ValueError(f"post {post_id}: a new state record needs a status")
            rec: dict = {k: None for k in POST_FIELDS}
            rec.update(first_seen_at=now, attempts=0)
            self.data["posts"][str(post_id)] = rec
        rec.update(fields)
        rec["updated_at"] = fields.get("updated_at", now)
        return rec

    @staticmethod
    def empty_data():
        return {"posts": {}, "search": {"last_ok_at": None, "consecutive_failures": 0}, "windows": {}}

    def window(self, key):
        return self.data["windows"].setdefault(key, {"found_post_id": None, "closed_reported": False})

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, sort_keys=True)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise


def append_log(base_dir, asset, entry):
    path = Path(base_dir) / "log" / f"{asset}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")


# ---------------------------------------------------------------- scan

def alert_search_failed(asset, last_error):
    return f"ORION DISCLOSURE ALERT {asset}: search failed {SEARCH_ALERT_DAYS} scan days running ({_one_line(last_error)})"


def window_closed_line(asset, key):
    return f"ORION DISCLOSURE {asset}: window {key} closed with no investor-call recording found"


def process_queued(asset, asset_cfg, state, base_dir, opts=None):
    """Spec 8.2 step 5: process the oldest post waiting for processing (queued, or left at transcribed / doc_added by an
    interrupted run or a busy run lock), at most one per run. Needs an Orion driver in opts['orion'] (a caller without
    one only discovers). Returns output lines."""
    opts = opts or {}
    if opts.get("orion") is None:
        return []
    waiting = [pid for pid, rec in state.data["posts"].items() if rec.get("status") in RETRY_STATUSES]
    if not waiting:
        return []
    post_id = min(waiting, key=int)  # X ids grow with time: the smallest is the oldest
    return process_post(post_id, asset_cfg, state, opts["orion"], {**opts, "asset": asset, "base_dir": base_dir})


def _record_search_failure(state, today, error):
    s = state.data["search"]
    s["last_error"] = error
    if s.get("last_failed_day") == today.isoformat():
        return False  # a failed scan DAY is counted once, however many attempts that day
    s["last_failed_day"] = today.isoformat()
    s["consecutive_failures"] = int(s.get("consecutive_failures") or 0) + 1
    return s["consecutive_failures"] == SEARCH_ALERT_DAYS


def scan_asset(asset, asset_cfg, base_dir, http, today, now, sleep=time.sleep, opts=None):
    """Spec 8.2 for one asset. Returns the output lines (alert lines first); [] on a quiet run.

    The whole scan holds state/<asset>.lock (fcntl.flock), so a concurrent scan or ingest cannot overwrite its state.
    """
    if not is_scan_day(today, asset_cfg):
        return []
    opts = dict(opts or {})
    opts.update(http=http)
    opts.setdefault("now", now)
    opts.setdefault("today", today)
    try:
        with asset_lock(base_dir, asset, opts.get("lock_timeout", LOCK_TIMEOUT_S)):
            if opts.get("dry_run"):  # as ingest's: transcripts in a temporary directory, state and log unwritten
                with tempfile.TemporaryDirectory(prefix="dw-dry-") as tmp:
                    return _scan_asset_locked(asset, asset_cfg, Path(base_dir), http, today, now, sleep,
                                              {**opts, "transcripts_dir": tmp})
            return _scan_asset_locked(asset, asset_cfg, Path(base_dir), http, today, now, sleep, opts)
    except LockBusy as e:
        return [lock_busy_line(asset, e)]


class DrySeen:
    """--dry-state: the post ids staging's dry scans have processed, {asset: {post_id: {status, at}}}, apart from the
    real state (which a dry scan never writes). Without it every scan day finds the same posts new again and reports
    them again (the 'analyst run was skipped' line, daily, for one post). Written tmp + os.replace."""

    def __init__(self, path):
        self.path = Path(path)
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.data = {}
        if not isinstance(self.data, dict):
            self.data = {}

    def ids(self, asset):
        return list((self.data.get(asset) or {}).keys())

    def add(self, asset, post_id, status, at):
        self.data.setdefault(asset, {})[str(post_id)] = {"status": status, "at": at}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)


DRY_SEEN = "dry_seen"  # a dry-state post in a dry scan's memory state: neither new nor waiting


def _scan_asset_locked(asset, asset_cfg, base_dir, http, today, now, sleep, opts):
    state = State.load(base_dir / "state" / f"{asset}.json")
    dry_seen = None
    if opts.get("dry_run"):  # a dry scan reads the state (known ids stay skipped) and never writes it
        state = MemoryState(None, state.data)
        if opts.get("dry_state"):
            dry_seen = DrySeen(opts["dry_state"])
            for pid in dry_seen.ids(asset):
                rec = state.get(pid)
                if rec is None or rec.get("status") in RETRY_STATUSES:
                    state.data["posts"][str(pid)] = {**(rec or {}), "status": DRY_SEEN}
    alerts, info = [], []
    entry = {"at": now.isoformat(timespec="seconds"), "today": today.isoformat(), "asset": asset,
             "search_ok": False, "ids": [], "new": [], "decisions": {}, "errors": []}
    try:
        ids = search_ids(http, asset_cfg, sleep=sleep)
    except SearchFailed as e:
        entry["errors"].append(f"search: {e}")
        if _record_search_failure(state, today, str(e)):
            alerts.append(alert_search_failed(asset, e))
        ids = None
    if ids is not None:
        entry["search_ok"] = True
        entry["ids"] = ids
        state.data["search"]["last_ok_at"] = now.isoformat(timespec="seconds")
        new_ids = [i for i in ids if state.get(i) is None]
        entry["new"] = new_ids
        fetched, fetch_error = 0, None
        for post_id in new_ids:
            try:
                post = fetch_post(http, post_id)
            except PostUnavailable as e:
                # The post is gone: a fact about it, not an outage. Deduped forever; not a failed fetch.
                fetched += 1
                state.set(post_id, status="irrelevant", kind=None, error=str(e))
                entry["decisions"][post_id] = "irrelevant"
                continue
            except RuntimeError as e:
                entry["errors"].append(str(e))
                fetch_error = str(e)
                continue
            fetched += 1
            kind = classify(post, asset_cfg, now)
            status = {"recording": "queued", "announcement": "announcement"}.get(kind, "irrelevant")
            state.set(post_id, status=status, kind=kind if kind != "irrelevant" else None)
            entry["decisions"][post_id] = status
            if kind == "recording":
                w = window_of(parse_created_at(post["created_at"]).date(), asset_cfg)
                if w is not None and state.window(w[0])["found_post_id"] is None:
                    state.window(w[0])["found_post_id"] = post_id
        if new_ids and not fetched:
            # Every tweet-result fetch failed: the scan learned nothing, so the day counts like a failed search
            # (towards the same three-day alert), never as "nothing found".
            error = f"tweet-result: all {len(new_ids)} fetch(es) failed; last: {fetch_error}"
            if _record_search_failure(state, today, error):
                alerts.append(alert_search_failed(asset, error))
        else:
            state.data["search"]["consecutive_failures"] = 0
            state.data["search"].pop("last_failed_day", None)
        state.save()
    waiting = [pid for pid, rec in state.data["posts"].items() if rec.get("status") in RETRY_STATUSES]
    out = process_queued(asset, asset_cfg, state, base_dir, opts)
    if dry_seen is not None:
        done = set(i for i in entry["new"] if (state.get(i) or {}).get("status") not in RETRY_STATUSES)
        if waiting and opts.get("orion") is not None:
            done.add(min(waiting, key=int))  # the one post process_queued took, whatever it ended at
        for pid in sorted(done, key=int):
            dry_seen.add(asset, pid, (state.get(pid) or {}).get("status"), now.isoformat(timespec="seconds"))
        if done:
            dry_seen.save()
    for line in out:
        (alerts if line.startswith("ORION DISCLOSURE ALERT") else info).append(line)
    # Every window that has closed since the watcher started, oldest first: on its last day, or the first scan after
    # it, however long the watcher was down (an outage past the next quarter end still reports the old window).
    since = watch_since_of(state.data, today)
    state.data["watch_since"] = since.isoformat()
    for key, _last_day in closed_windows(today, since, asset_cfg):
        win = state.window(key)
        if win["found_post_id"] is None and not win["closed_reported"]:
            alerts.append(window_closed_line(asset, key))
            win["closed_reported"] = True
    state.save()
    if not opts.get("dry_run"):
        append_log(base_dir, asset, entry)
    return alerts + info


def default_now(today):
    """Real UTC time; under ORION_DW_TODAY, noon UTC of that day so the 120-day age check follows the override."""
    if os.environ.get("ORION_DW_TODAY"):
        return datetime.combine(today, dtime(12, 0), tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def run_scan(cfg, base_dir, http, today, sleep=time.sleep, now=None, assets=None, opts=None):
    """scan over the configured assets (or the named ones). Returns all output lines."""
    if now is None:
        now = default_now(today)
    lines = []
    for asset, asset_cfg in cfg["assets"].items():
        if assets and asset not in assets:
            continue
        lines += scan_asset(asset, asset_cfg, base_dir, http, today, now, sleep=sleep, opts=opts)
    return lines


# ---------------------------------------------------------------- the state lock

LOCK_TIMEOUT_S = 60


class LockBusy(Exception):
    """Another watcher run holds state/<asset>.lock."""


@contextlib.contextmanager
def asset_lock(base_dir, asset, timeout=LOCK_TIMEOUT_S, poll=0.2):
    """Exclusive fcntl.flock on state/<asset>.lock for a whole scan or ingest; waits up to `timeout` s, then LockBusy."""
    path = Path(base_dir) / "state" / f"{asset}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a")
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise LockBusy(str(path)) from None
                time.sleep(poll)
        yield
    finally:
        f.close()  # closing the file releases the lock


def lock_busy_line(asset, err):
    return f"ORION DISCLOSURE ALERT {asset}: another watcher run holds {err}; this run gave up after waiting"


# ---------------------------------------------------------------- text

# Caps re-applied on the Hermes side (spec 7.1, 7.2, 8.5).
TITLE_CAP, EVENT_CAP, TEXT_CAP, FIX_CAP, QUOTE_CAP, WORD_CAP = 120, 200, 1000, 1500, 500, 64
_SLACK_SEQ = re.compile(r"<[@!#][^>]*>")
_SLACK_OPEN = re.compile(r"<[@!#]")
_URL = re.compile(r"https?://\S+", re.I)
_COMMENT = re.compile(r"<!--|-->")
_BROADCAST = re.compile(r"@(?:here|channel|everyone)\b", re.I)


def clean_model_text(s, cap, keep_newlines=False):
    """A model-written string made safe for Slack and the queue. In this order (so an invisible character cannot hide a
    sequence from the patterns): control and format characters removed (Unicode Cc/Cf/Cs/Co/Cn; newlines kept only
    with keep_newlines, as in claims; tabs -> blanks); then Slack control sequences (<@..>, <!..>, <#..>), bare URLs
    and HTML comment markers (<!--, -->) replaced by blanks; then any '<' and '>' left turned into '\u2039' and
    '\u203a' (Slack reads nothing in angle brackets as markup then) and @here, @channel, @everyone removed (any case);
    then runs of blanks collapsed, capped at `cap`, trimmed."""
    if s is None:
        return ""
    s = str(s).replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
    out = []
    for ch in s:
        if ch == "\n":
            out.append("\n" if keep_newlines else " ")
        elif unicodedata.category(ch) not in ("Cc", "Cf", "Cs", "Co", "Cn"):
            out.append(ch)
    s = "".join(out)
    # Each removal leaves a blank, so no removal can join its neighbours into a new sequence.
    s = _COMMENT.sub(" ", s)
    s = _SLACK_SEQ.sub(" ", s)
    s = _SLACK_OPEN.sub(" ", s)
    s = _URL.sub(" ", s)
    s = s.replace("<", "\u2039").replace(">", "\u203a")
    s = _BROADCAST.sub(" ", s)
    lines = [" ".join(line.split()) for line in s.split("\n")]
    s = "\n".join(line for line in lines if line)
    return s[:cap].strip()


def normalize_doc_text(raw):
    """Orion's normalizeDocText (spec 4.1, ruling 5): leading BOM stripped, CRLF -> LF, trailing newlines -> exactly one."""
    if raw.startswith("\ufeff"):
        raw = raw[1:]
    return raw.replace("\r\n", "\n").rstrip("\n") + "\n"


def format_transcript(segments):
    """`[mm:ss] text` per non-empty segment (minutes padded to two digits, three past 99), in Orion's normalized form."""
    lines = []
    for start, text in segments:
        text = " ".join(str(text).split())
        if text:
            lines.append(f"[{int(start // 60):02d}:{int(start % 60):02d}] {text}")
    return normalize_doc_text("\n".join(lines))


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _one_line(s, cap=300):
    """The last non-blank line of an error text (subprocess stderr, an exception, an Orion error message), made safe
    for Slack by clean_model_text and capped at `cap`: every alert line carries text from outside the script."""
    lines = [line.strip() for line in str(s or "").splitlines() if line.strip()]
    return clean_model_text(lines[-1] if lines else "", cap)


# ---------------------------------------------------------------- media: download, decode, transcribe (spec 8.4)

class StepFailed(Exception):
    def __init__(self, step, message):
        super().__init__(f"{step}: {message}")
        self.step, self.message = step, message


def _run_cmd(cmd, timeout=1800):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", f"timed out after {timeout} s")
    except OSError as e:
        return subprocess.CompletedProcess(cmd, 127, "", str(e))


def _ytdlp():
    """The yt-dlp beside the running interpreter (the watcher venv's, which the daemon upgrades weekly), else PATH's."""
    sibling = Path(sys.executable).parent / "yt-dlp"
    if sibling.exists():
        return str(sibling)
    return shutil.which("yt-dlp") or "yt-dlp"


def transcribe(wav_path, cfg):
    """faster-whisper on a 16 kHz mono WAV, per transcribe-reference.py. cfg is the asset's config. -> [(start_s, text)]"""
    import wave

    import numpy as np
    from faster_whisper import WhisperModel

    t = cfg["transcribe"]
    with wave.open(str(wav_path)) as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    model = WhisperModel(t["asr_model"], device="cpu", compute_type="int8", cpu_threads=4)
    segments, _info = model.transcribe(audio, vad_filter=True, beam_size=1, initial_prompt=t.get("initial_prompt"))
    return [(s.start, s.text) for s in segments]


def transcribe_post(post_id, url, cfg, opts):
    """Download the post's audio, decode to WAV, transcribe. -> (transcript text, audio sha256). Audio and WAV are
    deleted in a finally. Raises StepFailed('download' | 'transcribe', message)."""
    cache = Path(opts.get("cache_dir") or default_cache(opts.get("base_dir") or BASE_DIR))
    cache.mkdir(parents=True, exist_ok=True)
    run_cmd = opts.get("run_cmd") or _run_cmd
    transcribe_fn = opts.get("transcribe") or transcribe
    wav = cache / f"{post_id}.wav"
    try:
        r = run_cmd([_ytdlp(), "-f", "hls-audio-64000-Audio/bestaudio", "-o", str(cache / f"{post_id}.%(ext)s"), url])
        if r.returncode != 0:
            raise StepFailed("download", f"yt-dlp exit {r.returncode}: {_one_line(r.stderr)}")
        audio = [p for p in sorted(cache.glob(f"{post_id}.*")) if p.suffix not in (".wav", ".part", ".ytdl")]
        if not audio:
            raise StepFailed("download", "yt-dlp wrote no audio file")
        audio_sha = sha256_file(audio[0])
        limit = ["-t", str(opts["asr_seconds"])] if opts.get("asr_seconds") else []
        r = run_cmd(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(audio[0]), *limit,
                     "-ac", "1", "-ar", "16000", "-f", "wav", str(wav)])
        if r.returncode != 0:
            raise StepFailed("transcribe", f"ffmpeg exit {r.returncode}: {_one_line(r.stderr)}")
        try:
            segments = transcribe_fn(str(wav), cfg)
        except Exception as e:  # noqa: BLE001 - any ASR failure is this step's failure
            raise StepFailed("transcribe", _one_line(e) or type(e).__name__) from e
        return format_transcript(segments), audio_sha
    finally:
        for p in cache.glob(f"{post_id}.*"):
            with contextlib.suppress(FileNotFoundError):
                p.unlink()


# ---------------------------------------------------------------- the Orion CLI driver

class OrionCliError(RuntimeError):
    pass


def _error_text(data, code):
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        return f"{err.get('code')}: {err.get('message')}"
    return f"exit {code}"


class OrionCli:
    """The real Orion: `$ORION_NODE dist/cli/index.js <args> --json` (default `node`), cwd = the release root,
    ORION_HOME = the home. The rest of the environment (ORION_DATABASE_URL, ORION_ENV_FILE, ANTHROPIC_API_KEY, ...)
    is inherited."""

    def __init__(self, repo, home, timeout=1800):
        self.repo, self.home, self.timeout = Path(repo), Path(home), timeout

    def _call(self, args, timeout=300):
        env = {**os.environ, "ORION_HOME": str(self.home)}
        try:
            r = subprocess.run([os.environ.get("ORION_NODE") or "node", "dist/cli/index.js", *args, "--json"],
                               cwd=self.repo, env=env,
                               capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise OrionCliError(f"orion {args[0]} {args[1] if len(args) > 1 else ''}: {e}") from e
        try:
            data = json.loads(r.stdout)
        except ValueError:
            data = {"error": {"code": "bad_output", "message": _one_line(r.stderr) or _one_line(r.stdout[:200])}}
        return r.returncode, data

    def _checked(self, args):
        code, data = self._call(args)
        if code != 0 or not isinstance(data, dict) or isinstance(data.get("error"), dict):  # a row's null `error` is fine
            raise OrionCliError(_error_text(data, code))
        return data

    def doc_add(self, asset, *, url, file, kind, source_id, published_at, title, meta):
        args = ["doc", "add", asset, "--url", url, "--file", str(file), "--kind", kind, "--source-id", source_id,
                "--published-at", published_at, "--title", title]
        for k, v in meta.items():
            args += ["--meta", f"{k}={v}"]
        return self._checked(args)

    def agent_run(self, asset, doc_id, dry_run):
        """-> (exit code, JSON). A dry run passes --dry-run. No --out: since Phase 1 no run writes a signal."""
        args = ["agent", "run", asset, "--type", "disclosure", "--doc", str(doc_id)]
        args += ["--dry-run"] if dry_run else []
        return self._call(args, timeout=self.timeout)

    def run_show(self, run_id):
        return self._checked(["agent", "runs", "show", str(run_id)])

    def inbox(self, asset):
        return self._checked(["inbox", asset])


# ---------------------------------------------------------------- processing one post (spec 8.4)

# Statuses an ingest refuses without --force; statuses a scan picks up for processing.
PROCESSED = ("seeded", "transcribed", "doc_added", "run_done", "run_failed", "failed")
RETRY_STATUSES = ("queued", "transcribed", "doc_added")


class MemoryState(State):
    """A dry run's state: never written (a dry run leaves the watcher's state alone, as Orion's dry run does its DB)."""

    def save(self):
        pass


def post_url(asset_cfg, post_id):
    return f"https://x.com/{asset_cfg['author']['handle']}/status/{post_id}"


def post_title(feed, asset, created_at):
    """A text-only post's doc title: the feed's post_title ({date} = the post's UTC date), else '<ASSET> post <date>'.
    The feed's title names a call recording, so a plain post must not carry it."""
    return feed.get("post_title", f"{asset.upper()} post {{date}}").format(date=created_at[:10])


def quarter_key(d):
    """'<YYYY>Q<n>' of the latest quarter that ended before d (the quarter a call on d reviews)."""
    qe = last_quarter_end(d)
    return qe.year, (qe.month - 1) // 3 + 1


def _video_feed(asset_cfg):
    return next(f for f in asset_cfg["feeds"] if f["source"] == "x_video")


def doc_label(kind, asr_model):
    """Orion's docLabel (src/db/documents.ts), for the queue's Source line."""
    if kind == "machine_transcript":
        return (f"machine transcript ({asr_model or 'unknown model'}): names and numbers may be misheard; every figure "
                "in it is the speaker's dated claim, not a fact")
    if kind == "post":
        return "the issuer's own post: a dated claim"
    return kind


def run_json_path(post_id, tdir, opts):
    """--run-json, else transcripts/<asset>/<post_id>.run.json; on a dry run (whose transcripts dir is temporary) the
    default sits next to --queue-file."""
    if opts.get("run_json"):
        return Path(opts["run_json"])
    if opts.get("dry_run") and opts.get("queue_file"):
        return Path(opts["queue_file"]).parent / f"{post_id}.run.json"
    return Path(tdir) / f"{post_id}.run.json"


def _completed(result):
    return isinstance(result, dict) and isinstance(result.get("run"), dict) and result["run"].get("outcome") == "completed"


def _write_run_json(path, result, asset, post_id):
    """Write the raw `agent run --json` result (tmp + os.replace). A result that is not a completed run never replaces
    a completed one already there (a failed --force retry): it goes to <name>.failed.json beside it, and a line says
    so. -> [] or [one line]; never raises."""
    note = []
    try:
        if not _completed(result) and path.exists():
            with contextlib.suppress(Exception):
                if _completed(json.loads(path.read_text(encoding="utf-8"))):
                    path = path.with_name(path.name[:-len(".json")] + ".failed.json") \
                        if path.name.endswith(".json") else path.with_name(path.name + ".failed")
                    note = [f"ORION DISCLOSURE {asset}: post {post_id}: the earlier completed run's JSON is kept; "
                            f"this result is in {path.name}"]
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        return note
    except Exception as e:  # noqa: BLE001 - the run is done whatever happens here
        return [f"ORION DISCLOSURE ALERT {asset}: run json write failed for post {post_id}: "
                f"{_one_line(f'{type(e).__name__}: {e}')}"]


def process_post(post_id, cfg, state, orion, opts):
    """Spec 8.4 for one post, then the post-run step (8.5). cfg is the asset's config; opts carries asset, base_dir and
    either post (tweet-result JSON) or http. Returns output lines (an alert line first when a step fails)."""
    asset, base_dir = opts["asset"], Path(opts["base_dir"])
    post_id = str(post_id)
    post = opts.get("post")
    if post is None:
        try:
            post = fetch_post(opts["http"], post_id)
        except RuntimeError as e:  # the post stays where it is and is retried next run
            state.set(post_id, error=f"fetch: {e}")
            state.save()
            return []
    url = post_url(cfg, post_id)
    created_at = post["created_at"]
    year, quarter = quarter_key(parse_created_at(created_at).date())
    feed = _video_feed(cfg)
    duration_ms = video_duration_ms(post)
    kind = feed.get("doc_kind", "machine_transcript") if duration_ms is not None else "post"
    title = feed["title"].format(year=year, quarter=quarter) if kind != "post" else post_title(feed, asset, created_at)
    asr_model = cfg.get("transcribe", {}).get("asr_model") if kind == "machine_transcript" else None
    rec = state.get(post_id) or state.set(post_id, status="queued", kind="recording" if kind != "post" else "post")
    state.set(post_id, attempts=int(rec.get("attempts") or 0) + 1, error=None)
    state.save()

    def fail(step, message, status="failed"):
        message = _one_line(message)
        state.set(post_id, status=status, error=f"{step}: {message}")
        state.save()
        return [f"ORION DISCLOSURE ALERT {asset}: {step} failed for post {post_id}: {message}"]

    # 1-3: the transcript (or the post's text), written exactly as Orion will store it.
    tdir = Path(opts.get("transcripts_dir") or base_dir / "transcripts" / asset)
    tdir.mkdir(parents=True, exist_ok=True)
    txt_path, meta_path = tdir / f"{post_id}.txt", tdir / f"{post_id}.meta.json"
    audio_sha, transcribed_at = None, None
    if opts.get("transcript"):
        try:
            text = normalize_doc_text(Path(opts["transcript"]).read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError) as e:
            return fail("transcribe", f"--transcript {opts['transcript']}: {e}")
    elif kind == "post":
        text = normalize_doc_text(html.unescape(post.get("text") or ""))
    else:
        text = None
        if txt_path.exists() and meta_path.exists():  # a busy run lock, an interrupted run or --force: reuse
            try:
                old = json.loads(meta_path.read_text(encoding="utf-8"))
                text = normalize_doc_text(txt_path.read_text(encoding="utf-8"))
                audio_sha, transcribed_at, asr_model = (old.get("audio_sha256"), old.get("transcribed_at"),
                                                        old.get("asr_model"))
            except (OSError, ValueError, AttributeError):  # unreadable or not an object: transcribe again
                text, audio_sha, transcribed_at = None, None, None
        if text is None:
            try:
                text, audio_sha = transcribe_post(post_id, url, cfg, opts)
            except StepFailed as e:
                return fail(e.step, e.message)
            transcribed_at = utc_now_iso()
    if not text.strip():
        return fail("transcribe", "the transcript is empty")
    data = text.encode("utf-8")
    sha = sha256_bytes(data)
    txt_path.write_bytes(data)
    meta = {"post_id": post_id, "url": url, "created_at": created_at,
            "duration_s": None if duration_ms is None else duration_ms / 1000, "asr_model": asr_model,
            "audio_sha256": audio_sha, "transcript_sha256": sha, "transcribed_at": transcribed_at,
            "kind": kind, "transcript_file": opts.get("transcript")}
    meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    state.set(post_id, status="transcribed", kind="recording" if kind != "post" else "post")
    state.save()

    if opts.get("no_orion"):  # test-only: the smoke test of download + ASR
        return [f"transcript {txt_path.name}: {len(text.splitlines())} lines, sha256 {sha}"] + text.splitlines()[:5]

    # 5: doc add, and the sha256 handshake.
    doc_meta = {"post_id": post_id, "asr_model": asr_model, "duration_s": meta["duration_s"],
                "audio_sha": audio_sha, "transcribed_at": transcribed_at}  # Orion meta keys: [a-z_]{1,32}
    try:
        added = orion.doc_add(cfg.get("orion_asset", asset), url=url, file=str(txt_path), kind=kind,
                              source_id=f"x:{post_id}", published_at=created_at, title=title,
                              meta={k: str(v) for k, v in doc_meta.items() if v is not None})
    except Exception as e:  # noqa: BLE001 - OrionCliError, or the driver itself failing
        return fail("doc add", e)
    if added.get("sha256") != sha:
        return fail("doc add", f"sha256 mismatch (script {sha}, orion {added.get('sha256')})")
    doc_id = added["id"]
    state.set(post_id, status="doc_added", doc_id=doc_id, doc_sha256=sha)
    state.save()
    if opts.get("stop_after") == "doc-add":
        return [f"ORION DISCLOSURE {asset}: doc #{doc_id} {kind} stored ({'existing' if added.get('existing') else 'new'},"
                f" sha256 {sha}); stopped after doc add"]

    # 6: the analyst run. Its raw --json result is kept in a file (spec 15, ruling 19): check_acceptance.py reads it.
    dry_run = bool(opts.get("dry_run"))
    try:
        code, res = orion.agent_run(cfg.get("orion_asset", asset), doc_id, dry_run)
    except Exception as e:  # noqa: BLE001
        return fail("run", e, status="run_failed")
    run_json_alerts = _write_run_json(run_json_path(post_id, tdir, opts), res, asset, post_id)

    def out(lines):
        return run_json_alerts + lines

    res = res if isinstance(res, dict) else {}
    err = res.get("error")
    if code != 0 and isinstance(err, dict):
        if err.get("code") == "run_in_progress":  # the run lock: stay at doc_added, the next scan retries
            state.set(post_id, error=f"run: run_in_progress: {_one_line(err.get('message'))}")
            state.save()
            return out([f"ORION DISCLOSURE {asset}: run_in_progress (the asset's run lock is held) for post {post_id}; "
                        f"doc #{doc_id} is stored; the next scan retries the run"])
        if err.get("code") == "no_credentials" and dry_run:  # staging runs dry with no Anthropic key: not an alert
            state.set(post_id, error="run: no_credentials (dry run)")
            state.save()
            return out([f"ORION DISCLOSURE {asset}: dry run without Anthropic credentials: the analyst run was skipped "
                        f"for post {post_id}; doc #{doc_id} is stored"])
        if err.get("code") == "agent_refused_stage" and dry_run:  # Orion refuses every agent run on stage (I-4)
            state.set(post_id, error="run: agent_refused_stage (dry run)")
            state.save()
            return out([f"ORION DISCLOSURE {asset}: dry run on stage (agents never run on stage): the analyst run was "
                        f"skipped for post {post_id}; doc #{doc_id} is stored"])
        return out(fail("run", f"{err.get('code')}: {err.get('message')}", status="run_failed"))
    run = res.get("run")
    if not isinstance(run, dict):
        return out(fail("run", f"exit {code} without a run in the output", status="run_failed"))
    completed = run.get("outcome") == "completed"
    state.set(post_id, status="run_done" if completed else "run_failed", run_id=run.get("id"),
              run_outcome=run.get("outcome"), error=None if completed else f"run: {run.get('outcome')}: {run.get('error')}")
    state.save()

    # 7: the post-run step. The run is done whatever happens here: a failure is an alert, the state stays as set.
    try:
        show, inbox = {}, {}
        if completed:
            with contextlib.suppress(Exception):
                show = orion.run_show(run["id"])
            if (res.get("committed") or {}).get("proposalIds"):
                with contextlib.suppress(Exception):
                    inbox = orion.inbox(cfg.get("orion_asset", asset))
        post_meta = {"asset": asset, "title": title, "url": url, "posted": created_at[:10], "doc_id": doc_id,
                     "kind": kind, "duration_s": meta["duration_s"], "asr_model": asr_model,
                     "today": opts.get("today") or get_today()}
        queue = Path(opts.get("queue_file") or default_queue(base_dir))
        return out(post_run(res, inbox, show, cfg, queue, post_meta).split("\n"))
    except Exception as e:  # noqa: BLE001 - e.g. the queue file unwritable
        message = _one_line(f"{type(e).__name__}: {e}")
        if not opts.get("dry_run"):
            with contextlib.suppress(Exception):  # a failing log write must not hide the alert
                append_log(base_dir, asset, {"at": utc_now_iso(), "asset": asset, "post_run_failed": post_id,
                                             "run_id": run.get("id"), "error": message})
        return out([f"ORION DISCLOSURE ALERT {asset}: post-run failed for post {post_id}: {message}"])


# ---------------------------------------------------------------- ingest (spec 8.3)

POST_URL_RE = r"(?:x|twitter)\.com/[^/?#]+/status(?:es)?/(\d{5,25})"


def dry_run_usage_error(cmd, opts):
    """A dry run's rules (ingest and scan): an explicit --queue-file and --orion-home. -> the refusal text or None."""
    if opts.get("dry_run") and not opts.get("queue_file"):
        return (f"disclosure_watch.py {cmd}: --dry-run needs an explicit --queue-file "
                "(a dry run never writes the live dev queue)")
    if opts.get("dry_run") and not opts.get("orion_home"):
        return (f"disclosure_watch.py {cmd}: --dry-run needs an explicit --orion-home "
                "(a dry run never uses the live Orion home)")
    return None


def ingest_usage_error(cfg, asset, url, opts):
    """ingest's refusals before any lock, state or network. -> the refusal text or None."""
    if not re.search(POST_URL_RE, url):
        return f"disclosure_watch.py ingest: {url!r} is not an X post url (https://x.com/<handle>/status/<id>)"
    if asset not in cfg["assets"]:
        return f"disclosure_watch.py ingest: unknown asset {asset!r} (configured: {', '.join(cfg['assets'])})"
    return dry_run_usage_error("ingest", opts)


def ingest(cfg, asset, url, orion, opts):
    """The paste-a-link trigger. -> (exit code, lines). 0: run done (or stopped where asked); 1: refused or failed;
    2: a usage error. opts: base_dir, http, dry_run, queue_file, orion_home, run_json, transcript, force, and the test-only
    stop_after, no_orion, asr_seconds, cache_dir, run_cmd, transcribe, lock_timeout."""
    usage = ingest_usage_error(cfg, asset, url, opts)
    if usage:
        return 2, [usage]
    m = re.search(POST_URL_RE, url)
    base_dir = Path(opts["base_dir"])
    try:
        with asset_lock(base_dir, asset, opts.get("lock_timeout", LOCK_TIMEOUT_S)):
            if opts.get("dry_run"):
                with tempfile.TemporaryDirectory(prefix="dw-dry-") as tmp:
                    return _ingest_locked(cfg, asset, m.group(1), orion, {**opts, "transcripts_dir": tmp})
            return _ingest_locked(cfg, asset, m.group(1), orion, opts)
    except LockBusy as e:
        return 1, [lock_busy_line(asset, e)]


def _ingest_locked(cfg, asset, post_id, orion, opts):
    acfg = cfg["assets"][asset]
    base_dir = Path(opts["base_dir"])
    if opts.get("dry_run"):
        state = MemoryState(None, State.empty_data())
    else:
        state = State.load(base_dir / "state" / f"{asset}.json")
    rec = state.get(post_id)
    if rec is not None and rec["status"] in PROCESSED and not opts.get("force"):
        return 1, [f"ORION DISCLOSURE {asset}: post {post_id} is already known (status {rec['status']}); "
                   "use --force to re-run the analyst on it"]
    try:
        post = fetch_post(opts["http"], post_id)
    except RuntimeError as e:
        return 1, [f"ORION DISCLOSURE ALERT {asset}: fetch failed for post {post_id}: {_one_line(e)}"]
    author = acfg["author"]
    if str((post.get("user") or {}).get("id_str")) != str(author["user_id"]):
        who = post.get("user") or {}
        return 1, [f"ORION DISCLOSURE {asset}: post {post_id} is not by the configured author "
                   f"(@{author['handle']}, user id {author['user_id']}; this one is "
                   f"@{clean_model_text(who.get('screen_name'), WORD_CAP)}, "
                   f"user id {clean_model_text(who.get('id_str'), 30)}); refused"]
    is_recording = video_duration_ms(post) is not None
    state.set(post_id, status="queued", kind="recording" if is_recording else "post")
    if is_recording:
        year, quarter = quarter_key(parse_created_at(post["created_at"]).date())
        win = state.window(f"{year}Q{quarter}")
        if win["found_post_id"] is None:
            win["found_post_id"] = post_id
    state.save()
    lines = process_post(post_id, acfg, state, orion, {**opts, "asset": asset, "post": post})
    status = state.get(post_id)["status"]
    ok = (status == "run_done" or (status == "doc_added" and opts.get("stop_after") == "doc-add")
          or (status == "transcribed" and opts.get("no_orion")))
    if not opts.get("dry_run"):
        append_log(base_dir, asset, {"at": utc_now_iso(), "asset": asset, "ingest": post_id, "status": status,
                                     "force": bool(opts.get("force")), "error": state.get(post_id).get("error")})
    alerts = [line for line in lines if line.startswith("ORION DISCLOSURE ALERT")]
    return (0 if ok else 1), alerts + [line for line in lines if not line.startswith("ORION DISCLOSURE ALERT")]


# ---------------------------------------------------------------- post-run step (spec 8.5)

def _num(x):
    return "none" if x is None else f"{x:.2f}"


def _effect_text(effect):
    if not effect:
        return "no target effect"
    if "blocked" in effect:
        return "effect blocked: " + "; ".join(clean_model_text(b, EVENT_CAP) for b in effect["blocked"])
    e12 = effect.get("12m") or {}
    return f"12m target {_num(e12.get('from'))} -> {_num(e12.get('to'))}"


def _fmt_tokens(n):
    return f"{n / 1000:.1f}k" if n < 10000 else f"{round(n / 1000)}k"


def _date(s):
    s = str(s or "")
    return s if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else clean_model_text(s, 10)


def _indent(s):
    """Model text for a queue list item: a line starting with '#' gets a backslash (it cannot open a markdown section),
    continuation lines are indented two blanks so they stay inside the item."""
    return "\n  ".join("\\" + line if line.startswith("#") else line for line in s.split("\n"))


def _queue_section(f, run_id, post_meta):
    asset = post_meta["asset"]
    cites = f.get("citations") or []
    quotes = "; ".join(f"\"{clean_model_text(c.get('quotedText'), QUOTE_CAP)}\" [{clean_model_text(c.get('locator'), 20)}]"
                       for c in cites) or "none"
    evidence = ", ".join(str(int(e)) if isinstance(e, (int, float)) else clean_model_text(e, 20)
                         for e in f.get("evidence") or [])
    keys = ", ".join(clean_model_text(k, WORD_CAP) for k in f.get("metricKeys") or [])
    today = post_meta["today"]
    return "\n".join([
        f"## {asset.upper()} — {clean_model_text(f.get('title'), TITLE_CAP)} (disclosure watcher, "
        f"{today.isoformat() if hasattr(today, 'isoformat') else today}, run #{run_id}, doc #{post_meta['doc_id']})",
        f"<!-- dw:fp={f['_fp']} -->",
        f"Source: {post_meta['url']} (posted {post_meta['posted']}), {doc_label(post_meta['kind'], post_meta.get('asr_model'))}."
        " Machine-written from the document by the analyst; verify before building.",
        f"- Category: {clean_model_text(f.get('category'), WORD_CAP)}; metrics: {keys}; a fix moves targets: "
        f"{clean_model_text(f.get('valueDirection'), WORD_CAP)}",
        f"- Claim: {_indent(clean_model_text(f.get('claim'), TEXT_CAP, keep_newlines=True))}",
        f"- Orion: {_indent(clean_model_text(f.get('orionReading'), TEXT_CAP, keep_newlines=True))}  "
        f"(evidence: observation ids {evidence or 'none'})",
        f"- Quotes: {quotes}",
        f"- Proposed fix: {_indent(clean_model_text(f.get('proposedFix'), FIX_CAP, keep_newlines=True))}",
    ]) + "\n"


def _fingerprint(f):
    """The finding's fingerprint (exactly 64 lowercase hex digits, Orion's sha256), or '' when it is anything else."""
    fp = f.get("fingerprint")
    return fp if isinstance(fp, str) and re.fullmatch(r"[0-9a-f]{64}", fp) else ""


def post_run(run_json, inbox_json, run_show_json, cfg, queue_path, post_meta):
    """Spec 8.5: append the run's new dev findings to queue_path (fingerprint dedupe) and return the digest text."""
    asset = post_meta["asset"]
    run = run_json.get("run") or {}
    run_id, doc_id = run.get("id"), post_meta["doc_id"]
    if post_meta["kind"] == "machine_transcript" and post_meta.get("duration_s"):
        what = f"machine transcript, {post_meta['duration_s'] / 60:.1f} min"
    else:
        what = post_meta["kind"].replace("_", " ")
    lines = [f"ORION DISCLOSURE {asset} | {post_meta['title']} | posted {post_meta['posted']} | doc #{doc_id} {what} | "
             f"{post_meta['url']}"]
    if run.get("outcome") != "completed":
        lines.append(f"analyst disclosure run #{run_id} ended {clean_model_text(run.get('outcome'), WORD_CAP)}: nothing "
                     f"filed; doc #{doc_id} is stored; retry: ingest --force")
        return "\n".join(lines)

    usage = run.get("usage") or {}
    tokens = sum(int(usage.get(k) or 0) for k in ("inputTokens", "cacheReadTokens", "cacheWriteTokens"))
    cost = (run_show_json or {}).get("estimated_cost_usd")
    cost = f"{cost:.2f}" if isinstance(cost, (int, float)) else "?"
    lines.append(f"analyst disclosure run #{run_id} completed | {int(usage.get('requests') or 0)} requests, "
                 f"{_fmt_tokens(tokens)} input | est ${cost}")

    committed = run_json.get("committed")
    staged = run_json.get("staged") or {}
    if committed:
        by_id = {p.get("id"): p for p in (inbox_json or {}).get("proposals") or []}
        parts = []
        for pid in committed.get("proposalIds") or []:
            p = by_id.get(pid)
            parts.append(f"#{pid} {clean_model_text(p.get('kind'), WORD_CAP)} ({_effect_text(p.get('effect'))})" if p
                         else f"#{pid} (not in the inbox)")
        lines.append("proposals: " + (", ".join(parts) + f" | decide from the next orion-{asset} DECISIONS block"
                                      if parts else "none"))
        findings = committed.get("devFindings") or []
    else:
        parts = [f"{clean_model_text((p.get('change') or {}).get('kind'), WORD_CAP)} ({_effect_text(p.get('effect'))})"
                 for p in staged.get("proposals") or []]
        note = "dry run: nothing filed" if run.get("dryRun") else "nothing committed: nothing filed"
        lines.append("proposals: " + (", ".join(parts) + f" | {note}" if parts else "none"))
        findings = staged.get("devFindings") or []

    queue_path = Path(queue_path)
    existing = queue_path.read_text(encoding="utf-8") if queue_path.exists() else ""
    known = set(re.findall(r"<!-- dw:fp=([0-9a-f]+) -->", existing))
    sections, skipped = [], 0
    for f in findings:
        f = {**f, "_fp": _fingerprint(f)}
        if not f["_fp"]:  # no dedupe key: never appended (it would be filed again on every re-run)
            skipped += 1
            continue
        if f["_fp"] in known:
            continue
        known.add(f["_fp"])
        sections.append(_queue_section(f, run_id, post_meta))
    if sections:
        prefix = "" if not existing or existing.endswith("\n\n") else ("\n" if existing.endswith("\n") else "\n\n")
        queue_path.parent.mkdir(parents=True, exist_ok=True)
        with open(queue_path, "a", encoding="utf-8") as fh:
            fh.write(prefix + "\n".join(sections))
    if findings:
        titles = " | ".join(f"[{clean_model_text(f.get('category'), WORD_CAP)}] {clean_model_text(f.get('title'), TITLE_CAP)}"
                            for f in findings)
        n, k = len(findings), len(sections)
        already = n - k - skipped
        if k == n:
            counts = f"{n}, added to {queue_path.name}"
        else:
            counts = f"{n}, {k} added to {queue_path.name}" + (f", {already} already there" if already else "") + (
                f", {skipped} skipped (no fingerprint)" if skipped else "")
        lines.append(f"dev findings ({counts}): {titles}")
    else:
        lines.append("dev findings: none")

    cats = []
    for c in (staged.get("journal") or {}).get("catalysts") or []:
        event = clean_model_text(c.get("event"), EVENT_CAP)
        if c.get("from") or c.get("to"):
            cats.append(f"{_date(c.get('from'))}..{_date(c.get('to'))} {event}")
        elif c.get("by"):
            cats.append(f"by {_date(c.get('by'))} {event}")
        else:
            cats.append(event)
    lines.append("catalysts: " + (" | ".join(cats) if cats else "none"))
    return "\n".join(lines)


# ---------------------------------------------------------------- status

def status_lines(cfg, base_dir, assets=None):
    lines = []
    for asset in cfg["assets"]:
        if assets and asset not in assets:
            continue
        state = State.load(Path(base_dir) / "state" / f"{asset}.json")
        counts = {}
        for rec in state.data["posts"].values():
            counts[rec["status"]] = counts.get(rec["status"], 0) + 1
        s = state.data["search"]
        lines.append(f"{asset}: posts " + (", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "none")
                     + f" | search last ok {s.get('last_ok_at') or 'never'}, "
                       f"{s.get('consecutive_failures', 0)} failed scan days running")
        for key, w in sorted(state.data["windows"].items()):
            lines.append(f"  window {key}: found {w.get('found_post_id') or 'none'}"
                         + (", closed reported" if w.get("closed_reported") else ""))
    return lines


# ---------------------------------------------------------------- cli

def main(argv=None):
    p = argparse.ArgumentParser(prog="disclosure_watch.py", description="Orion disclosure watcher (Hermes side)")
    p.add_argument("--config", default=str(DEFAULT_CONFIG))
    p.add_argument("--base-dir", default=str(BASE_DIR), help="holds state/ and log/ (default: the watcher dir)")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("scan", "status"):
        sp = sub.add_parser(name)
        sp.add_argument("--asset", action="append", help="limit to this asset (repeatable)")
        sp.add_argument("--config", default=argparse.SUPPRESS)
        sp.add_argument("--base-dir", default=argparse.SUPPRESS)
        if name == "scan":
            sp.add_argument("--orion-home", help="ORION_HOME for the Orion commands (default: $ORION_HOME, else the "
                                                 "release root)")
            sp.add_argument("--dry-run", action="store_true", help="pass --dry-run to agent run; state, log and "
                                                                   "transcripts stay unwritten (needs --queue-file "
                                                                   "and --orion-home)")
            sp.add_argument("--queue-file", help="the dev queue (default: $ORION_DW_QUEUE, else "
                                                 "<base-dir>/dev-queue.md)")
            sp.add_argument("--dry-state", help="with --dry-run: remember the posts a dry scan processed in this file, "
                                                "so each is reported once (the daemon passes it on staging)")
    ing = sub.add_parser("ingest")
    ing.add_argument("--asset", required=True)
    ing.add_argument("--url", required=True)
    ing.add_argument("--dry-run", action="store_true")
    ing.add_argument("--orion-home")
    ing.add_argument("--queue-file")
    ing.add_argument("--run-json", help="where the raw `agent run --json` result goes (default "
                                        "transcripts/<asset>/<post_id>.run.json; on a dry run, next to --queue-file)")
    ing.add_argument("--transcript")
    ing.add_argument("--force", action="store_true")
    ing.add_argument("--config", default=argparse.SUPPRESS)
    ing.add_argument("--base-dir", default=argparse.SUPPRESS)
    # Test-only flags (the smoke test of spec Task 12 step 4).
    ing.add_argument("--stop-after", choices=["doc-add"], help=argparse.SUPPRESS)
    ing.add_argument("--asr-seconds", type=int, help=argparse.SUPPRESS)
    ing.add_argument("--no-orion", action="store_true", help=argparse.SUPPRESS)
    args = p.parse_args(argv)

    cfg = load_config(args.config)
    if args.cmd == "status":
        print("\n".join(status_lines(cfg, args.base_dir, args.asset)))
        return 0
    if args.cmd == "ingest":
        started = time.monotonic()
        opts = {"base_dir": args.base_dir, "dry_run": args.dry_run, "queue_file": args.queue_file,
                "orion_home": args.orion_home, "run_json": args.run_json,
                "transcript": args.transcript, "force": args.force, "stop_after": args.stop_after,
                "asr_seconds": args.asr_seconds, "no_orion": args.no_orion}
        try:
            usage = ingest_usage_error(cfg, args.asset, args.url, opts)
            if usage:
                raise UsageError(usage)
            orion = None if args.no_orion else orion_for(args.orion_home)
        except UsageError as e:
            print(e, file=sys.stderr)
            return 2
        code, lines = ingest(cfg, args.asset, args.url, orion, {**opts, "http": UrllibHttp()})
        if lines:
            print("\n".join(lines), file=sys.stderr if code == 2 else sys.stdout)
        if args.no_orion:
            print(f"wall time {time.monotonic() - started:.1f} s")
        return code
    opts = {"dry_run": args.dry_run, "queue_file": args.queue_file, "orion_home": args.orion_home,
            "dry_state": args.dry_state}
    try:
        usage = dry_run_usage_error("scan", opts)
        if not usage and args.dry_state and not args.dry_run:
            usage = "disclosure_watch.py scan: --dry-state is for --dry-run scans only"
        if usage:
            raise UsageError(usage)
        orion = orion_for(args.orion_home)
    except UsageError as e:
        print(e, file=sys.stderr)
        return 2
    lines = run_scan(cfg, args.base_dir, UrllibHttp(), get_today(), assets=args.asset, opts={**opts, "orion": orion})
    if lines:
        print("\n".join(lines))
    return 0


def orion_for(orion_home):
    """The real Orion driver: the release root $ORION_DW_REPO (required: UsageError when unset), home --orion-home,
    else $ORION_HOME, else the release root."""
    repo = os.environ.get("ORION_DW_REPO", "").strip()
    if not repo:
        raise UsageError(f"disclosure_watch.py: {REPO_REQUIRED}")
    home = orion_home or os.environ.get("ORION_HOME", "").strip() or repo
    return OrionCli(Path(repo), Path(home))


if __name__ == "__main__":
    sys.exit(main())
