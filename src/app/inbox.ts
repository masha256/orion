import { z } from 'zod';
import type { AssetConfig } from '../config/schema.js';
import { listAnomalies } from '../db/anomalies.js';
import type { Db } from '../db/connection.js';
import { listActiveObservations, type Observation } from '../db/observations.js';
import { listProposals } from '../db/proposals.js';
import { valueInForce } from './eligibility.js';

/**
 * Everything awaiting the user's decision on one asset: provisional observations to confirm or reject, pending
 * proposals to approve or decline, open anomalies to ack or resolve. Ids, kinds, dates, and Orion's own numbers only:
 * never a quote, a note, or a rationale. A citation URL is the one model-chosen string here, and the scheduled agent
 * that reads the inbox every day is told never to fetch one.
 */

const EffectSchema = z.union([
  z.strictObject({
    '6m': z.strictObject({ from: z.number().nullable(), to: z.number() }),
    '12m': z.strictObject({ from: z.number().nullable(), to: z.number() }),
  }),
  z.strictObject({ blocked: z.array(z.string()) }),
]);

export const InboxSchema = z.strictObject({
  /** Every active provisional row, whoever wrote it, newest first. */
  observations: z.array(
    z.strictObject({
      id: z.number().int(),
      metric: z.string(),
      value: z.number(),
      observed_at: z.string(),
      period_days: z.number().nullable(),
      unit: z.string().nullable(),
      citation_url: z.string().nullable(),
      /** Parsed from the research ledger's source detail; null for a row the user entered. */
      recorded_by: z.strictObject({ persona: z.string(), agent_run_id: z.number().int().nullable() }).nullable(),
      /** Percent against the last CONFIRMED value in force at observed_at, the move guard's own baseline; null when there is none. */
      move_pct: z.number().nullable(),
    }),
  ),
  proposals: z.array(
    z.strictObject({
      id: z.number().int(),
      kind: z.string(),
      persona: z.string(),
      agent_run_id: z.number().int().nullable(),
      filed_at: z.string(),
      /** The effect Orion computed at filing time, numbers only by construction. */
      effect: EffectSchema.nullable(),
    }),
  ),
  anomalies: z.array(
    z.strictObject({
      id: z.number().int(),
      kind: z.string(),
      metric: z.string(),
      severity: z.enum(['degrading', 'advisory']),
      occurrences: z.number().int(),
      first_seen_at: z.string(),
      last_seen_at: z.string(),
      /** Orion's numbers from the anomaly's detail (see readingOf). */
      reading: z.record(z.string(), z.unknown()),
    }),
  ),
});

export type Inbox = z.infer<typeof InboxSchema>;

export const emptyInbox = (): Inbox => ({ observations: [], proposals: [], anomalies: [] });

/** The keys under which an anomaly's detail holds a name Orion wrote itself (a source id, an address, a day). */
const READING_STRING_KEYS: ReadonlySet<string> = new Set(['primary_source', 'check_source', 'source', 'scan', 'sender', 'month', 'day', 'tx']);

/**
 * The numeric subset of an anomaly's detail: numbers, booleans, and the source, sender, day, and month names Orion
 * itself wrote, at any depth. Every other string is dropped, above all a source's error text, which may quote a
 * third-party response, and a note.
 */
export function readingOf(detail: unknown, key = ''): unknown {
  if (detail === null || typeof detail === 'number' || typeof detail === 'boolean') return detail;
  if (typeof detail === 'string') return READING_STRING_KEYS.has(key) ? detail : undefined;
  if (Array.isArray(detail)) return detail.map((item) => readingOf(item, key)).filter((item) => item !== undefined);
  if (typeof detail === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
      const kept = readingOf(v, k);
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  }
  return undefined;
}

const RESEARCH_DETAIL = /^research:([^:]+):run (\d+|none)/;

