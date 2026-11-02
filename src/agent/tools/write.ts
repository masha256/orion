import { z } from 'zod';
import { valueInForce } from '../../app/eligibility.js';
import { PROVISIONAL_MOVE_PCT } from '../../config/agentPolicy.js';
import { applyEditsToObject, getAtPath, UNPROPOSABLE_ROOTS, unproposableEdits } from '../../config/edit.js';
import { parseAssetObject, rawConfig } from '../../config/load.js';
import { getAnomaly } from '../../db/anomalies.js';
import { CATALYST_KINDS, type Catalyst } from '../../db/journal.js';
import { getObservationsByIds, listActiveObservations, type Observation } from '../../db/observations.js';
import { findPendingDuplicate, proposalIdentity, type ProposalChange } from '../../db/proposals.js';
import { isIsoDate } from '../../ingest/time.js';
import { canonicalJson, sha256 } from '../../util/canonical.js';
import { checkEvidence, cleanText, routeObservation, verifyAnyCitation, TRANSCRIPT_WINDOW, type EvidenceRef, type StoredCitation } from '../guardrails.js';
import { DEV_FINDING_CATEGORIES, VALUE_DIRECTIONS, type StagedProposal } from '../ledger.js';
import { defineTool, refuse, ToolRefusal, type AgentTool, type ToolContext } from './types.js';

const isActive = (o: Observation): boolean => o.supersededBy === null && o.status !== 'rejected';

/** A lookup over the cited ids: the stored ones are read up front, since `checkEvidence` looks them up synchronously. */
async function evidenceLookup(ctx: ToolContext, ids: number[]): Promise<(id: number) => EvidenceRef | null> {
  const stored = new Map((await getObservationsByIds(ctx.db, ids.filter((id) => id >= 0))).map((o) => [o.id, o]));
  return (id) => {
    if (id < 0) return ctx.ledger.hasStagedObservation(id) ? { assetId: ctx.loaded.config.id, active: true } : null;
    const o = stored.get(id);
    return o ? { assetId: o.assetId, active: isActive(o) } : null;
  };
}

