import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ImportManifest } from './importer.js';

export interface ReportsResult {
  ok: boolean;
  /** The new release's `report yield --help` lists `--legacy` (Phase 2, D9): its reports ran with it, compared less `incomeStatement`. */
  legacy: boolean;
  /** `identical`: same exit code and same stdout bytes, and stdout not empty (a CLI that printed nothing proves nothing). */
  files: { name: string; identical: boolean; old_exit: number; new_exit: number }[];
}

interface CliRun {
  stdout: Buffer;
  stderr: Buffer;
  exit: number;
}

/**
 * Runs a release's built CLI (`node <cli> ...args`) in `home`: `ORION_HOME` is the home, and no other `ORION_*` variable
 * of the caller's environment is passed on, so the home's `.env` (or its `orion.db`) decides which database is read.
 */
function runRelease(cli: string, home: string, args: string[]): Promise<CliRun> {
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ORION_')));
  env.ORION_HOME = home;
  return new Promise((resolveRun, reject) => {
    execFile(process.execPath, [resolve(cli), ...args], { cwd: home, env, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') {
        reject(err); // not an exit code: the process could not run at all
        return;
      }
      resolveRun({ stdout, stderr, exit: err ? (err.code as number) : 0 });
    });
  });
}

/**
 * The old release's `proposals list --all --json` without the proposals the import left out (the manifest's excluded
 * ids), re-serialised as the CLI prints it (`JSON.stringify(list, null, 2)` and a newline). Anything that is not a JSON
 * list (an error) is left as printed.
 */
function dropExcludedProposals(stdout: Buffer, manifest: ImportManifest): Buffer {
  const excluded = new Set((manifest.tables?.find((t) => t.table === 'proposals')?.excluded ?? []).flatMap((e) => e.ids));
  let list: unknown;
  try {
    list = JSON.parse(stdout.toString('utf8'));
  } catch {
    return stdout;
  }
  if (!Array.isArray(list)) return stdout;
  const kept = list.filter((p) => !excluded.has((p as { id?: number }).id as number));
  return Buffer.from(`${JSON.stringify(kept, null, 2)}\n`, 'utf8');
}

/**
 * A `report yield --json --legacy` output less its `incomeStatement` (the v1 object, D9), re-serialised as the CLI
 * prints JSON (`JSON.stringify(report, null, 2)` and a newline). Anything that is not a JSON object is left as printed.
 */
function dropIncomeStatement(stdout: Buffer): Buffer {
  let report: unknown;
  try {
    report = JSON.parse(stdout.toString('utf8'));
  } catch {
    return stdout;
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report) || !('incomeStatement' in report)) return stdout;
  const { incomeStatement: _v2, ...v1 } = report as Record<string, unknown>;
  return Buffer.from(`${JSON.stringify(v1, null, 2)}\n`, 'utf8');
}

/**
 * The cross-release comparison (spec 8.2): for every `assets/*.yaml` in the new home, `report yield <a> --day <D>
 * --json` with each release's CLI, then once each `data anomalies --all --json` and `proposals list --all --json`.
 * Outputs go to `<out>/old/` and `<out>/new/` (stderr, if any, beside them as `<name>.stderr`); a pair is identical
 * when the exit codes and the stdout bytes are, and stdout is not empty.
 *
 * A Phase 2 release drops the v1 report keys unless given `--legacy` (D9). So the new release's `report yield --help`
 * is read first (saved as `<out>/new/report-yield-help.txt`), as `tools/phase2-proof/reports.sh` does: when it lists
 * `--legacy`, the new side's reports run with it and are compared without their `incomeStatement` (the printed output
 * is kept as `<name minus .json>.unstripped.json`). A help that fails runs without the flag, so a Phase 2 release then
 * fails the comparison rather than passing it.
 */
export async function compareReports(opts: {
  oldCli: string;
  oldHome: string;
  newCli: string;
  newHome: string;
  day: string;
  manifest: ImportManifest;
  out: string;
}): Promise<ReportsResult> {
  const assets = readdirSync(join(opts.newHome, 'assets'))
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
  for (const side of ['old', 'new']) mkdirSync(join(opts.out, side), { recursive: true });
  const help = await runRelease(opts.newCli, opts.newHome, ['report', 'yield', '--help']);
  writeFileSync(join(opts.out, 'new', 'report-yield-help.txt'), help.stdout);
  if (help.stderr.length > 0) writeFileSync(join(opts.out, 'new', 'report-yield-help.txt.stderr'), help.stderr);
  const legacy = help.exit === 0 && help.stdout.toString('utf8').includes('--legacy');
  const jobs: { name: string; args: string[]; newArgs?: string[] }[] = [
    ...assets.map((a) => {
      const args = ['report', 'yield', a, '--day', opts.day, '--json'];
      return { name: `report-yield-${a}.json`, args, ...(legacy ? { newArgs: [...args, '--legacy'] } : {}) };
    }),
    { name: 'anomalies.json', args: ['data', 'anomalies', '--all', '--json'] },
    { name: 'proposals.json', args: ['proposals', 'list', '--all', '--json'] },
  ];
  const files: ReportsResult['files'] = [];
  for (const job of jobs) {
    const before = await runRelease(opts.oldCli, opts.oldHome, job.args);
    const after = await runRelease(opts.newCli, opts.newHome, job.newArgs ?? job.args);
    let old = before.stdout;
    let fresh = after.stdout;
    if (job.newArgs) {
      writeFileSync(join(opts.out, 'new', job.name.replace(/\.json$/, '.unstripped.json')), after.stdout);
      fresh = dropIncomeStatement(after.stdout);
    }
    if (job.name === 'proposals.json') {
      writeFileSync(join(opts.out, 'old', 'proposals.unfiltered.json'), before.stdout);
      old = dropExcludedProposals(before.stdout, opts.manifest);
    }
    writeFileSync(join(opts.out, 'old', job.name), old);
    writeFileSync(join(opts.out, 'new', job.name), fresh);
    for (const [side, run] of [['old', before], ['new', after]] as const) {
      if (run.stderr.length > 0) writeFileSync(join(opts.out, side, `${job.name}.stderr`), run.stderr);
    }
    files.push({
      name: job.name,
      identical: before.exit === after.exit && old.length > 0 && old.equals(fresh),
      old_exit: before.exit,
      new_exit: after.exit,
    });
  }
  return { ok: files.every((f) => f.identical), legacy, files };
}
