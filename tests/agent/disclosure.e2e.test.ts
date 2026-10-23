import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelRequest } from '../../src/agent/model.js';
import type { RunAgentResult } from '../../src/agent/run.js';
import { approveProposal } from '../../src/app/proposals.js';
import { buildProgram } from '../../src/cli/program.js';
import { loadAsset, parseAssetYaml } from '../../src/config/load.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation } from '../../src/db/observations.js';
import { insertProposal } from '../../src/db/proposals.js';
import { getAdapter } from '../../src/ingest/adapters/registry.js';
import { addDays } from '../../src/ingest/time.js';
import { sha256 } from '../../src/util/canonical.js';
import { fakeHttp } from '../helpers/fakeHttp.js';
import { calls, say, scriptedModel, toolUse, type ScriptedModel, type Step } from '../helpers/fakeModel.js';
import { sourceCtx } from '../helpers/sourceCtx.js';

/**
 * Level 2 of the disclosure watcher's acceptance test (spec 11.2, with the amendments of section 15): the full pipeline on
 * the Q3 2026 Lighter call, a scripted model standing in for the analyst. A temp ORION_HOME holds the real
 * assets/lit.yaml, personas/, skills/ and LIT's calibrated set; the fixture is stored with `doc add`; the run is
 * `agent run lit --type disclosure --doc 1 --dry-run --json`, in process, so its JSON is the CLI's own output. The script
 * makes the calls the manual review's outcome needs, and every one must pass the real guardrails. It proves the plumbing
 * accepts that outcome, not that an analyst finds it (level 3 does).
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = '2026-10-23T12:00:00.000Z';
const TRANSCRIPT = join(ROOT, 'tests/fixtures/disclosure/lit-q3-2026-call-transcript.txt');
const RUN_FIXTURE = join(ROOT, 'tests/fixtures/disclosure/lit-q3-run.json');
const LIT_HASH = 'ad683e198b9b97af4d0067e339b89323b1711fe3e689fbb7f9fd404353f926a5';
const SOURCE_URL = 'https://x.com/Lighter_xyz/status/2113065839352336774';

// Q3 2026 as the live DB has it (spec section 2): the treasury's buys and DefiLlama's revenue, summed over 92 days.
const Q3_FROM = '2026-07-01';
const Q3_TO = '2026-09-30';
const Q3_DAYS = 92;
const BUYBACK_Q3 = 7_410_898;
const LLAMA_Q3 = 9_846_397;
const UNLOCKS_NOW = 135_982_827;
/** What the valuation needs beyond the flows; the run rate is the Q3 buys annualized. */
const VALUATION_LEVELS: [string, number][] = [
  ['price_usd', 3.04],
  ['total_supply', 981_909_280],
  ['staked_supply', 0],
  ['staker_emission_share', 0],
  ['emission_rate_annual', 0],
  ['revenue_run_rate_usd', Math.round((BUYBACK_Q3 * 365) / Q3_DAYS)],
];

// Quotes verified against the fixture under the 3-segment rule (spec 11.3), with the locator each must resolve to.
const Q = {
  firstTranche: { locator: '12:33', text: 'Actually, the first one will be January 29th of next year,' },
  thirtySix: { locator: '12:29', text: 'what unlocks will happen literally over 36 months.' },
  refShare: { locator: '05:20', text: "I should remind everyone that it's a 50-50 ref share." },
  allToBuybacks: { locator: '11:27', text: '100% of trading revenue is used for buybacks.' },
  revenue: { locator: '04:22', text: 'So the total revenue of the quarter, 8.5 million,' },
  robinhoodFees: { locator: '06:12', text: 'already more than a million in fees attributed back to Lighter from the 50-50 split.' },
  fileNextMonth: { locator: '26:13', text: 'And so the plan from here is to file for these licenses next month.' },
  review180: { locator: '26:20', text: "And then from there, there's a period of up to 180 days that the agency would have to review" },
  options: { locator: '20:13', text: 'Vanilla options are going live by end of year.' },
  mainnet: { locator: '18:18', text: 'So the mainnet is planned by year end.' },
} as const;

