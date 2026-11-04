import type { MetricDef } from '../config/schema.js';
import type { WatchStateRow } from '../db/watchState.js';
import type { WatchFiring, WatchRule } from '../types.js';

/** A level watch's rule (`change_pct` or `outside`); null for no watch or a flow's `above`, which the nightly owns. */
export function levelWatchRule(def: MetricDef | undefined): WatchRule | null {
  if (def?.watch?.change_pct !== undefined) return 'change_pct';
  if (def?.watch?.outside !== undefined) return 'outside';
  return null;
}

/**
 * Fire and clear, per metric, from this hour's reads (spec 5.4, plan R13). `firings` are fetchAsset's own watch output,
 * so `change_pct` compares with the newest stored nightly row. A metric evaluated this run that fires now and did not
 * before is `fired`; one that fired before and is evaluated but no longer fires is `cleared`; a metric not evaluated
 * (its read failed) keeps its state. `above` (flow) rules are never touched here. `next` is every row to keep for the
 * asset: the untouched ones first, as they were, then any new ones. A rule changed in the YAML starts afresh.
 */
export function watchTransitions(
  prev: WatchStateRow[],
  firings: WatchFiring[],
  evaluated: { metricKey: string; rule: WatchRule; value: number }[],
  now: string,
  assetId: string,
): { fired: WatchFiring[]; cleared: { metricKey: string; rule: WatchRule }[]; next: WatchStateRow[] } {
  const fired: WatchFiring[] = [];
  const cleared: { metricKey: string; rule: WatchRule }[] = [];
  const next = new Map(prev.map((r) => [r.metricKey, r]));
  for (const e of evaluated) {
    if (e.rule === 'above') continue;
    const before = next.get(e.metricKey);
    const same = before !== undefined && before.rule === e.rule;
    const was = same && before.firing;
    const firing = firings.filter((f) => f.metric === e.metricKey && f.rule === e.rule).at(-1);
    const is = firing !== undefined;
    if (is && !was) fired.push(firing);
    if (!is && was) cleared.push({ metricKey: e.metricKey, rule: e.rule });
    next.set(e.metricKey, { assetId, metricKey: e.metricKey, rule: e.rule, firing: is, since: same && is === was ? before.since : now, lastValue: e.value });
  }
  return { fired, cleared, next: [...next.values()] };
}
