import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { scanFlowGroup } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { callKey } from '../helpers/fakeRpc.js';
import { CG_CHART, harness, hourlyPrices } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML, POOL, STAKING } from '../helpers/ingestAsset.js';

const E18 = 10n ** 18n;
const ms = (iso: string) => Date.parse(iso);

const PLAIN = 'source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: usd, price_coingecko_id: mini-token }';
const SHARES =
  'source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: usd, price_coingecko_id: mini-token, ' +
  'share_price: { contract: staking, function: pricePerShare, decimals: 18 } }';

function world(pps: bigint | Error) {
  const yaml = INGEST_ASSET_YAML.replace(PLAIN, SHARES);
  expect(yaml).not.toBe(INGEST_ASSET_YAML);
  const loaded = parseAssetYaml(yaml);
  const probe = harness({ loaded });
  const at = (iso: string) => probe.rpc.blockAtOrAfter(ms(iso) / 1000);
  const logs: Omit<TransferLog, 'timestamp'>[] = [
    { blockNumber: at('2026-09-16T10:00:00Z'), logIndex: 0, txHash: '0xa', from: POOL, value: 2n * E18 },
    { blockNumber: at('2026-09-17T10:00:00Z'), logIndex: 0, txHash: '0xb', from: POOL, value: 4n * E18 },
  ];
  return harness({
    loaded,
    logs,
    routes: { [CG_CHART]: hourlyPrices('2026-09-10T00:00:00Z', '2026-09-19T12:00:00Z', () => 10) },
    calls: { [callKey(STAKING, 'pricePerShare')]: pps },
  });
}

describe('transfer_flow share_price', () => {
  it('converts vault shares to the underlying at the day\'s last block before pricing; other members of the scan are untouched', async () => {
    const h = world(1_500_000_000_000_000_000n); // 1.5 underlying per share
    const latest = await h.rpc.latestBlock();
    const group = buildPlan(h.loaded.config).flowGroups[0];
    expect(group.members.find((m) => m.metricKey === 'flow_usd.fees')?.sharePrice).toEqual({ address: STAKING, functionName: 'pricePerShare', decimals: 18 });
    const r = await scanFlowGroup({
      db: h.db, asset: h.loaded.config, group, rpc: h.rpc, latest, http: h.http, env: {}, sleep: async () => undefined,
      now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false,
    });
    expect(r.outcome.status).toBe('ok');
    const vals = (k: string) => listActiveObservations(h.db, 'mini', k).map((o) => [o.observedAt.slice(0, 10), o.value]);
    // 2 shares x 1.5 x 10 USD = 30; 4 x 1.5 x 10 = 60; an empty day is 0 and reads no share price.
    expect(vals('flow_usd.fees')).toEqual([['2026-09-17', 30], ['2026-09-18', 60], ['2026-09-19', 0]]);
    expect(vals('flow_tokens.fees')).toEqual([['2026-09-17', 2], ['2026-09-18', 4], ['2026-09-19', 0]]); // no share_price: raw shares
    const detail = JSON.parse(listActiveObservations(h.db, 'mini', 'flow_usd.fees')[0].sourceDetail!) as { share_price?: Record<string, number> };
    expect(detail.share_price).toEqual({ [`${STAKING}.pricePerShare`]: 1.5 });
  });

  it('fails the scan, writing nothing for that day, when the share price cannot be read', async () => {
    const h = world(new Error('execution reverted'));
    const latest = await h.rpc.latestBlock();
    const r = await scanFlowGroup({
      db: h.db, asset: h.loaded.config, group: buildPlan(h.loaded.config).flowGroups[0], rpc: h.rpc, latest, http: h.http, env: {},
      sleep: async () => undefined, now: h.deps.now(), backfillDays: 3, rescan: false, adopt: false, dryRun: false,
    });
    expect(r.outcome.status).toBe('failed');
    expect(r.outcome.error).toMatch(/pricePerShare\(\) on 0x2222.*execution reverted/);
    expect(listActiveObservations(h.db, 'mini', 'flow_usd.fees')).toHaveLength(0);
  });

  it('is validated like any contract reference', () => {
    expect(() => parseAssetYaml(INGEST_ASSET_YAML.replace(PLAIN, SHARES.replace('contract: staking', 'contract: nowhere')))).toThrow(/unknown contract "nowhere"/);
  });
});
