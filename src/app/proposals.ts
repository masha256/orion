import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { applyEditsToYaml, getAtPath } from '../config/edit.js';
import { loadAsset, parseAssetYaml } from '../config/load.js';
import { decideAnomaly, getAnomaly } from '../db/anomalies.js';
import { insertAssumptionChange } from '../db/assumptionChanges.js';
import { getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { confirmObservation, getObservationsByIds, insertObservation, rejectObservation } from '../db/observations.js';
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
  const nowIso = opts.now.toISOString();
  const note = opts.note?.trim() || null;
  const change = p.change;

  if (change.kind === 'config') return approveConfig(db, home, p, note, nowIso);

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
        const inForce = valueInForce(db, config, change.metricKey, nowIso);
        if (inForce !== filed) stale(id, `${change.metricKey} was ${filed} when it was filed and is ${inForce} now`);
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
  })();
}

function approveConfig(db: Db, home: string, p: Proposal, note: string | null, nowIso: string): { proposal: Proposal; result: ApproveResult } {
  if (p.change.kind !== 'config') throw new Error('not a config proposal');
  const edits = p.change.edits;
  const file = join(home, 'assets', `${p.assetId}.yaml`);
  const original = readFileSync(file, 'utf8');

  // 1. Stale check, against the file as written: the same view the proposal was filed against.
  const raw = parseYaml(original) as unknown;
  const filed = p.filedAgainst as unknown[];
  const changes = edits.map((e, i) => {
    const from = getAtPath(raw, e.path);
    if (!same(from, filed[i])) stale(p.id, `${e.path.join(' > ')} was ${JSON.stringify(filed[i])} when it was filed and is ${JSON.stringify(from)} now`);
    return { path: e.path, from, to: e.value };
  });

  // 2 and 3. Edit the text, then validate it with the real loader before it touches the disk.
  const edited = applyEditsToYaml(original, edits);
  const { config } = parseAssetYaml(edited);
  if (config.id !== p.assetId) throw new OrionError('invalid_asset_config', `the edit would change the asset id to "${config.id}"`);
  const errors = validateAssetModules(config);
  const latest = getLatestAssumptionSet(db, p.assetId);
  if (latest) errors.push(...validateAssumptions(config, latest.values));
  if (errors.length > 0) throw new OrionError('invalid_asset_config', `the edited config is not valid:\n${errors.join('\n')}`);

  // 4. Write beside the file, then rename over it: a crash never leaves half a config.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, edited);
  renameSync(tmp, file);

  // 5. Mark it approved. If that fails, put the original text back.
  try {
    return { proposal: decideProposal(db, p.id, 'approved', note, nowIso), result: { kind: 'config', file, changes } };
  } catch (err) {
    writeFileSync(file, original);
    throw err;
  }
}
