// PW-041 — TST-041A/B in a real browser: the user picks writing references, asks for a profile (MOCK),
// sees each rule with the reference and section it came from and which sources were only partly read,
// approves the exact version, adds a journal rule (a new draft; the approved profile stays until that
// draft is approved) and leaves feedback that changes nothing by itself.
import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { createReference } from '../../../packages/domain/src/references/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: {} }); });
test.afterAll(async () => { await h?.stop(); });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
async function sourceWithText(paperId: string, owner: string, title: string, pages: string[]) {
  const ref = await createReference(h.pool, { paperId, ownerId: owner, body: { title, authors: [{ family: 'Kim' }], year: 2020 } });
  const asset = (await h.pool.query("INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, original_name, created_by) VALUES ($1, $2, $3, 100, 'application/pdf', 'x.pdf', $4) RETURNING id",
    [paperId, `source-${randomUUID()}`, sha(title), owner])).rows[0].id;
  await h.pool.query("INSERT INTO asset_sources (asset_revision_id, paper_id, owner_id, kind, source, reference_id, page_count, inspected_with) VALUES ($1, $2, $3, 'source_pdf', 'user_upload', $4, $5, 'test')", [asset, paperId, owner, ref.id, pages.length]);
  await h.pool.query("INSERT INTO asset_policy_revisions (asset_revision_id, paper_id, license, keep_right, external_send, decided_by) VALUES ($1, $2, 'unknown', 'user_supplied', 'allowed', $3)", [asset, paperId, owner]);
  const ex = (await h.pool.query("INSERT INTO pdf_extractions (paper_id, asset_revision_id, sha256, extractor, status, page_count) VALUES ($1, $2, $3, 'pdfjs-test', 'ok', $4) RETURNING id", [paperId, asset, sha(title), pages.length])).rows[0].id;
  for (const [i, t] of pages.entries()) await h.pool.query("INSERT INTO pdf_pages (extraction_id, page_index, view_box, rotate, text, runs) VALUES ($1, $2, '{0,0,612,792}', 0, $3, '[]')", [ex, i, t]);
}

test('TST-041A/B: a proposed profile shows its sources; the user approves it, adds a journal rule and feedback', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Profile paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Profile paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  await sourceWithText(paperId, ownerId, 'Fully read paper', ['Introduction\nDrought limits yield.', 'Discussion\nWe compare with earlier reports and name the limits.']);
  await sourceWithText(paperId, ownerId, 'Abstract only paper', ['Abstract\nWe show a drought response.']);

  await page.getByRole('tab', { name: '글쓰기 프로필' }).click();
  const panel = page.getByTestId('writing-profile');
  await expect(panel.getByTestId('profile-active')).toHaveText('승인된 프로필 없음');
  await panel.getByLabel('Fully read paper').check();
  await panel.getByLabel('Abstract only paper').check();
  await panel.getByRole('button', { name: '프로필 제안 요청' }).click();
  const latest = panel.getByTestId('profile-latest');
  await expect(latest.getByTestId('profile-status')).toHaveText('DRAFT');
  await expect(latest.getByTestId('profile-label')).toHaveText('MOCK');
  await expect(latest.getByTestId('profile-source').filter({ hasText: 'Fully read paper' })).toContainText('본문 읽음 (Introduction, Discussion)');
  await expect(latest.getByTestId('profile-source').filter({ hasText: 'Abstract only paper' })).toContainText('초록만 읽음 (Abstract)');
  // a Discussion rule names the fully read paper, not the abstract-only one
  const discussion = latest.getByTestId('profile-role').filter({ hasText: 'Discussion' });
  await expect(discussion.getByTestId('profile-principle')).toContainText('[Fully read paper · Discussion]');
  await expect(discussion).not.toContainText('Abstract only paper');

  await latest.getByRole('button', { name: '이 버전 승인' }).click();
  await expect(latest.getByTestId('profile-status')).toHaveText('APPROVED');
  await expect(panel.getByTestId('profile-active')).toHaveText('승인된 프로필 있음');

  await latest.getByLabel('규정 내용').fill('Abstract at most 200 words.');
  await latest.getByLabel('출처(주소 또는 문서)').fill('https://journal.example/guide');
  await latest.getByLabel('확인한 날짜').fill('2026-10-01');
  await latest.getByRole('button', { name: '저널 규정 넣은 새 초안' }).click();
  await expect(latest.getByTestId('profile-status')).toHaveText('DRAFT');
  await expect(latest.getByTestId('profile-journal-rule')).toContainText('Abstract at most 200 words.');
  await expect(panel.getByTestId('profile-active')).toHaveText('승인된 프로필 있음'); // the earlier approval stays in force

  await panel.getByLabel('의견').fill('Prefer shorter Results paragraphs.');
  await panel.getByRole('button', { name: '의견 남기기' }).click();
  await expect(panel.getByTestId('profile-feedback')).toHaveText(['Prefer shorter Results paragraphs.']);
  await expect(latest.getByTestId('profile-status')).toHaveText('DRAFT');
});
