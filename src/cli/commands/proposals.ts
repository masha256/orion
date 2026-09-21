import type { Command } from 'commander';
import { approveProposal, rejectProposal, type ApproveResult } from '../../app/proposals.js';
import { changesAgentLimits } from '../../config/edit.js';
import { getObservationsByIds } from '../../db/observations.js';
import { getProposal, listProposals, type Proposal } from '../../db/proposals.js';
import { MS_PER_DAY, OrionError } from '../../types.js';
import { canonicalJson } from '../../util/canonical.js';
import { guarded, output, parseNumber, withDb, type CliContext } from '../util.js';

function changeSummary(p: Proposal): string {
  const c = p.change;
  switch (c.kind) {
    case 'assumption_value':
      return `${c.key} (${c.scenario}) -> ${c.value}`;
    case 'config':
      // " > ", as src/config/edit.ts prints a path: assumption keys contain dots, so a dotted path is ambiguous.
      return c.edits.map((e) => `${e.path.join(' > ')} = ${e.value === null ? '(delete)' : JSON.stringify(e.value)}`).join('; ');
    case 'acknowledge_anomaly':
      return `acknowledge anomaly #${c.anomalyId}`;
    case 'withdraw_acknowledgement':
      return `withdraw the acknowledgement of anomaly #${c.anomalyId}`;
    case 'confirm_observation':
      return `confirm observation #${c.observationId}`;
    case 'reject_observation':
      return `reject observation #${c.observationId}`;
    case 'observation':
      return `${c.metricKey} = ${c.value} at ${c.observedAt} (${c.citationUrl})`;
  }
}

function effectSummary(p: Proposal): string {
  if (p.effect === null) return '';
  if ('blocked' in p.effect) return `blocks the engine: ${p.effect.blocked.join('; ')}`;
  const e = p.effect['12m'];
  return `12m ${e.from === null ? 'n/a' : e.from.toFixed(2)} -> ${e.to.toFixed(2)}`;
}

function proposalLine(p: Proposal, now: Date): string {
  const age = Math.floor((now.getTime() - Date.parse(p.createdAt)) / MS_PER_DAY);
  const effect = effectSummary(p);
  // Approving one of these changes the rules the next run plays by, not just a number: say so where the user decides.
  const limits = p.change.kind === 'config' && changesAgentLimits(p.change.edits) ? "  [changes the agent's limits]" : '';
  return `#${p.id}  ${p.assetId}  ${p.persona}  ${p.change.kind}  ${p.status}  ${changeSummary(p)}${effect ? `  [${effect}]` : ''}${limits}  ${age}d old`;
}

function approvedLines(result: ApproveResult): string[] {
  switch (result.kind) {
    case 'assumption_value':
      return [`saved as assumption set v${result.setVersion}`];
    case 'anomaly':
      return [`anomaly #${result.anomalyId} is now ${result.status}`];
    case 'observation':
      return [`observation #${result.observationId} ${result.action}`];
    case 'config':
      return [
        `edited ${result.file}:`,
        // Canonical JSON, so old and new print with the same key order whatever order the YAML or the proposal used.
        ...result.changes.map((c) => `  ${c.path.join(' > ')}: ${canonicalJson(c.from)} -> ${c.to === null ? '(deleted)' : canonicalJson(c.to)}`),
        'review it with "git diff", then commit it',
      ];
  }
}

export function registerProposals(model: Command, ctx: CliContext): void {
  const proposals = model.command('proposals').description('changes the agent may not make itself, for you to approve or reject');

  proposals
    .command('list [asset]')
    .description('pending proposals, newest first')
    .option('--all', 'include approved and rejected proposals')
    .option('--json', 'JSON output')
    .action((assetId: string | undefined, opts: { all?: boolean; json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const list = withDb(ctx, (db) => listProposals(db, { assetId, includeDecided: opts.all }));
        output(ctx, opts.json, list, () => (list.length === 0 ? ['no proposals'] : list.map((p) => proposalLine(p, ctx.now()))));
      }),
    );

  proposals
    .command('show <id>')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const proposalId = parseNumber(id, 'id');
        const { p, evidence } = withDb(ctx, (db) => {
          const found = getProposal(db, proposalId);
          return { p: found, evidence: found ? getObservationsByIds(db, found.evidence) : [] };
        });
        if (!p) throw new OrionError('proposal_not_found', `no proposal with id ${proposalId}`);
        output(ctx, opts.json, { ...p, evidence_observations: evidence }, () => [
          proposalLine(p, ctx.now()),
          `filed ${p.createdAt}${p.agentRunId === null ? '' : ` by agent run #${p.agentRunId}`}; filed against ${JSON.stringify(p.filedAgainst)}`,
          `rationale: ${p.rationale}`,
          ...evidence.map((o) => `  evidence #${o.id}  ${o.metricKey} = ${o.value} at ${o.observedAt} (${o.source}, ${o.status})${o.citationUrl ? ` ${o.citationUrl}` : ''}`),
          ...(p.change.kind === 'observation' ? [`  quote: "${p.change.quotedText}"`] : []),
          ...(p.status === 'pending' ? [] : [`${p.status} ${p.decidedAt ?? ''}${p.decisionNote ? `: ${p.decisionNote}` : ''}`]),
        ]);
      }),
    );

  proposals
    .command('approve <id>')
    .description('apply the proposal; a config proposal edits assets/<asset>.yaml in place')
    .option('--note <text>', 'why; the agent reads it in later runs')
    .option('--json', 'JSON output')
    .action((id: string, opts: { note?: string; json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const outcome = withDb(ctx, (db) => approveProposal(db, ctx.home, parseNumber(id, 'id'), { note: opts.note, now: ctx.now() }));
        output(ctx, opts.json, outcome, () => [`proposal #${outcome.proposal.id} approved`, ...approvedLines(outcome.result)]);
      }),
    );

  proposals
    .command('reject <id>')
    .requiredOption('--note <text>', 'why; the agent reads it in later runs')
    .option('--json', 'JSON output')
    .action((id: string, opts: { note: string; json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const p = withDb(ctx, (db) => rejectProposal(db, parseNumber(id, 'id'), opts.note, ctx.now()));
        output(ctx, opts.json, p, () => [`proposal #${p.id} rejected: ${p.decisionNote}`]);
      }),
    );
}
