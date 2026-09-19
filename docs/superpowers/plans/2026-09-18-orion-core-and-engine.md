# Orion Core and Engine (Sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js CLI that turns hand-entered observations and a versioned assumption set into a reproducible, schema-validated VVV price-target signal, with HYPE and AERO fixture configs proving that new assets need config only.

**Architecture:** Library functions first, CLI as thin wrappers. Human-authored asset config lives in `assets/*.yaml`; machine-written state lives in SQLite. A pure engine (no I/O, no clock, no LLM) maps `(drivers, assumptions, asset config)` to targets; the app layer freezes a snapshot, runs the engine, and persists a signal.

**Tech Stack:** Node 22+, TypeScript (ESM, NodeNext), better-sqlite3, commander, zod 4, yaml, vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md` (read it first; this plan implements section 11 item 1).

## Global Constraints

- Node `>=22`. ESM only (`"type": "module"`). Relative imports end in `.js`.
- The engine (`src/engine/**`) and drivers (`src/drivers/**`) are pure: no `Date.now()`, no `new Date()` without an argument, no file or DB access, no randomness. Time enters as an `asOf` ISO string.
- Modules read `Drivers` and assumptions only. Shared modules never read `drivers.extra`. Only custom modules may.
- Observations are append-only. The only in-place mutations allowed are `superseded_by` and `status -> 'rejected'` on a provisional row.
- Emissions yield is never a holder flow. Only revenue-funded flows count.
- A signal is always emitted, including `blocked`. Never interpolate or invent data.
- Percent fields (`*_pct`) are in percent units: `25` means +25 percent.
- One year is 365 days everywhere.
- Tables for later sub-projects (`anomalies`, `fetch_runs`, `proposals`, `assumption_evidence`, `coverage`, `agent_runs`, `journal`) are NOT created here. CLI groups `persona`, `agent`, `data fetch`, `data anomalies`, and `model proposals` are NOT built here.
- The code in this plan has not been executed. If a test fails because of a defect in the plan's code, fix the code so the test's stated intent holds; do not weaken the test.

## File Structure

```
package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts  .gitignore
src/
  types.ts                      shared constants, scenario/horizon types, OrionError
  util/canonical.ts             canonicalJson (sorted keys) and sha256
  db/connection.ts              openDb, migrate
  db/migrations.ts              ordered SQL migrations
  db/observations.ts            observation store (insert, supersede, confirm, reject, list)
  db/assumptions.ts             versioned assumption sets
  db/runs.ts                    config_versions, snapshots, valuation_runs, signals
  config/schema.ts              zod AssetConfig schema
  config/load.ts                YAML loading, hashing, listing
  drivers/select.ts             latestLevel, trailingFlowAnnualized, buildSchedule, staleness
  drivers/compute.ts            computeDrivers -> DriverReport
  engine/errors.ts              EngineError
  engine/version.ts             ENGINE_VERSION
  engine/paths.ts               revenue, growth, capture-rate, and flow paths
  engine/supply.ts              emissionsBetween, forecastSupply
  engine/modules/types.ts       ValuationModule interface
  engine/modules/keys.ts        shared assumption-key helpers
  engine/modules/holderCashflow.ts
  engine/modules/forwardMultiple.ts
  engine/modules/utilityClaim.ts   custom (VVV)
  engine/modules/registry.ts
  engine/requirements.ts        requiredAssumptionKeys, requiredExtraMetrics, validators
  engine/run.ts                 runEngine (fixed point, blend, total return)
  signals/schema.ts             zod Signal v1
  signals/quality.ts            gradeDataQuality
  signals/build.ts              buildSignal
  signals/emit.ts               stdout / JSONL emit
  app/valuation.ts              runValuation, whatIf, replayRun
  cli/index.ts                  bin entry
  cli/program.ts                buildProgram(ctx)
  cli/util.ts                   withDb, output, parse helpers
  cli/commands/{init,asset,data,model,signal}.ts
assets/vvv.yaml
calibration/vvv-seed-2026-09-18.sh
calibration/vvv-initial-assumptions.yaml
tests/helpers/{assets,obs}.ts
tests/fixtures/{hype,aero}.yaml
tests/**/**.test.ts
```

---

### Task 1: Project scaffold and database migrations

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/types.ts`, `src/db/migrations.ts`, `src/db/connection.ts`
- Test: `tests/db/connection.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): Db`, `migrate(db: Db): void`, type `Db`; from `src/types.ts`: `SCENARIOS`, `Scenario`, `HORIZONS`, `Horizon`, `HORIZON_YEARS`, `Provenance`, `PROVENANCE_RANK`, `ObservationSource`, `ObservationStatus`, `MS_PER_DAY`, `DAYS_PER_YEAR`, `STD_METRICS`, `ScenarioAssumptions`, `AssumptionValues`, `OrionError`.

- [ ] **Step 1: Scaffold the package**

```bash
cd /Users/machado/Projects/orion
npm init -y
npm pkg set type=module private=true engines.node=">=22" bin.orion=dist/cli/index.js
npm pkg set scripts.build="tsc -p tsconfig.build.json" scripts.test="vitest run" scripts.typecheck="tsc --noEmit" scripts.orion="tsx src/cli/index.ts"
npm install better-sqlite3 commander zod@^4 yaml
npm install -D typescript vitest tsx @types/node @types/better-sqlite3
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

`.gitignore`:

```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
.env
signals.jsonl
```

- [ ] **Step 2: Write `src/types.ts`**

```ts
export const SCENARIOS = ['bear', 'base', 'bull'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const HORIZONS = ['6m', '12m'] as const;
export type Horizon = (typeof HORIZONS)[number];
export const HORIZON_YEARS: Record<Horizon, number> = { '6m': 0.5, '12m': 1 };

export type Provenance = 'onchain' | 'api' | 'manual' | 'provisional';
export const PROVENANCE_RANK: Record<Provenance, number> = { onchain: 0, api: 1, manual: 2, provisional: 3 };

export type ObservationSource = 'onchain' | 'api' | 'manual';
export type ObservationStatus = 'confirmed' | 'provisional' | 'rejected';

export const MS_PER_DAY = 86_400_000;
export const DAYS_PER_YEAR = 365;

/** Standard metric keys. Fetchers (or manual entry) must produce these names. */
export const STD_METRICS = {
  price: 'price_usd',
  revenue: 'revenue_run_rate_usd',
  usageIndex: 'usage_index',
  effectiveSupply: 'effective_supply',
  circulatingSupply: 'circulating_supply',
  stakedSupply: 'staked_supply',
  lockedSupply: 'locked_supply',
  emissionRate: 'emission_rate_annual',
  stakerEmissionShare: 'staker_emission_share',
  scheduledUnlock: 'scheduled_unlock_tokens',
} as const;

export type ScenarioAssumptions = Record<string, number>;
export type AssumptionValues = Record<Scenario, ScenarioAssumptions>;

export class OrionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OrionError';
  }
}
```

- [ ] **Step 3: Write the failing test** `tests/db/connection.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/connection.js';

describe('openDb', () => {
  it('applies migrations and creates the sub-project 1 tables', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of ['observations', 'assumption_sets', 'assumptions', 'config_versions', 'snapshots', 'valuation_runs', 'signals']) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db);
    const row = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(row.n).toBe(1);
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `npx vitest run tests/db/connection.test.ts`
Expected: FAIL, cannot resolve `../../src/db/connection.js`.

- [ ] **Step 5: Write `src/db/migrations.ts`**

```ts
export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  period_days REAL,
  value REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('onchain','api','manual')),
  source_detail TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed','provisional','rejected')),
  citation_url TEXT,
  quoted_text TEXT,
  fetched_at TEXT NOT NULL,
  superseded_by INTEGER REFERENCES observations(id)
);
CREATE INDEX idx_obs_lookup ON observations (asset_id, metric_key, observed_at);

CREATE TABLE assumption_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  author TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (asset_id, version)
);
CREATE TABLE assumptions (
  set_id INTEGER NOT NULL REFERENCES assumption_sets(id),
  key TEXT NOT NULL,
  scenario TEXT NOT NULL CHECK (scenario IN ('bear','base','bull')),
  value REAL NOT NULL,
  PRIMARY KEY (set_id, key, scenario)
);

CREATE TABLE config_versions (
  hash TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  observation_ids TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE valuation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  assumption_set_id INTEGER REFERENCES assumption_sets(id),
  engine_version TEXT NOT NULL,
  config_hash TEXT NOT NULL REFERENCES config_versions(hash),
  status TEXT NOT NULL,
  output_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT NOT NULL UNIQUE,
  run_id INTEGER NOT NULL REFERENCES valuation_runs(id),
  asset_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at TEXT NOT NULL
);
`,
  },
];
```

- [ ] **Step 6: Write `src/db/connection.ts`**

```ts
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => (r as { id: number }).id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
    })();
  }
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/db/connection.test.ts && npm run typecheck`
Expected: 2 tests PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .gitignore src tests
git commit -m "feat: scaffold project and add SQLite migrations"
```

---

### Task 2: Canonical JSON and asset config schema

**Files:**
- Create: `src/util/canonical.ts`, `src/config/schema.ts`, `src/config/load.ts`, `tests/helpers/assets.ts`
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Consumes: `STD_METRICS`, `OrionError` from `src/types.ts`.
- Produces:
  - `canonicalJson(value: unknown): string`, `sha256(text: string): string`
  - `AssetConfigSchema`, types `AssetConfig`, `MetricDef`, `HolderFlowDef`, `ModuleInstanceDef`, `FlowKind`, `CaptureRule`, `RecipientBase`, `ModuleKind`
  - `interface LoadedAsset { config: AssetConfig; hash: string }`
  - `parseAssetYaml(text: string): LoadedAsset`, `parseAssetObject(obj: unknown): LoadedAsset`, `loadAsset(home: string, id: string): LoadedAsset`, `listAssetIds(home: string): string[]`
  - test helper `MINI_ASSET_YAML: string`, `miniAsset(): AssetConfig`

- [ ] **Step 1: Write the test helper** `tests/helpers/assets.ts`

```ts
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';

export const MINI_ASSET_YAML = `
id: mini
symbol: MINI
name: Mini Test Asset
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }
  effective_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 45, critical: true }
holder_flows:
  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: all, metric: flow_usd.fees }
modules:
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }
assumptions:
  rev_growth_y1: { min: -0.5, max: 5 }
  growth_fade_years: { min: 0, max: 10 }
  terminal_growth: { min: 0, max: 0.05 }
  capture_rate_terminal.fees: { min: 0, max: 1 }
  capture_ramp_years.fees: { min: 0, max: 10 }
  discount_rate_base: { min: 0.05, max: 0.5 }
  staked_ratio_horizon: { min: 0.05, max: 0.95 }
`;

export function miniAsset(): AssetConfig {
  return parseAssetYaml(MINI_ASSET_YAML).config;
}
```

- [ ] **Step 2: Write the failing test** `tests/config/load.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { canonicalJson } from '../../src/util/canonical.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });
});

describe('parseAssetYaml', () => {
  it('parses a valid asset and applies defaults', () => {
    const { config, hash } = parseAssetYaml(MINI_ASSET_YAML);
    expect(config.supply_basis).toBe('effective_total');
    expect(config.scenario_probabilities).toEqual({ bear: 0.25, base: 0.5, bull: 0.25 });
    expect(config.holder_flows[0].window_days).toBe(90);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same hash regardless of YAML key order', () => {
    const reordered = MINI_ASSET_YAML.replace('id: mini\nsymbol: MINI', 'symbol: MINI\nid: mini');
    expect(parseAssetYaml(reordered).hash).toBe(parseAssetYaml(MINI_ASSET_YAML).hash);
  });

  it('rejects estimate weights that do not sum to 1', () => {
    const bad = MINI_ASSET_YAML.replace('weight: 1 }', 'weight: 0.7 }');
    expect(() => parseAssetYaml(bad)).toThrow(/weights/);
  });

  it('rejects a holder flow whose metric is not a flow metric', () => {
    const bad = MINI_ASSET_YAML.replace('metric: flow_usd.fees }', 'metric: price_usd }');
    expect(() => parseAssetYaml(bad)).toThrow(/flow/);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseAssetYaml(MINI_ASSET_YAML + '\nsurprise: true\n')).toThrow();
  });

  it('requires circulating_supply when supply_basis is circulating', () => {
    expect(() => parseAssetYaml(MINI_ASSET_YAML + '\nsupply_basis: circulating\n')).toThrow(/circulating_supply/);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tests/config/load.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/util/canonical.ts`**

```ts
import { createHash } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
```

- [ ] **Step 5: Write `src/config/schema.ts`**

```ts
import { z } from 'zod';
import { STD_METRICS } from '../types.js';

const MetricDefSchema = z.strictObject({
  type: z.enum(['level', 'flow', 'schedule', 'event']),
  unit: z.string(),
  fetcher: z.string().default('manual'),
  cadence: z.enum(['daily', 'weekly', 'monthly', 'event']).default('daily'),
  staleness_days: z.number().positive(),
  tolerance_pct: z.number().nonnegative().default(1),
  allow_provisional: z.boolean().default(false),
  critical: z.boolean().default(false),
});

const HolderFlowSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  kind: z.enum(['burn', 'buy_and_hold', 'fee_share']),
  capture_rule: z.enum(['contractual', 'programmatic', 'discretionary']),
  recipient_base: z.enum(['all', 'staked', 'locked']),
  metric: z.string(),
  window_days: z.number().positive().default(90),
});

const ModuleInstanceSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/),
  type: z.string(),
  kind: z.enum(['estimate', 'component']),
  weight: z.number().min(0).max(1).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

const BoundSchema = z.strictObject({ min: z.number(), max: z.number() });

const ProbabilitiesSchema = z.strictObject({ bear: z.number(), base: z.number(), bull: z.number() });

export const AssetConfigSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/),
    symbol: z.string(),
    name: z.string(),
    chain: z.string().optional(),
    supply_basis: z.enum(['effective_total', 'circulating']).default('effective_total'),
    contracts: z.record(z.string(), z.string()).default({}),
    external_ids: z.record(z.string(), z.string()).default({}),
    metrics: z.record(z.string(), MetricDefSchema),
    holder_flows: z.array(HolderFlowSchema).min(1),
    modules: z.array(ModuleInstanceSchema).min(1),
    scenario_probabilities: ProbabilitiesSchema.default({ bear: 0.25, base: 0.5, bull: 0.25 }),
    assumptions: z.record(z.string(), BoundSchema),
    total_return_variants: z
      .array(z.strictObject({ id: z.string(), yield_multiplier_metric: z.string() }))
      .default([]),
    review_triggers: z.record(z.string(), z.unknown()).default({}),
    peer_set: z.array(z.string()).default([]),
  })
  .superRefine((a, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;

    const required = [
      STD_METRICS.price,
      STD_METRICS.revenue,
      STD_METRICS.effectiveSupply,
      STD_METRICS.stakedSupply,
      STD_METRICS.stakerEmissionShare,
      STD_METRICS.emissionRate,
    ];
    if (a.supply_basis === 'circulating') required.push(STD_METRICS.circulatingSupply);
    for (const key of required) if (!a.metrics[key]) issue(`metrics: required standard metric "${key}" is not defined`);

    const typed: [string, string][] = [
      [STD_METRICS.emissionRate, 'schedule'],
      [STD_METRICS.scheduledUnlock, 'event'],
    ];
    for (const [key, type] of typed) {
      if (a.metrics[key] && a.metrics[key].type !== type) issue(`metrics: "${key}" must have type ${type}`);
    }

    const flowIds = new Set<string>();
    for (const f of a.holder_flows) {
      if (flowIds.has(f.id)) issue(`holder_flows: duplicate id "${f.id}"`);
      flowIds.add(f.id);
      if (a.metrics[f.metric]?.type !== 'flow') issue(`holder_flows: "${f.id}" must reference a metric of type flow`);
    }

    const moduleIds = new Set<string>();
    let weightSum = 0;
    let estimates = 0;
    for (const m of a.modules) {
      if (moduleIds.has(m.id)) issue(`modules: duplicate id "${m.id}"`);
      moduleIds.add(m.id);
      if (m.kind === 'estimate') {
        estimates++;
        if (m.weight === undefined) issue(`modules: estimate "${m.id}" needs a weight`);
        weightSum += m.weight ?? 0;
      } else if (m.weight !== undefined) {
        issue(`modules: component "${m.id}" must not have a weight`);
      }
    }
    if (estimates === 0) issue('modules: at least one estimate module is required');
    if (estimates > 0 && !near(weightSum, 1)) issue(`modules: estimate weights must sum to 1 (got ${weightSum})`);

    const p = a.scenario_probabilities;
    if (!near(p.bear + p.base + p.bull, 1)) issue('scenario_probabilities must sum to 1');

    for (const [key, b] of Object.entries(a.assumptions)) {
      if (b.min > b.max) issue(`assumptions: "${key}" has min greater than max`);
    }
    for (const v of a.total_return_variants) {
      if (a.metrics[v.yield_multiplier_metric]?.type !== 'level') {
        issue(`total_return_variants: "${v.id}" must reference a level metric`);
      }
    }
  });

export type AssetConfig = z.infer<typeof AssetConfigSchema>;
export type MetricDef = AssetConfig['metrics'][string];
export type HolderFlowDef = AssetConfig['holder_flows'][number];
export type ModuleInstanceDef = AssetConfig['modules'][number];
export type FlowKind = HolderFlowDef['kind'];
export type CaptureRule = HolderFlowDef['capture_rule'];
export type RecipientBase = HolderFlowDef['recipient_base'];
export type ModuleKind = ModuleInstanceDef['kind'];
```

- [ ] **Step 6: Write `src/config/load.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { OrionError } from '../types.js';
import { canonicalJson, sha256 } from '../util/canonical.js';
import { AssetConfigSchema, type AssetConfig } from './schema.js';

export interface LoadedAsset {
  config: AssetConfig;
  hash: string;
}

export function parseAssetObject(obj: unknown): LoadedAsset {
  try {
    const config = AssetConfigSchema.parse(obj);
    return { config, hash: sha256(canonicalJson(config)) };
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new OrionError('invalid_asset_config', lines.join('\n'));
    }
    throw err;
  }
}

export function parseAssetYaml(text: string): LoadedAsset {
  return parseAssetObject(parseYaml(text));
}

export function listAssetIds(home: string): string[] {
  const dir = join(home, 'assets');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

export function loadAsset(home: string, id: string): LoadedAsset {
  const path = join(home, 'assets', `${id}.yaml`);
  if (!existsSync(path)) throw new OrionError('asset_not_found', `no asset config at ${path}`);
  const loaded = parseAssetYaml(readFileSync(path, 'utf8'));
  if (loaded.config.id !== id) {
    throw new OrionError('invalid_asset_config', `${path}: id "${loaded.config.id}" does not match the file name`);
  }
  return loaded;
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/config/load.test.ts && npm run typecheck`
Expected: 7 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/util src/config tests/helpers tests/config
git commit -m "feat: add asset config schema, loader, and canonical hashing"
```

---

### Task 3: Observation store

**Files:**
- Create: `src/db/observations.ts`
- Test: `tests/db/observations.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db/connection.ts`; `ObservationSource`, `ObservationStatus`, `OrionError` from `src/types.ts`.
- Produces:
  - `interface Observation { id: number; assetId: string; metricKey: string; observedAt: string; periodDays: number | null; value: number; source: ObservationSource; sourceDetail: string | null; status: ObservationStatus; citationUrl: string | null; quotedText: string | null; fetchedAt: string; supersededBy: number | null }`
  - `interface NewObservation { assetId; metricKey; observedAt: string; periodDays?: number | null; value: number; source: ObservationSource; sourceDetail?: string | null; status?: 'confirmed' | 'provisional'; citationUrl?: string | null; quotedText?: string | null; fetchedAt: string }`
  - `insertObservation(db, input: NewObservation): Observation`
  - `listActiveObservations(db, assetId: string, metricKey?: string): Observation[]` (active means `superseded_by IS NULL AND status != 'rejected'`)
  - `getObservationsByIds(db, ids: number[]): Observation[]` (ignores status; used by replay)
  - `confirmObservation(db, id: number, nowIso: string): Observation`
  - `rejectObservation(db, id: number): void`

Rules: `observedAt` and `fetchedAt` are normalized with `new Date(x).toISOString()`. Inserting a row with the same `(asset, metric, observed_at)` as an active row supersedes the old row. A provisional row requires `citationUrl`. Confirm inserts a confirmed copy (source `manual`) which supersedes the provisional row. Reject flips status to `rejected`.

- [ ] **Step 1: Write the failing test** `tests/db/observations.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/connection.js';
import {
  confirmObservation,
  getObservationsByIds,
  insertObservation,
  listActiveObservations,
  rejectObservation,
} from '../../src/db/observations.js';

