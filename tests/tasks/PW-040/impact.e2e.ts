// PW-040 — TST-040A/B in a real browser: withdrawing an approved claim in the 자료 tab shows an impact
// on the paragraph plan that relies on it (only that one), the plan's status says so, and the user's
// review clears it; the other plan is never touched.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { approveClaim, createClaim, createEvidence, linkClaimEvidence, reviewEvidence } from '../../../packages/domain/src/evidence/index.ts';
import { approveOutlineRevision, approveStoryRevision, createOutlineRevision, createStoryRevision } from '../../../packages/domain/src/outlines/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('TST-040A/B: a withdrawn claim marks only its paragraph plan; the user reviews it', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Impact paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Impact paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  const s = await createStoryRevision(h.pool, { paperId, ownerId, parent: null, brief: { purpose: 'Test ABC1 in drought' }, story: { question: 'Does ABC1 respond?', main_message: 'ABC1 is drought-induced' } });
  await approveStoryRevision(h.pool, { paperId, ownerId, revisionId: s.id, body: { intent: 'approve_story', content_hash: s.content_hash } });
  const ev = await createEvidence(h.pool, { paperId, ownerId, body: { kind: 'experiment', locator: { note: 'qPCR' }, label: 'Exp 1' } });
  await reviewEvidence(h.pool, { paperId, ownerId, id: ev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: ev.content_hash } });
  const c = await createClaim(h.pool, { paperId, ownerId, body: { kind: 'observation', text: 'ABC1 rises in roots.' } });
  await linkClaimEvidence(h.pool, { paperId, ownerId, claimId: c.id, body: { evidence_id: ev.id, relation: 'supports' } });
  await approveClaim(h.pool, { paperId, ownerId, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const base = { parent_node_id: null, section: 'Results', role: 'result', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null };
  const o = await createOutlineRevision(h.pool, { paperId, ownerId, parent: null, storyRevisionId: s.id, nodes: [
    { ...base, node_id: randomUUID(), paragraph_goal: 'Root induction', claim_ids: [c.id], evidence_ids: [ev.id] },
    { ...base, node_id: randomUUID(), paragraph_goal: 'Leaf contrast' },
  ] });
  await approveOutlineRevision(h.pool, { paperId, ownerId, revisionId: o.id, body: { intent: 'approve_outline', content_hash: o.content_hash } });

  await page.reload(); // the tabs loaded before the outline was made
  await page.getByRole('tab', { name: '구상·개요' }).click();
  const panel = page.getByTestId('outline-impacts');
  await expect(panel.getByTestId('impact-count')).toHaveText('0');

  // the claim is withdrawn in the 자료 tab
  await page.getByRole('tab', { name: '자료' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('claim-row').filter({ hasText: 'ABC1 rises in roots.' }).getByRole('button', { name: '주장 철회' }).click();
  await expect(page.getByTestId('claim-row').filter({ hasText: 'ABC1 rises in roots.' })).toContainText('RETRACTED');

  await page.getByRole('tab', { name: '구상·개요' }).click();
  await panel.getByRole('button', { name: '다시 확인' }).click();
  await expect(panel.getByTestId('impact-count')).toHaveText('1');
  const imp = panel.getByTestId('impact');
  await expect(imp).toHaveCount(1);
  await expect(imp).toContainText('Root induction');
  await expect(imp).toContainText('주장이 철회됨');
  await expect(imp).not.toContainText('Leaf contrast');
  await imp.getByRole('button', { name: '검토함 — 이 계획대로 진행' }).click();
  await expect(panel.getByTestId('impact-count')).toHaveText('0');
  await expect(imp).toHaveAttribute('data-resolved', 'true');
});
