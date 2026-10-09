// PW-021 — TST-021A / TST-021B in a real browser with the mock worker: an applied AI edit is undone after
// a page reload; two versions are compared; an import is previewed with its losses and replaces the
// manuscript only after an explicit confirmation, keeping the old text restorable.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: { chunkDelayMs: 0 } }); });
test.afterAll(async () => { await h?.stop(); });

const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const status = (page: Page) => page.getByTestId('save-status');
const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click();
const selectText = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __pwManuscript: { selectText(t: string): unknown } }).__pwManuscript.selectText(t), text);

async function prepare(page: Page, title: string, text: string) {
  await page.addInitScript(() => { (window as unknown as { __PW_TEST_HOOKS__: boolean }).__PW_TEST_HOOKS__ = true; });
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill(title);
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: title }).click();
  await tab(page, '원고');
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await editor(page).click();
  await page.keyboard.type(text);
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
}

test('TST-021A: an applied AI edit is undone after a reload, and versions compare', async ({ page }) => {
  await prepare(page, 'Undo paper', 'It was very very clear at 2.4-fold.');
  await selectText(page, 'very very clear');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '간결화' }).click();
  await page.getByTestId('selection-popup').getByRole('textbox').press('Enter');
  const item = page.getByTestId('proposals').getByTestId('proposal');
  await item.getByRole('button', { name: '적용' }).click();
  await expect(editor(page)).toHaveText('It was clear at 2.4-fold.');
  await expect(status(page)).toHaveText('저장됨');

  await page.reload();
  await tab(page, '원고');
  await expect(editor(page)).toHaveText('It was clear at 2.4-fold.');
  await tab(page, '버전');
  const edit = page.getByTestId('applied-edit');
  await expect(edit).toHaveCount(1);
  await expect(edit.locator('del')).toHaveText('very very ');
  await expect(edit.getByTestId('mock-badge')).toBeVisible();
  await edit.getByRole('button', { name: '되돌리기' }).click();
  await expect(edit.getByTestId('undo-state')).toContainText('되돌림');
  await expect(page.getByTestId('revision').first()).toHaveAttribute('data-reason', 'undo');
  await tab(page, '원고');
  await expect(editor(page)).toHaveText('It was very very clear at 2.4-fold.');
  await expect(status(page)).toHaveText('저장됨');

  // compare the AI version with the current one
  await tab(page, '버전');
  const aiRev = page.getByTestId('revision').filter({ hasText: 'AI 제안 적용' });
  const aiLabel = (await aiRev.locator('span').first().textContent())!;
  await page.getByLabel('이전 버전').selectOption({ label: aiLabel });
  await page.getByRole('button', { name: '비교' }).click();
  const diff = page.getByTestId('version-diff');
  await expect(diff.locator('[data-change="changed"] ins')).toHaveText('very very ');
  // history only grows: initial, saves, ai_apply, undo
  const reasons = await page.getByTestId('revision').evaluateAll((els) => els.map((e) => e.getAttribute('data-reason')));
  expect(reasons[0]).toBe('undo');
  expect(reasons).toContain('ai_apply');
  expect(reasons.at(-1)).toBe('initial');
});

test('TST-021B: an import shows its losses and replaces the manuscript only after confirmation; the old text is restorable', async ({ page }) => {
  await prepare(page, 'Import paper', 'My own first draft.');
  await tab(page, '버전');
  await page.getByLabel('가져올 파일').setInputFiles({ name: 'draft.md', mimeType: 'text/markdown', buffer: Buffer.from('# Results\n\nCells grew **2.4-fold** ([site](https://example.org)).\n\n- one\n- two\n') });
  await expect(page.getByLabel('형식', { exact: true })).toHaveValue('markdown');
  await page.getByRole('button', { name: '미리 보기' }).click();
  const prev = page.getByTestId('import-preview');
  await expect(prev).toContainText('draft.md');
  await expect(prev.getByTestId('import-losses')).toContainText('링크 주소를 빼고');
  await expect(prev.getByTestId('import-losses')).toContainText('목록을 기호가 붙은 문단으로');
  await expect(prev.locator('h3')).toHaveText('Results');
  const replace = prev.getByRole('button', { name: '원고를 가져온 내용으로 바꾸기' });
  await expect(replace).toBeDisabled();
  // nothing changed yet
  await tab(page, '원고');
  await expect(editor(page)).toHaveText('My own first draft.');
  await tab(page, '버전');
  await prev.getByRole('checkbox').check();
  await replace.click();
  await expect(page.getByTestId('revision').first()).toHaveAttribute('data-reason', 'import');
  await tab(page, '원고');
  await expect(editor(page).locator('h1')).toHaveText('Results');
  await expect(editor(page)).toContainText('Cells grew 2.4-fold (site).');
  await expect(status(page)).toHaveText('저장됨');

  // the replaced draft is restored as a new version
  await tab(page, '버전');
  const old = page.getByTestId('revision').filter({ hasText: '자동 저장' }).first();
  await old.getByRole('button', { name: '이 버전으로 복원' }).click();
  await page.getByRole('group', { name: '복원 확인' }).getByRole('button', { name: '복원 확인' }).click();
  await expect(page.getByTestId('revision').first()).toHaveAttribute('data-reason', 'restore');
  await tab(page, '원고');
  await expect(editor(page)).toHaveText('My own first draft.');
});

test('TST-021B: with unsaved typing in the editor, the versions tab does not change the head', async ({ page }) => {
  await prepare(page, 'Guard paper', 'Draft text.');
  // block the save so the typing stays unsaved
  await h.failRevisionInserts(true);
  try {
    await editor(page).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' More');
    await expect(status(page)).not.toHaveText('저장됨', { timeout: 10_000 });
    await tab(page, '버전');
    await expect(page.getByTestId('versions-blocked')).toContainText('저장되지 않은 변경');
    await expect(page.getByTestId('revision').filter({ hasText: '처음' }).getByRole('button', { name: '이 버전으로 복원' })).toBeDisabled();
  } finally {
    await h.failRevisionInserts(false);
  }
});