async function requireEvidence(ctx: ToolContext, ids: number[]): Promise<void> {
  const refusal = checkEvidence(ids, ctx.loaded.config.id, await evidenceLookup(ctx, ids), ctx.ledger.shown);
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
const MAX_PROPOSAL_CITATIONS = 5;
export const MAX_CATALYSTS = 8;
const MAX_CATALYST_EVENT = 200;
const MAX_CATALYST_CITATIONS = 3;
export const MAX_DEV_FINDINGS = 5;
const MAX_FINDING_TITLE = 120;
const MAX_FINDING_TEXT = 1000;
const MAX_FINDING_FIX = 1500;
const MAX_FINDING_METRICS = 6;
const MAX_FINDING_CITATIONS = 5;

function requireText(value: string, field: string): string {
  const text = cleanText(value);
  if (text === '') refuse('invalid_input', `${field} must not be blank`);
  return text;
}

/**
 * Verifies every citation the model gave, cleaned first so the stored quote is the checked one. One that fails refuses
 * the whole call: nothing is ever staged on a subset of its sources. A citation given twice (the same source, quote and
 * locator once cleaned) is kept once, at its first place.
 */
function verifyCitations(ctx: ToolContext, input: { source: string; quoted_text: string }[], whose?: string): StoredCitation[] {
  const sources = { pages: ctx.fetchedPages(), docs: ctx.citableDocs() };
  const seen = new Set<string>();
  return input.flatMap((c) => {
    const verified = verifyAnyCitation(sources, { source: cleanText(c.source), quoted_text: cleanText(c.quoted_text) });
    if ('refusal' in verified) {
      throw new ToolRefusal(whose === undefined ? verified.refusal : { ...verified.refusal, message: `${whose}: ${verified.refusal.message}` });
    }
    const key = JSON.stringify([verified.citation.source, verified.citation.quotedText, verified.citation.locator]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [verified.citation];
  });
}

/** Refuses `citation_required` unless at least one verified citation is of the run's target document; with no target document, always. */
function requireTargetDocCitation(ctx: ToolContext, citations: StoredCitation[], what: string): void {
  const target = ctx.targetDoc === null ? null : `doc:${ctx.targetDoc.id}`;
  if (target === null || !citations.some((c) => c.source === target)) {
    refuse('citation_required', `${what} must cite its document: give at least one citation of ${target ?? 'the target document'}, quoted verbatim`);
  }
}

/** A proposal's citations: all verified, and in a disclosure run at least one of the target document (spec 5.4); elsewhere optional. */
function verifyProposalCitations(ctx: ToolContext, input: { source: string; quoted_text: string }[]): StoredCitation[] {
  const citations = verifyCitations(ctx, input);
  if (ctx.runType === 'disclosure') requireTargetDocCitation(ctx, citations, "a disclosure run's proposal");
  return citations;
}

/**
 * Stages a proposal after the checks every kind shares: the run's proposal budget, and no duplicate of a pending or staged
 * one. Its effect is null: the 6m/12m target move a proposal used to carry went with the valuation.
 */
async function fileProposal(ctx: ToolContext, filed: Omit<StagedProposal, 'effect'>): Promise<Record<string, unknown>> {
  const p: StagedProposal = { ...filed, effect: null };
  if (ctx.ledger.proposals().length >= ctx.budgets.proposals) {
    refuse('proposal_budget', `this run may file at most ${ctx.budgets.proposals} proposals`);
  }
  const pending = await findPendingDuplicate(ctx.db, ctx.loaded.config.id, p.change);
  const same = proposalIdentity(p.change);
  if (pending || ctx.ledger.proposals().some((s) => proposalIdentity(s.change) === same)) {
    refuse('duplicate_proposal', 'an identical proposal is already pending', pending ? { proposal_id: pending.id } : { staged_in_this_run: true });
  }
  ctx.ledger.stageProposal(p);
  return { kind: p.change.kind, change: p.change, note: 'staged; the user decides after this run commits' };
}

// ---- resolve_anomaly -----------------------------------------------------------------------------------------------

const resolveAnomaly = defineTool({
  name: 'resolve_anomaly',
  description:
    'Resolves an open anomaly, with a note saying what you found and at least one observation id as evidence. A resolved anomaly whose ' +
    'condition persists reopens at the next fetch: for a persistent, understood condition, propose an acknowledgement instead. ' +
    'Acknowledged anomalies are read-only to you.',
  input: z.strictObject({ id: z.number().int(), note: z.string().max(MAX_RATIONALE), evidence: z.array(z.number().int()) }),
  async run(ctx, input) {
    const anomaly = await getAnomaly(ctx.db, input.id);
    if (!anomaly || anomaly.assetId !== ctx.loaded.config.id) refuse('anomaly_not_found', `no anomaly ${input.id} on ${ctx.loaded.config.id}`);
    const a = anomaly!;
    if (a.status === 'acknowledged') {
      refuse('acknowledged_is_read_only', `anomaly ${a.id} was acknowledged by the user; you may propose withdraw_acknowledgement, not resolve it`);
    }
    if (a.status !== 'open') refuse('anomaly_not_open', `anomaly ${a.id} is already ${a.status}`);
    const note = requireText(input.note, 'note');
    await requireEvidence(ctx, input.evidence);
    ctx.ledger.stageResolution({ anomalyId: a.id, note, evidence: input.evidence });
    return { staged: true, anomaly_id: a.id };
  },
});

// ---- record_provisional_observation --------------------------------------------------------------------------------

const recordProvisionalObservation = defineTool({
  name: 'record_provisional_observation',
  description:
    'Records a value you found by research, for a manually maintained metric. citation_url is the URL of a page you fetched, or doc:<id> ' +
    'for the stored document in your context pack. quoted_text must be the source\'s own words (20 characters or more, verbatim, from within ' +
    `one paragraph, table cell, or list item; in a transcript, within ${TRANSCRIPT_WINDOW} consecutive segments, without the [mm:ss] stamps) ` +
    'stating the figure. The row is stored as provisional and listed in the inbox for the user to confirm or reject; Orion\'s reports read ' +
    'confirmed rows only. A figure from a machine transcript, and every figure in a disclosure run, always waits for the user: on a ' +
    'metric that allows provisional data it becomes a proposal for the user, otherwise the row stays provisional until the user confirms it. ' +
    'On a critical metric, a large move from the last confirmed value becomes a proposal for the user instead of going live. ' +
    'Future dates are for announced schedule changes and events only. A fetched metric takes a researched row only when it is a schedule or event ' +
    'metric and the date is in the future: an announced change with its effective date. Fetched levels and flows never take one. ' +
    'You cannot write where an observation already exists at the same metric and time; propose reject_observation for one that is wrong.',
  input: z.strictObject({
    metric: z.string(),
    value: z.number(),
    observed_at: z.string(),
    period_days: z.number().positive().optional(),
    citation_url: z.string().max(MAX_URL),
    quoted_text: z.string().max(MAX_QUOTE),
    note: z.string().max(MAX_RATIONALE).optional(),
  }),
  async run(ctx, input) {
    const asset = ctx.loaded.config;
    // Cleaned once, here: the CLEANED quote is what is verified against the page, and what is stored. Verifying the raw
    // text and storing the cleaned one (or the other way round) would mean the stored quote was never the checked one.
    const citationUrl = cleanText(input.citation_url);
    const quotedText = cleanText(input.quoted_text);
    const note = input.note === undefined ? '' : cleanText(input.note);
    const def = asset.metrics[input.metric];
    if (!def) refuse('unknown_metric', `${input.metric} is not a metric of ${asset.id}`);

    const at = new Date(input.observed_at);
    if (Number.isNaN(at.getTime())) refuse('invalid_timestamp', `invalid observed_at: ${input.observed_at}`);
    const observedAt = at.toISOString();
    const now = ctx.now();
    // An announcement: a schedule step or an event dated after now. The only row research may add to a FETCHED metric,
    // because the fetch owns the present: a reading dated at or before now is what the chain or the API says, not a claim.
    const announcement = at.getTime() > now.getTime() && (def.type === 'schedule' || def.type === 'event');
    if (def.source !== undefined && !announcement) {
      refuse(
        'fetched_metric',
        def.type === 'schedule' || def.type === 'event'
          ? `${input.metric} is fetched from a configured source: the fetch owns the present, so research may only record an announced change dated after now`
          : `${input.metric} is fetched from a configured source; research never writes onto a fetched ${def.type} metric (only a schedule or event metric takes an announced, future-dated row)`,
      );
    }
    if (at.getTime() > now.getTime() && !announcement) {
      refuse('future_observation', `${input.metric} is a ${def.type} metric; only schedule and event metrics may be dated in the future`);
    }
    if (def.type === 'flow' && input.period_days === undefined) refuse('period_required', `${input.metric} is a flow metric; give period_days`);

    // The agent never supersedes an observation: the ledger refuses it at commit too. Say so now, while it can still act.
    const taken = (await listActiveObservations(ctx.db, asset.id, input.metric)).find((o) => o.observedAt === observedAt);
    if (taken) {
      refuse(
        'observation_exists',
        `observation #${taken.id} of ${input.metric} at ${observedAt} already exists (${taken.status}, value ${taken.value}); you never supersede one. If it is wrong, propose reject_observation.`,
        { observation_id: taken.id },
      );
    }

    const verified = verifyAnyCitation({ pages: ctx.fetchedPages(), docs: ctx.citableDocs() }, { source: citationUrl, quoted_text: quotedText });
    if ('refusal' in verified) throw new ToolRefusal(verified.refusal);
    // The canonical source (`doc:<id>` for a document) is what is stored, on a row or on a proposal.
    const source = verified.citation.source;

    // The last CONFIRMED value: measuring from a provisional row would let the guard compound from run to run.
    const inForce = await valueInForce(ctx.db, asset, input.metric, now.toISOString(), { confirmedOnly: true });
    // A figure from a machine transcript may be misheard: it is never read as the value in force unconfirmed (spec
    // invariant 3). A figure from a disclosure run, whatever it cites, waits for the user too (spec section 15, Ruling 18):
    // the run reads the issuer's own claims. A provisional row is eligible on a metric that allows provisional data, so
    // there it goes to the user as a proposal, whatever the move or the metric's criticality; elsewhere a provisional row
    // is inert until confirmed.
    const fromMachineTranscript = verified.citation.docKind === 'machine_transcript';
    const fromDisclosureRun = ctx.runType === 'disclosure';
    const route = fromMachineTranscript || fromDisclosureRun
      ? def.allow_provisional ? 'proposal' : 'inert'
      : routeObservation({ allowProvisional: def.allow_provisional, critical: def.critical, inForce, value: input.value, movePct: PROVISIONAL_MOVE_PCT });
    const periodDays = input.period_days ?? null;

    if (route === 'proposal') {
      const change: ProposalChange = {
        kind: 'observation', metricKey: input.metric, value: input.value, observedAt, periodDays, citationUrl: source, quotedText,
      };
      const why = fromMachineTranscript
        ? `${source} is a machine transcript, which may be misheard: a figure from a machine transcript always goes to the user`
        : fromDisclosureRun
          ? 'this is a disclosure run: a figure from a disclosure run always goes to the user'
          : inForce === null
          ? `${input.metric} is critical and there is no confirmed value to compare ${input.value} against`
          : `${input.metric} is critical and ${input.value} is more than ${PROVISIONAL_MOVE_PCT}% from the last confirmed value (${inForce})`;
      const staged = await fileProposal(ctx, {
        change, filedAgainst: { inForce }, rationale: note ? `${note} (${why})` : why, evidence: [], citations: [verified.citation],
      });
      return { recorded: false, converted_to_proposal: staged, reason: `${why}; it cannot be cited as evidence until the user approves it` };
    }

    const staged = ctx.ledger.stageObservation({
      metricKey: input.metric, value: input.value, observedAt, periodDays, citationUrl: source, quotedText, live: route === 'live',
    });
    return {
      recorded: true,
      observation_id: staged.tempId,
      note:
        route === 'live'
          ? 'provisional; listed in the inbox for the user to confirm or reject. You may cite this id as evidence in this run.'
          : `provisional; ${
            fromMachineTranscript
              ? 'it cites a machine transcript'
              : fromDisclosureRun ? 'it comes from a disclosure run' : `${input.metric} does not allow provisional data`
          }, so it is not read as the value in force; it is listed in the inbox until the user confirms or rejects it. You may cite this id as evidence in this run.`,
    };
  },
});

// ---- propose_change ------------------------------------------------------------------------------------------------

/** assumption_value is retired: stored ones still list and reject, but none can be filed or approved. */
const PROPOSABLE_KINDS = ['config', 'acknowledge_anomaly', 'withdraw_acknowledgement', 'confirm_observation', 'reject_observation'] as const;

const proposeChange = defineTool({
  name: 'propose_change',
  description:
    'Files a proposal for the user to approve or reject. Kinds and the fields each needs: config (edits: a list of {path, value}, where path is a list of segments into the asset config, a string segment selects a map key or ' +
    'the list item with that id, and a null value deletes; all edits must leave the config valid together, so change weights in one proposal); ' +
    'acknowledge_anomaly and withdraw_acknowledgement (anomaly_id); confirm_observation and reject_observation (observation_id). ' +
    'evidence (optional) is observation ids you have seen in this run. The rationale is what the user reads: make the case. ' +
    `citations (at most ${MAX_PROPOSAL_CITATIONS}): each a {source, quoted_text}, source the URL of a page you fetched or doc:<id> for the stored ` +
    'document in your context pack, quoted_text its own words under the same rules as record_provisional_observation. Every citation is ' +
    'verified; one that fails refuses the whole proposal. In a disclosure run at least one must cite the target document.',
  input: z.strictObject({
    kind: z.enum(PROPOSABLE_KINDS),
    rationale: z.string().max(MAX_RATIONALE),
    evidence: z.array(z.number().int()).optional(),
    edits: z.array(z.strictObject({ path: z.array(z.union([z.string(), z.number().int()])).min(1), value: z.unknown() })).min(1).optional(),
    anomaly_id: z.number().int().optional(),
    observation_id: z.number().int().optional(),
    citations: z.array(z.strictObject({ source: z.string().max(MAX_URL), quoted_text: z.string().max(MAX_QUOTE) })).max(MAX_PROPOSAL_CITATIONS).optional(),
  }),
  async run(ctx, input) {
    const asset = ctx.loaded.config;
    const rationale = requireText(input.rationale, 'rationale');
    const evidence = input.evidence ?? [];
    if (evidence.length > 0) await requireEvidence(ctx, evidence);
    const citations = verifyProposalCitations(ctx, input.citations ?? []);

    switch (input.kind) {
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
        parseAssetObject(applyEditsToObject(raw, edits)); // throws invalid_asset_config, which the model sees as a refusal
        return fileProposal(ctx, { change: { kind: 'config', edits }, filedAgainst, rationale, evidence, citations });
      }

      case 'acknowledge_anomaly':
      case 'withdraw_acknowledgement': {
        if (input.anomaly_id === undefined) refuse('invalid_input', `${input.kind} needs anomaly_id`);
        const anomaly = await getAnomaly(ctx.db, input.anomaly_id as number);
        if (!anomaly || anomaly.assetId !== asset.id) refuse('anomaly_not_found', `no anomaly ${input.anomaly_id} on ${asset.id}`);
        const needed = input.kind === 'acknowledge_anomaly' ? 'open' : 'acknowledged';
        if (anomaly!.status !== needed) refuse('wrong_anomaly_status', `anomaly ${anomaly!.id} is ${anomaly!.status}; ${input.kind} needs it ${needed}`);
        return fileProposal(ctx, {
          change: { kind: input.kind, anomalyId: anomaly!.id, note: rationale }, filedAgainst: { status: needed }, rationale, evidence, citations,
        });
      }

      case 'confirm_observation':
      case 'reject_observation': {
        if (input.observation_id === undefined) refuse('invalid_input', `${input.kind} needs observation_id`);
        const o = (await getObservationsByIds(ctx.db, [input.observation_id as number]))[0];
        if (!o || o.assetId !== asset.id) refuse('observation_not_found', `no observation ${input.observation_id} on ${asset.id}`);
        if (!isActive(o)) refuse('not_active', `observation ${o.id} is not active`);
        const confirming = input.kind === 'confirm_observation';
        if (confirming && o.status !== 'provisional') refuse('not_provisional', `observation ${o.id} is already ${o.status}`);
        return fileProposal(ctx, {
          change: { kind: input.kind, observationId: o.id, note: rationale },
          filedAgainst: { status: o.status, active: true }, rationale, evidence, citations,
        });
      }
    }
  },
});

// ---- write_journal -------------------------------------------------------------------------------------------------

/** Either `by`, or both `from` and `to` with `from <= to`; never both forms, never neither. */
function catalystDates(c: { event: string; by?: string; from?: string; to?: string }): Pick<Catalyst, 'by' | 'from' | 'to'> {
  const bad = (why: string): never => refuse('invalid_catalyst_dates', `catalyst "${c.event}": ${why}`);
  const given = [c.by, c.from, c.to].filter((d): d is string => d !== undefined);
  for (const d of given) if (!isIsoDate(d)) bad(`${d} is not a date in the form YYYY-MM-DD`);
  if (c.by !== undefined) {
    if (c.from !== undefined || c.to !== undefined) bad('give either by, or from and to, not both');
    return { by: c.by };
  }
  if (c.from === undefined || c.to === undefined) bad('give either by, or both from and to');
  if ((c.from as string) > (c.to as string)) bad(`from ${c.from} is after to ${c.to}`);
  return { from: c.from, to: c.to };
}

const writeJournal = defineTool({
  name: 'write_journal',
  description:
    'Your journal entry for this run: the only thing the next run will remember. thesis is your running view of the asset; open_questions ' +
    'is what the next run should look at; summary is what you did in this run and why. Required before you finish. A second call replaces the first. ' +
    `catalysts (at most ${MAX_CATALYSTS}): dated claims a source makes about what will happen, each {event, kind, by} or {event, kind, from, to} ` +
    `(dates YYYY-MM-DD, from <= to) with 1 to ${MAX_CATALYST_CITATIONS} citations, {source, quoted_text}, under the same rules as propose_change; ` +
    'in a disclosure run each catalyst cites the target document at least once. ' +
    'Every citation is verified; one that fails refuses the whole entry. A catalyst schedules nothing: a later run sees it when its date comes near.',
  input: z.strictObject({
    thesis: z.string().max(MAX_JOURNAL_TEXT),
    open_questions: z.array(z.string().max(MAX_OPEN_QUESTION)).max(MAX_OPEN_QUESTIONS),
    summary: z.string().max(MAX_JOURNAL_TEXT),
    catalysts: z
      .array(
        z.strictObject({
          event: z.string().max(MAX_CATALYST_EVENT),
          kind: z.enum(CATALYST_KINDS),
          by: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          citations: z.array(z.strictObject({ source: z.string().max(MAX_URL), quoted_text: z.string().max(MAX_QUOTE) })).min(1).max(MAX_CATALYST_CITATIONS),
        }),
      )
      .max(MAX_CATALYSTS)
      .optional(),
  }),
  run(ctx, input) {
    const thesis = requireText(input.thesis, 'thesis');
    const summary = requireText(input.summary, 'summary');
    // Allowed in every run type, and every quote must verify. In a disclosure run each catalyst must also cite the run's
    // document (spec section 15, Ruling 9): the run reads one document, so a catalyst it records comes from that document.
    const catalysts: Catalyst[] = (input.catalysts ?? []).map((c) => {
      const event = requireText(c.event, 'event');
      const whose = `catalyst "${event}"`;
      // Dates first, then citations: a malformed date is named before any quote is checked, in every run type.
      const dates = catalystDates({ ...c, event });
      const citations = verifyCitations(ctx, c.citations, whose);
      if (ctx.runType === 'disclosure') requireTargetDocCitation(ctx, citations, whose);
      return { event, kind: c.kind, ...dates, citations };
    });
    ctx.ledger.setJournal({ thesis, openQuestions: input.open_questions.map((q) => cleanText(q)).filter((q) => q !== ''), summary, catalysts });
    return { staged: true };
  },
});

// ---- record_dev_finding --------------------------------------------------------------------------------------------

const recordDevFinding = defineTool({
  name: 'record_dev_finding',
  description:
    'Records something the document shows Orion measures wrong or not at all, for the developer: a missing source, a mis-mapped flow, a ' +
    'supply or unlock figure Orion does not track. Not a proposal: nothing changes, and the user does not decide it. category is holder_flow, ' +
    'revenue, supply, unlocks, source, or other; metric_keys (1 to 6) are the asset\'s metrics it is about; claim is what the document says, in ' +
    'your words; orion_reading is what Orion measures for the same thing and period, with numbers (get_flow_total sums a flow); value_direction ' +
    'is which way a fix would move the asset\'s targets (up, down, none, unknown); proposed_fix is what to change. evidence: at least one ' +
    `observation id you have seen in this run. citations (1 to ${MAX_FINDING_CITATIONS}): {source, quoted_text} under the same rules as ` +
    'propose_change, at least one of the target document. Every citation is verified. ' +
    `At most ${MAX_DEV_FINDINGS} a run; a finding with the same category and metric keys as an earlier one replaces it.`,
  input: z.strictObject({
    category: z.enum(DEV_FINDING_CATEGORIES),
    title: z.string().max(MAX_FINDING_TITLE),
    metric_keys: z.array(z.string()).min(1).max(MAX_FINDING_METRICS),
    claim: z.string().max(MAX_FINDING_TEXT),
    orion_reading: z.string().max(MAX_FINDING_TEXT),
    value_direction: z.enum(VALUE_DIRECTIONS),
    proposed_fix: z.string().max(MAX_FINDING_FIX),
    evidence: z.array(z.number().int()),
    citations: z.array(z.strictObject({ source: z.string().max(MAX_URL), quoted_text: z.string().max(MAX_QUOTE) })).min(1).max(MAX_FINDING_CITATIONS),
  }),
  async run(ctx, input) {
    const asset = ctx.loaded.config;
    const title = requireText(input.title, 'title');
    const claim = requireText(input.claim, 'claim');
    const orionReading = requireText(input.orion_reading, 'orion_reading');
    const proposedFix = requireText(input.proposed_fix, 'proposed_fix');
    const undeclared = input.metric_keys.filter((k) => !asset.metrics[k]);
    if (undeclared.length > 0) {
      refuse('unknown_metric', `${undeclared.join(', ')} ${undeclared.length === 1 ? 'is not a metric' : 'are not metrics'} of ${asset.id}`, {
        metrics: Object.keys(asset.metrics).sort(),
      });
    }
    // Sorted and deduplicated: the order the model named them in is not part of what the finding is.
    const metricKeys = [...new Set(input.metric_keys)].sort();
    await requireEvidence(ctx, input.evidence);
    const citations = verifyCitations(ctx, input.citations);
    // Defensive: the tool is offered to disclosure runs only, and only those have a target document.
    requireTargetDocCitation(ctx, citations, 'a dev finding');

    const replacing = ctx.ledger.hasDevFinding({ category: input.category, metricKeys });
    if (!replacing && ctx.ledger.devFindings().length >= MAX_DEV_FINDINGS) {
      refuse('dev_finding_limit', `this run may record at most ${MAX_DEV_FINDINGS} dev findings; a finding with the same category and metric keys replaces one`);
    }
    const fingerprint = sha256(`${asset.id}|${input.category}|${metricKeys.join(',')}|${ctx.targetDoc!.sha256}`);
    const { replaced } = ctx.ledger.stageDevFinding({
      category: input.category, title, metricKeys, claim, orionReading, valueDirection: input.value_direction, proposedFix, evidence: input.evidence,
      citations, fingerprint,
    });
    return { staged: true, replaced, fingerprint, findings_staged: ctx.ledger.devFindings().length };
  },
});

export const WRITE_TOOLS: AgentTool[] = [resolveAnomaly, recordProvisionalObservation, proposeChange, writeJournal, recordDevFinding];
