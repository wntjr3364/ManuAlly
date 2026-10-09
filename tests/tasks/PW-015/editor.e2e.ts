// PW-015 — TST-015A / TST-015B in a real browser (Chromium, real API, temporary PostgreSQL).
// Korean IME input is driven through the Chrome DevTools Protocol (Input.imeSetComposition), the same
// events a real IME produces. All text is synthetic.
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });
test.afterEach(async () => { await h.failRevisionInserts(false); });

const REF = '00000000-0000-4000-8000-0000000000f1';

async function login(page: Page) {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '내 논문' })).toBeVisible();
}

// creates a paper with an empty manuscript and opens it; returns the paper and document ids
async function newManuscript(page: Page, title: string) {
  await page.getByLabel('새 논문 제목').fill(title);
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: title }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await expect(editor(page)).toBeVisible();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const { rows } = await h.pool.query("SELECT id FROM documents WHERE paper_id = $1 AND kind = 'manuscript'", [paperId]);
  return { paperId, documentId: rows[0].id as string };
}

const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const status = (page: Page) => page.getByTestId('save-status');

async function head(documentId: string) {
  const { rows } = await h.pool.query(
    'SELECT r.id, r.reason, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.id = $1', [documentId]);
  return rows[0] as { id: string; reason: string; content_json: { content: { content?: { type: string; text?: string; marks?: { type: string }[]; attrs?: Record<string, unknown> }[] }[] } };
}
async function revisionCount(documentId: string) {
  const { rows } = await h.pool.query('SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1', [documentId]);
  return rows[0].n as number;
}
const textOf = (c: Awaited<ReturnType<typeof head>>['content_json']) =>
  c.content.map((b) => (b.content ?? []).map((n) => n.text ?? `{${n.type}}`).join('')).join('\n');

// Korean IME: each step is the composition string shown while typing; `commit` ends the composition
async function compose(page: Page, steps: string[], commit?: string) {
  const cdp = await page.context().newCDPSession(page);
  for (const s of steps) await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length });
  if (commit !== undefined) await cdp.send('Input.insertText', { text: commit });
  return cdp;
}

// every text the save status showed, recorded in the page
async function recordStatuses(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="save-status"]')!;
    const seen: string[] = []; // changes from now on
    (window as unknown as { __statuses: string[] }).__statuses = seen;
    new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses);
}

const saves = (page: Page) => {
  const sent: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/saves')) sent.push(r.postData() ?? ''); });
  return sent;
};

