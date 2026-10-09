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

// evidence screenshots are written only when asked for, so test runs leave the tree unchanged
const evidence = async (page: Page, name: string) => {
  if (process.env.PW_SAVE_EVIDENCE) await page.screenshot({ path: `reports/tasks/PW-015/screens/${name}` });
};

// recovery copies (drafts) only; allRecoveryKeys also counts settings and open-tab marks
const recoveryKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pw-recovery:v1:draft:')));
const allRecoveryKeys = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pw-recovery:')));

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
  await evidence(page, '1-ime-marks-citation-reloaded.png');
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
  await evidence(page, '2-save-failed.png');
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

// closing a tab with unsaved text: the browser asks (beforeunload), the user leaves anyway
async function closeTab(page: Page) {
  page.on('dialog', (d) => void d.accept());
  await page.close({ runBeforeUnload: true });
  if (!page.isClosed()) await page.waitForEvent('close');
}

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
  await closeTab(page); // e.g. the tab was closed while the server failed
  await h.failRevisionInserts(false);
  return { ...ids, url };
}

test('TST-015A: unsaved text is offered back from this browser and then saved', async ({ context }) => {
  const { documentId, url } = await leaveDraft(context, '복구할 문장 x');
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(page.getByTestId('recovery-offer')).toContainText('저장되지 않은 원고 변경');
  // the copy came from another (closed) tab: it does not lock this editor (re-review nit 2)
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await evidence(page, '3-recovery-offer.png');
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
  expect(await allRecoveryKeys(page)).toHaveLength(0);

  await login(page);
  await newManuscript(page, 'No recovery paper');
  await page.getByLabel(/임시 보관/).uncheck();
  await h.failRevisionInserts(true);
  await editor(page).click();
  await page.keyboard.type('not kept locally');
  await expect(status(page)).toContainText('저장 실패', { timeout: 10_000 });
  await page.waitForTimeout(800);
  expect(await recoveryKeys(page)).toHaveLength(0);
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

test('review 2: a save right after typing leaves no copy of the saved text behind', async ({ page }) => {
  await login(page);
  await newManuscript(page, 'Quick save paper');
  await editor(page).click();
  await page.keyboard.type('saved at once');
  await page.keyboard.press('Control+s');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await page.waitForTimeout(800); // longer than the recovery-copy delay
  expect(await recoveryKeys(page)).toEqual([]);
});

test('review 3: tabs keep their own recovery copies; an open tab\'s copy is not offered elsewhere', async ({ context }) => {
  const a = await context.newPage();
  await login(a);
  await newManuscript(a, 'Two tabs paper');
  const url = a.url();
  const b = await context.newPage();
  await b.goto(url);
  await b.getByRole('tab', { name: '원고' }).click();
  // B's saves do not get through (its network fails); its text is only on screen and in its copy
  await b.route('**/saves', (r) => r.abort('failed'));
  await editor(b).click();
  await b.keyboard.type('bbb text of tab B');
  await expect(status(b)).toContainText('저장 실패', { timeout: 10_000 });
  // A saves other text: B's copy stays
  await editor(a).click();
  await a.keyboard.type('aaa text of tab A');
  await expect(status(a)).toHaveText('저장됨', { timeout: 10_000 });
  const copies = () => a.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':draft:')).map((k) => localStorage.getItem(k) ?? ''));
  await expect.poll(async () => (await copies()).filter((c) => c.includes('bbb text of tab B'))).toHaveLength(1);
  // B's save now meets A's newer head: a conflict, and B's text is still kept in this browser
  await b.unroute('**/saves');
  await b.getByRole('button', { name: '저장', exact: true }).click();
  await expect(status(b)).toContainText('다른 곳에서 먼저 바뀐 원고', { timeout: 15_000 });
  expect((await copies()).filter((c) => c.includes('bbb text of tab B'))).toHaveLength(1);
  // a third tab does not take over the copy of B, which is still open
  const c = await context.newPage();
  await c.goto(url);
  await c.getByRole('tab', { name: '원고' }).click();
  await expect(editor(c)).toHaveText('aaa text of tab A');
  await expect(c.getByTestId('recovery-offer')).toHaveCount(0);
  await expect(editor(c)).toHaveAttribute('contenteditable', 'true');
  // once B is closed, its copy is offered (for copying: it was based on an older version)
  await closeTab(b);
  await c.reload();
  await c.getByRole('tab', { name: '원고' }).click();
  await expect(c.getByTestId('recovery-text')).toHaveText('bbb text of tab B');
  // another tab's copy does not lock this editor (re-review nit 2)
  await expect(editor(c)).toHaveAttribute('contenteditable', 'true');
});

