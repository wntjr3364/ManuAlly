// PW-016 — TST-016A / TST-016B in a real browser (Chromium, real API, temporary PostgreSQL).
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { parseDocument, snapshotSelection } from '../../../packages/editor-core/src/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

async function login(page: Page) {
  await page.addInitScript(() => { (window as unknown as { __PW_TEST_HOOKS__: boolean }).__PW_TEST_HOOKS__ = true; });
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '내 논문' })).toBeVisible();
}
async function newManuscript(page: Page, title: string) {
  await page.getByLabel('새 논문 제목').fill(title);
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: title }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const { rows } = await h.pool.query("SELECT id FROM documents WHERE paper_id = $1 AND kind = 'manuscript'", [paperId]);
  return { paperId, documentId: rows[0].id as string };
}
const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const status = (page: Page) => page.getByTestId('save-status');
const toolbar = (page: Page) => page.getByTestId('selection-toolbar');
const popup = (page: Page) => page.getByTestId('selection-popup');
const selectText = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __pwManuscript: { selectText(t: string): unknown } }).__pwManuscript.selectText(t), text);
const requests = async (page: Page) => (await page.getByTestId('selection-requests').locator('[data-request]').evaluateAll((els) => els.map((e) => e.getAttribute('data-request')))).map((r) => JSON.parse(r!));
async function headOf(documentId: string) {
  const { rows } = await h.pool.query('SELECT r.id, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.id = $1', [documentId]);
  return rows[0] as { id: string; content_json: unknown };
}
async function compose(page: Page, steps: string[], commit: string) {
  const cdp = await page.context().newCDPSession(page);
  for (const s of steps) await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
  await cdp.send('Input.insertText', { text: commit });
}

test('TST-016A: a Korean instruction typed in the popup keeps the original selection and base revision', async ({ page }) => {
  await login(page);
  const { documentId } = await newManuscript(page, 'Selection paper');
  await editor(page).click();
  await page.keyboard.type('First sentence. Second sentence.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  const base = await headOf(documentId);
  await selectText(page, 'Second sentence');
  await expect(toolbar(page)).toBeVisible();
  await toolbar(page).getByRole('button', { name: '간결화' }).click();
  await expect(popup(page)).toBeVisible();
  await expect(page.getByTestId('selection-scope')).toContainText('문단 1');
  await expect(page.getByTestId('selection-scope')).toContainText('Second sentence');
  await expect(page.getByTestId('frozen-selection')).toHaveText('Second sentence');
  // the instruction is typed with the Korean IME; Enter that ends a composition does not send
  const box = popup(page).getByRole('textbox');
  await expect(box).toBeFocused();
  await compose(page, ['ㄷ', '더'], '더');
  await page.keyboard.type(' ');
  await compose(page, ['ㅉ', '짧', '짧ㄱ', '짧게'], '짧게');
  await box.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await expect(popup(page)).toBeVisible();
  // meanwhile the document changes (e.g. another change lands before the selection) and is saved
  await page.evaluate(() => (window as unknown as { __pwManuscript: { insertAtStart(t: string): unknown } }).__pwManuscript.insertAtStart('Intro. '));
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await expect(page.getByTestId('frozen-selection')).toHaveText('Second sentence'); // shown where it moved
  await box.focus();
  await page.keyboard.press('Enter');
  await expect(popup(page)).toHaveCount(0);
  const [req] = await requests(page);
  expect(req).toMatchObject({ document_id: documentId, base_revision_id: base.id, intent: 'concise', instruction: '더 짧게' });
  expect(req.selection).toMatchObject({ from: 16, to: 31, quote: 'Second sentence' });
  // the frozen snapshot is exactly what the server derives from the stored base revision
  const server = await snapshotSelection(parseDocument(base.content_json, 1), { blockId: req.selection.block_id, from: 16, to: 31 });
  expect(req.selection).toEqual(server);
});

test('TST-016B: no selection is never the whole manuscript; cross-paragraph and whole-document selections are refused', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'No target paper');
  await editor(page).click();
  await page.keyboard.type('alpha one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('beta two');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await expect(toolbar(page)).toHaveCount(0); // a caret is not a target
  await page.keyboard.press('Control+Shift+K');
  await expect(page.getByTestId('selection-message')).toHaveText('먼저 문장을 선택하세요');
  await expect(popup(page)).toHaveCount(0);
  await page.keyboard.press('Shift+ArrowUp'); // from the second paragraph into the first
  await expect(toolbar(page)).toContainText('한 문단 안에서 선택하세요');
  await expect(toolbar(page).getByRole('button')).toHaveCount(0);
  await page.keyboard.press('Control+a');
  await expect(toolbar(page)).toContainText('한 문단 안에서 선택하세요');
  await page.keyboard.press('Control+Shift+K');
  await expect(page.getByTestId('selection-message')).toHaveText('한 문단 안에서 선택하세요');
  expect(await page.getByTestId('selection-requests').count()).toBe(0);
});

