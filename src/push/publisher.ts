import { hostname } from 'node:os';
import { join } from 'node:path';
import { orionEnv, type OrionEnv, type OrionPaths } from '../cli/paths.js';
import { OrionError } from '../types.js';
import { gitPublisher, type GitRun } from './gitPublisher.js';

/**
 * Where snapshots go (spec 9.2). `ORION_PUBLISH` picks the driver per environment: `git:<url>#<branch>` (now),
 * `s3:...` (later; refused until built), unset = publishing off (snapshots still go to the outbox).
 */
export interface Publisher {
  /** Writes `files` (path -> exact text) and makes them visible to the site; `message` describes the publish. */
  publish(files: Record<string, string>, message: string): Promise<{ ref: string }>;
}

export type PublishTarget = { driver: 'git'; url: string; branch: string } | { driver: 's3' };

/** A branch name git accepts and that cannot be read as an option. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![./])$/;

export function parsePublishTarget(v: string | undefined): PublishTarget | null {
  const text = (v ?? '').trim();
  if (text === '') return null;
  if (text.startsWith('s3:')) return { driver: 's3' };
  const m = /^git:([^#\s]+)(?:#(.*))?$/.exec(text);
  const branch = m?.[2] ?? 'main';
  if (!m || m[1].startsWith('-') || !BRANCH.test(branch)) {
    throw new OrionError('invalid_publish_target', `ORION_PUBLISH must be git:<url>#<branch> (or s3:..., not built yet), got ${JSON.stringify(text)}`);
  }
  return { driver: 'git', url: m[1], branch };
}

const PROD_REPO = /(^|[/:])orion-data(\.git)?(#|\/?$)/;
const STAGE_REPO = /(^|[/:])orion-data-staging(\.git)?(#|\/?$)/;

/**
 * Refuses a publish target the environment must never use (N11): staging naming the prod repo `orion-data`, prod
 * naming the staging repo `orion-data-staging`; also a malformed target and a driver not built yet. The daemon checks
 * it at start, and `snapshot_push` again on every run (the `.env` is re-read for each job).
 */
export function checkPublishTarget(env: OrionEnv, publish: string | undefined): void {
  const text = (publish ?? '').trim();
  if (env === 'stage' && PROD_REPO.test(text)) {
    throw new OrionError('publish_repo_is_prod', 'ORION_ENV=stage but ORION_PUBLISH names the prod snapshot repo orion-data');
  }
  if (env === 'prod' && STAGE_REPO.test(text)) {
    throw new OrionError('publish_repo_is_stage', 'ORION_ENV=prod but ORION_PUBLISH names the staging snapshot repo orion-data-staging');
  }
  if (parsePublishTarget(text)?.driver === 's3') {
    throw new OrionError('publish_driver_not_built', 'ORION_PUBLISH names an s3 target; the S3 driver is not built yet (Phase 1.5 builds the git driver only)');
  }
}

/**
 * The publisher `ORION_PUBLISH` names, or null when publishing is off. The git driver keeps its clone in
 * `ORION_PUBLISH_DIR` (default `<home>/publish`), pushes with `ORION_PUBLISH_SSH_KEY` and commits as
 * `orion-<env>@<host>` (default: `ORION_ENV` and this host's name).
 */
export function publisherFromEnv(
  envVars: Record<string, string | undefined>,
  paths: OrionPaths,
  run: GitRun,
  o: { env?: OrionEnv; host?: string } = {},
): Publisher | null {
  const target = parsePublishTarget(envVars.ORION_PUBLISH);
  if (target === null) return null;
  if (target.driver === 's3') {
    throw new OrionError('publish_driver_not_built', 'ORION_PUBLISH names an s3 target; the S3 driver is not built yet (Phase 1.5 builds the git driver only)');
  }
  const dir = (envVars.ORION_PUBLISH_DIR ?? '').trim() || join(paths.home, 'publish');
  const sshKeyFile = (envVars.ORION_PUBLISH_SSH_KEY ?? '').trim() || undefined;
  return gitPublisher({ url: target.url, branch: target.branch, dir, sshKeyFile, author: `orion-${o.env ?? orionEnv(envVars)}@${o.host ?? hostname()}`, run });
}
