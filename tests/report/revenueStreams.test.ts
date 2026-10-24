import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import { openDb } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { addDays } from '../../src/ingest/time.js';
import { holderYieldReport, type ReportLevels } from '../../src/report/holderYield.js';
import { lastCompleteReportDay, loadHolderYieldReport, periodicDaily } from '../../src/report/load.js';

/**
 * Revenue as a list of streams (Mike, 2026-10-12): revenue = the sum of the streams; a stream is daily or periodic (lump
 * payments spread over the days they cover, the unpaid tail at the last period's daily rate, provisional); growth with and
 * without streams younger than 180 days; a disclosed stream is the company's own figure, its growth between disclosures.
 */
const hypeYaml = readFileSync(fileURLToPath(new URL('../fixtures/hype.yaml', import.meta.url)), 'utf8');
const withMetrics = (extra: string) => hypeYaml.replace('metrics:\n', `metrics:\n${extra}`);
const METRICS =
  '  flow_usd.trading: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n' +
  '  flow_usd.reserve: { type: flow, unit: usd, cadence: monthly, staleness_days: 45, monitor_only: true }\n' +
  '  rev_disclosed: { type: level, unit: usd, cadence: event, staleness_days: 60 }\n';

const streamsYaml = (window = 10, started = '2026-01-15') => `${withMetrics(METRICS)}
reporting:
  window_days: ${window}
  haircuts: { buyback: 0, reserve: 0 }
  revenue:
    - { id: trading, metric: flow_usd.trading, settlement: daily }
    - { id: reserve, label: reserve yield, metric: flow_usd.reserve, settlement: periodic, started: "${started}", holder_flow: burn }
  income:
    lines:
      - { id: buyback, to: holders, metric: flow_usd.buyback }
`;

const levels: ReportLevels = { price: 2, totalSupply: 1000, stakedSupply: 400, lockedSupply: null, emissionRateAnnual: 0, extra: {}, disclosed: [] };
const flat = (first: string, n: number, v: number) => new Map(Array.from({ length: n }, (_, i) => [addDays(first, i), v] as const));

function seedDaily(db: ReturnType<typeof openDb>, metricKey: string, lastDay: string, days: number, value: number) {
  for (let i = 0; i < days; i++) {
    const day = addDays(lastDay, -i);
    insertObservation(db, { assetId: 'hype', metricKey, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value, source: 'api', fetchedAt: '2026-10-11T00:00:00.000Z' });
  }
}

