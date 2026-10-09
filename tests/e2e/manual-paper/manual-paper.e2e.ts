// PW-014 — TST-014A / TST-014B in a real browser against the real API and PostgreSQL.
// Paper → evidence + fact verified → story and outline approved → manuscript typed and saved →
// named snapshot → a fresh browser session sees all of it. A database failure during save is
// never shown as saved and the text stays in the editor.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
// optional visual evidence for the task report (synthetic data only): PW_EVIDENCE_DIR=reports/tasks/PW-014/screens
const shot = async (page: Page, name: string) => {
  if (process.env.PW_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.PW_EVIDENCE_DIR}/${name}.png`, fullPage: true });
};
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

async function login(page: Page) {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '내 논문' })).toBeVisible();
}

test('TST-014A: manuscript, approvals, evidence and snapshot survive a new browser session', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);
  await page.getByLabel('새 논문 제목').fill('ABC1 drought response (synthetic)');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'ABC1 drought response (synthetic)' }).click();

  // evidence and a verified fact
  await page.getByRole('tab', { name: '자료' }).click();
  await page.getByLabel('근거 메모').fill('qPCR run 2026-03-14, plate 2, rows A–C (synthetic)');
  await page.getByRole('button', { name: '근거 추가' }).click();
  await page.getByRole('button', { name: '근거 검증' }).click();
  await expect(page.getByTestId('evidence-state').first()).toHaveText('VERIFIED');
  await page.getByLabel('대상', { exact: true }).fill('ABC1 transcript');
  await page.getByLabel('지표').fill('fold_change');
  await page.getByLabel('값(원문 그대로)').fill('2.4');
  await page.getByLabel('단위').fill('fold');
  await page.getByLabel('그룹', { exact: true }).fill('drought, 7 d');
  await page.getByLabel('비교 대상').fill('well-watered control');
  await page.getByLabel('반복 수(n)').fill('3');
  await page.getByRole('button', { name: '사실 추가' }).click();
  await page.getByRole('button', { name: '사실 검증' }).click();
  await expect(page.getByTestId('fact-state').first()).toHaveText('VERIFIED');

  // story and outline, approved explicitly
  await page.getByRole('tab', { name: '구상·개요' }).click();
  await page.getByLabel('연구 목적').fill('Test whether ABC1 responds to drought');
  await page.getByLabel('핵심 질문').fill('Does ABC1 respond to drought?');
  await page.getByLabel('핵심 메시지').fill('ABC1 transcript increases under drought');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await page.getByRole('button', { name: '이 스토리 버전 승인' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('APPROVED');
  await page.getByLabel('섹션').fill('Results');
  await page.getByLabel('문단 목표').fill('Report ABC1 induction under drought');
  await page.getByLabel('근거 필요').check();
  await page.getByLabel('근거 선택').selectOption({ index: 1 });
  await page.getByRole('button', { name: '개요 저장' }).click();
  await page.getByRole('button', { name: '이 개요 버전 승인' }).click();
  await expect(page.getByTestId('outline-status')).toHaveText('APPROVED');

  // manuscript typed by hand, saved only when the server says so
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const editor = page.getByTestId('editor').locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('ABC1 transcript rose 2.4-fold under drought.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Survival differed between lines.');
  await expect(page.getByTestId('save-status')).not.toHaveText('저장됨');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('저장됨');
  await shot(page, '1-manuscript-saved');

  // named snapshot
  await page.getByRole('tab', { name: '버전' }).click();
  await page.getByLabel('스냅샷 이름').fill('Before co-author review');
  await page.getByRole('button', { name: '스냅샷 만들기' }).click();
  await expect(page.getByText('Before co-author review')).toBeVisible();
  const paperUrl = page.url().split('#')[0]!;
  await ctx.close();

  // a new browser (no cookies, no local state) sees everything again
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await login(p2);
  await p2.goto(paperUrl);
  await p2.getByRole('tab', { name: '원고' }).click();
  await expect(p2.getByTestId('editor')).toContainText('ABC1 transcript rose 2.4-fold under drought.');
  await expect(p2.getByTestId('editor')).toContainText('Survival differed between lines.');
  await expect(p2.getByTestId('save-status')).toHaveText('저장됨');
  await p2.getByRole('tab', { name: '구상·개요' }).click();
  await expect(p2.getByTestId('story-status')).toHaveText('APPROVED');
  await expect(p2.getByTestId('outline-status')).toHaveText('APPROVED');
  await shot(p2, '2-new-session-plan-approved');
  await expect(p2.getByLabel('핵심 메시지')).toHaveValue('ABC1 transcript increases under drought');
  await p2.getByRole('tab', { name: '자료' }).click();
  await expect(p2.getByTestId('evidence-state').first()).toHaveText('VERIFIED');
  await expect(p2.getByTestId('fact-value').first()).toHaveText('2.4 fold');
  await expect(p2.getByTestId('fact-state').first()).toHaveText('VERIFIED');
  await p2.getByRole('tab', { name: '버전' }).click();
  await expect(p2.getByText('Before co-author review')).toBeVisible();
  await expect(p2.getByTestId('snapshot-pins').first()).toContainText('story');
  await shot(p2, '3-new-session-snapshot');
  await ctx2.close();
});

test('TST-014B: a database failure during save is never shown as saved, and the text is kept', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);
  await page.getByLabel('새 논문 제목').fill('Failure path paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Failure path paper' }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const editor = page.getByTestId('editor').locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('Text that must not be lost.');

  await h.failRevisionInserts(true); // the database itself refuses the write
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByTestId('save-status')).toHaveText(/저장되지 않/);
  await expect(page.getByTestId('save-status')).not.toHaveText('저장됨');
  await expect(page.getByTestId('editor')).toContainText('Text that must not be lost.');
  await shot(page, '4-db-failure-not-saved');
  // leaving the page with unsaved text asks first
  let asked = false;
  page.on('dialog', async (d) => { asked = d.type() === 'beforeunload'; await d.dismiss(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toBe(true);

  // the database recovers: the same text saves, and only then 저장됨
  const page2 = ctx.pages()[0] ?? page;
  await h.failRevisionInserts(false);
  await page2.getByRole('button', { name: '저장' }).click();
  await expect(page2.getByTestId('save-status')).toHaveText('저장됨');
  await page2.reload();
  await page2.getByRole('tab', { name: '원고' }).click();
  await expect(page2.getByTestId('editor')).toContainText('Text that must not be lost.');
  await ctx.close();
});
