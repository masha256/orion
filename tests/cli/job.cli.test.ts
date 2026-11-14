import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { listJobs, PRICES_BACKFILL_MAX_ATTEMPTS } from '../../src/db/jobs.js';
import { loadPrices } from '../../src/prices/config.js';
import { testCliContext, useTestDb } from '../helpers/db.js';
import { INGEST_ASSET_YAML, writeMiniHome } from '../helpers/ingestAsset.js';

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
  writeMiniHome(h, 'mini', INGEST_ASSET_YAML);
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

describe('orion job run-now backfill-prices (Phase 3 R2 Task 7)', () => {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url));
  const REFS = [...loadPrices(ROOT).keys()];
  /** A home with the repo's prices.yaml and no asset: a prices backfill is not per asset. */
  function pricesHome(): string {
    const h = mkdtempSync(join(tmpdir(), 'orion-job-cli-prices-'));
    dirs.push(h);
    mkdirSync(join(h, 'assets'));
    copyFileSync(join(ROOT, 'prices.yaml'), join(h, 'prices.yaml'));
    return h;
  }

  it('cli: job run-now backfill-prices queues one backfill job, asset null, op prices, at slot = now', async () => {
    const h = pricesHome();
    const r = await orion(h, 'job', 'run-now', 'backfill-prices', '--from', '2025-10-13', '--by', 'mike', '--json');
    expect(r.exit).toEqual([]);
    expect(JSON.parse(r.out)).toMatchObject({
      kind: 'backfill', assetId: null, slot: NOW, priority: 70, maxAttempts: PRICES_BACKFILL_MAX_ATTEMPTS, status: 'queued', requestedBy: 'run-now:mike',
      // R27: no --to -> today (UTC) at enqueue, stored in the params.
      params: { op: 'prices', from: '2025-10-13', to: '2026-11-03' },
    });
    await db().run('DELETE FROM jobs');
    const t = await orion(h, 'job', 'run-now', 'backfill-prices', '--from', '2026-11-01', '--to', '2026-11-02', '--refs', `${REFS[0]},hyperliquid:spot/@107`, '--by', 'mike');
    expect(t.exit).toEqual([]);
    expect(t.out).toBe(`queued job ${(await listJobs(db(), {}))[0]!.id} backfill slot ${NOW}: prices 2026-11-01..2026-11-02, refs ${REFS[0]}, hyperliquid:spot/@107`);
    expect((await listJobs(db(), { kind: 'backfill' })).map((j) => j.params)).toEqual([
      { op: 'prices', from: '2026-11-01', to: '2026-11-02', refs: [REFS[0], 'hyperliquid:spot/@107'] },
    ]);
    await db().run('DELETE FROM jobs');
    expect((await orion(h, 'job', 'run-now', 'backfill-prices', '--from', '2026-11-03', '--by', 'mike')).out)
      .toBe(`queued job ${(await listJobs(db(), {}))[0]!.id} backfill slot ${NOW}: prices 2026-11-03..2026-11-03, every ref`);
    await db().run('DELETE FROM jobs');
    // Op prices' cap is 550 days (R27): 2025-05-03..2026-11-03 is 550, accepted.
    expect((await orion(h, 'job', 'run-now', 'backfill-prices', '--from', '2025-05-03', '--by', 'mike', '--json')).exit).toEqual([]);
    expect((await listJobs(db(), { kind: 'backfill' })).map((j) => j.params)).toEqual([{ op: 'prices', from: '2025-05-03', to: '2026-11-03' }]);
  });

  it('cli: job run-now backfill-prices refuses an unknown ref, a bad range and stray options before the queue', async () => {
    const h = pricesHome();
    const run = (...a: string[]) => errorCode(h, 'job', 'run-now', 'backfill-prices', ...a, '--by', 'mike');
    expect(await run('--from', '2026-11-01', '--refs', `${REFS[0]},eip155:1/0x0000000000000000000000000000000000000001`)).toBe('invalid_backfill_params');
    expect(await run('--to', '2026-11-01')).toBe('invalid_option'); // --from is required
    expect(await run('--from', '2026-11-04')).toBe('invalid_backfill_params'); // after today (2026-11-03)
    expect(await run('--from', '2026-11-01', '--to', '2026-11-04')).toBe('invalid_backfill_params');
    expect(await run('--from', '2026-11-02', '--to', '2026-11-01')).toBe('invalid_backfill_params');
    expect(await run('--from', '2025-05-02')).toBe('invalid_backfill_params'); // 551 days to 2026-11-03
    expect(await run('--from', '2026-11-01', '--refs', '')).toBe('invalid_backfill_params');
    expect(await run('--from', 'yesterday')).toBe('invalid_backfill_params');
    expect(await run('mini', '--from', '2026-11-01')).toBe('asset_not_allowed');
    expect(await run('--from', '2026-11-01', '--metric', 'flow_usd.fees')).toBe('invalid_option');
    expect(await run('--from', '2026-11-01', '--backfill-days', '3')).toBe('invalid_option');
    expect(await run('--from', '2026-11-01', '--slot', NOW)).toBe('invalid_option');
    // --from/--to/--refs go with backfill-prices only.
    expect(await errorCode(h, 'job', 'run-now', 'levels', '--from', '2026-11-01', '--by', 'mike')).toBe('invalid_option');
    expect(await errorCode(home(), 'job', 'run-now', 'backfill', 'mini', '--metric', 'flow_usd.fees', '--backfill-days', '3', '--refs', REFS[0]!, '--by', 'mike')).toBe('invalid_option');
    expect(await listJobs(db(), {})).toEqual([]);
  });
});
