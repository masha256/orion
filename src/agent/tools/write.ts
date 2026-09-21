import { z } from 'zod';
import { valueInForce } from '../../app/eligibility.js';
import { provisionalMovePct } from '../../config/agentPolicy.js';
import { applyEditsToObject, getAtPath, UNPROPOSABLE_ROOTS, unproposableEdits } from '../../config/edit.js';
import { parseAssetObject, rawConfig } from '../../config/load.js';
import { getAnomaly, listOpenAnomalies } from '../../db/anomalies.js';
import { getObservationsByIds, listActiveObservations, type Observation } from '../../db/observations.js';
import { findPendingDuplicate, proposalIdentity, type ProposalChange, type ProposalEffect } from '../../db/proposals.js';
import { requiredAssumptionKeys, validateAssetModules, validateAssumptions } from '../../engine/requirements.js';
import { SCENARIOS, type Scenario } from '../../types.js';
import { canonicalJson } from '../../util/canonical.js';
import {
  allowedRange, blockingAnomalies, checkEvidence, checkStep, cleanText, placeValue, routeObservation, verifyCitation, type EvidenceRef,
} from '../guardrails.js';
import { computeEffect } from './think.js';
import { defineTool, refuse, ToolRefusal, type AgentTool, type ToolContext } from './types.js';

const isActive = (o: Observation): boolean => o.supersededBy === null && o.status !== 'rejected';

function evidenceLookup(ctx: ToolContext): (id: number) => EvidenceRef | null {
  return (id) => {
    if (id < 0) return ctx.ledger.hasStagedObservation(id) ? { assetId: ctx.loaded.config.id, active: true } : null;
    const o = getObservationsByIds(ctx.db, [id])[0];
    return o ? { assetId: o.assetId, active: isActive(o) } : null;
  };
}

function requireEvidence(ctx: ToolContext, ids: number[]): void {
  const refusal = checkEvidence(ids, ctx.loaded.config.id, evidenceLookup(ctx), ctx.ledger.shown);
  if (refusal) throw new ToolRefusal(refusal);
}

/**
 * Maximum lengths for everything the model writes. Nothing here needs to be long, and every one of these strings is
 * stored, printed, and read back into a later run's context. Too long is an ordinary `invalid_input` refusal: the model
 * shortens it and calls again.
 */
const MAX_QUOTE = 600;
const MAX_RATIONALE = 2000;
const MAX_URL = 2000;
const MAX_JOURNAL_TEXT = 4000;
const MAX_OPEN_QUESTION = 500;
const MAX_OPEN_QUESTIONS = 20;

function requireText(value: string, field: string): string {
  const text = cleanText(value);
  if (text === '') refuse('invalid_input', `${field} must not be blank`);
  return text;
}

/** Stages a proposal after the checks every kind shares: the run's proposal budget, and no duplicate of a pending or staged one. */
function fileProposal(
  ctx: ToolContext,
  p: { change: ProposalChange; filedAgainst: unknown; rationale: string; evidence: number[]; effect: ProposalEffect | null },
): Record<string, unknown> {
  if (ctx.ledger.proposals().length >= ctx.budgets.proposals) {
    refuse('proposal_budget', `this run may file at most ${ctx.budgets.proposals} proposals`);
  }
  const pending = findPendingDuplicate(ctx.db, ctx.loaded.config.id, p.change);
  const same = proposalIdentity(p.change);
  if (pending || ctx.ledger.proposals().some((s) => proposalIdentity(s.change) === same)) {
    refuse('duplicate_proposal', 'an identical proposal is already pending', pending ? { proposal_id: pending.id } : { staged_in_this_run: true });
  }
  ctx.ledger.stageProposal(p);
  return { kind: p.change.kind, change: p.change, effect: p.effect, note: 'staged; the user decides after this run commits' };
}

// ---- apply_assumption_change ---------------------------------------------------------------------------------------

