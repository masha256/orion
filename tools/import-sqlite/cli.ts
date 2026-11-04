#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkSchemaName } from '../../src/db/connection.js';
import { OrionError } from '../../src/types.js';
import { importSqlite, type ImportManifest } from './importer.js';
import { proveImport } from './proof.js';
import { compareReports } from './reports.js';

/**
 * The dev-only SQLite-to-Postgres tools (Phase 1.5b), run with `npx tsx tools/import-sqlite/cli.ts <command>`. Every
 * command prints one JSON document on stdout; a refusal is `{ error: { code, message } }` with exit 1. The Postgres URL
 * is never printed: messages name the database only.
 */
export interface CliIo {
  stdout: (line: string) => void;
  stderr?: (line: string) => void;
  env: Record<string, string | undefined>;
}

/** `20261104T035231Z`, for file names. */
export const fileStamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function readManifest(path: string): ImportManifest {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ImportManifest;
  } catch (err) {
    throw new OrionError('invalid_manifest', `cannot read the import manifest ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildCli(io: CliIo, setExit: (code: number) => void): Command {
  const print = (data: unknown) => io.stdout(JSON.stringify(data, null, 2));
  const program = new Command('import-sqlite')
    .exitOverride()
    .configureOutput({ writeOut: (s) => (io.stderr ?? io.stdout)(s.trimEnd()), writeErr: (s) => (io.stderr ?? io.stdout)(s.trimEnd()) });

  program
    .command('import')
    .description('copy a SQLite release database (schema 8) into an empty, migrated Postgres schema, in one transaction')
    .requiredOption('--from <sqlite>', 'the SQLite file (a .backup copy; opened read-only)')
    .requiredOption('--to <url>', 'the Postgres URL (naming the role, e.g. postgresql://orion_dev@/orion_dev?host=/var/run/postgresql)')
    .option('--schema <schema>', 'the target schema', 'orion')
    .requiredOption('--assets <dir>', 'the assets directory whose YAML decides which observations are carried')
    .option('--manifest-dir <dir>', 'where import-<UTC stamp>.json is written (default $ORION_HOME)')
    .action(async (opts: { from: string; to: string; schema: string; assets: string; manifestDir?: string }) => {
      const dir = opts.manifestDir ?? io.env.ORION_HOME;
      if (!dir) throw new OrionError('no_manifest_dir', 'give --manifest-dir or set ORION_HOME: the manifest is written there');
      const manifest = await importSqlite({ from: opts.from, to: { url: opts.to, schema: checkSchemaName(opts.schema) }, assetsDir: opts.assets });
      const text = JSON.stringify(manifest, null, 2);
      writeFileSync(join(resolve(dir), `import-${fileStamp(manifest.ended_at)}.json`), `${text}\n`, { mode: 0o600, flag: 'wx' });
      io.stdout(text);
      setExit(0);
    });

  program
    .command('proof')
    .description('prove an import row for row (per-row sha256, SQLite vs Postgres through Orion\'s Db) and its identity sequences')
    .requiredOption('--from <sqlite>', 'the SQLite file the import read (or a copy of it)')
    .requiredOption('--to <url>', 'the Postgres URL')
    .option('--schema <schema>', 'the imported schema', 'orion')
    .requiredOption('--assets <dir>', 'the assets directory the import used')
    .requiredOption('--manifest <json>', "the import's manifest")
    .action(async (opts: { from: string; to: string; schema: string; assets: string; manifest: string }) => {
      const result = await proveImport({
        from: opts.from,
        to: { url: opts.to, schema: checkSchemaName(opts.schema) },
        assetsDir: opts.assets,
        manifest: readManifest(opts.manifest),
      });
      print(result);
      setExit(result.ok ? 0 : 1);
    });

  program
    .command('reports')
    .description('run report yield (every asset), data anomalies and proposals list with two releases and compare the bytes')
    .requiredOption('--old-cli <js>', "the SQLite release's dist/cli/index.js")
    .requiredOption('--old-home <dir>', 'its home (assets/ and orion.db)')
    .requiredOption('--new-cli <js>', "this release's dist/cli/index.js")
    .requiredOption('--new-home <dir>', 'its home (assets/ and a .env naming the imported schema)')
    .requiredOption('--day <D>', 'the report day, YYYY-MM-DD')
    .requiredOption('--manifest <json>', "the import's manifest (its excluded proposal ids are dropped from the old list)")
    .requiredOption('--out <dir>', 'where <out>/old/ and <out>/new/ are written')
    .action(async (opts: { oldCli: string; oldHome: string; newCli: string; newHome: string; day: string; manifest: string; out: string }) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) throw new OrionError('invalid_day', `--day must be YYYY-MM-DD, got ${JSON.stringify(opts.day)}`);
      const result = await compareReports({ ...opts, manifest: readManifest(opts.manifest) });
      print(result);
      setExit(result.ok ? 0 : 1);
    });

  return program;
}

/** Runs one command in-process; resolves to the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let code = 0;
  const program = buildCli(io, (c) => (code = c));
  try {
    await program.parseAsync(argv, { from: 'user' });
    return code;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    const e = err instanceof OrionError ? { code: err.code, message: err.message } : { code: 'tool_failed', message: err instanceof Error ? err.message : String(err) };
    io.stdout(JSON.stringify({ error: e }, null, 2));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (l) => console.log(l),
    stderr: (l) => console.error(l),
    env: process.env,
  });
}
