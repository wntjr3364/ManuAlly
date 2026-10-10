// PW-058 — pure parts: blocks of a revision with their section heading, and the response table (Markdown)
// that cannot be broken by a reviewer's text.
import { describe, expect, test } from 'vitest';
import { blocksOf, responseTable, type Submission } from '../../../packages/domain/src/submissions/index.ts';

const t = (text: string) => ({ type: 'text', text });
describe('blocks and the response table', () => {
  test('each block knows its section heading and changes hash with its content', () => {
    const doc = { type: 'doc', content: [
      { type: 'heading', attrs: { id: 'h1', level: 1 }, content: [t('Results')] },
      { type: 'paragraph', attrs: { id: 'p1' }, content: [t('A '), { type: 'citation', attrs: { referenceId: 'r', locator: null } }] },
      { type: 'heading', attrs: { id: 'h2', level: 1 }, content: [t('Discussion')] },
      { type: 'paragraph', attrs: { id: 'p2' }, content: [t('B')] },
    ] };
    const b = blocksOf(doc);
    expect(b.get('p1')).toMatchObject({ heading: 'Results', text: 'A [cite]' });
    expect(b.get('p2')!.heading).toBe('Discussion');
    const changed = blocksOf({ ...doc, content: doc.content.map((x) => (x.attrs.id === 'p2' ? { ...x, content: [t('C')] } : x)) });
    expect(changed.get('p2')!.hash).not.toBe(b.get('p2')!.hash);
    expect(changed.get('p1')!.hash).toBe(b.get('p1')!.hash);
    expect(blocksOf(null).size).toBe(0);
  });
  test('the table escapes pipes and line breaks, says what was not answered and where a claimed change is missing', () => {
    const s = { label: 'J1 | x', target: 'Journal', status: 'draft', revision_id: 'r', docx_sha256: 'a'.repeat(64), responses: [
      { position: 1, round: 'R1', reviewer: 'Rev | 1', comment: 'line one\nline | two', status: 'addressed', response: 'done', links: [{ heading: 'Results', change: 'changed', holds: false }] },
      { position: 2, round: 'R1', reviewer: 'Rev 2', comment: 'x', status: null, response: null, links: [] },
    ] } as unknown as Submission;
    const md = responseTable(s);
    const rows = md.split('\n').filter((l) => l.startsWith('| 1') || l.startsWith('| 2'));
    expect(rows[0]).toContain('line one<br>line \\| two');
    expect(rows[0]).toContain('Rev \\| 1');
    expect(rows[0]).toContain('Results (changed, 지금 원고에 없음)');
    expect(rows[1]).toContain('답 없음');
    expect(md).toContain('상태: 초안');
    expect(md.split('\n')[0]).toBe('# J1 \\| x');
    for (const r of rows) expect(r.split(/(?<!\\)\|/).length).toBe(8); // 6 cells
  });
});