const applyAssumptionChange = defineTool({
  name: 'apply_assumption_change',
  description:
    'Changes one assumption, for one scenario or all three, within your band and the max step per run. Needs at least one observation id ' +
    'you have seen in this run as evidence, and a rationale a reader can check. A value outside your band becomes a proposal ' +
    'automatically. A value beyond the max step is refused with the range you may apply. Blocked while a degrading anomaly is open.',
  input: z.strictObject({
    key: z.string(),
    scenario: z.enum([...SCENARIOS, 'all']),
    value: z.number(),
    evidence: z.array(z.number().int()),
    rationale: z.string().max(MAX_RATIONALE),
  }),
  run(ctx, input) {
    const asset = ctx.loaded.config;
    const keys = requiredAssumptionKeys(asset);
    if (!keys.includes(input.key)) refuse('unknown_key', `${input.key} is not an assumption of ${asset.id}`, { keys });
    const rationale = requireText(input.rationale, 'rationale');

    const blocking = blockingAnomalies(listOpenAnomalies(ctx.db, asset.id), ctx.ledger.resolvedAnomalyIds());
    if (blocking.length > 0) {
      refuse('anomaly_block', `open degrading anomalies block assumption writes: ${blocking.map((id) => `#${id}`).join(', ')}. Resolve them first, or propose.`, {
        anomaly_ids: blocking,
      });
    }
    requireEvidence(ctx, input.evidence);

    const scenarios: Scenario[] = input.scenario === 'all' ? [...SCENARIOS] : [input.scenario];
    const starts = new Map<Scenario, number>();
    for (const s of scenarios) {
      const start = ctx.ledger.startValue(input.key, s);
      if (start === undefined) refuse('no_committed_value', `${input.key} (${s}) has no committed value to change`);
      starts.set(s, start as number);
    }

    const outside = scenarios.filter((s) => placeValue(asset, input.key, s, input.value) !== 'in_band');
    if (outside.length > 0) {
      if (input.scenario === 'all') {
        refuse('out_of_band', `${input.value} is outside your band for ${outside.join(', ')}; with scenario "all" every scenario must pass. Call once per scenario.`, {
          scenarios: outside,
        });
      }
      const s = outside[0];
      const placement = placeValue(asset, input.key, s, input.value);
      const change: ProposalChange = { kind: 'assumption_value', key: input.key, scenario: s, value: input.value };
      const staged = fileProposal(ctx, {
        change, filedAgainst: { value: starts.get(s) }, rationale, evidence: input.evidence,
        effect: computeEffect(ctx, [{ key: input.key, value: input.value, scenario: s }]),
      });
      return {
        applied: false,
        converted_to_proposal: staged,
        reason:
          placement === 'out_of_bounds'
            ? `${input.value} is outside the key-wide bounds; approving it will also need a bounds change in the asset config`
            : `${input.value} is outside your band for ${s}`,
        allowed_this_run: allowedRange(asset, input.key, s, starts.get(s) as number),
      };
    }

    for (const s of scenarios) {
      const refusal = checkStep(asset, input.key, s, starts.get(s) as number, input.value);
      if (refusal) throw new ToolRefusal(refusal);
    }
    const errors = validateAssumptions(asset, ctx.ledger.mergedValues(scenarios.map((s) => ({ key: input.key, scenario: s, value: input.value }))));
    if (errors.length > 0) refuse('invalid_set', `the assumption set would be invalid: ${errors.join('; ')}`, { errors });

    for (const s of scenarios) ctx.ledger.stageAssumptionChange({ key: input.key, scenario: s, value: input.value, rationale, evidence: input.evidence });
    return { applied: true, changes: scenarios.map((s) => ({ key: input.key, scenario: s, from: starts.get(s), to: input.value })) };
  },
});

// ---- resolve_anomaly -----------------------------------------------------------------------------------------------

const resolveAnomaly = defineTool({
  name: 'resolve_anomaly',
  description:
    'Resolves an open anomaly, with a note saying what you found and at least one observation id as evidence. A resolved anomaly whose ' +
    'condition persists reopens at the next fetch: for a persistent, understood condition, propose an acknowledgement instead. ' +
    'Acknowledged anomalies are read-only to you.',
  input: z.strictObject({ id: z.number().int(), note: z.string().max(MAX_RATIONALE), evidence: z.array(z.number().int()) }),
  run(ctx, input) {
    const anomaly = getAnomaly(ctx.db, input.id);
    if (!anomaly || anomaly.assetId !== ctx.loaded.config.id) refuse('anomaly_not_found', `no anomaly ${input.id} on ${ctx.loaded.config.id}`);
    const a = anomaly!;
    if (a.status === 'acknowledged') {
      refuse('acknowledged_is_read_only', `anomaly ${a.id} was acknowledged by the user; you may propose withdraw_acknowledgement, not resolve it`);
    }
    if (a.status !== 'open') refuse('anomaly_not_open', `anomaly ${a.id} is already ${a.status}`);
    const note = requireText(input.note, 'note');
    requireEvidence(ctx, input.evidence);
    ctx.ledger.stageResolution({ anomalyId: a.id, note, evidence: input.evidence });
    const stillBlocking = blockingAnomalies(listOpenAnomalies(ctx.db, ctx.loaded.config.id), ctx.ledger.resolvedAnomalyIds());
    return { staged: true, anomaly_id: a.id, anomalies_still_blocking_assumption_writes: stillBlocking };
  },
});

