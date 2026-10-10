import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { fetchAsset, type FetchResult } from '../../src/ingest/run.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { GENESIS_TS, harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML, POOL, SAFE } from '../helpers/ingestAsset.js';

const E18 = 10n ** 18n;
const STRANGER = '0x9999999999999999999999999999999999999999';
const TREASURY = '0x5555555555555555555555555555555555555555';
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / 2));

/** The mini asset plus a report-only revenue flow: the token sent to a treasury by the pool. */
const yaml = INGEST_ASSET_YAML.replace(
  `  safe: "${SAFE}"\n`,
  `  safe: "${SAFE}"\n  treasury: "${TREASURY}"\n`,
).replace(
  'holder_flows:',
  `  flow_usd.revenue:
    type: flow
    unit: usd
    staleness_days: 10
    monitor_only: true
    source: { type: transfer_flow, token: token, to: treasury, from_allowlist: [pool], unit: usd, price_coingecko_id: mini-token }
holder_flows:`,
);
const loaded = () => parseAssetYaml(yaml);
const source = (r: FetchResult, id: string) => r.sources.find((s) => s.sourceId === id);
const REV_ID = 'transfer_flow:token>treasury[pool]';

describe('fetchAsset: monitor-only (report) flows', () => {
  it('writes the report flow daily, like any transfer scan', async () => {
    const logs: Omit<TransferLog, 'timestamp'>[] = [{ blockNumber: blockAt('2026-09-17T12:00:00Z'), logIndex: 0, txHash: '0xa', from: POOL, value: 3n * E18 }];
    // The fake RPC ignores `to`, so the pool's transfer also lands on the burn sink's scan; only the revenue scan matters here.
    const h = harness({ loaded: loaded(), logs });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(source(r, REV_ID)).toMatchObject({ status: 'ok', metricsWritten: ['flow_usd.revenue'] });
    expect(listActiveObservations(h.db, 'mini', 'flow_usd.revenue').map((o) => o.value)).toEqual([0, 30, 0]);
  });

  it('raises no unlisted_sender anomaly for a sender only a report flow sees', async () => {
    const logs: Omit<TransferLog, 'timestamp'>[] = [{ blockNumber: blockAt('2026-09-17T12:00:00Z'), logIndex: 0, txHash: '0xb', from: STRANGER, value: 1n * E18 }];
    const h = harness({ loaded: loaded(), logs });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    // The same stranger reaches the valuation's own scan (the fake ignores `to`), which still raises its one anomaly.
    expect(r.anomalies.filter((a) => a.kind === 'unlisted_sender').map((a) => a.metricKey)).toEqual(['flow_usd.fees']);
  });

  it('raises no failure streak for a source that feeds only report flows', async () => {
    const h = harness({ loaded: loaded() });
    const realGetLogs = h.rpc.getTransferLogs.bind(h.rpc);
    // Fail only the treasury scan: its logs query names the treasury as `to`.
    h.rpc.getTransferLogs = async (q) => {
      if (q.to.toLowerCase() === TREASURY) throw new Error('boom');
      return realGetLogs(q);
    };
    // Three attempts in a row (the streak counts attempts); the fake chain head is fixed, so each re-scans the same days.
    for (const attempt of [0, 1, 2]) {
      const r = await fetchAsset(h.db, h.loaded, new Date(NOW.getTime() + 5000 + attempt), h.deps, { backfillDays: 2 });
      expect(source(r, REV_ID)?.status).toBe('failed');
      expect(r.anomalies.filter((a) => a.kind === 'source_failure_streak')).toEqual([]);
    }
  });

  it('still raises the streak when the same failure hits a valuation source (control)', async () => {
    const h = harness({ loaded: loaded() });
    const realGetLogs = h.rpc.getTransferLogs.bind(h.rpc);
    h.rpc.getTransferLogs = async (q) => {
      if (q.to.toLowerCase() !== TREASURY) throw new Error('boom');
      return realGetLogs(q);
    };
    let last: FetchResult | null = null;
    for (const attempt of [0, 1, 2]) last = await fetchAsset(h.db, h.loaded, new Date(NOW.getTime() + 5000 + attempt), h.deps, { backfillDays: 2 });
    expect(last!.anomalies.filter((a) => a.kind === 'source_failure_streak').map((a) => a.dedupeKey)).toEqual(['transfer_flow:token>burn_sink[pool,safe]']);
  });
});
