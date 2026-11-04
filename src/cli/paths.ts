import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { OrionError } from '../types.js';

/**
 * Where config, data and secrets live (spec §2.1, plan R4). In a dev checkout all three are `ORION_HOME`. On a server
 * the config is the release (`~/current/`: `assets/`, `personas/`, `skills/`, `RELEASE`), the data home is `~/home`
 * (`ORION_HOME`) and the secrets are `~/shared/.env` (`ORION_ENV_FILE`).
 */

/** The release a config root was shipped as: `<root>/RELEASE`, written by the release build. */
export interface ReleaseInfo {
  tag: string;
  commit: string;
  /** The highest migration id the release ships. */
  schema: number;
  builtAt: string;
}

export interface OrionPaths {
  /** The data home: `ticks.jsonl`, logs, manifests. */
  home: string;
  /** Where `assets/`, `personas/` and `skills/` are read from. */
  configRoot: string;
  /** The `.env` file `loadEnv` reads. */
  envFile: string;
  /** Non-null when the config root is a release: config changes then ship as releases, never as edits in place (D6). */
  release: ReleaseInfo | null;
}

export type OrionEnv = 'dev' | 'stage' | 'prod';
const ORION_ENVS: readonly OrionEnv[] = ['dev', 'stage', 'prod'];

const ReleaseFile = z.object({
  tag: z.string().min(1),
  commit: z.string().min(1),
  schema: z.number().int().nonnegative(),
  built_at: z.string().min(1),
});

/** `<root>/RELEASE` (JSON: `tag`, `commit`, `schema`, `built_at`), or null when there is none. A malformed one is refused. */
export function readRelease(root: string): ReleaseInfo | null {
  const file = join(root, 'RELEASE');
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new OrionError('invalid_release', `${file} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ReleaseFile.safeParse(raw);
  if (!parsed.success) {
    throw new OrionError('invalid_release', `${file} is not a release record: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const r = parsed.data;
  return { tag: r.tag, commit: r.commit, schema: r.schema, builtAt: r.built_at };
}

/**
 * The paths for this process. `cliDir` is the directory of the running entry point (`<release>/dist/cli` when built,
 * `<checkout>/src/cli` from source): its release root is two levels up, and is the config root when it holds a
 * `RELEASE` file. `ORION_CONFIG_ROOT` and `ORION_ENV_FILE` override; `ORION_HOME` defaults to the working directory.
 *
 * A release run (a `RELEASE` beside `dist/`, a release config root, or `ORION_ENV` stage or prod, which only servers
 * run) gets no defaults: `ORION_HOME` and `ORION_ENV_FILE` must be set (`release_env_required`, M-3; the orion-daemon
 * unit and orion-remote set both), and a stage or prod run whose `RELEASE` is missing is refused (`release_missing`,
 * I-3) instead of reading its config from `ORION_HOME`.
 */
export function resolvePaths(env: Record<string, string | undefined>, cliDir: string): OrionPaths {
  const home = env.ORION_HOME ?? process.cwd();
  const releaseRoot = resolve(cliDir, '..', '..');
  const shipped = readRelease(releaseRoot);
  const server = env.ORION_ENV === 'stage' || env.ORION_ENV === 'prod';
  const configRoot = env.ORION_CONFIG_ROOT ?? (shipped ? releaseRoot : home);
  const release = readRelease(configRoot);
  if (shipped || release || server) {
    const unset = (['ORION_HOME', 'ORION_ENV_FILE'] as const).filter((k) => (env[k] ?? '').trim() === '');
    if (unset.length > 0) {
      throw new OrionError(
        'release_env_required',
        `a release needs ORION_HOME and ORION_ENV_FILE set (the orion-daemon unit and orion-remote set both); not set: ${unset.join(', ')}`,
      );
    }
  }
  if (server && env.ORION_CONFIG_ROOT === undefined && !shipped) {
    throw new OrionError('release_missing', `ORION_ENV=${env.ORION_ENV} but ${releaseRoot} has no RELEASE file; a release never reads its config from ORION_HOME (${home})`);
  }
  return { home, configRoot, envFile: env.ORION_ENV_FILE ?? join(home, '.env'), release };
}

/** `ORION_ENV`: `dev` (the default), `stage` or `prod`. Anything else is refused rather than guessed at. */
export function orionEnv(env: Record<string, string | undefined>): OrionEnv {
  const value = env.ORION_ENV;
  if (value === undefined) return 'dev';
  if (!(ORION_ENVS as readonly string[]).includes(value)) {
    throw new OrionError('invalid_orion_env', `ORION_ENV must be one of ${ORION_ENVS.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value as OrionEnv;
}