// ---- record_provisional_observation --------------------------------------------------------------------------------

const recordProvisionalObservation = defineTool({
  name: 'record_provisional_observation',
  description:
    'Records a value you found by research, for a manually maintained metric. citation_url must be a page you fetched with web_fetch in ' +
    'this run, and quoted_text must be the page\'s own words (20 characters or more, verbatim, from within one paragraph, table cell, or list item) ' +
    'stating the figure. The row is stored as ' +
    'provisional. On a critical metric, a large move from the last confirmed value becomes a proposal for the user instead of going live. ' +
    'Future dates are for announced schedule changes and events only. You cannot write where an observation already exists at the same metric and time; propose reject_observation for one that is wrong.',
  input: z.strictObject({
    metric: z.string(),
    value: z.number(),
    observed_at: z.string(),
    period_days: z.number().positive().optional(),
    citation_url: z.string().max(MAX_URL),
    quoted_text: z.string().max(MAX_QUOTE),
    note: z.string().max(MAX_RATIONALE).optional(),
  }),
  run(ctx, input) {
    const asset = ctx.loaded.config;
    // Cleaned once, here: the CLEANED quote is what is verified against the page, and what is stored. Verifying the raw
    // text and storing the cleaned one (or the other way round) would mean the stored quote was never the checked one.
    const citationUrl = cleanText(input.citation_url);
    const quotedText = cleanText(input.quoted_text);
    const note = input.note === undefined ? '' : cleanText(input.note);
    const def = asset.metrics[input.metric];
    if (!def) refuse('unknown_metric', `${input.metric} is not a metric of ${asset.id}`);
    if (def.source !== undefined) refuse('fetched_metric', `${input.metric} is fetched from a configured source; research never writes onto a fetched metric`);

    const at = new Date(input.observed_at);
    if (Number.isNaN(at.getTime())) refuse('invalid_timestamp', `invalid observed_at: ${input.observed_at}`);
    const observedAt = at.toISOString();
    const now = ctx.now();
    if (at.getTime() > now.getTime() && def.type !== 'schedule' && def.type !== 'event') {
      refuse('future_observation', `${input.metric} is a ${def.type} metric; only schedule and event metrics may be dated in the future`);
    }
    if (def.type === 'flow' && input.period_days === undefined) refuse('period_required', `${input.metric} is a flow metric; give period_days`);

    // The agent never supersedes an observation: the ledger refuses it at commit too. Say so now, while it can still act.
    const taken = listActiveObservations(ctx.db, asset.id, input.metric).find((o) => o.observedAt === observedAt);
    if (taken) {
      refuse(
        'observation_exists',
        `observation #${taken.id} of ${input.metric} at ${observedAt} already exists (${taken.status}, value ${taken.value}); you never supersede one. If it is wrong, propose reject_observation.`,
        { observation_id: taken.id },
      );
    }

    const citation = verifyCitation(ctx.fetchedPages(), citationUrl, quotedText);
    if (citation) throw new ToolRefusal(citation);

    // The last CONFIRMED value: measuring from a provisional row would let the guard compound from run to run.
    const inForce = valueInForce(ctx.db, asset, input.metric, now.toISOString(), { confirmedOnly: true });
    const movePct = provisionalMovePct(asset);
    const route = routeObservation({ allowProvisional: def.allow_provisional, critical: def.critical, inForce, value: input.value, movePct });
    const periodDays = input.period_days ?? null;

    if (route === 'proposal') {
      const change: ProposalChange = {
        kind: 'observation', metricKey: input.metric, value: input.value, observedAt, periodDays, citationUrl, quotedText,
      };
      const preview: Observation = {
        id: -1_000_000, assetId: asset.id, metricKey: input.metric, observedAt, periodDays, value: input.value, source: 'manual',
        sourceDetail: null, status: 'confirmed', citationUrl, quotedText, fetchedAt: now.toISOString(), supersededBy: null,
      };
      const why =
        inForce === null
          ? `${input.metric} is critical and there is no confirmed value to compare ${input.value} against`
          : `${input.metric} is critical and ${input.value} is more than ${movePct}% from the last confirmed value (${inForce})`;
      const staged = fileProposal(ctx, {
        change, filedAgainst: { inForce }, rationale: note ? `${note} (${why})` : why, evidence: [],
        effect: computeEffect(ctx, [], { addObservations: [preview] }),
      });
      return { recorded: false, converted_to_proposal: staged, reason: `${why}; it cannot be cited as evidence until the user approves it` };
    }

    const staged = ctx.ledger.stageObservation({
      metricKey: input.metric, value: input.value, observedAt, periodDays, citationUrl, quotedText, live: route === 'live',
    });
    return {
      recorded: true,
      observation_id: staged.tempId,
      in_signal: route === 'live',
      note:
        route === 'live'
          ? 'provisional; it will be in the next signal, at data-quality grade C. You may cite this id as evidence in this run.'
          : `provisional; ${input.metric} does not allow provisional data, so it stays out of the signal until the user confirms it. You may cite this id as evidence in this run.`,
    };
  },
});

