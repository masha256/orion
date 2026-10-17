/**
 * A DefiLlama fees/dexs overview with the asset's parent at 30 percent of its category over 30 days and 25 percent over a
 * year, a child of the same parent in another category (never counted), and one rival. The route key is the overview
 * path, so it answers the chain-local URL (`/overview/dexs/BSC?...`) too.
 */
export function llamaOverview(parent: string, category: string): { protocols: Record<string, unknown>[] } {
  return {
    protocols: [
      { slug: 'mine-a', parentProtocol: parent, category, total30d: 20, total1y: 150 },
      { slug: 'mine-b', parentProtocol: parent, category, total30d: 10, total1y: 100 },
      { slug: 'mine-other', parentProtocol: parent, category: `${category} Other`, total30d: 1_000, total1y: 1_000 },
      { slug: 'rival', category, total30d: 70, total1y: 750 },
    ],
  };
}
