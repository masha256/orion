import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { cloneImplementation } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchResult } from '../../src/ingest/run.js';
import type { TransferLog } from '../../src/ingest/transport/rpc.js';
import { GENESIS_TS, harness } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML, POOL, SAFE } from '../helpers/ingestAsset.js';

const E18 = 10n ** 18n;
const FORWARDER = '0x7777777777777777777777777777777777777777';
const SIDECAR = '0x8888888888888888888888888888888888888888';
const OTHER_CLONE = '0x9999999999999999999999999999999999999999';
const IMPL = '0xef7cffdef21538b63cc541bf206bb382d922a216';
const OTHER_IMPL = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x6666666666666666666666666666666666666666';
const blockAt = (iso: string) => BigInt(Math.ceil((Date.parse(iso) / 1000 - GENESIS_TS) / 2));
const clone = (impl: string, tail = '') => `0x363d3d373d3d3d363d73${impl.slice(2)}5af43d82803e903d91602b57fd5bf3${tail}`;

/** The mini asset with ignore lists on its one transfer_flow scan (fees, fees_programmatic and flow_tokens share it). */
function withIgnore(lines: { ignore?: string[]; clones?: string[] }): string {
  const extra = [
    lines.ignore ? `from_ignore: [${lines.ignore.join(', ')}]` : '',
    lines.clones ? `from_ignore_clones_of: [${lines.clones.join(', ')}]` : '',
  ].filter((x) => x !== '').join(', ');
  return INGEST_ASSET_YAML
    .replace(`  safe: "${SAFE}"\n`, `  safe: "${SAFE}"\n  forwarder: "${FORWARDER}"\n  sidecar_impl: "${IMPL}"\n`)
    .replace('source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], unit: usd,', `source: { type: transfer_flow, token: token, to: burn_sink, from_allowlist: [pool, safe], ${extra}, unit: usd,`);
}

const DAY = '2026-09-17T12:00:00Z';
const log = (from: string, value: bigint, i: number): Omit<TransferLog, 'timestamp'> => ({ blockNumber: blockAt(DAY), logIndex: i, txHash: `0x${i}`, from, value });
const fees = (r: FetchResult) => r.written.filter((w) => w.metricKey === 'flow_usd.fees').map((w) => w.value);
const scan = (r: FetchResult) => r.sources.find((s) => s.sourceId.startsWith('transfer_flow:'))!;

describe('cloneImplementation (EIP-1167)', () => {
  it('reads the implementation of a plain clone and of a clone with immutable args', () => {
    expect(cloneImplementation(clone(IMPL))).toBe(IMPL);
    expect(cloneImplementation(clone(IMPL, 'deadbeef'))).toBe(IMPL);
    expect(cloneImplementation(clone(IMPL.toUpperCase().replace('0X', '0x')))).toBe(IMPL);
  });
  it('is null for anything else', () => {
    expect(cloneImplementation('0x')).toBeNull();
    expect(cloneImplementation('0x6080604052')).toBeNull();
    expect(cloneImplementation(clone(IMPL).replace('5af43d', '5af43e'))).toBeNull();
  });
});

describe('transfer_flow ignore rules', () => {
  it('rule 1: a zero-amount transfer from an unlisted sender is not reported', async () => {
    const h = harness({ loaded: parseAssetYaml(INGEST_ASSET_YAML), logs: [log(STRANGER, 0n, 0), log(POOL, 2n * E18, 1)] });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(scan(r).unlistedTransfers).toEqual([]);
    expect(r.anomalies.filter((a) => a.kind === 'unlisted_sender')).toEqual([]);
    expect(scan(r).notes).toContain('not counted, as configured: 1 zero-amount');
    expect(fees(r)).toEqual([0, 20, 0]);
  });

  it('rule 1 does not hide a non-zero transfer from the same stranger', async () => {
    const h = harness({ loaded: parseAssetYaml(INGEST_ASSET_YAML), logs: [log(STRANGER, 0n, 0), log(STRANGER, 1n, 1)] });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(scan(r).unlistedTransfers.map((t) => t.txHash)).toEqual(['0x1']);
  });

  it('rule 2: a from_ignore sender is neither counted nor reported; a stranger still is', async () => {
    const logs = [log(FORWARDER, 5n * E18, 0), log(POOL, 2n * E18, 1), log(STRANGER, 1n * E18, 2)];
    const h = harness({ loaded: parseAssetYaml(withIgnore({ ignore: ['forwarder'] })), logs });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(scan(r).unlistedTransfers.map((t) => t.from)).toEqual([STRANGER]);
    expect(scan(r).notes).toContain('not counted, as configured: 1 from from_ignore senders');
    expect(fees(r)).toEqual([0, 20, 0]); // the pool only, as without the rule
  });

  it('rule 3: clones of an ignored implementation are neither counted nor reported; other clones are', async () => {
    const logs = [log(SIDECAR, 5n * E18, 0), log(SIDECAR, 1n * E18, 1), log(OTHER_CLONE, 1n * E18, 2), log(POOL, 2n * E18, 3)];
    const h = harness({
      loaded: parseAssetYaml(withIgnore({ clones: ['sidecar_impl'] })),
      logs,
      code: { [SIDECAR]: clone(IMPL, 'abcd'), [OTHER_CLONE]: clone(OTHER_IMPL) },
    });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(scan(r).unlistedTransfers.map((t) => t.from)).toEqual([OTHER_CLONE]);
    expect(scan(r).notes).toContain('not counted, as configured: 2 from ignored clones');
    expect(fees(r)).toEqual([0, 20, 0]);
    expect(h.rpc.stats.getCode).toBe(2); // once per distinct unlisted sender, not per transfer
  });

  it('no rule changes a stored value: the same logs give the same rows with and without the lists', async () => {
    const logs = [log(FORWARDER, 5n * E18, 0), log(SIDECAR, 3n * E18, 1), log(POOL, 2n * E18, 2), log(SAFE, 4n * E18, 3), log(STRANGER, 0n, 4)];
    const rows = async (yaml: string) => {
      const h = harness({ loaded: parseAssetYaml(yaml), logs, code: { [SIDECAR]: clone(IMPL) } });
      await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
      return ['flow_usd.fees', 'flow_tokens.fees', 'flow_usd.fees_programmatic'].map((k) => listActiveObservations(h.db, 'mini', k).map((o) => [o.observedAt, o.value]));
    };
    expect(await rows(withIgnore({ ignore: ['forwarder'], clones: ['sidecar_impl'] }))).toEqual(await rows(INGEST_ASSET_YAML));
  });

  it('the ignore lists leave the scan key (and its cursor) and the source id alone', () => {
    const before = buildPlan(parseAssetYaml(INGEST_ASSET_YAML).config).flowGroups[0];
    const after = buildPlan(parseAssetYaml(withIgnore({ ignore: ['forwarder'], clones: ['sidecar_impl'] })).config).flowGroups[0];
    expect([after.scanKey, after.sourceId]).toEqual([before.scanKey, before.sourceId]);
    expect([after.ignore, after.ignoreClonesOf]).toEqual([[FORWARDER], [IMPL]]);
  });

  it('refuses a sender on both the allowlist and an ignore list', () => {
    expect(() => parseAssetYaml(withIgnore({ ignore: ['pool'] }))).toThrow(/pool is on from_allowlist and on an ignore list/);
  });
});
