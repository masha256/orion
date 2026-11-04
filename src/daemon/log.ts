import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** `daemon.log` is moved to `daemon.log.1` (replacing it) once it reaches this size. */
export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/**
 * The daemon's log: each line as `<ISO> <line>` to stdout (the journal, under systemd) and appended to
 * `<home>/daemon.log`, which is rotated to `daemon.log.1` at 10 MB. A failed file write never stops the daemon.
 */
export function daemonLog(
  home: string,
  io: { stdout?: (s: string) => void; now?: () => Date } = {},
): (line: string) => void {
  const file = join(home, 'daemon.log');
  const stdout = io.stdout ?? ((s: string) => console.log(s));
  const now = io.now ?? (() => new Date());
  return (line: string) => {
    const text = `${now().toISOString()} ${line}`;
    stdout(text);
    try {
      if (existsSync(file) && statSync(file).size >= LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${text}\n`);
    } catch {
      // the journal still has the line
    }
  };
}
