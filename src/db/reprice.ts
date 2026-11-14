import { lockHolder, withRunLock } from '../app/lock.js';
import type { LoadedAsset } from '../config/load.js';
import { derivedFunction, type DerivedName } from '../ingest/derived.js';
import { addDays, isIsoDate, utcDay } from '../ingest/time.js';
import { codeVersion } from '../provenance/types.js';
import { MS_PER_DAY, OrionError } from '../types.js';
import type { Db, OrionDb } from './connection.js';
import { chainHourPrices, CHAIN_PRICE_MAX_AGE_HOURS, HOURS_PER_DAY, MS_PER_HOUR, solanaTokenRef } from './prices.js';
import { exportStamp, fsyncDir, writeDurableExport } from './purge.js';

/**
 * `orion data reprice` (Phase 3 R2 plan P4, Ruling R26): rewrites, in place, the stored `value` of every active USD flow
 * row whose dollars were CoinGecko-priced when it was written, from the chain/first-party prices flow_usd_chain_v reads:
 * - (a) transfer-scan rows (rung `log_scan`, token + 24 hourly amounts): value = sum over the hours with an amount of
 *   amount x the hour's price (the newest chain row at or before the hour, at most 6 h old: the view's `hourly`);
 * - (b) Solana supply-drop rows (`locator.adapter` solana.supply_burn_daily) on chain days: value = the day's amount x the
 *   mean of its 24 chain hours (the view's `daily_mean`). A row written before 0005 has no amount: it takes the amount
 *   of its `flow_tokens.*` twin (same asset and observed_at) and the mint's ref. Days that began before the first stored
 *   supply reading (not rejected) are DefiLlama dollars (the adapter's `history`): skipped (R6), never refused.
 * Skipped by design (counted by reason): dollars a first-party API reports (`usd_native`), third-party (DefiLlama) rows,
 * disclosed/manual rows, derived rows, periodic rows (period > 1 day), anything else not CoinGecko-priced at write.
 * Refused (listed; the row keeps its value): a CoinGecko-priced row with an hour that has an amount and no chain price
 * (Review Focus 5), fewer than 24 priced hours on the daily mean, no tokens, or no twin amount.
 *
 * In the same pass: the `coingecko:crvusd` / `coingecko:yearn-crv` token refs of the asset's rows (every row, every
 * metric) become the crvUSD / yCRV address refs before those rows are priced; the stored `derived` rows over a repriced
 * flow (burn_momentum, flow_annualized) whose window holds a day this run prices or one already marked (Ruling R30: a
 * rerun after an interrupted --yes, a 0 -> 0 day) are recomputed with src/ingest/derived.ts at their own observed_at
 * and written only where the value differs. Every changed row gets `locator.repriced = { at, release, basis }`.
 *
 * A dry run by default (no lock, no write, no file). `yes`: under the asset's run lock, the plan is made, every row it
 * touches is written whole (to_jsonb) to `<exportDir>/<asset>-<UTCstamp>.json` (fsynced, as `data purge`), then one
 * transaction per asset-day applies it, each update guarded by the old value. A row already at its new value that
 * carries the marker is unchanged, so a second `--yes` writes nothing and no export.
 */

/** P4's token-ref remap: the CoinGecko ids flows were priced under, to the address refs prices.yaml prices. */
export const COINGECKO_REF_REMAP: Readonly<Record<string, { ref: string; symbol: string; decimals: number }>> = {
  'coingecko:crvusd': { ref: 'eip155:1/0xf939e0a03fb07f59a73314e73794be0e57ac1b4e', symbol: 'crvUSD', decimals: 18 },
  'coingecko:yearn-crv': { ref: 'eip155:1/0xfcc5c47be19d06bf83eb04298b026f81069ff65b', symbol: 'yCRV', decimals: 18 },
};

export const SUPPLY_BURN_ADAPTER = 'solana.supply_burn_daily';

export type RepriceBasis = 'hourly' | 'daily_mean';

export interface RepriceRefusal {
  id: number;
  day: string;
  reason: string;
}

export interface RepriceMetric {
  metric: string;
  /** Active rows of the metric in range. */
  rows: number;
  /** Rows whose value (or tokens, or marker) the reprice changes. */
  repriced: number;
  /** CoinGecko-priced rows already at their new value with the marker (a second run). */
  unchanged: number;
  refused: RepriceRefusal[];
  /** Rows not repriceable by design, by reason. */
  skipped: Record<string, number>;
  /** Sum of value before and after, over the repriced rows. */
  oldSum: number;
  newSum: number;
  /**
   * Ruling R33: superseded or rejected rows (in range) of the CoinGecko-priced classes (a transfer scan, a Solana
   * supply-drop chain day): never rewritten (history no report reads), counted so the dry run shows what keeps its
   * write-time CoinGecko value; Mike decides keep vs purge (R8 at the latest).
   */
  inactiveCoingeckoRows: number;
}

