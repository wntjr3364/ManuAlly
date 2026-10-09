// PW-039 — TST-039A/B in a real browser: the story tab asks for alternatives (MOCK generator, worker
// path), shows each one's message, evidence, limits and the MOCK label; adopting one makes a new DRAFT
// story revision shown in the form (approval stays a separate button); an alternative the system
// blocked says why and cannot be adopted.
import { test, expect } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { approveClaim, createClaim, createEvidence, createFactCandidates, linkClaimEvidence, reviewEvidence, reviewFact } from '../../../packages/domain/src/evidence/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: { chunkDelayMs: 10 } }); });
test.afterAll(async () => { await h?.stop(); });

test('TST-039A/B: alternatives with message, evidence and limits; adopt one into a draft; a blocked one cannot be adopted', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Story AI paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Story AI paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const owner = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  // settled material: one verified fact and one approved claim
  const ev = await createEvidence(h.pool, { paperId, ownerId: owner, body: { kind: 'experiment', locator: { note: 'qPCR roots' }, label: 'Exp 1' } });
  await reviewEvidence(h.pool, { paperId, ownerId: owner, id: ev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: ev.content_hash } });
  const [f] = await createFactCandidates(h.pool, { paperId, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: ev.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought roots', comparison: 'well-watered', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(h.pool, { paperId, ownerId: owner, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(h.pool, { paperId, ownerId: owner, body: { kind: 'observation', text: 'ABC1 rises 2.4-fold in drought-stressed roots.' } });
  await linkClaimEvidence(h.pool, { paperId, ownerId: owner, claimId: c.id, body: { evidence_id: ev.id, relation: 'supports' } });
  await approveClaim(h.pool, { paperId, ownerId: owner, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });

  await page.getByRole('tab', { name: '구상·개요' }).click();
  await page.getByLabel('연구 목적').fill('Test whether ABC1 responds to drought in roots');
  await page.getByLabel('핵심 질문').fill('Does ABC1 respond to drought?');
  await page.getByLabel('핵심 메시지').fill('ABC1 is drought-induced in roots');
  await page.getByLabel('새로운 점').fill('first root data');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('DRAFT');
  const firstVersion = (await h.pool.query('SELECT id FROM story_revisions WHERE paper_id = $1', [paperId])).rows[0].id as string;

  const box = page.getByTestId('story-alternatives');
  await box.getByRole('button', { name: '대안 요청' }).click();
  await expect(box.getByTestId('story-alternative').first()).toBeVisible({ timeout: 15_000 });
  await expect(box.getByTestId('story-alt-label')).toHaveText('MOCK');
  const cards = box.getByTestId('story-alternative');
  expect(await cards.count()).toBeGreaterThanOrEqual(2);
  const first = cards.first();
  await expect(first.getByTestId('story-alt-message')).toContainText('ABC1 is drought-induced in roots');
  await expect(first.getByTestId('story-alt-evidence').locator('[data-role="supports"]')).toContainText('2.4');
  // nothing changed yet
  expect((await h.pool.query('SELECT count(*)::int AS n FROM story_revisions WHERE paper_id = $1', [paperId])).rows[0].n).toBe(1);

  // the second alternative (narrowed to one observation) is adopted
  const second = cards.nth(1);
  const message = (await second.getByTestId('story-alt-message').textContent())!.replace('핵심 메시지', '').trim();
  await second.getByRole('button', { name: '이 안으로 새 스토리 초안' }).click();
  await expect(box.getByRole('status')).toContainText('새 스토리 초안');
  await expect(second.getByTestId('story-alt-adopted')).toBeVisible();
  await expect(page.getByTestId('story-status')).toHaveText('DRAFT');
  await expect(page.getByLabel('핵심 메시지')).toHaveValue(message);
  await expect(page.getByLabel('연구 목적')).toHaveValue('Test whether ABC1 responds to drought in roots');
  await expect(page.getByLabel('새로운 점')).toHaveValue('first root data');
  await expect(page.getByRole('button', { name: '이 스토리 버전 승인' })).toBeEnabled();
  const revs = (await h.pool.query('SELECT parent_revision_id, status FROM story_revisions WHERE paper_id = $1 ORDER BY created_at', [paperId])).rows;
  expect(revs).toEqual([{ parent_revision_id: null, status: 'DRAFT' }, { parent_revision_id: firstVersion, status: 'DRAFT' }]);
  // no claim was created or approved
  expect((await h.pool.query('SELECT count(*)::int AS n FROM claims WHERE paper_id = $1', [paperId])).rows[0].n).toBe(1);

  // an alternative the system blocked (a stated number not in its evidence) says why and cannot be adopted
  // (a synthetic finished run: the MOCK generator only states numbers its evidence holds)
  const latest = (await h.pool.query('SELECT id FROM story_revisions WHERE paper_id = $1 ORDER BY created_at DESC LIMIT 1', [paperId])).rows[0].id as string;
  const cl = await h.pool.connect();
  let job: string;
  try {
    // inserted and cancelled in one transaction: no worker ever sees it queued
    await cl.query('BEGIN');
    job = (await cl.query(`INSERT INTO jobs (paper_id, owner_id, intent, idempotency_key, payload, payload_hash) VALUES ($1, $2, 'propose_story', 'synthetic-blocked', '{}', repeat('b', 64)) RETURNING id`, [paperId, owner])).rows[0].id as string;
    await cl.query("UPDATE jobs SET status = 'CANCELLED', finished_at = clock_timestamp() WHERE id = $1", [job]);
    await cl.query('COMMIT');
  } finally {
    cl.release();
  }
  const run = (await h.pool.query(`INSERT INTO story_alternative_runs (paper_id, job_id, base_story_revision_id, generator, generator_label, input_hash)
    VALUES ($1, $2, $3, 'mock', 'MOCK', repeat('a', 64)) RETURNING id`, [paperId, job, latest])).rows[0].id;
  await h.pool.query(`INSERT INTO story_alternatives (run_id, paper_id, position, content, warnings, blocked_reasons) VALUES ($1, $2, 1, $3, '{}', '{number_not_in_evidence:3.1}')`,
    [run, paperId, JSON.stringify({ title: 'inflated', question: 'q?', main_message: 'ABC1 rises 3.1-fold.', presentation_order: [], evidence: [], competing_explanations: [], limitations: [], evidence_gaps: [], claim_suggestions: [] })]);
  await page.reload();
  await page.getByRole('tab', { name: '구상·개요' }).click();
  const blocked = page.getByTestId('story-alternative').first();
  await expect(blocked.getByTestId('story-alt-blocked')).toContainText('수치 3.1');
  await expect(blocked.getByRole('button', { name: '이 안으로 새 스토리 초안' })).toBeDisabled();
});
