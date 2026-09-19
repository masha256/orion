import { getAdapter } from '../adapters/registry.js';
import { failed, narrow, type ReadingResult, type SourceHandler } from '../types.js';

/** Dispatches to named adapters. An adapter that throws fails only its own reading. */
export const adapterSource: SourceHandler = {
  id: 'adapter',
  async fetch(requests, ctx) {
    const results: ReadingResult[] = [];
    for (const r of requests) {
      const s = narrow(r.source, 'adapter');
      const def = getAdapter(s.name); // an unknown name is a configuration error and propagates
      try {
        results.push({ ok: true, value: await def.run(ctx, s.params) });
      } catch (err) {
        results.push(failed(`adapter ${s.name}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    return results;
  },
};
