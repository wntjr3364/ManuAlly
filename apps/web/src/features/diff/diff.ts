// Word-level diff of a block before and after a proposal, for display only (the server decides what
// is applied). Inline atoms appear as labelled tokens so a moved or removed citation is visible.
import type { JSONContent } from '@tiptap/core';

export type DiffPart = { kind: 'same' | 'del' | 'ins'; text: string };
const ATOM_LABEL: Record<string, string> = { citation: '[인용]', math_inline: '[수식]', figure_ref: '[그림/표]' };

export function blockTokens(block: JSONContent): string[] {
  const out: string[] = [];
  for (const n of block.content ?? []) {
    if (n.type === 'text') out.push(...(n.text ?? '').split(/(\s+)/).filter(Boolean));
    else out.push(ATOM_LABEL[n.type ?? ''] ?? '[요소]');
  }
  return out;
}

// longest common subsequence over tokens; blocks are short (one paragraph), so O(n·m) is fine
export function diffTokens(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts.at(-1);
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]!); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push('del', a[i++]!);
    else push('ins', b[j++]!);
  }
  while (i < n) push('del', a[i++]!);
  while (j < m) push('ins', b[j++]!);
  return parts;
}
