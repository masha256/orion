import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/ingest/time.js';
import type { ReportInput } from '../../src/report/holderYield.js';
import { yieldReport } from '../../src/report/load.js';
import { ALL_ASSETS, repoAsset, syntheticInput } from '../helpers/syntheticReport.js';

/**
 * Task 11 (G4) proof on fixture data: `report yield --json` (v2) for all 13 repo assets, on two synthetic inputs (the
 * stored values; and a statement series on a second price basis with row provenance, as the loader passes it), must be
 * byte-identical to the JSON written at cc59fa7, before `holder_flows`/`reporting` and the v1 report were retired.
 * The inputs are hashed too, so a changed fixture cannot pass by moving both sides. UPDATE_GOLDEN=1 rewrites the file
 * (only ever at the base commit).
 */
const GOLDEN = fileURLToPath(new URL('./golden/v2-report-13.json', import.meta.url));

/**
 * The loader's shape: statement series on tokens x prices for flow_usd metrics, a price basis and a provenance per day.
 */
function loaderLike(input: ReportInput): ReportInput {
  const statementDaily = new Map<string, Map<string, number>>();
  const priceBasis = new Map<string, Map<string, 'hourly' | 'legacy'>>();
  const provenance = new Map<string, Map<string, { method: 'measured' | 'derived' | 'disclosed'; label: string }>>();
  for (const [m, days] of input.daily) {
    const usd = m.startsWith('flow_usd.');
    statementDaily.set(m, new Map([...days].map(([d, v], i) => [d, usd ? v * (1 + 0.003 * Math.sin(i)) : v])));
    if (usd) priceBasis.set(m, new Map([...days.keys()].map((d, i) => [d, i % 5 === 0 ? 'legacy' : 'hourly'])));
    provenance.set(m, new Map([...days.keys()].map((d, i) => [d, { method: i % 17 === 0 ? 'disclosed' : i % 7 === 0 ? 'derived' : 'measured', label: `onchain:${m}` }])));
  }
  return { ...input, statementDaily, priceBasis, provenance };
}

/** Rising series (positive growth, so trailing PEG is a number) and one disclosure only (the disclosed-growth note). */
function growing(input: ReportInput): ReportInput {
  const daily = new Map([...input.daily].map(([m, days]) => [m, new Map([...days].map(([d, v], i) => [d, v * (1 + (200 - i) / 120)]))]));
  return { ...input, daily, levels: { ...input.levels, disclosed: input.levels.disclosed.slice(-1) } };
}

const serial = (input: ReportInput): string =>
  JSON.stringify(input, (k, v) => (k === 'asset' ? undefined : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function compute(): Record<string, { input: string; report: string }> {
  const out: Record<string, { input: string; report: string }> = {};
  for (const id of ALL_ASSETS) {
    const base = syntheticInput(repoAsset(id));
    const prior = syntheticInput(repoAsset(id), addDays(base.day, -40));
    for (const [variant, input] of [['stored', base], ['loader', loaderLike(base)], ['prior', loaderLike(prior)], ['growing', growing(base)], ['growing-loader', loaderLike(growing(base))]] as const) {
      out[`${id}/${variant}`] = { input: sha(serial(input)), report: JSON.stringify(yieldReport(input)) };
    }
  }
  return out;
}

/**
 * The golden is written ONLY under UPDATE_GOLDEN=1 (fix round 1, M3): a missing file fails the suite rather than being
 * regenerated from the tree under test, which would make every case pass against itself.
 */
function readGolden(path: string, now: Record<string, { input: string; report: string }>, update = process.env.UPDATE_GOLDEN === '1'): Record<string, { input: string; report: string }> {
  if (update) writeFileSync(path, `${JSON.stringify(now, null, 1)}\n`);
  if (!existsSync(path)) throw new Error(`golden ${path} is missing: regenerate it only at the base commit, with UPDATE_GOLDEN=1`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, { input: string; report: string }>;
}

describe('v2 report JSON, golden at cc59fa7 (Task 11)', () => {
  const now = compute();
  const golden = readGolden(GOLDEN, now);

  it('a missing golden fails; it is never regenerated without UPDATE_GOLDEN=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orion-v2golden-'));
    const missing = join(dir, 'gone.json');
    expect(() => readGolden(missing, now, false)).toThrow(/is missing/);
    expect(existsSync(missing)).toBe(false);
  });

  it('covers the 13 assets x 5 inputs', () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(now).sort());
    expect(Object.keys(golden)).toHaveLength(65);
  });

  it.each(Object.keys(now))('%s: same input, byte-identical report', (key) => {
    expect(now[key]!.input).toBe(golden[key]!.input);
    expect(now[key]!.report).toBe(golden[key]!.report);
    expect(JSON.parse(now[key]!.report).incomeStatement).toEqual(expect.objectContaining({ schema: 2 }));
  });
});
