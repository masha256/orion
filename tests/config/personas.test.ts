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
      name: 'analyst', model: 'claude-opus-5', effort: 'high', temperament: 'skeptical', sectors: ['ai-infrastructure'],
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
    expect(p).toMatchObject({ name: 'analyst', model: 'claude-opus-5', effort: 'high', temperament: '', sectors: [] });
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
