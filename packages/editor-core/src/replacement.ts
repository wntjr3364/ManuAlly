// Typed replacement content of a replace_selection proposal (contract edit_proposal v2).
// Builds schema nodes or refuses; used by the browser diff preview and by the server before apply,
// so both see the same result. preserve_atom re-uses an atom of the original selection by index,
// which is the only way a proposal can keep inline math or figure references (RFC-005).
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { MARK_TYPES, schema } from './schema.ts';

export type ReplacementItem =
  | { type: 'text'; text: string; marks?: (typeof MARK_TYPES)[number][] }
  | { type: 'citation'; reference_id: string; locator?: string | null }
  | { type: 'preserve_atom'; atom_index: number };

export class ReplacementError extends Error {
  constructor(public readonly code: 'INVALID_REPLACEMENT', message: string) {
    super(`${code}: ${message}`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const fail = (m: string) => new ReplacementError('INVALID_REPLACEMENT', m);

// selectionAtoms: the atom nodes inside the selected range, in document order
export function buildReplacement(replacement: unknown, selectionAtoms: PMNode[]): PMNode[] {
  if (!Array.isArray(replacement)) throw fail('replacement must be a list');
  const used = new Set<number>();
  const nodes = replacement.map((raw, i): PMNode => {
    if (!raw || typeof raw !== 'object') throw fail(`item ${i} must be an object`);
    const item = raw as Record<string, unknown>;
    const keys = Object.keys(item);
    const allow = (ks: string[]) => { for (const k of keys) if (!ks.includes(k)) throw fail(`item ${i}: unknown field ${k}`); };
    if (item.type === 'text') {
      allow(['type', 'text', 'marks']);
      if (typeof item.text !== 'string' || !item.text || item.text.includes('\u0000') || LONE_SURROGATE.test(item.text)) throw fail(`item ${i}: text must be non-empty valid text`);
      const marks = item.marks ?? [];
      if (!Array.isArray(marks) || new Set(marks).size !== marks.length) throw fail(`item ${i}: marks must be a list without repeats`);
      return schema.text(item.text, marks.map((m) => {
        if (!(MARK_TYPES as readonly unknown[]).includes(m)) throw fail(`item ${i}: unknown mark ${JSON.stringify(m)}`);
        return schema.marks[m as string]!.create();
      }));
    }
    if (item.type === 'citation') {
      allow(['type', 'reference_id', 'locator']);
      if (typeof item.reference_id !== 'string' || !UUID.test(item.reference_id)) throw fail(`item ${i}: citation needs a reference_id UUID`);
      if (item.locator !== undefined && item.locator !== null && (typeof item.locator !== 'string' || !item.locator || item.locator.length > 200)) throw fail(`item ${i}: locator must be short text or null`);
      return schema.nodes.citation!.create({ referenceId: item.reference_id, locator: item.locator ?? null });
    }
    if (item.type === 'preserve_atom') {
      allow(['type', 'atom_index']);
      if (!Number.isInteger(item.atom_index)) throw fail(`item ${i}: atom_index must be an integer`);
      const atom = selectionAtoms[item.atom_index as number];
      if (!atom) throw fail(`item ${i}: there is no atom ${String(item.atom_index)} in the selection`);
      if (used.has(item.atom_index as number)) throw fail(`item ${i}: atom ${String(item.atom_index)} is used twice`);
      used.add(item.atom_index as number);
      return atom;
    }
    throw fail(`item ${i}: unsupported type ${JSON.stringify(item.type)}`);
  });
  // normalise the way ProseMirror does (adjacent text runs with equal marks are joined)
  const out: PMNode[] = [];
  Fragment.fromArray(nodes).forEach((n) => out.push(n));
  return out;
}

export function atomNodesIn(block: PMNode, from: number, to: number): PMNode[] {
  const out: PMNode[] = [];
  block.nodesBetween(from, to, (child) => { if (!child.isText && child.isAtom && child.isInline) out.push(child); });
  return out;
}
