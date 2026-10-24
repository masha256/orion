import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import { reportLines } from '../../src/cli/commands/report.js';
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

  it('refuses a share beside holder_flow, and a share on a metric an income line also reads; LIT\'s shape parses', () => {
    // Rulings 12 + 15: a share would split a holder flow (gross) from its stream (kept), and an income line from its stream.
    const reserveShare = streamsYaml().replace('holder_flow: burn }', 'holder_flow: burn, share: 0.5 }');
    expect(reserveShare).not.toBe(streamsYaml());
    expect(messageOf(reserveShare)).toMatch(/stream "reserve" takes no share with a holder_flow/);
    const onIncomeLine = streamsYaml().replace('metric: flow_usd.trading, settlement: daily }', 'metric: flow_usd.buyback, settlement: daily, share: 0.5 }');
    expect(onIncomeLine).not.toBe(streamsYaml());
    expect(messageOf(onIncomeLine)).toMatch(/stream "trading" takes no share: its metric "flow_usd\.buyback" is also an income line's metric/);
    // Without the share both configs parse.
    expect(messageOf(onIncomeLine.replace(', share: 0.5', ''))).toBe('');
    // LIT: a share on the Robinhood fee stream, the income line on the buybacks.
    const litLike = `${withMetrics(`${METRICS}  flow_usd.fees_rh: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n`)}
reporting:
  window_days: 10
  haircuts: { buyback: 0 }
  revenue:
    - { id: core, metric: flow_usd.trading, settlement: daily }
    - { id: rh, metric: flow_usd.fees_rh, settlement: daily, share: 0.5 }
  income:
    lines:
      - { id: buyback, to: holders, metric: flow_usd.buyback }
`;
    expect(messageOf(litLike)).toBe('');
  });
});

