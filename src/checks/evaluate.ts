import type { AssetConfig } from '../config/schema.js';
import { raiseAnomaly, type Anomaly } from '../db/anomalies.js';
import { upsertCheckResults, type CheckResult, type CheckStatus } from '../db/checkResults.js';
import type { Db } from '../db/connection.js';
import type { FetchRunDetail } from '../db/fetchRuns.js';
import { listActiveObservations, type Observation } from '../db/observations.js';
import { addDays, dayStartMs } from '../ingest/time.js';
import { MS_PER_DAY } from '../types.js';
import { resolveChecks, type ResolvedCheck, type Term } from './schema.js';

/**
 * Evaluating the reconciliation checks (spec §5) for one asset and UTC day, from stored data only (no network):
 *
 * - A flow's day D is its confirmed active daily row stamped D+1 00:00 (the ingest convention).
 * - A level's reading for D is the first one taken on D+1, the run that reads D's levels (the report's rule). A balance or
 *   supply check needs the day's change, so it uses the readings at the two day ends: the first reading within
 *   BOUNDARY_HOURS after each midnight (the nightly run reads at 00:45 UTC, staging at 02:45); a reading later in the day
 *   would compare a noon-to-noon change with a midnight-to-midnight flow.
 * - A price check `against` a contract reads the cross-check reading the first fetch run on D+1 stored in its detail.
 * - A revision check compares each day's first stored row with the row in force over the last `days` days: a source that
 *   restated a day superseded its row (apiFlow), and the old row is kept.
 *
 * A side with no row for the day (or a window day) makes the check `incomplete`, never a breach. gap_pct is
 * |lhs - rhs| / max(|lhs|, |rhs|) x 100 (0 when both are 0); a breach is a gap past tolerance_pct (and past tolerance_abs,
 * in the series' unit, when the check sets one).
 */

export const BOUNDARY_HOURS = 6;

const flowStamp = (day: string): string => new Date(dayStartMs(day) + MS_PER_DAY).toISOString();

export function gapPct(lhs: number, rhs: number): number {
  const scale = Math.max(Math.abs(lhs), Math.abs(rhs));
  return scale === 0 ? 0 : (Math.abs(lhs - rhs) / scale) * 100;
}

interface Outcome {
  lhs: number | null;
  rhs: number | null;
  gapPct: number | null;
  status: CheckStatus;
  detail: Record<string, unknown>;
}

/** Reads observations once per metric for one evaluation. */
class Store {
  private cache = new Map<string, Observation[]>();
  constructor(private db: Db, private assetId: string) {}

  async rows(metric: string): Promise<Observation[]> {
    let rows = this.cache.get(metric);
    if (!rows) {
      rows = (await listActiveObservations(this.db, this.assetId, metric)).filter((o) => o.status === 'confirmed');
      this.cache.set(metric, rows);
    }
    return rows;
  }

  async flowDay(metric: string, day: string): Promise<number | undefined> {
    const at = flowStamp(day);
    return (await this.rows(metric)).find((o) => o.periodDays === 1 && o.observedAt === at)?.value;
  }

  /** The first reading in [from, from + hours). */
  async firstReading(metric: string, fromMs: number, hours: number): Promise<Observation | undefined> {
    const end = fromMs + hours * 3_600_000;
    return (await this.rows(metric))
      .filter((o) => {
        const t = Date.parse(o.observedAt);
        return t >= fromMs && t < end;
      })
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id - b.id)[0];
  }
}

const incomplete = (detail: Record<string, unknown>): Outcome => ({ lhs: null, rhs: null, gapPct: null, status: 'incomplete', detail });

function judged(lhs: number, rhs: number, tolerancePct: number, toleranceAbs: number | null, detail: Record<string, unknown>): Outcome {
  const gap = gapPct(lhs, rhs);
  const past = gap > tolerancePct && !(toleranceAbs !== null && Math.abs(lhs - rhs) <= toleranceAbs);
  return { lhs, rhs, gapPct: gap, status: past ? 'breach' : 'ok', detail };
}

/** Each side's window sum, or the missing (metric, day) pairs. */
async function windowSums(store: Store, day: string, windowDays: number, sideTerms: Term[][]): Promise<{ sums: number[] } | { missing: string[] }> {
  const missing: string[] = [];
  const sums: number[] = [];
  for (const side of sideTerms) {
    let s = 0;
    for (const t of side) {
      for (let i = 0; i < windowDays; i++) {
        const d = addDays(day, -i);
        const v = await store.flowDay(t.metric, d);
        if (v === undefined) missing.push(`${t.metric}@${d}`);
        else s += v * t.factor;
      }
    }
    sums.push(s);
  }
  return missing.length > 0 ? { missing } : { sums };
}

