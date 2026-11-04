import { OrionError } from '../types.js';
import type { Db } from './connection.js';

/** The longest query `orion db query-ro` takes (orion-remote's own command cap). */
export const QUERY_RO_MAX = 8192;
/** Every read-only query runs under this statement timeout. */
export const QUERY_RO_TIMEOUT = '30s';

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Refuses anything but one plain statement: no backslash anywhere (psql meta-commands such as `\!` never reach a
 * client that would run them, and no `E'...'` escapes), and no `;` outside a '...' string or a "..." identifier, so a
 * second statement (`COMMIT; ...`) cannot follow the read-only transaction's own.
 */
export function checkSingleStatement(sql: string): string {
  if (sql.trim() === '') throw new OrionError('query_empty', 'query-ro needs a query');
  if (sql.length > QUERY_RO_MAX) throw new OrionError('query_too_long', `the query is longer than ${QUERY_RO_MAX} characters`);
  if (sql.includes('\\')) throw new OrionError('query_backslash', 'query-ro refuses a backslash anywhere in the query (no meta-commands, no E\'\' escapes)');
  if (sql.includes('\0')) throw new OrionError('query_nul', 'query-ro refuses a NUL in the query');
  let quote: "'" | '"' | null = null;
  for (const ch of sql) {
    if (quote !== null) {
      if (ch === quote) quote = null; // a doubled '' or "" closes and reopens: the same thing for this scan
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ';') {
      throw new OrionError('query_multiple', 'query-ro runs exactly one statement: no ";" outside quotes (drop a trailing ";")');
    }
  }
  if (quote !== null) throw new OrionError('query_unclosed_quote', `the query has an unclosed ${quote}`);
  return sql;
}

/** The connection URL with its user replaced by `role` (any password dropped: the read-only role signs in by peer). */
export function urlForRole(url: string, role: string): string {
  if (!ROLE.test(role)) throw new OrionError('invalid_role', `role ${JSON.stringify(role)} must match ${ROLE.source}`);
  const m = /^(postgres(?:ql)?:\/\/)(?:[^@/?#]*@)?(.*)$/s.exec(url);
  if (!m) throw new OrionError('invalid_database_url', 'ORION_DATABASE_URL is not a postgres:// or postgresql:// URL');
  return `${m[1]}${role}@${m[2]}`;
}

/** One statement in a `READ ONLY` transaction with a 30 s statement timeout; the rows as the driver returns them. */
export async function queryReadOnly(db: Db, sql: string): Promise<Record<string, unknown>[]> {
  checkSingleStatement(sql);
  return db.tx(async (t) => {
    await t.run('SET TRANSACTION READ ONLY');
    await t.run(`SET LOCAL statement_timeout = '${QUERY_RO_TIMEOUT}'`);
    return t.all(sql);
  });
}
