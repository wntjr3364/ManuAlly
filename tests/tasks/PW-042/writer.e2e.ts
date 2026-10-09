// PW-042 — TST-042A/B in a real browser: under the manuscript, the user asks for a new paragraph from
// an approved plan (MOCK writer), sees it as a proposal (the editor is unchanged), applies it and sees
// it in the editor; a plan without claims or facts gets "근거 부족", never a paragraph.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { approveClaim, createClaim, createEvidence, createFactCandidates, linkClaimEvidence, reviewEvidence, reviewFact } from '../../../packages/domain/src/evidence/index.ts';
import { approveOutlineRevision, approveStoryRevision, createOutlineRevision, createStoryRevision } from '../../../packages/domain/src/outlines/index.ts';
import { createDocument, saveRevision } from '../../../packages/domain/src/revisions/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: {} }); });
test.afterAll(async () => { await h?.stop(); });

test('TST-042A/B: a paragraph from an approved plan is a proposal until applied; no evidence, no paragraph', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Writer paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Writer paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  const s = await createStoryRevision(h.pool, { paperId, ownerId, parent: null, brief: { purpose: 'Test ABC1 in drought' }, story: { question: 'Does ABC1 respond?', main_message: 'ABC1 is drought-induced' } });
  await approveStoryRevision(h.pool, { paperId, ownerId, revisionId: s.id, body: { intent: 'approve_story', content_hash: s.content_hash } });
  const ev = await createEvidence(h.pool, { paperId, ownerId, body: { kind: 'experiment', locator: { note: 'qPCR' }, label: 'Exp 1' } });
  await reviewEvidence(h.pool, { paperId, ownerId, id: ev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: ev.content_hash } });
  const [f] = await createFactCandidates(h.pool, { paperId, ownerId, origin: 'user', single: true, facts: [{ evidence_id: ev.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(h.pool, { paperId, ownerId, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(h.pool, { paperId, ownerId, body: { kind: 'observation', text: 'ABC1 rises in roots.' } });
  await linkClaimEvidence(h.pool, { paperId, ownerId, claimId: c.id, body: { evidence_id: ev.id, relation: 'supports' } });
  await approveClaim(h.pool, { paperId, ownerId, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const base = { parent_node_id: null, section: 'Results', role: 'result', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null };
  const o = await createOutlineRevision(h.pool, { paperId, ownerId, parent: null, storyRevisionId: s.id, nodes: [
    { ...base, node_id: randomUUID(), paragraph_goal: 'Root induction', claim_ids: [c.id], evidence_ids: [ev.id] },
    { ...base, node_id: randomUUID(), paragraph_goal: 'Open question' },
  ] });
  await approveOutlineRevision(h.pool, { paperId, ownerId, revisionId: o.id, body: { intent: 'approve_outline', content_hash: o.content_hash } });
  const d = await createDocument(h.pool, paperId, ownerId, 'manuscript');
  await saveRevision(h.pool, { paperId, documentId: d.head.document_id, ownerId, expectedHead: d.head.id, schemaVersion: 1, reason: 'manual',
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'ABC1 was measured by qPCR.' }] }] } });

  await page.reload();
  await page.getByRole('tab', { name: '원고' }).click();
  const editor = page.locator('.ProseMirror');
  await expect(editor).toContainText('ABC1 was measured by qPCR.');
  const panel = page.getByTestId('writer');
  await panel.getByLabel('문단 계획').selectOption({ label: 'Results · Root induction' });
  await panel.getByLabel('넣을 위치(이 문단 뒤)').selectOption({ label: 'ABC1 was measured by qPCR.' });
  await panel.getByRole('button', { name: '제안 요청' }).click();
  const proposal = panel.getByTestId('writer-proposal').first();
  await expect(proposal.getByTestId('writer-status')).toHaveText('적용 가능');
  await expect(proposal.getByTestId('writer-text')).toContainText('ABC1 rises in roots');
  await expect(proposal.getByTestId('writer-text')).toContainText('2.4');
  // a proposal only: the editor still has one paragraph
  await expect(editor.locator('p')).toHaveCount(1);
  await proposal.getByRole('button', { name: '적용' }).click();
  await expect(proposal.getByTestId('writer-status')).toHaveText('적용됨');
  await expect(editor.locator('p')).toHaveCount(2);
  await expect(editor.locator('p').nth(1)).toContainText('ABC1 rises in roots');

  // a plan with no claims or facts: the writer says what is missing
  await panel.getByLabel('문단 계획').selectOption({ label: 'Results · Open question' });
  await panel.getByRole('button', { name: '제안 요청' }).click();
  const second = panel.getByTestId('writer-proposal').first();
  await expect(second.getByTestId('writer-status')).toHaveText('근거 부족');
  await expect(second.getByTestId('writer-missing')).toHaveCount(1);
  await expect(second.getByRole('button', { name: '적용' })).toHaveCount(0);
});
