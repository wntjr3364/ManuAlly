// Deterministic, offline mock provider (PW-020; spec 01 "외부 AI disabled, MockProvider", spec 11 "Mock
// 결과는 명확히 표기"). It never reads the manuscript beyond what a run hands it and never pretends to
// judge it: answers say they are mock output, and corrections are a few fixed, mechanical rewrites
// (spacing, doubled words, filler words) that keep every number, atom and mark.

export const MOCK_LABEL = 'MOCK' as const;

export type SliceItem =
  | { type: 'text'; text: string; marks?: string[] }
  | { type: 'preserve_atom'; atom_index: number };

export type SelectionIntent = 'grammar' | 'concise' | 'rewrite';

// What a selection run needs from a provider. Real adapters (P03) implement the same shape; `label`
// is what the UI must show next to their output (null only for an admitted real provider).
export interface SelectionProvider {
  id: string;
  label: typeof MOCK_LABEL | null;
  answer(input: { question: string; quote: string }): AsyncIterable<string>;
  revise(input: { intent: SelectionIntent; instruction: string; items: SliceItem[] }): Promise<{ items: SliceItem[]; explanation: string }>;
}

export interface MockOptions {
  // pause between answer pieces, so streaming can be seen and tested
  chunkDelayMs?: number;
  // test hook: runs before a revision is computed (e.g. to cancel the job meanwhile)
  beforeRevise?: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GRAMMAR: [RegExp, string][] = [
  [/\b(\p{L}+)(\s+)\1\b/giu, '$1'], // doubled word: "the the" -> "the" (keeps the first one's case)
  [/ {2,}/g, ' '],
  [/ +([,.;:!?])/g, '$1'],
];
const CONCISE: [RegExp, string][] = [
  [/\b(?:very|really|basically|actually|quite) +/giu, ''],
  [/\bin order to\b/giu, 'to'],
  [/\bdue to the fact that\b/giu, 'because'],
  [/\ba (?:large )?number of\b/giu, 'many'],
];
const REWRITE: [RegExp, string][] = [
  [/\ba lot of\b/giu, 'many'],
  [/\bshows\b/gu, 'indicates'],
  [/\bgot\b/gu, 'obtained'],
];

function rewriteText(text: string, intent: SelectionIntent): string {
  const rules = intent === 'grammar' ? GRAMMAR : intent === 'concise' ? [...CONCISE, ...GRAMMAR] : [...REWRITE, ...CONCISE, ...GRAMMAR];
  let out = text;
  for (const [re, by] of rules) out = out.replace(re, by);
  return out;
}

export function createMockProvider(opts: MockOptions = {}): SelectionProvider {
  const delay = opts.chunkDelayMs ?? 0;
  return {
    id: 'mock',
    label: MOCK_LABEL,
    async *answer({ question, quote }) {
      const chars = [...quote.replace(/￼/g, '')].length;
      const text = `[MOCK] 선택한 부분(${chars}자)에 대한 질문 “${question}”을 받았습니다. `
        + '이 답변은 연결 시험용 모의 응답이며 실제 AI가 원고를 읽고 판단한 결과가 아닙니다. '
        + '원고는 바뀌지 않았습니다.';
      // pieces of a few words each, like a streamed answer
      const words = text.split(/(?<= )/);
      for (let i = 0; i < words.length; i += 4) {
        if (delay) await sleep(delay);
        yield words.slice(i, i + 4).join('');
      }
    },
    async revise({ intent, items }) {
      await opts.beforeRevise?.();
      const out: SliceItem[] = [];
      for (const item of items) {
        if (item.type !== 'text') { out.push(item); continue; }
        const text = rewriteText(item.text, intent);
        if (text) out.push(item.marks ? { type: 'text', text, marks: item.marks } : { type: 'text', text });
      }
      return { items: out, explanation: `MOCK ${intent}: 고정 규칙(띄어쓰기·반복 단어·군더더기 표현)만 적용한 모의 수정` };
    },
  };
}
