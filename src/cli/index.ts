#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { resolvePaths } from './paths.js';
import { buildProgram } from './program.js';

function fail(err: unknown): void {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  // The data home, the config root (this release, or ORION_HOME in a dev checkout) and the env file, resolved apart.
  const paths = resolvePaths(process.env, dirname(fileURLToPath(import.meta.url)));
  const program = buildProgram({
    ...paths,
    stdout: (line) => console.log(line),
    now: () => new Date(),
    stderr: (line) => console.error(line),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode; // commander already printed help or its own error
      return;
    }
    throw err;
  }
}

main().catch(fail);
