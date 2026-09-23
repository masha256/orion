import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { allowedRange, placeValue } from '../../src/agent/guardrails.js';
import { buildSystemPrompt } from '../../src/agent/prompt.js';
import { agentBand, budgetsFor, DEFAULT_BUDGETS, provisionalMovePct } from '../../src/config/agentPolicy.js';
import { loadAsset } from '../../src/config/load.js';
import { listPersonaNames, loadPersona, loadSkills, skillsFor } from '../../src/config/personas.js';
import { requiredAssumptionKeys } from '../../src/engine/requirements.js';
import { RUN_TYPES, SCENARIOS, type AssumptionValues } from '../../src/types.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function calibrated(): AssumptionValues {
  const raw = parseYaml(readFileSync(`${ROOT}/calibration/vvv-assumptions.yaml`, 'utf8')) as Record<string, Record<string, number>>;
  return { bear: { ...raw.all, ...raw.bear }, base: { ...raw.all, ...raw.base }, bull: { ...raw.all, ...raw.bull } };
}

describe('the shipped persona and skills', () => {
  it('load, and every run type gets at least one skill', () => {
    expect(listPersonaNames(ROOT)).toEqual(['ai-infra-analyst', 'onchain-dex-analyst']);
    expect(loadPersona(ROOT, 'ai-infra-analyst')).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(loadSkills(ROOT).map((s) => s.name)).toEqual(['anomaly-triage', 'assumption-review', 'bootstrap-research', 'disclosure-research', 'tokenomics-audit']);
    expect(skillsFor(ROOT, 'bootstrap').map((s) => s.name)).toEqual(['bootstrap-research', 'disclosure-research']);
    expect(skillsFor(ROOT, 'weekly').map((s) => s.name)).toEqual(['assumption-review', 'disclosure-research']);
    expect(skillsFor(ROOT, 'triage').map((s) => s.name)).toEqual(['anomaly-triage', 'disclosure-research']);
    expect(skillsFor(ROOT, 'deep').map((s) => s.name)).toEqual(['assumption-review', 'disclosure-research', 'tokenomics-audit']);
  });

  it('build a system prompt for every run type, in plain ASCII', () => {
    const persona = loadPersona(ROOT, 'ai-infra-analyst');
    for (const runType of RUN_TYPES) {
      const prompt = buildSystemPrompt(persona, skillsFor(ROOT, runType), runType);
      expect(prompt).toContain('# How Orion works');
      expect(/^[\x00-\x7F]*$/.test(prompt)).toBe(true);
    }
  });

  it('tell the agent the research rules the tool layer enforces', () => {
    const research = loadSkills(ROOT).find((s) => s.name === 'disclosure-research')!.body;
    expect(research).toContain('one paragraph, table cell, or list item');
    expect(research).toContain('already exists at the same metric and time');
    expect(research).toContain('EFFECTIVE date');
  });
});

describe('the agent bands in assets/vvv.yaml', () => {
  const { config } = loadAsset(ROOT, 'vvv');
  const values = calibrated();

  it('contain every calibrated value, so the agent starts inside its bands with room to move both ways or a reason it cannot', () => {
    for (const key of requiredAssumptionKeys(config)) {
      for (const s of SCENARIOS) {
        expect(placeValue(config, key, s, values[s][key]), `${key} ${s}`).toBe('in_band');
        expect(allowedRange(config, key, s, values[s][key]), `${key} ${s}`).not.toBeNull();
      }
    }
  });

  it('follow the mirror rule where the three calibrated values are strictly ordered, and are absent elsewhere', () => {
    // Calibrated 2026-09-21 from a sensitivity sweep: each band is symmetric around the calibrated value, so the agent
    // can argue a driver down as far as up, and the outer edges no longer reach the key-wide bounds, where the 12m
    // value was most sensitive (the bull discount rate could be walked to 8 percent for +$3.2 with no room the other way).
    for (const [key, b] of Object.entries(config.assumptions)) {
      if (!b.bear || !b.base || !b.bull) continue;
      for (const s of SCENARIOS) {
        // The bear DIEM growth value sits on the key floor, so its band can only be a sliver above it.
        if (key === 'diem_target_supply_growth' && s === 'bear') continue;
        const v = values[s][key];
        const band = b[s]!;
        expect(band.max - v, `${key} ${s}`).toBeCloseTo(v - band.min, 6);
      }
    }
    // The bull growth band is narrower than the mirror rule gives (one step was $4.4 of the 12m value): half a step each way.
    expect(agentBand(config, 'rev_growth_y1', 'bull')).toEqual({ min: 1.75, max: 2.25 });
    expect(agentBand(config, 'rev_growth_y1', 'bear')).toEqual({ min: -0.125, max: 0.625 });
    // Discount rates fall from bear to bull, so their bands do too.
    expect(agentBand(config, 'discount_rate_base', 'bear')).toEqual({ min: 0.175, max: 0.225 });
    expect(agentBand(config, 'discount_rate_base', 'bull')).toEqual({ min: 0.105, max: 0.135 });
    expect(agentBand(config, 'diem_target_supply_growth', 'bear')).toEqual({ min: 0, max: 0.0125 });
    for (const key of ['growth_fade_years', 'capture_ramp_years.burn', 'staked_ratio_horizon']) {
      expect(Object.keys(config.assumptions[key]).sort(), key).toEqual(['max', 'min']);
    }
  });

  it('keep the bands of neighbouring scenarios from overlapping, so bear, base, and bull cannot cross', () => {
    for (const [key, b] of Object.entries(config.assumptions)) {
      if (!b.bear || !b.base || !b.bull) continue;
      const rising = b.bear.max <= b.base.min && b.base.max <= b.bull.min;
      const falling = b.bull.max <= b.base.min && b.base.max <= b.bear.min;
      expect(rising || falling, key).toBe(true);
    }
  });

  it('raise the weekly input budget, leave the other budgets at their defaults, and set the move threshold explicitly', () => {
    // The first live dry run (2026-09-21) read a ~96k-token prefix per request and used 542k of the 600k default in 5 requests.
    expect(budgetsFor(config, 'weekly')).toEqual({ ...DEFAULT_BUDGETS.weekly, inputTokens: 2_000_000 });
    expect(budgetsFor(config, 'triage')).toEqual(DEFAULT_BUDGETS.triage);
    expect(provisionalMovePct(config)).toBe(25);
    // The user's rule (2026-09-22): no researched figure goes live unconfirmed, so allow_provisional stays off.
    expect(config.metrics.revenue_run_rate_usd).toMatchObject({ critical: true, allow_provisional: false });
    expect(config.metrics.revenue_run_rate_usd.source).toBeUndefined(); // research may write here; it may not write onto a fetched metric
  });
});