// ---- propose_change ------------------------------------------------------------------------------------------------

const PROPOSABLE_KINDS = ['assumption_value', 'config', 'acknowledge_anomaly', 'withdraw_acknowledgement', 'confirm_observation', 'reject_observation'] as const;

const proposeChange = defineTool({
  name: 'propose_change',
  description:
    'Files a proposal for the user to approve or reject. Kinds and the fields each needs: assumption_value (key, scenario, value, evidence); ' +
    'config (edits: a list of {path, value}, where path is a list of segments into the asset config, a string segment selects a map key or ' +
    'the list item with that id, and a null value deletes; all edits must leave the config valid together, so change weights in one proposal); ' +
    'acknowledge_anomaly and withdraw_acknowledgement (anomaly_id); confirm_observation and reject_observation (observation_id). ' +
    'Proposals that can move the target store the computed effect. The rationale is what the user reads: make the case.',
  input: z.strictObject({
    kind: z.enum(PROPOSABLE_KINDS),
    rationale: z.string().max(MAX_RATIONALE),
    evidence: z.array(z.number().int()).optional(),
    key: z.string().optional(),
    scenario: z.enum(SCENARIOS).optional(),
    value: z.number().optional(),
    edits: z.array(z.strictObject({ path: z.array(z.union([z.string(), z.number().int()])).min(1), value: z.unknown() })).min(1).optional(),
    anomaly_id: z.number().int().optional(),
    observation_id: z.number().int().optional(),
  }),
  run(ctx, input) {
    const asset = ctx.loaded.config;
    const rationale = requireText(input.rationale, 'rationale');
    const evidence = input.evidence ?? [];
    if (evidence.length > 0 || input.kind === 'assumption_value') requireEvidence(ctx, evidence);

    switch (input.kind) {
      case 'assumption_value': {
        if (input.key === undefined || input.scenario === undefined || input.value === undefined) {
          refuse('invalid_input', 'assumption_value needs key, scenario, and value');
        }
        const key = input.key as string;
        const scenario = input.scenario as Scenario;
        const value = input.value as number;
        const keys = requiredAssumptionKeys(asset);
        if (!keys.includes(key)) refuse('unknown_key', `${key} is not an assumption of ${asset.id}`, { keys });
        const committed = ctx.ledger.startValue(key, scenario);
        if (committed === value) refuse('no_change', `${key} (${scenario}) is already ${value}`);
        return fileProposal(ctx, {
          change: { kind: 'assumption_value', key, scenario, value }, filedAgainst: { value: committed ?? null }, rationale, evidence,
          effect: computeEffect(ctx, [{ key, value, scenario }]),
        });
      }

      case 'config': {
        if (input.edits === undefined) refuse('invalid_input', 'config needs edits');
        const edits = (input.edits ?? []).map((e) => ({ path: e.path, value: e.value ?? null }));
        const blocked = unproposableEdits(edits);
        if (blocked.length > 0) {
          refuse('path_not_proposable', `nothing under ${UNPROPOSABLE_ROOTS.join(' or ')} can be proposed`, { paths: blocked.map((e) => e.path) });
        }
        const raw = rawConfig(ctx.loaded);
        const filedAgainst = edits.map((e) => getAtPath(raw, e.path));
        if (edits.every((e, i) => canonicalJson(e.value) === canonicalJson(filedAgainst[i]))) refuse('no_change', 'these edits change nothing');
        const edited = parseAssetObject(applyEditsToObject(raw, edits)); // throws invalid_asset_config, which the model sees as a refusal
        const moduleErrors = validateAssetModules(edited.config);
        if (moduleErrors.length > 0) refuse('invalid_config', moduleErrors.join('; '), { errors: moduleErrors });
        const assumptionErrors = validateAssumptions(edited.config, ctx.ledger.mergedValues());
        if (assumptionErrors.length > 0) {
          refuse('assumptions_invalid_under_config', `the current assumptions would be invalid under this config: ${assumptionErrors.join('; ')}`, {
            errors: assumptionErrors,
          });
        }
        return fileProposal(ctx, {
          change: { kind: 'config', edits }, filedAgainst, rationale, evidence, effect: computeEffect(ctx, [], { config: edited.config }),
        });
      }

      case 'acknowledge_anomaly':
      case 'withdraw_acknowledgement': {
        if (input.anomaly_id === undefined) refuse('invalid_input', `${input.kind} needs anomaly_id`);
        const anomaly = getAnomaly(ctx.db, input.anomaly_id as number);
        if (!anomaly || anomaly.assetId !== asset.id) refuse('anomaly_not_found', `no anomaly ${input.anomaly_id} on ${asset.id}`);
        const needed = input.kind === 'acknowledge_anomaly' ? 'open' : 'acknowledged';
        if (anomaly!.status !== needed) refuse('wrong_anomaly_status', `anomaly ${anomaly!.id} is ${anomaly!.status}; ${input.kind} needs it ${needed}`);
        return fileProposal(ctx, {
          change: { kind: input.kind, anomalyId: anomaly!.id, note: rationale }, filedAgainst: { status: needed }, rationale, evidence, effect: null,
        });
      }

      case 'confirm_observation':
      case 'reject_observation': {
        if (input.observation_id === undefined) refuse('invalid_input', `${input.kind} needs observation_id`);
        const o = getObservationsByIds(ctx.db, [input.observation_id as number])[0];
        if (!o || o.assetId !== asset.id) refuse('observation_not_found', `no observation ${input.observation_id} on ${asset.id}`);
        if (!isActive(o)) refuse('not_active', `observation ${o.id} is not active`);
        const confirming = input.kind === 'confirm_observation';
        if (confirming && o.status !== 'provisional') refuse('not_provisional', `observation ${o.id} is already ${o.status}`);
        return fileProposal(ctx, {
          change: { kind: input.kind, observationId: o.id, note: rationale },
          filedAgainst: { status: o.status, active: true }, rationale, evidence,
          effect: computeEffect(ctx, [], confirming ? { addObservations: [{ ...o, status: 'confirmed' }] } : { removeObservationIds: [o.id] }),
        });
      }
    }
  },
});

// ---- write_journal -------------------------------------------------------------------------------------------------

const writeJournal = defineTool({
  name: 'write_journal',
  description:
    'Your journal entry for this run: the only thing the next run will remember. thesis is your running view of the asset; open_questions ' +
    'is what the next run should look at; summary is what you did in this run and why. Required before you finish. A second call replaces the first.',
  input: z.strictObject({
    thesis: z.string().max(MAX_JOURNAL_TEXT),
    open_questions: z.array(z.string().max(MAX_OPEN_QUESTION)).max(MAX_OPEN_QUESTIONS),
    summary: z.string().max(MAX_JOURNAL_TEXT),
  }),
  run(ctx, input) {
    ctx.ledger.setJournal({
      thesis: requireText(input.thesis, 'thesis'),
      openQuestions: input.open_questions.map((q) => cleanText(q)).filter((q) => q !== ''),
      summary: requireText(input.summary, 'summary'),
    });
    return { staged: true };
  },
});

export const WRITE_TOOLS: AgentTool[] = [applyAssumptionChange, proposeChange, resolveAnomaly, recordProvisionalObservation, writeJournal];
