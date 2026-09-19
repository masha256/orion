#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program.js';

const program = buildProgram({
  home: process.env.ORION_HOME ?? process.cwd(),
  stdout: (line) => console.log(line),
  now: () => new Date(),
});

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode; // commander already printed help or its own error
    return;
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