async function pasteCitation(page: Page) {
  await editor(page).evaluate((el, ref) => {
    const dt = new DataTransfer();
    dt.setData('text/html', `<span data-pw-citation="" data-reference-id="${ref}" data-locator="p. 4">[인용]</span>`);
    dt.setData('text/plain', '[인용]');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, REF);
}

const recoveryKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pw-recovery:')));

test('TST-015A: Korean IME, italic, sub/superscript and a citation are autosaved and come back after reload', async ({ page }) => {
  await login(page);
  const { documentId } = await newManuscript(page, 'IME paper');
  const sent = saves(page);
  await editor(page).click();
  // 한 (ㅎ → 하 → 한), then 글 (ㄱ → 그 → 글)
  const cdp = await compose(page, ['ㅎ', '하', '한']);
  await page.waitForTimeout(2500); // longer than the autosave pause
  expect(sent, 'no save while composing').toHaveLength(0);
  await cdp.send('Input.insertText', { text: '한' });
  await compose(page, ['ㄱ', '그', '글'], '글');
  await page.keyboard.type(' ');
  await page.getByRole('button', { name: '기울임' }).click();
  await page.keyboard.type('in vivo');
  await page.getByRole('button', { name: '기울임' }).click();
  await page.keyboard.type(' H');
  await page.getByRole('button', { name: '아래첨자' }).click();
  await page.keyboard.type('2');
  await page.getByRole('button', { name: '아래첨자' }).click();
  await page.keyboard.type('O 10');
  await page.getByRole('button', { name: '위첨자' }).click();
  await page.keyboard.type('3');
  await page.getByRole('button', { name: '위첨자' }).click();
  await page.keyboard.type(' ');
  await pasteCitation(page);
  await expect(status(page)).toHaveText('저장됨', { timeout: 15_000 });

  const stored = await head(documentId);
  expect(stored.reason).toBe('autosave');
  const inline = stored.content_json.content[0]!.content!;
  expect(textOf(stored.content_json)).toBe('한글 in vivo H2O 103 {citation}');
  expect(inline.find((n) => n.text === 'in vivo')?.marks).toEqual([{ type: 'italic' }]);
  expect(inline.find((n) => n.text === '2')?.marks).toEqual([{ type: 'subscript' }]);
  expect(inline.find((n) => n.text === '3')?.marks).toEqual([{ type: 'superscript' }]);
  expect(inline.find((n) => n.type === 'citation')?.attrs).toEqual({ referenceId: REF, locator: 'p. 4' });
  // no jamo fragment was ever stored
  for (const body of sent) expect(body).not.toMatch(/[ㄱ-ㅎ]/);

  await page.reload();
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(editor(page)).toContainText('한글 in vivo H2O 103');
  await expect(editor(page).locator('em')).toHaveText('in vivo');
  await expect(editor(page).locator('sub')).toHaveText('2');
  await expect(editor(page).locator('sup')).toHaveText('3');
  await expect(editor(page).locator(`span[data-pw-citation][data-reference-id="${REF}"]`)).toHaveCount(1);
  await expect(status(page)).toHaveText('저장됨');
  await page.screenshot({ path: 'reports/tasks/PW-015/screens/1-ime-marks-citation-reloaded.png' });
});

test('TST-015B: an outside patch is refused while composing and applied after', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __PW_TEST_HOOKS__: boolean }).__PW_TEST_HOOKS__ = true; });
  await login(page);
  await newManuscript(page, 'Patch paper');
  await editor(page).click();
  const cdp = await compose(page, ['ㅎ', '하']);
  const during = await page.evaluate(() => {
    const m = (window as unknown as { __pwManuscript: { composing(): boolean; insertAtStart(t: string): unknown } }).__pwManuscript;
    return { composing: m.composing(), result: m.insertAtStart('X') };
  });
  expect(during).toEqual({ composing: true, result: { applied: false, code: 'COMPOSING' } });
  await cdp.send('Input.insertText', { text: '한' });
  await expect(editor(page)).toHaveText('한');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __pwManuscript: { composing(): boolean } }).__pwManuscript.composing())).toBe(false);
  const after = await page.evaluate(() => (window as unknown as { __pwManuscript: { insertAtStart(t: string): unknown } }).__pwManuscript.insertAtStart('X'));
  expect(after).toEqual({ applied: true });
  await expect(editor(page)).toHaveText('X한');
});

test('TST-015B: a failing save is never shown as saved; it is retried and then stored once', async ({ page }) => {
  await login(page);
  const { documentId } = await newManuscript(page, 'Failing paper');
  const before = await revisionCount(documentId);
  const statuses = await recordStatuses(page);
  await h.failRevisionInserts(true);
  await editor(page).click();
  await page.keyboard.type('must not look saved');
  await expect(status(page)).toContainText('저장 실패', { timeout: 10_000 });
  await page.waitForTimeout(3000); // at least one retry, still failing
  expect(await statuses()).not.toContain('저장됨');
  expect(await revisionCount(documentId)).toBe(before);
  await page.screenshot({ path: 'reports/tasks/PW-015/screens/2-save-failed.png' });
  await h.failRevisionInserts(false);
  await expect(status(page)).toHaveText('저장됨', { timeout: 20_000 });
  expect(textOf((await head(documentId)).content_json)).toBe('must not look saved');
  expect(await revisionCount(documentId)).toBe(before + 1);
});

test('TST-015B: offline shows not saved; coming back online saves', async ({ page, context }) => {
  await login(page);
  const { documentId } = await newManuscript(page, 'Offline paper');
  const statuses = await recordStatuses(page);
  await context.setOffline(true);
  await editor(page).click();
  await page.keyboard.type('written offline');
  await expect(status(page)).toContainText('오프라인', { timeout: 10_000 });
  expect(await statuses()).not.toContain('저장됨');
  await context.setOffline(false);
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  expect(textOf((await head(documentId)).content_json)).toBe('written offline');
});

