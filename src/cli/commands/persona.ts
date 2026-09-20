import type { Command } from 'commander';
import { loadAsset } from '../../config/load.js';
import { listPersonaNames, loadPersona, loadSkills } from '../../config/personas.js';
import { assignPersona, listCoverage } from '../../db/coverage.js';
import { guarded, output, withDb, type CliContext } from '../util.js';

export function registerPersona(program: Command, ctx: CliContext): void {
  const persona = program.command('persona').description('analyst personas: markdown files in personas/, assigned to assets');

  persona
    .command('list')
    .description('personas, the assets each covers, and the skills each run type loads')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const coverage = withDb(ctx, (db) => listCoverage(db));
        const personas = listPersonaNames(ctx.home).map((name) => {
          const p = loadPersona(ctx.home, name);
          return { name: p.name, model: p.model, effort: p.effort, sectors: p.sectors, covers: coverage.filter((c) => c.persona === name).map((c) => c.assetId) };
        });
        const skills = loadSkills(ctx.home).map((s) => ({ name: s.name, run_types: s.runTypes, description: s.description }));
        output(ctx, opts.json, { personas, skills }, () => [
          ...(personas.length === 0 ? ['no personas in personas/'] : personas.map((p) => `${p.name}  ${p.model}  effort ${p.effort}  covers: ${p.covers.join(', ') || 'nothing'}`)),
          ...skills.map((s) => `  skill ${s.name}  [${s.run_types.join(', ')}]  ${s.description}`),
        ]);
      }),
    );

  persona
    .command('show <name>')
    .description('a persona file: its settings and its prompt')
    .option('--json', 'JSON output')
    .action((name: string, opts: { json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        const p = loadPersona(ctx.home, name);
        output(ctx, opts.json, p, () => [`${p.name}  ${p.model}  effort ${p.effort}  ${p.temperament}`, `sectors: ${p.sectors.join(', ') || 'none'}`, '', p.body]);
      }),
    );

  persona
    .command('assign <asset> <name>')
    .description('make a persona the lead analyst for an asset (replaces any earlier assignment)')
    .option('--json', 'JSON output')
    .action((assetId: string, name: string, opts: { json?: boolean }) =>
      guarded(ctx, opts.json, () => {
        loadAsset(ctx.home, assetId); // both must exist before the assignment is recorded
        loadPersona(ctx.home, name);
        const c = withDb(ctx, (db) => assignPersona(db, assetId, name, ctx.now().toISOString()));
        output(ctx, opts.json, c, () => [`${c.persona} now covers ${c.assetId}`]);
      }),
    );
}
