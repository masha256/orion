import type { Anomaly } from '../db/anomalies.js';
import type { Observation } from '../db/observations.js';
import type { Proposal } from '../db/proposals.js';

/**
 * Compact JSON views of Orion's state for the model: the context pack and the read tools share them, so the agent sees
 * one shape for one thing. Keys are snake_case.
 */

export function describeObservation(o: Observation): Record<string, unknown> {
  return {
    id: o.id, metric: o.metricKey, value: o.value, observed_at: o.observedAt, period_days: o.periodDays, source: o.source,
    status: o.status, active: o.supersededBy === null && o.status !== 'rejected', citation_url: o.citationUrl, quoted_text: o.quotedText,
    source_detail: o.sourceDetail,
  };
}

export function describeAnomaly(a: Anomaly, stagedResolved = false): Record<string, unknown> {
  return {
    id: a.id, kind: a.kind, metric: a.metricKey, severity: a.severity, status: a.status, occurrences: a.occurrences,
    first_seen_at: a.firstSeenAt, last_seen_at: a.lastSeenAt, detail: a.detail, note: a.note, decided_by: a.decidedBy,
    ...(a.status === 'acknowledged' ? { read_only: true } : {}),
    ...(stagedResolved ? { resolution_staged_in_this_run: true } : {}),
  };
}

/** `effect` is null on every proposal filed now; a stored valuation-era one shows the 6m/12m target move it was filed with. */
export function describeProposal(p: Proposal): Record<string, unknown> {
  return {
    id: p.id, kind: p.change.kind, change: p.change, rationale: p.rationale, effect: p.effect, status: p.status, created_at: p.createdAt,
    decided_at: p.decidedAt, decision_note: p.decisionNote,
  };
}
