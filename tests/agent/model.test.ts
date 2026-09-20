import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { credentialSource } from '../../src/agent/model.js';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('the SDK seam', () => {
  it('only src/agent/model.ts imports the Anthropic SDK as a value; everything else may import its types', () => {
    const valueImport = /^import\s+(?!type\b)[^;]*from\s+['"]@anthropic-ai\/sdk/m;
    const offenders = sourceFiles('src').filter((f) => valueImport.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([join('src', 'agent', 'model.ts')]);
  });

  it('no test constructs the real client', () => {
    const offenders = sourceFiles('tests').filter((f) => !f.endsWith('model.test.ts') && readFileSync(f, 'utf8').includes('anthropicModelClient'));
    expect(offenders).toEqual([]);
  });
});

describe('credentialSource', () => {
  it('names where credentials will come from, in the order the SDK would use them', () => {
    expect(credentialSource({ ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 't' }, true)).toBe('ANTHROPIC_API_KEY');
    expect(credentialSource({ ANTHROPIC_AUTH_TOKEN: 't' }, false)).toBe('ANTHROPIC_AUTH_TOKEN');
    expect(credentialSource({ ANTHROPIC_PROFILE: 'work' }, false)).toBe('ANTHROPIC_PROFILE');
    expect(credentialSource({ ANTHROPIC_FEDERATION_RULE_ID: 'r' }, false)).toBe('workload identity federation');
    expect(credentialSource({}, true)).toBe('an SDK profile on disk');
  });

  it('is null when nothing suggests credentials exist, so preflight can fail before a run row is written', () => {
    expect(credentialSource({}, false)).toBeNull();
    expect(credentialSource({ ANTHROPIC_API_KEY: '   ' }, false)).toBeNull();
  });
});
