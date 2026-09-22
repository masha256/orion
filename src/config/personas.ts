import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z, ZodError } from 'zod';
import { OrionError, RUN_TYPES, type RunType } from '../types.js';
import { sha256 } from '../util/canonical.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_MODEL = 'claude-opus-5-5';

const NAME = /^[a-z0-9][a-z0-9-]*$/;

const PersonaFrontmatter = z.strictObject({
  name: z.string().regex(NAME),
  model: z.string().min(1).default(DEFAULT_MODEL),
  effort: z.enum(EFFORTS).default('high'),
  temperament: z.string().default(''),
  sectors: z.array(z.string()).default([]),
});

const SkillFrontmatter = z.strictObject({
  name: z.string().regex(NAME),
  description: z.string().min(1),
  run_types: z.array(z.enum(RUN_TYPES)).min(1),
});

export interface Persona {
  name: string;
  model: string;
  effort: Effort;
  temperament: string;
  sectors: string[];
  /** The persona's system prompt. */
  body: string;
  /** sha256 of the file text: runs record which wording they used. */
  hash: string;
}

export interface Skill {
  name: string;
  description: string;
  runTypes: RunType[];
  body: string;
  hash: string;
}

/** `---`, YAML, `---`, then the body. The body must not be blank. */
function splitFrontmatter(text: string, code: string, label: string): { front: unknown; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new OrionError(code, `${label}: expected YAML frontmatter between --- lines, then the body`);
  const body = match[2].trim();
  if (body === '') throw new OrionError(code, `${label}: the body is empty`);
  let front: unknown;
  try {
    front = parseYaml(match[1]);
  } catch (err) {
    throw new OrionError(code, `${label}: frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { front, body };
}

function parseWith<T>(schema: z.ZodType<T>, front: unknown, code: string, label: string): T {
  try {
    return schema.parse(front);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new OrionError(code, err.issues.map((i) => `${label}: ${i.path.join('.') || '(frontmatter)'}: ${i.message}`).join('\n'));
    }
    throw err;
  }
}

export function parsePersona(text: string, label = 'persona'): Persona {
  const { front, body } = splitFrontmatter(text, 'invalid_persona', label);
  const f = parseWith(PersonaFrontmatter, front, 'invalid_persona', label);
  return { name: f.name, model: f.model, effort: f.effort, temperament: f.temperament, sectors: f.sectors, body, hash: sha256(text) };
}

export function parseSkill(text: string, label = 'skill'): Skill {
  const { front, body } = splitFrontmatter(text, 'invalid_skill', label);
  const f = parseWith(SkillFrontmatter, front, 'invalid_skill', label);
  return { name: f.name, description: f.description, runTypes: f.run_types, body, hash: sha256(text) };
}

function markdownNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .sort();
}

export function listPersonaNames(home: string): string[] {
  return markdownNames(join(home, 'personas'));
}

export function loadPersona(home: string, name: string): Persona {
  const path = join(home, 'personas', `${name}.md`);
  if (!NAME.test(name) || !existsSync(path)) throw new OrionError('persona_not_found', `no persona file at ${path}`);
  const persona = parsePersona(readFileSync(path, 'utf8'), path);
  if (persona.name !== name) throw new OrionError('invalid_persona', `${path}: name "${persona.name}" does not match the file name`);
  return persona;
}

/** Every skill file, sorted by name. One invalid file fails the load: a run must never start with a skill silently missing. */
export function loadSkills(home: string): Skill[] {
  const dir = join(home, 'skills');
  return markdownNames(dir).map((name) => {
    const path = join(dir, `${name}.md`);
    const skill = parseSkill(readFileSync(path, 'utf8'), path);
    if (skill.name !== name) throw new OrionError('invalid_skill', `${path}: name "${skill.name}" does not match the file name`);
    return skill;
  });
}

/** The skills a run type loads, sorted by name so the system prompt is byte-stable. */
export function skillsFor(home: string, runType: RunType): Skill[] {
  return loadSkills(home).filter((s) => s.runTypes.includes(runType));
}