describe('revenue streams: config', () => {
  const messageOf = (yaml: string) => {
    try {
      parseAssetYaml(yaml);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };

  it('accepts a daily and a periodic stream, and adding a stream is config only', () => {
    expect(parseAssetYaml(streamsYaml()).config.reporting!.revenue!.map((s) => [s.id, s.settlement])).toEqual([['trading', 'daily'], ['reserve', 'periodic']]);
  });

  it('refuses a periodic stream without started, a level as a stream, and income.remainder_of beside streams', () => {
    expect(messageOf(streamsYaml().replace(', started: "2026-01-15"', ''))).toMatch(/periodic stream "reserve" needs started/);
    expect(messageOf(streamsYaml().replace('metric: flow_usd.trading, settlement', 'metric: rev_disclosed, settlement'))).toMatch(/"rev_disclosed" is not a flow metric/);
    expect(messageOf(`${streamsYaml()}    remainder_of: [ flow_usd.trading ]\n`)).toMatch(/drop income.remainder_of/);
  });

  it('makes a disclosed revenue the asset\'s revenue: revenue_disclosed without a disclosed stream is refused', () => {
    const base = `${withMetrics(METRICS)}\nreporting:\n  window_days: 10\n  haircuts: { buyback: 0 }\n  revenue_disclosed: rev_disclosed\n`;
    expect(messageOf(base)).toMatch(/revenue_disclosed "rev_disclosed" is the asset's revenue: list it as a disclosed revenue stream/);
    expect(messageOf(`${base}  revenue:\n    - { id: business, disclosed: rev_disclosed, cross_check: flow_usd.trading }\n`)).toBe('');
    expect(messageOf(`${base}  revenue:\n    - { id: business, disclosed: rev_disclosed }\n    - { id: trading, metric: flow_usd.trading, settlement: daily }\n`)).toMatch(/a disclosed stream is the whole revenue/);
  });
});

describe('revenue streams: share', () => {
  const messageOf = (yaml: string) => {
    try {
      parseAssetYaml(yaml);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  };
  const withShare = (share: string) => streamsYaml().replace('settlement: daily }', `settlement: daily, share: ${share} }`);

  it('accepts a share in (0, 1] on a metric stream; without one the stream has none', () => {
    expect(parseAssetYaml(withShare('0.5')).config.reporting!.revenue![0].share).toBe(0.5);
    expect(parseAssetYaml(withShare('1')).config.reporting!.revenue![0].share).toBe(1);
    expect(parseAssetYaml(streamsYaml()).config.reporting!.revenue![0].share).toBeUndefined();
  });

  it('refuses a share of 0 or above 1', () => {
    expect(messageOf(withShare('0'))).toMatch(/reporting\.revenue\.0\.share/);
    expect(messageOf(withShare('1.5'))).toMatch(/reporting\.revenue\.0\.share/);
  });

  it('refuses a share on a disclosed stream', () => {
    const base = `${withMetrics(METRICS)}\nreporting:\n  window_days: 10\n  haircuts: { buyback: 0 }\n  revenue_disclosed: rev_disclosed\n`;
    expect(messageOf(`${base}  revenue:\n    - { id: business, disclosed: rev_disclosed, share: 0.5 }\n`)).toMatch(/disclosed stream "business" takes no share/);
  });
});

describe('revenue streams: periodic settlement', () => {
  it('spreads each payment evenly over the days it covers, and runs the unpaid days at the last period\'s daily rate, provisional', () => {
    const db = openDb(':memory:');
    // 300 paid for 2026-01-01 .. 01-30 (30 days): 10 a day. Report day 02-05: 6 unpaid days.
    insertObservation(db, { assetId: 'hype', metricKey: 'flow_usd.reserve', observedAt: '2026-01-31T00:00:00.000Z', periodDays: 30, value: 300, source: 'api', fetchedAt: '2026-02-06T00:00:00.000Z' });
    const p = periodicDaily(db, 'hype', 'flow_usd.reserve', '2026-02-05');
    expect(p.days.get('2026-01-01')).toBe(10);
    expect(p.days.get('2026-01-30')).toBe(10);
    expect(p.days.get('2025-12-31')).toBeUndefined();
    expect([...p.provisional].sort()).toEqual(['2026-01-31', '2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05']);
    expect(p.days.get('2026-02-05')).toBe(10);
    // The next payment lands (330 for 01-31 .. 03-01): its days replace the provisional ones; nothing was stored for them.
    insertObservation(db, { assetId: 'hype', metricKey: 'flow_usd.reserve', observedAt: '2026-03-02T00:00:00.000Z', periodDays: 30, value: 330, source: 'api', fetchedAt: '2026-02-06T00:00:00.000Z' });
    const q = periodicDaily(db, 'hype', 'flow_usd.reserve', '2026-02-05');
    expect(q.days.get('2026-02-05')).toBe(11);
    expect(q.provisional.size).toBe(0);
  });

  it('sums the streams; a stream younger than the window runs at its own days\' rate; the periodic one never holds back the report day', () => {
    const asset = parseAssetYaml(streamsYaml(10, '2026-01-25')).config;
    const db = openDb(':memory:');
    seedDaily(db, 'flow_usd.trading', '2026-02-05', 40, 3);
    seedDaily(db, 'flow_usd.buyback', '2026-02-05', 40, 2);
    // Started 01-25: one payment for 01-25 .. 02-01 (8 days, 80), unpaid since: 4 provisional days to 02-05.
    insertObservation(db, { assetId: 'hype', metricKey: 'flow_usd.reserve', observedAt: '2026-02-02T00:00:00.000Z', periodDays: 8, value: 80, source: 'api', fetchedAt: '2026-02-06T00:00:00.000Z' });
    expect(lastCompleteReportDay(db, asset)).toBe('2026-02-05');
    const r = loadHolderYieldReport(db, asset);
    const v = r.revenue!;
    expect(v.basis).toBe('streams');
    expect(v.streams.map((s) => [s.id, s.basis, s.daysInWindow, s.provisionalDays, s.isNew])).toEqual([
      ['trading', 'daily', null, 0, false],
      ['reserve', 'periodic', null, 4, true], // 12 days old: older than the 10-day window, younger than 180
    ]);
    expect(v.streams[0].annualized).toBeCloseTo(3 * 365);
    expect(v.streams[1].annualized).toBeCloseTo(10 * 365);
    expect(v.annualized).toBeCloseTo(13 * 365);
    expect(v.provisional).toBe(true);
    // Growth as is: the reserve was zero in the prior window (before it started), so revenue grew; without it, flat.
    expect(v.growth.prior).toBeCloseTo(3 * 10 + 10 * 2); // 01-17 .. 01-26: 2 days of reserve
    expect(v.growth.current).toBeCloseTo(13 * 10);
    expect(v.excludedFromExNew).toEqual(['reserve']);
    expect(v.growthExNew!.change).toBeCloseTo(0);
    // The income statement's revenue is the streams; the reserve is paid to holders; protocol income is the rest.
    expect(r.income!.revenue.annualized).toBeCloseTo(13 * 365);
    expect(r.income!.revenue.growth.change).toBeCloseTo(v.growth.change!); // the young stream's run-rate weight is not in growth
    expect(r.income!.holders.annualized).toBeCloseTo((2 + 10) * 365);
    expect(r.income!.protocol.annualized).toBeCloseTo(1 * 365);
    // And it is a holder flow in the burn bucket, report only.
    expect(r.flows.map((f) => [f.id, f.bucket])).toEqual([['buyback', 'hold'], ['reserve', 'burn']]); // the fixture's buyback is buy_and_hold
    expect(r.notes.join('\n')).toMatch(/reserve has 4 unpaid day\(s\) at the last period's daily rate \(provisional\)/);
  });

  it('annualizes a stream younger than the window over its own days, not the whole window', () => {
    const asset = parseAssetYaml(streamsYaml(10, '2026-01-31')).config;
    const daily = new Map([
      ['flow_usd.buyback', flat('2026-01-01', 40, 1)],
      ['flow_usd.trading', flat('2026-01-01', 40, 1)],
      ['flow_usd.reserve', flat('2026-01-31', 6, 5)], // 6 days to 02-05, 5 a day
    ]);
    const r = holderYieldReport({ asset, day: '2026-02-05', daily, levels });
    const reserve = r.revenue!.streams[1];
    expect(reserve.daysInWindow).toBe(6);
    expect(reserve.annualized).toBeCloseTo(5 * 365); // not 30 / 10 * 365
  });
});

describe('revenue streams: a disclosed stream', () => {
  const yaml = `${withMetrics(METRICS)}
reporting:
  window_days: 10
  haircuts: { buyback: 0 }
  revenue_disclosed: rev_disclosed
  revenue:
    - { id: business, disclosed: rev_disclosed, cross_check: flow_usd.trading }
  income:
    lines:
      - { id: buyback, to: holders, metric: flow_usd.buyback }
`;
  const daily = new Map([['flow_usd.buyback', flat('2026-01-01', 300, 1)], ['flow_usd.trading', flat('2026-01-01', 300, 2)]]);

  it('is the revenue; growth between the two latest disclosures; the DefiLlama series is a cross-check only', () => {
    const asset = parseAssetYaml(yaml).config;
    const disclosed = [{ observedAt: '2026-07-01T00:00:00.000Z', value: 70e6 }, { observedAt: '2026-08-17T00:00:00.000Z', value: 100e6 }];
    const r = holderYieldReport({ asset, day: '2026-10-11', daily, levels: { ...levels, disclosed } });
    const v = r.revenue!;
    expect(v.basis).toBe('disclosed');
    expect(v.annualized).toBe(100e6);
    expect(v.disclosedGrowth!.gapDays).toBe(47);
    expect(v.disclosedGrowth!.annualized).toBeCloseTo((100 / 70) ** (365 / 47) - 1);
    expect(v.disclosedGrowth!.latestAgeDays).toBe(56);
    expect(v.disclosedGrowth!.flags).toEqual(['the two latest disclosures are 47 days apart (< 90): a noisy rate']);
    expect(v.crossCheck).toEqual({ metric: 'flow_usd.trading', annualized: 2 * 365 });
    // The statement's revenue is the disclosure; holders = the burns; protocol income = the rest.
    expect(r.income!.revenue.annualized).toBe(100e6);
    expect(r.income!.holders.annualized).toBeCloseTo(365);
    expect(r.income!.protocol.annualized).toBeCloseTo(100e6 - 365);
    expect(r.flows.map((f) => f.id)).toEqual(['buyback']); // holder flow stays = the burns
  });

  it('flags a latest disclosure older than 90 days, and one disclosure as no growth', () => {
    const asset = parseAssetYaml(yaml).config;
    const one = holderYieldReport({ asset, day: '2026-12-31', daily, levels: { ...levels, disclosed: [{ observedAt: '2026-08-17T00:00:00.000Z', value: 100e6 }] } });
    expect(one.revenue!.disclosedGrowth!.flags).toEqual(['one disclosure so far: no growth', 'the latest disclosure is 137 days old (> 90)']);
    expect(one.revenue!.disclosedGrowth!.annualized).toBeNull();
  });
});

describe('revenue without streams', () => {
  it('is the income statement\'s total, as before', () => {
    const yaml = `${withMetrics(METRICS)}\nreporting:\n  window_days: 10\n  haircuts: { buyback: 0 }\n  income:\n    lines:\n      - { id: buyback, to: holders, metric: flow_usd.buyback }\n    remainder_of: [ flow_usd.trading ]\n`;
    const asset = parseAssetYaml(yaml).config;
    const r = holderYieldReport({ asset, day: '2026-01-20', daily: new Map([['flow_usd.buyback', flat('2026-01-01', 20, 1)], ['flow_usd.trading', flat('2026-01-01', 20, 4)]]), levels });
    expect(r.revenue).toMatchObject({ basis: 'income', streams: [], growthExNew: null });
    expect(r.revenue!.annualized).toBeCloseTo(4 * 365);
    expect(r.income!.protocol.annualized).toBeCloseTo(3 * 365);
  });
});
