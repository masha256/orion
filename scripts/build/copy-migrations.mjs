// tsc emits no .sql: copy the Postgres migrations beside the built migrator (dist/db/pg/migrations/).
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const from = join(root, 'src', 'db', 'pg', 'migrations');
const to = join(root, 'dist', 'db', 'pg', 'migrations');
mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((f) => f.endsWith('.sql'));
for (const f of files) copyFileSync(join(from, f), join(to, f));
console.log(`copied ${files.length} migration(s) to dist/db/pg/migrations`);
