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

  describe('an empty or whitespace-only process value does not override .env', () => {
    const home = mkdtempSync(join(tmpdir(), 'orion-env-empty-'));
    writeFileSync(join(home, '.env'), 'ANTHROPIC_API_KEY=sk-from-file\nONLY_FILE=file-only\n');

    it('uses the file value when the process value is empty', () => {
      expect(loadEnv(home, { ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBe('sk-from-file');
    });

    it('uses the file value when the process value is whitespace only', () => {
      expect(loadEnv(home, { ANTHROPIC_API_KEY: '  \t ' }).ANTHROPIC_API_KEY).toBe('sk-from-file');
    });

    it('uses the file value when the process value is undefined', () => {
      expect(loadEnv(home, { ANTHROPIC_API_KEY: undefined }).ANTHROPIC_API_KEY).toBe('sk-from-file');
    });

    it('still lets a non-empty process value win', () => {
      expect(loadEnv(home, { ANTHROPIC_API_KEY: 'sk-from-proc' }).ANTHROPIC_API_KEY).toBe('sk-from-proc');
    });

    it('keeps a key that is only in the process env, empty or not', () => {
      const env = loadEnv(home, { ONLY_PROC: 'proc-only', EMPTY_PROC: '' });
      expect(env.ONLY_PROC).toBe('proc-only');
      expect(env.EMPTY_PROC).toBe('');
    });

    it('keeps a key that is only in the file', () => {
      expect(loadEnv(home, {}).ONLY_FILE).toBe('file-only');
    });
  });
});
