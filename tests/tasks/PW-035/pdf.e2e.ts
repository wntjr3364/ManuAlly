// PW-035 — in a real browser: upload a PDF original, extract its text (worker job), select a sentence
// and confirm it as an evidence location, then — after a reload — re-open it as a highlight on the
// rendered page (rotated pages included). A click without a selection in the page text confirms nothing.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { PAPER_V1 } from './fixtures.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: { chunkDelayMs: 10 } }); });
test.afterAll(async () => { await h?.stop(); });

const selectInText = (page: Page, quote: string, nth = 0) => page.evaluate(([q, n]) => {
  const pre = document.querySelector('[data-testid="page-text"]')!;
  const node = pre.firstChild!;
  let at = -1;
  for (let i = 0; i <= (n as number); i++) at = node.textContent!.indexOf(q as string, at + 1);
  const r = document.createRange();
  r.setStart(node, at);
  r.setEnd(node, at + (q as string).length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}, [quote, nth] as const);

test('TST-035A/B: confirm a quote, reload, re-open it as a highlight on the rendered (and rotated) page', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('PDF paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'PDF paper' }).click();
  await page.getByRole('tab', { name: '원문' }).click();

  await page.getByLabel('PDF 파일').setInputFiles({ name: 'synthetic-kim-2021.pdf', mimeType: 'application/pdf', buffer: PAPER_V1() });
  await page.getByLabel('라이선스').selectOption('cc-by');
  await page.getByRole('button', { name: '올리기' }).click();
  const item = page.getByTestId('asset').filter({ hasText: 'synthetic-kim-2021.pdf' });
  await expect(item).toContainText('2쪽');
  await expect(item).toContainText('외부 AI 전송: 정하지 않음');
  await item.getByRole('button', { name: '열기' }).click();
  await expect(page.getByTestId('page-canvas')).toHaveAttribute('width', /^\d{3}$/);
  await page.getByRole('button', { name: '텍스트 추출' }).click();
  await expect.poll(async () => { await page.getByRole('button', { name: '새로 고침' }).click(); return page.getByTestId('extraction-status').textContent(); }, { timeout: 15_000 }).toBe('텍스트 추출됨');

  // "induced" occurs twice on the page; the browser sends the selection's surroundings, so the second
  // one is located exactly (the API refuses a quote that stays ambiguous: integration tests)
  await page.getByRole('button', { name: '선택을 근거 위치로 확인' }).click();
  await expect(page.getByRole('alert')).toContainText('문장을 선택하세요');
  await selectInText(page, 'induced', 1);
  await page.getByRole('button', { name: '선택을 근거 위치로 확인' }).click();
  await expect(page.getByTestId('anchor')).toHaveCount(1);
  await selectInText(page, 'induced 2.4-fold');
  await page.getByRole('button', { name: '선택을 근거 위치로 확인' }).click();
  await expect(page.getByTestId('anchor')).toHaveCount(2);
  await expect(page.getByTestId('anchor-box')).toHaveCount(1);

  // reload: re-open the confirmed location from the stored record
  await page.reload();
  await page.getByRole('tab', { name: '원문' }).click();
  await page.getByTestId('asset').filter({ hasText: 'synthetic-kim-2021.pdf' }).getByRole('button', { name: '열기' }).click();
  const anchor = page.getByTestId('anchor').filter({ hasText: 'induced 2.4-fold' });
  await expect(anchor).toContainText('1쪽');
  await expect(anchor).toHaveAttribute('data-status', 'ok');
  await anchor.getByRole('button', { name: '다시 열기' }).click();
  const box = page.getByTestId('anchor-box');
  await expect(box).toHaveCount(1);
  // the box sits where the quote is drawn: right of the 72 pt margin, near the top of the 792 pt page (scale 1.25)
  const b = await box.evaluate((el) => ({ left: parseFloat((el as HTMLElement).style.left), top: parseFloat((el as HTMLElement).style.top), w: parseFloat((el as HTMLElement).style.width), h: parseFloat((el as HTMLElement).style.height) }));
  expect(b.left).toBeGreaterThan(72 * 1.25);
  expect(b.top).toBeGreaterThan((792 - 732) * 1.25 - 2);
  expect(b.top).toBeLessThan((792 - 720) * 1.25);
  expect(b.h).toBeCloseTo(12 * 1.25, 0);
  if (process.env.PW_SAVE_EVIDENCE === '1') await page.screenshot({ path: 'reports/tasks/PW-035/anchor-reopened.png', fullPage: true });

  // the rotated second page: its location is drawn on the rotated view
  await page.getByRole('button', { name: '다음 쪽' }).click();
  await expect(page.getByTestId('page-flag')).toContainText('회전된 쪽');
  await expect(page.getByTestId('page-canvas')).toHaveAttribute('width', String(Math.floor(792 * 1.25)));
  await selectInText(page, 'ABC1 in leaves');
  await page.getByRole('button', { name: '선택을 근거 위치로 확인' }).click();
  const rb = page.getByTestId('anchor-box');
  await expect(rb).toHaveCount(1);
  // rotated 90°: the text runs down the canvas, so the box is taller than wide
  const r = await rb.evaluate((el) => ({ w: parseFloat((el as HTMLElement).style.width), h: parseFloat((el as HTMLElement).style.height) }));
  expect(r.h).toBeGreaterThan(r.w);
  if (process.env.PW_SAVE_EVIDENCE === '1') await page.screenshot({ path: 'reports/tasks/PW-035/rotated-page.png', fullPage: true });
});