test('TST-016B: moving focus does not change the frozen range; Esc puts the selection back', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'Focus paper');
  await editor(page).click();
  await page.keyboard.type('alpha beta gamma');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await selectText(page, 'beta');
  await toolbar(page).getByRole('button', { name: '질문' }).click();
  await expect(popup(page)).toBeVisible();
  // the user clicks around in the editor (its own selection changes), then back into the popup
  await selectText(page, 'gamma');
  await popup(page).getByRole('textbox').click();
  await page.keyboard.type('Is this term defined?');
  await popup(page).getByRole('button', { name: '보내기' }).click();
  const [req] = await requests(page);
  expect(req).toMatchObject({ intent: 'ask', instruction: 'Is this term defined?' });
  expect(req.selection.quote).toBe('beta');
  // Esc closes the popup and the frozen range becomes the editor selection again
  await selectText(page, 'alpha');
  await toolbar(page).getByRole('button', { name: '문법' }).click();
  await expect(popup(page).getByRole('textbox')).toBeFocused();
  await selectText(page, 'gamma'); // the editor's own selection moves meanwhile
  await popup(page).getByRole('textbox').click();
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('alpha');
  expect(await requests(page)).toHaveLength(1);
});

test('keyboard only: Ctrl+Shift+K reaches the toolbar, Enter opens the popup and sends', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'Keyboard paper');
  await editor(page).click();
  await page.keyboard.type('keyboard text');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Control+Shift+K');
  await expect(toolbar(page).getByRole('button', { name: '질문' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toolbar(page).getByRole('button', { name: '문법' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(popup(page).getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Enter');
  const [req] = await requests(page);
  expect(req).toMatchObject({ intent: 'grammar', instruction: '' });
  expect(req.selection.quote).toBe('keyboard text');
});

test('requests wait for the stored revision; academic rewrite waits for an approved outline', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'Gate paper');
  await editor(page).click();
  await page.keyboard.type('some text');
  await selectText(page, 'some');
  // not stored yet: the actions are there but disabled, with the reason
  await expect(toolbar(page)).toContainText('저장된 뒤 요청할 수 있습니다');
  await expect(toolbar(page).getByRole('button', { name: '문법' })).toBeDisabled();
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await selectText(page, 'some');
  await expect(toolbar(page).getByRole('button', { name: '문법' })).toBeEnabled();
  await expect(toolbar(page).getByRole('button', { name: '질문' })).toBeEnabled();
  const rewrite = toolbar(page).getByRole('button', { name: '학술적 재작성' });
  await expect(rewrite).toBeDisabled();
  await expect(rewrite).toHaveAttribute('title', '개요를 승인한 뒤 사용할 수 있습니다');
});

async function pasteCitation(page: Page) {
  await editor(page).evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<span data-pw-citation="" data-reference-id="00000000-0000-4000-8000-0000000000f1">[인용]</span>');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
}

test('review 2: a citation-only selection can be asked about but not edited; atoms are named in the scope', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'Atom paper');
  await editor(page).click();
  await page.keyboard.type('induced ');
  await pasteCitation(page);
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await editor(page).locator('span[data-pw-citation]').click(); // selects the atom alone
  await expect(toolbar(page)).toBeVisible();
  for (const name of ['문법', '간결화']) {
    const b = toolbar(page).getByRole('button', { name });
    await expect(b).toBeDisabled();
    await expect(b).toHaveAttribute('title', /글자가 없는 선택/);
  }
  await toolbar(page).getByRole('button', { name: '질문' }).click();
  await expect(page.getByTestId('selection-scope')).toContainText('선택 0자 · 인용 등 1개 “[인용]”');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Home');
  await expect(toolbar(page).getByRole('button', { name: '문법' })).toBeEnabled();
});

test('review 1 / nit: Esc or Enter that belongs to an IME composition keeps the popup and the instruction', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'IME keys paper');
  await editor(page).click();
  await page.keyboard.type('alpha beta');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await selectText(page, 'beta');
  await toolbar(page).getByRole('button', { name: '질문' }).click();
  const box = popup(page).getByRole('textbox');
  await expect(box).toBeFocused(); // the popup moves focus into the box; keys before that go elsewhere
  await page.keyboard.type('Why ');
  for (const key of ['Escape', 'Enter']) {
    await box.evaluate((el, k) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, isComposing: true, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, keyCode: 229, bubbles: true }));
    }, key);
  }
  await expect(popup(page)).toBeVisible();
  await expect(box).toHaveValue('Why ');
  expect(await page.getByTestId('selection-requests').count()).toBe(0);
});

test('review 3 / nits: the shortcut explains disabled actions, stale messages clear, Esc leaves the toolbar', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'Shortcut paper');
  await editor(page).click();
  await page.keyboard.press('Control+Shift+K');
  await expect(page.getByTestId('selection-message')).toHaveText('먼저 문장을 선택하세요');
  await page.keyboard.type('unsaved words');
  await page.keyboard.press('Shift+Home'); // a valid selection: the old message goes away
  await expect(page.getByTestId('selection-message')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+K'); // not saved yet: every action is disabled
  await expect(page.getByTestId('selection-message')).toHaveText('저장된 뒤 요청할 수 있습니다');
  await expect(editor(page)).toBeFocused();
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await selectText(page, 'unsaved');
  await page.keyboard.press('Control+Shift+K');
  await expect(toolbar(page).getByRole('button', { name: '질문' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor(page)).toBeFocused();
});
