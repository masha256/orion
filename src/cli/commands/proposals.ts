import type { Command } from 'commander';
import { RETIRED_EFFECT } from '../../app/inbox.js';
import { approveProposal, rejectProposal, type ApproveResult } from '../../app/proposals.js';
import { changesAgentLimits } from '../../config/edit.js';
import type { Db } from '../../db/connection.js';
import { docLabel, getDocument } from '../../db/documents.js';
import { getObservationsByIds } from '../../db/observations.js';
import { getProposal, listProposals, type Proposal } from '../../db/proposals.js';
import { MS_PER_DAY, OrionError } from '../../types.js';
import { canonicalJson } from '../../util/canonical.js';
import { guarded, output, parseNumber, withDb, type CliContext } from '../util.js';

const DOC_SOURCE = /^doc:(\d+)$/;

/** One line per citation: the source, a transcript's locator, and for a stored document its fixed label (spec 5.3). */
async function citationLines(db: Db, p: Proposal): Promise<string[]> {
  const lines: string[] = [];
  for (const c of p.citations) {
    const m = DOC_SOURCE.exec(c.source);
    const doc = m ? await getDocument(db, Number(m[1])) : null;
    const label = m ? ` [${doc ? docLabel(doc) : 'document not found'}]` : '';
    lines.push(`  citation ${c.source}${c.locator === null ? '' : ` at ${c.locator}`}${label}: "${c.quotedText}"`);
  }
  return lines;
}

function changeSummary(p: Proposal): string {
  const c = p.change;
  switch (c.kind) {
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

// A stored effect is from the valuation era: never shown as a live target (--json keeps the stored object).
function effectSummary(p: Proposal): string {
  return p.effect === null ? '' : RETIRED_EFFECT;
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

export function registerProposals(program: Command, ctx: CliContext): void {
  const proposals = program.command('proposals').description('changes the agent may not make itself, for you to approve or reject');

  proposals
    .command('list [asset]')
    .description('pending proposals, newest first')
    .option('--all', 'include approved and rejected proposals')
    .option('--json', 'JSON output')
    .action((assetId: string | undefined, opts: { all?: boolean; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const list = await withDb(ctx, (db) => listProposals(db, { assetId, includeDecided: opts.all }));
        output(ctx, opts.json, list, () => (list.length === 0 ? ['no proposals'] : list.map((p) => proposalLine(p, ctx.now()))));
      }),
    );

  proposals
    .command('show <id>')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const proposalId = parseNumber(id, 'id');
        const { p, evidence, citations } = await withDb(ctx, async (db) => {
          const found = await getProposal(db, proposalId);
          return { p: found, evidence: found ? await getObservationsByIds(db, found.evidence) : [], citations: found ? await citationLines(db, found) : [] };
        });
        if (!p) throw new OrionError('proposal_not_found', `no proposal with id ${proposalId}`);
        output(ctx, opts.json, { ...p, evidence_observations: evidence }, () => [
          proposalLine(p, ctx.now()),
          `filed ${p.createdAt}${p.agentRunId === null ? '' : ` by agent run #${p.agentRunId}`}; filed against ${JSON.stringify(p.filedAgainst)}`,
          `rationale: ${p.rationale}`,
          ...evidence.map((o) => `  evidence #${o.id}  ${o.metricKey} = ${o.value} at ${o.observedAt} (${o.source}, ${o.status})${o.citationUrl ? ` ${o.citationUrl}` : ''}`),
          ...(p.change.kind === 'observation' ? [`  quote: "${p.change.quotedText}"`] : []),
          ...citations,
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
      guarded(ctx, opts.json, async () => {
        const outcome = await withDb(ctx, (db) => approveProposal(db, ctx.configRoot, parseNumber(id, 'id'), { note: opts.note, now: ctx.now(), release: ctx.release }));
        output(ctx, opts.json, outcome, () => [`proposal #${outcome.proposal.id} approved`, ...approvedLines(outcome.result)]);
      }),
    );

  proposals
    .command('reject <id>')
    .requiredOption('--note <text>', 'why; the agent reads it in later runs')
    .option('--json', 'JSON output')
    .action((id: string, opts: { note: string; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const p = await withDb(ctx, (db) => rejectProposal(db, parseNumber(id, 'id'), opts.note, ctx.now()));
        output(ctx, opts.json, p, () => [`proposal #${p.id} rejected: ${p.decisionNote}`]);
      }),
    );
}
