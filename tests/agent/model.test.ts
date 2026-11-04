import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anthropicModelClient, credentialSource, refuseAgentOnStage } from '../../src/agent/model.js';
import { OrionError } from '../../src/types.js';

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

describe('anthropicModelClient on stage', () => {
  it('model: refuses on stage before building a client, whatever credentials are set (I-4)', () => {
    for (const env of [{ ORION_ENV: 'stage', ANTHROPIC_API_KEY: 'sk-ant-x' }, { ORION_ENV: 'stage', ANTHROPIC_AUTH_TOKEN: 't' }, { ORION_ENV: 'stage' }]) {
      let err: unknown;
      try {
        anthropicModelClient(env);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(OrionError);
      expect(err).toMatchObject({ code: 'agent_refused_stage' });
    }
    expect(() => refuseAgentOnStage({ ORION_ENV: 'prod' })).not.toThrow();
    expect(() => refuseAgentOnStage({})).not.toThrow();
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
