import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { listJobs } from '../../src/db/jobs.js';
import { testCliContext, useTestDb } from '../helpers/db.js';
import { INGEST_ASSET_YAML } from '../helpers/ingestAsset.js';

const db = useTestDb();
const NOW = '2026-11-03T02:00:00.000Z';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A home with the mini ingest asset (flows with sources); the asset is not in the registry (a backfill needs no state). */
function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'orion-job-cli-'));
  dirs.push(h);
  mkdirSync(join(h, 'assets'));
  writeFileSync(join(h, 'assets', 'mini.yaml'), INGEST_ASSET_YAML);
  return h;
}

async function orion(h: string, ...args: string[]): Promise<{ out: string; exit: number[] }> {
  const lines: string[] = [];
  const exit: number[] = [];
  const program = buildProgram(testCliContext(h, { stdout: (l) => lines.push(l), now: () => new Date(NOW), setExitCode: (c) => exit.push(c) }));
  await program.parseAsync(args, { from: 'user' });
  return { out: lines.join('\n'), exit };
}

const errorCode = async (h: string, ...args: string[]): Promise<string> => {
  const r = await orion(h, ...args, '--json');
  expect(r.exit, args.join(' ')).toEqual([1]);
  return JSON.parse(r.out).error.code as string;
};

describe('orion job run-now backfill', () => {
  it('cli: job run-now backfill queues one backfill job with its params at slot = now, for an asset in no registry state', async () => {
    const h = home();
    const r = await orion(h, 'job', 'run-now', 'backfill', 'mini', '--metric', 'flow_usd.fees', '--metric', 'flow_tokens.fees', '--backfill-days', '120', '--by', 'mike', '--json');
    expect(r.exit).toEqual([]);
    expect(JSON.parse(r.out)).toMatchObject({
      id: 1, kind: 'backfill', assetId: 'mini', slot: NOW, runAfter: NOW, priority: 70, maxAttempts: 1, status: 'queued', requestedBy: 'run-now:mike',
      params: { op: 'fetch', metrics: ['flow_usd.fees', 'flow_tokens.fees'], backfillDays: 120 },
    });
    const jobs = await listJobs(db(), { kind: 'backfill' });
    expect(jobs.map((j) => j.params)).toEqual([{ op: 'fetch', metrics: ['flow_usd.fees', 'flow_tokens.fees'], backfillDays: 120 }]);
    // Text output names the metrics and days.
    const h2 = home();
    await db().run('DELETE FROM jobs');
    const t = await orion(h2, 'job', 'run-now', 'backfill', 'mini', '--metric', 'flow_tokens.fees', '--backfill-days', '30', '--by', 'mike');
    expect(t.out).toMatch(/^queued job \d+ backfill mini slot 2026-11-03T02:00:00.000Z: flow_tokens.fees, 30 days$/);
  });

  it('cli: job run-now backfill refuses a bad request before it reaches the queue', async () => {
    const h = home();
    const run = (...a: string[]) => errorCode(h, 'job', 'run-now', 'backfill', ...a, '--by', 'mike');
    expect(await run('--metric', 'flow_usd.fees', '--backfill-days', '30')).toBe('asset_required');
    expect(await run('mini', '--backfill-days', '30')).toBe('invalid_option'); // --metric is required
    expect(await run('mini', '--metric', 'flow_usd.fees')).toBe('invalid_option'); // --backfill-days is required
    expect(await run('mini', '--metric', 'nope', '--backfill-days', '30')).toBe('invalid_backfill_params');
    expect(await run('mini', '--metric', 'total_supply', '--backfill-days', '30')).toBe('invalid_backfill_params');
    expect(await run('mini', '--metric', 'flow_usd.fees', '--backfill-days', '0')).toBe('invalid_backfill_params');
    expect(await run('mini', '--metric', 'flow_usd.fees', '--backfill-days', '401')).toBe('invalid_backfill_params');
    expect(await run('mini', '--metric', 'flow_usd.fees', '--backfill-days', 'ten')).toBe('invalid_backfill_params');
    expect(await run('mini', '--metric', 'flow_usd.fees', '--metric', 'flow_usd.fees', '--backfill-days', '30')).toBe('invalid_backfill_params');
    expect(await run('ghost', '--metric', 'flow_usd.fees', '--backfill-days', '30')).toBe('asset_not_found');
    expect(await listJobs(db(), {})).toEqual([]);
  });

  it('cli: --metric and --backfill-days are refused for every other kind', async () => {
    const h = home();
    expect(await errorCode(h, 'job', 'run-now', 'refresh', 'mini', '--force', '--metric', 'flow_usd.fees', '--by', 'mike')).toBe('invalid_option');
    expect(await errorCode(h, 'job', 'run-now', 'levels', '--backfill-days', '30', '--by', 'mike')).toBe('invalid_option');
    expect(await errorCode(h, 'job', 'run-now', 'nightly_report', '--slot', '2026-11-03T00:45:00Z', '--metric', 'x', '--backfill-days', '3', '--by', 'mike')).toBe('invalid_option');
    expect(await listJobs(db(), {})).toEqual([]);
    // Unchanged without them.
    const r = await orion(h, 'job', 'run-now', 'levels', '--by', 'mike', '--json');
    expect(JSON.parse(r.out)).toMatchObject({ kind: 'levels', params: null });
  });
});