const base = { assetId: 'mini', metricKey: 'price_usd', source: 'manual' as const, fetchedAt: '2026-06-30T00:00:00Z' };
let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('observations', () => {
  it('normalizes timestamps to ISO', () => {
    const o = insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    expect(o.observedAt).toBe('2026-06-30T00:00:00.000Z');
    expect(o.status).toBe('confirmed');
  });

  it('rejects an invalid timestamp', () => {
    expect(() => insertObservation(db, { ...base, observedAt: 'not-a-date', value: 1 })).toThrow(/timestamp/);
  });

  it('supersedes an active row with the same metric and observed_at', () => {
    const first = insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    const second = insertObservation(db, { ...base, observedAt: '2026-06-30', value: 11 });
    const active = listActiveObservations(db, 'mini', 'price_usd');
    expect(active.map((o) => o.id)).toEqual([second.id]);
    expect(getObservationsByIds(db, [first.id])[0].supersededBy).toBe(second.id);
  });

  it('requires a citation for provisional rows', () => {
    expect(() =>
      insertObservation(db, { ...base, observedAt: '2026-06-30', value: 1, status: 'provisional' }),
    ).toThrow(/citation/);
  });

  it('confirm inserts a confirmed copy that supersedes the provisional row', () => {
    const p = insertObservation(db, {
      ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a', quotedText: 'five',
    });
    const c = confirmObservation(db, p.id, '2026-07-01T00:00:00Z');
    expect(c.status).toBe('confirmed');
    expect(c.value).toBe(5);
    expect(c.citationUrl).toBe('https://example.com/a');
    expect(listActiveObservations(db, 'mini').map((o) => o.id)).toEqual([c.id]);
  });

  it('reject removes a provisional row from the active set but keeps the row', () => {
    const p = insertObservation(db, {
      ...base, observedAt: '2026-06-30', value: 5, status: 'provisional', citationUrl: 'https://example.com/a',
    });
    rejectObservation(db, p.id);
    expect(listActiveObservations(db, 'mini')).toEqual([]);
    expect(getObservationsByIds(db, [p.id])[0].status).toBe('rejected');
  });

  it('refuses to confirm or reject a row that is not an active provisional row', () => {
    const o = insertObservation(db, { ...base, observedAt: '2026-06-30', value: 10 });
    expect(() => confirmObservation(db, o.id, '2026-07-01T00:00:00Z')).toThrow(/provisional/);
    expect(() => rejectObservation(db, o.id)).toThrow(/provisional/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/db/observations.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/db/observations.ts`**

```ts
import { OrionError, type ObservationSource, type ObservationStatus } from '../types.js';
import type { Db } from './connection.js';

export interface Observation {
  id: number;
  assetId: string;
  metricKey: string;
  observedAt: string;
  periodDays: number | null;
  value: number;
  source: ObservationSource;
  sourceDetail: string | null;
  status: ObservationStatus;
  citationUrl: string | null;
  quotedText: string | null;
  fetchedAt: string;
  supersededBy: number | null;
}

export interface NewObservation {
  assetId: string;
  metricKey: string;
  observedAt: string;
  periodDays?: number | null;
  value: number;
  source: ObservationSource;
  sourceDetail?: string | null;
  status?: 'confirmed' | 'provisional';
  citationUrl?: string | null;
  quotedText?: string | null;
  fetchedAt: string;
}

interface Row {
  id: number;
  asset_id: string;
  metric_key: string;
  observed_at: string;
  period_days: number | null;
  value: number;
  source: ObservationSource;
  source_detail: string | null;
  status: ObservationStatus;
  citation_url: string | null;
  quoted_text: string | null;
  fetched_at: string;
  superseded_by: number | null;
}

function fromRow(r: Row): Observation {
  return {
    id: r.id,
    assetId: r.asset_id,
    metricKey: r.metric_key,
    observedAt: r.observed_at,
    periodDays: r.period_days,
    value: r.value,
    source: r.source,
    sourceDetail: r.source_detail,
    status: r.status,
    citationUrl: r.citation_url,
    quotedText: r.quoted_text,
    fetchedAt: r.fetched_at,
    supersededBy: r.superseded_by,
  };
}

function toIso(text: string): string {
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new OrionError('invalid_timestamp', `invalid timestamp: ${text}`);
  return d.toISOString();
}

const ACTIVE = "superseded_by IS NULL AND status != 'rejected'";

export function getObservationsByIds(db: Db, ids: number[]): Observation[] {
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM observations WHERE id IN (${marks}) ORDER BY id`).all(...ids) as Row[];
  return rows.map(fromRow);
}

export function listActiveObservations(db: Db, assetId: string, metricKey?: string): Observation[] {
  const rows = (
    metricKey === undefined
      ? db.prepare(`SELECT * FROM observations WHERE asset_id = ? AND ${ACTIVE} ORDER BY observed_at, id`).all(assetId)
      : db
          .prepare(`SELECT * FROM observations WHERE asset_id = ? AND metric_key = ? AND ${ACTIVE} ORDER BY observed_at, id`)
          .all(assetId, metricKey)
  ) as Row[];
  return rows.map(fromRow);
}

export function insertObservation(db: Db, input: NewObservation): Observation {
  if (!Number.isFinite(input.value)) throw new OrionError('invalid_value', 'observation value must be a finite number');
  const status = input.status ?? 'confirmed';
  if (status === 'provisional' && !input.citationUrl) {
    throw new OrionError('citation_required', 'a provisional observation requires a citation url');
  }
  const observedAt = toIso(input.observedAt);
  const fetchedAt = toIso(input.fetchedAt);

  const id = db.transaction(() => {
    const prior = db
      .prepare(`SELECT id FROM observations WHERE asset_id = ? AND metric_key = ? AND observed_at = ? AND ${ACTIVE}`)
      .all(input.assetId, input.metricKey, observedAt) as { id: number }[];
    const info = db
      .prepare(
        `INSERT INTO observations
           (asset_id, metric_key, observed_at, period_days, value, source, source_detail, status, citation_url, quoted_text, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.assetId, input.metricKey, observedAt, input.periodDays ?? null, input.value, input.source,
        input.sourceDetail ?? null, status, input.citationUrl ?? null, input.quotedText ?? null, fetchedAt,
      );
    const newId = Number(info.lastInsertRowid);
    for (const p of prior) db.prepare('UPDATE observations SET superseded_by = ? WHERE id = ?').run(newId, p.id);
    return newId;
  })();

  return getObservationsByIds(db, [id])[0];
}

function activeProvisional(db: Db, id: number): Observation {
  const o = getObservationsByIds(db, [id])[0];
  if (!o) throw new OrionError('observation_not_found', `no observation with id ${id}`);
  if (o.status !== 'provisional' || o.supersededBy !== null) {
    throw new OrionError('not_provisional', `observation ${id} is not an active provisional observation`);
  }
  return o;
}

export function confirmObservation(db: Db, id: number, nowIso: string): Observation {
  const o = activeProvisional(db, id);
  return insertObservation(db, {
    assetId: o.assetId,
    metricKey: o.metricKey,
    observedAt: o.observedAt,
    periodDays: o.periodDays,
    value: o.value,
    source: 'manual',
    sourceDetail: o.sourceDetail,
    status: 'confirmed',
    citationUrl: o.citationUrl,
    quotedText: o.quotedText,
    fetchedAt: nowIso,
  });
}

export function rejectObservation(db: Db, id: number): void {
  activeProvisional(db, id);
  db.prepare("UPDATE observations SET status = 'rejected' WHERE id = ?").run(id);
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/db/observations.test.ts && npm run typecheck`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/observations.ts tests/db/observations.test.ts
git commit -m "feat: add append-only observation store"
```

---

### Task 4: Driver selection helpers

**Files:**
- Create: `src/drivers/select.ts`, `tests/helpers/obs.ts`
- Test: `tests/drivers/select.test.ts`

**Interfaces:**
- Consumes: `Observation` from `src/db/observations.ts`; `Provenance`, `PROVENANCE_RANK`, `MS_PER_DAY`, `DAYS_PER_YEAR` from `src/types.ts`.
- Produces:
  - `obsProvenance(o: Observation): Provenance` (provisional status wins over source)
  - `worstProvenance(list: Provenance[]): Provenance`
  - `latestLevel(obs: Observation[], asOf: string): Observation | undefined`
  - `trailingFlowAnnualized(obs: Observation[], asOf: string, windowDays: number): { annualized: number; used: Observation[] }`
  - `interface ScheduleStep { from: string; value: number }`
  - `buildSchedule(obs: Observation[], asOf: string): { steps: ScheduleStep[]; used: Observation[] }` (first step is the one in force at `asOf` if any; later steps are future changes)
  - `isStale(freshnessIso: string, asOf: string, stalenessDays: number): boolean`
  - test helper `obs(metricKey, value, observedAt, opts?)`, `AS_OF`

Flow rule: a flow observation covers the interval `[observedAt - periodDays, observedAt]` (`periodDays` defaults to 1). Its contribution to the window `[asOf - windowDays, asOf]` is `value * overlapDays / periodDays`. Annualized = sum of contributions `* 365 / windowDays`. Flow data must cover the whole window or the result understates.

- [ ] **Step 1: Write the test helper** `tests/helpers/obs.ts`

```ts
import type { Observation } from '../../src/db/observations.js';

export const AS_OF = '2026-06-30T00:00:00.000Z';

let nextId = 1;

export function obs(metricKey: string, value: number, observedAt: string, opts: Partial<Observation> = {}): Observation {
  const iso = new Date(observedAt).toISOString();
  return {
    id: nextId++,
    assetId: 'mini',
    metricKey,
    observedAt: iso,
    periodDays: null,
    value,
    source: 'onchain',
    sourceDetail: null,
    status: 'confirmed',
    citationUrl: null,
    quotedText: null,
    fetchedAt: iso,
    supersededBy: null,
    ...opts,
  };
}
```

- [ ] **Step 2: Write the failing test** `tests/drivers/select.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  buildSchedule, isStale, latestLevel, obsProvenance, trailingFlowAnnualized, worstProvenance,
} from '../../src/drivers/select.js';
import { AS_OF, obs } from '../helpers/obs.js';

describe('latestLevel', () => {
  it('picks the newest observation at or before asOf and ignores future ones', () => {
    const list = [obs('p', 1, '2026-06-01'), obs('p', 2, '2026-06-29'), obs('p', 3, '2026-07-05')];
    expect(latestLevel(list, AS_OF)?.value).toBe(2);
  });
  it('returns undefined when nothing qualifies', () => {
    expect(latestLevel([obs('p', 3, '2026-07-05')], AS_OF)).toBeUndefined();
  });
});

describe('trailingFlowAnnualized', () => {
  it('annualizes three full months inside a 90 day window', () => {
    const list = [
      obs('f', 300, '2026-05-01', { periodDays: 30 }),
      obs('f', 300, '2026-05-31', { periodDays: 30 }),
      obs('f', 300, '2026-06-30', { periodDays: 30 }),
    ];
    const r = trailingFlowAnnualized(list, AS_OF, 90);
    expect(r.annualized).toBeCloseTo((900 * 365) / 90, 9);
    expect(r.used).toHaveLength(3);
  });
  it('prorates an observation that straddles the window start', () => {
    // covers [asOf-110d, asOf-80d]; 10 of its 30 days fall inside the 90 day window
    const list = [obs('f', 300, '2026-04-11', { periodDays: 30 })];
    expect(trailingFlowAnnualized(list, AS_OF, 90).annualized).toBeCloseTo((100 * 365) / 90, 9);
  });
  it('ignores observations after asOf', () => {
    expect(trailingFlowAnnualized([obs('f', 300, '2026-07-15', { periodDays: 30 })], AS_OF, 90).annualized).toBe(0);
  });
});

describe('buildSchedule', () => {
  it('returns the step in force followed by future steps', () => {
    const list = [obs('e', 900, '2025-01-01'), obs('e', 700, '2026-01-01'), obs('e', 500, '2026-10-01')];
    const { steps } = buildSchedule(list, AS_OF);
    expect(steps).toEqual([
      { from: '2026-01-01T00:00:00.000Z', value: 700 },
      { from: '2026-10-01T00:00:00.000Z', value: 500 },
    ]);
  });
  it('returns only future steps when none is in force', () => {
    expect(buildSchedule([obs('e', 500, '2026-10-01')], AS_OF).steps).toHaveLength(1);
  });
});

describe('provenance and staleness', () => {
  it('treats provisional status as the provenance', () => {
    expect(obsProvenance(obs('p', 1, '2026-06-01', { status: 'provisional', source: 'manual' }))).toBe('provisional');
    expect(obsProvenance(obs('p', 1, '2026-06-01', { source: 'api' }))).toBe('api');
  });
  it('picks the worst provenance', () => {
    expect(worstProvenance(['onchain', 'manual', 'api'])).toBe('manual');
    expect(worstProvenance([])).toBe('onchain');
  });
  it('flags stale values', () => {
    expect(isStale('2026-06-20T00:00:00.000Z', AS_OF, 3)).toBe(true);
    expect(isStale('2026-06-28T00:00:00.000Z', AS_OF, 3)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tests/drivers/select.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `src/drivers/select.ts`**

```ts
import type { Observation } from '../db/observations.js';
import { DAYS_PER_YEAR, MS_PER_DAY, PROVENANCE_RANK, type Provenance } from '../types.js';

export interface ScheduleStep {
  from: string;
  value: number;
}

const ms = (iso: string) => new Date(iso).getTime();

/** Newer observedAt wins; ties go to the higher id. */
function newer(a: Observation, b: Observation): Observation {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt ? a : b;
  return a.id > b.id ? a : b;
}

export function obsProvenance(o: Observation): Provenance {
  return o.status === 'provisional' ? 'provisional' : o.source;
}

export function worstProvenance(list: Provenance[]): Provenance {
  let worst: Provenance = 'onchain';
  for (const p of list) if (PROVENANCE_RANK[p] > PROVENANCE_RANK[worst]) worst = p;
  return worst;
}

export function latestLevel(obs: Observation[], asOf: string): Observation | undefined {
  let best: Observation | undefined;
  for (const o of obs) {
    if (o.observedAt > asOf) continue;
    best = best ? newer(best, o) : o;
  }
  return best;
}

export function trailingFlowAnnualized(
  obs: Observation[],
  asOf: string,
  windowDays: number,
): { annualized: number; used: Observation[] } {
  const windowEnd = ms(asOf);
  const windowStart = windowEnd - windowDays * MS_PER_DAY;
  let sum = 0;
  const used: Observation[] = [];
  for (const o of obs) {
    if (o.observedAt > asOf) continue;
    const period = (o.periodDays ?? 1) * MS_PER_DAY;
    const end = ms(o.observedAt);
    const start = end - period;
    const overlap = Math.min(end, windowEnd) - Math.max(start, windowStart);
    if (overlap <= 0) continue;
    sum += o.value * (overlap / period);
    used.push(o);
  }
  return { annualized: (sum * DAYS_PER_YEAR) / windowDays, used };
}

export function buildSchedule(obs: Observation[], asOf: string): { steps: ScheduleStep[]; used: Observation[] } {
  const sorted = [...obs].sort((a, b) => (a.observedAt === b.observedAt ? a.id - b.id : a.observedAt < b.observedAt ? -1 : 1));
  const inForce = latestLevel(sorted, asOf);
  const used = sorted.filter((o) => o === inForce || o.observedAt > asOf);
  return { steps: used.map((o) => ({ from: o.observedAt, value: o.value })), used };
}

export function isStale(freshnessIso: string, asOf: string, stalenessDays: number): boolean {
  return ms(asOf) - ms(freshnessIso) > stalenessDays * MS_PER_DAY;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/drivers/select.test.ts && npm run typecheck`
Expected: 10 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/drivers/select.ts tests/helpers/obs.ts tests/drivers/select.test.ts
git commit -m "feat: add observation selection helpers for drivers"
```

---

### Task 5: computeDrivers

**Files:**
- Create: `src/drivers/compute.ts`
- Modify: `tests/helpers/obs.ts` (add `miniObservations`)
- Test: `tests/drivers/compute.test.ts`

**Interfaces:**
- Consumes: Task 2 `AssetConfig`, `FlowKind`, `CaptureRule`, `RecipientBase`; Task 3 `Observation`; Task 4 helpers and `ScheduleStep`; `STD_METRICS`, `Provenance`.
- Produces:

```ts
export interface DriverValue { value: number; provenance: Provenance; derived: boolean; observedAt: string }
export interface HolderFlowDriver {
  id: string; kind: FlowKind; captureRule: CaptureRule; recipientBase: RecipientBase;
  annualizedUsd: DriverValue; captureRate: number;
}
export interface UnlockEvent { at: string; tokens: number }
export interface Drivers {
  asOf: string;
  price: DriverValue; revenueRunRate: DriverValue; usageIndex: DriverValue | null;
  effectiveSupply: DriverValue; circulatingSupply: DriverValue | null;
  stakedSupply: DriverValue; stakedRatio: DriverValue; lockedRatio: DriverValue | null;
  stakerEmissionShare: DriverValue; emissionSchedule: ScheduleStep[]; emissionRateNow: DriverValue;
  realStakingYield: DriverValue; scheduledUnlocks: UnlockEvent[];
  marketCap: DriverValue | null; fdv: DriverValue;
  holderFlows: HolderFlowDriver[]; captureRate: number;
  extra: Record<string, DriverValue>;
}
export interface DriverReport {
  drivers: Drivers | null;      // null when anything required is missing
  missing: string[];            // metric keys
  staleMetrics: string[]; staleCritical: string[]; provisionalMetrics: string[]; manualMetrics: string[];
}
export function computeDrivers(asset: AssetConfig, observations: Observation[], asOf: string, extraRequired?: string[]): DriverReport
```

Rules:
- `computeDrivers` does not filter by observation status. The caller decides which observations are eligible (so replay by id is exact).
- Required: price, revenue, effective supply, staked supply, staker emission share, an emission step in force at `asOf`, every holder-flow metric (at least one observation at or before `asOf`), circulating supply when `supply_basis` is `circulating`, and every key in `extraRequired`.
- Staleness is measured on `observedAt` for `level` and `flow` metrics, and on the newest `fetchedAt` for `schedule` and `event` metrics.
- Every `level` metric that is not a standard metric lands in `drivers.extra`.
- Derived values take the worst provenance and the oldest `observedAt` of their inputs.
- `realStakingYield = emissionRateNow * stakerEmissionShare / stakedSupply - emissionRateNow / effectiveSupply`.

- [ ] **Step 1: Extend the test helper** (append to `tests/helpers/obs.ts`)

```ts
export interface MiniOverrides {
  price?: number; revenue?: number; supply?: number; staked?: number;
  emission?: number; share?: number; flowAnnual?: number; flowMetric?: string;
}

/** A complete observation set for the mini asset. Defaults: price 10, revenue 1000, supply 100, flow 100/yr. */
export function miniObservations(o: MiniOverrides = {}): Observation[] {
  const flowAnnual = o.flowAnnual ?? 100;
  return [
    obs('price_usd', o.price ?? 10, '2026-06-29'),
    obs('revenue_run_rate_usd', o.revenue ?? 1000, '2026-06-15'),
    obs('effective_supply', o.supply ?? 100, '2026-06-29'),
    obs('staked_supply', o.staked ?? 50, '2026-06-29'),
    obs('staker_emission_share', o.share ?? 1, '2026-06-29'),
    obs('emission_rate_annual', o.emission ?? 0, '2026-01-01', { fetchedAt: '2026-06-29T00:00:00.000Z' }),
    obs(o.flowMetric ?? 'flow_usd.fees', (flowAnnual * 90) / 365, AS_OF, { periodDays: 90 }),
  ];
}
```

- [ ] **Step 2: Write the failing test** `tests/drivers/compute.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { MINI_ASSET_YAML, miniAsset } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

describe('computeDrivers', () => {
  it('computes standard drivers for a complete data set', () => {
    const r = computeDrivers(miniAsset(), miniObservations(), AS_OF);
    expect(r.missing).toEqual([]);
    const d = r.drivers!;
    expect(d.price.value).toBe(10);
    expect(d.fdv.value).toBe(1000);
    expect(d.fdv.derived).toBe(true);
    expect(d.stakedRatio.value).toBe(0.5);
    expect(d.holderFlows[0].annualizedUsd.value).toBeCloseTo(100, 9);
    expect(d.holderFlows[0].captureRate).toBeCloseTo(0.1, 9);
    expect(d.captureRate).toBeCloseTo(0.1, 9);
    expect(d.emissionSchedule).toEqual([{ from: '2026-01-01T00:00:00.000Z', value: 0 }]);
    expect(d.marketCap).toBeNull();
  });

  it('computes real staking yield as staker APR minus inflation', () => {
    const d = computeDrivers(miniAsset(), miniObservations({ emission: 10 }), AS_OF).drivers!;
    // staker APR = 10 * 1 / 50 = 0.2 ; inflation = 10 / 100 = 0.1
    expect(d.realStakingYield.value).toBeCloseTo(0.1, 9);
  });

  it('reports missing required metrics and returns no drivers', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'price_usd');
    const r = computeDrivers(miniAsset(), list, AS_OF);
    expect(r.drivers).toBeNull();
    expect(r.missing).toEqual(['price_usd']);
  });

  it('reports a missing required extra metric', () => {
    const r = computeDrivers(miniAsset(), miniObservations(), AS_OF, ['diem_supply']);
    expect(r.missing).toEqual(['diem_supply']);
  });

  it('flags stale, critical, manual, and provisional metrics', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'price_usd' && o.metricKey !== 'staked_supply');
    list.push(obs('price_usd', 10, '2026-06-01'));
    list.push(obs('staked_supply', 50, '2026-06-29', { source: 'manual' }));
    list.push(obs('revenue_run_rate_usd', 1000, '2026-06-20', { source: 'manual', status: 'provisional' }));
    const r = computeDrivers(miniAsset(), list, AS_OF);
    expect(r.staleMetrics).toEqual(['price_usd']);
    expect(r.staleCritical).toEqual(['price_usd']);
    expect(r.manualMetrics).toEqual(['staked_supply']);
    expect(r.provisionalMetrics).toEqual(['revenue_run_rate_usd']);
    expect(r.drivers!.captureRate).toBeCloseTo(0.1, 9);
    expect(r.drivers!.fdv.provenance).toBe('onchain');
  });

  it('puts non-standard level metrics in extra', () => {
    const yaml = MINI_ASSET_YAML.replace('holder_flows:', '  widget_count: { type: level, unit: count, staleness_days: 30 }\nholder_flows:');
    const asset = parseAssetYaml(yaml).config;
    const r = computeDrivers(asset, [...miniObservations(), obs('widget_count', 7, '2026-06-29')], AS_OF);
    expect(r.drivers!.extra.widget_count.value).toBe(7);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tests/drivers/compute.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `src/drivers/compute.ts`**

```ts
import type { AssetConfig, CaptureRule, FlowKind, RecipientBase } from '../config/schema.js';
import type { Observation } from '../db/observations.js';
import { STD_METRICS, type Provenance } from '../types.js';
import {
  buildSchedule, isStale, latestLevel, obsProvenance, trailingFlowAnnualized, worstProvenance, type ScheduleStep,
} from './select.js';

export interface DriverValue {
  value: number;
  provenance: Provenance;
  derived: boolean;
  observedAt: string;
}
export interface HolderFlowDriver {
  id: string;
  kind: FlowKind;
  captureRule: CaptureRule;
  recipientBase: RecipientBase;
  annualizedUsd: DriverValue;
  captureRate: number;
}
export interface UnlockEvent {
  at: string;
  tokens: number;
}
export interface Drivers {
  asOf: string;
  price: DriverValue;
  revenueRunRate: DriverValue;
  usageIndex: DriverValue | null;
  effectiveSupply: DriverValue;
  circulatingSupply: DriverValue | null;
  stakedSupply: DriverValue;
  stakedRatio: DriverValue;
  lockedRatio: DriverValue | null;
  stakerEmissionShare: DriverValue;
  emissionSchedule: ScheduleStep[];
  emissionRateNow: DriverValue;
  realStakingYield: DriverValue;
  scheduledUnlocks: UnlockEvent[];
  marketCap: DriverValue | null;
  fdv: DriverValue;
  holderFlows: HolderFlowDriver[];
  captureRate: number;
  extra: Record<string, DriverValue>;
}
export interface DriverReport {
  drivers: Drivers | null;
  missing: string[];
  staleMetrics: string[];
  staleCritical: string[];
  provisionalMetrics: string[];
  manualMetrics: string[];
}

function derive(value: number, inputs: DriverValue[]): DriverValue {
  return {
    value,
    provenance: worstProvenance(inputs.map((i) => i.provenance)),
    derived: true,
    observedAt: inputs.map((i) => i.observedAt).sort()[0],
  };
}

function newestFetchedAt(list: Observation[]): string {
  return list.map((o) => o.fetchedAt).sort().at(-1)!;
}

export function computeDrivers(
  asset: AssetConfig,
  observations: Observation[],
  asOf: string,
  extraRequired: string[] = [],
): DriverReport {
  const byMetric = new Map<string, Observation[]>();
  for (const o of observations) {
    if (o.assetId !== asset.id) continue;
    const list = byMetric.get(o.metricKey) ?? [];
    list.push(o);
    byMetric.set(o.metricKey, list);
  }
  const of = (key: string) => byMetric.get(key) ?? [];

  const missing = new Set<string>();
  const stale = new Set<string>();
  const provisional = new Set<string>();
  const manual = new Set<string>();

  const note = (key: string, used: Observation[], freshnessIso: string) => {
    for (const o of used) {
      const p = obsProvenance(o);
      if (p === 'provisional') provisional.add(key);
      else if (p === 'manual') manual.add(key);
    }
    const def = asset.metrics[key];
    if (def && isStale(freshnessIso, asOf, def.staleness_days)) stale.add(key);
  };

  const level = (key: string, required: boolean): DriverValue | null => {
    const o = latestLevel(of(key), asOf);
    if (!o) {
      if (required) missing.add(key);
      return null;
    }
    note(key, [o], o.observedAt);
    return { value: o.value, provenance: obsProvenance(o), derived: false, observedAt: o.observedAt };
  };

  const price = level(STD_METRICS.price, true);
  const revenue = level(STD_METRICS.revenue, true);
  const usageIndex = level(STD_METRICS.usageIndex, false);
  const effective = level(STD_METRICS.effectiveSupply, true);
  const circulating = level(STD_METRICS.circulatingSupply, asset.supply_basis === 'circulating');
  const staked = level(STD_METRICS.stakedSupply, true);
  const locked = level(STD_METRICS.lockedSupply, false);
  const share = level(STD_METRICS.stakerEmissionShare, true);

  // Emission schedule: needs a step in force at asOf.
  const sched = buildSchedule(of(STD_METRICS.emissionRate), asOf);
  let emissionNow: DriverValue | null = null;
  const inForce = sched.used.find((o) => o.observedAt <= asOf);
  if (!inForce) {
    missing.add(STD_METRICS.emissionRate);
  } else {
    note(STD_METRICS.emissionRate, sched.used, newestFetchedAt(sched.used));
    emissionNow = { value: inForce.value, provenance: obsProvenance(inForce), derived: false, observedAt: inForce.observedAt };
  }

  // Scheduled unlocks: optional, future events only.
  const unlockObs = of(STD_METRICS.scheduledUnlock).filter((o) => o.observedAt > asOf);
  if (unlockObs.length > 0) note(STD_METRICS.scheduledUnlock, unlockObs, newestFetchedAt(unlockObs));
  const scheduledUnlocks = unlockObs
    .map((o) => ({ at: o.observedAt, tokens: o.value }))
    .sort((a, b) => (a.at < b.at ? -1 : 1));

  // Holder flows.
  const flowMetricKeys = new Set(asset.holder_flows.map((f) => f.metric));
  const flows: { def: AssetConfig['holder_flows'][number]; annualized: DriverValue }[] = [];
  for (const f of asset.holder_flows) {
    const past = of(f.metric).filter((o) => o.observedAt <= asOf);
    if (past.length === 0) {
      missing.add(f.metric);
      continue;
    }
    const newest = past.map((o) => o.observedAt).sort().at(-1)!;
    const { annualized, used } = trailingFlowAnnualized(past, asOf, f.window_days);
    const basis = used.length > 0 ? used : past;
    note(f.metric, basis, newest);
    flows.push({
      def: f,
      annualized: {
        value: annualized,
        provenance: worstProvenance(basis.map(obsProvenance)),
        derived: true,
        observedAt: newest,
      },
    });
  }

  // Extra: every non-standard level metric.
  const standard = new Set<string>(Object.values(STD_METRICS));
  const extra: Record<string, DriverValue> = {};
  for (const [key, def] of Object.entries(asset.metrics)) {
    if (def.type !== 'level' || standard.has(key) || flowMetricKeys.has(key)) continue;
    const v = level(key, extraRequired.includes(key));
    if (v) extra[key] = v;
  }
  for (const key of extraRequired) if (!extra[key]) missing.add(key);

  const report = (drivers: Drivers | null): DriverReport => ({
    drivers,
    missing: [...missing].sort(),
    staleMetrics: [...stale].sort(),
    staleCritical: [...stale].filter((k) => asset.metrics[k]?.critical).sort(),
    provisionalMetrics: [...provisional].sort(),
    manualMetrics: [...manual].sort(),
  });

  if (missing.size > 0 || !price || !revenue || !effective || !staked || !share || !emissionNow) return report(null);

  const holderFlows: HolderFlowDriver[] = flows.map(({ def, annualized }) => ({
    id: def.id,
    kind: def.kind,
    captureRule: def.capture_rule,
    recipientBase: def.recipient_base,
    annualizedUsd: annualized,
    captureRate: revenue.value > 0 ? annualized.value / revenue.value : 0,
  }));

  const stakerApr = staked.value > 0 ? (emissionNow.value * share.value) / staked.value : 0;
  const inflation = effective.value > 0 ? emissionNow.value / effective.value : 0;

  return report({
    asOf,
    price,
    revenueRunRate: revenue,
    usageIndex,
    effectiveSupply: effective,
    circulatingSupply: circulating,
    stakedSupply: staked,
    stakedRatio: derive(effective.value > 0 ? staked.value / effective.value : 0, [staked, effective]),
    lockedRatio: locked ? derive(effective.value > 0 ? locked.value / effective.value : 0, [locked, effective]) : null,
    stakerEmissionShare: share,
    emissionSchedule: sched.steps,
    emissionRateNow: emissionNow,
    realStakingYield: derive(stakerApr - inflation, [emissionNow, share, staked, effective]),
    scheduledUnlocks,
    marketCap: circulating ? derive(price.value * circulating.value, [price, circulating]) : null,
    fdv: derive(price.value * effective.value, [price, effective]),
    holderFlows,
    captureRate: holderFlows.reduce((s, f) => s + f.captureRate, 0),
    extra,
  });
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/drivers && npm run typecheck`
Expected: all driver tests PASS (6 new).

- [ ] **Step 6: Commit**

```bash
git add src/drivers/compute.ts tests/helpers/obs.ts tests/drivers/compute.test.ts
git commit -m "feat: compute standard drivers with provenance and staleness"
```

---

### Task 6: Engine paths and supply forecast

**Files:**
- Create: `src/engine/errors.ts`, `src/engine/version.ts`, `src/engine/paths.ts`, `src/engine/supply.ts`
- Modify: `tests/helpers/assets.ts` (add `miniAssumptions`)
- Test: `tests/engine/paths.test.ts`, `tests/engine/supply.test.ts`

**Interfaces:**
- Consumes: `Drivers`, `HolderFlowDriver` (Task 5); `ScheduleStep` (Task 4); `AssetConfig` (Task 2); `ScenarioAssumptions`, `MS_PER_DAY`, `DAYS_PER_YEAR`.
- Produces:
  - `class EngineError extends Error`
  - `ENGINE_VERSION = '1.0.0'`
  - `need(a: ScenarioAssumptions, key: string): number` (throws `EngineError` when missing or not finite)
  - `growthInYear(y: number, a): number`, `revenueAt(tau: number, r0: number, a): number`
  - `captureRateAt(tau: number, c0: number, cT: number, rampYears: number): number`
  - `flowUsdAt(tau: number, flow: HolderFlowDriver, drivers: Drivers, a): number`
  - `yearsBetween(asOf: string, iso: string): number`
  - `emissionsBetween(steps: ScheduleStep[], asOf: string, t0: number, t1: number): number`
  - `interface SupplyArgs { asset: AssetConfig; drivers: Drivers; assumptions: ScenarioAssumptions; horizonYears: number; targetPrice: number }`
  - `forecastSupply(args: SupplyArgs): number`
  - test helper `miniAssumptions(over?: Partial<Record<string, number>>): AssumptionValues`

Math (`tau` is years from `asOf`):
- Growth in year `y` (1-based): `g1` for `y = 1`; for `y >= 2`, `g1 + (gT - g1) * min(1, (y - 1) / fade)`; if `fade <= 0`, `gT`.
- `revenueAt(tau)` compounds whole years then a fractional year: `r0 * prod(1 + g_y) * (1 + g_next)^frac`.
- `captureRateAt(tau) = c0 + (cT - c0) * min(1, tau / ramp)`; if `ramp <= 0`, `cT` for `tau > 0` and `c0` at `tau = 0`.
- Supply: `S(H) = S0 + emissions[0,H] + unlocks(0,H] (circulating basis only) - tokens removed`. Tokens removed integrate `flowUsd / price` with the midpoint rule over `max(1, round(12 * H))` steps on the linear price path from spot to `targetPrice`. `burn` flows reduce supply on both bases. `buy_and_hold` flows reduce supply only on the `circulating` basis.

- [ ] **Step 1: Add `miniAssumptions`** (append to `tests/helpers/assets.ts`)

```ts
import type { AssumptionValues } from '../../src/types.js';

/** Flat world: no growth, capture stays at 10 percent, 10 percent discount rate. Same in every scenario. */
export function miniAssumptions(over: Partial<Record<string, number>> = {}): AssumptionValues {
  const one = {
    rev_growth_y1: 0,
    growth_fade_years: 1,
    terminal_growth: 0,
    'capture_rate_terminal.fees': 0.1,
    'capture_ramp_years.fees': 0,
    discount_rate_base: 0.1,
    staked_ratio_horizon: 0.5,
    ...over,
  } as Record<string, number>;
  return { bear: { ...one }, base: { ...one }, bull: { ...one } };
}
```

Move the new `import type` line to the top of the file with the other imports.

- [ ] **Step 2: Write the failing tests**

`tests/engine/paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EngineError } from '../../src/engine/errors.js';
import { captureRateAt, growthInYear, need, revenueAt } from '../../src/engine/paths.js';

const a = { rev_growth_y1: 1, growth_fade_years: 2, terminal_growth: 0 };

describe('revenue path', () => {
  it('fades growth linearly to terminal', () => {
    expect(growthInYear(1, a)).toBe(1);
    expect(growthInYear(2, a)).toBe(0.5);
    expect(growthInYear(3, a)).toBe(0);
    expect(growthInYear(9, a)).toBe(0);
  });
  it('compounds whole and fractional years', () => {
    expect(revenueAt(0, 100, a)).toBe(100);
    expect(revenueAt(0.5, 100, a)).toBeCloseTo(100 * Math.SQRT2, 9);
    expect(revenueAt(1, 100, a)).toBeCloseTo(200, 9);
    expect(revenueAt(2, 100, a)).toBeCloseTo(300, 9);
    expect(revenueAt(3, 100, a)).toBeCloseTo(300, 9);
  });
  it('jumps straight to terminal growth when fade is zero', () => {
    expect(growthInYear(2, { ...a, growth_fade_years: 0 })).toBe(0);
  });
});

describe('captureRateAt', () => {
  it('ramps linearly and then holds', () => {
    expect(captureRateAt(0, 0.1, 0.3, 2)).toBeCloseTo(0.1, 12);
    expect(captureRateAt(1, 0.1, 0.3, 2)).toBeCloseTo(0.2, 12);
    expect(captureRateAt(5, 0.1, 0.3, 2)).toBeCloseTo(0.3, 12);
  });
  it('switches immediately when ramp is zero', () => {
    expect(captureRateAt(0, 0.1, 0.3, 0)).toBe(0.1);
    expect(captureRateAt(0.01, 0.1, 0.3, 0)).toBe(0.3);
  });
});

describe('need', () => {
  it('throws EngineError for a missing key', () => {
    expect(() => need({}, 'x')).toThrow(EngineError);
  });
});
```

`tests/engine/supply.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeDrivers } from '../../src/drivers/compute.js';
import { emissionsBetween, forecastSupply } from '../../src/engine/supply.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

describe('emissionsBetween', () => {
  it('integrates a step schedule', () => {
    const steps = [
      { from: '2025-01-01T00:00:00.000Z', value: 1000 },
      { from: '2026-03-15T00:00:00.000Z', value: 500 }, // 73 days = 0.2 years after asOf
    ];
    expect(emissionsBetween(steps, '2026-01-01T00:00:00.000Z', 0, 0.5)).toBeCloseTo(1000 * 0.2 + 500 * 0.3, 9);
  });
  it('is zero before the first step', () => {
    expect(emissionsBetween([{ from: '2027-01-01T00:00:00.000Z', value: 500 }], '2026-01-01T00:00:00.000Z', 0, 0.5)).toBe(0);
  });
});

describe('forecastSupply', () => {
  const a = miniAssumptions().base;

  it('adds emissions and leaves a fee-share asset otherwise unchanged', () => {
    const drivers = computeDrivers(miniAsset(), miniObservations({ emission: 10 }), AS_OF).drivers!;
    expect(forecastSupply({ asset: miniAsset(), drivers, assumptions: a, horizonYears: 1, targetPrice: 10 })).toBeCloseTo(110, 9);
  });

  it('removes burned tokens along the price path', () => {
    const asset = miniAsset();
    asset.holder_flows[0].kind = 'burn';
    const list = miniObservations({ price: 1, revenue: 12000, supply: 100000, flowAnnual: 1200 });
    const drivers = computeDrivers(asset, list, AS_OF).drivers!;
    // 1200 USD per year at a flat price of 1 for half a year = 600 tokens
    expect(forecastSupply({ asset, drivers, assumptions: a, horizonYears: 0.5, targetPrice: 1 })).toBeCloseTo(100000 - 600, 6);
    // a higher target means a higher price path, so fewer tokens are burned
    const higher = forecastSupply({ asset, drivers, assumptions: a, horizonYears: 0.5, targetPrice: 3 });
    expect(higher).toBeGreaterThan(100000 - 600);
  });

  it('counts scheduled unlocks only on the circulating basis', () => {
    const asset = miniAsset();
    const list = [...miniObservations(), obs('circulating_supply', 40, '2026-06-29'), obs('scheduled_unlock_tokens', 5, '2026-09-01')];
    asset.metrics.circulating_supply = { ...asset.metrics.effective_supply };
    asset.metrics.scheduled_unlock_tokens = { ...asset.metrics.emission_rate_annual, type: 'event' };
    const total = computeDrivers(asset, list, AS_OF).drivers!;
    expect(forecastSupply({ asset, drivers: total, assumptions: a, horizonYears: 0.5, targetPrice: 10 })).toBeCloseTo(100, 9);
    asset.supply_basis = 'circulating';
    expect(forecastSupply({ asset, drivers: total, assumptions: a, horizonYears: 0.5, targetPrice: 10 })).toBeCloseTo(45, 9);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npx vitest run tests/engine`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write `src/engine/errors.ts` and `src/engine/version.ts`**

```ts
// src/engine/errors.ts
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}
```

```ts
// src/engine/version.ts
/** Bump on any change that can alter engine output. Replay refuses to run across versions. */
export const ENGINE_VERSION = '1.0.0';
```

- [ ] **Step 5: Write `src/engine/paths.ts`**

```ts
import type { Drivers, HolderFlowDriver } from '../drivers/compute.js';
import type { ScenarioAssumptions } from '../types.js';
import { EngineError } from './errors.js';

export function need(a: ScenarioAssumptions, key: string): number {
  const v = a[key];
  if (v === undefined || !Number.isFinite(v)) throw new EngineError(`missing assumption: ${key}`);
  return v;
}

export function growthInYear(y: number, a: ScenarioAssumptions): number {
  const g1 = need(a, 'rev_growth_y1');
  const gT = need(a, 'terminal_growth');
  const fade = need(a, 'growth_fade_years');
  if (y <= 1) return g1;
  if (fade <= 0) return gT;
  return g1 + (gT - g1) * Math.min(1, (y - 1) / fade);
}

export function revenueAt(tau: number, r0: number, a: ScenarioAssumptions): number {
  if (tau <= 0) return r0;
  const whole = Math.floor(tau);
  let r = r0;
  for (let y = 1; y <= whole; y++) r *= 1 + growthInYear(y, a);
  const frac = tau - whole;
  if (frac > 0) r *= Math.pow(1 + growthInYear(whole + 1, a), frac);
  return r;
}

export function captureRateAt(tau: number, c0: number, cT: number, rampYears: number): number {
  if (tau <= 0) return c0;
  if (rampYears <= 0) return cT;
  return c0 + (cT - c0) * Math.min(1, tau / rampYears);
}

/** Annualized USD run-rate of one holder flow at time tau. */
export function flowUsdAt(tau: number, flow: HolderFlowDriver, drivers: Drivers, a: ScenarioAssumptions): number {
  const revenue = revenueAt(tau, drivers.revenueRunRate.value, a);
  const rate = captureRateAt(
    tau,
    flow.captureRate,
    need(a, `capture_rate_terminal.${flow.id}`),
    need(a, `capture_ramp_years.${flow.id}`),
  );
  return revenue * rate;
}
```

- [ ] **Step 6: Write `src/engine/supply.ts`**

```ts
import type { AssetConfig } from '../config/schema.js';
import type { Drivers } from '../drivers/compute.js';
import type { ScheduleStep } from '../drivers/select.js';
import { DAYS_PER_YEAR, MS_PER_DAY, type ScenarioAssumptions } from '../types.js';
import { EngineError } from './errors.js';
import { flowUsdAt } from './paths.js';

export interface SupplyArgs {
  asset: AssetConfig;
  drivers: Drivers;
  assumptions: ScenarioAssumptions;
  horizonYears: number;
  targetPrice: number;
}

export function yearsBetween(asOf: string, iso: string): number {
  return (new Date(iso).getTime() - new Date(asOf).getTime()) / (MS_PER_DAY * DAYS_PER_YEAR);
}

export function emissionsBetween(steps: ScheduleStep[], asOf: string, t0: number, t1: number): number {
  const pts = steps.map((s) => ({ t: yearsBetween(asOf, s.from), rate: s.value })).sort((x, y) => x.t - y.t);
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const start = Math.max(pts[i].t, t0);
    const end = Math.min(i + 1 < pts.length ? pts[i + 1].t : Infinity, t1);
    if (end > start) total += pts[i].rate * (end - start);
  }
  return total;
}

export function forecastSupply(args: SupplyArgs): number {
  const { asset, drivers, assumptions, horizonYears: H, targetPrice } = args;
  const circulating = asset.supply_basis === 'circulating';
  const spot = drivers.price.value;

  let supply: number;
  if (circulating) {
    if (!drivers.circulatingSupply) throw new EngineError('circulating supply is required for the circulating basis');
    supply = drivers.circulatingSupply.value;
  } else {
    supply = drivers.effectiveSupply.value;
  }

  supply += emissionsBetween(drivers.emissionSchedule, drivers.asOf, 0, H);

  if (circulating) {
    for (const u of drivers.scheduledUnlocks) {
      const t = yearsBetween(drivers.asOf, u.at);
      if (t > 0 && t <= H) supply += u.tokens;
    }
  }

  const removing = drivers.holderFlows.filter((f) => f.kind === 'burn' || (circulating && f.kind === 'buy_and_hold'));
  if (removing.length > 0) {
    const steps = Math.max(1, Math.round(12 * H));
    const dt = H / steps;
    for (let i = 0; i < steps; i++) {
      const tau = (i + 0.5) * dt;
      const price = spot + (targetPrice - spot) * (tau / H);
      if (!(price > 0)) throw new EngineError('price path must stay positive');
      for (const f of removing) supply -= (flowUsdAt(tau, f, drivers, assumptions) / price) * dt;
    }
  }

  if (!(supply > 0)) throw new EngineError('forecast supply is not positive');
  return supply;
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/engine && npm run typecheck`
Expected: all PASS. If the unlock test fails on the ISO comparison, check that `obs()` normalizes `2026-09-01` to `2026-09-01T00:00:00.000Z` (63 days after `AS_OF`, which is 0.173 years, inside the 0.5 year horizon).

- [ ] **Step 8: Commit**

```bash
git add src/engine tests/engine tests/helpers/assets.ts
git commit -m "feat: add revenue, capture, and supply forecast paths"
```

---

### Task 7: Shared valuation modules and registry

**Files:**
- Create: `src/engine/modules/types.ts`, `src/engine/modules/keys.ts`, `src/engine/modules/holderCashflow.ts`, `src/engine/modules/forwardMultiple.ts`, `src/engine/modules/registry.ts`
- Test: `tests/engine/modules.test.ts`

**Interfaces:**
- Consumes: `Drivers` (Task 5); `need`, `flowUsdAt`, `revenueAt` (Task 6); `EngineError`; `CaptureRule`, `ModuleKind` (Task 2); `OrionError`.
- Produces:

```ts
export interface FlowRef { id: string; captureRule: CaptureRule }
export interface ModuleContext {
  instanceId: string;
  params: Record<string, unknown>;
  drivers: Drivers;
  assumptions: ScenarioAssumptions;
  horizonYears: number;
  supplyAtHorizon: number;
  priceAtHorizon: number;         // current fixed-point iterate of the target
  stakingYieldAtHorizon: number;  // staker APR in tokens
}
export interface ModuleResult { valuePerToken: number; breakdown: Record<string, unknown> }
export interface ValuationModule {
  type: string;
  allowedKinds: readonly ModuleKind[];
  validateParams(params: Record<string, unknown>): string[];
  assumptionKeys(instanceId: string, params: Record<string, unknown>, flows: FlowRef[]): string[];
  requiredExtra(params: Record<string, unknown>): string[];
  compute(ctx: ModuleContext): ModuleResult;
}
export function getModule(type: string): ValuationModule   // throws OrionError('unknown_module')
export function moduleTypes(): string[]
```

  - `keys.ts`: `REVENUE_KEYS`, `captureKeys(flows)`, `discountKeys(flows)`, `discountRateFor(rule, a)`.

Math:
- `holder_cashflow`: for each flow `k`, `r_k = discount_rate_base + premium(rule)`, `g = terminal_growth`, `N = params.years ?? 5`. Year `t` flow is the run-rate at the mid-year point `H + t - 0.5`. `PV_k = sum_{t=1..N} F_k(t)/(1+r_k)^t + [F_k(N) * (1+g)/(r_k - g)] / (1+r_k)^N`. `value = sum(PV_k) / S(H)`. Throws `EngineError` when `r_k <= g`.
- `forward_multiple`: `basis` is the run-rate at `H + 0.5` (revenue, or the sum of holder flows). `value = basis * multiple.<instanceId> * regime_multiplier / S(H)`.

- [ ] **Step 1: Write the failing test** `tests/engine/modules.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { computeDrivers } from '../../src/drivers/compute.js';
import { EngineError } from '../../src/engine/errors.js';
import { getModule, moduleTypes } from '../../src/engine/modules/registry.js';
import type { ModuleContext } from '../../src/engine/modules/types.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

function ctx(over: Partial<ModuleContext> = {}): ModuleContext {
  return {
    instanceId: 'm',
    params: {},
    drivers: computeDrivers(miniAsset(), miniObservations(), AS_OF).drivers!,
    assumptions: miniAssumptions().base,
    horizonYears: 1,
    supplyAtHorizon: 100,
    priceAtHorizon: 10,
    stakingYieldAtHorizon: 0,
    ...over,
  };
}

describe('registry', () => {
  it('knows the shared modules and rejects unknown types', () => {
    expect(moduleTypes()).toEqual(expect.arrayContaining(['holder_cashflow', 'forward_multiple']));
    expect(() => getModule('nope')).toThrow(/unknown module/);
  });
});

describe('holder_cashflow', () => {
  const m = getModule('holder_cashflow');

  it('values a flat 100 per year flow at 10 percent as a 1000 perpetuity', () => {
    const r = m.compute(ctx());
    expect(r.valuePerToken).toBeCloseTo(10, 6);
    expect(r.breakdown.aggregate_pv_usd).toBeCloseTo(1000, 4);
  });

  it('adds the capture-rule premium to the discount rate', () => {
    const c = ctx({ assumptions: { ...miniAssumptions().base, discount_premium_discretionary: 0.1 } });
    c.drivers.holderFlows[0].captureRule = 'discretionary';
    expect(m.compute(c).valuePerToken).toBeCloseTo(5, 6); // 100 / 0.20 / 100
  });

  it('throws when the discount rate does not exceed terminal growth', () => {
    const c = ctx({ assumptions: { ...miniAssumptions().base, terminal_growth: 0.1 } });
    expect(() => m.compute(c)).toThrow(EngineError);
  });

  it('declares premium keys only for the rules in use', () => {
    expect(m.assumptionKeys('hc', {}, [{ id: 'fees', captureRule: 'contractual' }])).not.toContain('discount_premium_discretionary');
    expect(m.assumptionKeys('hc', {}, [{ id: 'burn', captureRule: 'discretionary' }])).toContain('discount_premium_discretionary');
  });
});

describe('forward_multiple', () => {
  const m = getModule('forward_multiple');
  const a = { ...miniAssumptions().base, 'multiple.m': 10, regime_multiplier: 0.5 };

  it('applies multiple and regime to forward revenue', () => {
    const r = m.compute(ctx({ params: { basis: 'revenue' }, assumptions: a }));
    expect(r.valuePerToken).toBeCloseTo((1000 * 10 * 0.5) / 100, 9);
  });

  it('can use holder flow as the basis', () => {
    const r = m.compute(ctx({ params: { basis: 'holder_flow' }, assumptions: a }));
    expect(r.valuePerToken).toBeCloseTo((100 * 10 * 0.5) / 100, 9);
  });

  it('validates params and names its multiple key after the instance', () => {
    expect(m.validateParams({})).not.toEqual([]);
    expect(m.validateParams({ basis: 'revenue' })).toEqual([]);
    expect(m.assumptionKeys('fm_rev', { basis: 'revenue' }, [])).toContain('multiple.fm_rev');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/engine/modules.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/engine/modules/types.ts`**

```ts
import type { CaptureRule, ModuleKind } from '../../config/schema.js';
import type { Drivers } from '../../drivers/compute.js';
import type { ScenarioAssumptions } from '../../types.js';

export interface FlowRef {
  id: string;
  captureRule: CaptureRule;
}

export interface ModuleContext {
  instanceId: string;
  params: Record<string, unknown>;
  drivers: Drivers;
  assumptions: ScenarioAssumptions;
  horizonYears: number;
  supplyAtHorizon: number;
  priceAtHorizon: number;
  stakingYieldAtHorizon: number;
}

export interface ModuleResult {
  valuePerToken: number;
  breakdown: Record<string, unknown>;
}

export interface ValuationModule {
  type: string;
  allowedKinds: readonly ModuleKind[];
  validateParams(params: Record<string, unknown>): string[];
  assumptionKeys(instanceId: string, params: Record<string, unknown>, flows: FlowRef[]): string[];
  requiredExtra(params: Record<string, unknown>): string[];
  compute(ctx: ModuleContext): ModuleResult;
}
```

- [ ] **Step 4: Write `src/engine/modules/keys.ts`**

```ts
import type { CaptureRule } from '../../config/schema.js';
import type { ScenarioAssumptions } from '../../types.js';
import { need } from '../paths.js';
import type { FlowRef } from './types.js';

export const REVENUE_KEYS = ['rev_growth_y1', 'growth_fade_years', 'terminal_growth'] as const;

export function captureKeys(flows: FlowRef[]): string[] {
  return flows.flatMap((f) => [`capture_rate_terminal.${f.id}`, `capture_ramp_years.${f.id}`]);
}

export function discountKeys(flows: FlowRef[]): string[] {
  const keys = ['discount_rate_base'];
  if (flows.some((f) => f.captureRule === 'programmatic')) keys.push('discount_premium_programmatic');
  if (flows.some((f) => f.captureRule === 'discretionary')) keys.push('discount_premium_discretionary');
  return keys;
}

export function discountRateFor(rule: CaptureRule, a: ScenarioAssumptions): number {
  const base = need(a, 'discount_rate_base');
  if (rule === 'programmatic') return base + need(a, 'discount_premium_programmatic');
  if (rule === 'discretionary') return base + need(a, 'discount_premium_discretionary');
  return base;
}
```

- [ ] **Step 5: Write `src/engine/modules/holderCashflow.ts`**

```ts
import { EngineError } from '../errors.js';
import { flowUsdAt, need } from '../paths.js';
import { captureKeys, discountKeys, discountRateFor, REVENUE_KEYS } from './keys.js';
import type { ValuationModule } from './types.js';

function years(params: Record<string, unknown>): number {
  return typeof params.years === 'number' ? params.years : 5;
}

export const holderCashflow: ValuationModule = {
  type: 'holder_cashflow',
  allowedKinds: ['estimate'],

  validateParams(params) {
    const errors: string[] = [];
    if (params.years !== undefined && !(typeof params.years === 'number' && Number.isInteger(params.years) && params.years >= 1)) {
      errors.push('years must be a positive integer');
    }
    return errors;
  },

  assumptionKeys(_id, _params, flows) {
    return [...REVENUE_KEYS, ...captureKeys(flows), ...discountKeys(flows)];
  },

  requiredExtra() {
    return [];
  },

  compute(ctx) {
    const N = years(ctx.params);
    const H = ctx.horizonYears;
    const g = need(ctx.assumptions, 'terminal_growth');
    let aggregate = 0;
    const flows: Record<string, unknown> = {};

    for (const f of ctx.drivers.holderFlows) {
      const r = discountRateFor(f.captureRule, ctx.assumptions);
      if (r <= g) throw new EngineError(`discount rate ${r} must exceed terminal growth ${g} (flow ${f.id})`);
      let pv = 0;
      let last = 0;
      for (let t = 1; t <= N; t++) {
        last = flowUsdAt(H + t - 0.5, f, ctx.drivers, ctx.assumptions);
        pv += last / Math.pow(1 + r, t);
      }
      const terminal = (last * (1 + g)) / (r - g) / Math.pow(1 + r, N);
      aggregate += pv + terminal;
      flows[f.id] = {
        discount_rate: r,
        capture_rule: f.captureRule,
        recipient_base: f.recipientBase,
        explicit_pv_usd: pv,
        terminal_pv_usd: terminal,
      };
    }

    return {
      valuePerToken: aggregate / ctx.supplyAtHorizon,
      breakdown: {
        aggregate_pv_usd: aggregate,
        supply_at_horizon: ctx.supplyAtHorizon,
        explicit_years: N,
        flows,
        note: 'Aggregate holder-flow value divided by total forecast supply, whatever the recipient base.',
      },
    };
  },
};
```

- [ ] **Step 6: Write `src/engine/modules/forwardMultiple.ts`**

```ts
import { flowUsdAt, need, revenueAt } from '../paths.js';
import { captureKeys, REVENUE_KEYS } from './keys.js';
import type { ValuationModule } from './types.js';

type Basis = 'revenue' | 'holder_flow';
const isBasis = (x: unknown): x is Basis => x === 'revenue' || x === 'holder_flow';

export const forwardMultiple: ValuationModule = {
  type: 'forward_multiple',
  allowedKinds: ['estimate'],

  validateParams(params) {
    const errors: string[] = [];
    if (!isBasis(params.basis)) errors.push('basis must be "revenue" or "holder_flow"');
    if (params.market_convention !== undefined && typeof params.market_convention !== 'boolean') {
      errors.push('market_convention must be a boolean');
    }
    return errors;
  },

  assumptionKeys(instanceId, params, flows) {
    const keys = [...REVENUE_KEYS, `multiple.${instanceId}`, 'regime_multiplier'];
    if (params.basis === 'holder_flow') keys.push(...captureKeys(flows));
    return keys;
  },

  requiredExtra() {
    return [];
  },

  compute(ctx) {
    const basisKind: Basis = isBasis(ctx.params.basis) ? ctx.params.basis : 'revenue';
    const mid = ctx.horizonYears + 0.5;
    const basis =
      basisKind === 'revenue'
        ? revenueAt(mid, ctx.drivers.revenueRunRate.value, ctx.assumptions)
        : ctx.drivers.holderFlows.reduce((s, f) => s + flowUsdAt(mid, f, ctx.drivers, ctx.assumptions), 0);
    const multiple = need(ctx.assumptions, `multiple.${ctx.instanceId}`);
    const regime = need(ctx.assumptions, 'regime_multiplier');
    const aggregate = basis * multiple * regime;
    return {
      valuePerToken: aggregate / ctx.supplyAtHorizon,
      breakdown: {
        basis: basisKind,
        market_convention: ctx.params.market_convention === true,
        forward_basis_usd: basis,
        multiple,
        regime_multiplier: regime,
        aggregate_value_usd: aggregate,
        supply_at_horizon: ctx.supplyAtHorizon,
      },
    };
  },
};
```

- [ ] **Step 7: Write `src/engine/modules/registry.ts`**

```ts
import { OrionError } from '../../types.js';
import { forwardMultiple } from './forwardMultiple.js';
import { holderCashflow } from './holderCashflow.js';
import type { ValuationModule } from './types.js';

const MODULES = new Map<string, ValuationModule>();

export function registerModule(m: ValuationModule): void {
  MODULES.set(m.type, m);
}

registerModule(holderCashflow);
registerModule(forwardMultiple);

export function getModule(type: string): ValuationModule {
  const m = MODULES.get(type);
  if (!m) throw new OrionError('unknown_module', `unknown module type: ${type}`);
  return m;
}

export function moduleTypes(): string[] {
  return [...MODULES.keys()].sort();
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run tests/engine/modules.test.ts && npm run typecheck`
Expected: 9 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/engine/modules tests/engine/modules.test.ts
git commit -m "feat: add holder_cashflow and forward_multiple modules"
```

---

### Task 8: utility_claim module (custom, VVV)

**Files:**
- Create: `src/engine/modules/utilityClaim.ts`
- Modify: `src/engine/modules/registry.ts` (register it)
- Test: `tests/engine/utilityClaim.test.ts`

**Interfaces:**
- Consumes: `ValuationModule`, `ModuleContext` (Task 7); `need`; `EngineError`.
- Produces: `utilityClaim: ValuationModule` with `type: 'utility_claim'`, `allowedKinds: ['component']`.
  - Params (all optional except the basis): `diem_value_basis: 'market' | 'intrinsic'`, `mint_base_rate` (default 90), `mint_curve_k` (default 2), `mint_curve_power` (default 3), `credit_usd_per_year` (default 365), `years` (default 5).
  - Extra drivers read: `diem_supply`, `diem_target_supply`, `diem_locked_yield_share`, and `diem_price_usd` when the basis is `market`.
  - Assumption keys: `diem_target_supply_growth`, `diem_discount_rate`, and `diem_utilization` when the basis is `intrinsic`.

Math (values future DIEM issuance only; existing DIEM is value already distributed):

```
fill          = min(1, diem_supply / diem_target_supply)            held constant
mint_rate     = mint_base_rate * exp(mint_curve_k * fill^mint_curve_power)     VVV locked per DIEM
diem_value    = market: diem_price_usd
                intrinsic: credit_usd_per_year * diem_utilization / diem_discount_rate
haircut/yr    = mint_rate * stakingYieldAtHorizon * (1 - diem_locked_yield_share) * priceAtHorizon
cost          = haircut/yr * sum_{t=1..N} 1/(1+r)^t                  r = diem_discount_rate
net           = max(0, diem_value - cost)
issuance(t)   = fill * target0 * ((1+g)^(H+t) - (1+g)^(H+t-1))       g = diem_target_supply_growth
value         = sum_{t=1..N} issuance(t) * net / (1+r)^t / S(H)
```

- [ ] **Step 1: Write the failing test** `tests/engine/utilityClaim.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { computeDrivers, type DriverValue } from '../../src/drivers/compute.js';
import { getModule } from '../../src/engine/modules/registry.js';
import type { ModuleContext } from '../../src/engine/modules/types.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const dv = (value: number): DriverValue => ({ value, provenance: 'onchain', derived: false, observedAt: AS_OF });

function ctx(assumptions: Record<string, number>, params: Record<string, unknown>): ModuleContext {
  const drivers = computeDrivers(miniAsset(), miniObservations(), AS_OF).drivers!;
  drivers.extra = {
    diem_supply: dv(500),
    diem_target_supply: dv(1000),
    diem_locked_yield_share: dv(0.8),
    diem_price_usd: dv(10),
  };
  return {
    instanceId: 'diem', params, drivers,
    assumptions: { ...miniAssumptions().base, ...assumptions },
    horizonYears: 1, supplyAtHorizon: 1000, priceAtHorizon: 5, stakingYieldAtHorizon: 0.1,
  };
}

describe('utility_claim', () => {
  const m = getModule('utility_claim');
  const params = { diem_value_basis: 'market', mint_base_rate: 2, mint_curve_k: 0, years: 1 };

  it('is a component and needs its extra drivers', () => {
    expect(m.allowedKinds).toEqual(['component']);
    expect(m.requiredExtra(params)).toEqual(
      expect.arrayContaining(['diem_supply', 'diem_target_supply', 'diem_locked_yield_share', 'diem_price_usd']),
    );
    expect(m.requiredExtra({ diem_value_basis: 'intrinsic' })).not.toContain('diem_price_usd');
  });

  it('is worth nothing when the target supply does not grow', () => {
    expect(m.compute(ctx({ diem_target_supply_growth: 0, diem_discount_rate: 0.25 }, params)).valuePerToken).toBe(0);
  });

  it('matches the hand-computed value', () => {
    // fill 0.5, target doubles yearly: issuance in year 1 after H=1 is 0.5*1000*(4-2) = 1000 DIEM
    // mint_rate 2, haircut = 2*0.1*0.2*5 = 0.2/yr, cost = 0.2/1.25 = 0.16, net = 9.84
    // value = 1000 * 9.84 / 1.25 / 1000 = 7.872
    const r = m.compute(ctx({ diem_target_supply_growth: 1, diem_discount_rate: 0.25 }, params));
    expect(r.valuePerToken).toBeCloseTo(7.872, 9);
  });

  it('supports an intrinsic DIEM value', () => {
    const p = { ...params, diem_value_basis: 'intrinsic', credit_usd_per_year: 365 };
    const r = m.compute(ctx({ diem_target_supply_growth: 1, diem_discount_rate: 0.25, diem_utilization: 0.5 }, p));
    // diem_value = 365*0.5/0.25 = 730 ; net = 729.84 ; value = 1000*729.84/1.25/1000
    expect(r.valuePerToken).toBeCloseTo(729.84 / 1.25, 9);
    expect(m.assumptionKeys('diem', p, [])).toContain('diem_utilization');
  });

  it('never goes negative when locking costs more than DIEM is worth', () => {
    const r = m.compute({ ...ctx({ diem_target_supply_growth: 1, diem_discount_rate: 0.25 }, params), priceAtHorizon: 1e6 });
    expect(r.valuePerToken).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/engine/utilityClaim.test.ts`
Expected: FAIL, `unknown module type: utility_claim`.

- [ ] **Step 3: Write `src/engine/modules/utilityClaim.ts`**

```ts
import { EngineError } from '../errors.js';
import { need } from '../paths.js';
import type { ModuleContext, ValuationModule } from './types.js';

type Basis = 'market' | 'intrinsic';
const isBasis = (x: unknown): x is Basis => x === 'market' || x === 'intrinsic';
const num = (params: Record<string, unknown>, key: string, fallback: number): number =>
  typeof params[key] === 'number' ? (params[key] as number) : fallback;

function extra(ctx: ModuleContext, key: string): number {
  const v = ctx.drivers.extra[key];
  if (!v) throw new EngineError(`utility_claim needs extra driver "${key}"`);
  return v.value;
}

export const utilityClaim: ValuationModule = {
  type: 'utility_claim',
  allowedKinds: ['component'],

  validateParams(params) {
    const errors: string[] = [];
    if (!isBasis(params.diem_value_basis)) errors.push('diem_value_basis must be "market" or "intrinsic"');
    for (const key of ['mint_base_rate', 'mint_curve_k', 'mint_curve_power', 'credit_usd_per_year', 'years']) {
      if (params[key] !== undefined && typeof params[key] !== 'number') errors.push(`${key} must be a number`);
    }
    return errors;
  },

  assumptionKeys(_id, params) {
    const keys = ['diem_target_supply_growth', 'diem_discount_rate'];
    if (params.diem_value_basis === 'intrinsic') keys.push('diem_utilization');
    return keys;
  },

  requiredExtra(params) {
    const keys = ['diem_supply', 'diem_target_supply', 'diem_locked_yield_share'];
    if (params.diem_value_basis !== 'intrinsic') keys.push('diem_price_usd');
    return keys;
  },

  compute(ctx) {
    const p = ctx.params;
    const basis: Basis = isBasis(p.diem_value_basis) ? p.diem_value_basis : 'market';
    const N = num(p, 'years', 5);
    const H = ctx.horizonYears;
    const g = need(ctx.assumptions, 'diem_target_supply_growth');
    const r = need(ctx.assumptions, 'diem_discount_rate');
    if (!(r > 0)) throw new EngineError('diem_discount_rate must be positive');

    const supply = extra(ctx, 'diem_supply');
    const target0 = extra(ctx, 'diem_target_supply');
    const lockedShare = extra(ctx, 'diem_locked_yield_share');
    const fill = target0 > 0 ? Math.min(1, supply / target0) : 0;

    const mintRate =
      num(p, 'mint_base_rate', 90) * Math.exp(num(p, 'mint_curve_k', 2) * Math.pow(fill, num(p, 'mint_curve_power', 3)));
    const diemValue =
      basis === 'market'
        ? extra(ctx, 'diem_price_usd')
        : (num(p, 'credit_usd_per_year', 365) * need(ctx.assumptions, 'diem_utilization')) / r;

    const haircutPerYear = mintRate * ctx.stakingYieldAtHorizon * (1 - lockedShare) * ctx.priceAtHorizon;
    let annuity = 0;
    for (let t = 1; t <= N; t++) annuity += 1 / Math.pow(1 + r, t);
    const cost = haircutPerYear * annuity;
    const net = Math.max(0, diemValue - cost);

    let pv = 0;
    let issued = 0;
    for (let t = 1; t <= N; t++) {
      const issuance = fill * target0 * (Math.pow(1 + g, H + t) - Math.pow(1 + g, H + t - 1));
      issued += issuance;
      pv += (issuance * net) / Math.pow(1 + r, t);
    }

    return {
      valuePerToken: pv / ctx.supplyAtHorizon,
      breakdown: {
        diem_value_basis: basis,
        diem_value_usd: diemValue,
        mint_rate_vvv_per_diem: mintRate,
        cost_of_locking_usd: cost,
        net_value_per_diem_usd: net,
        fill_ratio: fill,
        diem_issued_over_explicit_years: issued,
        aggregate_pv_usd: pv,
        note: 'Values future DIEM issuance only. Existing DIEM is value already distributed to its minters.',
      },
    };
  },
};
```

- [ ] **Step 4: Register it.** In `src/engine/modules/registry.ts` add the import and the registration:

```ts
import { utilityClaim } from './utilityClaim.js';
```

```ts
registerModule(utilityClaim);
```

(place the `registerModule` call directly after `registerModule(forwardMultiple);`)

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/engine && npm run typecheck`
Expected: all PASS (5 new).

- [ ] **Step 6: Commit**

```bash
git add src/engine/modules tests/engine/utilityClaim.test.ts
git commit -m "feat: add utility_claim component module for DIEM issuance"
```

---

### Task 9: Assumption requirements, validation, and store

**Files:**
- Create: `src/engine/requirements.ts`, `src/db/assumptions.ts`
- Test: `tests/engine/requirements.test.ts`, `tests/db/assumptions.test.ts`

**Interfaces:**
- Consumes: `getModule` (Task 7); `REVENUE_KEYS`, `captureKeys`, `discountRateFor` (Task 7); `AssetConfig`; `AssumptionValues`, `SCENARIOS`, `Scenario`; `Db`.
- Produces:
  - `flowRefs(asset: AssetConfig): FlowRef[]`
  - `requiredAssumptionKeys(asset: AssetConfig): string[]` (sorted; always includes revenue keys, capture keys for every flow, and `staked_ratio_horizon`, plus each module's keys)
  - `requiredExtraMetrics(asset: AssetConfig): string[]` (module extras plus `total_return_variants` metrics, sorted)
  - `validateAssetModules(asset: AssetConfig): string[]` (unknown type, disallowed kind, bad params, required assumption key without bounds, required extra metric not defined)
  - `validateAssumptions(asset: AssetConfig, values: AssumptionValues, opts?: { checkBounds?: boolean }): string[]` (missing keys, unknown keys, out of bounds, `rev_growth_y1 <= -1`, discount rate not above terminal growth)
  - `interface AssumptionSet { id: number; assetId: string; version: number; parentVersion: number | null; author: string; rationale: string; createdAt: string; values: AssumptionValues }`
  - `createAssumptionSet(db, input: { assetId: string; author: string; rationale: string; values: AssumptionValues; createdAt: string }): AssumptionSet`
  - `getLatestAssumptionSet(db, assetId): AssumptionSet | null`, `getAssumptionSetById(db, id): AssumptionSet | null`, `listAssumptionSets(db, assetId): Omit<AssumptionSet, 'values'>[]`

- [ ] **Step 1: Write the failing tests**

`tests/engine/requirements.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import {
  requiredAssumptionKeys, requiredExtraMetrics, validateAssetModules, validateAssumptions,
} from '../../src/engine/requirements.js';
import { MINI_ASSET_YAML, miniAsset, miniAssumptions } from '../helpers/assets.js';

describe('requirements', () => {
  it('lists required assumption keys for the mini asset', () => {
    expect(requiredAssumptionKeys(miniAsset())).toEqual([
      'capture_ramp_years.fees', 'capture_rate_terminal.fees', 'discount_rate_base',
      'growth_fade_years', 'rev_growth_y1', 'staked_ratio_horizon', 'terminal_growth',
    ]);
    expect(requiredExtraMetrics(miniAsset())).toEqual([]);
  });

  it('accepts a valid asset and valid assumptions', () => {
    expect(validateAssetModules(miniAsset())).toEqual([]);
    expect(validateAssumptions(miniAsset(), miniAssumptions())).toEqual([]);
  });

  it('reports unknown module types, disallowed kinds, and missing bounds', () => {
    const unknown = parseAssetYaml(MINI_ASSET_YAML.replace('type: holder_cashflow', 'type: nope')).config;
    expect(validateAssetModules(unknown).join('\n')).toMatch(/unknown module type/);
    const noBound = parseAssetYaml(MINI_ASSET_YAML.replace('  discount_rate_base: { min: 0.05, max: 0.5 }\n', '')).config;
    expect(validateAssetModules(noBound).join('\n')).toMatch(/discount_rate_base/);
  });

  it('reports missing, unknown, and out-of-bounds assumptions', () => {
    const values = miniAssumptions({ discount_rate_base: 0.9 });
    delete values.bear.rev_growth_y1;
    values.bull.mystery = 1;
    const errors = validateAssumptions(miniAsset(), values).join('\n');
    expect(errors).toMatch(/bear: missing rev_growth_y1/);
    expect(errors).toMatch(/bull: unknown key mystery/);
    expect(errors).toMatch(/discount_rate_base .* outside/);
  });

  it('can skip bounds for what-if runs but still checks the math', () => {
    const values = miniAssumptions({ discount_rate_base: 0.9 });
    expect(validateAssumptions(miniAsset(), values, { checkBounds: false })).toEqual([]);
    const broken = miniAssumptions({ terminal_growth: 0.2 });
    expect(validateAssumptions(miniAsset(), broken, { checkBounds: false }).join('\n')).toMatch(/must exceed terminal growth/);
  });
});
```

`tests/db/assumptions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createAssumptionSet, getAssumptionSetById, getLatestAssumptionSet, listAssumptionSets } from '../../src/db/assumptions.js';
import { openDb } from '../../src/db/connection.js';
import { miniAssumptions } from '../helpers/assets.js';

describe('assumption sets', () => {
  it('versions sets per asset and round-trips values', () => {
    const db = openDb(':memory:');
    expect(getLatestAssumptionSet(db, 'mini')).toBeNull();
    const v1 = createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale: 'first', values: miniAssumptions(), createdAt: '2026-06-30T00:00:00Z' });
    const v2 = createAssumptionSet(db, {
      assetId: 'mini', author: 'user', rationale: 'second', values: miniAssumptions({ rev_growth_y1: 0.2 }), createdAt: '2026-07-01T00:00:00Z',
    });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(v2.parentVersion).toBe(1);
    expect(getLatestAssumptionSet(db, 'mini')!.values.base.rev_growth_y1).toBe(0.2);
    expect(getAssumptionSetById(db, v1.id)!.values).toEqual(miniAssumptions());
    expect(listAssumptionSets(db, 'mini').map((s) => s.rationale)).toEqual(['second', 'first']);
    expect(getLatestAssumptionSet(db, 'other')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run tests/engine/requirements.test.ts tests/db/assumptions.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/engine/requirements.ts`**

```ts
import type { AssetConfig } from '../config/schema.js';
import { OrionError, SCENARIOS, type AssumptionValues } from '../types.js';
import { captureKeys, discountRateFor, REVENUE_KEYS } from './modules/keys.js';
import { getModule } from './modules/registry.js';
import type { FlowRef, ValuationModule } from './modules/types.js';

export function flowRefs(asset: AssetConfig): FlowRef[] {
  return asset.holder_flows.map((f) => ({ id: f.id, captureRule: f.capture_rule }));
}

function tryModule(type: string): ValuationModule | null {
  try {
    return getModule(type);
  } catch (err) {
    if (err instanceof OrionError) return null;
    throw err;
  }
}

export function requiredAssumptionKeys(asset: AssetConfig): string[] {
  const flows = flowRefs(asset);
  const keys = new Set<string>([...REVENUE_KEYS, ...captureKeys(flows), 'staked_ratio_horizon']);
  for (const m of asset.modules) {
    const impl = tryModule(m.type);
    if (impl) for (const k of impl.assumptionKeys(m.id, m.params, flows)) keys.add(k);
  }
  return [...keys].sort();
}

export function requiredExtraMetrics(asset: AssetConfig): string[] {
  const keys = new Set<string>(asset.total_return_variants.map((v) => v.yield_multiplier_metric));
  for (const m of asset.modules) {
    const impl = tryModule(m.type);
    if (impl) for (const k of impl.requiredExtra(m.params)) keys.add(k);
  }
  return [...keys].sort();
}

export function validateAssetModules(asset: AssetConfig): string[] {
  const errors: string[] = [];
  for (const m of asset.modules) {
    const impl = tryModule(m.type);
    if (!impl) {
      errors.push(`modules.${m.id}: unknown module type "${m.type}"`);
      continue;
    }
    if (!impl.allowedKinds.includes(m.kind)) errors.push(`modules.${m.id}: type ${m.type} cannot be a ${m.kind}`);
    for (const e of impl.validateParams(m.params)) errors.push(`modules.${m.id}.params: ${e}`);
  }
  for (const key of requiredAssumptionKeys(asset)) {
    if (!asset.assumptions[key]) errors.push(`assumptions: required key "${key}" has no bounds`);
  }
  for (const key of requiredExtraMetrics(asset)) {
    if (asset.metrics[key]?.type !== 'level') errors.push(`metrics: required extra metric "${key}" must be defined with type level`);
  }
  return errors;
}

export function validateAssumptions(
  asset: AssetConfig,
  values: AssumptionValues,
  opts: { checkBounds?: boolean } = {},
): string[] {
  const checkBounds = opts.checkBounds ?? true;
  const required = requiredAssumptionKeys(asset);
  const errors: string[] = [];
  const usesCashflow = asset.modules.some((m) => m.type === 'holder_cashflow');

  for (const s of SCENARIOS) {
    const a = values[s] ?? {};
    for (const key of required) {
      if (a[key] === undefined || !Number.isFinite(a[key])) errors.push(`${s}: missing ${key}`);
    }
    for (const key of Object.keys(a)) {
      if (!required.includes(key)) errors.push(`${s}: unknown key ${key}`);
    }
    if (checkBounds) {
      for (const key of required) {
        const b = asset.assumptions[key];
        const v = a[key];
        if (b && v !== undefined && (v < b.min || v > b.max)) {
          errors.push(`${s}: ${key} = ${v} is outside [${b.min}, ${b.max}]`);
        }
      }
    }
    if (a.rev_growth_y1 !== undefined && a.rev_growth_y1 <= -1) errors.push(`${s}: rev_growth_y1 must be greater than -1`);
    if (usesCashflow && a.discount_rate_base !== undefined && a.terminal_growth !== undefined) {
      for (const f of flowRefs(asset)) {
        let r: number;
        try {
          r = discountRateFor(f.captureRule, a);
        } catch {
          continue; // the missing premium key is already reported above
        }
        if (r <= a.terminal_growth) {
          errors.push(`${s}: discount rate ${r} for flow ${f.id} must exceed terminal growth ${a.terminal_growth}`);
        }
      }
    }
  }
  return errors;
}
```

- [ ] **Step 4: Write `src/db/assumptions.ts`**

```ts
import { SCENARIOS, type AssumptionValues, type Scenario } from '../types.js';
import type { Db } from './connection.js';

export interface AssumptionSet {
  id: number;
  assetId: string;
  version: number;
  parentVersion: number | null;
  author: string;
  rationale: string;
  createdAt: string;
  values: AssumptionValues;
}

interface SetRow {
  id: number;
  asset_id: string;
  version: number;
  parent_version: number | null;
  author: string;
  rationale: string;
  created_at: string;
}

function meta(r: SetRow): Omit<AssumptionSet, 'values'> {
  return {
    id: r.id, assetId: r.asset_id, version: r.version, parentVersion: r.parent_version,
    author: r.author, rationale: r.rationale, createdAt: r.created_at,
  };
}

function loadValues(db: Db, setId: number): AssumptionValues {
  const values: AssumptionValues = { bear: {}, base: {}, bull: {} };
  const rows = db.prepare('SELECT key, scenario, value FROM assumptions WHERE set_id = ? ORDER BY key').all(setId) as {
    key: string; scenario: Scenario; value: number;
  }[];
  for (const r of rows) values[r.scenario][r.key] = r.value;
  return values;
}

export function getAssumptionSetById(db: Db, id: number): AssumptionSet | null {
  const row = db.prepare('SELECT * FROM assumption_sets WHERE id = ?').get(id) as SetRow | undefined;
  return row ? { ...meta(row), values: loadValues(db, row.id) } : null;
}

export function getLatestAssumptionSet(db: Db, assetId: string): AssumptionSet | null {
  const row = db
    .prepare('SELECT * FROM assumption_sets WHERE asset_id = ? ORDER BY version DESC LIMIT 1')
    .get(assetId) as SetRow | undefined;
  return row ? { ...meta(row), values: loadValues(db, row.id) } : null;
}

export function listAssumptionSets(db: Db, assetId: string): Omit<AssumptionSet, 'values'>[] {
  const rows = db.prepare('SELECT * FROM assumption_sets WHERE asset_id = ? ORDER BY version DESC').all(assetId) as SetRow[];
  return rows.map(meta);
}

export function createAssumptionSet(
  db: Db,
  input: { assetId: string; author: string; rationale: string; values: AssumptionValues; createdAt: string },
): AssumptionSet {
  const id = db.transaction(() => {
    const latest = getLatestAssumptionSet(db, input.assetId);
    const version = (latest?.version ?? 0) + 1;
    const info = db
      .prepare('INSERT INTO assumption_sets (asset_id, version, parent_version, author, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.assetId, version, latest?.version ?? null, input.author, input.rationale, new Date(input.createdAt).toISOString());
    const setId = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO assumptions (set_id, key, scenario, value) VALUES (?, ?, ?, ?)');
    for (const s of SCENARIOS) {
      for (const [key, value] of Object.entries(input.values[s])) insert.run(setId, key, s, value);
    }
    return setId;
  })();
  return getAssumptionSetById(db, id)!;
}
```

The store does not validate. Callers validate with `validateAssumptions` before calling `createAssumptionSet`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/engine/requirements.test.ts tests/db/assumptions.test.ts && npm run typecheck`
Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/requirements.ts src/db/assumptions.ts tests/engine/requirements.test.ts tests/db/assumptions.test.ts
git commit -m "feat: add assumption requirements, validation, and versioned store"
```

---

### Task 10: runEngine (fixed point, blend, total return)

**Files:**
- Create: `src/engine/run.ts`
- Test: `tests/engine/run.test.ts`

**Interfaces:**
- Consumes: `forecastSupply`, `emissionsBetween` (Task 6); `getModule`, `ModuleResult` (Task 7); `need`; `EngineError`; `ENGINE_VERSION`; `Drivers`; `AssetConfig`; `SCENARIOS`, `HORIZONS`, `HORIZON_YEARS`.
- Produces:

```ts
export interface EngineInput { asset: AssetConfig; drivers: Drivers; assumptions: AssumptionValues }
export interface ScenarioOutput {
  target: number; probability: number; supplyAtHorizon: number; stakingYield: number;
  iterations: number; converged: boolean; dispersion: number; modules: Record<string, ModuleResult>;
}
export interface ModuleSummary {
  type: string; kind: ModuleKind; weight: number | null;
  value: number;                          // probability-weighted across scenarios
  byScenario: Record<Scenario, number>;
  breakdown: Record<string, unknown>;     // base scenario breakdown
}
export interface HorizonOutput {
  expectedTarget: number; upsidePct: number;
  scenarios: Record<Scenario, ScenarioOutput>;
  modules: Record<string, ModuleSummary>;
  dispersion: number;                     // on probability-weighted estimate values
  stakedTotalReturnPct: number;
  extras: Record<string, number>;
}
export interface EngineOutput { engineVersion: string; asOf: string; spot: number; converged: boolean; horizons: Record<Horizon, HorizonOutput> }
export function runEngine(input: EngineInput): EngineOutput
```

Algorithm per horizon and scenario (max 20 iterations, tolerance 0.001):
1. `target = spot`.
2. `S = forecastSupply(target)`; `y = avgEmission * staker_share / (staked_ratio_horizon * S)` where `avgEmission = emissionsBetween(0, H) / H`.
3. Compute every module with `priceAtHorizon = target`. `next = max(0, sum(weight_i * estimate_i) + sum(component_j))`.
4. If `|next - target| / max(|target|, 1e-12) < 0.001` then converged. Set `target = next` either way.

Aggregates: `expectedTarget = sum(p_s * target_s)`; dispersion `= (max - min of estimates) / sum(w_i * estimate_i)`, or 0 when that sum is not positive; `stakedTotalReturnPct = ((expected / spot) * (1 + y_exp)^H - 1) * 100` with `y_exp = sum(p_s * y_s)`; each total-return variant uses `y_exp * drivers.extra[metric].value` and is emitted in `extras` under the variant id.

- [ ] **Step 1: Write the failing test** `tests/engine/run.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { parseAssetYaml } from '../../src/config/load.js';
import { computeDrivers } from '../../src/drivers/compute.js';
import { runEngine } from '../../src/engine/run.js';
import { ENGINE_VERSION } from '../../src/engine/version.js';
import { canonicalJson } from '../../src/util/canonical.js';
import { MINI_ASSET_YAML, miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, type MiniOverrides } from '../helpers/obs.js';

function run(obsOver: MiniOverrides = {}, assumeOver: Partial<Record<string, number>> = {}, asset = miniAsset()) {
  const drivers = computeDrivers(asset, miniObservations(obsOver), AS_OF).drivers!;
  return runEngine({ asset, drivers, assumptions: miniAssumptions(assumeOver) });
}

describe('runEngine', () => {
  it('values the flat mini asset at its perpetuity value in every scenario', () => {
    const out = run();
    expect(out.engineVersion).toBe(ENGINE_VERSION);
    expect(out.converged).toBe(true);
    const h = out.horizons['12m'];
    expect(h.expectedTarget).toBeCloseTo(10, 6);
    expect(h.upsidePct).toBeCloseTo(0, 4);
    expect(h.scenarios.base.supplyAtHorizon).toBeCloseTo(100, 9);
    expect(h.modules.hc.value).toBeCloseTo(10, 6);
    expect(h.dispersion).toBe(0);
    expect(h.stakedTotalReturnPct).toBeCloseTo(0, 4);
  });

  it('is deterministic', () => {
    expect(canonicalJson(run())).toBe(canonicalJson(run()));
  });

  it('lowers the per-token target when emissions rise', () => {
    const diluted = run({ emission: 10 }).horizons['12m'];
    expect(diluted.expectedTarget).toBeCloseTo(1000 / 110, 6);
    // staker APR = 10 / (0.5 * 110); total return = (target/spot) * (1 + y) - 1
    const y = 10 / (0.5 * 110);
    expect(diluted.stakedTotalReturnPct).toBeCloseTo(((1000 / 110 / 10) * (1 + y) - 1) * 100, 6);
  });

  it('raises the target when growth rises', () => {
    expect(run({}, { rev_growth_y1: 0.5 }).horizons['12m'].expectedTarget).toBeGreaterThan(10);
  });

  it('weights scenarios by probability', () => {
    const asset = miniAsset();
    const drivers = computeDrivers(asset, miniObservations(), AS_OF).drivers!;
    const values = miniAssumptions();
    values.bull.discount_rate_base = 0.05; // bull target = 100 / 0.05 / 100 = 20
    const h = runEngine({ asset, drivers, assumptions: values }).horizons['12m'];
    expect(h.scenarios.bull.target).toBeCloseTo(20, 6);
    expect(h.expectedTarget).toBeCloseTo(0.25 * 10 + 0.5 * 10 + 0.25 * 20, 6);
  });

  it('converges on a burn asset where supply depends on the target', () => {
    const asset = miniAsset();
    asset.holder_flows[0].kind = 'burn';
    const out = run({ price: 1, revenue: 12000, supply: 100000, staked: 50000, flowAnnual: 1200 }, {}, asset);
    const s = out.horizons['12m'].scenarios.base;
    expect(s.converged).toBe(true);
    expect(s.iterations).toBeGreaterThan(1);
    expect(s.supplyAtHorizon).toBeLessThan(100000);
  });

  it('blends two estimates, reports dispersion, and leaves holder_cashflow value untouched by regime', () => {
    const yaml = MINI_ASSET_YAML
      .replace('  - { id: hc, type: holder_cashflow, kind: estimate, weight: 1 }',
        '  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.5 }\n  - { id: fm, type: forward_multiple, kind: estimate, weight: 0.5, params: { basis: revenue } }')
      .replace('assumptions:', 'assumptions:\n  multiple.fm: { min: 0, max: 100 }\n  regime_multiplier: { min: 0.1, max: 3 }');
    const asset = parseAssetYaml(yaml).config;
    const lo = run({}, { 'multiple.fm': 2, regime_multiplier: 1 }, asset).horizons['12m'];
    // hc = 10, fm = 1000 * 2 * 1 / 100 = 20 -> blend 15, dispersion (20 - 10) / 15
    expect(lo.expectedTarget).toBeCloseTo(15, 6);
    expect(lo.dispersion).toBeCloseTo(10 / 15, 6);
    const hi = run({}, { 'multiple.fm': 2, regime_multiplier: 2 }, asset).horizons['12m'];
    expect(hi.modules.fm.value).toBeCloseTo(40, 6);
    expect(hi.modules.hc.breakdown.aggregate_pv_usd).toBeCloseTo(lo.modules.hc.breakdown.aggregate_pv_usd as number, 6);
  });

  it('emits total-return variants in extras', () => {
    const yaml = MINI_ASSET_YAML
      .replace('holder_flows:', '  lock_share: { type: level, unit: ratio, staleness_days: 90 }\nholder_flows:')
      + '\ntotal_return_variants:\n  - { id: locked_total_return_pct, yield_multiplier_metric: lock_share }\n';
    const asset = parseAssetYaml(yaml).config;
    const list = [...miniObservations({ emission: 10 })];
    list.push({ ...list[0], id: 9999, metricKey: 'lock_share', value: 0.8 });
    const drivers = computeDrivers(asset, list, AS_OF).drivers!;
    const h = runEngine({ asset, drivers, assumptions: miniAssumptions() }).horizons['12m'];
    const y = (10 / (0.5 * 110)) * 0.8;
    expect(h.extras.locked_total_return_pct).toBeCloseTo(((1000 / 110 / 10) * (1 + y) - 1) * 100, 6);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/engine/run.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/engine/run.ts`**

```ts
import type { AssetConfig, ModuleInstanceDef, ModuleKind } from '../config/schema.js';
import type { Drivers } from '../drivers/compute.js';
import {
  HORIZON_YEARS, HORIZONS, SCENARIOS, type AssumptionValues, type Horizon, type Scenario, type ScenarioAssumptions,
} from '../types.js';
import { EngineError } from './errors.js';
import { getModule } from './modules/registry.js';
import type { ModuleResult, ValuationModule } from './modules/types.js';
import { need } from './paths.js';
import { emissionsBetween, forecastSupply } from './supply.js';
import { ENGINE_VERSION } from './version.js';

const MAX_ITERATIONS = 20;
const TOLERANCE = 0.001;

export interface EngineInput {
  asset: AssetConfig;
  drivers: Drivers;
  assumptions: AssumptionValues;
}
export interface ScenarioOutput {
  target: number;
  probability: number;
  supplyAtHorizon: number;
  stakingYield: number;
  iterations: number;
  converged: boolean;
  dispersion: number;
  modules: Record<string, ModuleResult>;
}
export interface ModuleSummary {
  type: string;
  kind: ModuleKind;
  weight: number | null;
  value: number;
  byScenario: Record<Scenario, number>;
  breakdown: Record<string, unknown>;
}
export interface HorizonOutput {
  expectedTarget: number;
  upsidePct: number;
  scenarios: Record<Scenario, ScenarioOutput>;
  modules: Record<string, ModuleSummary>;
  dispersion: number;
  stakedTotalReturnPct: number;
  extras: Record<string, number>;
}
export interface EngineOutput {
  engineVersion: string;
  asOf: string;
  spot: number;
  converged: boolean;
  horizons: Record<Horizon, HorizonOutput>;
}

interface Instance {
  def: ModuleInstanceDef;
  impl: ValuationModule;
}

function dispersionOf(estimates: { weight: number; value: number }[]): number {
  if (estimates.length === 0) return 0;
  const blended = estimates.reduce((s, e) => s + e.weight * e.value, 0);
  if (!(blended > 0)) return 0;
  const values = estimates.map((e) => e.value);
  return (Math.max(...values) - Math.min(...values)) / blended;
}

function solveScenario(
  asset: AssetConfig,
  drivers: Drivers,
  a: ScenarioAssumptions,
  H: number,
  instances: Instance[],
  probability: number,
): ScenarioOutput {
  const stakedRatio = need(a, 'staked_ratio_horizon');
  if (!(stakedRatio > 0)) throw new EngineError('staked_ratio_horizon must be positive');
  const avgEmission = emissionsBetween(drivers.emissionSchedule, drivers.asOf, 0, H) / H;

  let target = drivers.price.value;
  let supply = 0;
  let stakingYield = 0;
  let modules: Record<string, ModuleResult> = {};
  let iterations = 0;
  let converged = false;

  while (iterations < MAX_ITERATIONS && !converged) {
    iterations++;
    supply = forecastSupply({ asset, drivers, assumptions: a, horizonYears: H, targetPrice: target });
    stakingYield = (avgEmission * drivers.stakerEmissionShare.value) / (stakedRatio * supply);
    modules = {};
    let next = 0;
    for (const { def, impl } of instances) {
      const result = impl.compute({
        instanceId: def.id,
        params: def.params,
        drivers,
        assumptions: a,
        horizonYears: H,
        supplyAtHorizon: supply,
        priceAtHorizon: target,
        stakingYieldAtHorizon: stakingYield,
      });
      if (!Number.isFinite(result.valuePerToken)) throw new EngineError(`module ${def.id} returned a non-finite value`);
      modules[def.id] = result;
      next += def.kind === 'estimate' ? (def.weight ?? 0) * result.valuePerToken : result.valuePerToken;
    }
    next = Math.max(0, next);
    converged = Math.abs(next - target) / Math.max(Math.abs(target), 1e-12) < TOLERANCE;
    target = next;
  }

  const estimates = instances
    .filter((i) => i.def.kind === 'estimate')
    .map((i) => ({ weight: i.def.weight ?? 0, value: modules[i.def.id].valuePerToken }));

  return { target, probability, supplyAtHorizon: supply, stakingYield, iterations, converged, dispersion: dispersionOf(estimates), modules };
}

export function runEngine(input: EngineInput): EngineOutput {
  const { asset, drivers, assumptions } = input;
  const spot = drivers.price.value;
  if (!(spot > 0)) throw new EngineError('spot price must be positive');
  const instances: Instance[] = asset.modules.map((def) => ({ def, impl: getModule(def.type) }));
  const probs = asset.scenario_probabilities;

  const horizons = {} as Record<Horizon, HorizonOutput>;
  let allConverged = true;

  for (const h of HORIZONS) {
    const H = HORIZON_YEARS[h];
    const scenarios = {} as Record<Scenario, ScenarioOutput>;
    for (const s of SCENARIOS) {
      scenarios[s] = solveScenario(asset, drivers, assumptions[s], H, instances, probs[s]);
      if (!scenarios[s].converged) allConverged = false;
    }

    const expectedTarget = SCENARIOS.reduce((sum, s) => sum + probs[s] * scenarios[s].target, 0);
    const expectedYield = SCENARIOS.reduce((sum, s) => sum + probs[s] * scenarios[s].stakingYield, 0);

    const modules: Record<string, ModuleSummary> = {};
    for (const { def } of instances) {
      const byScenario = {} as Record<Scenario, number>;
      for (const s of SCENARIOS) byScenario[s] = scenarios[s].modules[def.id].valuePerToken;
      modules[def.id] = {
        type: def.type,
        kind: def.kind,
        weight: def.kind === 'estimate' ? (def.weight ?? 0) : null,
        value: SCENARIOS.reduce((sum, s) => sum + probs[s] * byScenario[s], 0),
        byScenario,
        breakdown: scenarios.base.modules[def.id].breakdown,
      };
    }

    const totalReturn = (multiplier: number) =>
      ((expectedTarget / spot) * Math.pow(1 + expectedYield * multiplier, H) - 1) * 100;

    const extras: Record<string, number> = {};
    for (const v of asset.total_return_variants) {
      const m = drivers.extra[v.yield_multiplier_metric];
      if (!m) throw new EngineError(`total return variant ${v.id} needs extra driver "${v.yield_multiplier_metric}"`);
      extras[v.id] = totalReturn(m.value);
    }

    horizons[h] = {
      expectedTarget,
      upsidePct: (expectedTarget / spot - 1) * 100,
      scenarios,
      modules,
      dispersion: dispersionOf(
        instances.filter((i) => i.def.kind === 'estimate').map((i) => ({ weight: i.def.weight ?? 0, value: modules[i.def.id].value })),
      ),
      stakedTotalReturnPct: totalReturn(1),
      extras,
    };
  }

  return { engineVersion: ENGINE_VERSION, asOf: drivers.asOf, spot, converged: allConverged, horizons };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/engine && npm run typecheck`
Expected: all PASS (8 new).

- [ ] **Step 5: Confirm engine purity**

Run: `grep -rnE "Date\.now|new Date\(\)|Math\.random|from 'node:fs'|better-sqlite3" src/engine src/drivers`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/engine/run.ts tests/engine/run.test.ts
git commit -m "feat: add engine with fixed-point supply, blending, and total return"
```

---

### Task 11: HYPE and AERO contrast fixtures

Proves the spec's generality claim: both assets are expressed with config over the two shared modules, with no custom code. All numbers are synthetic and chosen for round arithmetic. They are not market data.

**Files:**
- Create: `tests/fixtures/hype.yaml`, `tests/fixtures/aero.yaml`, `tests/fixtures/contrast.ts`
- Test: `tests/engine/contrast.test.ts`

**Interfaces:**
- Consumes: `parseAssetYaml`, `computeDrivers`, `runEngine`, `validateAssetModules`, `validateAssumptions`, test helper `obs`.
- Produces (test-only): `loadFixture(name: 'hype' | 'aero'): AssetConfig`, `hypeObservations()`, `aeroObservations()`, `hypeAssumptions()`, `aeroAssumptions()`.

- [ ] **Step 1: Write `tests/fixtures/hype.yaml`** (programmatic buyback, capture near 100 percent, circulating basis with scheduled unlocks)

```yaml
id: hype
symbol: HYPE
name: Hyperliquid (synthetic fixture)
supply_basis: circulating
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 7, critical: true }
  effective_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  circulating_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  scheduled_unlock_tokens: { type: event, unit: tokens, staleness_days: 400 }
  flow_usd.buyback: { type: flow, unit: usd, staleness_days: 7, critical: true }
holder_flows:
  - { id: buyback, kind: buy_and_hold, capture_rule: programmatic, recipient_base: all, metric: flow_usd.buyback }
modules:
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.5 }
  - { id: fm_flow, type: forward_multiple, kind: estimate, weight: 0.5, params: { basis: holder_flow } }
assumptions:
  rev_growth_y1: { min: -0.5, max: 3 }
  growth_fade_years: { min: 0, max: 10 }
  terminal_growth: { min: 0, max: 0.05 }
  capture_rate_terminal.buyback: { min: 0, max: 1 }
  capture_ramp_years.buyback: { min: 0, max: 10 }
  discount_rate_base: { min: 0.05, max: 0.5 }
  discount_premium_programmatic: { min: 0, max: 0.2 }
  multiple.fm_flow: { min: 1, max: 100 }
  regime_multiplier: { min: 0.2, max: 3 }
  staked_ratio_horizon: { min: 0.05, max: 0.95 }
```

- [ ] **Step 2: Write `tests/fixtures/aero.yaml`** (fee share to lockers, heavy emissions)

```yaml
id: aero
symbol: AERO
name: Aerodrome (synthetic fixture)
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 7, critical: true }
  effective_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  locked_supply: { type: level, unit: tokens, staleness_days: 7 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, staleness_days: 400 }
  flow_usd.fees: { type: flow, unit: usd, staleness_days: 7, critical: true }
holder_flows:
  - { id: fees, kind: fee_share, capture_rule: contractual, recipient_base: locked, metric: flow_usd.fees }
modules:
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.6 }
  - { id: fm_flow, type: forward_multiple, kind: estimate, weight: 0.4, params: { basis: holder_flow } }
assumptions:
  rev_growth_y1: { min: -0.5, max: 3 }
  growth_fade_years: { min: 0, max: 10 }
  terminal_growth: { min: 0, max: 0.05 }
  capture_rate_terminal.fees: { min: 0, max: 1 }
  capture_ramp_years.fees: { min: 0, max: 10 }
  discount_rate_base: { min: 0.05, max: 0.5 }
  multiple.fm_flow: { min: 1, max: 100 }
  regime_multiplier: { min: 0.2, max: 3 }
  staked_ratio_horizon: { min: 0.05, max: 0.95 }
```

- [ ] **Step 3: Write `tests/fixtures/contrast.ts`**

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAssetYaml } from '../../src/config/load.js';
import type { AssetConfig } from '../../src/config/schema.js';
import type { Observation } from '../../src/db/observations.js';
import type { AssumptionValues } from '../../src/types.js';
import { AS_OF, obs } from '../helpers/obs.js';

export function loadFixture(name: 'hype' | 'aero'): AssetConfig {
  const path = fileURLToPath(new URL(`./${name}.yaml`, import.meta.url));
  return parseAssetYaml(readFileSync(path, 'utf8')).config;
}

const flow = (assetId: string, metric: string, annual: number): Observation =>
  obs(metric, (annual * 90) / 365, AS_OF, { assetId, periodDays: 90 });
const at = (assetId: string, metric: string, value: number, when = '2026-06-29'): Observation =>
  obs(metric, value, when, { assetId });

/** Revenue 1000, buyback 970 per year (capture 0.97), price 10, circulating 300 of 1000, unlock of 100 in 3 months. */
export function hypeObservations(unlockTokens = 100): Observation[] {
  return [
    at('hype', 'price_usd', 10),
    at('hype', 'revenue_run_rate_usd', 1000),
    at('hype', 'effective_supply', 1000),
    at('hype', 'circulating_supply', 300),
    at('hype', 'staked_supply', 400),
    at('hype', 'staker_emission_share', 1),
    obs('emission_rate_annual', 0, '2026-01-01', { assetId: 'hype', fetchedAt: '2026-06-29T00:00:00.000Z' }),
    obs('scheduled_unlock_tokens', unlockTokens, '2026-09-30', { assetId: 'hype', fetchedAt: '2026-06-29T00:00:00.000Z' }),
    flow('hype', 'flow_usd.buyback', 970),
  ];
}

/** Revenue 1000, all of it to lockers (capture 1.0), supply 1000, emissions 200 per year (20 percent inflation). */
export function aeroObservations(emission = 200): Observation[] {
  return [
    at('aero', 'price_usd', 5),
    at('aero', 'revenue_run_rate_usd', 1000),
    at('aero', 'effective_supply', 1000),
    at('aero', 'staked_supply', 500),
    at('aero', 'locked_supply', 500),
    at('aero', 'staker_emission_share', 1),
    obs('emission_rate_annual', emission, '2026-01-01', { assetId: 'aero', fetchedAt: '2026-06-29T00:00:00.000Z' }),
    flow('aero', 'flow_usd.fees', 1000),
  ];
}

const same = (one: Record<string, number>): AssumptionValues => ({ bear: { ...one }, base: { ...one }, bull: { ...one } });

export function hypeAssumptions(): AssumptionValues {
  return same({
    rev_growth_y1: 0, growth_fade_years: 1, terminal_growth: 0,
    'capture_rate_terminal.buyback': 0.97, 'capture_ramp_years.buyback': 0,
    discount_rate_base: 0.1, discount_premium_programmatic: 0.05,
    'multiple.fm_flow': 10, regime_multiplier: 1, staked_ratio_horizon: 0.4,
  });
}

export function aeroAssumptions(): AssumptionValues {
  return same({
    rev_growth_y1: 0, growth_fade_years: 1, terminal_growth: 0,
    'capture_rate_terminal.fees': 1, 'capture_ramp_years.fees': 0,
    discount_rate_base: 0.2, 'multiple.fm_flow': 5, regime_multiplier: 1, staked_ratio_horizon: 0.5,
  });
}
```

- [ ] **Step 4: Write the test** `tests/engine/contrast.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { computeDrivers } from '../../src/drivers/compute.js';
import { validateAssetModules, validateAssumptions } from '../../src/engine/requirements.js';
import { runEngine } from '../../src/engine/run.js';
import {
  aeroAssumptions, aeroObservations, hypeAssumptions, hypeObservations, loadFixture,
} from '../fixtures/contrast.js';
import { AS_OF } from '../helpers/obs.js';

const SHARED = ['holder_cashflow', 'forward_multiple'];

describe('contrast assets are expressible as config only', () => {
  it.each(['hype', 'aero'] as const)('%s uses only shared modules and validates cleanly', (name) => {
    const asset = loadFixture(name);
    expect(asset.modules.every((m) => SHARED.includes(m.type))).toBe(true);
    expect(validateAssetModules(asset)).toEqual([]);
    expect(validateAssumptions(asset, name === 'hype' ? hypeAssumptions() : aeroAssumptions())).toEqual([]);
  });
});

describe('HYPE fixture', () => {
  const asset = loadFixture('hype');
  const target = (unlock: number) => {
    const drivers = computeDrivers(asset, hypeObservations(unlock), AS_OF).drivers!;
    return runEngine({ asset, drivers, assumptions: hypeAssumptions() }).horizons['6m'];
  };

  it('converges and reports a programmatic capture rate near 100 percent', () => {
    const drivers = computeDrivers(asset, hypeObservations(), AS_OF).drivers!;
    expect(drivers.captureRate).toBeCloseTo(0.97, 9);
    expect(drivers.holderFlows[0].captureRule).toBe('programmatic');
    const out = runEngine({ asset, drivers, assumptions: hypeAssumptions() });
    expect(out.converged).toBe(true);
    expect(out.horizons['12m'].expectedTarget).toBeGreaterThan(0);
  });

  it('scheduled unlocks dilute the per-token target on the circulating basis', () => {
    expect(target(100).expectedTarget).toBeLessThan(target(0).expectedTarget);
  });

  it('buy-and-hold purchases shrink circulating supply', () => {
    const s = target(0).scenarios.base;
    expect(s.supplyAtHorizon).toBeLessThan(300);
  });
});

describe('AERO fixture', () => {
  const asset = loadFixture('aero');
  const run = (emission: number) => {
    const drivers = computeDrivers(asset, aeroObservations(emission), AS_OF).drivers!;
    return runEngine({ asset, drivers, assumptions: aeroAssumptions() }).horizons['12m'];
  };

  it('records the locked recipient base in the breakdown', () => {
    const flows = run(200).modules.hc.breakdown.flows as Record<string, { recipient_base: string }>;
    expect(flows.fees.recipient_base).toBe('locked');
  });

  it('heavy emissions dilute the target but lift staker total return above price return', () => {
    const heavy = run(200);
    const none = run(0);
    expect(heavy.expectedTarget).toBeLessThan(none.expectedTarget);
    // flat fees of 1000: hc = 1000/0.2 = 5000, fm = 1000*5 = 5000, both over supply 1200
    expect(heavy.expectedTarget).toBeCloseTo(5000 / 1200, 6);
    expect(heavy.stakedTotalReturnPct).toBeGreaterThan(heavy.upsidePct);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/engine/contrast.test.ts && npm run typecheck`
Expected: 7 tests PASS. No `src/` change is needed. If either fixture needs a `src/` change to pass, stop and report it: that is a finding against the spec's config-only claim, not something to patch around.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures tests/engine/contrast.test.ts
git commit -m "test: add HYPE and AERO contrast fixtures proving config-only assets"
```

---

### Task 12: Signal schema, data-quality grade, and builder

**Files:**
- Create: `src/signals/schema.ts`, `src/signals/quality.ts`, `src/signals/build.ts`, `src/signals/emit.ts`
- Test: `tests/signals/build.test.ts`

**Interfaces:**
- Consumes: `EngineOutput` (Task 10); `DriverReport` (Task 5); `AssetConfig`; `SCENARIOS`.
- Produces:
  - `SignalSchema` (zod), `type Signal = z.infer<typeof SignalSchema>`
  - `gradeDataQuality(report: DriverReport): 'A' | 'B' | 'C' | 'D'`
  - `interface BuildSignalInput { signalId: string; asset: AssetConfig; generatedAt: string; report: DriverReport; engine: EngineOutput | null; blockedReasons: string[]; change: Signal['change']; provenance: Signal['provenance']; spotFallback?: { price: number; ts: string } | null }`
  - `buildSignal(input: BuildSignalInput): Signal` (validates against `SignalSchema` before returning)
  - `emitSignal(signal: Signal, opts: { write: (line: string) => void; outFile?: string }): void`

Rules:
- Grade: `D` when any critical metric is stale; else `C` when any metric is provisional or stale; else `B` when any used metric is manual; else `A`. `open_anomalies` is always `0` in sub-project 1 (anomalies arrive with ingestion).
- Status: `blocked` when `engine` is null (horizons omitted, `status_reasons = blockedReasons`); `degraded` when grade is `D` (`reason: stale_critical:<metric>` per metric) or `engine.converged` is false (`reason: supply_forecast_not_converged`); otherwise `ok`.
- `spot` is null only when the price driver is missing.
- Each signal module's `breakdown` is the base-scenario breakdown plus a `by_scenario` map of per-scenario values.

- [ ] **Step 1: Write the failing test** `tests/signals/build.test.ts`

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDrivers } from '../../src/drivers/compute.js';
import { latestLevel } from '../../src/drivers/select.js';
import { runEngine } from '../../src/engine/run.js';
import { buildSignal, type BuildSignalInput } from '../../src/signals/build.js';
import { emitSignal } from '../../src/signals/emit.js';
import { gradeDataQuality } from '../../src/signals/quality.js';
import { SignalSchema } from '../../src/signals/schema.js';
import { miniAsset, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations, obs } from '../helpers/obs.js';

function input(list = miniObservations()): BuildSignalInput {
  const asset = miniAsset();
  const report = computeDrivers(asset, list, AS_OF);
  const engine = report.drivers ? runEngine({ asset, drivers: report.drivers, assumptions: miniAssumptions() }) : null;
  const p = latestLevel(list.filter((o) => o.metricKey === 'price_usd'), AS_OF);
  return {
    spotFallback: p ? { price: p.value, ts: p.observedAt } : null,
    signalId: 'mini-test-1', asset, generatedAt: AS_OF, report, engine,
    blockedReasons: engine ? [] : report.missing.map((m) => `missing_metric:${m}`),
    change: { prev_signal_id: null, target_delta_pct: null, cause: 'none', rationale: '' },
    provenance: { run_id: 1, snapshot_id: 1, assumption_set_version: 1, engine_version: '1.0.0', config_hash: 'abc' },
  };
}

describe('gradeDataQuality', () => {
  const asset = miniAsset();
  it('grades A for fresh on-chain data', () => {
    expect(gradeDataQuality(computeDrivers(asset, miniObservations(), AS_OF))).toBe('A');
  });
  it('grades B when a manual metric is used', () => {
    const list = [...miniObservations(), obs('staked_supply', 50, '2026-06-29T12:00:00Z', { source: 'manual' })];
    expect(gradeDataQuality(computeDrivers(asset, list, AS_OF))).toBe('B');
  });
  it('grades C for provisional data', () => {
    const list = [...miniObservations(), obs('revenue_run_rate_usd', 1000, '2026-06-20', { status: 'provisional' })];
    expect(gradeDataQuality(computeDrivers(asset, list, AS_OF))).toBe('C');
  });
  it('grades D when a critical metric is stale', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'price_usd');
    list.push(obs('price_usd', 10, '2026-06-01'));
    expect(gradeDataQuality(computeDrivers(asset, list, AS_OF))).toBe('D');
  });
});

describe('buildSignal', () => {
  it('builds a schema-valid ok signal', () => {
    const s = buildSignal(input());
    expect(SignalSchema.safeParse(s).success).toBe(true);
    expect(s.status).toBe('ok');
    expect(s.schema_version).toBe(1);
    expect(s.horizons!['12m'].expected_target).toBeCloseTo(10, 6);
    expect(s.horizons!['12m'].scenarios.base.probability).toBe(0.5);
    expect(s.horizons!['12m'].modules.hc.breakdown.by_scenario).toEqual({ bear: expect.any(Number), base: expect.any(Number), bull: expect.any(Number) });
    expect(s.data_quality.grade).toBe('A');
    expect(s.spot).toEqual({ price: 10, ts: '2026-06-29T00:00:00.000Z' });
  });

  it('emits a blocked signal without horizons when a driver is missing', () => {
    const s = buildSignal(input(miniObservations().filter((o) => o.metricKey !== 'effective_supply')));
    expect(s.status).toBe('blocked');
    expect(s.horizons).toBeUndefined();
    expect(s.status_reasons).toEqual(['missing_metric:effective_supply']);
    expect(s.spot).not.toBeNull();
  });

  it('degrades when a critical metric is stale', () => {
    const list = miniObservations().filter((o) => o.metricKey !== 'price_usd');
    list.push(obs('price_usd', 10, '2026-06-01'));
    const s = buildSignal(input(list));
    expect(s.status).toBe('degraded');
    expect(s.status_reasons).toContain('stale_critical:price_usd');
    expect(s.horizons).toBeDefined();
  });
});

describe('emitSignal', () => {
  it('writes one JSON line and appends to the JSONL file', () => {
    const lines: string[] = [];
    const out = join(mkdtempSync(join(tmpdir(), 'orion-')), 'signals.jsonl');
    const s = buildSignal(input());
    emitSignal(s, { write: (l) => lines.push(l), outFile: out });
    emitSignal(s, { write: (l) => lines.push(l), outFile: out });
    expect(JSON.parse(lines[0]).signal_id).toBe('mini-test-1');
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/signals/build.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/signals/schema.ts`**

```ts
import { z } from 'zod';

const ScenarioSchema = z.strictObject({ target: z.number(), probability: z.number() });

const ModuleSchema = z.strictObject({
  type: z.string(),
  kind: z.enum(['estimate', 'component']),
  weight: z.number().nullable(),
  value: z.number(),
  breakdown: z.record(z.string(), z.unknown()),
});

const HorizonSchema = z.strictObject({
  expected_target: z.number(),
  upside_pct: z.number(),
  scenarios: z.strictObject({ bear: ScenarioSchema, base: ScenarioSchema, bull: ScenarioSchema }),
  modules: z.record(z.string(), ModuleSchema),
  dispersion: z.number(),
  staked_total_return_pct: z.number(),
  extras: z.record(z.string(), z.number()),
});

export const SignalSchema = z.strictObject({
  schema_version: z.literal(1),
  signal_id: z.string(),
  asset: z.string(),
  generated_at: z.string(),
  status: z.enum(['ok', 'degraded', 'blocked']),
  status_reasons: z.array(z.string()),
  spot: z.strictObject({ price: z.number(), ts: z.string() }).nullable(),
  horizons: z.strictObject({ '6m': HorizonSchema, '12m': HorizonSchema }).optional(),
  data_quality: z.strictObject({
    grade: z.enum(['A', 'B', 'C', 'D']),
    stale_metrics: z.array(z.string()),
    provisional_metrics: z.array(z.string()),
    open_anomalies: z.number().int().nonnegative(),
  }),
  change: z.strictObject({
    prev_signal_id: z.string().nullable(),
    target_delta_pct: z.number().nullable(),
    cause: z.enum(['data', 'assumptions', 'both', 'none']),
    rationale: z.string(),
  }),
  provenance: z.strictObject({
    run_id: z.number().int(),
    snapshot_id: z.number().int(),
    assumption_set_version: z.number().int().nullable(),
    engine_version: z.string(),
    config_hash: z.string(),
  }),
});

export type Signal = z.infer<typeof SignalSchema>;
```

- [ ] **Step 4: Write `src/signals/quality.ts`**

```ts
import type { DriverReport } from '../drivers/compute.js';

export type Grade = 'A' | 'B' | 'C' | 'D';

export function gradeDataQuality(report: DriverReport): Grade {
  if (report.staleCritical.length > 0) return 'D';
  if (report.provisionalMetrics.length > 0 || report.staleMetrics.length > 0) return 'C';
  if (report.manualMetrics.length > 0) return 'B';
  return 'A';
}
```

- [ ] **Step 5: Write `src/signals/build.ts`**

```ts
import type { AssetConfig } from '../config/schema.js';
import type { DriverReport } from '../drivers/compute.js';
import type { EngineOutput, HorizonOutput } from '../engine/run.js';
import { gradeDataQuality } from './quality.js';
import { SignalSchema, type Signal } from './schema.js';

export interface BuildSignalInput {
  signalId: string;
  asset: AssetConfig;
  generatedAt: string;
  report: DriverReport;
  engine: EngineOutput | null;
  blockedReasons: string[];
  change: Signal['change'];
  provenance: Signal['provenance'];
  /** Price observation to report when drivers are null (blocked) but a price exists. */
  spotFallback?: { price: number; ts: string } | null;
}

type SignalHorizon = NonNullable<Signal['horizons']>['6m'];

function toHorizon(h: HorizonOutput): SignalHorizon {
  const modules: SignalHorizon['modules'] = {};
  for (const [id, m] of Object.entries(h.modules)) {
    modules[id] = {
      type: m.type,
      kind: m.kind,
      weight: m.weight,
      value: m.value,
      breakdown: { ...m.breakdown, by_scenario: m.byScenario },
    };
  }
  const scenario = (s: 'bear' | 'base' | 'bull') => ({ target: h.scenarios[s].target, probability: h.scenarios[s].probability });
  return {
    expected_target: h.expectedTarget,
    upside_pct: h.upsidePct,
    scenarios: { bear: scenario('bear'), base: scenario('base'), bull: scenario('bull') },
    modules,
    dispersion: h.dispersion,
    staked_total_return_pct: h.stakedTotalReturnPct,
    extras: h.extras,
  };
}

export function buildSignal(input: BuildSignalInput): Signal {
  const { report, engine } = input;
  const grade = gradeDataQuality(report);

  let status: Signal['status'];
  let reasons: string[];
  if (!engine) {
    status = 'blocked';
    reasons = input.blockedReasons;
  } else {
    reasons = report.staleCritical.map((m) => `stale_critical:${m}`);
    if (!engine.converged) reasons.push('supply_forecast_not_converged');
    status = reasons.length > 0 ? 'degraded' : 'ok';
  }

  const spot = report.drivers
    ? { price: report.drivers.price.value, ts: report.drivers.price.observedAt }
    : (input.spotFallback ?? null);

  return SignalSchema.parse({
    schema_version: 1,
    signal_id: input.signalId,
    asset: input.asset.id,
    generated_at: input.generatedAt,
    status,
    status_reasons: reasons,
    spot,
    ...(engine ? { horizons: { '6m': toHorizon(engine.horizons['6m']), '12m': toHorizon(engine.horizons['12m']) } } : {}),
    data_quality: {
      grade,
      stale_metrics: report.staleMetrics,
      provisional_metrics: report.provisionalMetrics,
      open_anomalies: 0,
    },
    change: input.change,
    provenance: input.provenance,
  });
}
```

`computeDrivers` returns `drivers: null` when any required metric is missing, even if a price exists. The caller passes `spotFallback` (the latest price observation) so a blocked signal can still report spot.

- [ ] **Step 6: Write `src/signals/emit.ts`**

```ts
import { appendFileSync } from 'node:fs';
import type { Signal } from './schema.js';

/** Writes the signal as one JSON line to `write`, and appends the same line to `outFile` when given. */
export function emitSignal(signal: Signal, opts: { write: (line: string) => void; outFile?: string }): void {
  const line = JSON.stringify(signal);
  opts.write(line);
  if (opts.outFile) appendFileSync(opts.outFile, line + '\n', 'utf8');
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/signals && npm run typecheck`
Expected: 8 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/signals tests/signals
git commit -m "feat: add signal schema v1, data-quality grading, and builder"
```

---

### Task 13: Run store and app layer (run, what-if, replay)

**Files:**
- Create: `src/db/runs.ts`, `src/app/valuation.ts`
- Test: `tests/app/valuation.test.ts`

**Interfaces:**
- Consumes: everything above. Key signatures: `listActiveObservations`, `getObservationsByIds`, `insertObservation` (Task 3); `computeDrivers` (Task 5); `latestLevel` (Task 4); `requiredExtraMetrics`, `validateAssumptions` (Task 9); `getLatestAssumptionSet`, `getAssumptionSetById` (Task 9); `runEngine`, `EngineOutput` (Task 10); `buildSignal`, `Signal` (Task 12); `LoadedAsset`, `parseAssetObject` (Task 2); `canonicalJson`; `ENGINE_VERSION`; `EngineError`; `OrionError`.
- Produces (`src/db/runs.ts`):
  - `saveConfigVersion(db, hash: string, assetId: string, config: unknown, nowIso: string): void` (insert or ignore)
  - `getConfigVersion(db, hash): string | null` (content JSON)
  - `createSnapshot(db, assetId, asOf, observationIds: number[], nowIso): number`
  - `getSnapshot(db, id): { id: number; assetId: string; asOf: string; observationIds: number[] } | null`
  - `interface ValuationRunRow { id: number; assetId: string; snapshotId: number; assumptionSetId: number | null; engineVersion: string; configHash: string; status: string; outputJson: string | null; createdAt: string }`
  - `insertValuationRun(db, row: Omit<ValuationRunRow, 'id'>): number`, `getValuationRun(db, id): ValuationRunRow | null`
  - `updateRunStatus(db, runId: number, status: string): void` (the run is inserted as `pending` because the signal id needs the run id; its final status is written once, in the same transaction)
  - `insertSignal(db, runId: number, signal: Signal): void`
  - `getLatestSignal(db, assetId): Signal | null`, `listSignals(db, assetId, limit: number): Signal[]` (newest first)
- Produces (`src/app/valuation.ts`):
  - `runValuation(db: Db, loaded: LoadedAsset, now: Date): { runId: number; signal: Signal }`
  - `whatIf(db: Db, loaded: LoadedAsset, now: Date, overrides: { key: string; value: number; scenario?: Scenario }[]): { blocked: string[] } | { output: EngineOutput }`
  - `replayRun(db: Db, runId: number): { identical: boolean; stored: string; replayed: string }`

Rules:
- Eligible observations for a snapshot: active, metric defined in the asset config, and either `confirmed` or the metric has `allow_provisional: true`.
- `runValuation` is one transaction. Blocked reasons: `missing_metric:<key>`, `no_assumption_set`, `invalid_assumptions:<message>`, `engine_error:<message>`. A blocked run still writes a `valuation_runs` row (`output_json` null) and a `blocked` signal.
- `signal_id = <asset>-<YYYYMMDDTHHMMSSZ>-<runId>`.
- `change`: compared with the previous signal for the asset. `data` changed when the previous snapshot's observation ids differ; `assumptions` changed when the assumption-set version differs. `target_delta_pct` compares 12m expected targets (null if either is absent). `rationale` is the assumption set's rationale when assumptions changed, else `''`.
- `whatIf` persists nothing, skips bounds, and still checks keys and the discount-rate math.
- `replayRun` loads the config from `config_versions`, observations by id (ignoring current status), and the assumption set by id. It throws `OrionError('engine_version_mismatch')` when versions differ and `OrionError('not_replayable')` for blocked runs.

- [ ] **Step 1: Write the failing test** `tests/app/valuation.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { replayRun, runValuation, whatIf } from '../../src/app/valuation.js';
import { parseAssetYaml, type LoadedAsset } from '../../src/config/load.js';
import { createAssumptionSet } from '../../src/db/assumptions.js';
import { openDb, type Db } from '../../src/db/connection.js';
import { insertObservation, rejectObservation } from '../../src/db/observations.js';
import { MINI_ASSET_YAML, miniAssumptions } from '../helpers/assets.js';
import { AS_OF, miniObservations } from '../helpers/obs.js';

const NOW = new Date(AS_OF);
let db: Db;
let loaded: LoadedAsset;

function seedObservations(skip: string[] = []) {
  for (const o of miniObservations()) {
    if (skip.includes(o.metricKey)) continue;
    insertObservation(db, {
      assetId: o.assetId, metricKey: o.metricKey, observedAt: o.observedAt, periodDays: o.periodDays,
      value: o.value, source: o.source, fetchedAt: o.fetchedAt,
    });
  }
}
function seedAssumptions(over: Partial<Record<string, number>> = {}, rationale = 'initial') {
  return createAssumptionSet(db, { assetId: 'mini', author: 'user', rationale, values: miniAssumptions(over), createdAt: AS_OF });
}

beforeEach(() => {
  db = openDb(':memory:');
  loaded = parseAssetYaml(MINI_ASSET_YAML);
});

describe('runValuation', () => {
  it('produces an ok signal and persists the run', () => {
    seedObservations();
    seedAssumptions();
    const { runId, signal } = runValuation(db, loaded, NOW);
    expect(signal.status).toBe('ok');
    expect(signal.signal_id).toBe(`mini-20260630T000000Z-${runId}`);
    expect(signal.horizons!['12m'].expected_target).toBeCloseTo(10, 6);
    expect(signal.provenance.config_hash).toBe(loaded.hash);
    expect(signal.change).toEqual({ prev_signal_id: null, target_delta_pct: null, cause: 'none', rationale: '' });
  });

  it('blocks with reasons when data or assumptions are missing', () => {
    seedObservations(['price_usd']);
    const { signal } = runValuation(db, loaded, NOW);
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons).toEqual(['missing_metric:price_usd', 'no_assumption_set']);
    expect(signal.spot).toBeNull();
  });

  it('blocks when the stored assumptions are out of bounds', () => {
    seedObservations();
    seedAssumptions({ discount_rate_base: 0.9 });
    const { signal } = runValuation(db, loaded, NOW);
    expect(signal.status).toBe('blocked');
    expect(signal.status_reasons[0]).toMatch(/^invalid_assumptions:/);
  });

  it('attributes a target change to assumptions and carries the rationale', () => {
    seedObservations();
    seedAssumptions();
    const first = runValuation(db, loaded, NOW).signal;
    seedAssumptions({ discount_rate_base: 0.2 }, 'higher discount rate');
    const second = runValuation(db, loaded, NOW).signal;
    expect(second.change.prev_signal_id).toBe(first.signal_id);
    expect(second.change.cause).toBe('assumptions');
    expect(second.change.rationale).toBe('higher discount rate');
    expect(second.change.target_delta_pct).toBeCloseTo(-50, 4);
  });

  it('attributes a target change to data', () => {
    seedObservations();
    seedAssumptions();
    runValuation(db, loaded, NOW);
    insertObservation(db, { assetId: 'mini', metricKey: 'effective_supply', observedAt: '2026-06-29T12:00:00Z', value: 200, source: 'onchain', fetchedAt: AS_OF });
    expect(runValuation(db, loaded, NOW).signal.change.cause).toBe('data');
  });

  it('excludes provisional observations unless the metric allows them', () => {
    seedObservations();
    seedAssumptions();
    insertObservation(db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-28', value: 5000, source: 'manual',
      status: 'provisional', citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    expect(runValuation(db, loaded, NOW).signal.data_quality.provisional_metrics).toEqual([]);
    const allowing = parseAssetYaml(
      MINI_ASSET_YAML.replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
        'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, allow_provisional: true }'),
    );
    const s = runValuation(db, allowing, NOW).signal;
    expect(s.data_quality.provisional_metrics).toEqual(['revenue_run_rate_usd']);
    expect(s.data_quality.grade).toBe('C');
  });
});

describe('whatIf', () => {
  it('applies overrides without persisting anything', () => {
    seedObservations();
    seedAssumptions();
    const r = whatIf(db, loaded, NOW, [{ key: 'discount_rate_base', value: 0.05, scenario: 'bull' }]);
    expect('output' in r && r.output.horizons['12m'].scenarios.bull.target).toBeCloseTo(20, 6);
    const n = db.prepare('SELECT COUNT(*) AS n FROM valuation_runs').get() as { n: number };
    expect(n.n).toBe(0);
  });
  it('reports why it cannot run', () => {
    const r = whatIf(db, loaded, NOW, []);
    expect('blocked' in r && r.blocked.length).toBeGreaterThan(0);
  });
});

describe('replayRun', () => {
  it('reproduces a stored run byte for byte, even after data and status changes', () => {
    const allowing = parseAssetYaml(
      MINI_ASSET_YAML.replace('revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true }',
        'revenue_run_rate_usd: { type: level, unit: usd, staleness_days: 60, critical: true, allow_provisional: true }'),
    );
    seedObservations();
    seedAssumptions();
    const provisional = insertObservation(db, {
      assetId: 'mini', metricKey: 'revenue_run_rate_usd', observedAt: '2026-06-28', value: 5000, source: 'manual',
      status: 'provisional', citationUrl: 'https://example.com', fetchedAt: AS_OF,
    });
    const { runId, signal } = runValuation(db, allowing, NOW);
    expect(signal.data_quality.provisional_metrics).toEqual(['revenue_run_rate_usd']);
    // everything below changes live state; none of it may change the replay
    rejectObservation(db, provisional.id);
    insertObservation(db, { assetId: 'mini', metricKey: 'price_usd', observedAt: '2026-06-29T18:00:00Z', value: 99, source: 'onchain', fetchedAt: AS_OF });
    seedAssumptions({ rev_growth_y1: 1 }, 'later change');
    const r = replayRun(db, runId);
    expect(r.identical).toBe(true);
    expect(r.replayed).toBe(r.stored);
  });

  it('refuses to replay a blocked run', () => {
    const { runId } = runValuation(db, loaded, NOW);
    expect(() => replayRun(db, runId)).toThrow(/blocked/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/app/valuation.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/db/runs.ts`**

```ts
import type { Signal } from '../signals/schema.js';
import { canonicalJson } from '../util/canonical.js';
import type { Db } from './connection.js';

export interface ValuationRunRow {
  id: number;
  assetId: string;
  snapshotId: number;
  assumptionSetId: number | null;
  engineVersion: string;
  configHash: string;
  status: string;
  outputJson: string | null;
  createdAt: string;
}

export function saveConfigVersion(db: Db, hash: string, assetId: string, config: unknown, nowIso: string): void {
  db.prepare('INSERT OR IGNORE INTO config_versions (hash, asset_id, content_json, created_at) VALUES (?, ?, ?, ?)').run(
    hash, assetId, canonicalJson(config), nowIso,
  );
}

export function getConfigVersion(db: Db, hash: string): string | null {
  const row = db.prepare('SELECT content_json FROM config_versions WHERE hash = ?').get(hash) as { content_json: string } | undefined;
  return row?.content_json ?? null;
}

export function createSnapshot(db: Db, assetId: string, asOf: string, observationIds: number[], nowIso: string): number {
  const ids = [...observationIds].sort((a, b) => a - b);
  const info = db
    .prepare('INSERT INTO snapshots (asset_id, as_of, observation_ids, created_at) VALUES (?, ?, ?, ?)')
    .run(assetId, asOf, JSON.stringify(ids), nowIso);
  return Number(info.lastInsertRowid);
}

export function getSnapshot(db: Db, id: number): { id: number; assetId: string; asOf: string; observationIds: number[] } | null {
  const row = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as
    | { id: number; asset_id: string; as_of: string; observation_ids: string }
    | undefined;
  return row ? { id: row.id, assetId: row.asset_id, asOf: row.as_of, observationIds: JSON.parse(row.observation_ids) as number[] } : null;
}

export function insertValuationRun(db: Db, row: Omit<ValuationRunRow, 'id'>): number {
  const info = db
    .prepare(
      `INSERT INTO valuation_runs (asset_id, snapshot_id, assumption_set_id, engine_version, config_hash, status, output_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.assetId, row.snapshotId, row.assumptionSetId, row.engineVersion, row.configHash, row.status, row.outputJson, row.createdAt);
  return Number(info.lastInsertRowid);
}

export function updateRunStatus(db: Db, runId: number, status: string): void {
  db.prepare('UPDATE valuation_runs SET status = ? WHERE id = ?').run(status, runId);
}

export function getValuationRun(db: Db, id: number): ValuationRunRow | null {
  const r = db.prepare('SELECT * FROM valuation_runs WHERE id = ?').get(id) as
    | {
        id: number; asset_id: string; snapshot_id: number; assumption_set_id: number | null; engine_version: string;
        config_hash: string; status: string; output_json: string | null; created_at: string;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id, assetId: r.asset_id, snapshotId: r.snapshot_id, assumptionSetId: r.assumption_set_id,
    engineVersion: r.engine_version, configHash: r.config_hash, status: r.status, outputJson: r.output_json, createdAt: r.created_at,
  };
}

export function insertSignal(db: Db, runId: number, signal: Signal): void {
  db.prepare(
    'INSERT INTO signals (signal_id, run_id, asset_id, schema_version, status, payload_json, emitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(signal.signal_id, runId, signal.asset, signal.schema_version, signal.status, JSON.stringify(signal), signal.generated_at);
}

export function listSignals(db: Db, assetId: string, limit: number): Signal[] {
  const rows = db.prepare('SELECT payload_json FROM signals WHERE asset_id = ? ORDER BY id DESC LIMIT ?').all(assetId, limit) as {
    payload_json: string;
  }[];
  return rows.map((r) => JSON.parse(r.payload_json) as Signal);
}

export function getLatestSignal(db: Db, assetId: string): Signal | null {
  return listSignals(db, assetId, 1)[0] ?? null;
}
```

`updateRunStatus` is the one allowed mutation on `valuation_runs`: the run row is inserted before the signal exists (the signal id needs the run id), so its final status (`ok`, `degraded`, `blocked`) is written once, immediately after, inside the same transaction.

- [ ] **Step 4: Write `src/app/valuation.ts`**

```ts
import { parseAssetObject, type LoadedAsset } from '../config/load.js';
import type { AssetConfig } from '../config/schema.js';
import { getAssumptionSetById, getLatestAssumptionSet } from '../db/assumptions.js';
import type { Db } from '../db/connection.js';
import { getObservationsByIds, listActiveObservations, type Observation } from '../db/observations.js';
import {
  createSnapshot, getConfigVersion, getLatestSignal, getSnapshot, getValuationRun, insertSignal, insertValuationRun,
  saveConfigVersion, updateRunStatus,
} from '../db/runs.js';
import { computeDrivers, type Drivers } from '../drivers/compute.js';
import { latestLevel } from '../drivers/select.js';
import { EngineError } from '../engine/errors.js';
import { requiredExtraMetrics, validateAssumptions } from '../engine/requirements.js';
import { runEngine, type EngineOutput } from '../engine/run.js';
import { ENGINE_VERSION } from '../engine/version.js';
import { buildSignal } from '../signals/build.js';
import type { Signal } from '../signals/schema.js';
import { OrionError, SCENARIOS, STD_METRICS, type AssumptionValues, type Scenario } from '../types.js';
import { canonicalJson } from '../util/canonical.js';

function eligibleObservations(db: Db, asset: AssetConfig): Observation[] {
  return listActiveObservations(db, asset.id).filter((o) => {
    const def = asset.metrics[o.metricKey];
    return def !== undefined && (o.status === 'confirmed' || def.allow_provisional);
  });
}

function tryEngine(asset: AssetConfig, drivers: Drivers, values: AssumptionValues): { output: EngineOutput } | { error: string } {
  try {
    return { output: runEngine({ asset, drivers, assumptions: values }) };
  } catch (err) {
    if (err instanceof EngineError) return { error: err.message };
    throw err;
  }
}

function compactStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function runValuation(db: Db, loaded: LoadedAsset, now: Date): { runId: number; signal: Signal } {
  const { config: asset, hash } = loaded;
  const asOf = now.toISOString();

  return db.transaction(() => {
    saveConfigVersion(db, hash, asset.id, asset, asOf);
    const observations = eligibleObservations(db, asset);
    const snapshotId = createSnapshot(db, asset.id, asOf, observations.map((o) => o.id), asOf);
    const report = computeDrivers(asset, observations, asOf, requiredExtraMetrics(asset));
    const set = getLatestAssumptionSet(db, asset.id);

    const reasons: string[] = report.missing.map((m) => `missing_metric:${m}`);
    if (!set) reasons.push('no_assumption_set');
    else reasons.push(...validateAssumptions(asset, set.values).map((e) => `invalid_assumptions:${e}`));

    let engine: EngineOutput | null = null;
    if (reasons.length === 0 && report.drivers && set) {
      const r = tryEngine(asset, report.drivers, set.values);
      if ('output' in r) engine = r.output;
      else reasons.push(`engine_error:${r.error}`);
    }

    const runId = insertValuationRun(db, {
      assetId: asset.id,
      snapshotId,
      assumptionSetId: set?.id ?? null,
      engineVersion: ENGINE_VERSION,
      configHash: hash,
      status: 'pending',
      outputJson: engine ? canonicalJson(engine) : null,
      createdAt: asOf,
    });

    const prev = getLatestSignal(db, asset.id);
    let cause: Signal['change']['cause'] = 'none';
    let delta: number | null = null;
    if (prev) {
      const prevSnapshot = getSnapshot(db, prev.provenance.snapshot_id);
      const dataChanged = JSON.stringify(prevSnapshot?.observationIds ?? []) !== JSON.stringify(observations.map((o) => o.id).sort((a, b) => a - b));
      const assumptionsChanged = prev.provenance.assumption_set_version !== (set?.version ?? null);
      cause = dataChanged && assumptionsChanged ? 'both' : dataChanged ? 'data' : assumptionsChanged ? 'assumptions' : 'none';
      const before = prev.horizons?.['12m'].expected_target;
      const after = engine?.horizons['12m'].expectedTarget;
      if (before !== undefined && after !== undefined && before !== 0) delta = (after / before - 1) * 100;
    }

    const priceObs = latestLevel(observations.filter((o) => o.metricKey === STD_METRICS.price), asOf);
    const signal = buildSignal({
      signalId: `${asset.id}-${compactStamp(asOf)}-${runId}`,
      asset,
      generatedAt: asOf,
      report,
      engine,
      blockedReasons: reasons,
      spotFallback: priceObs ? { price: priceObs.value, ts: priceObs.observedAt } : null,
      change: {
        prev_signal_id: prev?.signal_id ?? null,
        target_delta_pct: delta,
        cause,
        rationale: set && (cause === 'assumptions' || cause === 'both') ? set.rationale : '',
      },
      provenance: {
        run_id: runId,
        snapshot_id: snapshotId,
        assumption_set_version: set?.version ?? null,
        engine_version: ENGINE_VERSION,
        config_hash: hash,
      },
    });

    updateRunStatus(db, runId, signal.status);
    insertSignal(db, runId, signal);
    return { runId, signal };
  })();
}

export function whatIf(
  db: Db,
  loaded: LoadedAsset,
  now: Date,
  overrides: { key: string; value: number; scenario?: Scenario }[],
): { blocked: string[] } | { output: EngineOutput } {
  const asset = loaded.config;
  const asOf = now.toISOString();
  const report = computeDrivers(asset, eligibleObservations(db, asset), asOf, requiredExtraMetrics(asset));
  const set = getLatestAssumptionSet(db, asset.id);
  const blocked = report.missing.map((m) => `missing_metric:${m}`);
  if (!set) blocked.push('no_assumption_set');
  if (!set || !report.drivers) return { blocked };

  const values: AssumptionValues = { bear: { ...set.values.bear }, base: { ...set.values.base }, bull: { ...set.values.bull } };
  for (const o of overrides) {
    for (const s of o.scenario ? [o.scenario] : SCENARIOS) values[s][o.key] = o.value;
  }
  const errors = validateAssumptions(asset, values, { checkBounds: false });
  if (errors.length > 0) return { blocked: errors.map((e) => `invalid_assumptions:${e}`) };

  const r = tryEngine(asset, report.drivers, values);
  return 'output' in r ? { output: r.output } : { blocked: [`engine_error:${r.error}`] };
}

export function replayRun(db: Db, runId: number): { identical: boolean; stored: string; replayed: string } {
  const run = getValuationRun(db, runId);
  if (!run) throw new OrionError('run_not_found', `no valuation run with id ${runId}`);
  if (run.outputJson === null || run.assumptionSetId === null) {
    throw new OrionError('not_replayable', `run ${runId} was blocked and has no engine output to replay`);
  }
  if (run.engineVersion !== ENGINE_VERSION) {
    throw new OrionError('engine_version_mismatch', `run ${runId} used engine ${run.engineVersion}; this build is ${ENGINE_VERSION}`);
  }
  const content = getConfigVersion(db, run.configHash);
  const snapshot = getSnapshot(db, run.snapshotId);
  const set = getAssumptionSetById(db, run.assumptionSetId);
  if (!content || !snapshot || !set) throw new OrionError('not_replayable', `run ${runId} is missing stored inputs`);

  const asset = parseAssetObject(JSON.parse(content)).config;
  const observations = getObservationsByIds(db, snapshot.observationIds);
  const report = computeDrivers(asset, observations, snapshot.asOf, requiredExtraMetrics(asset));
  if (!report.drivers) throw new OrionError('not_replayable', `run ${runId} inputs no longer produce drivers`);
  const replayed = canonicalJson(runEngine({ asset, drivers: report.drivers, assumptions: set.values }));
  return { identical: replayed === run.outputJson, stored: run.outputJson, replayed };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/app && npm run typecheck`
Expected: 10 tests PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: every test file passes.

- [ ] **Step 7: Commit**

```bash
git add src/db/runs.ts src/app tests/app
git commit -m "feat: add run store and app layer with what-if and replay"
```

---

### Task 14: CLI

Commands are thin wrappers: parse arguments, call a library function, print. No valuation logic lives here. Every leaf command takes `--json`. Failures throw `OrionError`; `src/cli/index.ts` prints the message and sets exit code 1.

**Files:**
- Create: `src/cli/util.ts`, `src/cli/program.ts`, `src/cli/index.ts`, `src/cli/commands/init.ts`, `src/cli/commands/asset.ts`, `src/cli/commands/data.ts`, `src/cli/commands/model.ts`, `src/cli/commands/signal.ts`
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `loadAsset`, `listAssetIds` (Task 2); observation store (Task 3); `validateAssetModules`, `validateAssumptions`, `requiredAssumptionKeys` (Task 9); assumption store (Task 9); `runValuation`, `whatIf`, `replayRun` (Task 13); `getLatestSignal`, `listSignals` (Task 13); `emitSignal` (Task 12).
- Produces:
  - `interface CliContext { home: string; stdout: (line: string) => void; now: () => Date }`
  - `buildProgram(ctx: CliContext): Command`
  - Project home is `ORION_HOME` or the current directory. The database is `<home>/orion.db`. Assets are `<home>/assets/<id>.yaml`.

Command surface built in this task:

```
orion init
orion asset    list | show <id> | validate [id]
orion data     set <asset> <metric> <value> [--at iso] [--period-days n] [--source onchain|api|manual]
                   [--detail text] [--provisional --citation url [--quote text]]
               | confirm <obs_id> | reject <obs_id> | show <asset> [metric]
orion model    run <asset> [--as-of iso]
               | whatif <asset> --set key=value ... [--scenario bear|base|bull]
               | assumptions show <asset>
               | assumptions set <asset> <key> <value> --rationale text [--scenario bear|base|bull|all]
               | assumptions import <asset> <file> --rationale text
               | assumptions history <asset>
               | replay <run_id>
orion signal   latest <asset> | history <asset> [--limit n] | emit <asset> [--out file]
```

Assumption import file format (YAML): optional `all:` map applied to every scenario first, then `bear:`, `base:`, `bull:` maps that override it.

- [ ] **Step 1: Write the failing test** `tests/cli/cli.test.ts`

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { MINI_ASSET_YAML } from '../helpers/assets.js';
import { AS_OF } from '../helpers/obs.js';

let home: string;

async function orion(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const program = buildProgram({ home, stdout: (l) => lines.push(l), now: () => new Date(AS_OF) });
  await program.parseAsync(args, { from: 'user' });
  return lines.join('\n');
}

const ASSUMPTIONS_YAML = `
all:
  rev_growth_y1: 0
  growth_fade_years: 1
  terminal_growth: 0
  capture_rate_terminal.fees: 0.1
  capture_ramp_years.fees: 0
  discount_rate_base: 0.1
  staked_ratio_horizon: 0.5
bull:
  discount_rate_base: 0.05
`;

async function seedData() {
  await orion('data', 'set', 'mini', 'price_usd', '10', '--at', '2026-06-29', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'revenue_run_rate_usd', '1000', '--at', '2026-06-15', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'effective_supply', '100', '--at', '2026-06-29', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'staked_supply', '50', '--at', '2026-06-29', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'staker_emission_share', '1', '--at', '2026-06-29', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'emission_rate_annual', '0', '--at', '2026-01-01', '--source', 'onchain');
  await orion('data', 'set', 'mini', 'flow_usd.fees', String((100 * 90) / 365), '--at', AS_OF, '--period-days', '90', '--source', 'onchain');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'orion-cli-'));
  await orion('init');
  writeFileSync(join(home, 'assets', 'mini.yaml'), MINI_ASSET_YAML);
  writeFileSync(join(home, 'assumptions.yaml'), ASSUMPTIONS_YAML);
});

describe('orion cli', () => {
  it('init creates the home layout and database', () => {
    for (const d of ['assets', 'personas', 'skills', 'calibration']) expect(existsSync(join(home, d))).toBe(true);
    expect(existsSync(join(home, 'orion.db'))).toBe(true);
  });

  it('lists, shows, and validates assets', async () => {
    expect(JSON.parse(await orion('asset', 'list', '--json'))).toEqual(['mini']);
    expect(JSON.parse(await orion('asset', 'show', 'mini', '--json')).hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(await orion('asset', 'validate', '--json'))).toEqual([{ id: 'mini', errors: [] }]);
    mkdirSync(join(home, 'assets'), { recursive: true });
    writeFileSync(join(home, 'assets', 'bad.yaml'), MINI_ASSET_YAML.replace('id: mini', 'id: bad').replace('type: holder_cashflow', 'type: nope'));
    await expect(orion('asset', 'validate', 'bad')).rejects.toThrow(/validation failed/);
  });

  it('rejects data for a metric the asset does not define', async () => {
    await expect(orion('data', 'set', 'mini', 'nonsense', '1')).rejects.toThrow(/not defined/);
  });

  it('runs the full flow: data, assumptions, run, replay, what-if, emit', async () => {
    await seedData();
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');

    const signal = JSON.parse(await orion('model', 'run', 'mini', '--json'));
    expect(signal.status).toBe('ok');
    expect(signal.horizons['12m'].scenarios.bull.target).toBeCloseTo(20, 6);
    expect(signal.horizons['12m'].expected_target).toBeCloseTo(12.5, 6);

    expect(JSON.parse(await orion('signal', 'latest', 'mini', '--json')).signal_id).toBe(signal.signal_id);
    expect(JSON.parse(await orion('model', 'replay', String(signal.provenance.run_id), '--json')).identical).toBe(true);

    await orion('model', 'assumptions', 'set', 'mini', 'discount_rate_base', '0.2', '--scenario', 'bear', '--rationale', 'more cautious bear');
    const history = JSON.parse(await orion('model', 'assumptions', 'history', 'mini', '--json'));
    expect(history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    const shown = JSON.parse(await orion('model', 'assumptions', 'show', 'mini', '--json'));
    expect(shown.values.bear.discount_rate_base).toBe(0.2);
    expect(shown.values.base.discount_rate_base).toBe(0.1);

    const wi = JSON.parse(await orion('model', 'whatif', 'mini', '--set', 'discount_rate_base=0.05', '--scenario', 'base', '--json'));
    expect(wi.output.horizons['12m'].scenarios.base.target).toBeCloseTo(20, 6);

    const out = join(home, 'signals.jsonl');
    await orion('signal', 'emit', 'mini', '--out', out);
    expect(JSON.parse(readFileSync(out, 'utf8').trim()).signal_id).toBe(signal.signal_id);
    expect(JSON.parse(await orion('signal', 'history', 'mini', '--json'))).toHaveLength(1);
  });

  it('refuses out-of-bounds assumptions', async () => {
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');
    await expect(
      orion('model', 'assumptions', 'set', 'mini', 'discount_rate_base', '0.9', '--rationale', 'too high'),
    ).rejects.toThrow(/outside/);
  });

  it('handles provisional observations through confirm', async () => {
    await orion('data', 'set', 'mini', 'revenue_run_rate_usd', '1200', '--at', '2026-06-20', '--provisional', '--citation', 'https://example.com/post', '--quote', 'crossed 1200');
    const shown = JSON.parse(await orion('data', 'show', 'mini', 'revenue_run_rate_usd', '--json'));
    expect(shown[0].status).toBe('provisional');
    const confirmed = JSON.parse(await orion('data', 'confirm', String(shown[0].id), '--json'));
    expect(confirmed.status).toBe('confirmed');
    await expect(orion('data', 'set', 'mini', 'price_usd', '1', '--provisional')).rejects.toThrow(/citation/);
  });

  it('prints a readable summary without --json', async () => {
    await seedData();
    await orion('model', 'assumptions', 'import', 'mini', join(home, 'assumptions.yaml'), '--rationale', 'initial');
    const text = await orion('model', 'run', 'mini');
    expect(text).toMatch(/MINI\s+ok\s+grade A/);
    expect(text).toMatch(/12m\s+expected 12\.5000/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/cli/cli.test.ts`
Expected: FAIL, `src/cli/program.js` not found.

- [ ] **Step 3: Write `src/cli/util.ts`**

```ts
import { join } from 'node:path';
import { openDb, type Db } from '../db/connection.js';
import type { Signal } from '../signals/schema.js';
import { OrionError } from '../types.js';

export interface CliContext {
  home: string;
  stdout: (line: string) => void;
  now: () => Date;
}

export function dbPath(ctx: CliContext): string {
  return join(ctx.home, 'orion.db');
}

export function withDb<T>(ctx: CliContext, fn: (db: Db) => T): T {
  const db = openDb(dbPath(ctx));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function output(ctx: CliContext, json: boolean | undefined, data: unknown, text: () => string[]): void {
  if (json) ctx.stdout(JSON.stringify(data, null, 2));
  else for (const line of text()) ctx.stdout(line);
}

export function parseNumber(text: string, label: string): number {
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) throw new OrionError('invalid_number', `${label} must be a number, got "${text}"`);
  return n;
}

export const fmt = (n: number): string => n.toFixed(4);

export function signalSummary(s: Signal): string[] {
  const lines = [`${s.asset.toUpperCase()}  ${s.status}  grade ${s.data_quality.grade}  (${s.signal_id})`];
  if (s.spot) lines.push(`spot ${fmt(s.spot.price)} at ${s.spot.ts}`);
  for (const [name, h] of Object.entries(s.horizons ?? {})) {
    lines.push(
      `${name}  expected ${fmt(h.expected_target)}  upside ${h.upside_pct.toFixed(1)}%  staked total return ${h.staked_total_return_pct.toFixed(1)}%  dispersion ${h.dispersion.toFixed(2)}`,
    );
    lines.push(
      '     ' + (['bear', 'base', 'bull'] as const).map((k) => `${k} ${fmt(h.scenarios[k].target)} (${(h.scenarios[k].probability * 100).toFixed(0)}%)`).join('  '),
    );
    lines.push(
      '     ' + Object.entries(h.modules).map(([id, m]) => `${id} ${fmt(m.value)}${m.weight === null ? ' (component)' : ` (w ${m.weight.toFixed(2)})`}`).join('  '),
    );
    for (const [id, v] of Object.entries(h.extras)) lines.push(`     ${id} ${v.toFixed(1)}%`);
  }
  if (s.status_reasons.length > 0) lines.push(`reasons: ${s.status_reasons.join('; ')}`);
  if (s.data_quality.stale_metrics.length > 0) lines.push(`stale: ${s.data_quality.stale_metrics.join(', ')}`);
  if (s.data_quality.provisional_metrics.length > 0) lines.push(`provisional: ${s.data_quality.provisional_metrics.join(', ')}`);
  if (s.change.prev_signal_id) {
    const delta = s.change.target_delta_pct === null ? 'n/a' : `${s.change.target_delta_pct.toFixed(1)}%`;
    lines.push(`change: ${s.change.cause}, 12m target ${delta} vs ${s.change.prev_signal_id}${s.change.rationale ? ` (${s.change.rationale})` : ''}`);
  }
  return lines;
}
```

- [ ] **Step 4: Write `src/cli/commands/init.ts` and `src/cli/commands/asset.ts`**

```ts
// src/cli/commands/init.ts
import type { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dbPath, output, withDb, type CliContext } from '../util.js';

export function registerInit(program: Command, ctx: CliContext): void {
  program
    .command('init')
    .description('create the project layout and database in the Orion home directory')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) => {
      for (const d of ['assets', 'personas', 'skills', 'calibration']) mkdirSync(join(ctx.home, d), { recursive: true });
      withDb(ctx, () => undefined);
      output(ctx, opts.json, { home: ctx.home, db: dbPath(ctx) }, () => [`initialized ${ctx.home}`]);
    });
}
```

```ts
// src/cli/commands/asset.ts
import type { Command } from 'commander';
import { listAssetIds, loadAsset } from '../../config/load.js';
import { requiredAssumptionKeys, validateAssetModules } from '../../engine/requirements.js';
import { OrionError } from '../../types.js';
import { output, type CliContext } from '../util.js';

export function registerAsset(program: Command, ctx: CliContext): void {
  const asset = program.command('asset').description('inspect and validate asset configs (edit the YAML files directly)');

  asset
    .command('list')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) => {
      const ids = listAssetIds(ctx.home);
      output(ctx, opts.json, ids, () => (ids.length > 0 ? ids : ['no assets found in assets/']));
    });

  asset
    .command('show <id>')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      const loaded = loadAsset(ctx.home, id);
      const c = loaded.config;
      output(ctx, opts.json, { ...loaded, required_assumption_keys: requiredAssumptionKeys(c) }, () => [
        `${c.symbol}  ${c.name}  (${c.id})`,
        `config hash ${loaded.hash}`,
        `supply basis ${c.supply_basis}`,
        `metrics: ${Object.keys(c.metrics).join(', ')}`,
        `holder flows: ${c.holder_flows.map((f) => `${f.id} [${f.kind}, ${f.capture_rule}, ${f.recipient_base}]`).join('; ')}`,
        `modules: ${c.modules.map((m) => `${m.id}=${m.type}${m.weight === undefined ? '' : `@${m.weight}`}`).join('; ')}`,
        `scenario probabilities: bear ${c.scenario_probabilities.bear}, base ${c.scenario_probabilities.base}, bull ${c.scenario_probabilities.bull}`,
      ]);
    });

  asset
    .command('validate [id]')
    .option('--json', 'JSON output')
    .action((id: string | undefined, opts: { json?: boolean }) => {
      const results = (id ? [id] : listAssetIds(ctx.home)).map((assetId) => {
        try {
          return { id: assetId, errors: validateAssetModules(loadAsset(ctx.home, assetId).config) };
        } catch (err) {
          if (err instanceof OrionError) return { id: assetId, errors: err.message.split('\n') };
          throw err;
        }
      });
      output(ctx, opts.json, results, () =>
        results.flatMap((r) => (r.errors.length === 0 ? [`${r.id}: ok`] : [`${r.id}:`, ...r.errors.map((e) => `  ${e}`)])),
      );
      const failed = results.filter((r) => r.errors.length > 0).map((r) => r.id);
      if (failed.length > 0) throw new OrionError('validation_failed', `validation failed for: ${failed.join(', ')}`);
    });
}
```

- [ ] **Step 5: Write `src/cli/commands/data.ts`**

```ts
import type { Command } from 'commander';
import { loadAsset } from '../../config/load.js';
import { confirmObservation, insertObservation, listActiveObservations, rejectObservation } from '../../db/observations.js';
import { OrionError, type ObservationSource } from '../../types.js';
import { output, parseNumber, withDb, type CliContext } from '../util.js';

interface SetOpts {
  at?: string;
  periodDays?: string;
  source: string;
  detail?: string;
  provisional?: boolean;
  citation?: string;
  quote?: string;
  json?: boolean;
}

const SOURCES: ObservationSource[] = ['onchain', 'api', 'manual'];

export function registerData(program: Command, ctx: CliContext): void {
  const data = program.command('data').description('enter, confirm, and inspect observations');

  data
    .command('set <asset> <metric> <value>')
    .description('record one observation')
    .option('--at <iso>', 'observed-at timestamp (default: now). For schedule metrics this is the effective date')
    .option('--period-days <n>', 'for flow metrics: days covered, ending at --at')
    .option('--source <source>', 'onchain | api | manual', 'manual')
    .option('--detail <text>', 'where the number came from')
    .option('--provisional', 'store as provisional (requires --citation)')
    .option('--citation <url>', 'citation url')
    .option('--quote <text>', 'quoted source text')
    .option('--json', 'JSON output')
    .action((assetId: string, metric: string, value: string, opts: SetOpts) => {
      const { config } = loadAsset(ctx.home, assetId);
      if (!config.metrics[metric]) throw new OrionError('unknown_metric', `metric "${metric}" is not defined in assets/${assetId}.yaml`);
      if (!SOURCES.includes(opts.source as ObservationSource)) throw new OrionError('invalid_source', `source must be one of ${SOURCES.join(', ')}`);
      const nowIso = ctx.now().toISOString();
      const o = withDb(ctx, (db) =>
        insertObservation(db, {
          assetId,
          metricKey: metric,
          observedAt: opts.at ?? nowIso,
          periodDays: opts.periodDays === undefined ? null : parseNumber(opts.periodDays, '--period-days'),
          value: parseNumber(value, 'value'),
          source: opts.source as ObservationSource,
          sourceDetail: opts.detail ?? null,
          status: opts.provisional ? 'provisional' : 'confirmed',
          citationUrl: opts.citation ?? null,
          quotedText: opts.quote ?? null,
          fetchedAt: nowIso,
        }),
      );
      output(ctx, opts.json, o, () => [`recorded #${o.id}: ${assetId} ${metric} = ${o.value} at ${o.observedAt} (${o.status})`]);
    });

  data
    .command('confirm <obs_id>')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      const o = withDb(ctx, (db) => confirmObservation(db, parseNumber(id, 'obs_id'), ctx.now().toISOString()));
      output(ctx, opts.json, o, () => [`confirmed as #${o.id}: ${o.metricKey} = ${o.value}`]);
    });

  data
    .command('reject <obs_id>')
    .option('--json', 'JSON output')
    .action((id: string, opts: { json?: boolean }) => {
      const n = parseNumber(id, 'obs_id');
      withDb(ctx, (db) => rejectObservation(db, n));
      output(ctx, opts.json, { rejected: n }, () => [`rejected #${n}`]);
    });

  data
    .command('show <asset> [metric]')
    .description('list active observations, newest first')
    .option('--json', 'JSON output')
    .action((assetId: string, metric: string | undefined, opts: { json?: boolean }) => {
      const list = withDb(ctx, (db) => listActiveObservations(db, assetId, metric)).reverse();
      output(ctx, opts.json, list, () =>
        list.length === 0
          ? ['no active observations']
          : list.map((o) => `#${o.id}  ${o.metricKey}  ${o.value}  ${o.observedAt}  ${o.source}  ${o.status}${o.periodDays ? `  period ${o.periodDays}d` : ''}`),
      );
    });
}
```

- [ ] **Step 6: Write `src/cli/commands/model.ts`**

```ts
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { replayRun, runValuation, whatIf } from '../../app/valuation.js';
import { loadAsset } from '../../config/load.js';
import type { AssetConfig } from '../../config/schema.js';
import { createAssumptionSet, getLatestAssumptionSet, listAssumptionSets } from '../../db/assumptions.js';
import type { Db } from '../../db/connection.js';
import { validateAssumptions } from '../../engine/requirements.js';
import { OrionError, SCENARIOS, type AssumptionValues, type Scenario } from '../../types.js';
import { fmt, output, parseNumber, signalSummary, withDb, type CliContext } from '../util.js';

const isScenario = (x: string): x is Scenario => (SCENARIOS as readonly string[]).includes(x);
const collect = (value: string, previous: string[]): string[] => [...previous, value];

function saveValidated(db: Db, asset: AssetConfig, values: AssumptionValues, rationale: string, nowIso: string) {
  const errors = validateAssumptions(asset, values);
  if (errors.length > 0) throw new OrionError('invalid_assumptions', errors.join('\n'));
  return createAssumptionSet(db, { assetId: asset.id, author: 'user', rationale, values, createdAt: nowIso });
}

function readImportFile(path: string): AssumptionValues {
  const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new OrionError('invalid_import', `${path} is not a YAML map`);
  const section = (name: string): Record<string, number> => {
    const s = raw[name];
    if (s === undefined) return {};
    if (s === null || typeof s !== 'object') throw new OrionError('invalid_import', `${path}: "${name}" must be a map`);
    for (const [k, v] of Object.entries(s)) {
      if (typeof v !== 'number') throw new OrionError('invalid_import', `${path}: ${name}.${k} must be a number`);
    }
    return s as Record<string, number>;
  };
  for (const key of Object.keys(raw)) {
    if (key !== 'all' && !isScenario(key)) throw new OrionError('invalid_import', `${path}: unknown section "${key}"`);
  }
  const all = section('all');
  return { bear: { ...all, ...section('bear') }, base: { ...all, ...section('base') }, bull: { ...all, ...section('bull') } };
}

export function registerModel(program: Command, ctx: CliContext): void {
  const model = program.command('model').description('run valuations and manage assumptions');

  model
    .command('run <asset>')
    .description('snapshot data, run the engine, and persist a signal')
    .option('--as-of <iso>', 'valuation time (default: now). Use for backfills and reproducible demos')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { asOf?: string; json?: boolean }) => {
      const loaded = loadAsset(ctx.home, assetId);
      const now = opts.asOf ? new Date(opts.asOf) : ctx.now();
      if (Number.isNaN(now.getTime())) throw new OrionError('invalid_timestamp', `invalid --as-of: ${opts.asOf}`);
      const { signal } = withDb(ctx, (db) => runValuation(db, loaded, now));
      output(ctx, opts.json, signal, () => signalSummary(signal));
    });

  model
    .command('whatif <asset>')
    .description('run the engine with assumption overrides; nothing is saved and bounds are not enforced')
    .option('--set <key=value>', 'override (repeatable)', collect, [])
    .option('--scenario <scenario>', 'apply overrides to one scenario (default: all)')
    .option('--as-of <iso>', 'valuation time (default: now)')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { set: string[]; scenario?: string; asOf?: string; json?: boolean }) => {
      if (opts.scenario !== undefined && !isScenario(opts.scenario)) throw new OrionError('invalid_scenario', `unknown scenario: ${opts.scenario}`);
      const scenario = opts.scenario as Scenario | undefined;
      const overrides = opts.set.map((pair) => {
        const i = pair.indexOf('=');
        if (i <= 0) throw new OrionError('invalid_override', `expected key=value, got "${pair}"`);
        return { key: pair.slice(0, i), value: parseNumber(pair.slice(i + 1), pair.slice(0, i)), scenario };
      });
      const loaded = loadAsset(ctx.home, assetId);
      const now = opts.asOf ? new Date(opts.asOf) : ctx.now();
      const result = withDb(ctx, (db) => whatIf(db, loaded, now, overrides));
      output(ctx, opts.json, result, () => {
        if ('blocked' in result) return ['cannot run:', ...result.blocked.map((b) => `  ${b}`)];
        return Object.entries(result.output.horizons).flatMap(([name, h]) => [
          `${name}  expected ${fmt(h.expectedTarget)}  upside ${h.upsidePct.toFixed(1)}%  dispersion ${h.dispersion.toFixed(2)}`,
          '     ' + SCENARIOS.map((s) => `${s} ${fmt(h.scenarios[s].target)}`).join('  '),
        ]);
      });
    });

  const assumptions = model.command('assumptions').description('versioned assumption sets');

  assumptions
    .command('show <asset>')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const { config } = loadAsset(ctx.home, assetId);
      const set = withDb(ctx, (db) => getLatestAssumptionSet(db, assetId));
      if (!set) throw new OrionError('no_assumption_set', `no assumption set for ${assetId}; use "orion model assumptions import"`);
      output(ctx, opts.json, set, () => [
        `${assetId} assumptions v${set.version} by ${set.author} at ${set.createdAt}: ${set.rationale}`,
        ...Object.keys(set.values.base).sort().map((key) => {
          const b = config.assumptions[key];
          const bounds = b ? `[${b.min}, ${b.max}]` : '[no bounds]';
          return `  ${key}  bear ${set.values.bear[key]}  base ${set.values.base[key]}  bull ${set.values.bull[key]}  ${bounds}`;
        }),
      ]);
    });

  assumptions
    .command('set <asset> <key> <value>')
    .description('create a new version with one value changed')
    .requiredOption('--rationale <text>', 'why this changed')
    .option('--scenario <scenario>', 'bear | base | bull | all', 'all')
    .option('--json', 'JSON output')
    .action((assetId: string, key: string, value: string, opts: { rationale: string; scenario: string; json?: boolean }) => {
      if (opts.scenario !== 'all' && !isScenario(opts.scenario)) throw new OrionError('invalid_scenario', `unknown scenario: ${opts.scenario}`);
      const { config } = loadAsset(ctx.home, assetId);
      const v = parseNumber(value, 'value');
      const set = withDb(ctx, (db) => {
        const latest = getLatestAssumptionSet(db, assetId);
        if (!latest) throw new OrionError('no_assumption_set', `no assumption set for ${assetId}; import one first`);
        const values: AssumptionValues = { bear: { ...latest.values.bear }, base: { ...latest.values.base }, bull: { ...latest.values.bull } };
        for (const s of opts.scenario === 'all' ? SCENARIOS : [opts.scenario as Scenario]) values[s][key] = v;
        return saveValidated(db, config, values, opts.rationale, ctx.now().toISOString());
      });
      output(ctx, opts.json, set, () => [`${assetId} assumptions v${set.version}: ${key} = ${v} (${opts.scenario})`]);
    });

  assumptions
    .command('import <asset> <file>')
    .description('create a new version from a YAML file with all/bear/base/bull sections')
    .requiredOption('--rationale <text>', 'why this set exists')
    .option('--json', 'JSON output')
    .action((assetId: string, file: string, opts: { rationale: string; json?: boolean }) => {
      const { config } = loadAsset(ctx.home, assetId);
      const values = readImportFile(file);
      const set = withDb(ctx, (db) => saveValidated(db, config, values, opts.rationale, ctx.now().toISOString()));
      output(ctx, opts.json, set, () => [`${assetId} assumptions v${set.version} imported from ${file}`]);
    });

  assumptions
    .command('history <asset>')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const list = withDb(ctx, (db) => listAssumptionSets(db, assetId));
      output(ctx, opts.json, list, () =>
        list.length === 0 ? ['no assumption sets'] : list.map((s) => `v${s.version}  ${s.createdAt}  ${s.author}  ${s.rationale}`),
      );
    });

  model
    .command('replay <run_id>')
    .description('recompute a stored run from its frozen inputs and compare byte for byte')
    .option('--json', 'JSON output')
    .action((runId: string, opts: { json?: boolean }) => {
      const result = withDb(ctx, (db) => replayRun(db, parseNumber(runId, 'run_id')));
      output(ctx, opts.json, { run_id: Number(runId), identical: result.identical }, () => [
        result.identical ? `run ${runId}: replay is identical` : `run ${runId}: REPLAY DIFFERS from the stored output`,
      ]);
      if (!result.identical) throw new OrionError('replay_mismatch', `run ${runId} did not reproduce`);
    });
}
```

- [ ] **Step 7: Write `src/cli/commands/signal.ts`**

```ts
import type { Command } from 'commander';
import { getLatestSignal, listSignals } from '../../db/runs.js';
import { emitSignal } from '../../signals/emit.js';
import { OrionError } from '../../types.js';
import { output, parseNumber, signalSummary, withDb, type CliContext } from '../util.js';

export function registerSignal(program: Command, ctx: CliContext): void {
  const signal = program.command('signal').description('read and emit stored signals');

  const latest = (assetId: string) => {
    const s = withDb(ctx, (db) => getLatestSignal(db, assetId));
    if (!s) throw new OrionError('no_signal', `no signal for ${assetId}; run "orion model run ${assetId}"`);
    return s;
  };

  signal
    .command('latest <asset>')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { json?: boolean }) => {
      const s = latest(assetId);
      output(ctx, opts.json, s, () => signalSummary(s));
    });

  signal
    .command('history <asset>')
    .option('--limit <n>', 'maximum signals, newest first', '20')
    .option('--json', 'JSON output')
    .action((assetId: string, opts: { limit: string; json?: boolean }) => {
      const list = withDb(ctx, (db) => listSignals(db, assetId, parseNumber(opts.limit, '--limit')));
      output(ctx, opts.json, list, () =>
        list.length === 0
          ? ['no signals']
          : list.map((s) => `${s.generated_at}  ${s.status}  grade ${s.data_quality.grade}  12m ${s.horizons ? s.horizons['12m'].expected_target.toFixed(4) : 'n/a'}  ${s.signal_id}`),
      );
    });

  signal
    .command('emit <asset>')
    .description('write the latest signal as one JSON line to stdout, and append it to --out when given')
    .option('--out <file>', 'JSONL file to append to')
    .action((assetId: string, opts: { out?: string }) => {
      emitSignal(latest(assetId), { write: ctx.stdout, outFile: opts.out });
    });
}
```

- [ ] **Step 8: Write `src/cli/program.ts` and `src/cli/index.ts`**

```ts
// src/cli/program.ts
import { Command } from 'commander';
import { registerAsset } from './commands/asset.js';
import { registerData } from './commands/data.js';
import { registerInit } from './commands/init.js';
import { registerModel } from './commands/model.js';
import { registerSignal } from './commands/signal.js';
import type { CliContext } from './util.js';

export type { CliContext } from './util.js';

export function buildProgram(ctx: CliContext): Command {
  const program = new Command('orion')
    .description('Token valuation signals from deterministic models and versioned assumptions')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.stdout(s.trimEnd()),
      writeErr: (s) => ctx.stdout(s.trimEnd()),
    });
  registerInit(program, ctx);
  registerAsset(program, ctx);
  registerData(program, ctx);
  registerModel(program, ctx);
  registerSignal(program, ctx);
  return program;
}
```

`exitOverride()` and `configureOutput()` must be called before the `register*` calls: commander copies these settings into subcommands at the moment they are created.

`src/cli/index.ts` (the `#!` line must be the first line of the file):

```ts
#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program.js';

const program = buildProgram({
  home: process.env.ORION_HOME ?? process.cwd(),
  stdout: (line) => console.log(line),
  now: () => new Date(),
});

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode; // commander already printed help or its own error
    return;
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
```

- [ ] **Step 9: Run tests, typecheck, and build**

Run: `npx vitest run tests/cli && npm run typecheck && npm run build && node dist/cli/index.js --help`
Expected: 7 tests PASS; the build succeeds; help lists `init`, `asset`, `data`, `model`, `signal`.

If `tsc` rejects the shebang line in `index.ts`, keep it: TypeScript preserves a leading `#!` line. If the built file is not executable when linked, run `chmod +x dist/cli/index.js`.

- [ ] **Step 10: Commit**

```bash
git add src/cli tests/cli
git commit -m "feat: add CLI for assets, data entry, valuation runs, and signals"
```

---

### Task 15: VVV asset, seed data, and calibration checkpoint

This task ends with a **user checkpoint**. The assumption values, bounds, and module weights below are a starting draft written by the planner, not a recommendation. The user owns them. Do not tune them to make the output look better.

**Files:**
- Create: `assets/vvv.yaml`, `calibration/vvv-seed-2026-09-18.sh`, `calibration/vvv-initial-assumptions.yaml`, `README.md`
- Test: `tests/assets/vvv.test.ts`

**Interfaces:**
- Consumes: `loadAsset`, `validateAssetModules`, `validateAssumptions`, the CLI.
- Produces: a committed VVV config and a first stored VVV signal in the local (git-ignored) `orion.db`.

Data values come from section 4 of the spec (research pass on 2026-09-18). Every number entered by the seed script is `manual` provenance, so the best possible grade in this sub-project is `B`. Revenue is entered as `provisional` with its citation, which makes the first signal grade `C` until the user confirms it.

- [ ] **Step 1: Write `assets/vvv.yaml`**

```yaml
id: vvv
symbol: VVV
name: Venice Token
chain: base
supply_basis: effective_total

contracts:
  token: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf"
  staking: "0x321b7ff75154472B18EDb199033fF4D116F340Ff"
  diem: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024"
  burn_sink: "0x0000000000000000000000000000000000000000"
  treasury: "0x2D8CB8DC596daD0e1E34E2042E7ae6Df93B11524"

external_ids:
  coingecko: venice-token
  coingecko_diem: diem
  defillama: venice

# All fetchers are "manual" in sub-project 1. Sub-project 2 points them at base-rpc, venice-api, coingecko, defillama.
metrics:
  price_usd: { type: level, unit: usd, staleness_days: 3, critical: true }
  revenue_run_rate_usd: { type: level, unit: usd, cadence: event, staleness_days: 60, critical: true, allow_provisional: true }
  effective_supply: { type: level, unit: tokens, staleness_days: 7, critical: true }
  circulating_supply: { type: level, unit: tokens, staleness_days: 14 }
  staked_supply: { type: level, unit: tokens, staleness_days: 7 }
  locked_supply: { type: level, unit: tokens, staleness_days: 14 }
  staker_emission_share: { type: level, unit: ratio, staleness_days: 30 }
  emission_rate_annual: { type: schedule, unit: tokens_per_year, cadence: event, staleness_days: 45, critical: true }
  flow_usd.burn: { type: flow, unit: usd, cadence: monthly, staleness_days: 45, critical: true }
  diem_supply: { type: level, unit: diem, staleness_days: 14 }
  diem_target_supply: { type: level, unit: diem, staleness_days: 45 }
  diem_price_usd: { type: level, unit: usd, staleness_days: 7 }
  diem_locked_yield_share: { type: level, unit: ratio, cadence: event, staleness_days: 90 }

holder_flows:
  - { id: burn, kind: burn, capture_rule: discretionary, recipient_base: all, metric: flow_usd.burn, window_days: 90 }

modules:
  - { id: hc, type: holder_cashflow, kind: estimate, weight: 0.4 }
  - { id: fm_revenue, type: forward_multiple, kind: estimate, weight: 0.3, params: { basis: revenue, market_convention: true } }
  - { id: fm_holder_flow, type: forward_multiple, kind: estimate, weight: 0.3, params: { basis: holder_flow } }
  - { id: diem, type: utility_claim, kind: component, params: { diem_value_basis: market } }

scenario_probabilities: { bear: 0.25, base: 0.5, bull: 0.25 }

total_return_variants:
  - { id: diem_locked_staked_total_return_pct, yield_multiplier_metric: diem_locked_yield_share }

assumptions:
  rev_growth_y1: { min: -0.5, max: 4.0 }
  growth_fade_years: { min: 1, max: 8 }
  terminal_growth: { min: 0, max: 0.05 }
  capture_rate_terminal.burn: { min: 0, max: 0.5 }
  capture_ramp_years.burn: { min: 0, max: 8 }
  discount_rate_base: { min: 0.08, max: 0.30 }
  discount_premium_discretionary: { min: 0, max: 0.15 }
  multiple.fm_revenue: { min: 1, max: 50 }
  multiple.fm_holder_flow: { min: 5, max: 150 }
  regime_multiplier: { min: 0.3, max: 2.5 }
  staked_ratio_horizon: { min: 0.1, max: 0.9 }
  diem_target_supply_growth: { min: 0, max: 1 }
  diem_discount_rate: { min: 0.05, max: 0.5 }

review_triggers:
  driver_deviation_pct: 25
  calendar:
    - { date: "2026-10-01", note: "Announced emission cut to 2.0M VVV per year" }

peer_set: []
```

Note on `multiple.fm_revenue`: values are divided by effective total supply, so this multiple is comparable to FDV over revenue, not market cap over revenue.

- [ ] **Step 2: Write the config test** `tests/assets/vvv.test.ts`

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadAsset } from '../../src/config/load.js';
import { requiredExtraMetrics, validateAssetModules, validateAssumptions } from '../../src/engine/requirements.js';
import type { AssumptionValues } from '../../src/types.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('assets/vvv.yaml', () => {
  it('is a valid asset with bounds for every required assumption', () => {
    const { config } = loadAsset(ROOT, 'vvv');
    expect(validateAssetModules(config)).toEqual([]);
    expect(requiredExtraMetrics(config)).toEqual(['diem_locked_yield_share', 'diem_price_usd', 'diem_supply', 'diem_target_supply']);
  });

  it('ships a draft assumption file that passes validation', () => {
    const { config } = loadAsset(ROOT, 'vvv');
    const raw = parseYaml(readFileSync(`${ROOT}/calibration/vvv-initial-assumptions.yaml`, 'utf8')) as Record<string, Record<string, number>>;
    const values: AssumptionValues = {
      bear: { ...raw.all, ...raw.bear },
      base: { ...raw.all, ...raw.base },
      bull: { ...raw.all, ...raw.bull },
    };
    expect(validateAssumptions(config, values)).toEqual([]);
  });
});
```

- [ ] **Step 3: Write `calibration/vvv-initial-assumptions.yaml`** (DRAFT for user review)

```yaml
# DRAFT starting point. Every value here is the user's to change at the calibration checkpoint.
all:
  capture_ramp_years.burn: 3
  staked_ratio_horizon: 0.42
bear:
  rev_growth_y1: 0.10
  growth_fade_years: 4
  terminal_growth: 0.02
  capture_rate_terminal.burn: 0.05
  discount_rate_base: 0.20
  discount_premium_discretionary: 0.08
  multiple.fm_revenue: 6
  multiple.fm_holder_flow: 15
  regime_multiplier: 0.6
  diem_target_supply_growth: 0.0
  diem_discount_rate: 0.25
base:
  rev_growth_y1: 0.80
  growth_fade_years: 4
  terminal_growth: 0.03
  capture_rate_terminal.burn: 0.10
  discount_rate_base: 0.15
  discount_premium_discretionary: 0.06
  multiple.fm_revenue: 15
  multiple.fm_holder_flow: 30
  regime_multiplier: 1.0
  diem_target_supply_growth: 0.10
  diem_discount_rate: 0.20
bull:
  rev_growth_y1: 2.00
  growth_fade_years: 5
  terminal_growth: 0.04
  capture_rate_terminal.burn: 0.20
  discount_rate_base: 0.12
  discount_premium_discretionary: 0.04
  multiple.fm_revenue: 25
  multiple.fm_holder_flow: 50
  regime_multiplier: 1.4
  diem_target_supply_growth: 0.25
  diem_discount_rate: 0.15
```

- [ ] **Step 4: Run the config test**

Run: `npx vitest run tests/assets/vvv.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Write `calibration/vvv-seed-2026-09-18.sh`**

```bash
#!/usr/bin/env bash
# Hand-entered VVV observations as of 2026-09-18, from the research pass recorded in the design spec (section 4).
# Run from the repo root after "npm run build". Safe to re-run: same metric + same timestamp supersedes.
set -euo pipefail
O="node dist/cli/index.js"
D="research pass 2026-09-18"

$O data set vvv price_usd 27.46 --at 2026-09-18 --detail "$D: CoinGecko and Venice API"
$O data set vvv effective_supply 81003579 --at 2026-09-18 --detail "$D: totalSupply minus balanceOf(0x0)"
$O data set vvv circulating_supply 48350000 --at 2026-09-18 --detail "$D: Venice API vvv_stats"
$O data set vvv staked_supply 33964988 --at 2026-09-18 --detail "$D: staking totalSupply()"
$O data set vvv locked_supply 8969695 --at 2026-09-18 --detail "$D: totalLockedStakedVVV()"
$O data set vvv staker_emission_share 0.947 --at 2026-09-18 --detail "$D: Venice API vvv_staking_yield (6488 of 6850 per day)"

# Emission schedule: --at is the effective date. The 2026-10-01 cut is announced, not yet on-chain.
$O data set vvv emission_rate_annual 2500000 --at 2026-09-01 --detail "$D: EmissionRateUpdated event"
$O data set vvv emission_rate_annual 2000000 --at 2026-10-01 --detail "$D: Venice blog update of 2026-08-05 (announced)"

# Revenue-funded burns in USD. --at is the END of the period, --period-days its length.
$O data set vvv flow_usd.burn 241800 --at 2026-07-01 --period-days 30 --detail "$D: vvv_burn_history 2026-06"
$O data set vvv flow_usd.burn 445200 --at 2026-08-01 --period-days 31 --detail "$D: vvv_burn_history 2026-07"
$O data set vvv flow_usd.burn 702700 --at 2026-09-01 --period-days 31 --detail "$D: vvv_burn_history 2026-08"
$O data set vvv flow_usd.burn 676500 --at 2026-09-18 --period-days 17 --detail "$D: vvv_burn_history 2026-09 month to date"

$O data set vvv diem_supply 37759.6 --at 2026-09-18 --detail "$D: DIEM totalSupply()"
$O data set vvv diem_target_supply 40000 --at 2026-09-14 --detail "$D: on-chain mint-rate table after the 2026-09-14 update"
$O data set vvv diem_price_usd 2057.69 --at 2026-09-18 --detail "$D: CoinGecko id diem"
$O data set vvv diem_locked_yield_share 0.8 --at 2026-09-18 --detail "$D: veniceEmissionsPercentageWhenLocked() = 20 percent"

# Revenue is a secondhand disclosure, so it goes in as provisional with its citation.
$O data set vvv revenue_run_rate_usd 100000000 --at 2026-08-17 --provisional \
  --citation "https://coincodex.com/article/90258/vvv-spikes-20-as-venice-ai-tops-100m-annualized-revenue/" \
  --quote "Venice just crossed \$100m annualized revenue" \
  --detail "$D: founder post on X, read via press quote"
```

Then: `chmod +x calibration/vvv-seed-2026-09-18.sh`

- [ ] **Step 6: Produce the first VVV signal**

```bash
npm run build
export ORION_HOME="$PWD"
node dist/cli/index.js init
node dist/cli/index.js asset validate vvv
./calibration/vvv-seed-2026-09-18.sh
node dist/cli/index.js model assumptions import vvv calibration/vvv-initial-assumptions.yaml --rationale "Planner draft, pending user calibration"
node dist/cli/index.js model run vvv --as-of 2026-09-18T12:00:00Z
node dist/cli/index.js model replay 1
```

Expected:
- `asset validate` prints `vvv: ok`.
- `model run` prints a summary with status `ok`, grade `C`, `provisional: revenue_run_rate_usd`, both horizons, four module values per horizon, and a `diem_locked_staked_total_return_pct` line.
- `holder_cashflow` (`hc`) is far below spot and `fm_revenue` is the highest estimate, so dispersion is well above 1. This gap is expected and is the reason dispersion is a first-class field (spec section 4.1). It is not a bug.
- `model replay 1` prints `run 1: replay is identical`.

Sanity checks to make by eye (do not assert exact values): trailing burn flow should annualize to roughly 7 to 8 million USD, giving a capture rate near 0.08; supply at 12m should be near 83 million.

- [ ] **Step 7: Write `README.md`**

````markdown
# Orion

Price-target signals for crypto tokens with real value capture. A deterministic engine turns observations and a versioned assumption set into 6-month and 12-month targets, emitted as JSON signals.

Design: `docs/superpowers/specs/2026-09-18-orion-valuation-framework-design.md`

## Quick start

```bash
npm install && npm run build && npm link     # provides the `orion` command
export ORION_HOME="$PWD"
orion init
orion asset validate
./calibration/vvv-seed-2026-09-18.sh
orion model assumptions import vvv calibration/vvv-initial-assumptions.yaml --rationale "first calibration"
orion model run vvv
orion signal emit vvv --out signals.jsonl
```

## Where things live

- Human-authored, in git: `assets/*.yaml` (metrics, holder flows, modules, weights, assumption bounds), `personas/`, `skills/`, `calibration/`.
- Machine-written, in `orion.db` (git-ignored): observations, assumption-set versions, snapshots, runs, signals.

## Everyday commands

```bash
orion data set vvv price_usd 28.10                       # new observation, now
orion data show vvv revenue_run_rate_usd                 # inspect
orion data confirm 17                                    # promote a provisional observation
orion model assumptions show vvv
orion model assumptions set vvv rev_growth_y1 0.6 --scenario base --rationale "slower Q4"
orion model whatif vvv --set regime_multiplier=0.5       # explore, nothing saved
orion model run vvv                                      # new signal
orion model replay 12                                    # prove run 12 reproduces
```

Every command accepts `--json`. Signals follow schema v1 (spec section 9). Orion emits signals only. It is not investment advice.
````

- [ ] **Step 8: Run everything**

Run: `npm test && npm run typecheck`
Expected: all test files pass, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add assets calibration README.md tests/assets
git commit -m "feat: add VVV asset config, seed data, and draft calibration"
```

- [ ] **Step 10: USER CHECKPOINT: calibration**

Stop and show the user:
1. The full output of `orion model run vvv --as-of 2026-09-18T12:00:00Z` and of `orion model assumptions show vvv`.
2. The three decisions that are theirs to make:
   - **Module weights** in `assets/vvv.yaml` (`hc` 0.4, `fm_revenue` 0.3, `fm_holder_flow` 0.3). These decide how much the target leans on cash flows that actually reach holders versus how the market prices revenue.
   - **Assumption values** per scenario, and the **bounds** the agent will later be held to.
   - Whether to **confirm** the provisional revenue observation (`orion data show vvv revenue_run_rate_usd`, then `orion data confirm <id>`), which lifts the grade from `C` to `B`.
3. Apply what they decide with `orion model assumptions set ... --rationale ...` or a fresh `import`, and by editing `assets/vvv.yaml` for weights and bounds. Re-run `orion asset validate vvv` and `orion model run vvv --as-of 2026-09-18T12:00:00Z`. Commit any YAML changes.

Sub-project 1 is complete when the user accepts the calibrated signal and `npm test` passes.

---

## Deferred to later sub-projects (do not build here)

| Item | Sub-project |
|---|---|
| `base-rpc`, `venice-api`, `coingecko`, `defillama` fetchers; `orion data fetch`; cross-check tolerance; `anomalies`; `fetch_runs`; burn-derived revenue proxy | 2 |
| Personas, skills, agent runner, guardrails, `proposals`, `assumption_evidence`, `journal`, `coverage`, `orion persona`, `orion agent`, `orion model proposals`, peer multiples as data | 3 |
| `orion tick`, triggers, per-asset run lock, webhook delivery | 4 |

