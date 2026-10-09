// PW-018 — TST-018A / TST-018B in a real browser: a comment follows its text when that is certain and
// is shown as having lost its place otherwise; it is never moved to a similar sentence.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

type Hooks = { selectText(t: string): unknown; moveBlock(i: number, j: number): void };
const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const status = (page: Page) => page.getByTestId('save-status');
const selectText = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __pwManuscript: Hooks }).__pwManuscript.selectText(t), text);
const comments = (page: Page) => page.getByTestId('comments');
const highlight = (page: Page) => editor(page).locator('.comment-highlight');

async function start(page: Page, title: string) {
  await page.addInitScript(() => { (window as unknown as { __PW_TEST_HOOKS__: boolean }).__PW_TEST_HOOKS__ = true; });
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill(title);
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: title }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await editor(page).click();
  await page.keyboard.type('Roots grew. Expression rose in roots. Leaves were small.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Other paragraph.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await selectText(page, 'Expression rose in roots.');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '코멘트' }).click();
  await page.getByTestId('selection-popup').getByRole('textbox').fill('Is this measured?');
  await page.keyboard.press('Enter');
  await expect(comments(page).getByTestId('comment')).toHaveCount(1);
  await expect(highlight(page)).toHaveText('Expression rose in roots.');
}

test('TST-018A: after the paragraph moves and a small edit, the comment stays on its sentence', async ({ page }) => {
  await start(page, 'Comment move paper');
  const item = comments(page).getByTestId('comment');
  await expect(item).toContainText('Is this measured?');
  await expect(item).toHaveAttribute('data-anchor', 'ATTACHED');
  await page.evaluate(() => (window as unknown as { __pwManuscript: Hooks }).__pwManuscript.moveBlock(0, 1));
  await expect(editor(page).locator('p').nth(1)).toContainText('Expression rose in roots.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await expect(highlight(page)).toHaveText('Expression rose in roots.');
  await editor(page).locator('p').nth(1).click();
  await page.keyboard.press('Home');
  await page.keyboard.type('Many ');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await expect(item).toContainText('위치 이동됨');
  await expect(item).toHaveAttribute('data-anchor', 'ATTACHED');
  await expect(highlight(page)).toHaveText('Expression rose in roots.');
});

test('TST-018B: a deleted sentence or two equal candidates leave the comment without a place; it can be attached again', async ({ page }) => {
  await start(page, 'Comment orphan paper');
  const item = comments(page).getByTestId('comment');
  await selectText(page, 'Expression rose in roots. ');
  await page.keyboard.press('Backspace');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await expect(item).toHaveAttribute('data-anchor', 'ORPHANED');
  await expect(item).toContainText('코멘트한 문장이 바뀌거나 삭제됨');
  await expect(highlight(page)).toHaveCount(0);
  // the same sentence comes back twice: the place is ambiguous, so it stays without a place
  await selectText(page, 'Leaves');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('Expression rose in roots. Expression rose in roots. ');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await expect(item).toContainText('같은 문장이 여러 곳에 있어');
  await expect(highlight(page)).toHaveCount(0);
  // the owner attaches it to the first of them
  await page.evaluate(() => {
    const ed = (window as unknown as { __pwManuscript: Hooks }).__pwManuscript;
    ed.selectText('Expression rose in roots.');
  });
  await item.getByRole('button', { name: '선택한 곳에 다시 연결' }).click();
  await expect(item).toHaveAttribute('data-anchor', 'ATTACHED');
  await expect(highlight(page)).toHaveCount(1);
});

test('replies, resolve and reopen; a resolved comment has no highlight', async ({ page }) => {
  await start(page, 'Comment thread paper');
  const item = comments(page).getByTestId('comment');
  await item.getByLabel('답글').fill('Yes, by qPCR.');
  await item.getByRole('button', { name: '답글' }).click();
  await expect(item.locator('.comment-message')).toHaveText(['Is this measured?', 'Yes, by qPCR.']);
  // resolving while the screen has unsaved text removes the highlight at once (review nit)
  await editor(page).locator('p').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' x');
  await item.getByRole('button', { name: '해결' }).click();
  await expect(highlight(page)).toHaveCount(0);
  await expect(comments(page).getByTestId('comment')).toHaveCount(0);
  await expect(highlight(page)).toHaveCount(0);
  await comments(page).getByLabel(/해결된 코멘트도 보기/).check();
  await comments(page).getByRole('button', { name: '다시 열기' }).click();
  await expect(highlight(page)).toHaveText('Expression rose in roots.');
});
