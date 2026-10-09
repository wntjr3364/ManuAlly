// PW-022 — P02 selection-editing browser gate.
// TST-022A: the core workflow (select → short request → diff → apply → undo) by keyboard at 1366×768
//   and 1920×1080, with the toolbar, popup and panels on screen and no horizontal scrolling.
// TST-022B: duplicate sentences, emoji, citation atoms and two tabs never let a change land in the
//   wrong place; every AI apply in these papers is audited against the exact expected paragraph.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { aiApplies, editor, head, lastQuote, newManuscript, paragraphText, requestConcise, selectFromEnd, status, tab } from '../../e2e/editor/helpers.ts';
import { createReference } from '../../../packages/domain/src/references/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: { chunkDelayMs: 0 } }); });
test.afterAll(async () => { await h?.stop(); });

async function onScreen(page: Page, testId: string) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const vp of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  test(`TST-022A: keyboard workflow at ${vp.width}×${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    const paperId = await newManuscript(page, h, `Keyboard ${vp.width}`);
    await editor(page).click();
    await page.keyboard.type('It was very very clear at 2.4-fold.');
    await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
    // select "very very clear" with the keyboard
    await page.keyboard.press('End');
    for (let i = 0; i < ' at 2.4-fold.'.length; i++) await page.keyboard.press('ArrowLeft');
    for (let i = 0; i < 'very very clear'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    await expect(page.getByTestId('selection-toolbar')).toBeVisible();
    await onScreen(page, 'selection-toolbar');
    // Ctrl+Shift+K moves to the toolbar; Tab to "간결화"; Enter opens the popup with focus in the box
    await page.keyboard.press('Control+Shift+K');
    for (let i = 0; i < 6 && (await page.evaluate(() => document.activeElement?.textContent)) !== '간결화'; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('간결화');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('selection-popup')).toBeVisible();
    await onScreen(page, 'selection-popup');
    await expect(page.getByTestId('selection-popup').getByRole('textbox')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ai-job').first()).toHaveAttribute('data-phase', 'proposal_ready', { timeout: 15_000 });
    const item = page.getByTestId('proposals').getByTestId('proposal');
    await expect(item.locator('del')).toHaveText('very very ');
    await onScreen(page, 'proposals');
    await page.screenshot({ path: `reports/tasks/PW-022/proposal-${vp.width}x${vp.height}.png` });
    // apply with the keyboard
    await item.getByRole('button', { name: '적용' }).focus();
    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveText('It was clear at 2.4-fold.');
    await expect(status(page)).toHaveText('저장됨');
    // undo from the versions tab with the keyboard
    await page.getByRole('tab', { name: '버전' }).focus();
    await page.keyboard.press('Enter');
    const undo = page.getByTestId('applied-edit').getByRole('button', { name: '되돌리기' });
    await undo.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('applied-edit').getByTestId('undo-state')).toContainText('되돌림');
    await page.screenshot({ path: `reports/tasks/PW-022/versions-${vp.width}x${vp.height}.png` });
    await tab(page, '원고');
    await expect(editor(page)).toHaveText('It was very very clear at 2.4-fold.');
    expect(await noHorizontalScroll(page)).toBe(true);
    expect(paragraphText((await head(h, paperId)).content_json)).toBe('It was very very clear at 2.4-fold.');
  });
}

// applies the (only) proposal that can be applied
async function lastQuoteAfterRequest(page: Page, outcome: string) {
  await requestConcise(page, outcome);
  return lastQuote(page);
}

async function applyFirstProposal(page: Page) {
  await page.getByTestId('proposals').getByRole('button', { name: '적용' }).first().click();
}

test('TST-022B: duplicate sentences — only the selected occurrence changes', async ({ page }) => {
  const paperId = await newManuscript(page, h, 'Duplicate paper');
  await editor(page).click();
  await page.keyboard.type('It was very clear. It was very clear.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await selectFromEnd(page, 1, 'very clear'.length, 'very clear'); // the second "very clear"
  await requestConcise(page);
  await applyFirstProposal(page);
  await expect(editor(page)).toHaveText('It was very clear. It was clear.');
  await expect(status(page)).toHaveText('저장됨');
  expect(paragraphText((await head(h, paperId)).content_json)).toBe('It was very clear. It was clear.');
  const applies = await aiApplies(h, paperId);
  expect(applies).toHaveLength(1);
  expect(paragraphText(applies[0]!.after as never)).toBe('It was very clear. It was clear.');
});

test('TST-022B: emoji before the selection — the change lands at the right characters', async ({ page }) => {
  const paperId = await newManuscript(page, h, 'Emoji paper');
  await editor(page).click();
  await page.keyboard.type('🧪 It was very clear 😀 and very clear.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await selectFromEnd(page, 1, 'very clear'.length, 'very clear');
  await requestConcise(page);
  await applyFirstProposal(page);
  await expect(editor(page)).toHaveText('🧪 It was very clear 😀 and clear.');
  await expect(status(page)).toHaveText('저장됨');
  expect(paragraphText((await head(h, paperId)).content_json)).toBe('🧪 It was very clear 😀 and clear.');
});

test('TST-022B: citation atoms — a change that would move a citation to another word is refused; a safe one keeps both atoms in place', async ({ page }) => {
  const paperId = await newManuscript(page, h, 'Atom paper');
  const owner = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id;
  const ref = await createReference(h.pool, { paperId, ownerId: owner, body: { title: 'Drought paper', authors: [{ family: 'Kim' }], year: 2020 } });
  await page.getByTestId('references').getByRole('button', { name: '새로고침' }).click();
  await editor(page).click();
  await page.keyboard.type('As shown ');
  await page.getByTestId('reference-list').locator('li', { hasText: 'Drought paper' }).getByRole('button', { name: '인용 넣기' }).click();
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' it was very ');
  await page.getByTestId('reference-list').locator('li', { hasText: 'Drought paper' }).getByRole('button', { name: '인용 넣기' }).click();
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' clear and very very bright.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  const start = paragraphText((await head(h, paperId)).content_json);
  expect(start).toBe('As shown [citation] it was very [citation] clear and very very bright.');
  // 1) "very [cite] clear": dropping "very" would put the citation after "was" — refused by the checks
  await selectFromEnd(page, ' and very very bright.'.length, 'very '.length + 1 + ' clear'.length);
  expect(await lastQuoteAfterRequest(page, 'check_failed')).toBe('very  clear'); // the quote leaves the atom out
  await expect(page.getByTestId('proposals').getByTestId('proposal-checks')).toContainText('citation_positions');
  expect(paragraphText((await head(h, paperId)).content_json)).toBe(start);
  // 2) "[cite] clear and very very bright": the citation stays after "very"
  await selectFromEnd(page, 1, 1 + ' clear and very very bright'.length);
  expect(await lastQuoteAfterRequest(page, 'proposal_ready')).toBe(' clear and very very bright');
  await applyFirstProposal(page);
  await expect(status(page)).toHaveText('저장됨');
  const after = (await head(h, paperId)).content_json;
  expect(paragraphText(after)).toBe('As shown [citation] it was very [citation] clear and bright.');
  const cites = (after.content[0]!.content ?? []).filter((n) => n.type === 'citation');
  expect(cites.map((c) => (c.attrs as { referenceId: string }).referenceId)).toEqual([ref.id, ref.id]);
});

test('TST-022B: two tabs — a proposal made before another tab\'s edit is refused, and an old tab never overwrites an apply', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const paperId = await newManuscript(a, h, 'Two tabs paper');
  await editor(a).click();
  await a.keyboard.type('It was very very clear.');
  await expect(status(a)).toHaveText('저장됨', { timeout: 10_000 });
  const b = await ctx.newPage();
  await b.addInitScript(() => { (window as unknown as { __PW_TEST_HOOKS__: boolean }).__PW_TEST_HOOKS__ = true; });
  await b.goto(a.url());
  await tab(b, '원고');
  await expect(editor(b)).toHaveText('It was very very clear.');

  // 1) A asks for a correction; B then edits the same paragraph; A's apply is refused (stale)
  await a.bringToFront();
  await selectFromEnd(a, 1, 'very very clear'.length, 'very very clear');
  await requestConcise(a);
  await b.bringToFront();
  await editor(b).click();
  await b.keyboard.press('End');
  await b.keyboard.type(' Indeed.');
  await expect(status(b)).toHaveText('저장됨', { timeout: 10_000 });
  await a.bringToFront();
  await applyFirstProposal(a);
  await expect(a.getByTestId('proposals').getByRole('alert')).toBeVisible();
  expect(paragraphText((await head(h, paperId)).content_json)).toBe('It was very very clear. Indeed.');
  expect(await aiApplies(h, paperId)).toHaveLength(0);

  // 2) A reloads and applies a fresh proposal; B (still on the older head) types: B's save is refused,
  //    the applied text stays
  await a.reload();
  await a.bringToFront(); // a reloaded page in a two-page browser does not get focus back by itself
  await tab(a, '원고');
  await expect(editor(a)).toHaveText('It was very very clear. Indeed.');
  await selectFromEnd(a, ' Indeed.'.length + 1, 'very very clear'.length, 'very very clear');
  await requestConcise(a);
  expect(await lastQuote(a)).toBe('very very clear');
  await applyFirstProposal(a);
  await expect(editor(a)).toHaveText('It was clear. Indeed.');
  await expect(status(a)).toHaveText('저장됨');
  await b.bringToFront();
  await editor(b).click();
  await b.keyboard.press('End');
  await b.keyboard.type(' Late.');
  await expect(status(b)).not.toHaveText('저장됨', { timeout: 10_000 });
  await expect(status(b)).toContainText(/충돌|다른 곳|새로/, { timeout: 10_000 });
  expect(paragraphText((await head(h, paperId)).content_json)).toBe('It was clear. Indeed.');
  const applies = await aiApplies(h, paperId);
  expect(applies.map((x) => paragraphText(x.after as never))).toEqual(['It was clear. Indeed.']);
  await ctx.close();
});

test('TST-022B: background reloads (window focus) do not touch the editor while a selection is being made', async ({ page }) => {
  await newManuscript(page, h, 'Focus paper');
  await editor(page).click();
  await page.keyboard.type('Some text here.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await page.evaluate(() => {
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor: { on(e: string, f: () => void): void } }).editor;
    const w = window as unknown as { __tr: number };
    w.__tr = 0;
    ed.on('transaction', () => { w.__tr++; });
  });
  // the references and comments panels reload on focus; with nothing changed they must not dispatch
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __tr: number }).__tr)).toBe(0);
});

test('TST-022B: an autosave (new stored head) does not make the comments layer dispatch when nothing changed', async ({ page }) => {
  await newManuscript(page, h, 'Autosave paper');
  await editor(page).click();
  await page.keyboard.type('Some text here.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor: { on(e: string, f: (x: { transaction: { meta: object } }) => void): void } }).editor;
    const w = window as unknown as { __metas: string[] };
    w.__metas = [];
    ed.on('transaction', ({ transaction }) => { w.__metas.push(...Object.keys(transaction.meta)); });
  });
  await page.keyboard.type(' More.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await page.waitForTimeout(1000); // the panels reload for the new head
  const metas = await page.evaluate(() => (window as unknown as { __metas: string[] }).__metas);
  expect(metas.filter((m) => /CommentHighlights|ReferenceLabels/i.test(m))).toEqual([]);
});
