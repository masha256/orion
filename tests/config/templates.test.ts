import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseAssetObject } from '../../src/config/load.js';

/**
 * Onboarding templates T1-T10 (spec 2026-10-28 §9): each doc's `yaml skeleton` block, with the doc's own
 * `yaml example-values` block filled in, must load through parseAssetObject, the path every real asset takes. Both blocks
 * are read from the doc itself, so the doc and this test cannot drift.
 */
const dir = resolve(import.meta.dirname, '..', '..', 'docs', 'templates');
const docs = readdirSync(dir).filter((f) => /^T\d+-.*\.md$/.test(f)).sort((a, b) => Number(a.slice(1).split('-')[0]) - Number(b.slice(1).split('-')[0]));
/** The generic source types not built yet (Mike's P3: built with Phase 3); a skeleton may name them only in a comment. */
const PHASE3_TYPES = ['state_delta', 'event_sum', 'balance_delta', 'pool_scan', 'api_series'];
const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;

function block(text: string, info: string, doc: string): string {
  const found = [...text.matchAll(new RegExp('^```' + info + '\\n([\\s\\S]*?)^```$', 'gm'))];
  if (found.length !== 1) throw new Error(`${doc}: expected exactly one \`\`\`${info} block, found ${found.length}`);
  return found[0]![1]!;
}

describe('onboarding templates (docs/templates)', () => {
  it('there are ten, T1 to T10', () => {
    expect(docs.map((d) => d.split('-')[0])).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10']);
  });

  for (const doc of docs) {
    describe(doc, () => {
      const text = readFileSync(join(dir, doc), 'utf8');
      const skeleton = block(text, 'yaml skeleton', doc);
      const values = parseYaml(block(text, 'yaml example-values', doc)) as Record<string, unknown>;

      it('every placeholder has an example value, and every example value fills a placeholder', () => {
        const used = new Set([...skeleton.matchAll(PLACEHOLDER)].map((m) => m[1]!));
        expect([...used].sort()).toEqual(Object.keys(values).sort());
      });

      it('the filled skeleton loads through parseAssetObject, with an income statement', () => {
        const filled = skeleton.replace(PLACEHOLDER, (_m, k: string) => String(values[k]));
        const loaded = parseAssetObject(parseYaml(filled));
        expect(loaded.config.income_statement).toBeDefined();
      });

      it('uses the Phase 3 source types only in commented "# needs <type> (Phase 3)" lines', () => {
        const liveUse = new RegExp(`\\b(type|name):\\s*(${PHASE3_TYPES.join('|')})\\b`);
        for (const line of skeleton.split('\n')) {
          const live = line.split('#')[0]!;
          expect(live, `${doc}: ${line}`).not.toMatch(liveUse);
          for (const m of line.matchAll(/# needs ([a-z_]+)/g)) {
            expect(PHASE3_TYPES, `${doc}: ${line}`).toContain(m[1]);
            expect(line, `${doc}: ${line}`).toMatch(/# needs [a-z_]+ \(Phase 3\)/);
          }
        }
      });
    });
  }
});
