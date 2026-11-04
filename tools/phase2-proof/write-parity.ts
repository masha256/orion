/**
 * Writes tools/phase2-proof/parity.json from PARITY_PATHS (src/report/parity.ts), the map compare.py --parity
 * reads (ruling R7). tests/report/parity.test.ts fails when the committed file and PARITY_PATHS differ.
 *
 *   npx tsx tools/phase2-proof/write-parity.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PARITY_PATHS } from '../../src/report/parity.js';

const dest = fileURLToPath(new URL('./parity.json', import.meta.url));
writeFileSync(dest, `${JSON.stringify(PARITY_PATHS, null, 2)}\n`);
console.log(dest);
