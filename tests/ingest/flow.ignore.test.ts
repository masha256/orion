import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { cloneImplementation, ERC4626_DEPOSIT_TOPIC, mintDepositor } from '../../src/ingest/flow.js';
import { buildPlan } from '../../src/ingest/plan.js';
import { fetchAsset, type FetchResult } from '../../src/ingest/run.js';
import type { ReceiptLog, TransferLog } from '../../src/ingest/transport/rpc.js';
import { GENESIS_TS, harness } from '../helpers/fetchHarness.js';
import { SINK, INGEST_ASSET_YAML, POOL, SAFE, TOKEN } from '../helpers/ingestAsset.js';

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

const ZERO = '0x0000000000000000000000000000000000000000';
const CONVERTER = '0x5555555555555555555555555555555555555555';
const KEEPER = '0x2468246824682468246824682468246824682468';
const word = (x: bigint | string) => (typeof x === 'bigint' ? x.toString(16) : x.replace(/^0x/, '')).padStart(64, '0');
/** The vault's ERC-4626 Deposit(sender, owner, assets, shares), as a receipt log. */
const deposit = (vault: string, sender: string, owner: string, shares: bigint, logIndex: number): ReceiptLog => ({
  address: vault.toLowerCase(), topics: [ERC4626_DEPOSIT_TOPIC, `0x${word(sender)}`, `0x${word(owner)}`], data: `0x${word(shares + 7n)}${word(shares)}`, logIndex,
});
const withMint = (lines: { ignore?: string[]; mint?: boolean }) =>
  withIgnore({ ignore: lines.ignore })
    .replace(`  forwarder: "${FORWARDER}"\n`, `  forwarder: "${FORWARDER}"\n  converter: "${CONVERTER}"\n`)
    .replace(', , unit: usd,', ', unit: usd,')
    .replace('from_allowlist: [pool, safe], ', `from_allowlist: [pool, safe], ${lines.mint ? 'mint_sender: erc4626_deposit, ' : ''}`);

describe('mint_sender: erc4626_deposit', () => {
  const mint = (shares: bigint, tx: string, i: number) => ({ blockNumber: blockAt(DAY), logIndex: i, txHash: tx, from: ZERO, value: shares });

  it('mintDepositor picks the vault Deposit owned by the sink with the minted shares', () => {
    const sink = SINK.toLowerCase();
    const vault = TOKEN.toLowerCase();
    const logs = [
      deposit(vault, KEEPER, '0x1234567890123456789012345678901234567890', 5n, 3), // another owner
      deposit('0x' + 'ab'.repeat(20), KEEPER, sink, 5n, 4), // another vault
      deposit(vault, KEEPER, sink, 6n, 5), // other shares
      deposit(vault, CONVERTER, sink, 5n, 9),
    ];
    expect(mintDepositor(logs, vault, sink, 5n, 8)).toBe(CONVERTER);
    expect(mintDepositor(logs.slice(0, 3), vault, sink, 5n, 8)).toBeNull();
  });

  it('a mint whose depositor is on from_ignore is neither counted nor reported', async () => {
    const tx = '0xm1';
    const h = harness({
      loaded: parseAssetYaml(withMint({ ignore: ['converter'], mint: true })),
      logs: [mint(3n * E18, tx, 1), log(POOL, 2n * E18, 5)],
      receipts: { [tx]: [deposit(TOKEN, CONVERTER, SINK, 3n * E18, 2)] },
    });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(scan(r).unlistedTransfers).toEqual([]);
    expect(scan(r).notes).toEqual(expect.arrayContaining(['1 mint(s) attributed to their ERC-4626 depositor', 'not counted, as configured: 1 from from_ignore senders']));
    expect(fees(r)).toEqual([0, 20, 0]);
  });

  it('a mint with no matching Deposit stays 0x0 and is reported', async () => {
    const h = harness({ loaded: parseAssetYaml(withMint({ ignore: ['converter'], mint: true })), logs: [mint(3n * E18, '0xm2', 1)], receipts: {} });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(scan(r).unlistedTransfers.map((t) => t.from)).toEqual([ZERO]);
  });

  it('a mint attributed to an unlisted depositor is reported under the depositor', async () => {
    const tx = '0xm3';
    const h = harness({ loaded: parseAssetYaml(withMint({ mint: true })), logs: [mint(3n * E18, tx, 1)], receipts: { [tx]: [deposit(TOKEN, KEEPER, SINK, 3n * E18, 2)] } });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(scan(r).unlistedTransfers.map((t) => t.from)).toEqual([KEEPER]);
  });

  it('without mint_sender, no receipt is read and a mint stays 0x0', async () => {
    const h = harness({ loaded: parseAssetYaml(withMint({ ignore: ['converter'] })), logs: [mint(3n * E18, '0xm4', 1)] });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(h.rpc.stats.receipts).toBe(0);
    expect(scan(r).unlistedTransfers.map((t) => t.from)).toEqual([ZERO]);
  });
});


