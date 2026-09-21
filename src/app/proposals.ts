import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { applyEditsToYaml, getAtPath, unproposableEdits } from '../config/edit.js';
import { loadAsset, parseAssetYaml } from '../config/load.js';
import { decideAnomaly, getAnomaly } from '../db/anomalies.js';
import { insertAssumptionChange } from '../db/assumptionChanges.js';
import { getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { confirmObservation, getObservationsByIds, insertObservation, listActiveObservations, rejectObservation } from '../db/observations.js';
import { decideProposal, getProposal, type Proposal } from '../db/proposals.js';
import { validateAssetModules, validateAssumptions } from '../engine/requirements.js';
import { OrionError, type AssumptionValues, type PathSegment } from '../types.js';
import { canonicalJson } from '../util/canonical.js';
import { saveAssumptions } from './assumptions.js';
import { valueInForce } from './eligibility.js';

/** What approving did, for the command to print. */
export type ApproveResult =
  | { kind: 'assumption_value'; setVersion: number }
  | { kind: 'anomaly'; anomalyId: number; status: 'acknowledged' | 'resolved' }
  | { kind: 'observation'; observationId: number; action: 'confirmed' | 'rejected' | 'inserted' }
  | { kind: 'config'; file: string; changes: { path: PathSegment[]; from: unknown; to: unknown }[] };

const stale = (id: number, what: string): never => {
  throw new OrionError('stale_proposal', `proposal ${id} is stale: ${what}. Reject it with a note, or wait for the agent to file it again.`);
};

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function pending(db: Db, id: number): Proposal {
  const p = getProposal(db, id);
  if (!p) throw new OrionError('proposal_not_found', `no proposal with id ${id}`);
  if (p.status !== 'pending') throw new OrionError('proposal_not_pending', `proposal ${id} is already ${p.status}`);
  return p;
}

/** Decisions are final. The note is required: the agent reads it in later runs. */
export function rejectProposal(db: Db, id: number, note: string, now: Date): Proposal {
  if (note.trim() === '') throw new OrionError('note_required', 'a note is required: say why, so the agent learns from it');
  pending(db, id);
  return decideProposal(db, id, 'rejected', note, now.toISOString());
}

/**
 * Applies a proposal through the same functions the CLI uses, after checking that what it was filed against still holds.
 * Database kinds are one transaction. A config proposal edits assets/<id>.yaml in place and restores the file if marking
 * the proposal approved fails. No valuation runs here: the next `orion update` picks the change up.
 */
export function approveProposal(db: Db, home: string, id: number, opts: { note?: string; now: Date }): { proposal: Proposal; result: ApproveResult } {
  const p = pending(db, id);
  // The asset id becomes part of a file path below, and it comes off a stored row. A row from an older build, or one
  // edited in the database, must not be able to steer a write out of <home>/assets. Checked before any path is built.
  if (!/^[a-z0-9-]+$/.test(p.assetId)) {
    throw new OrionError('invalid_proposal', `proposal ${id} names "${p.assetId}", which is not an asset id`);
  }
  const nowIso = opts.now.toISOString();
  const note = opts.note?.trim() || null;
  const change = p.change;

  if (change.kind === 'config') return approveConfig(db, home, p, note, nowIso);

  // IMMEDIATE: every kind below checks what the proposal was filed against before it writes, and a deferred transaction
  // takes the write lock only at that first write. A concurrent commit in between would fail this one with
  // SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot retry away.
  return db.transaction(() => {
    let result: ApproveResult;
    switch (change.kind) {
      case 'assumption_value': {
        const { config } = loadAsset(home, p.assetId);
        const latest = getLatestAssumptionSet(db, p.assetId);
        if (!latest) throw new OrionError('no_assumption_set', `no assumption set for ${p.assetId}`);
        const current = latest.values[change.scenario][change.key];
        const filed = (p.filedAgainst as { value: number | null }).value;
        if (current !== filed) stale(id, `${change.key} (${change.scenario}) was ${filed} when it was filed and is ${current} now`);
        const bounds = config.assumptions[change.key];
        if (bounds && (change.value < bounds.min || change.value > bounds.max)) {
          throw new OrionError(
            'outside_key_bounds',
            `${change.value} is outside the key-wide bounds [${bounds.min}, ${bounds.max}] of ${change.key}; widen assumptions.${change.key} in assets/${p.assetId}.yaml first`,
          );
        }
        const values: AssumptionValues = { bear: { ...latest.values.bear }, base: { ...latest.values.base }, bull: { ...latest.values.bull } };
        values[change.scenario][change.key] = change.value;
        const set = saveAssumptions(db, config, values, {
          author: 'user', rationale: `Approved proposal #${id} from ${p.persona}: ${p.rationale}`, now: opts.now,
        });
        insertAssumptionChange(db, {
          setId: set.id, key: change.key, scenario: change.scenario, fromValue: current, toValue: change.value, rationale: p.rationale, evidence: p.evidence,
        });
        result = { kind: 'assumption_value', setVersion: set.version };
        break;
      }

      case 'acknowledge_anomaly':
      case 'withdraw_acknowledgement': {
        const needed = change.kind === 'acknowledge_anomaly' ? 'open' : 'acknowledged';
        const anomaly = getAnomaly(db, change.anomalyId);
        if (!anomaly || anomaly.status !== needed) stale(id, `anomaly ${change.anomalyId} is ${anomaly?.status ?? 'missing'}, not ${needed}`);
        const status = change.kind === 'acknowledge_anomaly' ? 'acknowledged' : 'resolved';
        decideAnomaly(db, change.anomalyId, status, note ?? change.note, nowIso);
        result = { kind: 'anomaly', anomalyId: change.anomalyId, status };
        break;
      }

      case 'confirm_observation':
      case 'reject_observation': {
        const o = getObservationsByIds(db, [change.observationId])[0];
        const active = o !== undefined && o.supersededBy === null && o.status !== 'rejected';
        if (!active) stale(id, `observation ${change.observationId} is no longer active`);
        if (change.kind === 'confirm_observation') {
          if (o.status !== 'provisional') stale(id, `observation ${o.id} is already ${o.status}`);
          result = { kind: 'observation', observationId: confirmObservation(db, o.id, nowIso).id, action: 'confirmed' };
        } else {
          rejectObservation(db, o.id);
          result = { kind: 'observation', observationId: o.id, action: 'rejected' };
        }
        break;
      }

      case 'observation': {
        const { config } = loadAsset(home, p.assetId);
        const filed = (p.filedAgainst as { inForce: number | null }).inForce;
        // The last CONFIRMED value: the same baseline the move guard measured from when it filed this proposal.
        const inForce = valueInForce(db, config, change.metricKey, nowIso, { confirmedOnly: true });
        if (inForce !== filed) stale(id, `${change.metricKey} was ${filed} when it was filed and is ${inForce} now`);
        // Approving never supersedes silently either: a confirmed insert would retire every active row at this metric and time.
        const at = new Date(change.observedAt).toISOString();
        const taken = listActiveObservations(db, p.assetId, change.metricKey).find((o) => o.observedAt === at);
        if (taken) stale(id, `observation #${taken.id} of ${change.metricKey} at ${at} now exists (${taken.status}, value ${taken.value}); reject it first if this proposal's value should replace it`);
        const row = insertObservation(db, {
          assetId: p.assetId, metricKey: change.metricKey, observedAt: change.observedAt, periodDays: change.periodDays, value: change.value,
          source: 'manual', status: 'confirmed', citationUrl: change.citationUrl, quotedText: change.quotedText, fetchedAt: nowIso,
          sourceDetail: `research:${p.persona}:run ${p.agentRunId ?? 'none'}; approved proposal #${id}`,
        });
        result = { kind: 'observation', observationId: row.id, action: 'inserted' };
        break;
      }
    }
    return { proposal: decideProposal(db, id, 'approved', note, nowIso), result };
  }).immediate();
}

/** Writes beside the file, then renames over it: a crash never leaves half a config, and a failure never leaves the temp file. */
function writeAtomically(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function approveConfig(db: Db, home: string, p: Proposal, note: string | null, nowIso: string): { proposal: Proposal; result: ApproveResult } {
  if (p.change.kind !== 'config') throw new Error('not a config proposal');
  const edits = p.change.edits;

  // The tool refuses these when a proposal is filed. Approve acts with the USER's authority on a stored row, so it checks
  // again: a row from an older build, or one edited in the database, must never raise the agent's own limits.
  const blocked = unproposableEdits(edits);
  if (blocked.length > 0) {
    throw new OrionError('path_not_proposable', `proposal ${p.id} edits ${blocked.map((e) => e.path.join(' > ')).join(', ')}; nothing under agent or id can be changed by a proposal`);
  }
  const filed = p.filedAgainst;
  if (!Array.isArray(filed) || filed.length !== edits.length) {
    throw new OrionError('invalid_proposal', `proposal ${p.id} does not record what each of its ${edits.length} edits was filed against`);
  }

  const file = join(home, 'assets', `${p.assetId}.yaml`);
  if (!existsSync(file)) throw new OrionError('asset_not_found', `no asset config at ${file}`);
  const original = readFileSync(file, 'utf8');

  // 1. Stale check, against the file as written: the same view the proposal was filed against.
  const raw = parseYaml(original) as unknown;
  const current = edits.map((e) => getAtPath(raw, e.path));
  const changes = edits.map((e, i) => ({ path: e.path, from: current[i], to: e.value }));
  // The file already holds every proposed value: an earlier approve renamed the file and died before recording it.
  if (edits.every((e, i) => same(current[i], e.value))) {
    return { proposal: decideProposal(db, p.id, 'approved', note, nowIso), result: { kind: 'config', file, changes } };
  }
  edits.forEach((e, i) => {
    if (!same(current[i], filed[i])) stale(p.id, `${e.path.join(' > ')} was ${JSON.stringify(filed[i])} when it was filed and is ${JSON.stringify(current[i])} now`);
  });

  // 2 and 3. Edit the text, then validate it with the real loader before it touches the disk.
  const edited = applyEditsToYaml(original, edits);
  const { config } = parseAssetYaml(edited);
  if (config.id !== p.assetId) throw new OrionError('invalid_asset_config', `the edit would change the asset id to "${config.id}"`);
  const errors = validateAssetModules(config);
  const latest = getLatestAssumptionSet(db, p.assetId);
  if (latest) errors.push(...validateAssumptions(config, latest.values));
  if (errors.length > 0) throw new OrionError('invalid_asset_config', `the edited config is not valid:\n${errors.join('\n')}`);

  // 4. Write the file.
  writeAtomically(file, edited);

  // 5. Mark it approved. If that fails, put the original text back, and never let a failed restore hide why.
  try {
    return { proposal: decideProposal(db, p.id, 'approved', note, nowIso), result: { kind: 'config', file, changes } };
  } catch (err) {
    try {
      writeAtomically(file, original);
    } catch (restoreErr) {
      throw new OrionError(
        'config_restore_failed',
        `marking proposal ${p.id} approved failed (${messageOf(err)}), and restoring ${file} failed too (${messageOf(restoreErr)}). ` +
          'The file holds the EDITED config: check it with git diff.',
      );
    }
    throw err;
  }
}