const missingDetail = (missing: string[]) => ({ missing: missing.slice(0, 10), missing_count: missing.length });

async function evaluateOne(db: Db, store: Store, asset: AssetConfig, c: ResolvedCheck, day: string): Promise<Outcome> {
  const tol = { tolerance_pct: c.tolerancePct, ...(c.auto ? { auto: true } : {}) };
  const nextDayMs = dayStartMs(addDays(day, 1));
  switch (c.type) {
    case 'sum':
    case 'two_path':
    case 'coverage': {
      const [a, b] = c.type === 'sum' ? [c.total, c.parts] : c.type === 'two_path' ? [c.a, c.b] : [c.listed, c.total];
      const detail = { ...tol, window_days: c.windowDays, lhs: a.map((t) => t.line ?? t.metric), rhs: b.map((t) => t.line ?? t.metric) };
      const r = await windowSums(store, day, c.windowDays, [a, b]);
      if ('missing' in r) return incomplete({ ...detail, ...missingDetail(r.missing) });
      return judged(r.sums[0]!, r.sums[1]!, c.tolerancePct, null, detail);
    }
    case 'parameter': {
      const o = await store.firstReading(c.metric, nextDayMs, 24);
      const detail = { ...tol, metric: c.metric, ...(c.line !== undefined ? { line: c.line } : {}) };
      if (!o) return incomplete({ ...detail, ...missingDetail([`${c.metric}@${addDays(day, 1)}`]) });
      return judged(o.value, c.expected, c.tolerancePct, null, { ...detail, observed_at: o.observedAt });
    }
    case 'balance':
    case 'supply': {
      const end = await store.firstReading(c.level, nextDayMs, BOUNDARY_HOURS);
      const start = await store.firstReading(c.level, dayStartMs(day), BOUNDARY_HOURS);
      const [plus, minus] = c.type === 'balance' ? [c.inflows, c.outflows] : [c.burns, c.mints];
      const detail = { ...tol, ...(c.toleranceAbs !== null ? { tolerance_abs: c.toleranceAbs } : {}), level: c.level, boundary_hours: BOUNDARY_HOURS };
      const missing: string[] = [];
      if (!start) missing.push(`${c.level}@${day}T00:00Z+${BOUNDARY_HOURS}h`);
      if (!end) missing.push(`${c.level}@${addDays(day, 1)}T00:00Z+${BOUNDARY_HOURS}h`);
      const r = await windowSums(store, day, 1, [plus, minus]);
      if ('missing' in r) missing.push(...r.missing);
      if (missing.length > 0 || !start || !end || 'missing' in r) return incomplete({ ...detail, ...missingDetail(missing) });
      const change = end.value - start.value;
      // balance: the account's change vs in - out; supply: the supply's fall vs burns - mints.
      const lhs = c.type === 'balance' ? change : -change;
      return judged(lhs, r.sums[0]! - r.sums[1]!, c.tolerancePct, c.toleranceAbs, { ...detail, start: { observed_at: start.observedAt, value: start.value }, end: { observed_at: end.observedAt, value: end.value } });
    }
    case 'price': {
      if (c.against.kind === 'metric') {
        const a = await store.firstReading(c.level, nextDayMs, 24);
        const b = await store.firstReading(c.against.metric, nextDayMs, 24);
        const detail = { ...tol, level: c.level, against: c.against.metric };
        const missing = [...(a ? [] : [`${c.level}@${addDays(day, 1)}`]), ...(b ? [] : [`${c.against.metric}@${addDays(day, 1)}`])];
        if (!a || !b) return incomplete({ ...detail, ...missingDetail(missing) });
        return judged(a.value, b.value, c.tolerancePct, null, { ...detail, observed_at: [a.observedAt, b.observedAt] });
      }
      const detail = { ...tol, level: c.level, against: c.against.contract, source: c.against.sourceId };
      const runs = await db.all<{ id: number; started_at: string; detail_json: string }>(
        'SELECT id, started_at, detail_json FROM fetch_runs WHERE asset_id = $1 AND started_at >= $2 AND started_at < $3 ORDER BY started_at, id',
        [asset.id, new Date(nextDayMs).toISOString(), new Date(nextDayMs + MS_PER_DAY).toISOString()],
      );
      for (const run of runs) {
        const d = JSON.parse(run.detail_json) as FetchRunDetail;
        for (const s of d.sources ?? []) {
          if (s.sourceId !== c.against.sourceId) continue;
          const rec = (s.crossChecks ?? []).find((x) => x.metricKey === c.level && x.label === 'level');
          if (rec) return judged(rec.primary, rec.check, c.tolerancePct, null, { ...detail, fetch_run_id: Number(run.id), started_at: run.started_at });
        }
      }
      return incomplete({ ...detail, ...missingDetail([`${c.level} cross-check ${c.against.contract}@${addDays(day, 1)}`]) });
    }
    case 'revision': {
      const first = addDays(day, 1 - c.days);
      const detail: Record<string, unknown> = { ...tol, metric: c.metric, days: c.days };
      const rows = await db.all<{ id: number; observed_at: string; value: number; source: string; superseded_by: number | null }>(
        `SELECT id, observed_at, value, source, superseded_by FROM observations
         WHERE asset_id = $1 AND metric_key = $2 AND period_days = 1 AND status = 'confirmed' AND observed_at >= $3 AND observed_at <= $4
         ORDER BY id`,
        [asset.id, c.metric, flowStamp(first), flowStamp(day)],
      );
      const active = await store.flowDay(c.metric, day);
      if (active === undefined) return incomplete({ ...detail, ...missingDetail([`${c.metric}@${day}`]) });
      // Per stamped day: the row in force, and the first row the same source wrote for that day.
      const restated: { day: string; first: number; active: number; gap_pct: number }[] = [];
      const byStamp = new Map<string, typeof rows>();
      for (const r of rows) byStamp.set(r.observed_at, [...(byStamp.get(r.observed_at) ?? []), r]);
      for (const [stamp, rs] of [...byStamp.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
        const inForce = rs.find((r) => r.superseded_by === null);
        if (!inForce) continue;
        const orig = rs.find((r) => r.source === inForce.source)!;
        if (orig.id === inForce.id) continue;
        const g = gapPct(orig.value, inForce.value);
        if (g > 0) restated.push({ day: addDays(stamp.slice(0, 10), -1), first: orig.value, active: inForce.value, gap_pct: g });
      }
      const worst = restated.reduce<(typeof restated)[number] | null>((w, r) => (w === null || r.gap_pct > w.gap_pct ? r : w), null);
      const out = { ...detail, restated: restated.slice(0, 10), restated_count: restated.length };
      if (worst === null) return judged(active, active, c.tolerancePct, null, out);
      return judged(worst.first, worst.active, c.tolerancePct, null, { ...out, worst_day: worst.day });
    }
  }
}

/** Every check of the asset (explicit and automatic) for `day`, from stored data. Reads only. */
export async function evaluateChecks(db: Db, asset: AssetConfig, day: string, opts: { now?: Date } = {}): Promise<CheckResult[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`check day must be YYYY-MM-DD, got ${day}`);
  const checks = resolveChecks(asset);
  const store = new Store(db, asset.id);
  const evaluatedAt = (opts.now ?? new Date()).toISOString();
  const out: CheckResult[] = [];
  for (const c of checks) {
    const o = await evaluateOne(db, store, asset, c, day);
    out.push({ assetId: asset.id, checkId: c.id, day, type: c.type, lhs: o.lhs, rhs: o.rhs, gapPct: o.gapPct, status: o.status, detail: o.detail, evaluatedAt });
  }
  return out;
}

