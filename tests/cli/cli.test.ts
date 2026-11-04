import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { devPaths, testCliContext, useTestDb } from '../helpers/db.js';
import { AS_OF } from '../helpers/obs.js';

const testDb = useTestDb();

let home: string;

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const program = buildProgram(testCliContext(home, { stdout: (l) => lines.push(l), now: () => new Date(AS_OF) }));
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-cli-'));
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
});

describe('orion cli', () => {
  it('init creates the home layout and no database file', async () => {
    for (const d of ['assets', 'personas', 'skills']) expect(existsSync(join(home, d))).toBe(true);
    expect(existsSync(join(home, 'orion.db'))).toBe(false); // the database is Postgres, set up by orion db migrate
    const fresh = mkdtempSync(join(tmpdir(), 'orion-cli-'));
    const lines: string[] = [];
    // no database configured at all: init needs none
    await buildProgram({ ...devPaths(fresh), stdout: (l) => lines.push(l), now: () => new Date(AS_OF) }).parseAsync(['init', '--json'], { from: 'user' });
    expect(JSON.parse(lines.join('\n'))).toEqual({ home: fresh });
  });

  it('cli: model, signal and update are unknown commands', async () => {
    // Each with a sub-command and arguments it used to accept, so only a missing top-level command can fail this way.
    for (const args of [['model', 'run', 'mini'], ['model', 'proposals', 'list'], ['signal', 'latest', 'mini'], ['update', 'mini']]) {
      const lines: string[] = [];
      const program = buildProgram(testCliContext(home, { stdout: (l) => lines.push(l), now: () => new Date(AS_OF) }));
      await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({ code: 'commander.unknownCommand', exitCode: 1 });
      // Commander may add a "(Did you mean ...?)" line for a near miss, such as update -> data.
      expect(lines.join('\n')).toMatch(new RegExp(`^error: unknown command '${args[0]}'`));
    }
  });

  it('cli: proposals is a top-level command', async () => {
    const lines: string[] = [];
    const exit: number[] = [];
    const program = buildProgram(testCliContext(home, { stdout: (l) => lines.push(l), now: () => new Date(AS_OF), setExitCode: (c) => exit.push(c) }));
    await program.parseAsync(['proposals', 'list'], { from: 'user' });
    expect(lines.join('\n')).toBe('no proposals');
    expect(exit).toEqual([]);
    expect(JSON.parse(await orion('proposals', 'list', '--json'))).toEqual([]);
  });

  it('lists, shows, and validates assets', async () => {
    expect(JSON.parse(await orion('asset', 'list', '--json'))).toEqual(['mini']);
    expect(JSON.parse(await orion('asset', 'show', 'mini', '--json')).hash).toMatch(/^[0-9a-f]{64}$/);
    const shown = await orion('asset', 'show', 'mini');
    expect(shown).toMatch(/^MINI {2}Mini Test Asset {2}\(mini\)\nconfig hash [0-9a-f]{64}\nmetrics: .+\nholder flows: .+$/);
    expect(JSON.parse(await orion('asset', 'validate', '--json'))).toEqual([{ id: 'mini', errors: [] }]);
    mkdirSync(join(home, 'assets'), { recursive: true });
    writeFileSync(join(home, 'assets', 'bad.yaml'), MINI_ASSET_YAML.replace('id: mini', 'id: bad').replace('price_usd: { type: level', 'price_usd: { type: nope'));
    await expect(orion('asset', 'validate', 'bad')).rejects.toThrow(/validation failed/);
  });

  it('cli: asset validate fails on a schedule.yaml with a 07:30 slot', async () => {
    writeFileSync(join(home, 'schedule.yaml'), 'nightly: { at: "00:45", tz: UTC }\nlevels: { every: 1h, minute: 15 }\n');
    expect(JSON.parse(await orion('asset', 'validate', '--json'))).toEqual([{ id: 'mini', errors: [] }, { id: 'schedule.yaml', errors: [] }]);
    writeFileSync(join(home, 'schedule.yaml'), 'nightly: { at: "07:30", tz: UTC }\n');
    const lines: string[] = [];
    const program = buildProgram(testCliContext(home, { stdout: (l) => lines.push(l), now: () => new Date(AS_OF) }));
    await expect(program.parseAsync(['asset', 'validate'], { from: 'user' })).rejects.toThrow('validation failed for: schedule.yaml');
    expect(lines).toEqual(['mini: ok', 'schedule.yaml:', '  nightly at 07:30 UTC falls in 07:00-08:00 UTC, whose Pacific date differs between PDT and PST']);
    // `asset validate <id>` checks that asset only.
    expect(await orion('asset', 'validate', 'mini')).toBe('mini: ok');
  });

  it('cli: asset validate prints the listing bar (D6) for an asset with income_statement, without failing on it', async () => {
    for (const a of ['hype', 'crv']) copyFileSync(join(import.meta.dirname, '..', '..', 'assets', `${a}.yaml`), join(home, 'assets', `${a}.yaml`));
    expect(await orion('asset', 'validate', 'hype')).toBe('hype: ok\n  listing bar (D6): fails: revenue.trading (third_party), holders.af_buyback (third_party)');
    expect(await orion('asset', 'validate', 'crv')).toBe('crv: ok\n  listing bar (D6): ok');
    expect(JSON.parse(await orion('asset', 'validate', 'hype', '--json'))).toEqual([
      { id: 'hype', errors: [], listingBar: { ok: false, failing: [{ line: 'revenue.trading', sourceType: 'third_party' }, { line: 'holders.af_buyback', sourceType: 'third_party' }] } },
    ]);
  });

  it('rejects data for a metric the asset does not define', async () => {
    await expect(orion('data', 'set', 'mini', 'nonsense', '1')).rejects.toThrow(/not defined/);
  });

  it('requires --period-days for a flow metric and refuses it for any other type', async () => {
    await expect(orion('data', 'set', 'mini', 'flow_usd.fees', '100', '--at', AS_OF)).rejects.toThrow(/--period-days/);
    await expect(
      orion('data', 'set', 'mini', 'price_usd', '10', '--at', AS_OF, '--period-days', '30'),
    ).rejects.toThrow(/--period-days/);
  });

  it('handles provisional observations through confirm', async () => {
    await orion('data', 'set', 'mini', 'revenue_run_rate_usd', '1200', '--at', '2026-06-20', '--provisional', '--citation', 'https://example.com/post', '--quote', 'crossed 1200');
    const shown = JSON.parse(await orion('data', 'show', 'mini', 'revenue_run_rate_usd', '--json'));
    expect(shown[0].status).toBe('provisional');
    // The inbox is where the row waits, with its id, and without the quote.
    const inbox = JSON.parse(await orion('inbox', 'mini', '--json'));
    expect(inbox).toMatchObject({ asset: 'mini', observations: [{ id: shown[0].id, metric: 'revenue_run_rate_usd', value: 1200, citation_url: 'https://example.com/post', recorded_by: null }], proposals: [], anomalies: [] });
    expect(JSON.stringify(inbox)).not.toContain('crossed 1200');
    expect(await orion('inbox', 'mini')).toMatch(/^obs #\d+  revenue_run_rate_usd  1200 at 2026-06-20  no confirmed value  entered by hand  https:\/\/example.com\/post$/);
    const confirmed = JSON.parse(await orion('data', 'confirm', String(shown[0].id), '--json'));
    expect(confirmed.status).toBe('confirmed');
    expect(await orion('inbox', 'mini')).toBe('nothing to decide');
    await expect(orion('data', 'set', 'mini', 'price_usd', '1', '--provisional')).rejects.toThrow(/citation/);
  });

  it('guards the inbox when a stored proposal has a shape the schema does not expect', async () => {
    await orion('inbox', 'mini'); // creates the database
    await testDb().run("INSERT INTO proposals (asset_id, persona, agent_run_id, kind, change_json, filed_against_json, rationale, evidence_json, effect_json, status, created_at) VALUES ('mini', 'analyst', NULL, 'config', '{}', '{}', 'r', '[]', '{\"weird\": 1}', 'pending', $1)", [AS_OF]);
    const lines: string[] = [];
    const errors: string[] = [];
    await buildProgram(testCliContext(home, { stdout: (l) => lines.push(l), stderr: (l) => errors.push(l), now: () => new Date(AS_OF) })).parseAsync(['inbox', 'mini'], { from: 'user' });
    expect(lines.join('\n')).toBe('nothing to decide');
    expect(errors.some((l) => /^warning: the inbox could not be built \(.+\); nothing is listed$/s.test(l))).toBe(true);
  });

  async function registryCounts(): Promise<{ rows: number; events: number }> {
    const r = await testDb().one<{ rows: number; events: number }>(
      'SELECT (SELECT count(*)::int FROM asset_registry) AS rows, (SELECT count(*)::int FROM asset_state_events) AS events',
    );
    return r!;
  }

  it('cli: asset registry diff writes nothing', async () => {
    writeFileSync(join(home, 'assets', 'two.yaml'), MINI_ASSET_YAML.replace('id: mini', 'id: two'));
    expect(JSON.parse(await orion('asset', 'registry', 'diff', '--json'))).toEqual({ added: ['mini', 'two'], missing: [], returned: [], configChanged: [] });
    expect(await orion('asset', 'registry', 'diff')).toBe('new (arrive inactive): mini, two');
    expect(await registryCounts()).toEqual({ rows: 0, events: 0 });
    expect(await orion('asset', 'registry')).toBe('the asset registry is empty');
    // Once seeded, the diff is empty and still writes nothing.
    await orion('asset', 'registry', 'seed', '--all', '--reason', 'cutover', '--by', 'mike');
    const counts = await registryCounts();
    expect(await orion('asset', 'registry', 'diff')).toBe('registry matches the YAML');
    expect(await registryCounts()).toEqual(counts);
  });

  it('cli: asset registry reconcile applies the diff; retiring every asset needs --allow-retire (R-c10)', async () => {
    writeFileSync(join(home, 'assets', 'two.yaml'), MINI_ASSET_YAML.replace('id: mini', 'id: two'));
    await orion('asset', 'registry', 'seed', '--all', '--reason', 'cutover', '--by', 'mike');
    // Both YAMLs gone: the reconcile would retire every asset, refused (no writes) without --allow-retire.
    const kept = mkdtempSync(join(tmpdir(), 'orion-cli-kept-'));
    for (const f of ['mini.yaml', 'two.yaml']) {
      copyFileSync(join(home, 'assets', f), join(kept, f));
      rmSync(join(home, 'assets', f));
    }
    const counts = await registryCounts();
    const exit: number[] = [];
    const lines: string[] = [];
    await buildProgram(testCliContext(home, { stdout: (l) => lines.push(l), setExitCode: (c) => exit.push(c) }))
      .parseAsync(['asset', 'registry', 'reconcile', '--json'], { from: 'user' });
    expect(exit).toEqual([1]);
    expect(JSON.parse(lines.join('\n')).error.code).toBe('reconcile_would_retire');
    expect(await registryCounts()).toEqual(counts);
    expect(JSON.parse(await orion('asset', 'registry', 'reconcile', '--allow-retire', '--json'))).toEqual({
      added: [], missing: ['mini', 'two'], returned: [], configChanged: [],
    });
    const rows = JSON.parse(await orion('asset', 'registry', '--json'));
    expect(rows.map((r: { state: string }) => r.state)).toEqual(['missing', 'missing']);
    for (const f of ['mini.yaml', 'two.yaml']) copyFileSync(join(kept, f), join(home, 'assets', f));
    rmSync(kept, { recursive: true, force: true });
    expect(await orion('asset', 'registry', 'reconcile')).toBe('YAML back (return inactive): mini, two');
  });

  it('cli: asset registry seed needs ids or --all, seeds only an empty registry and prints what it activates (I-2)', async () => {
    writeFileSync(join(home, 'assets', 'two.yaml'), MINI_ASSET_YAML.replace('id: mini', 'id: two'));
    const fail = async (...args: string[]): Promise<string> => {
      const exit: number[] = [];
      const lines: string[] = [];
      await buildProgram(testCliContext(home, { stdout: (l) => lines.push(l), setExitCode: (c) => exit.push(c) })).parseAsync(args, { from: 'user' });
      expect(exit).toEqual([1]);
      return JSON.parse(lines.join('\n')).error.code;
    };
    // Neither ids nor --all; both; --reason missing.
    expect(await fail('asset', 'registry', 'seed', '--reason', 'cutover', '--by', 'mike', '--json')).toBe('seed_ids_required');
    expect(await fail('asset', 'registry', 'seed', 'mini', '--all', '--reason', 'cutover', '--by', 'mike', '--json')).toBe('seed_ids_required');
    expect(await fail('asset', 'registry', 'seed', '--all', '--by', 'mike', '--json')).toBe('reason_required');
    expect(await registryCounts()).toEqual({ rows: 0, events: 0 });
    expect(await orion('asset', 'registry', 'seed', 'mini', '--reason', 'cutover from SQLite', '--by', 'mike')).toBe('seeded active: mini');
    // The registry has a row now: a second seed (even of another id) is refused and two stays out.
    expect(await fail('asset', 'registry', 'seed', 'two', '--reason', 'again', '--by', 'mike', '--json')).toBe('registry_not_empty');
    expect(await registryCounts()).toEqual({ rows: 1, events: 1 });
    await testDb().run('TRUNCATE asset_registry, asset_state_events');
    expect(JSON.parse(await orion('asset', 'registry', 'seed', '--all', '--reason', 'cutover from SQLite', '--by', 'mike', '--json'))).toEqual({ seeded: ['mini', 'two'] });
    const rows = JSON.parse(await orion('asset', 'registry', '--json'));
    expect(rows.map((r: { assetId: string; state: string; stateBy: string; stateReason: string }) => [r.assetId, r.state, r.stateBy, r.stateReason])).toEqual([
      ['mini', 'active', 'mike', 'cutover from SQLite'],
      ['two', 'active', 'mike', 'cutover from SQLite'],
    ]);
  });

  it('cli: asset pause, resume and activate change the registry and print it', async () => {
    await orion('asset', 'registry', 'seed', '--all', '--reason', 'cutover', '--by', 'mike');
    await testDb().run("UPDATE asset_registry SET state = 'inactive'"); // as a new asset from a release
    // No schedule.yaml in this home: no slot to name, but the way to refresh now.
    expect(await orion('asset', 'activate', 'mini', '--by', 'mike')).toBe('MINI active (was inactive)\nto refresh now: orion job run-now refresh mini');
    expect(await orion('asset', 'pause', 'mini', '--reason', 'merger rebuild', '--by', 'mike via raymond')).toBe('MINI paused (was active): merger rebuild');
    const listed = await orion('asset', 'registry');
    expect(listed).toMatch(/^mini {2}paused {2}since \d{4}-\d{2}-\d{2} by mike via raymond: merger rebuild {2}last run never$/);
    expect(await orion('asset', 'resume', 'mini', '--by', 'mike')).toBe('MINI active (was paused 0 days): flows backfill from their cursors');
    const err = JSON.parse(await orion('asset', 'resume', 'mini', '--json'));
    expect(err.error).toEqual({ code: 'invalid_state_transition', message: 'mini is active; resume needs paused' });
    // R-c5: an asset paused while inactive resumes to inactive.
    await testDb().run("UPDATE asset_registry SET state = 'inactive'");
    await orion('asset', 'pause', 'mini', '--reason', 'hold', '--by', 'mike');
    expect(await orion('asset', 'resume', 'mini', '--by', 'mike')).toBe('MINI inactive (was paused 0 days): asset activate starts it');
  });

  it('cli: asset activate names the next nightly slot and suggests job run-now (mid-day activation)', async () => {
    copyFileSync(new URL('../../schedule.yaml', import.meta.url), join(home, 'schedule.yaml'));
    await orion('asset', 'registry', 'seed', '--all', '--reason', 'cutover', '--by', 'mike');
    await testDb().run("UPDATE asset_registry SET state = 'inactive'");
    // AS_OF is 2026-06-30T00:00Z: the next nightly slot is 00:45 that day (dev env: the base entry).
    expect(await orion('asset', 'activate', 'mini', '--by', 'mike')).toBe(
      'MINI active (was inactive)\nfirst nightly refresh at 2026-06-30T00:45:00.000Z; to refresh now: orion job run-now refresh mini',
    );
  });
});
