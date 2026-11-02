import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateCostUsd } from '../../agent/cost.js';
import type { StagedPreview } from '../../agent/ledger.js';
import { runAgent } from '../../agent/run.js';
import { lockHolder, withRunLock } from '../../app/lock.js';
import { loadAsset } from '../../config/load.js';
import { getAgentRun, getTranscript, listAgentRuns, type AgentRun } from '../../db/agentRuns.js';
import { OrionError, RUNNABLE_RUN_TYPES, type RunnableRunType } from '../../types.js';
import { guarded, modelClientFor, output, parseNumber, withDb, type CliContext } from '../util.js';

const isRunnable = (x: string): x is RunnableRunType => (RUNNABLE_RUN_TYPES as readonly string[]).includes(x);

/**
 * A run summary's `staged`, as stored. Rows written before a field existed lack it, and rows of the retired run types
 * (weekly, triage, deep, bootstrap) carry the assumption changes they staged, so `agent runs show` still prints those.
 */
type StoredStaged = Partial<StagedPreview> & {
  assumptionChanges?: { key: string; scenario: string; start: number; value: number; rationale: string }[];
};

function usageLine(run: AgentRun): string {
  const u = run.usage;
  const cost = estimateCostUsd(run.model, u);
  return (
    `${u.requests} requests  input ${u.inputTokens} + ${u.cacheReadTokens} cached + ${u.cacheWriteTokens} cache writes  output ${u.outputTokens}  ` +
    `web ${u.webSearches} searches, ${u.webFetches} fetches  ${cost === null ? 'cost unknown for this model' : `about $${cost.toFixed(2)} at list price`}`
  );
}

function stagedLines(staged: StoredStaged, verb: string): string[] {
  const lines: string[] = [];
  for (const c of staged.assumptionChanges ?? []) lines.push(`  ${verb} ${c.key} (${c.scenario}) ${c.start} -> ${c.value}: ${c.rationale}`);
  for (const r of staged.resolutions ?? []) lines.push(`  ${verb} anomaly #${r.anomalyId} resolved: ${r.note}`);
  for (const o of staged.observations ?? []) lines.push(`  ${verb} provisional ${o.metricKey} = ${o.value} at ${o.observedAt} (${o.live ? 'in force until reviewed' : 'inert until confirmed'}) ${o.citationUrl}`);
  for (const p of staged.proposals ?? []) lines.push(`  ${verb} proposal ${p.change.kind}: ${p.rationale}`);
  if (staged.journal) {
    lines.push(`  ${verb} journal: ${staged.journal.summary}`);
    // `?? []`: run summaries stored before catalysts existed have none.
    for (const c of staged.journal.catalysts ?? []) {
      const when = c.by !== undefined ? `by ${c.by}` : `${c.from}..${c.to}`;
      const where = c.citations.map((x) => (x.locator === null ? x.source : `${x.source}@${x.locator}`)).join(', ');
      lines.push(`  ${verb} catalyst ${when} ${c.kind}: ${c.event} [${where}]`);
    }
  }
  // `?? []`: run summaries stored before dev findings existed have none.
  for (const f of staged.devFindings ?? []) {
    const where = f.citations
      .map((x) => `${x.locator === null ? x.source : `${x.source}@${x.locator}`}${x.docKind === null ? '' : ` (${x.docKind.replace('_', ' ')})`}`)
      .join(', ');
    lines.push(`  ${verb} dev finding ${f.category} [${f.metricKeys.join(', ')}]: ${f.title} [${where}]`);
  }
  return lines.length > 0 ? lines : ['  nothing staged'];
}

/** What the reserve request did, when it ran: `summary.reserve` is absent on a run that never needed it. */
function reserveLines(run: AgentRun): string[] {
  const reason = (run.summary?.reserve as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason !== 'string') return [];
  return [run.outcome === 'completed' ? `finished on reserve after ${reason}` : `reserve request used after ${reason}; nothing committed`];
}

function runLine(r: AgentRun): string {
  return `#${r.id}  ${r.startedAt}  ${r.assetId}  ${r.runType}  ${r.persona}  ${r.outcome}${r.dryRun ? ' (dry run)' : ''}${r.error ? `  ${r.error}` : ''}`;
}

