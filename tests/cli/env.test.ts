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

  it('lets the process environment win over the env file, and works without a file', () => {
    const home = mkdtempSync(join(tmpdir(), 'orion-env-'));
    const envFile = join(home, '.env');
    expect(loadEnv(envFile, { X: 'proc' })).toEqual({ X: 'proc' });
    writeFileSync(envFile, 'ORION_BASE_RPC_URL=https://rpc.example\nX=file\n');
    expect(loadEnv(envFile, { X: 'proc' })).toEqual({ ORION_BASE_RPC_URL: 'https://rpc.example', X: 'proc' });
  });

  it('env: loadEnv reads the given file, not <home>/.env', () => {
    const home = mkdtempSync(join(tmpdir(), 'orion-env-home-'));
    writeFileSync(join(home, '.env'), 'FROM=home\nHOME_ONLY=1\n');
    const shared = mkdtempSync(join(tmpdir(), 'orion-env-shared-'));
    writeFileSync(join(shared, '.env'), 'FROM=shared\n');
    expect(loadEnv(join(shared, '.env'), {})).toEqual({ FROM: 'shared' });
  });

  describe('an empty or whitespace-only process value does not override .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orion-env-empty-'));
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'ANTHROPIC_API_KEY=sk-from-file\nONLY_FILE=file-only\n');

    it('uses the file value when the process value is empty', () => {
      expect(loadEnv(envFile, { ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBe('sk-from-file');
    });

    it('uses the file value when the process value is whitespace only', () => {
      expect(loadEnv(envFile, { ANTHROPIC_API_KEY: '  \t ' }).ANTHROPIC_API_KEY).toBe('sk-from-file');
    });

    it('uses the file value when the process value is undefined', () => {
      expect(loadEnv(envFile, { ANTHROPIC_API_KEY: undefined }).ANTHROPIC_API_KEY).toBe('sk-from-file');
    });

    it('still lets a non-empty process value win', () => {
      expect(loadEnv(envFile, { ANTHROPIC_API_KEY: 'sk-from-proc' }).ANTHROPIC_API_KEY).toBe('sk-from-proc');
    });

    it('keeps a key that is only in the process env, empty or not', () => {
      const env = loadEnv(envFile, { ONLY_PROC: 'proc-only', EMPTY_PROC: '' });
      expect(env.ONLY_PROC).toBe('proc-only');
      expect(env.EMPTY_PROC).toBe('');
    });

    it('keeps a key that is only in the file', () => {
      expect(loadEnv(envFile, {}).ONLY_FILE).toBe('file-only');
    });
  });
});
