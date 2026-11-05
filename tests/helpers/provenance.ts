import type { Provenance } from '../../src/provenance/types.js';

/** A measured row's provenance for seeding test observations (the writers under test build their own). */
export const TEST_PROVENANCE: Provenance = {
  method: 'measured', sourceType: 'contract_state', chain: null, locator: { test: true }, codeVersion: 'test', configHash: 'test',
};
