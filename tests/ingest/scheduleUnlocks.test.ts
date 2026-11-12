import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { listLatestLevels } from '../../src/db/latestLevels.js';
import { listActiveObservations } from '../../src/db/observations.js';
import { adapterNames, getAdapter } from '../../src/ingest/adapters/registry.js';
import { fetchAsset } from '../../src/ingest/run.js';
import type { SourceValue } from '../../src/ingest/types.js';
import { runLevels } from '../../src/levels/levels.js';
import { methodOfSource } from '../../src/provenance/locator.js';
import { originOf } from '../../src/provenance/origin.js';
import { ADAPTER_SOURCE_TYPES } from '../../src/report/sourceTypes.js';
import { ADAPTER_ENDPOINTS } from '../../tools/sources-register/generate.js';
import { useTestDb } from '../helpers/db.js';
import { harness, NOW } from '../helpers/fetchHarness.js';
import { INGEST_ASSET_YAML, METRICS_END } from '../helpers/ingestAsset.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

/**
 * `schedule.unlocks_next_year` (Phase 3 R1 Task 4): team/investor unlocks over the next 365 days, computed offline from a
 * schedule cited in the asset YAML (rung `disclosure`, method `disclosed`). Fixtures are the LIT and PUMP citations the
 * controller recorded (ledger citations.md, ruling R5).
 */
const NAME = 'schedule.unlocks_next_year';
const DAY = 86_400_000;

const LIT_CITATION = {
  url: 'https://x.com/Lighter_xyz/status/2005862687331303804',
  quote: 'The team and investors all have a 1-year unlock and 3-year linear vesting after. The breakdown is 26% team, 24% investor.',
};
const PUMP_CITATION = {
  url: 'https://blockworks.com/token-transparency/filing/pump',
  quote:
    'The team allocation of 20 percent and the existing investor allocation of 13 percent, together 330,000,000,000 PUMP, were locked for 12 months from 12 July 2025 and then vest linearly over three years to July 2029. The first cliff released 82,500,000,000 PUMP on 12 July 2026, worth approximately $125 million at the time, split as 50,000,000,000 PUMP to the team and 32,500,000,000 PUMP to existing investors, and leaving 247,500,000,000 PUMP locked.',
};
const LIT_TRANCHES = { first: '2027-01-29', every_months: 1, count: 36 };
const LIT_PARAMS = {
  citation: LIT_CITATION,
  schedules: [
    { label: 'team', tokens: 260e6, tranches: LIT_TRANCHES },
    { label: 'investors', tokens: 240e6, tranches: LIT_TRANCHES },
  ],
};
const PUMP_LINEAR = { start: '2026-07-12', years: 3 };
const PUMP_PARAMS = {
  citation: PUMP_CITATION,
  schedules: [
    { label: 'team', tokens: 150e9, linear: PUMP_LINEAR },
    { label: 'investors', tokens: 97.5e9, linear: PUMP_LINEAR },
  ],
};

const run = async (nowIso: string, params: Record<string, unknown>): Promise<Extract<SourceValue, { kind: 'level' }>> => {
  const v = await getAdapter(NAME).run(sourceCtx({ nowIso }), params);
  if (v.kind !== 'level') throw new Error(`expected a level, got ${v.kind}`);
  return v;
};
const one = (schedule: Record<string, unknown>) => ({ citation: LIT_CITATION, schedules: [{ label: 'x', tokens: 1200, ...schedule }] });

describe('schedule.unlocks_next_year: registration', () => {
  it('is registered, offline (no RPC), on the disclosure rung with method disclosed', () => {
    expect(adapterNames()).toContain(NAME);
    expect(getAdapter(NAME).needsRpc).toBe(false);
    expect(ADAPTER_SOURCE_TYPES[NAME]).toBe('disclosure');
    expect(methodOfSource({ type: 'adapter', name: NAME, params: {} })).toBe('disclosed');
    // Every other adapter keeps method measured.
    for (const n of adapterNames().filter((x) => x !== NAME)) expect(methodOfSource({ type: 'adapter', name: n, params: {} }), n).toBe('measured');
    expect(getAdapter(NAME).paramsDoc).toMatch(/citation/);
  });

  it('its rows read back as api (the reading it stamps), while a hand-entered disclosure stays manual', () => {
    expect(originOf({ method: 'disclosed', sourceType: 'disclosure', locator: { adapter: NAME, params: {} } })).toBe('api');
    expect(originOf({ method: 'disclosed', sourceType: 'disclosure', locator: { citation_url: 'https://x.test', approved_by: 'u', approved_at: null } })).toBe('manual');
  });

  it('the sources register lists the citation url (it reads no endpoint)', () => {
    expect(ADAPTER_ENDPOINTS[NAME]!(PUMP_PARAMS, sourceCtx().asset)).toEqual([{ kind: 'http', url: PUMP_CITATION.url }]);
  });
});

