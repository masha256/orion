import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { orionEnv, readRelease, resolvePaths } from '../../src/cli/paths.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE = { tag: 'orion-2026.11.02.1', commit: '0123456789abcdef0123456789abcdef01234567', schema: 1, built_at: '2026-11-02T10:00:00.000Z' };

const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A release root as `pack.sh` lays it out: `RELEASE` beside `dist/cli/`. */
function releaseRoot(): string {
  const root = scratch('orion-release-');
  mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(root, 'RELEASE'), `${JSON.stringify(RELEASE)}\n`);
  return root;
}

describe('paths', () => {
  it('paths: a release root is the config root', () => {
    const root = releaseRoot();
    const p = resolvePaths({ ORION_HOME: '/h' }, join(root, 'dist', 'cli'));
    expect(p.configRoot).toBe(root);
    expect(p.home).toBe('/h');
    expect(p.envFile).toBe(join('/h', '.env'));
    expect(p.release).toEqual({ tag: 'orion-2026.11.02.1', commit: RELEASE.commit, schema: 1, builtAt: '2026-11-02T10:00:00.000Z' });
    expect(p.release?.tag).toBe('orion-2026.11.02.1');
  });

  it('paths: a dev checkout uses ORION_HOME for config', () => {
    const checkout = scratch('orion-checkout-');
    mkdirSync(join(checkout, 'src', 'cli'), { recursive: true });
    const p = resolvePaths({ ORION_HOME: '/h' }, join(checkout, 'src', 'cli'));
    expect(p).toEqual({ home: '/h', configRoot: '/h', envFile: join('/h', '.env'), release: null });
    // No ORION_HOME: the working directory is the home, as before.
    expect(resolvePaths({}, join(checkout, 'src', 'cli')).home).toBe(process.cwd());
    // This repository has no RELEASE file: run from source, the config is the home's.
    expect(resolvePaths({ ORION_HOME: '/h' }, join(ROOT, 'src', 'cli')).configRoot).toBe('/h');
  });

  it('paths: ORION_CONFIG_ROOT and ORION_ENV_FILE override', () => {
    const root = releaseRoot();
    const elsewhere = scratch('orion-config-');
    const p = resolvePaths({ ORION_HOME: '/h', ORION_CONFIG_ROOT: elsewhere, ORION_ENV_FILE: '/s/.env' }, join(root, 'dist', 'cli'));
    expect(p).toEqual({ home: '/h', configRoot: elsewhere, envFile: '/s/.env', release: null });
    // A config root that is a release carries its release info.
    expect(resolvePaths({ ORION_HOME: '/h', ORION_CONFIG_ROOT: root }, '/nowhere/dist/cli').release?.tag).toBe('orion-2026.11.02.1');
  });

  it('paths: a RELEASE file that is not the release record is refused, not ignored', () => {
    const root = releaseRoot();
    writeFileSync(join(root, 'RELEASE'), '{"tag": "orion-2026.11.02.1"}\n');
    expect(() => readRelease(root)).toThrow(expect.objectContaining({ code: 'invalid_release' }));
    writeFileSync(join(root, 'RELEASE'), 'not json\n');
    expect(() => readRelease(root)).toThrow(expect.objectContaining({ code: 'invalid_release' }));
    expect(readRelease(scratch('orion-norelease-'))).toBeNull();
  });

  it('paths: ORION_ENV is dev, stage or prod, default dev', () => {
    expect(orionEnv({})).toBe('dev');
    expect(orionEnv({ ORION_ENV: 'stage' })).toBe('stage');
    expect(orionEnv({ ORION_ENV: 'prod' })).toBe('prod');
    for (const bad of ['production', 'PROD', '', ' prod']) {
      expect(() => orionEnv({ ORION_ENV: bad }), bad).toThrow(expect.objectContaining({ code: 'invalid_orion_env' }));
    }
  });
});

/** The real entry point, from source, in its own process. Only the variables given (plus PATH) reach it. */
function orionProcess(env: Record<string, string>, ...args: string[]): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', join(ROOT, 'src', 'cli', 'index.ts'), ...args],
      { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') {
          reject(err);
          return;
        }
        done({ stdout, stderr, exit: err ? (err.code as number) : 0 });
      },
    );
  });
}

describe('the CLI process', () => {
  it('cli: asset list reads <configRoot>/assets while the data home is elsewhere', async () => {
    const config = scratch('orion-cfgroot-');
    mkdirSync(join(config, 'assets'));
    writeFileSync(join(config, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
    const home = scratch('orion-datahome-');
    mkdirSync(join(home, 'assets'));
    writeFileSync(join(home, 'assets', 'other.yaml'), MINI_ASSET_YAML.replace(/^id: mini$/m, 'id: other'));
    const r = await orionProcess({ ORION_HOME: home, ORION_CONFIG_ROOT: config, ORION_ENV_FILE: join(home, 'no.env') }, 'asset', 'list', '--json');
    expect(r.stderr).toBe('');
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['mini']);
  }, 30_000);
});