/** The mini asset with its fees and token flows on a from_any scan (the programmatic member, a count_from, is dropped). */
function withAnySender(ignore: string[]): string {
  return INGEST_ASSET_YAML
    .replace(`  safe: "${SAFE}"\n`, `  safe: "${SAFE}"\n  forwarder: "${FORWARDER}"\n`)
    .replaceAll('from_allowlist: [pool, safe], unit:', `from_any: true, from_ignore: [${ignore.join(', ')}], unit:`)
    .replace(/\n  flow_usd\.fees_programmatic:[\s\S]*?count_from: \[pool\][^\n]*\n/, '\n');
}

describe('transfer_flow from_any', () => {
  it('counts every sender but the ignored ones, reports none as unlisted, and keeps per-sender totals by address', async () => {
    const logs = [log(FORWARDER, 5n * E18, 0), log(POOL, 2n * E18, 1), log(STRANGER, 1n * E18, 2)];
    const loaded = parseAssetYaml(withAnySender(['forwarder']));
    const h = harness({ loaded, logs });
    const r = await fetchAsset(h.db, h.loaded, h.deps.now(), h.deps);
    expect(scan(r).sourceId).toBe('transfer_flow:token>burn_sink[*]');
    expect(scan(r).unlistedTransfers).toEqual([]);
    expect(r.anomalies.filter((a) => a.kind === 'unlisted_sender')).toEqual([]);
    expect(scan(r).notes).toContain('not counted, as configured: 1 from from_ignore senders');
    expect(fees(r)).toEqual([0, 30, 0]); // pool 2 + stranger 1 tokens at 10 USD; the ignored 5 left out
    const day = listActiveObservations(h.db, 'mini').find((o) => o.metricKey === 'flow_usd.fees' && o.value === 30)!;
    expect(Object.keys(JSON.parse(day.sourceDetail!).senders).sort()).toEqual([POOL, STRANGER].sort());
    expect(buildPlan(h.loaded.config).flowGroups[0].anySender).toBe(true);
  });

  it('needs exactly one of from_allowlist and from_any, and refuses count_from with from_any', () => {
    const both = INGEST_ASSET_YAML.replace('from_allowlist: [pool, safe], unit: tokens', 'from_allowlist: [pool, safe], from_any: true, unit: tokens');
    expect(() => parseAssetYaml(both)).toThrow(/exactly one of from_allowlist and from_any/);
    const neither = INGEST_ASSET_YAML.replace('from_allowlist: [pool, safe], unit: tokens', 'unit: tokens');
    expect(() => parseAssetYaml(neither)).toThrow(/exactly one of from_allowlist and from_any/);
    const counted = INGEST_ASSET_YAML.replace('from_allowlist: [pool, safe], count_from: [pool]', 'from_any: true, count_from: [pool]');
    expect(() => parseAssetYaml(counted)).toThrow(/count_from picks from an allowlist/);
  });
});