export interface RepriceDerived {
  metric: string;
  /** Stored active rows in range. */
  rows: number;
  recomputed: number;
  /** Rows whose window holds a repriced day and whose recomputed value equals the stored one. */
  unchanged: number;
  /** Rows whose window is no longer complete (left as they are). */
  incomplete: number;
}

export interface RepriceResult {
  asset: string;
  from: string | null;
  applied: boolean;
  perMetric: RepriceMetric[];
  derived: RepriceDerived[];
  remapped: { from: string; to: string; rows: number }[];
  /** Asset-days written (one transaction each); 0 on a dry run or when nothing changes. */
  days: number;
  exportFile: string | null;
  exportSha256: string | null;
}

export interface RepriceOptions {
  /** First UTC day (YYYY-MM-DD) whose rows are repriced; default every day. */
  from?: string;
  yes: boolean;
  now: Date;
  /** `$ORION_HOME/repriced` from the CLI. */
  exportDir: string;
  /** The release (tag) the marker names; default the running code version. */
  release?: string;
  /** Test seam: fsyncs one directory. */
  syncDir?: (dir: string) => void;
}

interface Row {
  id: number;
  metric_key: string;
  observed_at: string;
  period_days: number | null;
  value: number;
  method: string;
  source_type: string;
  locator: Record<string, unknown> | null;
  token_ref: string | null;
  amount: number | null;
  hourly_amounts: number[] | null;
}

/** One planned row write. */
interface Write {
  id: number;
  metric: string;
  day: string;
  oldValue: number;
  newValue: number;
  oldTokenRef: string | null;
  newTokenRef: string | null;
  newAmount: number | null;
  /** The marker to set; null for a remap-only row. */
  basis: RepriceBasis | 'derived' | null;
}

const ACTIVE = "superseded_by IS NULL AND status <> 'rejected'";
const ROW_COLS = 'id, metric_key, observed_at, period_days, value, method, source_type, locator, token_ref, amount, hourly_amounts';

const iso = (v: unknown): string => new Date(v as string).toISOString();
/** The UTC day a daily row covers (stamped at the day's end), as run.ts reads it. */
const dayOf = (observedAt: string): string => utcDay(Date.parse(observedAt) - MS_PER_DAY);
const remapOf = (ref: string | null): string | null => (ref !== null && COINGECKO_REF_REMAP[ref] ? COINGECKO_REF_REMAP[ref]!.ref : ref);