/**
 * Stores the results and opens (or counts again) one `check_breach` anomaly per breached check: advisory, deduped by
 * check id, so a check that keeps breaching bumps one row's occurrences. Occurrences count breached days, not
 * evaluations: a day whose stored result is already a breach (a stale report day ticked again, a manual re-tick) raises
 * nothing more, though its stored row still takes the latest evaluation. Anomalies wake no agent (Phase 1). One
 * transaction under the asset's lock.
 */
export async function recordChecks(db: Db, assetId: string, results: CheckResult[], nowIso: string): Promise<Anomaly[]> {
  return db.tx(
    async (t) => {
      const counted = new Set<string>();
      for (const r of results) {
        if (r.status !== 'breach') continue;
        const prior = await t.one<{ status: string }>('SELECT status FROM check_results WHERE asset_id = $1 AND check_id = $2 AND day = $3', [assetId, r.checkId, r.day]);
        if (prior?.status === 'breach') counted.add(`${r.checkId}\u0000${r.day}`);
      }
      await upsertCheckResults(t, results);
      const raised: Anomaly[] = [];
      for (const r of results) {
        if (r.status !== 'breach' || counted.has(`${r.checkId}\u0000${r.day}`)) continue;
        raised.push(await raiseAnomaly(t, {
          assetId, kind: 'check_breach', metricKey: '', dedupeKey: r.checkId, severity: 'advisory', seenAt: nowIso,
          detail: { check_id: r.checkId, check_type: r.type, day: r.day, lhs: r.lhs, rhs: r.rhs, gap_pct: r.gapPct, tolerance_pct: r.detail.tolerance_pct ?? null },
        }));
      }
      return raised;
    },
    { lockAsset: assetId },
  );
}
