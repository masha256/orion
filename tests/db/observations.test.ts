import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/connection.js';
import {
  confirmObservation,
  getObservationsByIds,
  getProvenanceByIds,
  insertObservation,
  listActiveObservations,
  listActiveProvenance,
  rejectObservation,
} from '../../src/db/observations.js';
import type { Provenance } from '../../src/provenance/types.js';
import { useTestDb } from '../helpers/db.js';
import { TEST_PROVENANCE } from '../helpers/provenance.js';

const BY = { approvedBy: 'test', configHash: 'test' };

const testDb = useTestDb();

const base = { assetId: 'mini', metricKey: 'price_usd', source: 'manual' as const, fetchedAt: '2026-06-30T00:00:00Z' };
let db: Db;
beforeEach(() => {
  db = testDb();
});

describe('observations', () => {
  it('normalizes timestamps to ISO', async () => {
    const o = await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 10 });
    expect(o.observedAt).toBe('2026-06-30T00:00:00.000Z');
    expect(o.status).toBe('confirmed');
  });

  it('rejects an invalid timestamp', async () => {
    await expect(insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: 'not-a-date', value: 1 })).rejects.toThrow(/timestamp/);
  });

  it('supersedes an active row with the same metric and observed_at', async () => {
    const first = await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 10 });
    const second = await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 11 });
    const active = await listActiveObservations(db, 'mini', 'price_usd');
    expect(active.map((o) => o.id)).toEqual([second.id]);
    expect((await getObservationsByIds(db, [first.id]))[0].supersededBy).toBe(second.id);
  });

  it('refuses a period length that is not a positive finite number', async () => {
    for (const periodDays of [0, -30, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 1, periodDays })).rejects.toThrow(/period/);
    }
    expect((await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 1, periodDays: null })).periodDays).toBeNull();
  });

  it('requires a citation for provisional rows', async () => {
    await expect(insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 1, status: 'provisional' })).rejects.toThrow(/citation/);
  });

  it('confirm inserts a confirmed copy that supersedes the provisional row', async () => {
    const p = await insertObservation(db, {
      provenance: TEST_PROVENANCE,
      ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a', quotedText: 'five',
    });
    const c = await confirmObservation(db, p.id, '2026-07-01T00:00:00Z', BY);
    expect(c.status).toBe('confirmed');
    expect(c.value).toBe(5);
    expect(c.citationUrl).toBe('https://example.com/a');
    expect((await listActiveObservations(db, 'mini')).map((o) => o.id)).toEqual([c.id]);
  });

  it('reject removes a provisional row from the active set but keeps the row', async () => {
    const p = await insertObservation(db, {
      provenance: TEST_PROVENANCE,
      ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a',
    });
    await rejectObservation(db, p.id);
    expect(await listActiveObservations(db, 'mini')).toEqual([]);
    expect((await getObservationsByIds(db, [p.id]))[0].status).toBe('rejected');
  });

  it('a provisional insert supersedes only provisional rows, never a confirmed one', async () => {
    const confirmed = await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 10 });
    const first = await insertObservation(db, {
      provenance: TEST_PROVENANCE,
      ...base, observedAt: '2026-06-30', value: 11, status: 'provisional', citationUrl: 'https://example.com/a',
    });
    expect((await listActiveObservations(db, 'mini')).map((o) => o.id)).toEqual([confirmed.id, first.id]);

    const second = await insertObservation(db, {
      provenance: TEST_PROVENANCE,
      ...base, observedAt: '2026-06-30', value: 12, status: 'provisional', citationUrl: 'https://example.com/b',
    });
    expect((await getObservationsByIds(db, [first.id]))[0].supersededBy).toBe(second.id);
    expect((await listActiveObservations(db, 'mini')).map((o) => o.id)).toEqual([confirmed.id, second.id]);

    // confirming still retires the provisional row, and the earlier confirmed row with it
    const c = await confirmObservation(db, second.id, '2026-07-01T00:00:00Z', BY);
    expect((await listActiveObservations(db, 'mini')).map((o) => o.id)).toEqual([c.id]);
  });

  it('refuses to confirm a row that is not an active provisional row', async () => {
    const o = await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 10 });
    await expect(confirmObservation(db, o.id, '2026-07-01T00:00:00Z', BY)).rejects.toThrow(/provisional/);
  });

  it('reject retires an active confirmed row so a bad entry can be taken out of the window', async () => {
    const o = await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 10 });
    await rejectObservation(db, o.id);
    expect(await listActiveObservations(db, 'mini')).toEqual([]);
    expect((await getObservationsByIds(db, [o.id]))[0].status).toBe('rejected');
  });

  it('refuses to reject a superseded or already rejected row', async () => {
    const first = await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 10 });
    const second = await insertObservation(db, { provenance: TEST_PROVENANCE, ...base, observedAt: '2026-06-30', value: 11 });
    await expect(rejectObservation(db, first.id)).rejects.toThrow(/not active/);
    await rejectObservation(db, second.id);
    await expect(rejectObservation(db, second.id)).rejects.toThrow(/not active/);
  });
});

