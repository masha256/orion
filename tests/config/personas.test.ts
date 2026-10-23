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
  it('parses a skill and requires at least one known run type', () => {
    expect(parseSkill(skill('assumption-review', 'weekly, deep'))).toMatchObject({
      name: 'assumption-review', description: 'Does assumption-review.', runTypes: ['weekly', 'deep'], body: 'Instructions for assumption-review.',
    });
    expect(codeOf(() => parseSkill(skill('x', '')))).toBe('invalid_skill');
    expect(codeOf(() => parseSkill(skill('x', 'daily')))).toBe('invalid_skill');
  });

  it('rejects unknown frontmatter keys and a missing description', () => {
    expect(codeOf(() => parseSkill(skill('x', 'weekly').replace('description:', 'summary:')))).toBe('invalid_skill');
    expect(codeOf(() => parseSkill(skill('x', 'weekly').replace('run_types:', 'priority: 1\nrun_types:')))).toBe('invalid_skill');
  });

  it('selects the skills for a run type, sorted by name', () => {
    writeFileSync(join(home, 'skills', 'tokenomics-audit.md'), skill('tokenomics-audit', 'deep'));
    writeFileSync(join(home, 'skills', 'assumption-review.md'), skill('assumption-review', 'weekly, deep'));
    writeFileSync(join(home, 'skills', 'anomaly-triage.md'), skill('anomaly-triage', 'triage'));
    writeFileSync(join(home, 'skills', 'notes.txt'), 'ignored');
    expect(loadSkills(home).map((s) => s.name)).toEqual(['anomaly-triage', 'assumption-review', 'tokenomics-audit']);
    expect(skillsFor(home, 'deep').map((s) => s.name)).toEqual(['assumption-review', 'tokenomics-audit']);
    expect(skillsFor(home, 'triage').map((s) => s.name)).toEqual(['anomaly-triage']);
  });

  it('fails the whole load when one skill file is invalid or misnamed', () => {
    writeFileSync(join(home, 'skills', 'assumption-review.md'), skill('assumption-review', 'weekly'));
    writeFileSync(join(home, 'skills', 'broken.md'), 'no frontmatter');
    expect(codeOf(() => skillsFor(home, 'weekly'))).toBe('invalid_skill');
    writeFileSync(join(home, 'skills', 'broken.md'), skill('renamed', 'weekly'));
    expect(codeOf(() => skillsFor(home, 'weekly'))).toBe('invalid_skill');
  });

  it('returns nothing when the directory does not exist', () => {
    expect(loadSkills(join(home, 'nowhere'))).toEqual([]);
  });
});

describe('dominance rule in the sector personas (2026-10-17)', () => {
  const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url));
  const SECTOR = ['onchain-dex-analyst', 'perp-exchange-analyst', 'consumer-launchpad-analyst', 'stablecoin-protocol-analyst', 'oracle-network-analyst'];
  for (const name of SECTOR) {
    it(`${name} carries the durability rule`, () => {
      const p = loadPersona(ROOT_DIR, name);
      expect(p.body).toContain('Dominance sets durability, not growth.');
      expect(p.body).toContain('`dominance_share`');
      expect(p.body).toContain('Never use it to move `rev_growth_y1` or a multiple');
    });
  }
  it('only the oracle persona carries the manual-research sentence', () => {
    for (const name of SECTOR) {
      expect(loadPersona(ROOT_DIR, name).body.includes('is manual: when the latest is more than 90 days old')).toBe(name === 'oracle-network-analyst');
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
    expect(body).toContain('watch the team and investor unlocks from 2026-12-29');
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
    for (const tool of ['get_flow_total', 'get_observations', 'propose_change', 'record_dev_finding', 'write_journal', 'apply_assumption_change', 'asset_config_yaml', 'adapter_params']) {
      expect(review.body).toContain(tool);
    }
    expect(/^[\x00-\x7F]*$/.test(review.body)).toBe(true);
    for (const leak of ['Robinhood', 'DefiLlama', '2027-01-29', 'CFTC', 'Q3']) expect(review.body).not.toContain(leak);
  });
});
