// PW-056 — exports in a real browser: a manuscript with a citation number typed as text exports as a draft
// with the reason shown; once fixed, the export passes the check; the file downloads as stored.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('TST-056A/B: a typed citation number makes a draft; a clean manuscript exports clean; the file downloads as stored', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Export paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Export paper' }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const editor = page.getByTestId('editor').locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  await page.keyboard.type('Root growth increased as reported [7].');
  await expect(page.getByTestId('save-status')).toHaveText('저장됨', { timeout: 15_000 });

  await page.getByRole('tab', { name: '버전' }).click();
  const panel = page.getByTestId('exports');
  await panel.getByRole('button', { name: 'Word로 내보내기' }).click();
  const draft = panel.getByTestId('export').first();
  await expect(draft).toHaveAttribute('data-status', 'draft_with_errors');
  await expect(draft.getByTestId('export-status')).toContainText('초안');
  await expect(draft.locator('[data-kind="citation_like_text"]')).toContainText('[7]');
  await page.screenshot({ path: 'reports/tasks/PW-056/1-draft-export.png', fullPage: true });

  // the typed number removed: the export passes the check
  await page.getByRole('tab', { name: '원고' }).click();
  await editor.click();
  await page.keyboard.press('End');
  for (let i = 0; i < ' as reported [7].'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('.');
  await expect(page.getByTestId('save-status')).toHaveText('저장됨', { timeout: 15_000 });
  await page.getByRole('tab', { name: '버전' }).click();
  await panel.getByRole('button', { name: 'Word로 내보내기' }).click();
  const clean = panel.getByTestId('export').first();
  await expect(clean).toHaveAttribute('data-status', 'clean');
  await expect(clean.getByTestId('export-status')).toHaveText('검사 통과');
  await expect(panel.getByTestId('export')).toHaveCount(2);

  const href = await clean.getByTestId('export-file').getAttribute('href');
  const res = await page.request.get(new URL(href!, h.webUrl).toString());
  expect(res.status()).toBe(200);
  const body = await res.body();
  const stored = (await h.pool.query("SELECT sha256 FROM exports WHERE status = 'clean'")).rows[0].sha256;
  expect(createHash('sha256').update(body).digest('hex')).toBe(stored);
  expect(body.subarray(0, 2).toString()).toBe('PK');
  await page.screenshot({ path: 'reports/tasks/PW-056/2-clean-export.png', fullPage: true });
});
