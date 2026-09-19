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
