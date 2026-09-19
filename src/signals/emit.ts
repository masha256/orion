import { appendFileSync } from 'node:fs';
import type { Signal } from './schema.js';

/** Writes the signal as one JSON line to `write`, and appends the same line to `outFile` when given. */
export function emitSignal(signal: Signal, opts: { write: (line: string) => void; outFile?: string }): void {
  const line = JSON.stringify(signal);
  opts.write(line);
  if (opts.outFile) appendFileSync(opts.outFile, line + '\n', 'utf8');
}