test('review 7: a browser that blocks site storage is told that nothing is kept locally', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  await login(page);
  await newManuscript(page, 'Blocked storage paper');
  await expect(page.getByTestId('recovery-unavailable')).toContainText('임시 보관할 수 없습니다');
  await editor(page).click();
  await page.keyboard.type('still autosaved');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
});

test('review 8: signing in removes recovery copies another account left in this browser', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.evaluate(() => {
    localStorage.setItem('pw-recovery:v1:draft:00000000-0000-4000-8000-00000000000b:00000000-0000-4000-8000-0000000000d1:t1', '{"other":"account"}');
    localStorage.setItem('pw-recovery:v1:off:00000000-0000-4000-8000-00000000000b', '1');
  });
  await login(page);
  await expect.poll(() => allRecoveryKeys(page)).toEqual([]);
});

test('re-review 1: a duplicated tab does not share the tab id of the open original', async ({ context }) => {
  const a = await context.newPage();
  await login(a);
  await newManuscript(a, 'Duplicate tab paper');
  const url = a.url();
  await expect(editor(a)).toHaveAttribute('contenteditable', 'true'); // the tab id has been claimed
  const idA = await a.evaluate(() => sessionStorage.getItem('pw-recovery-tab'));
  expect(idA).toMatch(/^[0-9a-f-]{36}$/);
  // A leaves the editor (the page, and its tab lock, stay)
  await a.getByRole('link', { name: 'Paper Workspace' }).click();
  // B is a duplicate of A: the browser copies A's sessionStorage
  const b = await context.newPage();
  await b.addInitScript((id) => { if (!sessionStorage.getItem('pw-recovery-tab')) sessionStorage.setItem('pw-recovery-tab', id); }, idA!);
  await b.goto(url);
  await b.getByRole('tab', { name: '원고' }).click();
  await expect(editor(b)).toHaveAttribute('contenteditable', 'true');
  const idB = await b.evaluate(() => sessionStorage.getItem('pw-recovery-tab'));
  expect(idB).not.toBe(idA);
  // A types while its saves fail: its copy is not offered to (or deletable by) B
  await a.goto(url);
  await a.getByRole('tab', { name: '원고' }).click();
  await a.route('**/saves', (r) => r.abort('failed'));
  await editor(a).click();
  await a.keyboard.type('text only tab A has');
  await expect(status(a)).toContainText('저장 실패', { timeout: 10_000 });
  await expect.poll(() => recoveryKeys(a)).toHaveLength(1);
  await b.reload();
  await b.getByRole('tab', { name: '원고' }).click();
  await expect(editor(b)).toHaveAttribute('contenteditable', 'true');
  await expect(b.getByTestId('recovery-offer')).toHaveCount(0);
  expect(await recoveryKeys(a)).toHaveLength(1);
});

test('re-review 4: after a logout in another tab, an open editor keeps no copy', async ({ context }) => {
  const a = await context.newPage();
  await login(a);
  await newManuscript(a, 'Logout elsewhere paper');
  const b = await context.newPage();
  await b.goto(h.webUrl);
  await b.getByRole('button', { name: '로그아웃' }).click();
  await expect(b.getByLabel('사용자 이름')).toBeVisible();
  await editor(a).click();
  await a.keyboard.type('typed after logout elsewhere');
  await expect(status(a)).not.toHaveText('저장됨', { timeout: 10_000 });
  await a.waitForTimeout(1000); // longer than the copy delay
  expect(await allRecoveryKeys(a)).toEqual([]);
  await closeTab(a);
  expect(await allRecoveryKeys(b)).toEqual([]);
});
