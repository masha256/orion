import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import type { Db } from '../../src/db/connection.js';
import { emptySourceOutcome } from '../../src/db/fetchRuns.js';
import { getProvenanceByIds, insertObservation, listActiveObservations, type NewObservation } from '../../src/db/observations.js';
import { writeApiFlow } from '../../src/ingest/apiFlow.js';
import { writePeriodicPayments } from '../../src/ingest/periodic.js';
import { scanFlowGroup } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset } from '../../src/ingest/run.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { addDays } from '../../src/ingest/time.js';
import { sha256 } from '../../src/util/canonical.js';
import { CG_CHART, harness, hourlyPrices, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML, POOL, SAFE } from '../helpers/ingestAsset.js';
import { useTestDb } from '../helpers/db.js';

const testDb = useTestDb();
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const E18 = 10n ** 18n;

/** The provenance stored on the newest active row of a metric. */
async function stored(db: Db, assetId: string, metric: string) {
  const rows = await listActiveObservations(db, assetId, metric);
  return (await getProvenanceByIds(db, [rows.at(-1)!.id]))[0]!;
}

describe('provenance: every writer fills it', () => {
  it('transfer_flow row: method measured, source_type log_scan, chain eip155:1, block_from/to = detail.blocks, tx_count, tx_digest over all refs, tx_refs capped at 50', async () => {
    // The mini asset on Ethereum mainnet; 60 counted transfers on 2026-09-17 (31 from the pool, 29 from the safe).
    const loaded = parseAssetYaml(INGEST_ASSET_YAML.replace('chain_id: 8453', 'chain_id: 1'));
    const probe = harness(testDb(), { loaded });
    const at = (iso: string) => probe.rpc.blockAtOrAfter(Date.parse(iso) / 1000);
    const logs: Omit<TransferLog, 'timestamp'>[] = Array.from({ length: 60 }, (_, i) => ({
      blockNumber: at(`2026-09-17T${String(Math.floor(i / 3)).padStart(2, '0')}:${String((i % 3) * 10).padStart(2, '0')}:00Z`), logIndex: i, txHash: `0xtx${String(i).padStart(3, '0')}`,
      from: i % 2 === 0 ? POOL : SAFE, value: 1n * E18,
    }));
    const h = harness(testDb(), { loaded, logs, routes: { [CG_CHART]: hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', () => 10) } });
    const r = await scanFlowGroup({
      db: h.db, asset: h.loaded.config, configHash: h.loaded.hash, group: buildPlan(h.loaded.config).flowGroups[0], rpc: h.rpc, latest: await h.rpc.latestBlock(),
      http: h.http, env: {}, sleep: async () => undefined, now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false,
    });
    expect(r.outcome.status).toBe('ok');
    const row = (await listActiveObservations(h.db, 'mini', 'flow_usd.fees')).find((o) => o.observedAt.startsWith('2026-09-18'))!;
    expect(row.value).toBe(600); // values unchanged: 60 tokens at 10
    const detail = JSON.parse(row.sourceDetail!) as { blocks: [number, number] };
    const [p] = await getProvenanceByIds(h.db, [row.id]);
    const refs = logs.map((l) => `${l.txHash}:${l.logIndex}`).sort();
    expect(p).toMatchObject({
      method: 'measured', sourceType: 'log_scan', chain: 'eip155:1', blockFrom: detail.blocks[0], blockTo: detail.blocks[1], txCount: 60,
      txDigest: sha256(JSON.stringify(refs)), codeVersion: 'dev', configHash: h.loaded.hash, responseDigest: null,
    });
    expect(p!.txRefs).toEqual(refs.slice(0, 50));
    expect(p!.locator).toMatchObject({ event: 'Transfer(address,address,uint256)', senders: { pool: POOL, safe: SAFE } });
    // count_from [pool]: its own refs, its own digest.
    const prog = (await listActiveObservations(h.db, 'mini', 'flow_usd.fees_programmatic')).find((o) => o.observedAt.startsWith('2026-09-18'))!;
    const [pp] = await getProvenanceByIds(h.db, [prog.id]);
    expect(pp).toMatchObject({ txCount: 30, txRefs: expect.any(Array), locator: expect.objectContaining({ senders: { pool: POOL } }) });
    // A day with no transfer: count 0, no refs, no digest.
    const empty = (await listActiveObservations(h.db, 'mini', 'flow_usd.fees')).find((o) => o.observedAt.startsWith('2026-09-19'))!;
    expect((await getProvenanceByIds(h.db, [empty.id]))[0]).toMatchObject({ txCount: 0, txRefs: null, txDigest: null });
  });

  it('lighter API row: first_party_api, response_digest set', async () => {
    const lit = loadAsset(ROOT, 'lit');
    const days = ['2026-09-16', '2026-09-17', '2026-09-18'];
    const r = await writeApiFlow({
      db: testDb(), asset: lit.config, configHash: lit.hash, metricKey: 'flow_usd.fees_core', scanKey: 'adapter:lit.exchange_fees_daily>flow_usd.fees_core',
      // The first two days carry the API's own row for the day; the third none (an adapter that cannot expose it).
      points: days.map((day, i) => ({ day, value: 1000 + i, ...(i < 2 ? { slice: { maker_fee: { timestamp: Date.parse(day) / 1000, data: 1000 + i } } } : {}) })), detail: 'lighter exchangeMetrics mainnet.zklighter.elliot.ai maker_fee+taker_fee (3 days)', now: NOW,
      backfillDays: 3, rescan: false, adopt: false, dryRun: false, outcome: emptySourceOutcome('adapter:lit.exchange_fees_daily'), validate: () => null,
    });
    expect(r.written).toHaveLength(3);
    const p = await stored(testDb(), 'lit', 'flow_usd.fees_core');
    expect(p).toMatchObject({ method: 'measured', sourceType: 'first_party_api', chain: null, configHash: lit.hash, locator: { adapter: 'lit.exchange_fees_daily' } });
    // The digest is of the raw response slice (key-sorted), not of Orion's parsed value; no slice, no digest.
    const ids = (await listActiveObservations(testDb(), 'lit', 'flow_usd.fees_core')).map((o) => o.id);
    expect((await getProvenanceByIds(testDb(), ids)).map((x) => x.responseDigest)).toEqual([
      sha256(`{"maker_fee":{"data":1000,"timestamp":${Date.parse(days[0]!) / 1000}}}`),
      sha256(`{"maker_fee":{"data":1001,"timestamp":${Date.parse(days[1]!) / 1000}}}`),
      null,
    ]);
  });

  it('periodic payment row: response_digest of the ledger entries paid, none without them', async () => {
    const hype = loadAsset(ROOT, 'hype');
    const entry = { time: Date.parse('2026-08-09T10:00:00Z'), hash: '0xabc', delta: { type: 'send', token: 'USDC', amount: '1000.5' } };
    await writePeriodicPayments({
      db: testDb(), asset: hype.config, configHash: hype.hash, metricKey: 'flow_usd.reserve_yield',
      payments: [
        { from: '2026-07-01', to: '2026-07-30', value: 1000.5, paidAt: '2026-08-09T10:00:00.000Z', dueDay: '2026-08-08', slice: [entry] },
        { from: '2026-07-31', to: '2026-08-29', value: 900, paidAt: '2026-09-08T10:00:00.000Z', dueDay: '2026-09-07' },
      ],
      due: [], payers: [], expectedPayers: [], detail: 'ledger', now: NOW, dryRun: false, outcome: emptySourceOutcome('adapter:hype.reserve_yield_payments'),
      validate: () => null, raise: async () => undefined,
    });
    const ids = (await listActiveObservations(testDb(), 'hype', 'flow_usd.reserve_yield')).map((o) => o.id);
    expect((await getProvenanceByIds(testDb(), ids)).map((x) => x.responseDigest)).toEqual([
      sha256(`[{"delta":{"amount":"1000.5","token":"USDC","type":"send"},"hash":"0xabc","time":${entry.time}}]`),
      null,
    ]);
  });

  it('defillama row: third_party', async () => {
    const yaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
    const unix = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
    const h = harness(testDb(), {
      loaded: parseAssetYaml(yaml),
      routes: { 'https://api.llama.fi/summary/fees/hyperliquid': { totalDataChart: [['2026-09-17', 130], ['2026-09-18', 140]].map(([d, v]) => [unix(d as string), v]) } },
    });
    await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const p = await stored(h.db, 'hype', 'flow_usd.buyback');
    expect(p).toMatchObject({
      method: 'measured', sourceType: 'third_party', chain: null,
      locator: { endpoint: 'https://api.llama.fi/summary/fees/hyperliquid', request: { dataType: 'dailyHoldersRevenue' } },
    });
    // Each day's digest is that day's totalDataChart entry.
    const rows = await listActiveObservations(h.db, 'hype', 'flow_usd.buyback');
    const digests = (await getProvenanceByIds(h.db, rows.map((o) => o.id))).map((x) => x.responseDigest);
    expect(digests).toEqual(rows.map((o) => {
      const day = addDays(o.observedAt.slice(0, 10), -1);
      return sha256(JSON.stringify([unix(day), day === '2026-09-17' ? 130 : 140]));
    }));
  });

  it('derived flow_annualized: inputs + formula \'flow_annualized@1\'', async () => {
    const yaml = INGEST_ASSET_YAML.replace(
      '  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
      '  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, source: { type: derived, name: flow_annualized, params: { metric: flow_usd.fees, days: 2 } } }',
    );
    const h = harness(testDb(), { loaded: parseAssetYaml(yaml), logs: [] });
    await fetchAsset(h.db, h.loaded, NOW, h.deps);
    const rows = await listActiveObservations(h.db, 'mini', 'revenue_run_rate_usd');
    expect(rows.length).toBeGreaterThan(0);
    const last = rows.at(-1)!;
    const day = addDays(last.observedAt.slice(0, 10), -1);
    const [p] = await getProvenanceByIds(h.db, [last.id]);
    expect(p).toMatchObject({
      method: 'derived', sourceType: 'derived', formula: 'flow_annualized@1', inputs: [{ metric: 'flow_usd.fees', from: addDays(day, -1), to: day }],
      locator: { metrics: ['flow_usd.fees'], params: { metric: 'flow_usd.fees', days: 2 } },
    });
    // A chain level read at the run's block carries it; a market-data level its response digest.
    const supply = await stored(h.db, 'mini', 'total_supply');
    expect(supply).toMatchObject({ method: 'measured', sourceType: 'contract_state', chain: 'eip155:8453', blockFrom: expect.any(Number) });
    expect(supply.blockTo).toBe(supply.blockFrom);
    expect((await stored(h.db, 'mini', 'price_usd'))).toMatchObject({ sourceType: 'market_data', responseDigest: sha256('{"current_price":10,"id":"mini-token"}') });
  });

  it('disclosure row: method disclosed, citation required', async () => {
    const base: NewObservation = {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-09-01', value: 1, source: 'manual', fetchedAt: '2026-09-01',
      provenance: { method: 'disclosed', sourceType: 'disclosure', chain: null, locator: { citation_url: null }, codeVersion: 'dev', configHash: 'h' },
    };
    await expect(insertObservation(testDb(), base)).rejects.toThrow(expect.objectContaining({ code: 'citation_required' }));
    const o = await insertObservation(testDb(), { ...base, citationUrl: 'https://example.com/q3' });
    expect((await getProvenanceByIds(testDb(), [o.id]))[0]).toMatchObject({ method: 'disclosed', sourceType: 'disclosure' });
  });

  it('TypeScript: NewObservation without provenance does not compile', () => {
    // @ts-expect-error provenance is required on every new observation
    const missing: NewObservation = { assetId: 'mini', metricKey: 'price_usd', observedAt: '2026-09-01', value: 1, source: 'onchain', fetchedAt: '2026-09-01' };
    expect(missing.provenance).toBeUndefined();
  });
});
