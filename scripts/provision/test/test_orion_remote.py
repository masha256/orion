"""Unit tests for scripts/provision/files/orion-remote (plan 1.5c Task 14).

Run: python3 -m unittest discover -s scripts/provision/test -p 'test_orion_remote.py'

Each test runs orion-remote as a subprocess the way sshd would (SSH_ORIGINAL_COMMAND, a clean environment) with
ORION_REMOTE_TEST=1, which lets a non-root caller point it at a temp HOME, a pretend Unix user and a directory of fake
tools (node, npm, psql, pg_dump, pg_isready, systemctl). Each fake appends what it was called with to calls.jsonl and
answers from behaviour.json. A "marker" fake for sh/bash/id/rm/touch on the PATH proves no caller text reached a shell.
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

sys.dont_write_bytecode = True  # never a __pycache__ beside orion-remote (pack.sh ships scripts/provision/)
HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE = os.path.join(os.path.dirname(HERE), 'files', 'orion-remote')

FAKE = r'''#!{python} -I
import datetime, json, os, sys
STATE = {state!r}
tool = os.path.basename(sys.argv[0])
args = sys.argv[1:]
home = os.environ.get('HOME', '')
cur = os.path.join(home, 'current')
rec = {{
    'tool': tool, 'argv': args, 'cwd': os.getcwd(),
    'current': os.readlink(cur) if os.path.islink(cur) else None,
    'env': dict(os.environ),
}}
with open(os.path.join(STATE, 'calls.jsonl'), 'a') as f:
    f.write(json.dumps(rec) + '\n')
try:
    with open(os.path.join(STATE, 'behaviour.json')) as f:
        b = json.load(f)
except FileNotFoundError:
    b = {{}}
def out(obj, code=0):
    print(json.dumps(obj))
    sys.exit(code)
def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
running_file = os.path.join(STATE, 'running_tag')
if tool == 'node':
    script, rest = args[0], args[1:]
    tag = script.split('/releases/')[1].split('/')[0] if '/releases/' in script else None
    cmd = ' '.join(rest[:2])
    if cmd == 'daemon drain':
        if b.get('drain') == 'no_daemon':
            out({{'error': {{'code': 'no_daemon', 'message': 'no daemon is running'}}}}, 1)
        out({{'daemonId': 'd1', 'state': 'drained'}})
    if cmd == 'daemon undrain':
        out({{'cleared': 1}})
    if cmd == 'db status':
        out(b.get('db_status', {{'dbAt': 2, 'codeRequires': 2, 'pending': [], 'state': 'current'}}))
    if cmd == 'db migrate':
        if b.get('migrate_fail'):
            out({{'error': {{'code': 'migration_failed', 'message': 'boom'}}}}, 1)
        out({{'applied': b.get('applied', []), 'status': {{}}}})
    if cmd == 'daemon status':
        running = open(running_file).read().strip() if os.path.exists(running_file) else None
        if b.get('never_up'):
            running = 'orion-1999.01.01.1'
        out({{'env': 'x', 'heartbeat': {{'releaseTag': running, 'beatAt': now(), 'state': 'running'}}}})
    if cmd == 'asset validate':
        out({{'ok': b.get('validate_ok', True)}}, 0 if b.get('validate_ok', True) else 1)
    if rest[:3] == ['asset', 'registry', 'diff']:
        out(b.get('diff', {{'added': [], 'missing': [], 'returned': [], 'configChanged': []}}))
    if rest[:3] == ['asset', 'registry', 'reconcile']:
        out(b.get('diff', {{'added': [], 'missing': [], 'returned': [], 'configChanged': []}}))
    if rest[:2] == ['asset', 'registry']:
        out([])
    out({{'tag': tag, 'argv': rest}}, b.get('node_exit', 0))
if tool == 'npm':
    sys.exit(b.get('npm_exit', 0))
if tool == 'systemctl':
    if 'restart' in args and os.path.islink(cur):
        with open(running_file, 'w') as f:
            f.write(os.path.basename(os.readlink(cur)))
    sys.exit(0)
if tool == 'pg_dump':
    path = args[args.index('-f') + 1]
    with open(path, 'wb') as f:
        f.write(b'PGDMP')
    sys.exit(b.get('pg_dump_exit', 0))
if tool == 'psql':
    n = b.get('psql_bytes')
    sys.stdout.write('x' * n if n else ' ?column? \n----------\n        1\n(1 row)\n')
    sys.exit(0)
if tool == 'pg_isready':
    sys.exit(0)
sys.exit(0)
'''

MARKER = '#!/bin/sh\necho evaluated >"{marker}"\n'

TAG = 'orion-2026.11.02.1'
TAG2 = 'orion-2026.11.03.1'


def tarball(tag, extra=None, top=None):
    """A release tarball as pack.sh lays it out (top dir <tag>/), as bytes."""
    buf = io.BytesIO()
    top = tag if top is None else top
    files = {
        'RELEASE': json.dumps({'tag': tag, 'commit': 'c' * 40, 'schema': 2, 'built_at': '2026-11-02T10:00:00Z', 'node': 'v26.7.0'}),
        'dist/cli/index.js': 'console.log(1);\n',
        'package.json': '{}\n',
        'package-lock.json': '{}\n',
    }
    files.update(extra or {})
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        for rel, text in sorted(files.items()):
            data = text.encode()
            info = tarfile.TarInfo(f'{top}/{rel}')
            info.size = len(data)
            info.mtime = 1_700_000_000
            t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class RemoteCase(unittest.TestCase):
    user = 'orion-prod'

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='orion-remote-test-')
        self.home = os.path.join(self.tmp, 'home')
        self.bin = os.path.join(self.tmp, 'bin')
        self.state = os.path.join(self.tmp, 'state')
        self.decoys = os.path.join(self.tmp, 'decoys')
        self.marker = os.path.join(self.tmp, 'PWNED')
        for d in (self.home, self.bin, self.state, self.decoys, os.path.join(self.home, 'home'), os.path.join(self.home, 'shared')):
            os.makedirs(d)
        with open(os.path.join(self.home, 'shared', '.env'), 'w') as f:
            f.write('SLACK_WEBHOOK_URL=https://hooks.example.test/SECRET-TOKEN\n')
        fake = FAKE.format(python=sys.executable, state=self.state)
        for tool in ('node', 'npm', 'psql', 'pg_dump', 'pg_isready', 'systemctl'):
            path = os.path.join(self.bin, tool)
            with open(path, 'w') as f:
                f.write(fake)
            os.chmod(path, 0o755)
        for c in ('sh', 'bash', 'id', 'rm', 'touch'):
            path = os.path.join(self.decoys, c)
            with open(path, 'w') as f:
                f.write(MARKER.format(marker=self.marker))
            os.chmod(path, 0o755)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers ------------------------------------------------------------------------------------------------------

    def behave(self, **b):
        with open(os.path.join(self.state, 'behaviour.json'), 'w') as f:
            json.dump(b, f)

    def release(self, tag, current=False):
        root = os.path.join(self.home, 'releases', tag)
        os.makedirs(os.path.join(root, 'dist', 'cli'), exist_ok=True)
        with open(os.path.join(root, 'RELEASE'), 'w') as f:
            json.dump({'tag': tag, 'commit': 'c' * 40, 'schema': 2, 'built_at': '2026-11-02T10:00:00Z'}, f)
        if current:
            link = os.path.join(self.home, 'current')
            if os.path.lexists(link):
                os.unlink(link)
            os.symlink(f'releases/{tag}', link)
            with open(os.path.join(self.state, 'running_tag'), 'w') as f:
                f.write(tag)
        return root

    def remote(self, command, stdin=b'', user=None, extra_env=None):
        env = {
            'ORION_REMOTE_TEST': '1',
            'ORION_REMOTE_TEST_USER': user or self.user,
            'ORION_REMOTE_TEST_BIN': self.bin,
            'ORION_REMOTE_TEST_POLL': '0.05',
            'ORION_REMOTE_TEST_HEARTBEAT_TIMEOUT': '1',
            'HOME': self.home,
            'PATH': f'{self.decoys}:/usr/bin:/bin',
            'SSH_CLIENT': '192.168.0.201 50000 22',
        }
        if command is not None:
            env['SSH_ORIGINAL_COMMAND'] = command
        env.update(extra_env or {})
        r = subprocess.run([sys.executable, '-I', REMOTE], input=stdin, env=env, capture_output=True, timeout=60)
        return r.returncode, r.stdout.decode(), r.stderr.decode()

    def calls(self, tool=None):
        path = os.path.join(self.state, 'calls.jsonl')
        if not os.path.exists(path):
            return []
        with open(path) as f:
            rows = [json.loads(line) for line in f]
        return [r for r in rows if tool is None or r['tool'] == tool]

    def node_argv(self):
        """The Orion argv of every node call (the script path dropped)."""
        return [c['argv'][1:] for c in self.calls('node')]

    def log_lines(self):
        path = os.path.join(self.home, 'remote.log')
        with open(path) as f:
            return f.read().splitlines()

    def deploys(self):
        path = os.path.join(self.home, 'deploys.log')
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return f.read().splitlines()

    def current(self):
        return os.readlink(os.path.join(self.home, 'current'))

    def install(self, tag, data, sha=None):
        return self.remote(f'install {tag} {sha or hashlib.sha256(data).hexdigest()}', stdin=data)


class InjectionTests(RemoteCase):
    def test_injection_attempts_are_literal_or_refused(self):
        self.release(TAG, current=True)
        # Quoted text is one literal argv element: nothing expanded.
        rc, _out, _err = self.remote("ack 7 '$(id)'")
        self.assertEqual(rc, 0)
        self.assertEqual(self.node_argv()[-1], ['data', 'ack', '7', '--note', '$(id)', '--json'])
        rc, _out, _err = self.remote('resolve 8 "`id` and $HOME; rm -rf ~"')
        self.assertEqual(rc, 0)
        self.assertEqual(self.node_argv()[-1], ['data', 'resolve', '8', '--note', '`id` and $HOME; rm -rf ~', '--json'])
        # A newline inside quotes stays inside the one note.
        rc, _out, _err = self.remote('approve 7 "two\nlines"')
        self.assertEqual(rc, 0)
        self.assertEqual(self.node_argv()[-1], ['proposals', 'approve', '7', '--note', 'two\nlines', '--json'])
        n = len(self.calls())
        refused = [
            'status; rm -rf ~',
            'status && touch x',
            'status | id',
            'status >/tmp/x',
            '$(id)',
            '`id`',
            "ack 7 'unclosed",
            'ack 7 "unclosed',
            'status\nid',
            'status\\\nid',
            'install x',
            f'install {TAG}',
            'ack 7',
            'ack 1e3 note',
            'ack -7 note',
            'ack 7 note extra',
            'ack 7 --json',
            'status --bogus',
            'logs 5000',
            '*',
            '',
        ]
        for cmd in refused:
            rc, _out, err = self.remote(cmd)
            self.assertEqual(rc, 64, f'{cmd!r}: {err}')
            self.assertTrue(err.startswith('orion-remote: '), f'{cmd!r}: {err}')
        self.assertEqual(len(self.calls()), n, 'a refused command ran something')
        rc, _out, err = self.remote(None)  # no SSH_ORIGINAL_COMMAND at all (an interactive login)
        self.assertEqual(rc, 64)
        rc, _out, err = self.remote('bogus')
        self.assertEqual(rc, 64)
        self.assertIn("orion-remote: 'bogus' is not an allowed verb", err)
        rc, _out, err = self.remote('ack 7')
        self.assertIn('note required', err)
        # sql-ro is prod-only.
        rc, _out, err = self.remote("sql-ro 'select 1'", user='orion-stage')
        self.assertEqual(rc, 64)
        self.assertIn('sql-ro is prod-only: staging has no read-only role', err)
        self.assertEqual(self.calls('psql'), [])
        self.assertFalse(os.path.exists(self.marker), 'caller text reached a shell')

        # remote.log: one line per call, no argument text, no control characters.
        lines = self.log_lines()
        self.assertEqual(len(lines), 3 + len(refused) + 4)
        text = '\n'.join(lines)
        for leak in ('$(id)', '`id`', 'rm -rf', 'two', 'lines', 'select 1', 'unclosed', 'bogus', '/tmp/x', 'extra'):
            self.assertNotIn(leak, text)
        for line in lines:
            parts = line.split(' ')
            self.assertRegex(parts[0], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
            self.assertIn(parts[1], ('orion-prod', 'orion-stage'))
            self.assertRegex(' '.join(parts[2:]), r'^\S+ \d+ (ok|refused|exit \d+)$')
            self.assertTrue(all(ord(ch) >= 32 for ch in line))
        self.assertEqual(lines[0].split(' ')[2:], ['ack', '3', 'ok'])
        self.assertEqual(lines[-1].split(' ')[2:], ['sql-ro', '2', 'refused'])

    def test_unknown_unix_user_exits_64(self):
        rc, _out, err = self.remote('status', user='hermes')
        self.assertEqual(rc, 64)
        self.assertIn('not an Orion user', err)
        self.assertEqual(self.calls(), [])

    def test_child_env_is_clean_and_env_file_never_read(self):
        self.release(TAG, current=True)
        rc, out, _err = self.remote('status --json', extra_env={'SECRET_FROM_CALLER': 'x', 'NODE_OPTIONS': '--require /tmp/evil.js'})
        self.assertEqual(rc, 0)
        self.assertNotIn('SECRET-TOKEN', out)
        call = self.calls('node')[-1]
        env = call['env']
        self.assertEqual(env['ORION_ENV'], 'prod')
        self.assertEqual(env['ORION_HOME'], os.path.join(self.home, 'home'))
        self.assertEqual(env['ORION_ENV_FILE'], os.path.join(self.home, 'shared', '.env'))
        self.assertEqual(env['PATH'], '/usr/bin:/bin')
        self.assertEqual(env['HOME'], self.home)
        self.assertEqual(env['XDG_RUNTIME_DIR'], f'/run/user/{os.getuid()}')
        self.assertNotIn('SECRET_FROM_CALLER', env)
        self.assertNotIn('NODE_OPTIONS', env)
        self.assertNotIn('SSH_ORIGINAL_COMMAND', env)
        self.assertEqual(call['argv'][0], os.path.join(self.home, 'current', 'dist', 'cli', 'index.js'))
        self.assertEqual(call['argv'][1:], ['daemon', 'status', '--json'])


class InstallTests(RemoteCase):
    def test_install_verifies_sha_and_caps_size(self):
        data = tarball(TAG)
        # A wrong sha256: nothing is unpacked, the upload is not kept.
        rc, _out, err = self.install(TAG, data, sha='0' * 64)
        self.assertEqual(rc, 1)
        self.assertIn('sha256 mismatch', err)
        self.assertFalse(os.path.exists(os.path.join(self.home, 'releases', TAG)))
        self.assertEqual(os.listdir(os.path.join(self.home, 'incoming')), [])
        # Over the cap: refused while reading, nothing kept.
        big = data + b'\0' * 2048
        rc, _out, err = self.remote(f'install {TAG} {hashlib.sha256(big).hexdigest()}', stdin=big,
                                    extra_env={'ORION_REMOTE_TEST_MAX_BYTES': str(len(data) + 1024)})
        self.assertEqual(rc, 1)
        self.assertIn('larger than', err)
        self.assertEqual(os.listdir(os.path.join(self.home, 'incoming')), [])
        self.assertEqual(self.calls(), [])
        # A bad sha256 or tag is a usage error.
        for cmd in (f'install {TAG} xyz', f'install orion-2026.11.02 {"a" * 64}', f'install ../x {"a" * 64}'):
            self.assertEqual(self.remote(cmd, stdin=data)[0], 64, cmd)
        # A tarball whose top directory is not the tag, or that escapes it, is refused.
        for bad in (tarball(TAG, top='other'), tarball(TAG, extra={'../../evil': 'x'})):
            rc, _out, err = self.install(TAG, bad)
            self.assertEqual(rc, 1, err)
            self.assertFalse(os.path.exists(os.path.join(self.home, 'releases', TAG)))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'evil')))
        # The real thing: unpacked, npm ci, the three checks, one JSON object.
        self.release(TAG2)  # an older current, so prune has something to protect
        rc, out, err = self.install(TAG, data)
        self.assertEqual(rc, 0, err)
        result = json.loads(out)
        self.assertEqual(sorted(result), ['db', 'registry', 'release', 'tag', 'validate'])
        self.assertEqual(result['tag'], TAG)
        self.assertEqual(result['release']['tag'], TAG)
        self.assertEqual(result['validate'], {'ok': True})
        self.assertEqual(result['db']['state'], 'current')
        root = os.path.join(self.home, 'releases', TAG)
        self.assertTrue(os.path.isfile(os.path.join(root, 'dist', 'cli', 'index.js')))
        npm = self.calls('npm')
        self.assertEqual(len(npm), 1)
        self.assertEqual(npm[0]['argv'], ['ci', '--omit=dev', '--ignore-scripts'])
        self.assertEqual(npm[0]['cwd'], root)
        self.assertEqual(self.node_argv(), [['asset', 'validate', '--json'], ['db', 'status', '--json'], ['asset', 'registry', 'diff', '--json']])
        self.assertTrue(all(c['argv'][0] == os.path.join(root, 'dist', 'cli', 'index.js') for c in self.calls('node')))
        self.assertEqual(os.listdir(os.path.join(self.home, 'incoming')), [])

    def test_install_refuses_existing_release(self):
        self.release(TAG)
        data = tarball(TAG)
        rc, _out, err = self.install(TAG, data)
        self.assertEqual(rc, 1)
        self.assertIn('already installed', err)
        self.assertEqual(self.calls(), [])

    def test_install_failed_checks_remove_the_release(self):
        self.behave(npm_exit=1)
        rc, _out, err = self.install(TAG, tarball(TAG))
        self.assertEqual(rc, 1)
        self.assertIn('npm ci', err)
        self.assertFalse(os.path.exists(os.path.join(self.home, 'releases', TAG)))
        self.behave(validate_ok=False)
        rc, out, _err = self.install(TAG, tarball(TAG))
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(out)['validate'], {'ok': False})
        self.assertFalse(os.path.exists(os.path.join(self.home, 'releases', TAG)))

    def test_install_prunes_beyond_five_never_current_or_its_predecessor(self):
        tags = [f'orion-2026.10.{d:02d}.1' for d in range(1, 9)]
        for t in tags:
            self.release(t)
        self.release(tags[0], current=True)  # the oldest is current
        with open(os.path.join(self.home, 'deploys.log'), 'w') as f:
            f.write(f'2026-10-01T00:00:00Z switch {tags[1]} -> {tags[0]} migrations=none\n')
        rc, _out, err = self.install(TAG, tarball(TAG))
        self.assertEqual(rc, 0, err)
        left = sorted(os.listdir(os.path.join(self.home, 'releases')))
        self.assertEqual(left, sorted([tags[0], tags[1]] + tags[4:] + [TAG]))


class SwitchTests(RemoteCase):
    def setUp(self):
        super().setUp()
        self.release(TAG, current=True)
        self.release(TAG2)

    def tools(self):
        return [(c['tool'], c['argv'][1:3] if c['tool'] == 'node' else c['argv'][:2], c['current']) for c in self.calls()]

    def test_switch_order(self):
        self.behave(applied=[3])
        rc, out, err = self.remote(f'switch {TAG2}')
        self.assertEqual(rc, 0, err)
        old, new = f'releases/{TAG}', f'releases/{TAG2}'
        seq = self.tools()
        self.assertEqual(seq[:5], [
            ('node', ['daemon', 'drain'], old),
            ('node', ['db', 'status'], old),
            ('node', ['db', 'migrate'], old),
            ('systemctl', ['--user', 'restart'], new),  # the symlink was swapped before the restart
            ('node', ['daemon', 'status'], new),
        ])
        calls = self.calls('node')
        self.assertEqual(calls[0]['argv'][0], os.path.join(self.home, 'current', 'dist', 'cli', 'index.js'))  # drain: current
        self.assertEqual(calls[0]['argv'][1:], ['daemon', 'drain', '--wait', '30m', '--json'])
        new_cli = os.path.join(self.home, 'releases', TAG2, 'dist', 'cli', 'index.js')
        self.assertEqual(calls[1]['argv'][0], new_cli)  # db status and migrate: the new release
        self.assertEqual(calls[2]['argv'], [new_cli, 'db', 'migrate', '--json'])
        self.assertEqual(self.calls('systemctl')[0]['argv'], ['--user', 'restart', 'orion-daemon'])
        self.assertEqual(self.current(), new)
        self.assertFalse(os.path.lexists(os.path.join(self.home, 'current.tmp')))
        log = self.deploys()
        self.assertEqual(len(log), 1)
        self.assertRegex(log[0], rf'^\d{{4}}-\d{{2}}-\d{{2}}T\d{{2}}:\d{{2}}:\d{{2}}Z switch {TAG} -> {TAG2} migrations=3$')
        result = json.loads(out)
        self.assertEqual(result['from'], TAG)
        self.assertEqual(result['to'], TAG2)
        self.assertEqual(result['migrations'], [3])
        self.assertIn('registry', result)
        self.assertIn('next', result)
        self.assertEqual(self.calls('pg_dump'), [])

    def test_switch_migrate_failure_undrains_and_keeps_current(self):
        self.behave(migrate_fail=True)
        rc, _out, err = self.remote(f'switch {TAG2}')
        self.assertEqual(rc, 1)
        self.assertIn('db migrate', err)
        self.assertEqual(self.current(), f'releases/{TAG}')
        self.assertEqual(self.node_argv()[-1], ['daemon', 'undrain', '--json'])
        self.assertEqual(self.calls('node')[-1]['argv'][0], os.path.join(self.home, 'current', 'dist', 'cli', 'index.js'))
        self.assertEqual(self.calls('systemctl'), [])
        self.assertEqual(self.deploys(), [])

    def test_switch_refuses_breaking_without_flag(self):
        self.behave(db_status={'dbAt': 2, 'codeRequires': 3, 'pending': [{'id': 3, 'name': 'drop_x', 'breaking': True}], 'state': 'behind'})
        rc, _out, err = self.remote(f'switch {TAG2}')
        self.assertEqual(rc, 1)
        self.assertIn('--breaking', err)
        self.assertEqual([a[:2] for a in self.node_argv()], [['daemon', 'drain'], ['db', 'status'], ['daemon', 'undrain']])
        self.assertEqual(self.current(), f'releases/{TAG}')
        self.assertEqual(self.calls('pg_dump'), [])

    def test_switch_breaking_dumps_first(self):
        self.behave(db_status={'dbAt': 2, 'codeRequires': 3, 'pending': [{'id': 3, 'name': 'drop_x', 'breaking': True}], 'state': 'behind'}, applied=[3])
        rc, _out, err = self.remote(f'switch {TAG2} --breaking')
        self.assertEqual(rc, 0, err)
        order = [c['tool'] + (':' + ' '.join(c['argv'][1:3]) if c['tool'] == 'node' else '') for c in self.calls()]
        self.assertEqual(order[:4], ['node:daemon drain', 'node:db status', 'pg_dump', 'node:db migrate'])
        dump = self.calls('pg_dump')[0]['argv']
        self.assertEqual(dump[:5], ['-Fc', '-U', 'orion_prod', '-d', 'orion_prod'])
        path = dump[dump.index('-f') + 1]
        self.assertTrue(path.startswith(os.path.join(self.home, 'shared', 'predeploy', f'{TAG2}-')))
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(self.node_argv()[2], ['db', 'migrate', '--breaking', '--json'])

    def test_switch_heartbeat_timeout_exits_1_with_rollback_hint(self):
        self.behave(never_up=True)
        rc, _out, err = self.remote(f'switch {TAG2}')
        self.assertEqual(rc, 1)
        self.assertIn('orion-remote rollback', err)
        self.assertEqual(self.current(), f'releases/{TAG2}')  # repointed: rollback needs the log line
        self.assertEqual(len(self.deploys()), 1)

    def test_switch_first_deploy_and_bad_targets(self):
        self.assertEqual(self.remote(f'switch {TAG}')[0], 1)  # already current
        self.assertEqual(self.remote('switch orion-2026.12.01.1')[0], 1)  # not installed
        self.assertEqual(self.remote(f'switch {TAG2} --force')[0], 64)
        self.assertEqual(self.calls(), [])
        # No current yet (the first deploy): no drain, still migrate/restart/poll.
        os.unlink(os.path.join(self.home, 'current'))
        self.behave(drain='no_daemon')
        rc, out, err = self.remote(f'switch {TAG2}')
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)['from'], None)
        self.assertRegex(self.deploys()[0], rf'switch none -> {TAG2} migrations=none$')


class RollbackTests(RemoteCase):
    def test_rollback_targets_previous_release(self):
        self.release(TAG, current=True)
        self.release(TAG2)
        rc, _out, err = self.remote(f'switch {TAG2}')
        self.assertEqual(rc, 0, err)
        n = len(self.calls())
        rc, out, err = self.remote('rollback')
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.current(), f'releases/{TAG}')
        seq = [c['tool'] + (':' + ' '.join(c['argv'][1:3]) if c['tool'] == 'node' else '') for c in self.calls()[n:]]
        self.assertEqual(seq[:3], ['node:daemon drain', 'systemctl', 'node:daemon status'])
        self.assertNotIn('node:db migrate', seq)
        log = self.deploys()
        self.assertEqual(len(log), 2)
        self.assertRegex(log[1], rf'^\S+ rollback {TAG2} -> {TAG}$')
        self.assertEqual(json.loads(out)['to'], TAG)
        # Nothing to roll back to: refused.
        self.assertEqual(self.remote('rollback extra')[0], 64)

    def test_rollback_without_a_switch_is_refused(self):
        self.release(TAG, current=True)
        rc, _out, err = self.remote('rollback')
        self.assertEqual(rc, 1)
        self.assertIn('no switch', err)
        self.assertEqual(self.calls(), [])


class VerbTests(RemoteCase):
    def setUp(self):
        super().setUp()
        self.release(TAG, current=True)

    def last(self, cmd, user=None):
        rc, out, err = self.remote(cmd, user=user)
        self.assertEqual(rc, 0, f'{cmd}: {err}')
        return self.node_argv()[-1]

    def test_registry_verbs_compose_by(self):
        self.assertEqual(self.last("asset pause aero --reason 'merger' --for mike"),
                         ['asset', 'pause', 'aero', '--reason', 'merger', '--by', 'mike via raymond'])
        self.assertEqual(self.last('asset resume aero'), ['asset', 'resume', 'aero', '--by', 'raymond'])
        self.assertEqual(self.last('asset activate new-coin --for mike'), ['asset', 'activate', 'new-coin', '--by', 'mike via raymond'])
        self.assertEqual(self.last('asset registry'), ['asset', 'registry', '--json'])
        self.assertEqual(self.last('asset registry diff'), ['asset', 'registry', 'diff', '--json'])
        n = len(self.calls())
        for cmd in ('asset pause aero', 'asset pause --reason x', 'asset pause AERO --reason x', 'asset activate', 'asset resume',
                    "asset pause aero --reason 'x' --for 'mike; id'", 'asset pause aero --reason x --by mike', 'asset seed --all',
                    'asset pause aero --reason --for', 'asset resume aero --reason x'):
            self.assertEqual(self.remote(cmd)[0], 64, cmd)
        self.assertEqual(len(self.calls()), n)

    def test_decision_verbs(self):
        self.assertEqual(self.last('confirm 12'), ['data', 'confirm', '12', '--json'])
        self.assertEqual(self.last('reject 12'), ['data', 'reject', '12', '--json'])
        self.assertEqual(self.last('approve 5'), ['proposals', 'approve', '5', '--json'])
        self.assertEqual(self.last("approve 5 'looks right'"), ['proposals', 'approve', '5', '--note', 'looks right', '--json'])
        self.assertEqual(self.last("decline 5 'not sourced'"), ['proposals', 'reject', '5', '--note', 'not sourced', '--json'])
        self.assertEqual(self.last("ack 9 'known'"), ['data', 'ack', '9', '--note', 'known', '--json'])
        self.assertEqual(self.last("resolve 9 'fixed'"), ['data', 'resolve', '9', '--note', 'fixed', '--json'])
        for cmd in ('decline 5', "decline 5 ''", 'confirm', 'confirm 1234567890123', 'confirm 1 2', "ack 9 '--json'"):
            rc, _out, err = self.remote(cmd)
            self.assertEqual(rc, 64, cmd)
        self.assertIn('note required', self.remote('decline 5')[2])

    def test_read_only_verbs(self):
        cases = {
            'status --json': ['daemon', 'status', '--json'],
            'jobs': ['job', 'list', '--json'],
            'jobs --since 2026-11-01T00:00:00Z': ['job', 'list', '--json', '--since', '2026-11-01T00:00:00Z'],
            'report yield': ['report', 'yield', '--json'],
            'report yield aero --day 2026-11-01': ['report', 'yield', 'aero', '--day', '2026-11-01', '--json'],
            'data anomalies': ['data', 'anomalies', '--json'],
            'data anomalies aero --all': ['data', 'anomalies', 'aero', '--all', '--json'],
            'data sources aero': ['data', 'sources', 'aero', '--json'],
            'data show aero': ['data', 'show', 'aero', '--json'],
            'data show aero price_usd': ['data', 'show', 'aero', 'price_usd', '--json'],
            'proposals list': ['proposals', 'list', '--json'],
            'proposals list aero --all': ['proposals', 'list', 'aero', '--all', '--json'],
            'agent runs list': ['agent', 'runs', 'list', '--json'],
            'agent runs list aero': ['agent', 'runs', 'list', 'aero', '--json'],
            'inbox aero': ['inbox', 'aero', '--json'],
            'job run-now refresh aero': ['job', 'run-now', 'refresh', 'aero', '--by', 'raymond', '--json'],
            'job run-now levels': ['job', 'run-now', 'levels', '--by', 'raymond', '--json'],
        }
        for cmd, argv in cases.items():
            self.assertEqual(self.last(cmd), argv, cmd)
        n = len(self.calls())
        for cmd in ('data set aero price_usd 1', 'data fetch aero', 'data show', 'inbox', 'report growth aero', 'jobs --since yesterday',
                    'job run-now bogus', 'job run-now staging_refresh x;y', 'job list', 'agent run aero', 'proposals show 1',
                    'report yield aero --day 2026-1-1', 'db migrate', 'daemon drain'):
            self.assertEqual(self.remote(cmd)[0], 64, cmd)
        self.assertEqual(len(self.calls()), n)

    def test_status_text_has_the_env_header(self):
        rc, out, _err = self.remote('status')
        self.assertEqual(rc, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], 'env: prod')
        self.assertTrue(lines[1].startswith('host: '))
        self.assertEqual(lines[2], f'current: releases/{TAG}')
        self.assertEqual(lines[3], 'postgres: accepting connections')
        self.assertEqual(self.node_argv()[-1], ['daemon', 'status'])
        # No release yet: the header, and no daemon call.
        os.unlink(os.path.join(self.home, 'current'))
        n = len(self.calls('node'))
        rc, out, _err = self.remote('status')
        self.assertEqual(rc, 0)
        self.assertIn('current: none', out)
        self.assertEqual(len(self.calls('node')), n)

    def test_logs_and_dev_queue_tail_files(self):
        log = os.path.join(self.home, 'home', 'daemon.log')
        with open(log, 'w') as f:
            f.write(''.join(f'line {i}\n' for i in range(3000)))
        rc, out, _err = self.remote('logs')
        self.assertEqual(rc, 0)
        self.assertEqual(out.splitlines(), [f'line {i}' for i in range(2800, 3000)])
        rc, out, _err = self.remote('logs 2000')
        self.assertEqual(len(out.splitlines()), 2000)
        self.assertEqual(self.remote('logs 2001')[0], 64)
        self.assertEqual(self.remote('logs 0')[0], 64)
        os.makedirs(os.path.join(self.home, 'home', 'disclosure'))
        with open(os.path.join(self.home, 'home', 'disclosure', 'dev-queue.md'), 'w') as f:
            f.write('# queue\n- a\n- b\n')
        rc, out, _err = self.remote('dev-queue 2')
        self.assertEqual((rc, out), (0, '- a\n- b\n'))
        self.assertEqual(self.calls('node'), [])

    def test_sql_ro_prod_only_and_capped(self):
        rc, out, _err = self.remote("sql-ro 'select 1'")
        self.assertEqual(rc, 0)
        self.assertIn('(1 row)', out)
        psql = self.calls('psql')[0]['argv']
        self.assertEqual(psql, ['-X', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-U', 'orion_prod_ro', '-d', 'orion_prod', '-c', 'select 1'])
        self.behave(psql_bytes=1024 * 1024 + 500)
        rc, out, err = self.remote("sql-ro 'select repeat(1)'")
        self.assertEqual(len(out.encode()), 1024 * 1024)
        self.assertIn('truncated at 1 MB', err)
        self.assertEqual(self.remote('sql-ro')[0], 64)
        self.assertEqual(self.remote("sql-ro 'select 1' 'select 2'")[0], 64)

    def test_refresh_staging_stage_only(self):
        self.assertEqual(self.last('refresh-staging', user='orion-stage'), ['job', 'run-now', 'staging_refresh', '--by', 'raymond', '--json'])
        self.assertEqual(self.calls('node')[-1]['env']['ORION_ENV'], 'stage')
        rc, _out, err = self.remote('refresh-staging')
        self.assertEqual(rc, 64)
        self.assertIn('stage-only', err)

    def test_reconcile_allow_retire_needs_yes_and_prints_the_diff_first(self):
        self.behave(diff={'added': [], 'missing': ['aero', 'cake', 'crv'], 'returned': [], 'configChanged': []})
        rc, out, err = self.remote('reconcile --allow-retire')
        self.assertEqual(rc, 1)
        self.assertIn('--yes', err)
        self.assertEqual(json.loads(out)['missing'], ['aero', 'cake', 'crv'])
        self.assertEqual(self.node_argv(), [['asset', 'registry', 'diff', '--json']])
        rc, out, err = self.remote('reconcile --allow-retire --yes')
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.node_argv()[-2:], [['asset', 'registry', 'diff', '--json'], ['asset', 'registry', 'reconcile', '--allow-retire', '--json']])
        for cmd in ('reconcile', 'reconcile --yes', 'reconcile --allow-retire --yes --force'):
            self.assertEqual(self.remote(cmd)[0], 64, cmd)

    def test_exit_code_is_the_childs(self):
        self.behave(node_exit=3)
        rc, _out, _err = self.remote('inbox aero')
        self.assertEqual(rc, 3)
        self.assertEqual(self.log_lines()[-1].split(' ', 2)[2], 'inbox 2 exit 3')


class StaticTests(unittest.TestCase):
    def test_split_refuses_nul_and_bare_control_characters(self):
        # sshd cannot pass a NUL through the environment; the check still holds when one is handed in.
        import importlib.machinery
        import importlib.util
        loader = importlib.machinery.SourceFileLoader('orion_remote', REMOTE)
        spec = importlib.util.spec_from_loader('orion_remote', loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        for raw in ('confirm 7\x00', 'status\rid', 'status\x1b[2J', 'ack 7 x\x7f'):
            with self.assertRaises(mod.Refused, msg=repr(raw)):
                mod.split_command(raw)
        self.assertEqual(mod.split_command("ack 7 'a\tb\nc'"), ['ack', '7', 'a\tb\nc'])
        self.assertEqual(mod.split_command('ack\t7  x'), ['ack', '7', 'x'])

    def test_source_never_uses_a_shell(self):
        with open(REMOTE) as f:
            src = f.read()
        self.assertTrue(src.startswith('#!/usr/bin/python3 -I\n'))
        for bad in ('shell=True', 'os.system', 'os.popen', 'eval(', 'exec(', '"/bin/sh"', 'subprocess.call('):
            self.assertNotIn(bad, src)

    def test_test_overrides_need_the_flag(self):
        tmp = tempfile.mkdtemp(prefix='orion-remote-test-')
        try:
            env = {'ORION_REMOTE_TEST_USER': 'orion-prod', 'ORION_REMOTE_TEST_BIN': tmp, 'HOME': tmp, 'PATH': '/usr/bin:/bin',
                   'SSH_ORIGINAL_COMMAND': 'status'}
            r = subprocess.run([sys.executable, '-I', REMOTE], env=env, capture_output=True, timeout=30)
            # Without ORION_REMOTE_TEST=1 the real user (not orion-prod) is used: refused.
            self.assertEqual(r.returncode, 64, r.stderr)
            self.assertIn(b'not an Orion user', r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
