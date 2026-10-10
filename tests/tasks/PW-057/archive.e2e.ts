// PW-057 — the reading PDF and the source archive in a real browser: a snapshot made in the snapshot panel
// appears in the export panel; the share archive is made, says what it left out, downloads as stored and
// verifies on its own; the PDF (LibreOffice required) downloads as a PDF.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { verifyArchive } from '../../../packages/exports/src/archive/index.ts';
import { findSoffice } from '../../../packages/exports/src/pdf/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('TST-057A/B: a snapshot\'s share archive and the reading PDF from the export panel', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Archive paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Archive paper' }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const editor = page.getByTestId('editor').locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  await page.keyboard.type('Root growth increased under drought.');
  await expect(page.getByTestId('save-status')).toHaveText('저장됨', { timeout: 15_000 });

  await page.getByRole('tab', { name: '버전' }).click();
  const panel = page.getByTestId('exports');
  await expect(panel.getByTestId('archive-needs-snapshot')).toBeVisible();
  await page.getByLabel('스냅샷 이름').fill('submitted v1');
  await page.getByRole('button', { name: '스냅샷 만들기' }).click();
  await expect(panel.getByTestId('archive-snapshot')).toContainText('submitted v1');

  await panel.getByRole('button', { name: '공유용 원본 묶음' }).click();
  const archive = panel.locator('[data-testid="export"][data-format="source_archive"]').first();
  await expect(archive).toHaveAttribute('data-status', 'clean');
  await expect(archive).toHaveAttribute('data-purpose', 'share');
  await expect(archive).toContainText('submitted v1');
  await expect(archive).toContainText('묶음 자체 검증 통과');
  await expect(archive).toContainText('Word 출력 재현됨');
  const href = await archive.getByTestId('export-file').getAttribute('href');
  const res = await page.request.get(new URL(href!, h.webUrl).toString());
  expect(res.status()).toBe(200);
  const body = await res.body();
  const stored = (await h.pool.query("SELECT sha256 FROM exports WHERE format = 'source_archive'")).rows[0].sha256;
  expect(createHash('sha256').update(body).digest('hex')).toBe(stored);
  expect(verifyArchive(body)).toMatchObject({ ok: true, reproduced: true });
  await page.screenshot({ path: 'reports/tasks/PW-057/1-share-archive.png', fullPage: true });

  // the PDF needs LibreOffice on this machine; without it the test fails and says so (never skipped)
  expect(await findSoffice(), 'LibreOffice (soffice) is needed for the PDF tests').toBeTruthy();
  {
    await panel.getByRole('button', { name: 'PDF로 내보내기' }).click();
    const pdf = panel.locator('[data-testid="export"][data-format="pdf"]').first();
    await expect(pdf).toHaveAttribute('data-status', 'clean', { timeout: 120_000 });
    await expect(pdf).toContainText('본문 확인됨');
    const p = await page.request.get(new URL((await pdf.getByTestId('export-file').getAttribute('href'))!, h.webUrl).toString());
    expect(p.headers()['content-type']).toBe('application/pdf');
    expect((await p.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await page.screenshot({ path: 'reports/tasks/PW-057/2-pdf.png', fullPage: true });
  }
});
