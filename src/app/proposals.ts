import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ReleaseInfo } from '../cli/paths.js';
import { applyEditsToYaml, getAtPath, unproposableEdits } from '../config/edit.js';
import { loadAsset, parseAssetYaml } from '../config/load.js';
import { decideAnomaly, getAnomaly } from '../db/anomalies.js';
import type { Db } from '../db/connection.js';
import { confirmObservation, getObservationsByIds, insertObservation, listActiveObservations, rejectObservation } from '../db/observations.js';
import { decideProposal, getProposal, type Proposal } from '../db/proposals.js';
import { disclosedProvenance } from '../provenance/locator.js';
import { OrionError, type PathSegment } from '../types.js';
import { canonicalJson } from '../util/canonical.js';
import { valueInForce } from './eligibility.js';

/** What approving did, for the command to print. */
export type ApproveResult =
  | { kind: 'anomaly'; anomalyId: number; status: 'acknowledged' | 'resolved' }
  | { kind: 'observation'; observationId: number; action: 'confirmed' | 'rejected' | 'inserted' }
  | { kind: 'config'; file: string; changes: { path: PathSegment[]; from: unknown; to: unknown }[] };

const stale = (id: number, what: string): never => {
  throw new OrionError('stale_proposal', `proposal ${id} is stale: ${what}. Reject it with a note, or wait for the agent to file it again.`);
};

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

async function pending(db: Db, id: number): Promise<Proposal> {
  const p = await getProposal(db, id);
  if (!p) throw new OrionError('proposal_not_found', `no proposal with id ${id}`);
  if (p.status !== 'pending') throw new OrionError('proposal_not_pending', `proposal ${id} is already ${p.status}`);
  return p;
}

/** Decisions are final. The note is required: the agent reads it in later runs. */
export async function rejectProposal(db: Db, id: number, note: string, now: Date): Promise<Proposal> {
  if (note.trim() === '') throw new OrionError('note_required', 'a note is required: say why, so the agent learns from it');
  await pending(db, id);
  return decideProposal(db, id, 'rejected', note, now.toISOString());
}

/**
 * Applies a proposal through the same functions the CLI uses, after checking that what it was filed against still holds.
 * Database kinds are one transaction. A config proposal edits `<configRoot>/assets/<id>.yaml` in place and restores the
 * file if marking the proposal approved fails. With `release` (the config root is a shipped release, D6) a config
 * proposal never writes: it is approved only once the release's YAML already holds every proposed value, else
 * `config_needs_release`.
 */
