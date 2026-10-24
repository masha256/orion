import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * KEY=value lines; optional "export "; optional single or double quotes; # comments. Anything else is
 * ignored. An unquoted value keeps a bare `#` (no preceding whitespace) but drops a trailing
 * ` #...` comment; a quoted value keeps everything between the quotes, `#` included.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * The process environment, over <ORION_HOME>/.env when that file exists. A process value that is
 * undefined, empty or whitespace-only does not override the file (a shell that exports
 * `ANTHROPIC_API_KEY=""` must not hide the real key in .env); it is kept only when the file lacks the key.
 */
export function loadEnv(home: string, processEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const path = join(home, '.env');
  const fromFile = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  const out: Record<string, string | undefined> = { ...fromFile };
  for (const [key, value] of Object.entries(processEnv)) {
    const blank = value === undefined || value.trim() === '';
    if (!blank || !(key in fromFile)) out[key] = value;
  }
  return out;
}