function recordedBy(o: Observation): Inbox['observations'][number]['recorded_by'] {
  const m = o.sourceDetail === null ? null : RESEARCH_DETAIL.exec(o.sourceDetail);
  if (!m) return null;
  return { persona: m[1], agent_run_id: m[2] === 'none' ? null : Number(m[2]) };
}

function movePct(db: Db, asset: AssetConfig, o: Observation): number | null {
  const inForce = valueInForce(db, asset, o.metricKey, o.observedAt, { confirmedOnly: true });
  if (inForce === null || inForce === 0) return null;
  return Math.round(((o.value - inForce) / inForce) * 100 * 1e4) / 1e4; // four decimals: a percent for a reader, not a guard
}

export function buildInbox(db: Db, asset: AssetConfig): Inbox {
  const observations = listActiveObservations(db, asset.id)
    .filter((o) => o.status === 'provisional')
    .sort((a, b) => b.id - a.id)
    .map((o) => ({
      id: o.id, metric: o.metricKey, value: o.value, observed_at: o.observedAt, period_days: o.periodDays,
      unit: asset.metrics[o.metricKey]?.unit ?? null, citation_url: o.citationUrl, recorded_by: recordedBy(o), move_pct: movePct(db, asset, o),
    }));
  const proposals = listProposals(db, { assetId: asset.id }).map((p) => ({
    id: p.id, kind: p.change.kind, persona: p.persona, agent_run_id: p.agentRunId, filed_at: p.createdAt, effect: p.effect,
  }));
  const anomalies = listAnomalies(db, { assetId: asset.id }).map((a) => ({
    id: a.id, kind: a.kind, metric: a.metricKey, severity: a.severity, occurrences: a.occurrences, first_seen_at: a.firstSeenAt, last_seen_at: a.lastSeenAt,
    reading: readingOf(a.detail) as Record<string, unknown>,
  }));
  return InboxSchema.parse({ observations, proposals, anomalies });
}

const num = (n: number): string => String(Number(n.toPrecision(10)));
const day = (iso: string): string => iso.slice(0, 10);

/** One line per item, in a fixed form the user answers by id. The Hermes job prints these verbatim. */
export function inboxLines(inbox: Inbox): string[] {
  const lines: string[] = [];
  for (const o of inbox.observations) {
    const when = o.period_days === null ? `at ${day(o.observed_at)}` : `${num(o.period_days)}d to ${day(o.observed_at)}`;
    const move = o.move_pct === null ? 'no confirmed value' : `${o.move_pct >= 0 ? '+' : ''}${o.move_pct.toFixed(1)}% vs confirmed`;
    const by = o.recorded_by ? `by ${o.recorded_by.persona}${o.recorded_by.agent_run_id === null ? '' : ` run #${o.recorded_by.agent_run_id}`}` : 'entered by hand';
    lines.push(`obs #${o.id}  ${o.metric}  ${num(o.value)} ${when}  ${move}  ${by}  ${o.citation_url ?? 'no citation'}`);
  }
  for (const p of inbox.proposals) {
    const effect =
      p.effect === null
        ? 'no target effect'
        : 'blocked' in p.effect
          ? `effect: blocked (${p.effect.blocked.join('; ')})`
          : `effect: 12m target ${p.effect['12m'].from === null ? 'none' : num(p.effect['12m'].from)} -> ${num(p.effect['12m'].to)}`;
    lines.push(`prop #${p.id}  ${p.kind}  filed ${day(p.filed_at)} by ${p.persona}${p.agent_run_id === null ? '' : ` run #${p.agent_run_id}`}  ${effect}`);
  }
  for (const a of inbox.anomalies) {
    lines.push(`anom #${a.id}  ${a.kind}${a.metric === '' ? '' : `  ${a.metric}`}  ${a.severity}  seen ${a.occurrences}x since ${day(a.first_seen_at)}  reading ${JSON.stringify(a.reading)}`);
  }
  return lines.length > 0 ? lines : ['nothing to decide'];
}