describe('revenue streams: share in the report', () => {
  // Two daily streams of $1,000 a day; the second is a gross series the protocol keeps half of (LIT's Robinhood fees).
  const shareYaml = (started = '') => `${withMetrics(`${METRICS}  flow_usd.rh: { type: flow, unit: usd, staleness_days: 4, monitor_only: true }\n`)}
reporting:
  window_days: 10
  haircuts: { buyback: 0 }
  revenue:
    - { id: core, metric: flow_usd.trading, settlement: daily }
    - { id: rh, metric: flow_usd.rh, settlement: daily, share: 0.5${started} }
  income:
    lines:
      - { id: buyback, to: holders, metric: flow_usd.buyback }
  volume: [ flow_usd.rh ]
`;
  const day = '2026-02-05';
  const daily = () => new Map([
    ['flow_usd.buyback', flat('2026-01-01', 40, 100)],
    ['flow_usd.trading', flat('2026-01-01', 40, 1000)],
    ['flow_usd.rh', new Map([...flat('2026-01-01', 30, 1000), ...flat('2026-01-27', 10, 2000)])], // 01-27 .. 02-05 at 2,000
  ]);
  const flatDaily = () => new Map([
    ['flow_usd.buyback', flat('2026-01-01', 40, 100)],
    ['flow_usd.trading', flat('2026-01-01', 40, 1000)],
    ['flow_usd.rh', flat('2026-01-01', 40, 1000)],
  ]);

  it('share halves the stream: kept 182,500 beside gross 365,000; the total is the kept sum', () => {
    const asset = parseAssetYaml(shareYaml()).config;
    const r = holderYieldReport({ asset, day, daily: flatDaily(), levels });
    const [core, rh] = r.revenue!.streams;
    expect(core.annualized).toBeCloseTo(365_000);
    expect(rh.annualized).toBeCloseTo(182_500);
    expect(r.revenue!.annualized).toBeCloseTo(547_500);
    expect(rh.share).toBe(0.5);
    expect(rh.grossAnnualized).toBeCloseTo(365_000);
    expect('share' in core).toBe(false);
    expect('grossAnnualized' in core).toBe(false);
    // The income statement's revenue is the kept total; protocol income is that less the buybacks.
    expect(r.income!.revenue.annualized).toBeCloseTo(547_500);
    expect(r.income!.protocol.annualized).toBeCloseTo(547_500 - 36_500);
    // Other readers of the same metric see the gross series: the volume line is untouched.
    expect(r.volume!.annualized).toBeCloseTo(365_000);
    // The text report shows kept beside gross on the stream with a share, and nothing new on the other.
    const text = reportLines(r);
    expect(text.find((l) => l.includes('stream rh'))).toMatch(/\$0\.18M .*\[daily, 50\.0% of gross \$0\.36M\]/);
    expect(text.find((l) => l.includes('stream core'))).not.toMatch(/of gross/);
  });

  it('growth uses the kept value', () => {
    const asset = parseAssetYaml(shareYaml()).config;
    const r = holderYieldReport({ asset, day, daily: daily(), levels });
    const rh = r.revenue!.streams[1];
    expect(rh.growth.current).toBeCloseTo(0.5 * 10 * 2000);
    expect(rh.growth.prior).toBeCloseTo(0.5 * 10 * 1000);
    expect(r.revenue!.growth.current).toBeCloseTo(10 * 1000 + 0.5 * 10 * 2000);
    expect(r.revenue!.growth.prior).toBeCloseTo(10 * 1000 + 0.5 * 10 * 1000);
    expect(r.income!.revenue.growth.current).toBeCloseTo(r.revenue!.growth.current!);
    expect(r.income!.revenue.growth.prior).toBeCloseTo(r.revenue!.growth.prior!);
    expect(r.volume!.growth.current).toBeCloseTo(10 * 2000); // gross
  });

  it('started plus share: a young stream is annualized over its own days, then the share is applied', () => {
    const asset = parseAssetYaml(shareYaml(', started: "2026-02-01"')).config;
    const d = new Map([...flatDaily(), ['flow_usd.rh', flat('2026-02-01', 5, 1000)]]); // 5 days to 02-05
    const r = holderYieldReport({ asset, day, daily: d, levels });
    const rh = r.revenue!.streams[1];
    expect(rh.daysInWindow).toBe(5);
    expect(rh.grossAnnualized).toBeCloseTo(365_000); // 1,000 a day over its own 5 days, not 5,000 / 10
    expect(rh.annualized).toBeCloseTo(182_500);
    expect(r.income!.revenue.annualized).toBeCloseTo(547_500);
  });

  it('no share, same JSON: the revenue and income objects equal the base commit\'s (d5a3bcd), values included', () => {
    // The literals below were computed by holderYieldReport at d5a3bcd (before share existed) from these same inputs.
    const json = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;
    const g = (current: number | null, prior: number | null, change: number | null, annualized: number | null, note?: string) =>
      (note === undefined ? { current, prior, change, annualized } : { current, prior, change, annualized, note });
    // HYPE: a daily stream (3 a day, then 5 from 01-27) and a periodic one; the buybacks at 2 a day.
    const hype = holderYieldReport({ asset: parseAssetYaml(streamsYaml(10, '2026-01-25')).config, day, daily: new Map([
      ['flow_usd.buyback', flat('2026-01-01', 40, 2)],
      ['flow_usd.trading', new Map([...flat('2026-01-01', 30, 3), ...flat('2026-01-27', 10, 5)])],
      ['flow_usd.reserve', flat('2026-01-25', 12, 10)],
    ]), levels });
    const tradingGrowth = g(50, 30, 0.6666666666666667, 125163977.98647128);
    const triple = g(150, 50, 2, 259971534277923460);
    expect(json({ revenue: hype.revenue, income: hype.income })).toEqual({
      revenue: {
        basis: 'streams',
        streams: [
          { id: 'trading', label: null, basis: 'daily', metric: 'flow_usd.trading', annualized: 1825, daysInWindow: null, provisionalDays: 0, started: null, isNew: false, growth: tradingGrowth, holderFlow: null },
          { id: 'reserve', label: 'reserve yield', basis: 'periodic', metric: 'flow_usd.reserve', annualized: 3650, daysInWindow: null, provisionalDays: 0, started: '2026-01-25', isNew: true, growth: g(100, 20, 4, 3.253907165344266e25), holderFlow: 'burn' },
        ],
        annualized: 5475,
        growth: triple,
        growthExNew: tradingGrowth,
        excludedFromExNew: ['reserve'],
        provisional: false,
      },
      income: {
        revenue: { annualized: 5475, growth: triple },
        holders: { annualized: 4380, growth: g(120, 40, 2, 259971534277923460) },
        protocol: { annualized: 1095, growth: g(30, 10, 2, 259971534277923460) },
        costs: { annualized: 0 },
        payoutRatio: 0.8,
        protocolMargin: 0.2,
        lines: [
          { id: 'buyback', to: 'holders', annualized: 730, basis: 'measured' },
          { id: 'reserve', to: 'holders', annualized: 3650, basis: 'measured', note: 'reserve yield: a revenue stream paid to holders' },
          { id: 'protocol_income', to: 'protocol', annualized: 1095, basis: 'remainder', note: 'revenue less holders and costs' },
        ],
        checks: [],
        outsideRevenue: [],
      },
    });
    // VVV: the disclosed stream, with the burns (4 a day) and the cross-check series (9 a day) over 158 days.
    const vvvAsset = parseAssetYaml(readFileSync(fileURLToPath(new URL('../../assets/vvv.yaml', import.meta.url)), 'utf8')).config;
    expect(vvvAsset.reporting!.revenue!.some((s) => s.share !== undefined)).toBe(false);
    const disclosed = [{ observedAt: '2025-10-01T00:00:00.000Z', value: 50e6 }, { observedAt: '2026-01-15T00:00:00.000Z', value: 80e6 }];
    const vvv = holderYieldReport({ asset: vvvAsset, day, daily: new Map([
      ['flow_usd.burn', flat('2025-09-01', 158, 4)], ['flow_usd.revenue_proxy', flat('2025-09-01', 158, 9)],
    ]), levels: { ...levels, disclosed } });
    const between = g(80e6, 50e6, 0.6000000000000001, 4.045055846141385, 'between the two latest disclosures');
    expect(json({ revenue: vvv.revenue, income: vvv.income })).toEqual({
      revenue: {
        basis: 'disclosed',
        streams: [
          { id: 'business', label: 'disclosed business revenue (annual run rate)', basis: 'disclosed', metric: 'revenue_run_rate_usd', annualized: 80e6, daysInWindow: null, provisionalDays: 0, started: null, isNew: false, growth: between, holderFlow: null },
        ],
        annualized: 80e6,
        growth: between,
        growthExNew: null,
        excludedFromExNew: [],
        disclosedGrowth: { annualized: 4.045055846141385, gapDays: 106, latestAgeDays: 22, flags: [] },
        crossCheck: { metric: 'flow_usd.revenue_proxy', annualized: 3285 },
        provisional: false,
      },
      income: {
        revenue: { annualized: 80e6, growth: g(null, null, null, null, 'a disclosed level: see revenue') },
        holders: { annualized: 1460, growth: g(360, null, null, null, 'needs 180 complete days of every flow') },
        protocol: { annualized: 79998540, growth: g(null, null, null, null, 'a disclosed level less daily flows') },
        costs: { annualized: 0 },
        payoutRatio: 0.00001825,
        protocolMargin: 0.99998175,
        lines: [
          { id: 'burn', to: 'holders', annualized: 1460, basis: 'measured' },
          { id: 'protocol_income', to: 'protocol', annualized: 79998540, basis: 'remainder', note: 'revenue less holders and costs' },
        ],
        checks: [],
        outsideRevenue: [],
      },
    });
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
