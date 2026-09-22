import type { Command } from 'commander';
import { estimateCostUsd } from '../../agent/cost.js';
import { runAgent, type RunAgentResult } from '../../agent/run.js';
import { lockHolder, withRunLock } from '../../app/lock.js';
import { loadAsset } from '../../config/load.js';
import { getAgentRun, getTranscript, listAgentRuns, type AgentRun } from '../../db/agentRuns.js';
import { emitSignal } from '../../signals/emit.js';
import { OrionError, RUN_TYPES, type RunType } from '../../types.js';
import { guarded, modelClientFor, output, parseNumber, signalSummary, withDb, withDbAsync, type CliContext } from '../util.js';

const isRunType = (x: string): x is RunType => (RUN_TYPES as readonly string[]).includes(x);

function usageLine(run: AgentRun): string {
  const u = run.usage;
  const cost = estimateCostUsd(run.model, u);
  return (
    `${u.requests} requests  input ${u.inputTokens} + ${u.cacheReadTokens} cached + ${u.cacheWriteTokens} cache writes  output ${u.outputTokens}  ` +
    `web ${u.webSearches} searches, ${u.webFetches} fetches  ${cost === null ? 'cost unknown for this model' : `about $${cost.toFixed(2)} at list price`}`
  );
}

function stagedLines(staged: RunAgentResult['staged'], verb: string): string[] {
  const lines: string[] = [];
  for (const c of staged.assumptionChanges) lines.push(`  ${verb} ${c.key} (${c.scenario}) ${c.start} -> ${c.value}: ${c.rationale}`);
  for (const r of staged.resolutions) lines.push(`  ${verb} anomaly #${r.anomalyId} resolved: ${r.note}`);
  for (const o of staged.observations) lines.push(`  ${verb} provisional ${o.metricKey} = ${o.value} at ${o.observedAt} (${o.live ? 'in the signal' : 'inert until confirmed'}) ${o.citationUrl}`);
  for (const p of staged.proposals) lines.push(`  ${verb} proposal ${p.change.kind}: ${p.rationale}`);
  if (staged.journal) lines.push(`  ${verb} journal: ${staged.journal.summary}`);
  return lines.length > 0 ? lines : ['  nothing staged'];
}

function runLine(r: AgentRun): string {
  return `#${r.id}  ${r.startedAt}  ${r.assetId}  ${r.runType}  ${r.persona}  ${r.outcome}${r.dryRun ? ' (dry run)' : ''}${r.error ? `  ${r.error}` : ''}`;
}

export function registerAgent(program: Command, ctx: CliContext): void {
  const agent = program.command('agent').description('run the analyst persona that covers an asset');

  agent
    .command('run <asset>')
    .description('one agent run; exit 0 completed, 2 completed with a blocked signal, 1 anything else')
    .requiredOption('--type <type>', 'weekly | triage | deep')
    .option('--anomaly <id>', 'triage: the anomaly to look into')
    .option('--note <text>', 'triage: a lead for the agent to verify (text or a URL); never evidence')
    .option('--dry-run', 'do everything except commit; spends tokens')
    .option('--out <file>', 'JSONL file to append the signal to, when the run produces one')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { type: string; anomaly?: string; note?: string; dryRun?: boolean; out?: string; json?: boolean }) =>
      guarded(ctx, opts.json, async () => {
        if (!isRunType(opts.type)) throw new OrionError('invalid_run_type', `--type must be one of ${RUN_TYPES.join(', ')}`);
        const runType = opts.type;
        const anomalyId = opts.anomaly === undefined ? undefined : parseNumber(opts.anomaly, '--anomaly');
        const loaded = loadAsset(ctx.home, assetId);
        const result = await withDbAsync(ctx, (db) =>
          withRunLock(db, assetId, lockHolder('agent run'), ctx.now(), () =>
            runAgent(db, loaded, { runType, anomalyId, note: opts.note, dryRun: opts.dryRun }, {
              home: ctx.home, now: ctx.now, modelClient: () => modelClientFor(ctx), reload: () => loadAsset(ctx.home, assetId),
            }),
          ),
        );
        if (result.signal && opts.out) emitSignal(result.signal, { write: () => undefined, outFile: opts.out });
        output(ctx, opts.json, result, () => [
          runLine(result.run),
          usageLine(result.run),
          ...stagedLines(result.staged, result.committed ? 'committed' : result.run.dryRun ? 'would commit' : 'discarded'),
          ...(result.signal
            ? signalSummary(result.signal)
            : [result.run.dryRun ? 'no signal: a dry run commits nothing and runs no valuation' : 'no signal: nothing this run committed can move one']),
        ]);
        if (result.run.outcome !== 'completed') ctx.setExitCode?.(1);
        else if (result.signal?.status === 'blocked') ctx.setExitCode?.(2);
      }),
    );

  const runs = agent.command('runs').description('past agent runs');

  runs
    .command('list [asset]')
    .option('--limit <n>', 'how many (default 20)')
    .option('--json', 'JSON output')
    .action((assetId: string | undefined, opts: { limit?: string; json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const limit = opts.limit === undefined ? 20 : parseNumber(opts.limit, '--limit');
        // SQLite reads a negative LIMIT as "no limit": refuse it here rather than return every row.
        if (!Number.isInteger(limit) || limit < 1) throw new OrionError('invalid_limit', `--limit must be a positive whole number, got ${opts.limit}`);
        const list = withDb(ctx, (db) => listAgentRuns(db, { assetId, limit }));
        output(ctx, opts.json, list, () => (list.length === 0 ? ['no agent runs'] : list.map(runLine)));
      }),
    );

  runs
    .command('show <id>')
    .description('outcome, what was committed, token counts, and an estimated cost')
    .option('--transcript', 'include the full conversation')
    .option('--json', 'JSON output')
    .action((id: string, opts: { transcript?: boolean; json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const runId = parseNumber(id, 'id');
        const { run, transcript } = withDb(ctx, (db) => ({ run: getAgentRun(db, runId), transcript: opts.transcript ? getTranscript(db, runId) : undefined }));
        if (!run) throw new OrionError('agent_run_not_found', `no agent run with id ${runId}`);
        const cost = estimateCostUsd(run.model, run.usage);
        const staged = (run.summary?.staged ?? null) as RunAgentResult['staged'] | null;
        output(ctx, opts.json, { ...run, estimated_cost_usd: cost, ...(opts.transcript ? { transcript } : {}) }, () => [
          runLine(run),
          `model ${run.model}  config ${run.configHash.slice(0, 12)}  trigger ${run.trigger} ${JSON.stringify(run.triggerDetail)}`,
          usageLine(run),
          ...(staged ? stagedLines(staged, run.summary?.committed ? 'committed' : run.dryRun ? 'would commit' : 'discarded') : []),
          ...(run.summary?.signal_id ? [`signal ${String(run.summary.signal_id)}`] : []),
          ...(run.summary?.valuation_error ? [`valuation failed after the commit: ${String(run.summary.valuation_error)}`] : []),
          ...(opts.transcript ? ['', JSON.stringify(transcript, null, 2)] : []),
        ]);
      }),
    );
}
