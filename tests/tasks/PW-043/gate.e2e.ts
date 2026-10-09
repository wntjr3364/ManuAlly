// PW-043 — TST-043A/B in a real browser: in the manuscript tab the user checks a saved paragraph; a
// matching one shows each number with the evidence it came from, a paragraph with a changed unit shows
// the mismatch, and a number no fact holds is "확인 안 됨", never a pass.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { createEvidence, createFactCandidates, reviewEvidence, reviewFact } from '../../../packages/domain/src/evidence/index.ts';
import { createDocument, saveRevision } from '../../../packages/domain/src/revisions/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: {} }); });
test.afterAll(async () => { await h?.stop(); });

test('TST-043A/B: a paragraph check shows matches with their evidence, mismatches and unknowns', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Gate paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Gate paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  const ev = await createEvidence(h.pool, { paperId, ownerId, body: { kind: 'experiment', locator: { note: 'plate 3' }, label: 'roots qPCR' } });
  await reviewEvidence(h.pool, { paperId, ownerId, id: ev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: ev.content_hash } });
  const [f] = await createFactCandidates(h.pool, { paperId, ownerId, origin: 'user', single: true, facts: [{ evidence_id: ev.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(h.pool, { paperId, ownerId, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const d = await createDocument(h.pool, paperId, ownerId, 'manuscript');
  await saveRevision(h.pool, { paperId, documentId: d.head.document_id, ownerId, expectedHead: d.head.id, schemaVersion: 1, reason: 'manual', content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'Under drought ABC1 rose 2.4-fold in roots (n = 3).' }] },
    { type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'Under drought ABC1 hit 2.4 mM in roots after 24 h.' }] },
  ] } });

  await page.reload();
  await page.getByRole('tab', { name: '원고' }).click();
  const box = page.getByTestId('sci-check');
  await box.getByLabel('검사할 문단').selectOption({ label: 'Under drought ABC1 rose 2.4-fold in roots (n = 3).' });
  await box.getByRole('button', { name: '검사' }).click();
  await expect(box.getByTestId('sci-status')).toHaveText('근거와 일치');
  await expect(box.getByTestId('sci-finding').first()).toContainText('2.4-fold — roots qPCR');

  await box.getByLabel('검사할 문단').selectOption({ label: 'Under drought ABC1 hit 2.4 mM in roots after 24 h.' });
  await box.getByRole('button', { name: '검사' }).click();
  await expect(box.getByTestId('sci-status')).toHaveText('불일치');
  await expect(box.locator('[data-verdict="fail"]')).toContainText('단위가 다름');
  await expect(box.locator('[data-verdict="unknown"]')).toContainText('24 h');
  await expect(box.locator('[data-verdict="pass"]')).toHaveCount(0);
});