export async function repriceAsset(db: OrionDb, loaded: LoadedAsset, opts: RepriceOptions): Promise<RepriceResult> {
  const asset = loaded.config.id;
  if (opts.from !== undefined && !isIsoDate(opts.from)) throw new OrionError('invalid_day', `--from must be a UTC day YYYY-MM-DD, got ${opts.from}`);
  const release = opts.release ?? codeVersion();
  const marker = (basis: string) => JSON.stringify({ at: opts.now.toISOString(), release, basis });
  if (!opts.yes) return (await planReprice(db, loaded, opts.from)).result;

  return await withRunLock(db, asset, lockHolder('orion data reprice'), opts.now, async () => {
    const plan = await planReprice(db, loaded, opts.from);
    const writes = [...plan.remapOnly, ...plan.flows, ...plan.derived];
    if (writes.length === 0) return plan.result;
    const ids = [...new Set(writes.map((w) => w.id))].sort((a, b) => a - b);
    const rows = (await db.all<{ row: unknown }>('SELECT to_jsonb(o) AS row FROM observations o WHERE id = ANY($1::bigint[]) ORDER BY id', [ids])).map((r) => r.row);
    // On disk (fsynced) before the first write; a failure throws with nothing written.
    const { file, sha256 } = writeDurableExport(opts.exportDir, `${asset}-${exportStamp(opts.now)}.json`, {
      asset, from: opts.from ?? null, createdAt: opts.now.toISOString(), release,
      perMetric: plan.result.perMetric, derivedSummary: plan.result.derived, remapped: plan.result.remapped,
      derived: plan.derived.map((w) => ({ id: w.id, metric: w.metric, day: w.day, oldValue: w.oldValue, newValue: w.newValue })),
      observations: rows,
    }, opts.syncDir ?? fsyncDir, 'reprice_export_failed', 'nothing was repriced');

    const byDay = new Map<string, Write[]>();
    for (const w of writes) byDay.set(w.day, [...(byDay.get(w.day) ?? []), w]);
    const days = [...byDay.keys()].sort();
    for (const day of days) {
      const dayWrites = byDay.get(day)!;
      await db.tx(async (t) => {
        // The address refs' tokens rows first (yCRV may have none yet): the observations FK needs them.
        for (const to of new Set(dayWrites.filter((w) => w.newTokenRef !== w.oldTokenRef).map((w) => w.newTokenRef!))) {
          const info = Object.values(COINGECKO_REF_REMAP).find((x) => x.ref === to);
          if (info) {
            await t.run('INSERT INTO tokens (token_ref, symbol, decimals, peg, coingecko_id) VALUES ($1, $2, $3, NULL, NULL) ON CONFLICT (token_ref) DO NOTHING', [info.ref, info.symbol, info.decimals]);
          }
        }
        // Remaps before the value writes (a remap-only row and a repriced row are distinct writes of distinct rows).
        const ordered = [...dayWrites.filter((w) => w.basis === null), ...dayWrites.filter((w) => w.basis !== null && w.basis !== 'derived'), ...dayWrites.filter((w) => w.basis === 'derived')];
        for (const w of ordered) {
          const res = await t.run(
            `UPDATE observations SET value = $2, token_ref = $3, amount = COALESCE($4::float8, amount),
                    locator = CASE WHEN $5::jsonb IS NULL THEN locator ELSE COALESCE(locator, '{}'::jsonb) || jsonb_build_object('repriced', $5::jsonb) END
              WHERE id = $1 AND asset_id = $6 AND value = $7 AND token_ref IS NOT DISTINCT FROM $8`,
            [w.id, w.newValue, w.newTokenRef, w.newAmount, w.basis === null ? null : marker(w.basis), asset, w.oldValue, w.oldTokenRef],
          );
          if (res.rowCount !== 1) throw new OrionError('reprice_conflict', `observation #${w.id} (${w.metric} ${w.day}) changed since the plan was exported; this day was rolled back`);
        }
      }, { lockAsset: asset });
    }
    return { ...plan.result, applied: true, days: days.length, exportFile: file, exportSha256: sha256 };
  });
}

interface Plan {
  result: RepriceResult;
  remapOnly: Write[];
  flows: Write[];
  derived: Write[];
}