const TRANCHES = { first: '2027-01-29', every_months: 1, count: 36 };
const DILUTION_NOTE = 'team and investor vesting, 36 monthly tranches from 2027-01-29 (Lighter Q3 2026 call)';

let home: string;
let home2: string | undefined;
let model: ScriptedModel;
let result: RunAgentResult;
let rawJson: string;
let exitCode: number | undefined;
let before: Record<string, number>;
let after: Record<string, number>;
const flowIds: Record<string, { first_id: number; last_id: number }> = {};

const withDb = <T>(h: string, fn: (db: Db) => T): T => {
  const db = openDb(join(h, 'orion.db'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

async function orion(h: string, ...args: string[]): Promise<string> {
  const lines: string[] = [];
  exitCode = undefined;
  const program = buildProgram({ home: h, stdout: (l) => lines.push(l), now: () => new Date(NOW), setExitCode: (c) => (exitCode = c), modelClient: () => model });
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

const TABLES = ['proposals', 'journal', 'observations', 'assumption_sets', 'documents', 'agent_runs'] as const;
const counts = (h: string): Record<string, number> =>
  withDb(h, (db) => Object.fromEntries(TABLES.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n])));

/**
 * The rows ingest would have written: one confirmed `api` row per completed UTC day D, stamped at the end of D (D+1 at
 * 00:00Z), period 1 day. Equal days with the remainder on the last, so the integer total is exact.
 */
function seedDaily(db: Db, metricKey: string, total: number): void {
  const per = Math.floor(total / Q3_DAYS);
  for (let i = 0; i < Q3_DAYS; i++) {
    const day = addDays(Q3_FROM, i);
    const value = i === Q3_DAYS - 1 ? total - per * (Q3_DAYS - 1) : per;
    insertObservation(db, { assetId: 'lit', metricKey, observedAt: `${addDays(day, 1)}T00:00:00.000Z`, periodDays: 1, value, source: 'api', fetchedAt: NOW });
  }
}

/** The tool results the loop sent back in `request`, parsed (the same split as ScriptedModel.toolResults). */
function resultsIn(request: ModelRequest): Record<string, unknown>[] {
  const last = request.messages.at(-1)!;
  if (last.role !== 'user' || typeof last.content === 'string') return [];
  return last.content.flatMap((b) => (b.type === 'tool_result' && typeof b.content === 'string' ? [JSON.parse(b.content.split('\n\nbudget: ')[0]!) as Record<string, unknown>] : []));
}

const cite = (docId: number, ...quotes: { text: string }[]) => quotes.map((q) => ({ source: `doc:${docId}`, quoted_text: q.text }));

function script(docId: number): (Step | ((r: ModelRequest) => Step))[] {
  return [
    // 1. Orion's own Q3 sums of both flows.
    calls(
      toolUse('get_flow_total', { metric: 'flow_usd.buyback', from: Q3_FROM, to: Q3_TO }),
      toolUse('get_flow_total', { metric: 'flow_usd.llama_revenue', from: Q3_FROM, to: Q3_TO }),
    ),
    // 2. Keep the summed ids (evidence for the findings), then the unlock-cadence config proposal.
    (request) => {
      for (const r of resultsIn(request)) flowIds[r.metric as string] = { first_id: r.first_id as number, last_id: r.last_id as number };
      return calls(toolUse('propose_change', {
        kind: 'config',
        rationale: 'The call says team and investor tokens unlock in 36 monthly tranches from 2027-01-29, not linearly from 2026-12-29 as DefiLlama has it.',
        edits: [
          { path: ['metrics', 'unlocks_next_year', 'source', 'params', 'tranches'], value: TRANCHES },
          { path: ['reporting', 'dilution', 'unlocks', 'note'], value: DILUTION_NOTE },
        ],
        citations: cite(docId, Q.firstTranche, Q.thirtySix),
      }));
    },
    // 3. The two dev findings, citing rows get_flow_total showed.
    () => calls(
      toolUse('record_dev_finding', {
        category: 'holder_flow', title: 'Q3 buys miss the Robinhood instance', metric_keys: ['flow_usd.buyback'],
        claim: 'All trading revenue (8.5M USD in Q3, including about 1M USD from the 50-50 Robinhood ref share) goes to buybacks.',
        orion_reading: `Orion measures 7,410,898 USD of treasury buys in Q3 2026 (2026-07-01..09-30), against 8.5M USD disclosed.`,
        value_direction: 'up', proposed_fix: 'Find where the Robinhood share is spent on LIT and add it to the holder flow.',
        evidence: [flowIds['flow_usd.buyback']!.first_id, flowIds['flow_usd.buyback']!.last_id],
        citations: cite(docId, Q.refShare, Q.allToBuybacks),
      }),
      toolUse('record_dev_finding', {
        category: 'revenue', title: "DefiLlama's revenue overstates Lighter's Q3", metric_keys: ['flow_usd.llama_revenue'],
        claim: 'Lighter disclosed 8.5M USD of Q3 revenue, of which more than 1M USD came from the Robinhood split.',
        orion_reading: `DefiLlama's dailyRevenue sums to 9,846,397 USD for Q3 2026, against 8.5M USD disclosed.`,
        value_direction: 'none', proposed_fix: 'Check how DefiLlama counts the Robinhood instance and label the proxy accordingly.',
        evidence: [flowIds['flow_usd.llama_revenue']!.first_id],
        citations: cite(docId, Q.revenue, Q.robinhoodFees),
      }),
    ),
    // 4. The journal with the three dated catalysts.
    calls(toolUse('write_journal', {
      thesis: 'Buybacks track trading revenue; the unlock cadence and the Robinhood share are the open items.',
      open_questions: ['Where is the Robinhood ref share spent?'],
      summary: 'Reviewed the Q3 2026 call: one config proposal, two dev findings, three catalysts.',
      catalysts: [
        { event: 'CFTC DCM and DCO applications filed, then up to 180 days of review', kind: 'regulatory', from: '2026-11-01', to: '2027-05-29', citations: cite(docId, Q.fileNextMonth, Q.review180) },
        { event: 'Vanilla options go live', kind: 'product', by: '2026-12-31', citations: cite(docId, Q.options) },
        { event: 'Lighter EVM mainnet', kind: 'product', by: '2026-12-31', citations: cite(docId, Q.mainnet) },
      ],
    })),
    say('Done.'),
  ];
}

/**
 * Fields normalized before the fixture is written or compared. None varies today (every timestamp comes from the
 * injected clock), but a fixture pinned to them would break for reasons Task 12 does not care about:
 * - run.startedAt, run.endedAt: wall-clock fields in a real run (here NOW).
 * - run.configHash: hashes the persona, skill and asset texts, so any later edit of those files would move it.
 * The shape (RunAgentResult: run, staged, committed, signal) is kept; only those values become placeholders.
 */
function normalized(r: RunAgentResult): unknown {
  const copy = structuredClone(r) as RunAgentResult;
  copy.run.startedAt = '<startedAt>';
  copy.run.endedAt = '<endedAt>';
  copy.run.configHash = '<configHash>';
  return copy;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-disclosure-e2e-'));
  await orion(home, 'init');
  copyFileSync(join(ROOT, 'assets/lit.yaml'), join(home, 'assets/lit.yaml'));
  cpSync(join(ROOT, 'personas'), join(home, 'personas'), { recursive: true });
  cpSync(join(ROOT, 'skills'), join(home, 'skills'), { recursive: true });
  await orion(home, 'model', 'assumptions', 'import', 'lit', join(ROOT, 'calibration/lit-assumptions.yaml'), '--rationale', 'central package (Mike, 2026-10-16)');
  await orion(home, 'persona', 'assign', 'lit', 'perp-exchange-analyst');

  withDb(home, (db) => {
    seedDaily(db, 'flow_usd.buyback', BUYBACK_Q3);
    seedDaily(db, 'flow_usd.llama_revenue', LLAMA_Q3);
    const level = (metricKey: string, value: number, source: 'api' | 'onchain' = 'api') =>
      insertObservation(db, { assetId: 'lit', metricKey, observedAt: '2026-10-23T00:00:00.000Z', value, source, fetchedAt: NOW });
    level('unlocks_next_year', UNLOCKS_NOW);
    // The minimum the LIT valuation needs to price (without them the proposal's effect is blocked on missing_metric), as
    // the 2026-10-23 fetch would stamp them: constants and the derived run rate are `api`, the supply read `onchain`.
    for (const [key, value] of VALUATION_LEVELS) level(key, value, key === 'total_supply' ? 'onchain' : 'api');
  });

  const added = JSON.parse(await orion(home, 'doc', 'add', 'lit', '--url', SOURCE_URL, '--file', TRANSCRIPT, '--kind', 'machine_transcript',
    '--published-at', '2026-10-22T16:00:00Z', '--title', 'LIT investor update 2026Q3', '--source-id', 'x:2113065839352336774',
    '--meta', 'asr_model=faster-whisper large-v3', '--json')) as { id: number; existing: boolean };
  expect(added).toMatchObject({ id: 1, existing: false });

  before = counts(home);
  model = scriptedModel(script(added.id));
  rawJson = await orion(home, 'agent', 'run', 'lit', '--type', 'disclosure', '--doc', String(added.id), '--dry-run', '--json');
  result = JSON.parse(rawJson) as RunAgentResult;
  after = counts(home);
});

afterAll(() => {
  for (const h of [home, home2]) if (h) rmSync(h, { recursive: true, force: true });
});

describe('disclosure dry run on the Q3 2026 Lighter call (scripted model)', () => {
  it('every scripted call passed its guardrails', () => {
    const refused = model.requests.flatMap((_, i) => model.toolResults(i)).filter((r) => r.is_error);
    expect(refused).toEqual([]);
    expect(exitCode).toBeUndefined();
    expect(model.requests).toHaveLength(5);
  });

  it('get_flow_total returns the live Q3 totals over 92 whole days', () => {
    const [buyback, llama] = model.toolResults(1).map((r) => r.result);
    expect(buyback).toMatchObject({ metric: 'flow_usd.buyback', from: Q3_FROM, to: Q3_TO, total: BUYBACK_Q3, unit: 'usd', days_covered: 92, days_missing: [], rows: 92 });
    expect(llama).toMatchObject({ metric: 'flow_usd.llama_revenue', total: LLAMA_Q3, unit: 'usd', days_covered: 92, days_missing: [], rows: 92 });
    expect(flowIds['flow_usd.buyback']).toEqual({ first_id: buyback!.first_id, last_id: buyback!.last_id });
  });

  it('completes as a dry run that commits nothing', () => {
    expect(result.run.outcome).toBe('completed');
    expect(result.run.dryRun).toBe(true);
    expect(result.run.runType).toBe('disclosure');
    expect(result.run.triggerDetail).toMatchObject({ docId: 1 });
    expect(result.committed).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.staged.assumptionChanges).toEqual([]);
  });

  it('stages the unlock-cadence config proposal, citing 12:33 and 12:29, with an effect that moves no target', () => {
    expect(result.staged.proposals).toHaveLength(1);
    const prop = result.staged.proposals[0]!;
    expect(prop.change.kind).toBe('config');
    expect(prop.change).toEqual({
      kind: 'config',
      edits: [
        { path: ['metrics', 'unlocks_next_year', 'source', 'params', 'tranches'], value: TRANCHES },
        { path: ['reporting', 'dilution', 'unlocks', 'note'], value: DILUTION_NOTE },
      ],
    });
    // unlocks_next_year is monitor_only: the config moves the report's dilution line, never a target.
    const effect = prop.effect as { '6m': { from: number; to: number }; '12m': { from: number; to: number } };
    expect(typeof effect['6m'].to).toBe('number');
    expect(typeof effect['12m'].to).toBe('number');
    expect(prop.effect).toMatchObject({ '6m': { from: effect['6m'].to, to: effect['6m'].to }, '12m': { from: effect['12m'].to, to: effect['12m'].to } });
    expect(prop.citations.map((c) => c.locator)).toEqual([Q.firstTranche.locator, Q.thirtySix.locator]);
  });

  it('stages two dev findings with the right categories, metric keys, evidence and fingerprints', () => {
    const findings = result.staged.devFindings;
    expect(findings.map((f) => [f.category, f.metricKeys])).toEqual([['holder_flow', ['flow_usd.buyback']], ['revenue', ['flow_usd.llama_revenue']]]);
    const docSha = sha256(readFileSync(TRANSCRIPT, 'utf8'));
    expect(findings.map((f) => f.fingerprint)).toEqual([
      sha256(`lit|holder_flow|flow_usd.buyback|${docSha}`),
      sha256(`lit|revenue|flow_usd.llama_revenue|${docSha}`),
    ]);
    expect(findings[0]!.evidence).toEqual([flowIds['flow_usd.buyback']!.first_id, flowIds['flow_usd.buyback']!.last_id]);
    expect(findings.map((f) => f.citations.map((c) => c.locator))).toEqual([[Q.refShare.locator, Q.allToBuybacks.locator], [Q.revenue.locator, Q.robinhoodFees.locator]]);
  });

  it('stages the journal with the three catalysts and their dates', () => {
    const catalysts = result.staged.journal!.catalysts;
    expect(catalysts.map((c) => [c.by ?? null, c.from ?? null, c.to ?? null])).toEqual([[null, '2026-11-01', '2027-05-29'], ['2026-12-31', null, null], ['2026-12-31', null, null]]);
    expect(catalysts.map((c) => c.citations.map((x) => x.locator))).toEqual([[Q.fileNextMonth.locator, Q.review180.locator], [Q.options.locator], [Q.mainnet.locator]]);
  });

  it('every citation is of the target document and verified at its expected locator', () => {
    const all = [
      ...result.staged.proposals.flatMap((p) => p.citations),
      ...result.staged.devFindings.flatMap((f) => f.citations),
      ...result.staged.journal!.catalysts.flatMap((c) => c.citations),
    ];
    expect(all).toHaveLength(10);
    const docSha = sha256(readFileSync(TRANSCRIPT, 'utf8'));
    for (const c of all) expect(c).toMatchObject({ source: 'doc:1', docSha256: docSha, docKind: 'machine_transcript' });
    expect(all.map((c) => [c.locator, c.quotedText])).toEqual(
      [Q.firstTranche, Q.thirtySix, Q.refShare, Q.allToBuybacks, Q.revenue, Q.robinhoodFees, Q.fileNextMonth, Q.review180, Q.options, Q.mainnet].map((q) => [q.locator, q.text]),
    );
  });

  it('leaves the database as it was, except the one run row', () => {
    expect(before).toMatchObject({ documents: 1, agent_runs: 0, proposals: 0, journal: 0, assumption_sets: 1, observations: 2 * Q3_DAYS + 1 + VALUATION_LEVELS.length });
    expect(after).toEqual({ ...before, agent_runs: 1 });
  });

  it('offers the disclosure tools and never apply_assumption_change', () => {
    const names = model.requests[0]!.tools.map((t) => ('name' in t ? t.name : t.type));
    expect(names).not.toContain('apply_assumption_change');
    expect(names).toEqual(expect.arrayContaining(['get_flow_total', 'record_dev_finding', 'propose_change', 'write_journal']));
  });

  it('the run JSON matches tests/fixtures/disclosure/lit-q3-run.json (UPDATE_FIXTURES=1 rewrites it)', () => {
    // The CLI printed exactly what runAgent returned.
    expect(Object.keys(result)).toEqual(['run', 'staged', 'committed', 'signal']);
    const text = `${JSON.stringify(normalized(result), null, 1)}\n`;
    if (process.env.UPDATE_FIXTURES === '1') {
      mkdirSync(join(ROOT, 'tests/fixtures/disclosure'), { recursive: true });
      writeFileSync(RUN_FIXTURE, text);
    }
    expect(existsSync(RUN_FIXTURE)).toBe(true);
    expect(JSON.parse(readFileSync(RUN_FIXTURE, 'utf8'))).toEqual(JSON.parse(text));
  });
});

