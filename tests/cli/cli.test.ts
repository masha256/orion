import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    await orion('asset', 'registry', 'seed', '--reason', 'cutover', '--by', 'mike');
    const counts = await registryCounts();
    expect(await orion('asset', 'registry', 'diff')).toBe('registry matches the YAML');
    expect(await registryCounts()).toEqual(counts);
  });

  it('cli: asset registry seed makes every YAML active once', async () => {
    writeFileSync(join(home, 'assets', 'two.yaml'), MINI_ASSET_YAML.replace('id: mini', 'id: two'));
    const first = JSON.parse(await orion('asset', 'registry', 'seed', '--reason', 'cutover from SQLite', '--by', 'mike', '--json'));
    expect(first).toEqual({ seeded: ['mini', 'two'], existing: [] });
    const second = await orion('asset', 'registry', 'seed', '--reason', 'cutover from SQLite', '--by', 'mike');
    expect(second).toBe('nothing to seed: every YAML has a registry row (mini, two)');
    expect(await registryCounts()).toEqual({ rows: 2, events: 2 });
    const rows = JSON.parse(await orion('asset', 'registry', '--json'));
    expect(rows.map((r: { assetId: string; state: string; stateBy: string; stateReason: string }) => [r.assetId, r.state, r.stateBy, r.stateReason])).toEqual([
      ['mini', 'active', 'mike', 'cutover from SQLite'],
      ['two', 'active', 'mike', 'cutover from SQLite'],
    ]);
    // --reason and --by are both required.
    const exit: number[] = [];
    const lines: string[] = [];
    await buildProgram(testCliContext(home, { stdout: (l) => lines.push(l), setExitCode: (c) => exit.push(c) })).parseAsync(['asset', 'registry', 'seed', '--by', 'mike', '--json'], { from: 'user' });
    expect(JSON.parse(lines.join('\n')).error.code).toBe('reason_required');
    expect(exit).toEqual([1]);
  });

  it('cli: asset pause, resume and activate change the registry and print it', async () => {
    await orion('asset', 'registry', 'seed', '--reason', 'cutover', '--by', 'mike');
    await testDb().run("UPDATE asset_registry SET state = 'inactive'"); // as a new asset from a release
    expect(await orion('asset', 'activate', 'mini', '--by', 'mike')).toBe('MINI active (was inactive)');
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
});
