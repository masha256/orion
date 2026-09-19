import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, parseEnvFile } from '../../src/cli/env.js';

describe('.env loading', () => {
  it('parses KEY=value lines with comments, export, and quotes', () => {
    const text = ['# comment', '', 'A=1', 'export B="two words"', "C='x=y'", 'D = spaced ', 'not a line', 'E='].join('\n');
    expect(parseEnvFile(text)).toEqual({ A: '1', B: 'two words', C: 'x=y', D: 'spaced', E: '' });
  });

  it('strips a trailing inline comment from an unquoted value, but not from a quoted one or a bare #', () => {
    const text = ['F=value # trailing comment', 'G="quoted # not a comment"', "H='also # not a comment'", 'I=nohash#stuck'].join('\n');
    expect(parseEnvFile(text)).toEqual({ F: 'value', G: 'quoted # not a comment', H: 'also # not a comment', I: 'nohash#stuck' });
  });

  it('lets the process environment win over <ORION_HOME>/.env, and works without a file', () => {
    const home = mkdtempSync(join(tmpdir(), 'orion-env-'));
    expect(loadEnv(home, { X: 'proc' })).toEqual({ X: 'proc' });
    writeFileSync(join(home, '.env'), 'ORION_BASE_RPC_URL=https://rpc.example\nX=file\n');
    expect(loadEnv(home, { X: 'proc' })).toEqual({ ORION_BASE_RPC_URL: 'https://rpc.example', X: 'proc' });
  });
});