/** Reads only: classifies every active USD flow row in range, prices the repriceable ones, recomputes the derived rows. */
async function planReprice(db: Db, loaded: LoadedAsset, from: string | undefined): Promise<Plan> {
  const { config } = loaded;
  const asset = config.id;
  const inRange = (day: string): boolean => from === undefined || day >= from;

  // P4 remap: every row of the asset under a CoinGecko id ref, whatever its metric or status.
  const remapRows = await db.all<{ id: number; metric_key: string; observed_at: string; value: number; token_ref: string }>(
    'SELECT id, metric_key, observed_at, value, token_ref FROM observations WHERE asset_id = $1 AND token_ref = ANY($2::text[]) ORDER BY id',
    [asset, Object.keys(COINGECKO_REF_REMAP)],
  );
  const remapped = Object.entries(COINGECKO_REF_REMAP)
    .map(([fromRef, { ref }]) => ({ from: fromRef, to: ref, rows: remapRows.filter((r) => r.token_ref === fromRef).length }))
    .filter((r) => r.rows > 0);

  const all = (await db.all<Row>(
    `SELECT ${ROW_COLS} FROM observations WHERE asset_id = $1 AND ${ACTIVE} AND period_days IS NOT NULL AND starts_with(metric_key, 'flow_usd.') ORDER BY observed_at, id`,
    [asset],
  )).map((r) => ({ ...r, observed_at: iso(r.observed_at) }));
  const rows = all.filter((r) => inRange(dayOf(r.observed_at)));

  // The supply-drop context: the first stored supply reading per supply metric, and the flow_tokens twins.
  const firstReading = new Map<string, number | null>();
  const supplyStart = async (metric: string): Promise<number | null> => {
    const params = (config.metrics[metric]?.source as { params?: Record<string, unknown> } | undefined)?.params ?? {};
    const supply = typeof params.supply_metric === 'string' ? params.supply_metric : '';
    if (!firstReading.has(supply)) {
      const r = await db.one<{ first: string | null }>(
        "SELECT min(observed_at) AS first FROM observations WHERE asset_id = $1 AND metric_key = $2 AND locator->>'adapter' = 'solana.token_supply' AND status <> 'rejected'",
        [asset, supply],
      );
      firstReading.set(supply, r?.first ? Date.parse(iso(r.first)) : null);
    }
    return firstReading.get(supply)!;
  };
  const mintRefOf = (metric: string): string | null => {
    const params = (config.metrics[metric]?.source as { params?: Record<string, unknown> } | undefined)?.params ?? {};
    const mint = typeof params.mint === 'string' ? (config.contracts[params.mint] ?? params.mint) : null;
    return mint === null ? null : solanaTokenRef(mint);
  };
  const twins = new Map<string, { value: number; token_ref: string | null }>();
  const twinRows = await db.all<{ metric_key: string; observed_at: string; value: number; token_ref: string | null }>(
    `SELECT metric_key, observed_at, value, token_ref FROM observations WHERE asset_id = $1 AND ${ACTIVE} AND starts_with(metric_key, 'flow_tokens.') AND period_days = 1`,
    [asset],
  );
  for (const t of twinRows) twins.set(`${t.metric_key}|${iso(t.observed_at)}`, { value: t.value, token_ref: t.token_ref });

  type Classified =
    | { kind: 'skip'; reason: string }
    | { kind: 'refuse'; reason: string }
    | { kind: 'price'; tokenRef: string; amount: number; hourly: number[] | null; setAmount: number | null };
  const classify = async (r: Row): Promise<Classified> => {
    const adapter = typeof r.locator?.adapter === 'string' ? r.locator.adapter : null;
    if (r.token_ref === 'usd') return { kind: 'skip', reason: 'usd_native' };
    if (r.source_type === 'third_party') return { kind: 'skip', reason: 'third_party' };
    if (r.method === 'disclosed') return { kind: 'skip', reason: 'disclosed' };
    if (r.method === 'derived') return { kind: 'skip', reason: 'derived' };
    if (r.period_days !== 1) return { kind: 'skip', reason: 'periodic' };
    const ref = remapOf(r.token_ref);
    if (r.source_type === 'log_scan') {
      if (ref === null || r.amount === null) return { kind: 'refuse', reason: 'no token amounts' };
      return { kind: 'price', tokenRef: ref, amount: r.amount, hourly: r.hourly_amounts, setAmount: null };
    }
    if (adapter === SUPPLY_BURN_ADAPTER) {
      if (r.amount !== null && ref !== null) return { kind: 'price', tokenRef: ref, amount: r.amount, hourly: null, setAmount: null };
      const first = await supplyStart(r.metric_key);
      const dayStart = Date.parse(`${dayOf(r.observed_at)}T00:00:00.000Z`);
      if (first === null || dayStart < first) return { kind: 'skip', reason: 'defillama_history' };
      const twinMetric = `flow_tokens.${r.metric_key.slice('flow_usd.'.length)}`;
      const twin = twins.get(`${twinMetric}|${r.observed_at}`);
      if (twin === undefined) return { kind: 'refuse', reason: `no amount and no ${twinMetric} twin row` };
      const tokenRef = remapOf(twin.token_ref) ?? ref ?? mintRefOf(r.metric_key);
      if (tokenRef === null) return { kind: 'refuse', reason: 'no token ref' };
      return { kind: 'price', tokenRef, amount: twin.value, hourly: null, setAmount: twin.value };
    }
    return { kind: 'skip', reason: `not_coingecko_priced:${r.source_type}` };
  };

  // Chain prices per ref, one read over the whole range (6 h of lookback before the first hour).
  const priceCache = new Map<string, Map<number, number>>();
  const lookback = CHAIN_PRICE_MAX_AGE_HOURS * MS_PER_HOUR;
  const minMs = rows.length > 0 ? Date.parse(rows[0]!.observed_at) - MS_PER_DAY - lookback : 0;
  const maxMs = rows.length > 0 ? Date.parse(rows[rows.length - 1]!.observed_at) : 0;
  const hoursOf = async (ref: string): Promise<Map<number, number>> => {
    if (!priceCache.has(ref)) priceCache.set(ref, await chainHourPrices(db, ref, minMs, maxMs));
    return priceCache.get(ref)!;
  };

  const perMetric = new Map<string, RepriceMetric>();
  const metricOf = (m: string): RepriceMetric => {
    if (!perMetric.has(m)) perMetric.set(m, { metric: m, rows: 0, repriced: 0, unchanged: 0, refused: [], skipped: {}, oldSum: 0, newSum: 0, inactiveCoingeckoRows: 0 });
    return perMetric.get(m)!;
  };
  const flows: Write[] = [];
  /**
   * Ruling R30: the flow days (by metric) a derived row over them must be recomputed for: every day this run prices
   * (changed or not: a 0 -> 0 day, a day an interrupted earlier run already committed) and every day already carrying
   * the marker. Every planned new flow value by id.
   */
  const repricedDays = new Map<string, Set<string>>();
  const markDay = (metric: string, day: string): void => {
    if (!repricedDays.has(metric)) repricedDays.set(metric, new Set());
    repricedDays.get(metric)!.add(day);
  };
  const isMarked = (r: Row): boolean => r.locator?.repriced !== undefined && r.locator?.repriced !== null;
  for (const r of all) if (isMarked(r)) markDay(r.metric_key, dayOf(r.observed_at));
  // R33: the superseded/rejected rows in range, classified as an active row would be; those of a CoinGecko-priced class
  // (priced or refused, not skipped by design) are counted, never written.
  const inactive = (await db.all<Row>(
    `SELECT ${ROW_COLS} FROM observations WHERE asset_id = $1 AND NOT (${ACTIVE}) AND period_days IS NOT NULL AND starts_with(metric_key, 'flow_usd.') ORDER BY observed_at, id`,
    [asset],
  )).map((r) => ({ ...r, observed_at: iso(r.observed_at) })).filter((r) => inRange(dayOf(r.observed_at)));
  for (const r of inactive) {
    const c = await classify(r);
    if (c.kind !== 'skip') metricOf(r.metric_key).inactiveCoingeckoRows++;
  }
  const newValue = new Map<number, number>();
  for (const r of rows) {
    const m = metricOf(r.metric_key);
    m.rows++;
    const day = dayOf(r.observed_at);
    const c = await classify(r);
    if (c.kind === 'skip') {
      m.skipped[c.reason] = (m.skipped[c.reason] ?? 0) + 1;
      continue;
    }
    if (c.kind === 'refuse') {
      m.refused.push({ id: Number(r.id), day, reason: c.reason });
      continue;
    }
    const hours = await hoursOf(c.tokenRef);
    const start = Date.parse(r.observed_at) - MS_PER_DAY;
    let usd = 0;
    let basis: RepriceBasis;
    if (c.hourly !== null) {
      basis = 'hourly';
      let needed = 0;
      let priced = 0;
      for (let i = 0; i < c.hourly.length; i++) {
        const amt = c.hourly[i]!;
        if (amt === 0) continue;
        needed++;
        const h = start + i * MS_PER_HOUR;
        let p: number | undefined;
        for (let t = h; t >= h - lookback && p === undefined; t -= MS_PER_HOUR) p = hours.get(t);
        if (p === undefined) continue;
        priced++;
        usd += amt * p;
      }
      if (priced < needed) {
        m.refused.push({ id: Number(r.id), day, reason: `${priced} of ${needed} hours with an amount priced` });
        continue;
      }
    } else {
      basis = 'daily_mean';
      let sum = 0;
      let n = 0;
      for (let i = 0; i < HOURS_PER_DAY; i++) {
        const p = hours.get(start + i * MS_PER_HOUR);
        if (p === undefined) continue;
        sum += p;
        n++;
      }
      if (n < HOURS_PER_DAY) {
        m.refused.push({ id: Number(r.id), day, reason: `${n} of ${HOURS_PER_DAY} hours priced (daily mean)` });
        continue;
      }
      usd = c.amount * (sum / HOURS_PER_DAY);
    }
    markDay(r.metric_key, day);
    const hasMarker = isMarked(r);
    const tokenMoves = c.tokenRef !== r.token_ref || c.setAmount !== null;
    if (usd === r.value && hasMarker && !tokenMoves) {
      m.unchanged++;
      continue;
    }
    m.repriced++;
    m.oldSum += r.value;
    m.newSum += usd;
    newValue.set(Number(r.id), usd);
    flows.push({ id: Number(r.id), metric: r.metric_key, day, oldValue: r.value, newValue: usd, oldTokenRef: r.token_ref, newTokenRef: c.tokenRef, newAmount: c.setAmount, basis });
  }

  // Remap-only writes: the rows under a CoinGecko id ref the flow writes above do not already cover.
  const covered = new Set(flows.map((w) => w.id));
  const remapOnly: Write[] = remapRows
    .filter((r) => !covered.has(Number(r.id)))
    .map((r) => ({
      id: Number(r.id), metric: r.metric_key, day: dayOf(iso(r.observed_at)), oldValue: r.value, newValue: r.value,
      oldTokenRef: r.token_ref, newTokenRef: remapOf(r.token_ref), newAmount: null, basis: null,
    }));

  // Derived rows over a repriced flow: recomputed at their observed_at from the flows' new values; written only when the
  // value differs (so a second --yes stays a no-op).
  const derivedWrites: Write[] = [];
  const derived: RepriceDerived[] = [];
  for (const [key, def] of Object.entries(config.metrics).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const s = def.source;
    if (s?.type !== 'derived') continue;
    const params = (s.params ?? {}) as Record<string, unknown>;
    const names = (x: unknown): string[] => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
    const plus = [...names(params.metric), ...names(params.metrics)];
    const minus = names(params.minus);
    if (![...plus, ...minus].some((m) => m.startsWith('flow_usd.') && perMetric.has(m))) continue;
    const windowDays = typeof params.days === 'number' ? params.days : 30;
    const dailyOf = (m: string): Map<string, number> => {
      const out = new Map<string, number>();
      for (const r of all) if (r.metric_key === m && r.period_days === 1) out.set(dayOf(r.observed_at), newValue.get(Number(r.id)) ?? r.value);
      return out;
    };
    // flow_tokens inputs are not USD and never move; read them as stored.
    const tokenInputs = [...plus, ...minus].filter((m) => !m.startsWith('flow_usd.'));
    const stored = new Map<string, Map<string, number>>();
    for (const m of tokenInputs) {
      const rs = await db.all<{ observed_at: string; value: number }>(
        `SELECT observed_at, value FROM observations WHERE asset_id = $1 AND metric_key = $2 AND ${ACTIVE} AND period_days = 1`, [asset, m],
      );
      stored.set(m, new Map(rs.map((x) => [dayOf(iso(x.observed_at)), x.value])));
    }
    const series = (m: string): Map<string, number> => stored.get(m) ?? dailyOf(m);
    const perPlus = plus.map(series);
    const perMinus = minus.map(series);
    const days = new Map<string, number>();
    for (const [day] of perPlus[0] ?? new Map<string, number>()) {
      if ([...perPlus, ...perMinus].every((d) => d.has(day))) {
        days.set(day, perPlus.reduce((acc, d) => acc + d.get(day)!, 0) - perMinus.reduce((acc, d) => acc + d.get(day)!, 0));
      }
    }
    const points = new Map(derivedFunction(s.name as DerivedName)(days, windowDays).map((p) => [p.day, p.value]));
    const touches = (day: string): boolean => {
      for (const m of [...plus, ...minus]) {
        const changed = repricedDays.get(m);
        if (!changed) continue;
        for (let i = 0; i < windowDays; i++) if (changed.has(addDays(day, -i))) return true;
      }
      return false;
    };
    const summary: RepriceDerived = { metric: key, rows: 0, recomputed: 0, unchanged: 0, incomplete: 0 };
    const storedRows = await db.all<{ id: number; observed_at: string; value: number; token_ref: string | null }>(
      `SELECT id, observed_at, value, token_ref FROM observations WHERE asset_id = $1 AND metric_key = $2 AND ${ACTIVE} ORDER BY observed_at, id`, [asset, key],
    );
    for (const d of storedRows) {
      const day = dayOf(iso(d.observed_at));
      if (!inRange(day)) continue;
      summary.rows++;
      if (!touches(day)) continue;
      const v = points.get(day);
      if (v === undefined) {
        summary.incomplete++;
        continue;
      }
      if (v === d.value) {
        summary.unchanged++;
        continue;
      }
      summary.recomputed++;
      derivedWrites.push({ id: Number(d.id), metric: key, day, oldValue: d.value, newValue: v, oldTokenRef: d.token_ref, newTokenRef: d.token_ref, newAmount: null, basis: 'derived' });
    }
    derived.push(summary);
  }

  const result: RepriceResult = {
    asset, from: from ?? null, applied: false,
    perMetric: [...perMetric.values()].sort((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0)),
    derived, remapped, days: 0, exportFile: null, exportSha256: null,
  };
  return { result, remapOnly, flows, derived: derivedWrites };
}
