import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { insertObservation } from '../../src/db/observations.js';
import type { FetchDeps } from '../../src/ingest/run.js';
import type { HttpTransport } from '../../src/ingest/transport/http.js';
import { callKey, fakeRpc } from '../helpers/fakeRpc.js';
import { testCliContext, useTestDb } from '../helpers/db.js';

const db = useTestDb();
const NOW = '2026-11-20T12:00:00.000Z';
const GENESIS = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
const TOKEN = '0x00000000000000000000000000000000000000c1';
const ESCROW = '0x00000000000000000000000000000000000000e1';
const E18 = 10n ** 18n;

const YAML = `
id: sup
symbol: SUP
name: Supply CLI Test
contracts:
  token: "${TOKEN}"
  grant_escrow: "${ESCROW}"
ingest: { chain_id: 56, rpc_url_env: ORION_BNB_RPC_URL, backfill_days: 100 }
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  total_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  circulating_supply:
    type: level
    unit: tokens
    staleness_days: 14
    source:
      type: adapter
      name: chain.view_sum
      params:
        terms:
          - { contract: token, function: totalSupply }
          - { contract: grant_escrow, function: lockedSupply, sign: -1 }
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'orion-supply-cli-'));
  dirs.push(h);
  mkdirSync(join(h, 'assets'));
  writeFileSync(join(h, 'assets', 'sup.yaml'), YAML);
  return h;
}

/** 3 s blocks; the escrow reverts before 2026-10-01 (no code yet). totalSupply 1,000,000, escrow 50,000. */
function deps(): FetchDeps {
  const escrowBlock = BigInt(Math.ceil((Date.parse('2026-10-01T00:00:00Z') / 1000 - GENESIS) / 3));
  const rpc = fakeRpc({
    genesisTs: GENESIS, latest: BigInt(Math.floor((Date.parse(NOW) / 1000 - GENESIS) / 3)), blockTimeSec: 3,
    callsAt: (b) => ({
      [callKey(TOKEN, 'totalSupply')]: 1_000_000n * E18,
      [callKey(ESCROW, 'lockedSupply')]: b < escrowBlock ? new Error('execution reverted') : 50_000n * E18,
    }),
  });
  const http = { getJson: async () => { throw new Error('no HTTP'); }, postJson: async () => { throw new Error('no HTTP'); } } as HttpTransport;
  return { http, rpcFactory: () => rpc, env: { ORION_BNB_RPC_URL: 'http://bnb.test' }, sleep: async () => undefined, now: () => new Date(NOW) };
}

async function orion(h: string, ...args: string[]): Promise<{ out: string; exit: number[] }> {
  const lines: string[] = [];
  const exit: number[] = [];
  const program = buildProgram(testCliContext(h, { stdout: (l) => lines.push(l), now: () => new Date(NOW), setExitCode: (c) => exit.push(c), ingestDeps: deps }));
  await program.parseAsync(args, { from: 'user' });
  return { out: lines.join('\n'), exit };
}

const cg = async (observedAt: string): Promise<number> => (await insertObservation(db(), {
  assetId: 'sup', metricKey: 'circulating_supply', observedAt, value: 1, periodDays: null, fetchedAt: observedAt,
  provenance: { method: 'measured', sourceType: 'market_data', chain: null, locator: { provider: 'coingecko' }, codeVersion: 'test', configHash: 'h' },
})).id;

describe('orion data rebuild-supply-levels', () => {
  it('a disclosure row is listed KEPT (text and JSON), untouched by --yes (Ruling R15)', async () => {
    const h = home();
    await cg('2026-10-20T00:47:00.000Z');
    const disc = (await insertObservation(db(), {
      assetId: 'sup', metricKey: 'circulating_supply', observedAt: '2026-09-18T00:00:00.000Z', value: 48_350_000, periodDays: null,
      fetchedAt: '2026-09-18T00:00:00.000Z', citationUrl: 'https://example.test/disclosed',
      provenance: { method: 'disclosed', sourceType: 'disclosure', chain: null, locator: { citation_url: 'https://example.test/disclosed' }, codeVersion: 'test', configHash: 'h' },
    })).id;
    const dry = await orion(h, 'data', 'rebuild-supply-levels', 'sup');
    const lines = dry.out.split('\n');
    expect(lines[1]).toMatch(/: 1 row\(s\) of another source: 1 to rebuild, 0 refused, 0 not rebuildable; 0 of the current source unchanged; 1 kept; \d+ RPC call\(s\)$/);
    expect(lines[2]).toBe(`    KEPT #${disc} 2026-09-18T00:00:00.000Z: a disclosure row: only market_data and old-locator contract_state rows are rebuilt (Ruling R15)`);
    expect(dry.exit).toEqual([]);
    const yes = await orion(h, 'data', 'rebuild-supply-levels', 'sup', '--yes', '--json');
    expect(JSON.parse(yes.out)).toMatchObject({ applied: true, rows: 1, rebuilt: 1, kept: [{ id: disc, observedAt: '2026-09-18T00:00:00.000Z' }] });
    expect(await db().one('SELECT superseded_by, value, source_type FROM observations WHERE id = $1', [disc])).toEqual({ superseded_by: null, value: 48_350_000, source_type: 'disclosure' });
  });

  it('dry run, then --yes; nothing refused exits 0', async () => {
    const h = home();
    await cg('2026-10-20T00:47:00.000Z');
    const dry = await orion(h, 'data', 'rebuild-supply-levels', 'sup');
    const lines = dry.out.split('\n');
    expect(lines[0]).toBe('SUP rebuild-supply-levels (dry run):');
    expect(lines[1]).toMatch(/^ {2}circulating_supply: 1 row\(s\) of another source: 1 to rebuild, 0 refused, 0 not rebuildable; 0 of the current source unchanged; 0 kept; \d+ RPC call\(s\)$/);
    expect(lines[2]).toBe('dry run: nothing written; --yes writes the rebuilt rows');
    expect(dry.exit).toEqual([]);
    const yes = await orion(h, 'data', 'rebuild-supply-levels', 'sup', '--yes', '--json');
    expect(JSON.parse(yes.out)).toMatchObject({ asset: 'sup', applied: true, metric: 'circulating_supply', rows: 1, rebuilt: 1, refused: [], notRebuildable: [] });
    expect(yes.exit).toEqual([]);
    expect(await db().all("SELECT value, source_type FROM observations WHERE metric_key = 'circulating_supply' AND superseded_by IS NULL")).toEqual([{ value: 950_000, source_type: 'contract_state' }]);
  });

  it('a row whose read reverts at its block is refused: exit 3 (dry run and --yes), listed, its CoinGecko row kept', async () => {
    const h = home();
    await cg('2026-10-20T00:47:00.000Z');
    const old = await cg('2026-09-15T00:47:00.000Z');
    const dry = await orion(h, 'data', 'rebuild-supply-levels', 'sup');
    expect(dry.exit).toEqual([3]);
    expect(dry.out.split('\n')[2]).toMatch(new RegExp(`^ {4}REFUSED #${old} 2026-09-15T00:47:00.000Z: adapter chain.view_sum: lockedSupply\\(\\) at block \\d+: execution reverted$`));
    const yes = await orion(h, 'data', 'rebuild-supply-levels', 'sup', '--yes', '--json');
    expect(yes.exit).toEqual([3]);
    expect(JSON.parse(yes.out)).toMatchObject({ applied: true, rebuilt: 1, refused: [{ id: old, observedAt: '2026-09-15T00:47:00.000Z' }] });
    expect(await db().one('SELECT superseded_by, value, source_type FROM observations WHERE id = $1', [old])).toEqual({ superseded_by: null, value: 1, source_type: 'market_data' });
  });
});
