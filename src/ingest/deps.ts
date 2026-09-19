import type { FetchDeps } from './run.js';
import { createHttpTransport, realHttpDeps } from './transport/http.js';
import { createViemRpc } from './transport/viemRpc.js';

/** The real transports. Everything that touches the network is built here and nowhere else. */
export function realFetchDeps(env: Record<string, string | undefined>, now: () => Date): FetchDeps {
  return {
    http: createHttpTransport(realHttpDeps()),
    rpcFactory: createViemRpc,
    env,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now,
  };
}
