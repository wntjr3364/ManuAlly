// PW-055 — Word import in a real browser (Chromium, real API, temporary PostgreSQL): the page asks which text
// to take when tracked changes are unresolved, shows the preview with every loss and the "not a round trip"
// warning, offers the original for download (byte for byte), and only then makes the manuscript.
import { test, expect } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { richDocx } from './fixture.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('TST-055A/B: choose the tracked-change text, check the losses, keep the original, then import', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Word paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Word paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  await page.getByRole('tab', { name: '버전' }).click();

  const bytes = richDocx();
  const panel = page.getByTestId('docx-import');
  await panel.getByLabel('가져올 Word 파일').setInputFiles({ name: 'paper.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes });
  // unresolved tracked changes: the page asks first, nothing is stored yet
  const ask = panel.getByTestId('docx-tracked-choice');
  await expect(ask).toContainText('삽입 1곳, 삭제 1곳');
  expect((await h.pool.query('SELECT count(*)::int AS n FROM import_sources WHERE paper_id = $1', [paperId])).rows[0].n).toBe(0);
  await ask.getByLabel('변경 전 원문(변경 거부)').check();
  await ask.getByRole('button', { name: '이 글로 미리 보기' }).click();

  const preview = panel.getByTestId('docx-preview');
  await expect(preview).toContainText('The marker was barely induced.');
  await expect(preview).toContainText('변경 전 원문');
  await expect(preview.getByTestId('docx-round-trip')).toContainText('왕복 변환 아님');
  const losses = preview.getByTestId('docx-losses');
  for (const kind of ['tracked_change', 'comment', 'citation_field', 'bibliography_field', 'equation', 'table_layout', 'image', 'footnote', 'link']) {
    await expect(losses.locator(`[data-kind="${kind}"]`)).toBeVisible();
  }
  await expect(losses.locator('[data-kind="comment"]')).toContainText('Please cite the source.');
  await expect(losses.locator('[data-kind="citation_field"]')).toContainText('(Kim et al., 2020)');
  // the original downloads byte for byte
  const href = await preview.getByTestId('docx-original').getAttribute('href');
  const dl = await page.request.get(new URL(href!, h.webUrl).toString());
  expect(dl.status()).toBe(200);
  expect(Buffer.compare(await dl.body(), bytes)).toBe(0);
  // nothing changed yet
  expect((await h.pool.query("SELECT count(*)::int AS n FROM documents WHERE paper_id = $1", [paperId])).rows[0].n).toBe(0);
  await page.screenshot({ path: 'reports/tasks/PW-055/1-docx-preview.png', fullPage: true });

  await preview.getByRole('button', { name: 'Word 내용으로 새 원고 만들기' }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(page.getByTestId('editor')).toContainText('The marker was barely induced.');
  await expect(page.getByTestId('editor')).not.toContainText('Please cite the source.');
  const head = (await h.pool.query("SELECT r.reason FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1", [paperId])).rows[0];
  expect(head.reason).toBe('import');
  // the original is still there after applying
  expect((await h.pool.query('SELECT count(*)::int AS n FROM import_sources WHERE paper_id = $1', [paperId])).rows[0].n).toBe(1);
  await page.screenshot({ path: 'reports/tasks/PW-055/2-imported.png', fullPage: true });
});
