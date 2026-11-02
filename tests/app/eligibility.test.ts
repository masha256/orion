import { beforeEach, describe, expect, it } from 'vitest';
import { eligibleObservations, narrowToUsable } from '../../src/app/eligibility.js';
import { parseAssetYaml } from '../../src/config/load.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { MINI_ASSET_YAML, miniAsset } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

const DAY = 86_400_000;
const NOW = new Date(AS_OF);
const dayBefore = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

/** 200 daily flow rows ending at AS_OF, 100 USD per year, plus 200 daily prices. */
function dailyHistory() {
  const list = miniObservations().filter((o) => o.metricKey !== 'flow_usd.fees' && o.metricKey !== 'price_usd');
  for (let n = 199; n >= 0; n--) {
    list.push(obs('flow_usd.fees', 100 / 365, dayBefore(n), { periodDays: 1 }));
    list.push(obs('price_usd', 10 + n / 1000, dayBefore(n + 0.5)));
  }
  return list;
}

describe('narrowToUsable', () => {
  const asset = miniAsset();

  it('keeps the newest level, the flow window plus a day, the schedule in force and later, and future events', () => {
    const list = [
      ...dailyHistory(),
      obs('emission_rate_annual', 5, '2025-01-01'),
      obs('emission_rate_annual', 3, '2026-08-01'),
      obs('scheduled_unlock_tokens', 7, '2026-05-01'),
      obs('scheduled_unlock_tokens', 9, '2026-12-01'),
    ];
    const withEvents = parseAssetYaml(MINI_ASSET_YAML.replace('holder_flows:', '  scheduled_unlock_tokens: { type: event, unit: tokens, staleness_days: 400 }\nholder_flows:')).config;
    const kept = narrowToUsable(withEvents, list, AS_OF);
    const of = (key: string) => kept.filter((o) => o.metricKey === key);
    expect(of('price_usd')).toHaveLength(1);
    expect(of('price_usd')[0].observedAt).toBe(dayBefore(0.5));
    expect(of('flow_usd.fees')).toHaveLength(91); // the 90-day window plus one day of margin
    expect(of('emission_rate_annual').map((o) => o.value)).toEqual([0, 3]); // in force since 2026-01-01, and the later step
    expect(of('scheduled_unlock_tokens').map((o) => o.value)).toEqual([9]);
    expect(kept.length).toBeLessThan(110);
    expect(kept.map((o) => [o.observedAt, o.id])).toEqual([...kept].sort((a, b) => (a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1)).map((o) => [o.observedAt, o.id]));
  });

  it('drops flow metrics that no holder flow uses, and metrics the asset does not define', () => {
    const withInfo = parseAssetYaml(MINI_ASSET_YAML.replace('holder_flows:', '  flow_tokens.fees: { type: flow, unit: tokens, staleness_days: 45 }\nholder_flows:')).config;
    const list = [...miniObservations(), obs('flow_tokens.fees', 5, AS_OF, { periodDays: 1 }), obs('not_defined', 1, AS_OF)];
    const keys = new Set(narrowToUsable(withInfo, list, AS_OF).map((o) => o.metricKey));
    expect(keys.has('flow_tokens.fees')).toBe(false);
    expect(keys.has('not_defined')).toBe(false);
    expect(keys.has('flow_usd.fees')).toBe(true);
  });

  it('ignores observations after as_of, except schedule steps and events', () => {
    const list = [...miniObservations(), obs('price_usd', 99, '2026-07-05'), obs('flow_usd.fees', 50, '2026-07-05', { periodDays: 1 })];
    const kept = narrowToUsable(asset, list, AS_OF);
    expect(kept.some((o) => o.value === 99)).toBe(false);
    expect(kept.filter((o) => o.metricKey === 'flow_usd.fees')).toHaveLength(1);
  });
});

describe('eligibleObservations', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('reads the stored rows narrowed to what is usable at as_of', async () => {
    for (const o of dailyHistory()) insertObservation(db, { assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays, value: o.value, source: o.source, fetchedAt: o.fetchedAt });
    const asset = miniAsset();
    const eligible = await eligibleObservations(db, asset, AS_OF);
    expect(eligible.length).toBeLessThan(110);
    expect(eligible.filter((o) => o.metricKey === 'flow_usd.fees')).toHaveLength(91);
    expect(eligible.filter((o) => o.metricKey === 'price_usd')).toHaveLength(1);
  });
});