test('TST-015B: a save whose answer was lost is not stored twice and not reported as a conflict', async ({ page }) => {
  await login(page);
  const { documentId } = await newManuscript(page, 'Lost answer paper');
  const before = await revisionCount(documentId);
  let dropped = false;
  await page.route('**/saves', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch(); // the server stores it ...
    await route.abort('failed'); // ... but the browser never hears back
  });
  await editor(page).click();
  await page.keyboard.type('stored once');
  await expect(status(page)).toHaveText('저장됨', { timeout: 15_000 });
  expect(dropped).toBe(true);
  expect(await revisionCount(documentId)).toBe(before + 1);
  await page.keyboard.type(' and more');
  await expect(status(page)).toHaveText('저장됨', { timeout: 15_000 });
  expect(textOf((await head(documentId)).content_json)).toBe('stored once and more');
});

async function leaveDraft(context: BrowserContext, text: string) {
  const page = await context.newPage();
  await login(page);
  const ids = await newManuscript(page, `Draft paper ${text}`);
  await h.failRevisionInserts(true);
  await editor(page).click();
  await page.keyboard.type(text);
  await expect(status(page)).toContainText('저장 실패', { timeout: 10_000 });
  await expect.poll(() => recoveryKeys(page)).toHaveLength(1);
  const url = page.url();
  await page.close(); // e.g. the tab or browser was closed
  await h.failRevisionInserts(false);
  return { ...ids, url };
}

test('TST-015A: unsaved text is offered back from this browser and then saved', async ({ context }) => {
  const { documentId, url } = await leaveDraft(context, '복구할 문장 x');
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(page.getByTestId('recovery-offer')).toContainText('저장되지 않은 원고 변경');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
  await page.screenshot({ path: 'reports/tasks/PW-015/screens/3-recovery-offer.png' });
  await page.getByRole('button', { name: '복구본 불러오기' }).click();
  await expect(editor(page)).toHaveText('복구할 문장 x');
  await expect(status(page)).toHaveText('저장됨', { timeout: 15_000 });
  expect(textOf((await head(documentId)).content_json)).toBe('복구할 문장 x');
  await expect.poll(() => recoveryKeys(page)).toHaveLength(0);
});

test('TST-015A: a recovery copy older than the server text is shown for copying, never merged', async ({ context }) => {
  const { paperId, documentId, url } = await leaveDraft(context, 'old local text');
  const cur = await head(documentId);
  const { saveRevision } = await import('../../../packages/domain/src/revisions/index.ts');
  const { rows } = await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId]);
  await saveRevision(h.pool, {
    paperId, documentId, ownerId: rows[0].owner_id, expectedHead: cur.id, schemaVersion: 1, reason: 'manual',
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-0000000000c1' }, content: [{ type: 'text', text: 'newer server text' }] }] },
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(page.getByTestId('recovery-text')).toHaveText('old local text');
  await expect(editor(page)).toHaveText('newer server text');
  await expect(page.getByRole('button', { name: '복구본 불러오기' })).toHaveCount(0);
  await page.getByRole('button', { name: '복구본 버리기' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  expect(textOf((await head(documentId)).content_json)).toBe('newer server text');
  await expect.poll(() => recoveryKeys(page)).toHaveLength(0);
});

test('TST-015A: logout leaves no recovery copy; turning recovery off stores none', async ({ context }) => {
  await leaveDraft(context, 'secret draft');
  const page = await context.newPage();
  await page.goto(h.webUrl); // still signed in (same browser)
  await expect(page.getByRole('heading', { name: '내 논문' })).toBeVisible();
  expect(await recoveryKeys(page)).toHaveLength(1);
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByLabel('사용자 이름')).toBeVisible();
  expect(await recoveryKeys(page)).toHaveLength(0);

  await login(page);
  await newManuscript(page, 'No recovery paper');
  await page.getByLabel(/임시 보관/).uncheck();
  await h.failRevisionInserts(true);
  await editor(page).click();
  await page.keyboard.type('not kept locally');
  await expect(status(page)).toContainText('저장 실패', { timeout: 10_000 });
  await page.waitForTimeout(800);
  expect((await recoveryKeys(page)).filter((k) => k.includes(':draft:'))).toHaveLength(0);
});

test('Korean composition inside a paragraph keeps the paragraph id', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'IME id paper');
  await editor(page).click();
  await page.keyboard.type('first');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  const idOf = () => editor(page).locator('p').nth(1).getAttribute('data-block-id');
  const before = await idOf();
  await page.keyboard.press('Home');
  await compose(page, ['ㄴ', '나'], '나');
  await expect(editor(page).locator('p').nth(1)).toHaveText('나second');
  expect(await idOf()).toBe(before);
});