export async function approveProposal(
  db: Db, configRoot: string, id: number, opts: { note?: string; now: Date; release?: ReleaseInfo | null },
): Promise<{ proposal: Proposal; result: ApproveResult }> {
  const p = await pending(db, id);
  // The asset id becomes part of a file path below, and it comes off a stored row. A row from an older build, or one
  // edited in the database, must not be able to steer a write out of <configRoot>/assets. Checked before any path is built.
  if (!/^[a-z0-9-]+$/.test(p.assetId)) {
    throw new OrionError('invalid_proposal', `proposal ${id} names "${p.assetId}", which is not an asset id`);
  }
  const nowIso = opts.now.toISOString();
  const note = opts.note?.trim() || null;
  const change = p.change;

  if (change.kind === 'config') return approveConfig(db, configRoot, p, note, nowIso, opts.release ?? null);

  // Under the asset's transaction lock: every kind below checks what the proposal was filed against before it writes.
  // A row of another asset reached from here (a stored proposal citing another asset's observation or anomaly) is
  // refused by the nested write's own lock (`tx_asset_mismatch`), and the transaction rolls back.
  return db.tx(async (t) => {
    let result: ApproveResult;
    switch (change.kind) {
      case 'acknowledge_anomaly':
      case 'withdraw_acknowledgement': {
        const needed = change.kind === 'acknowledge_anomaly' ? 'open' : 'acknowledged';
        const anomaly = await getAnomaly(t, change.anomalyId);
        if (!anomaly || anomaly.status !== needed) stale(id, `anomaly ${change.anomalyId} is ${anomaly?.status ?? 'missing'}, not ${needed}`);
        const status = change.kind === 'acknowledge_anomaly' ? 'acknowledged' : 'resolved';
        await decideAnomaly(t, change.anomalyId, status, note ?? change.note, nowIso);
        result = { kind: 'anomaly', anomalyId: change.anomalyId, status };
        break;
      }

      case 'confirm_observation':
      case 'reject_observation': {
        const o = (await getObservationsByIds(t, [change.observationId]))[0];
        const active = o !== undefined && o.supersededBy === null && o.status !== 'rejected';
        if (!active) stale(id, `observation ${change.observationId} is no longer active`);
        if (change.kind === 'confirm_observation') {
          if (o.status !== 'provisional') stale(id, `observation ${o.id} is already ${o.status}`);
          const by = { approvedBy: `user (proposal #${id})` };
          result = { kind: 'observation', observationId: (await confirmObservation(t, o.id, nowIso, by)).id, action: 'confirmed' };
        } else {
          await rejectObservation(t, o.id);
          result = { kind: 'observation', observationId: o.id, action: 'rejected' };
        }
        break;
      }

      case 'observation': {
        const { config, hash } = loadAsset(configRoot, p.assetId);
        const filed = (p.filedAgainst as { inForce: number | null }).inForce;
        // The last CONFIRMED value: the same baseline the move guard measured from when it filed this proposal.
        const inForce = await valueInForce(t, config, change.metricKey, nowIso, { confirmedOnly: true });
        if (inForce !== filed) stale(id, `${change.metricKey} was ${filed} when it was filed and is ${inForce} now`);
        // Approving never supersedes silently either: a confirmed insert would retire every active row at this metric and time.
        const at = new Date(change.observedAt).toISOString();
        const taken = (await listActiveObservations(t, p.assetId, change.metricKey)).find((o) => o.observedAt === at);
        if (taken) stale(id, `observation #${taken.id} of ${change.metricKey} at ${at} now exists (${taken.status}, value ${taken.value}); reject it first if this proposal's value should replace it`);
        const row = await insertObservation(t, {
          assetId: p.assetId, metricKey: change.metricKey, observedAt: change.observedAt, periodDays: change.periodDays, value: change.value,
          status: 'confirmed', citationUrl: change.citationUrl, quotedText: change.quotedText, fetchedAt: nowIso,
          sourceDetail: `research:${p.persona}:run ${p.agentRunId ?? 'none'}; approved proposal #${id}`,
          // A figure the analyst filed from a citation and the user approved: disclosed, the citation required.
          provenance: disclosedProvenance(hash, {
            citationUrl: change.citationUrl, approvedBy: `user (proposal #${id})`, approvedAt: nowIso,
            proposedBy: `research:${p.persona}:run ${p.agentRunId ?? 'none'}`,
          }),
        });
        result = { kind: 'observation', observationId: row.id, action: 'inserted' };
        break;
      }
    }
    return { proposal: await decideProposal(t, id, 'approved', note, nowIso), result };
  }, { lockAsset: p.assetId });
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

async function approveConfig(
  db: Db, configRoot: string, p: Proposal, note: string | null, nowIso: string, release: ReleaseInfo | null,
): Promise<{ proposal: Proposal; result: ApproveResult }> {
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

  const file = join(configRoot, 'assets', `${p.assetId}.yaml`);
  if (!existsSync(file)) throw new OrionError('asset_not_found', `no asset config at ${file}`);
  const original = readFileSync(file, 'utf8');

  // 1. Stale check, against the file as written: the same view the proposal was filed against.
  const raw = parseYaml(original) as unknown;
  const current = edits.map((e) => getAtPath(raw, e.path));
  const changes = edits.map((e, i) => ({ path: e.path, from: current[i], to: e.value }));
  // The file already holds every proposed value: an earlier approve renamed the file and died before recording it, or
  // (in a release) the change was committed, shipped and deployed.
  if (edits.every((e, i) => same(current[i], e.value))) {
    return { proposal: await decideProposal(db, p.id, 'approved', note, nowIso), result: { kind: 'config', file, changes } };
  }
  // A release's files are what was built and deployed: an edit in place would be overwritten by the next deploy and
  // would make the running config differ from its tag. The change goes through git and a release instead (D6).
  if (release !== null) {
    throw new OrionError(
      'config_needs_release',
      `proposal ${p.id} changes assets/${p.assetId}.yaml; commit the change, ship a release, deploy it, then approve`,
    );
  }
  edits.forEach((e, i) => {
    if (!same(current[i], filed[i])) stale(p.id, `${e.path.join(' > ')} was ${JSON.stringify(filed[i])} when it was filed and is ${JSON.stringify(current[i])} now`);
  });

  // 2 and 3. Edit the text, then validate it with the real loader before it touches the disk.
  const edited = applyEditsToYaml(original, edits);
  const { config } = parseAssetYaml(edited);
  if (config.id !== p.assetId) throw new OrionError('invalid_asset_config', `the edit would change the asset id to "${config.id}"`);

  // 4. Write the file.
  writeAtomically(file, edited);

  // 5. Mark it approved. If that fails, put the original text back, and never let a failed restore hide why.
  try {
    return { proposal: await decideProposal(db, p.id, 'approved', note, nowIso), result: { kind: 'config', file, changes } };
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
