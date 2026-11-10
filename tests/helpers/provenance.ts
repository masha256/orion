import type { Provenance } from '../../src/provenance/types.js';
import type { ObservationSource } from '../../src/types.js';

/** A measured row's provenance for seeding test observations (the writers under test build their own). */
export const TEST_PROVENANCE: Provenance = {
  method: 'measured', sourceType: 'contract_state', chain: null, locator: { test: true }, codeVersion: 'test', configHash: 'test',
};

/**
 * A seeded row's provenance for the origin a test wants (since 0006 the origin is derived from it, `originOf`):
 * `onchain` a contract read, `api` a first-party API read, `manual` a disclosure when the row has its citation
 * (`cited`), else the shape of a hand correction of a fetched day (R17 2a: `manual_*` formula, no citation needed).
 */
export function testProvenance(source: ObservationSource, cited = false): Provenance {
  switch (source) {
    case 'onchain':
      return TEST_PROVENANCE;
    case 'api':
      return { ...TEST_PROVENANCE, sourceType: 'first_party_api' };
    case 'manual':
      return cited
        ? { method: 'disclosed', sourceType: 'disclosure', chain: null, locator: { test: true }, codeVersion: 'test', configHash: 'test' }
        : { method: 'derived', sourceType: 'derived', chain: null, locator: { test: true }, formula: 'manual_test@1', codeVersion: 'test', configHash: 'test' };
  }
}
