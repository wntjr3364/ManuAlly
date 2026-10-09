// Compares two stored revisions block by block, by stable block id (PW-021). A block present in both
// is the same, changed (word diff) or moved (its order relative to the others changed); a block in
// only one revision is added or removed. Blocks are compared by their whole JSON, so a mark, an atom
// or a heading level counts as a change even when the visible words are equal.
import type { JSONContent } from '@tiptap/core';
import { canonicalJson } from '@pw/editor-core';
import { blockTokens, diffTokens, type DiffPart } from '../diff/diff.ts';

// moved: `changed` says whether its content changed too (then `parts` holds the diff)
export interface BlockChange { kind: 'same' | 'changed' | 'moved' | 'added' | 'removed'; id: string; type: string; text: string; parts?: DiffPart[]; changed?: boolean }

const blocksOf = (d: unknown) => (((d as JSONContent)?.content ?? []) as JSONContent[]).filter((b) => typeof b.attrs?.id === 'string');
const textOf = (b: JSONContent) => blockTokens(b).join('');

// ids kept in the same relative order (longest common subsequence); the rest of the shared ids moved
function stableIds(a: string[], b: string[]): Set<string> {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const keep = new Set<string>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { keep.add(a[i]!); i++; j++; } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++; else j++;
  }
  return keep;
}

export function compareDocuments(older: unknown, newer: unknown): BlockChange[] {
  const a = blocksOf(older), b = blocksOf(newer);
  const aById = new Map(a.map((x) => [x.attrs!.id as string, x]));
  const bIds = new Set(b.map((x) => x.attrs!.id as string));
  const shared = (xs: JSONContent[], other: Set<string> | Map<string, unknown>) => xs.map((x) => x.attrs!.id as string).filter((id) => other.has(id));
  const keep = stableIds(shared(a, bIds), shared(b, aById));
  const out: BlockChange[] = [];
  // a removed block is listed where it stood: right after the block before it that is still in place
  const aIndex = new Map(a.map((x, i) => [x.attrs!.id as string, i]));
  const reported = new Set<string>();
  const removedFrom = (i: number) => {
    for (let k = i; k < a.length && !bIds.has(a[k]!.attrs!.id as string); k++) {
      const x = a[k]!;
      reported.add(x.attrs!.id as string);
      out.push({ kind: 'removed', id: x.attrs!.id as string, type: x.type!, text: textOf(x) });
    }
  };
  removedFrom(0);
  for (const x of b) {
    const id = x.attrs!.id as string;
    const old = aById.get(id);
    if (!old) { out.push({ kind: 'added', id, type: x.type!, text: textOf(x) }); continue; }
    const same = canonicalJson(old) === canonicalJson(x);
    const kind = !keep.has(id) ? 'moved' : same ? 'same' : 'changed';
    out.push({ kind, id, type: x.type!, text: textOf(x), parts: same ? undefined : diffTokens(blockTokens(old), blockTokens(x)), ...(kind === 'moved' ? { changed: !same } : {}) });
    if (keep.has(id)) removedFrom(aIndex.get(id)! + 1);
  }
  // removed blocks that followed a moved one
  for (const x of a) {
    const id = x.attrs!.id as string;
    if (!bIds.has(id) && !reported.has(id)) out.push({ kind: 'removed', id, type: x.type!, text: textOf(x) });
  }
  return out;
}