export function registerAgent(program: Command, ctx: CliContext): void {
  const agent = program.command('agent').description('run the analyst persona that covers an asset');

  agent
    .command('run <asset>')
    .description('one disclosure run on a stored document; exit 0 completed, 1 anything else')
    .requiredOption('--type <type>', 'disclosure (the only run type)')
    .option('--anomaly <id>', 'an open anomaly to look into, shown in the pack')
    .option('--note <text>', 'a lead for the agent to verify (text or a URL), shown in the pack; never evidence')
    .option('--doc <id>', 'the stored document to read (orion doc list); required')
    .option('--dry-run', 'do everything except commit; spends tokens')
    // The disclosure watcher passes --out on its real-run command line; nothing is written to it since signals went.
    .option('--out <file>', 'accepted and ignored: no run writes a signal any more')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { type: string; anomaly?: string; note?: string; doc?: string; dryRun?: boolean; out?: string; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        if (!isRunnable(opts.type)) throw new OrionError('invalid_run_type', `--type must be one of ${RUNNABLE_RUN_TYPES.join(', ')}`);
        const runType = opts.type;
        const anomalyId = opts.anomaly === undefined ? undefined : parseNumber(opts.anomaly, '--anomaly');
        const docId = opts.doc === undefined ? undefined : parseNumber(opts.doc, '--doc');
        const loaded = loadAsset(ctx.home, assetId);
        // The file as the user wrote it, comments included: the pack shows it.
        const assetYaml = readFileSync(join(ctx.home, 'assets', `${assetId}.yaml`), 'utf8');
        const result = await withDb(ctx, (db) =>
          withRunLock(db, assetId, lockHolder('agent run'), ctx.now(), () =>
            runAgent(db, loaded, { runType, anomalyId, note: opts.note, dryRun: opts.dryRun, docId, assetYaml }, {
              home: ctx.home, now: ctx.now, modelClient: () => modelClientFor(ctx), reload: () => loadAsset(ctx.home, assetId),
            })
          , { onReleaseError: (err) => ctx.stderr?.(`warning: the run lock could not be released (${err instanceof Error ? err.message : String(err)}); it expires on its own`) }),
        );
        output(ctx, opts.json, result, () => [
          runLine(result.run),
          usageLine(result.run),
          ...reserveLines(result.run),
          ...stagedLines(result.staged, result.committed ? 'committed' : result.run.dryRun ? 'would commit' : 'discarded'),
        ]);
        if (result.run.outcome !== 'completed') ctx.setExitCode?.(1);
      }),
    );

  const runs = agent.command('runs').description('past agent runs');

  runs
    .command('list [asset]')
    .option('--limit <n>', 'how many (default 20)')
    .option('--json', 'JSON output')
    .action((assetId: string | undefined, opts: { limit?: string; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const limit = opts.limit === undefined ? 20 : parseNumber(opts.limit, '--limit');
        // SQLite reads a negative LIMIT as "no limit": refuse it here rather than return every row.
        if (!Number.isInteger(limit) || limit < 1) throw new OrionError('invalid_limit', `--limit must be a positive whole number, got ${opts.limit}`);
        const list = await withDb(ctx, (db) => listAgentRuns(db, { assetId, limit }));
        output(ctx, opts.json, list, () => (list.length === 0 ? ['no agent runs'] : list.map(runLine)));
      }),
    );

  runs
    .command('show <id>')
    .description('outcome, what was committed, token counts, and an estimated cost')
    .option('--transcript', 'include the full conversation')
    .option('--json', 'JSON output')
    .action((id: string, opts: { transcript?: boolean; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        const runId = parseNumber(id, 'id');
        const { run, transcript } = await withDb(ctx, async (db) => ({ run: await getAgentRun(db, runId), transcript: opts.transcript ? await getTranscript(db, runId) : undefined }));
        if (!run) throw new OrionError('agent_run_not_found', `no agent run with id ${runId}`);
        const cost = estimateCostUsd(run.model, run.usage);
        const staged = (run.summary?.staged ?? null) as StoredStaged | null;
        output(ctx, opts.json, { ...run, estimated_cost_usd: cost, ...(opts.transcript ? { transcript } : {}) }, () => [
          runLine(run),
          `model ${run.model}  config ${run.configHash.slice(0, 12)}  trigger ${run.trigger} ${JSON.stringify(run.triggerDetail)}`,
          usageLine(run),
          ...reserveLines(run),
          ...(staged ? stagedLines(staged, run.summary?.committed ? 'committed' : run.dryRun ? 'would commit' : 'discarded') : []),
          // Runs of the retired types valued the asset after their commit: their summaries carry the signal or the failure.
          ...(run.summary?.signal_id ? [`signal ${String(run.summary.signal_id)}`] : []),
          ...(run.summary?.valuation_error ? [`valuation failed after the commit: ${String(run.summary.valuation_error)}`] : []),
          ...(opts.transcript ? ['', JSON.stringify(transcript, null, 2)] : []),
        ]);
      }),
    );
}