describe('schedule.unlocks_next_year: values', () => {
  it('LIT at 2026-11-12T00:46:15Z: 36 monthly tranches from 2027-01-29, 10 due in the year', async () => {
    const v = await run('2026-11-12T00:46:15Z', LIT_PARAMS);
    expect(v.value).toBeCloseTo((500e6 / 36) * 10, 6);
    expect(v.value).toBeCloseTo(138_888_888.89, 2);
    expect(v).toMatchObject({ kind: 'level', observedAt: '2026-11-12T00:46:15Z', source: 'api', citation: LIT_CITATION });
    expect(v.detail).toBe(`team 72.22M, investors 66.67M; cited ${LIT_CITATION.url}`);
  });

  it('PUMP at 2026-11-12T00:46:41Z: linear over 3 years from 2026-07-12 gives exactly 82.5e9', async () => {
    const v = await run('2026-11-12T00:46:41Z', PUMP_PARAMS);
    expect(v.value).toBe(82.5e9);
    expect(v).toMatchObject({ source: 'api', citation: PUMP_CITATION });
    expect(v.detail).toBe(`team 50000.00M, investors 32500.00M; cited ${PUMP_CITATION.url}`);
  });

  it('tranche on now + 365d counts; one on now does not', async () => {
    const tranches = { first: '2026-01-29', every_months: 12, count: 2 }; // 2026-01-29 and 2027-01-29 (365 days later)
    // At now = the first tranche: the first (on now) is out, the second (on now + 365d) is in.
    expect((await run('2026-01-29T00:00:00.000Z', one({ tranches }))).value).toBe(600);
    // A millisecond earlier the first is in and the second (now + 365d + 1ms) is out; a millisecond later, the reverse.
    expect((await run('2026-01-28T23:59:59.999Z', one({ tranches }))).value).toBe(600);
    expect((await run('2026-01-29T00:00:00.001Z', one({ tranches }))).value).toBe(600);
    // Both inside (now, now + 365d]: none on an edge.
    expect((await run('2026-01-28T00:00:00.000Z', one({ tranches: { ...tranches, every_months: 6 } }))).value).toBe(1200);
  });

  it('linear ending inside the window counts only to its end', async () => {
    // start 2026-07-12 + 3 x 365 d = 2029-07-11 (2028 is a leap year): 180 days after 2029-01-12.
    const end = Date.parse('2026-07-12T00:00:00Z') + 3 * 365 * DAY;
    expect(new Date(end).toISOString()).toBe('2029-07-11T00:00:00.000Z');
    const days = (end - Date.parse('2029-01-12T00:00:00Z')) / DAY;
    expect(days).toBe(180);
    const v = await run('2029-01-12T00:00:00.000Z', one({ linear: { start: '2026-07-12', years: 3 } }));
    expect(v.value).toBeCloseTo((1200 / 3) * (days / 365), 9);
  });

  it('linear starting inside the window counts only from its start', async () => {
    const v = await run('2026-01-12T00:00:00.000Z', one({ linear: { start: '2026-07-12', years: 3 } }));
    const days = (Date.parse('2027-01-12T00:00:00Z') - Date.parse('2026-07-12T00:00:00Z')) / DAY; // 184
    expect(v.value).toBeCloseTo((1200 / 3) * (days / 365), 9);
  });

  it('before start counts nothing', async () => {
    expect((await run('2024-01-01T00:00:00.000Z', one({ linear: { start: '2026-07-12', years: 3 } }))).value).toBe(0);
    expect((await run('2024-01-01T00:00:00.000Z', one({ tranches: LIT_TRANCHES }))).value).toBe(0);
  });

  it('a schedule wholly past is 0', async () => {
    expect((await run('2030-01-01T00:00:00.000Z', one({ linear: { start: '2026-07-12', years: 3 } }))).value).toBe(0);
    expect((await run('2031-01-01T00:00:00.000Z', one({ tranches: LIT_TRANCHES }))).value).toBe(0);
    const v = await run('2031-01-01T00:00:00.000Z', LIT_PARAMS);
    expect(v.value).toBe(0);
    expect(v.detail).toBe(`team 0.00M, investors 0.00M; cited ${LIT_CITATION.url}`);
  });

  it('tranche dates clamp to the month end (as lit.unlocks_next_year): the 31st monthly falls on Feb 28', async () => {
    const tranches = { first: '2027-01-31', every_months: 1, count: 3 }; // Jan 31, Feb 28, Mar 31
    expect((await run('2027-02-27T00:00:00.000Z', one({ tranches }))).value).toBe(800);
    expect((await run('2027-02-28T00:00:00.000Z', one({ tranches }))).value).toBe(400);
  });

  it('run refuses params validateParams refuses (never a silent 0)', async () => {
    await expect(run('2026-11-12T00:00:00Z', { schedules: LIT_PARAMS.schedules })).rejects.toThrow(/citation/);
  });
});

