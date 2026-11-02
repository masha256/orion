import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listPersonaNames, loadPersona, loadSkills, parsePersona, parseSkill, skillsFor } from '../../src/config/personas.js';
import type { OrionError } from '../../src/types.js';

const PERSONA = `---
name: analyst
temperament: skeptical
sectors: [ai-infrastructure]
---
You are a sector analyst.
`;

const skill = (name: string, runTypes: string): string => `---
name: ${name}
description: Does ${name}.
run_types: [${runTypes}]
---
Instructions for ${name}.
`;

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as OrionError).code;
  }
  return undefined;
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orion-personas-'));
  mkdirSync(join(home, 'personas'));
  mkdirSync(join(home, 'skills'));
});

describe('personas', () => {
  it('parses frontmatter with defaults, trims the body, and hashes the file text', () => {
    const p = parsePersona(PERSONA);
    expect(p).toMatchObject({
      name: 'analyst', model: 'claude-opus-5-5', effort: 'high', temperament: 'skeptical', sectors: ['ai-infrastructure'],
      body: 'You are a sector analyst.',
    });
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsePersona(PERSONA.replace('skeptical', 'sceptical')).hash).not.toBe(p.hash);
  });

  it('lets the file override model and effort', () => {
    const p = parsePersona(PERSONA.replace('name: analyst', 'name: analyst\nmodel: claude-sonnet-5\neffort: medium'));
    expect(p).toMatchObject({ model: 'claude-sonnet-5', effort: 'medium' });
  });

  it('treats temperament and sectors as optional descriptive metadata: a persona with only a name loads', () => {
    const p = parsePersona('---\nname: analyst\n---\nYou are an analyst.\n');
    expect(p).toMatchObject({ name: 'analyst', model: 'claude-opus-5-5', effort: 'high', temperament: '', sectors: [] });
  });

  it('rejects missing frontmatter, an empty body, unknown keys, and a bad effort', () => {
    expect(codeOf(() => parsePersona('You are an analyst.'))).toBe('invalid_persona');
    expect(codeOf(() => parsePersona('---\nname: analyst\n---\n   \n'))).toBe('invalid_persona');
    expect(codeOf(() => parsePersona(PERSONA.replace('temperament:', 'mood:')))).toBe('invalid_persona');
    expect(codeOf(() => parsePersona(PERSONA.replace('name: analyst', 'name: analyst\neffort: extreme')))).toBe('invalid_persona');
    expect(codeOf(() => parsePersona('---\nname: [unclosed\n---\nbody\n'))).toBe('invalid_persona');
  });

  it('loads by name, and the name must match the file', () => {
    writeFileSync(join(home, 'personas', 'analyst.md'), PERSONA);
    writeFileSync(join(home, 'personas', 'other.md'), PERSONA);
    expect(listPersonaNames(home)).toEqual(['analyst', 'other']);
    expect(loadPersona(home, 'analyst').name).toBe('analyst');
    expect(codeOf(() => loadPersona(home, 'other'))).toBe('invalid_persona');
    expect(codeOf(() => loadPersona(home, 'missing'))).toBe('persona_not_found');
    expect(codeOf(() => loadPersona(home, '../analyst'))).toBe('persona_not_found');
  });
});

