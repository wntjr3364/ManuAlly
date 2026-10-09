// PW-044 — TST-044A/B in a real browser: the user asks for a review of a paragraph (MOCK reviewer),
// sees the finding with its words, reason, source and confidence, accepts it, asks for the one repair,
// and applies the repaired paragraph from "문단 작성"; the repair cannot be asked for twice.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { approveClaim, createClaim, createEvidence, createFactCandidates, linkClaimEvidence, reviewEvidence, reviewFact } from '../../../packages/domain/src/evidence/index.ts';
import { approveOutlineRevision, approveStoryRevision, createOutlineRevision, createStoryRevision } from '../../../packages/domain/src/outlines/index.ts';
import { createDocument, saveRevision } from '../../../packages/domain/src/revisions/index.ts';
import { linkParagraph } from '../../../packages/domain/src/outline-impact/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: {} }); });
test.afterAll(async () => { await h?.stop(); });

test('TST-044A/B: a finding with its span and source, accepted by the user, repaired once and applied by the user', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Review paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Review paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  const s = await createStoryRevision(h.pool, { paperId, ownerId, parent: null, brief: { purpose: 'Test ABC1 in drought' }, story: { question: 'Does ABC1 respond?', main_message: 'ABC1 is drought-induced' } });
  await approveStoryRevision(h.pool, { paperId, ownerId, revisionId: s.id, body: { intent: 'approve_story', content_hash: s.content_hash } });
  const ev = await createEvidence(h.pool, { paperId, ownerId, body: { kind: 'experiment', locator: { note: 'qPCR' }, label: 'roots qPCR' } });
  await reviewEvidence(h.pool, { paperId, ownerId, id: ev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: ev.content_hash } });
  const [f] = await createFactCandidates(h.pool, { paperId, ownerId, origin: 'user', single: true, facts: [{ evidence_id: ev.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(h.pool, { paperId, ownerId, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(h.pool, { paperId, ownerId, body: { kind: 'observation', text: 'ABC1 rises in roots under drought.' } });
  await linkClaimEvidence(h.pool, { paperId, ownerId, claimId: c.id, body: { evidence_id: ev.id, relation: 'supports' } });
  await approveClaim(h.pool, { paperId, ownerId, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const nodeId = randomUUID();
  const o = await createOutlineRevision(h.pool, { paperId, ownerId, parent: null, storyRevisionId: s.id, nodes: [
    { node_id: nodeId, parent_node_id: null, section: 'Results', role: 'result', paragraph_goal: 'Root induction', claim_ids: [c.id], evidence_ids: [ev.id], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null },
  ] });
  await approveOutlineRevision(h.pool, { paperId, ownerId, revisionId: o.id, body: { intent: 'approve_outline', content_hash: o.content_hash } });
  const d = await createDocument(h.pool, paperId, ownerId, 'manuscript');
  const P = randomUUID();
  await saveRevision(h.pool, { paperId, documentId: d.head.document_id, ownerId, expectedHead: d.head.id, schemaVersion: 1, reason: 'manual', content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: P }, content: [{ type: 'text', text: 'ABC1 rose 2.4-fold in roots under drought, which demonstrates that ABC1 causes tolerance.' }] },
  ] } });
  await linkParagraph(h.pool, { paperId, ownerId, outlineRevisionId: o.id, nodeId, body: { document_id: d.head.document_id, block_id: P } });

  await page.reload();
  await page.getByRole('tab', { name: '원고' }).click();
  const panel = page.getByTestId('review');
  await panel.getByLabel('검토할 문단').selectOption({ index: 1 });
  await panel.getByRole('button', { name: '검토 요청' }).click();
  const finding = panel.getByTestId('review-finding');
  await expect(finding).toHaveCount(1);
  await expect(finding).toContainText('과학 · 인과 단정');
  await expect(finding).toContainText('demonstrates that ABC1 causes tolerance');
  await expect(finding).toContainText('근거: 승인된 주장');
  await expect(finding).toContainText('확신도 보통');
  await expect(finding.getByTestId('review-alternative')).toContainText('is consistent with the possibility that ABC1 contributes to tolerance');
  await expect(panel.getByTestId('review-independence')).toContainText('사용자가 쓴 문단의 검토');
  // nothing changed in the manuscript
  await expect(page.locator('.ProseMirror')).toContainText('demonstrates that ABC1 causes tolerance');

  await finding.getByRole('button', { name: '채택' }).click();
  await expect(finding.getByTestId('review-decision')).toHaveText('채택함');
  await panel.getByRole('button', { name: '채택한 지적으로 고쳐 쓰기 (한 번)' }).click();
  await expect(panel.getByTestId('review-repair')).toContainText('"문단 작성"에 제안으로 있습니다');
  await expect(panel.getByRole('button', { name: '채택한 지적으로 고쳐 쓰기 (한 번)' })).toHaveCount(0);

  const proposal = page.getByTestId('writer').getByTestId('writer-proposal').first();
  await expect(proposal.getByTestId('writer-status')).toHaveText('적용 가능');
  await expect(proposal.getByTestId('writer-text')).toContainText('is consistent with the possibility that ABC1 contributes to tolerance');
  await proposal.getByRole('button', { name: '적용' }).click();
  await expect(page.locator('.ProseMirror')).toContainText('is consistent with the possibility that ABC1 contributes to tolerance');
  await expect(page.locator('.ProseMirror')).not.toContainText('demonstrates that');
});
