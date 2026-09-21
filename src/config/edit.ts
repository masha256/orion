import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { OrionError, type ConfigEdit, type PathSegment } from '../types.js';

/**
 * Structured edits to an asset config, addressed by segment path. A string segment selects a map key or, in a list whose
 * items have an `id`, the item with that id; a number selects a list item by index. Paths are arrays, not dotted
 * strings, because assumption keys contain dots (`capture_rate_terminal.burn`).
 *
 * The same edits apply to a plain object (to validate a proposal and compute its effect) and to the YAML text (when the
 * user approves it), so both must resolve a path the same way: `concretePath` is that one place.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const show = (path: PathSegment[]): string => path.map(String).join(' > ');

/** Paths come from model output. These segments would walk into Object.prototype instead of the config. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Top-level config keys no proposal may touch: the agent's own limits, and the asset's identity. Checked when a proposal is filed AND when it is approved. */
export const UNPROPOSABLE_ROOTS: readonly string[] = ['agent', 'id'];

/** The edits that reach under an unproposable root. */
export function unproposableEdits(edits: ConfigEdit[]): ConfigEdit[] {
  return edits.filter((e) => UNPROPOSABLE_ROOTS.includes(String(e.path[0])));
}

/** Metric settings that decide what research may do with that metric unattended. */
const AGENT_LIMIT_METRIC_KEYS = new Set(['source', 'allow_provisional', 'critical']);

/**
 * True when any of these edits would widen (or narrow) what the agent may do without asking. A proposal may legitimately
 * do this, so it is not refused; the user is told, because approving it changes the rules the NEXT run plays by.
 * Bands and bounds decide what it may apply; provisional_move_pct decides when research goes live rather than to the
 * user; a metric's source, allow_provisional, and critical decide whether it may write there at all.
 */
export function changesAgentLimits(edits: ConfigEdit[]): boolean {
  return edits.some((e) => {
    const path = e.path.map(String);
    if (path[0] === 'assumptions') return true;
    if (path.length === 2 && path[0] === 'review_triggers' && path[1] === 'provisional_move_pct') return true;
    return path[0] === 'metrics' && path.length >= 3 && AGENT_LIMIT_METRIC_KEYS.has(path[path.length - 1]);
  });
}

/** Turns id segments into list indexes by walking the plain object. Throws `invalid_path` when a parent is missing or is not a container. */
function concretePath(root: unknown, path: PathSegment[]): (string | number)[] {
  if (path.length === 0) throw new OrionError('invalid_path', 'a config path needs at least one segment');
  const out: (string | number)[] = [];
  let node: unknown = root;
  path.forEach((segment, i) => {
    if (typeof segment === 'string' && PROTOTYPE_KEYS.has(segment)) {
      throw new OrionError('invalid_path', `${show(path)}: "${segment}" is not a config key`);
    }
    const last = i === path.length - 1;
    if (Array.isArray(node)) {
      const index = typeof segment === 'number' ? segment : node.findIndex((item) => isRecord(item) && item.id === segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) {
        throw new OrionError('invalid_path', `${show(path)}: no list item "${segment}"`);
      }
      out.push(index);
      node = node[index];
    } else if (isRecord(node)) {
      if (typeof segment !== 'string') throw new OrionError('invalid_path', `${show(path)}: "${segment}" indexes a map; use a key`);
      // Own keys only: an inherited property (toString, hasOwnProperty) is never a config key.
      const own = Object.hasOwn(node, segment);
      if (!last && !own) throw new OrionError('invalid_path', `${show(path)}: "${segment}" does not exist`);
      out.push(segment);
      node = own ? node[segment] : undefined;
    } else {
      throw new OrionError('invalid_path', `${show(path)}: "${segment}" is inside a value that is not a map or a list`);
    }
  });
  return out;
}

/** The value at a path, or `null` when the last key is absent. Null is also what an explicit YAML null reads as. */
export function getAtPath(root: unknown, path: PathSegment[]): unknown {
  let node: unknown = root;
  for (const segment of concretePath(root, path)) {
    node = Array.isArray(node) || (isRecord(node) && Object.hasOwn(node, segment)) ? (node as Record<string | number, unknown>)[segment] : undefined;
  }
  return node === undefined ? null : node;
}

/** A deep copy with the edits applied, in order. A `null` value deletes the key (or the list item). The input is not touched. */
export function applyEditsToObject(root: unknown, edits: ConfigEdit[]): unknown {
  const copy = structuredClone(root);
  for (const edit of edits) {
    const concrete = concretePath(copy, edit.path);
    const key = concrete[concrete.length - 1];
    let parent: unknown = copy;
    for (const segment of concrete.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[segment];
    if (Array.isArray(parent)) {
      if (edit.value === null) parent.splice(key as number, 1);
      else parent[key as number] = structuredClone(edit.value);
    } else if (edit.value === null) {
      delete (parent as Record<string, unknown>)[key as string];
    } else {
      (parent as Record<string, unknown>)[key as string] = structuredClone(edit.value);
    }
  }
  return copy;
}

const YAML_OUT = { lineWidth: 0 } as const;

function parseOrThrow(text: string): Document.Parsed {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new OrionError('invalid_yaml', doc.errors.map((e) => e.message).join('\n'));
  return doc;
}

/** True when parsing and printing the text changes nothing, so an edit's diff will show the edit and only the edit. */
export function roundTrips(text: string): boolean {
  return parseOrThrow(text).toString(YAML_OUT) === text;
}

/**
 * The YAML text with the edits applied. Comments, key order, and flow style are kept. A scalar is changed in place, so a
 * comment on its line survives. Long flow maps are not re-wrapped (`lineWidth: 0`).
 */
export function applyEditsToYaml(text: string, edits: ConfigEdit[]): string {
  const doc = parseOrThrow(text);
  for (const edit of edits) {
    const concrete = concretePath(doc.toJS(), edit.path);
    if (edit.value === null) {
      doc.deleteIn(concrete);
      continue;
    }
    const existing = doc.getIn(concrete, true);
    const scalarValue = edit.value === null || ['string', 'number', 'boolean'].includes(typeof edit.value);
    if (isScalar(existing) && scalarValue) {
      existing.value = edit.value;
    } else {
      const node = doc.createNode(edit.value);
      // A new collection inside a flow collection must be flow too; inside a block collection keep short maps on one line.
      if (isMap(node) || isSeq(node)) node.flow = true;
      doc.setIn(concrete, node);
    }
  }
  return doc.toString(YAML_OUT);
}
