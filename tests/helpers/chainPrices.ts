import type { Db } from '../../src/db/connection.js';
import { MS_PER_HOUR, upsertPrices, upsertToken, type PriceRow } from '../../src/db/prices.js';
import type { ChainPriceWriter } from '../../src/ingest/flow.js';
import type { WriteResult } from '../../src/prices/types.js';

/** The source the fake writer stores under: a chain source, so flow_usd_chain_v and the flow scan read it. */
export const FAKE_PRICE_SOURCE = 'chain:test';
/** The fetched_at of every fake row (fixed, so a test's rows do not depend on the clock). */
export const FAKE_FETCHED_AT = '2026-01-01T00:00:00.000Z';

export interface FakePriceWriter extends ChainPriceWriter {
  calls: { refs: string[]; fromHourMs: number; toHourMs: number; dryRun: boolean }[];
}

/**
 * A stand-in for writeChainPrices (Phase 3 R2 Task 6a): writes `priceOf(ref, hourMs)` for every hour of the range under
 * FAKE_PRICE_SOURCE, or `sourceOf(ref)` (a ref's primary source, as the real writer stores it) (null: no row, the hour is `missing`); on a dry run returns the rows and writes nothing (R19).
 * Tests that seeded a CoinGecko market_chart for a flow use it with the same prices, so the flow values do not move.
 */
export function fakePriceWriter(
  priceOf: (ref: string, hourMs: number) => number | null, extra: Partial<WriteResult> = {}, sourceOf: (ref: string) => string = () => FAKE_PRICE_SOURCE,
): FakePriceWriter {
  const calls: FakePriceWriter['calls'] = [];
  const writer = async (db: Db, refs: string[], fromHourMs: number, toHourMs: number, opts: { dryRun?: boolean } = {}): Promise<WriteResult> => {
    const dryRun = opts.dryRun ?? false;
    calls.push({ refs: [...refs], fromHourMs, toHourMs, dryRun });
    const result: WriteResult = {
      written: {}, skippedExisting: 0, missing: [], breaches: [], calls: {}, reachedMs: fromHourMs, stoppedByBudget: false, stoppedBySignal: false, errors: [],
      ...(dryRun ? { rows: {} } : {}), ...extra,
    };
    for (const ref of [...new Set(refs)]) {
      const rows: PriceRow[] = [];
      for (let h = fromHourMs; h < toHourMs; h += MS_PER_HOUR) {
        const p = priceOf(ref, h);
        if (p === null) result.missing.push({ ref, hourMs: h, reason: 'not_priced' });
        else rows.push({ ts: new Date(h).toISOString(), priceUsd: p, checkGapPct: null, check: 'test', detail: null });
      }
      result.written[ref] = rows.length;
      if (dryRun) {
        result.rows![ref] = rows;
        continue;
      }
      await upsertToken(db, { tokenRef: ref, symbol: ref.slice(-6), decimals: null, coingeckoId: null });
      await upsertPrices(db, ref, sourceOf(ref), rows, FAKE_FETCHED_AT);
    }
    return result;
  };
  return Object.assign(writer, { calls });
}

/** Seeds chain prices directly (no writer): `priceOf` for every hour in [fromIso, toIso). */
export async function seedChainPrices(db: Db, ref: string, fromIso: string, toIso: string, priceOf: (hourMs: number) => number | null): Promise<void> {
  const rows: PriceRow[] = [];
  for (let h = Date.parse(fromIso); h < Date.parse(toIso); h += MS_PER_HOUR) {
    const p = priceOf(h);
    if (p !== null) rows.push({ ts: new Date(h).toISOString(), priceUsd: p });
  }
  await upsertToken(db, { tokenRef: ref, symbol: ref.slice(-6), decimals: null, coingeckoId: null });
  await upsertPrices(db, ref, FAKE_PRICE_SOURCE, rows, FAKE_FETCHED_AT);
}