describe('schedule.unlocks_next_year: validateParams', () => {
  const v = (params: Record<string, unknown>) => getAdapter(NAME).validateParams!(params);
  const sched = (over: Record<string, unknown>) => ({ citation: LIT_CITATION, schedules: [{ label: 'team', tokens: 1, tranches: LIT_TRANCHES, ...over }] });

  it('takes the LIT and PUMP params', () => {
    expect(v(LIT_PARAMS)).toEqual([]);
    expect(v(PUMP_PARAMS)).toEqual([]);
    expect(PUMP_CITATION.quote.length).toBeLessThanOrEqual(500);
  });

  it('refuses an unknown key, at every level', () => {
    expect(v({ ...LIT_PARAMS, url: 'x' })).toEqual(['unknown key "url" (citation, schedules)']);
    expect(v({ ...LIT_PARAMS, citation: { ...LIT_CITATION, page: 1 } })).toEqual(['citation: unknown key "page" (url, quote)']);
    expect(v(sched({ note: 'x' }))).toEqual(['schedules[0]: unknown key "note" (label, tokens, tranches, linear)']);
    expect(v(sched({ tranches: { ...LIT_TRANCHES, every: 1 } }))).toEqual(['schedules[0].tranches: unknown key "every" (first, every_months, count)']);
    expect(v(sched({ tranches: undefined, linear: { ...PUMP_LINEAR, end: '2029-07-12' } }))).toEqual(['schedules[0].linear: unknown key "end" (start, years)']);
  });

  it('refuses a missing citation, a missing url or quote, and a quote longer than 500 chars', () => {
    expect(v({ schedules: LIT_PARAMS.schedules })).toEqual(['citation: an object { url, quote } (the cited source of the schedule)']);
    expect(v({ ...LIT_PARAMS, citation: { quote: 'q' } })).toEqual(['citation.url: an http(s) URL, not null']);
    expect(v({ ...LIT_PARAMS, citation: { url: 'x.com/post', quote: 'q' } })).toEqual(['citation.url: an http(s) URL, not "x.com/post"']);
    expect(v({ ...LIT_PARAMS, citation: { url: LIT_CITATION.url } })).toEqual(['citation.quote: the verbatim quote, a non-empty string of at most 500 chars']);
    expect(v({ ...LIT_PARAMS, citation: { url: LIT_CITATION.url, quote: 'x'.repeat(501) } })).toEqual(['citation.quote: the verbatim quote, a non-empty string of at most 500 chars']);
    expect(v({ ...LIT_PARAMS, citation: { url: LIT_CITATION.url, quote: 'x'.repeat(500) } })).toEqual([]);
  });

  it('refuses tokens <= 0, a missing label, and an empty schedule list', () => {
    expect(v(sched({ tokens: 0 }))).toEqual(['schedules[0].tokens: a finite number > 0, not 0']);
    expect(v(sched({ tokens: -5 }))).toEqual(['schedules[0].tokens: a finite number > 0, not -5']);
    expect(v(sched({ tokens: '5' }))).toEqual(['schedules[0].tokens: a finite number > 0, not "5"']);
    expect(v(sched({ label: '' }))).toEqual(['schedules[0].label: a non-empty string']);
    expect(v({ citation: LIT_CITATION, schedules: [] })).toEqual(['schedules: a non-empty list of { label, tokens, tranches | linear }']);
    expect(v({ citation: LIT_CITATION })).toEqual(['schedules: a non-empty list of { label, tokens, tranches | linear }']);
  });

  it('refuses both or neither of tranches/linear', () => {
    expect(v(sched({ linear: PUMP_LINEAR }))).toEqual(['schedules[0]: exactly one of tranches or linear']);
    expect(v(sched({ tranches: undefined }))).toEqual(['schedules[0]: exactly one of tranches or linear']);
  });

  it('refuses a bad date, out-of-range tranche fields and years', () => {
    expect(v(sched({ tranches: { ...LIT_TRANCHES, first: '2027-02-30' } }))).toEqual(['schedules[0].tranches.first: a calendar date YYYY-MM-DD, not "2027-02-30"']);
    expect(v(sched({ tranches: undefined, linear: { start: '2026/07/12', years: 3 } }))).toEqual(['schedules[0].linear.start: a calendar date YYYY-MM-DD, not "2026/07/12"']);
    expect(v(sched({ tranches: { ...LIT_TRANCHES, every_months: 13 } }))).toEqual(['schedules[0].tranches.every_months: an integer 1..12, not 13']);
    expect(v(sched({ tranches: { ...LIT_TRANCHES, count: 0 } }))).toEqual(['schedules[0].tranches.count: an integer 1..120, not 0']);
    expect(v(sched({ tranches: { ...LIT_TRANCHES, count: 121 } }))).toEqual(['schedules[0].tranches.count: an integer 1..120, not 121']);
    expect(v(sched({ tranches: undefined, linear: { start: '2026-07-12', years: 0 } }))).toEqual(['schedules[0].linear.years: a number > 0 and <= 50, not 0']);
  });

  it('a bad param is refused when the asset loads', () => {
    const yaml = INGEST_ASSET_YAML.replace(
      METRICS_END,
      `  unlocks_next_year: { type: level, unit: tokens_per_year, staleness_days: 14, monitor_only: true, source: { type: adapter, name: ${NAME}, params: { schedules: [] } } }\n${METRICS_END}`,
    );
    expect(() => parseAssetYaml(yaml)).toThrow(/metrics\.unlocks_next_year\.source\.params: citation: an object/);
  });
});

