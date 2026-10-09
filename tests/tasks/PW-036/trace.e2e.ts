// PW-036 — in a real browser: a claim is traced to its figure (number, version, panel, unit, groups)
// and fact value; a new figure version with a changed unit lists the paragraph, claim and fact for
// review (the manuscript is not changed), and the owner closes a review item with a note.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { createFigure } from '../../../packages/domain/src/references/index.ts';
import { addFigureVersion, linkFigureEvidence, recordFigureFile } from '../../../packages/domain/src/figures/index.ts';
import { createClaim, createEvidence, createFactCandidates, linkClaimEvidence } from '../../../packages/domain/src/evidence/index.ts';
import { createDocument, saveRevision } from '../../../packages/domain/src/revisions/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('TST-036A/B: trace a claim to its figure and value; a unit change asks for review without touching the text', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Trace paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Trace paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  // synthetic records (each step has its own API test in PW-011/019/036)
  const fig = await createFigure(h.pool, { paperId, ownerId, kind: 'figure', title: 'ABC1 induction' });
  const file = await recordFigureFile(h.pool, { paperId, ownerId, sha256: 'a'.repeat(64), byteSize: 10, media: 'image/png', name: 'fig1.png' });
  const v1 = await addFigureVersion(h.pool, { paperId, ownerId, figureId: fig.id, body: { caption: 'ABC1 induction.', panels: [{ panel: 'A', unit: 'fold', groups: ['WT', 'abc1'] }], asset_id: file.id } });
  const ev = await createEvidence(h.pool, { paperId, ownerId, body: { kind: 'figure_panel', source_asset_revision_id: file.id, locator: { panel: 'A' }, label: 'Fig. 1A bars' } });
  await linkFigureEvidence(h.pool, { paperId, ownerId, evidenceId: ev.id, body: { figure_version_id: v1.version.id, panel: 'A' } });
  await createFactCandidates(h.pool, { paperId, ownerId, origin: 'user', single: true, facts: [{ evidence_id: ev.id, entity: 'ABC1', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'abc1 vs WT', comparison: 'WT', n: 3, extraction_method: 'figure_reading' }] });
  const claim = await createClaim(h.pool, { paperId, ownerId, body: { kind: 'observation', text: 'ABC1 is induced 2.4-fold.' } });
  await linkClaimEvidence(h.pool, { paperId, ownerId, claimId: claim.id, body: { evidence_id: ev.id, relation: 'supports' } });
  const { document, head } = await createDocument(h.pool, paperId, ownerId, 'manuscript');
  const documentId = (document as unknown as { id: string }).id;
  await saveRevision(h.pool, { paperId, documentId, ownerId, expectedHead: head.id, schemaVersion: 1, reason: 'manual',
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'ABC1 was induced (' }, { type: 'figure_ref', attrs: { targetId: fig.id } }, { type: 'text', text: ').' }] }] } });

  await page.getByRole('tab', { name: '자료' }).click();
  await expect(page.getByTestId('no-flags')).toBeVisible();
  await page.getByRole('listitem').filter({ hasText: 'ABC1 is induced 2.4-fold.' }).getByRole('button', { name: '출처 추적' }).click();
  await expect(page.getByTestId('trace-figure')).toContainText('Figure 1A (버전 1) 단위 fold · 그룹 WT, abc1');
  await expect(page.getByTestId('trace-fact')).toContainText('ABC1 · fold change: 2.4 fold (abc1 vs WT)');

  // a new version with another unit
  const form = page.getByRole('form', { name: '새 그림 버전' });
  await form.getByLabel('그림·표').selectOption(fig.id);
  await form.getByLabel('캡션').fill('ABC1 induction.');
  await form.getByLabel('패널 목록').fill('A: log2 fold; WT, abc1');
  await form.getByRole('button', { name: '새 버전 만들기' }).click();
  await expect(page.getByRole('status')).toContainText('검토할 곳 3개');
  const flags = page.getByTestId('flag');
  await expect(flags).toHaveCount(3);
  await expect(page.getByTestId('flag-list')).toContainText('패널 A 단위가 바뀜');
  await expect(flags.filter({ hasText: '원고 문단' })).toHaveCount(1);
  if (process.env.PW_SAVE_EVIDENCE === '1') await page.screenshot({ path: 'reports/tasks/PW-036/review-flags.png', fullPage: true });
  // the trace says the evidence was read from an older version
  await page.getByRole('listitem').filter({ hasText: 'ABC1 is induced 2.4-fold.' }).getByRole('button', { name: '출처 추적' }).click();
  await expect(page.getByTestId('trace-figure')).toContainText('최신 2 — 이전 버전에서 읽음');
  await expect(page.getByTestId('trace-flags')).toContainText('검토 필요 1건');
  // the manuscript text was not changed
  const headNow = (await h.pool.query('SELECT r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.id = $1', [documentId])).rows[0].content_json;
  expect(JSON.stringify(headNow)).toContain('ABC1 was induced (');
  // close one with a note
  const p = flags.filter({ hasText: '원고 문단' });
  await p.getByLabel('검토 메모').fill('wording still fits log2 values');
  await p.getByRole('button', { name: '검토함' }).click();
  await expect(page.getByTestId('flag')).toHaveCount(2);
  expect((await h.pool.query("SELECT resolution_note FROM figure_review_flags WHERE target_kind = 'paragraph'")).rows).toEqual([{ resolution_note: 'wording still fits log2 values' }]);
});