describe('skills', () => {
  it('parses a skill and requires at least one runnable run type: disclosure is the only one', () => {
    expect(parseSkill(skill('disclosure-review', 'disclosure'))).toMatchObject({
      name: 'disclosure-review', description: 'Does disclosure-review.', runTypes: ['disclosure'], body: 'Instructions for disclosure-review.',
    });
    expect(codeOf(() => parseSkill(skill('x', '')))).toBe('invalid_skill');
    expect(codeOf(() => parseSkill(skill('x', 'daily')))).toBe('invalid_skill');
    // The retired run types: a skill file that still names one fails loudly instead of loading for a run that cannot start.
    for (const retired of ['weekly', 'triage', 'deep', 'bootstrap', 'disclosure, weekly']) expect(codeOf(() => parseSkill(skill('x', retired)))).toBe('invalid_skill');
  });

  it('rejects unknown frontmatter keys and a missing description', () => {
    expect(codeOf(() => parseSkill(skill('x', 'disclosure').replace('description:', 'summary:')))).toBe('invalid_skill');
    expect(codeOf(() => parseSkill(skill('x', 'disclosure').replace('run_types:', 'priority: 1\nrun_types:')))).toBe('invalid_skill');
  });

  it('selects the skills for a run type, sorted by name', () => {
    writeFileSync(join(home, 'skills', 'disclosure-review.md'), skill('disclosure-review', 'disclosure'));
    writeFileSync(join(home, 'skills', 'disclosure-research.md'), skill('disclosure-research', 'disclosure'));
    writeFileSync(join(home, 'skills', 'notes.txt'), 'ignored');
    expect(loadSkills(home).map((s) => s.name)).toEqual(['disclosure-research', 'disclosure-review']);
    expect(skillsFor(home, 'disclosure').map((s) => s.name)).toEqual(['disclosure-research', 'disclosure-review']);
  });

  it('fails the whole load when one skill file is invalid, misnamed, or names a retired run type', () => {
    writeFileSync(join(home, 'skills', 'disclosure-review.md'), skill('disclosure-review', 'disclosure'));
    writeFileSync(join(home, 'skills', 'broken.md'), 'no frontmatter');
    expect(codeOf(() => skillsFor(home, 'disclosure'))).toBe('invalid_skill');
    writeFileSync(join(home, 'skills', 'broken.md'), skill('renamed', 'disclosure'));
    expect(codeOf(() => skillsFor(home, 'disclosure'))).toBe('invalid_skill');
    writeFileSync(join(home, 'skills', 'broken.md'), skill('broken', 'weekly'));
    expect(codeOf(() => skillsFor(home, 'disclosure'))).toBe('invalid_skill');
  });

  it('returns nothing when the directory does not exist', () => {
    expect(loadSkills(join(home, 'nowhere'))).toEqual([]);
  });
});

describe('the shipped personas and skills', () => {
  const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

  it('ship the two disclosure skills only: the four skills of the retired run types are gone', () => {
    expect(loadSkills(ROOT_DIR).map((s) => s.name)).toEqual(['disclosure-research', 'disclosure-review']);
    for (const s of loadSkills(ROOT_DIR)) expect(s.runTypes).toEqual(['disclosure']);
  });

  it('no persona tells the analyst about assumptions, bands, targets or dominance', () => {
    expect(listPersonaNames(ROOT_DIR)).toHaveLength(6);
    for (const name of listPersonaNames(ROOT_DIR)) {
      const body = loadPersona(ROOT_DIR, name).body;
      for (const gone of ['assumption', ' band', 'target', 'dominance', 'valuation', 'rev_growth_y1', 'bear case']) expect(body, `${name}: ${gone}`).not.toContain(gone);
      expect(/^[\x00-\x7F]*$/.test(body)).toBe(true);
    }
  });
});

describe('the disclosure run text (2026-10-23)', () => {
  const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));

  it('disclosure runs load disclosure-review and disclosure-research only', () => {
    expect(skillsFor(ROOT_DIR, 'disclosure').map((s) => s.name)).toEqual(['disclosure-research', 'disclosure-review']);
  });

  it('the perp persona carries the disclosure paragraph and stays ASCII', () => {
    const body = loadPersona(ROOT_DIR, 'perp-exchange-analyst').body;
    expect(body).toContain('Issuer disclosures.');
    expect(body).toContain('A gap between the two is the finding; neither side is right by default.');
    expect(body).toContain('watch the team and investor unlocks (the tranche schedule is in the asset config)');
    expect(/^[\x00-\x7F]*$/.test(body)).toBe(true);
  });

  it('the persona names none of the Q3 findings', () => {
    const body = loadPersona(ROOT_DIR, 'perp-exchange-analyst').body;
    expect(body).not.toContain('Robinhood');
    expect(body).not.toContain('2027-01-29');
  });

  it('the disclosure-review skill names the real tools and none of the Q3 findings', () => {
    const review = skillsFor(ROOT_DIR, 'disclosure').find((s) => s.name === 'disclosure-review')!;
    expect(review.runTypes).toEqual(['disclosure']);
    for (const tool of ['get_flow_total', 'get_observations', 'propose_change', 'record_dev_finding', 'write_journal', 'asset_config_yaml', 'adapter_params']) {
      expect(review.body).toContain(tool);
    }
    for (const gone of ['apply_assumption_change', 'run_whatif', 'assumption', 'effect']) expect(review.body).not.toContain(gone);
    expect(/^[\x00-\x7F]*$/.test(review.body)).toBe(true);
    for (const leak of ['Robinhood', 'DefiLlama', '2027-01-29', 'CFTC', 'Q3']) expect(review.body).not.toContain(leak);
  });
});