describe('provenance columns (0004)', () => {
  const full: Provenance = {
    method: 'measured', sourceType: 'log_scan', chain: 'eip155:1',
    locator: { contracts: ['0x1111'], event: 'Transfer(address,address,uint256)', endpoint: 'https://eth-mainnet.g.alchemy.com/v2/abc_123456789?apikey=k' },
    blockFrom: 10, blockTo: 20, txCount: 2, txRefs: ['0xa:1', '0xb:2'], txDigest: 'd', responseDigest: null, inputs: null, formula: null, coverage: null,
    codeVersion: 'abc123', configHash: 'h1',
  };

  it('writes and reads every provenance column; value, source and source_detail exactly as given; the locator scrubbed', async () => {
    const o = await insertObservation(db, { ...base, source: 'onchain', sourceDetail: '{"day":"2026-06-29"}', observedAt: '2026-06-30', value: 0.1 + 0.2, provenance: full });
    expect(o).toMatchObject({ value: 0.1 + 0.2, source: 'onchain', sourceDetail: '{"day":"2026-06-29"}' });
    expect(Object.keys(o)).not.toContain('provenance'); // readers of Observation see the same shape as before
    const [p] = await getProvenanceByIds(db, [o.id]);
    expect(p).toEqual({
      id: o.id, metricKey: 'price_usd', observedAt: '2026-06-30T00:00:00.000Z', periodDays: null, status: 'confirmed',
      method: 'measured', sourceType: 'log_scan', chain: 'eip155:1',
      locator: { contracts: ['0x1111'], event: 'Transfer(address,address,uint256)', endpoint: 'https://eth-mainnet.g.alchemy.com/v2' },
      blockFrom: 10, blockTo: 20, txCount: 2, txRefs: ['0xa:1', '0xb:2'], txDigest: 'd', responseDigest: null, inputs: null, formula: null, coverage: null,
      codeVersion: 'abc123', configHash: 'h1',
    });
    expect((await listActiveProvenance(db, 'mini', ['price_usd'])).map((r) => r.id)).toEqual([o.id]);
  });

  it('refuses more than 50 tx refs, an unknown method, and a missing code version or config hash', async () => {
    const at = { ...base, observedAt: '2026-06-30', value: 1 };
    await expect(insertObservation(db, { ...at, provenance: { ...full, txRefs: Array.from({ length: 51 }, (_, i) => `0x${i}:0`) } })).rejects.toThrow(/at most 50/);
    await expect(insertObservation(db, { ...at, provenance: { ...full, method: 'guessed' as never } })).rejects.toThrow(/unknown provenance method/);
    await expect(insertObservation(db, { ...at, provenance: { ...full, configHash: '' } })).rejects.toThrow(/config hash/);
    expect(await listActiveObservations(db, 'mini')).toEqual([]);
  });

  it('a release-N-1 insert without the new columns still succeeds on 0004', async () => {
    // The insert release orion-2026.11.04.2 (f5f36fa) makes: src/db/observations.ts insertObservation's statement, verbatim.
    const inserted = await db.run<{ id: number }>(
      `INSERT INTO observations
         (asset_id, metric_key, observed_at, period_days, value, source, source_detail, status, citation_url, quoted_text, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      ['mini', 'price_usd', '2026-06-30T00:00:00.000Z', null, 10, 'api', 'coingecko /coins/markets mini.current_price', 'confirmed', null, null, '2026-06-30T00:00:00.000Z'],
    );
    const id = Number(inserted.rows[0]!.id);
    expect((await getObservationsByIds(db, [id]))[0]).toMatchObject({ value: 10, source: 'api' });
    expect((await getProvenanceByIds(db, [id]))[0]).toMatchObject({ method: null, sourceType: null, locator: null, codeVersion: null, configHash: null });
    // And the CHECKs allow NULL but refuse a value outside the ladder.
    await expect(db.run("UPDATE observations SET source_type = 'indexer' WHERE id = $1", [id])).rejects.toThrow(/source_type_check/);
    await expect(db.run("UPDATE observations SET method = 'guessed' WHERE id = $1", [id])).rejects.toThrow(/method_check/);
  });

  it('confirm copies the provisional row\'s provenance and records who approved it', async () => {
    const disclosed: Provenance = { method: 'disclosed', sourceType: 'disclosure', chain: null, locator: { citation_url: 'https://example.com/a', approved_by: null, approved_at: null }, codeVersion: 'old', configHash: 'h0' };
    const p = await insertObservation(db, { ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a', provenance: disclosed });
    const c = await confirmObservation(db, p.id, '2026-07-01T00:00:00.000Z', { approvedBy: 'user', configHash: 'h1' });
    expect((await getProvenanceByIds(db, [c.id]))[0]).toMatchObject({
      method: 'disclosed', sourceType: 'disclosure', locator: { citation_url: 'https://example.com/a', approved_by: 'user', approved_at: '2026-07-01T00:00:00.000Z' },
      codeVersion: 'dev', configHash: 'h0',
    });
  });
});