/** The mini asset with the PUMP schedule as a watched monitor-only level (so the hourly levels job reads it too). */
const UNLOCKS_YAML = INGEST_ASSET_YAML.replace(
  METRICS_END,
  `  unlocks_next_year:
    type: level
    unit: tokens_per_year
    staleness_days: 14
    monitor_only: true
    watch: { change_pct: 50 }
    source:
      type: adapter
      name: ${NAME}
      params:
        citation:
          url: "${PUMP_CITATION.url}"
          quote: "${PUMP_CITATION.quote}"
        schedules:
          - { label: team, tokens: 150000000000, linear: { start: 2026-07-12, years: 3 } }
          - { label: investors, tokens: 97500000000, linear: { start: 2026-07-12, years: 3 } }
${METRICS_END}`,
);

describe('schedule.unlocks_next_year: written rows', () => {
  const testDb = useTestDb();

  it('the observation is disclosed on the disclosure rung, with the citation url and quote, and reads back as api', async () => {
    const loaded = parseAssetYaml(UNLOCKS_YAML);
    const h = harness(testDb(), { loaded });
    const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['unlocks_next_year'] });
    expect(r.sources.filter((s) => s.status === 'failed')).toEqual([]);
    // NOW is 2026-09-19: the whole window is inside the vest, so a full year's worth.
    expect(r.written).toEqual([expect.objectContaining({ metricKey: 'unlocks_next_year', value: 82.5e9, source: 'api' })]);
    const row = (await h.db.one<Record<string, unknown>>(
      "SELECT method, source_type, chain, citation_url, quoted_text, response_digest, locator->>'adapter' AS adapter FROM observations WHERE metric_key = 'unlocks_next_year'",
    ))!;
    expect(row).toEqual({
      method: 'disclosed', source_type: 'disclosure', chain: null, citation_url: PUMP_CITATION.url, quoted_text: PUMP_CITATION.quote, response_digest: null, adapter: NAME,
    });
    const [obs] = await listActiveObservations(h.db, 'mini', 'unlocks_next_year');
    expect(obs).toMatchObject({ source: 'api', citationUrl: PUMP_CITATION.url, sourceDetail: `team 50000.00M, investors 32500.00M; cited ${PUMP_CITATION.url}` });
  });

  it('a disclosure-rung reading that comes back without its citation fails the read and writes nothing', async () => {
    const loaded = parseAssetYaml(UNLOCKS_YAML);
    const h = harness(testDb(), { loaded });
    const def = getAdapter(NAME);
    const original = def.run;
    def.run = async (ctx, params) => {
      const v = await original(ctx, params);
      if (v.kind !== 'level') return v;
      const { citation: _drop, ...rest } = v;
      return rest;
    };
    try {
      const r = await fetchAsset(h.db, h.loaded, NOW, h.deps, { metrics: ['unlocks_next_year'] });
      expect(r.written).toEqual([]);
      const s = r.sources.find((x) => x.sourceId.includes(NAME))!;
      expect(s.status).toBe('failed');
      expect(s.error).toMatch(/unlocks_next_year: a disclosure-rung reading needs its citation/);
    } finally {
      def.run = original;
    }
    expect(await listActiveObservations(h.db, 'mini', 'unlocks_next_year')).toEqual([]);
  });

  it('the hourly levels job reads it into latest_levels on the disclosure rung', async () => {
    const loaded = parseAssetYaml(UNLOCKS_YAML);
    const h = harness(testDb(), { loaded });
    const out = await runLevels(h.db, [h.loaded], h.deps, NOW, 3);
    expect(out.perAsset[0]!.failed).toEqual([]);
    const row = (await listLatestLevels(h.db)).find((l) => l.metricKey === 'unlocks_next_year');
    expect(row).toMatchObject({ value: 82.5e9, source: 'api', sourceType: 'disclosure', blockNumber: null, locator: { adapter: NAME } });
  });
});
