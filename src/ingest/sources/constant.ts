import { level, narrow, type SourceHandler } from '../types.js';

/** A fixed value from the asset file, stamped at the fetch time. Never fails. */
export const constantSource: SourceHandler = {
  id: 'constant',
  async fetch(requests, ctx) {
    return requests.map((r) => {
      const s = narrow(r.source, 'constant');
      return level(s.value, ctx.nowIso, 'api', `constant: ${s.note}`);
    });
  },
};