describe('approving the config proposal on a copy of assets/lit.yaml', () => {
  it('loads, and unlocks_next_year re-read on the issuer schedule gives 9 of 36 tranches', async () => {
    const prop = result.staged.proposals[0]!;
    const h2 = mkdtempSync(join(tmpdir(), 'orion-disclosure-approve-'));
    home2 = h2;
    await orion(h2, 'init');
    copyFileSync(join(ROOT, 'assets/lit.yaml'), join(h2, 'assets/lit.yaml'));
    await orion(h2, 'model', 'assumptions', 'import', 'lit', join(ROOT, 'calibration/lit-assumptions.yaml'), '--rationale', 'central package');

    const approved = withDb(h2, (db) => {
      const filed = insertProposal(db, {
        assetId: 'lit', persona: 'perp-exchange-analyst', agentRunId: null, change: prop.change, filedAgainst: prop.filedAgainst, rationale: prop.rationale,
        evidence: prop.evidence, effect: prop.effect, citations: prop.citations, createdAt: NOW,
      });
      return approveProposal(db, h2, filed.id, { now: new Date(NOW) });
    });
    expect(approved.proposal.status).toBe('approved');

    const { config } = loadAsset(h2, 'lit');
    const source = config.metrics.unlocks_next_year!.source as { type: string; name: string; params: Record<string, unknown> };
    expect(source).toEqual({ type: 'adapter', name: 'lit.unlocks_next_year', params: { allocations: ['Team', 'Investors'], tranches: TRANCHES } });
    expect(config.reporting!.dilution).toEqual([{ id: 'unlocks', metric: 'unlocks_next_year', note: DILUTION_NOTE }]);

    // Task 8's canned DefiLlama curve (tests/ingest/adapters.lit.test.ts): linear weekly from 2026-12-29 over three years to
    // 300M (Team) and 198M (Investors). Nothing is out at the schedule start, so 9 of 36 tranches fall in the next year.
    const t0 = Date.parse('2026-12-29T00:00:00Z') / 1000;
    const linearTo = (total: number) => Array.from({ length: 1300 }, (_, i) => ({ timestamp: t0 + (i - 80) * 86_400, unlocked: Math.min(total, Math.max(0, ((i - 80) * total) / 1095)) }));
    const body = { documentedData: { data: [{ label: 'Team', data: linearTo(300_000_000) }, { label: 'Investors', data: linearTo(198_000_000) }] } };
    const http = fakeHttp({ 'https://defillama-datasets.llama.fi/emissions/lighter': body });
    const v = await getAdapter('lit.unlocks_next_year').run(sourceCtx({ asset: config, nowIso: NOW, http }), source.params);
    if (v.kind !== 'level') throw new Error('expected a level');
    expect(v.value).toBeCloseTo((9 / 36) * 498_000_000, 0);
    expect(v.detail).toMatch(/; tranches 36 x 1mo from 2027-01-29$/);

    // The repo's own file is untouched.
    expect(parseAssetYaml(readFileSync(join(ROOT, 'assets/lit.yaml'), 'utf8')).hash).toBe(LIT_HASH);
  });
});
