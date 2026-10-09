// PW-014 re-review fixes (MA1, MA2, minors 1, 2, 4, 5, 6) in a real browser.
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, type Harness } from './harness.ts';
import { createDocument } from '../../../packages/domain/src/revisions/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

async function login(page: Page) {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '내 논문' })).toBeVisible();
}
async function newPaper(page: Page, title: string) {
  await page.getByLabel('새 논문 제목').fill(title);
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: title }).click();
}

test('MA1: the browser Back button asks before discarding unsaved text, and staying keeps it', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Back paper');
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await page.getByTestId('editor').locator('.ProseMirror').click();
  await page.keyboard.type('Do not lose me.');
  const paperUrl = page.url();
  const dialogs: string[] = [];
  page.once('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.goBack();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toMatch(/저장되지 않은/);
  await expect(page).toHaveURL(paperUrl);
  await expect(page.getByTestId('editor')).toContainText('Do not lose me.');
});

test('MA2: a saved story whose list field had a trailing newline or spaces is not "unsaved", and can be approved', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Trailing paper');
  await page.getByLabel('연구 목적').fill('purpose');
  await page.getByLabel('핵심 질문').fill('question');
  await page.getByLabel('핵심 메시지').fill('message');
  await page.getByLabel('한계 (한 줄에 하나)').fill(' small n\n\n');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('DRAFT');
  await expect(page.getByRole('button', { name: '이 스토리 버전 승인' })).toBeEnabled();
  await page.getByRole('button', { name: '이 스토리 버전 승인' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('APPROVED');
  const dialogs: string[] = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.getByRole('link', { name: 'Paper Workspace' }).click();
  await expect(page.getByRole('heading', { name: '내 논문' })).toBeVisible();
  expect(dialogs).toEqual([]);
});

test('minor 1: workspace sources behind pnpm links and VCS files are not served', async ({ request }) => {
  const repo = process.cwd();
  const files = ['node_modules/.pnpm/node_modules/@pw/api/src/server.ts', 'node_modules/.pnpm/node_modules/@pw/domain/src/shared/db.ts', 'node_modules/.pnpm/node_modules/@pw/web/vite.config.ts', '.git/config', '.npmrc']
    .filter((f) => fs.existsSync(path.join(repo, f))); // a missing file just falls back to the app page
  expect(files.length).toBeGreaterThanOrEqual(4);
  for (const f of files) {
    expect((await request.get(`${h.webUrl}/@fs${repo}/${f}`)).status(), f).toBe(403);
    expect((await request.get(`${h.webUrl}/@fs${repo}/${f}?raw`)).status(), `${f}?raw`).toBe(403);
  }
});

test('minor 2: Enter at the start of a paragraph keeps its id with its text', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Enter paper');
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const pm = page.getByTestId('editor').locator('.ProseMirror');
  await pm.click();
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('beta');
  const idOf = (text: string) => pm.locator('p', { hasText: text }).getAttribute('data-block-id');
  const before = await idOf('beta');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  expect(await idOf('beta')).toBe(before);
});

test('minor 4: a manuscript stored with another schema version opens read-only', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Version paper');
  const { rows } = await h.pool.query("SELECT id, owner_id FROM paper_projects WHERE working_title = 'Version paper'");
  const d = await createDocument(h.pool, rows[0].id, rows[0].owner_id, 'manuscript');
  const docId = (d.document as unknown as { id: string }).id;
  const content = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: '00000000-0000-4000-8000-0000000000c1' }, content: [{ type: 'text', text: 'Version two text.' }] }] };
  const ins = await h.pool.query(
    "INSERT INTO document_revisions (paper_id, document_id, parent_revision_id, content_json, schema_version, content_hash, created_by, reason) VALUES ($1, $2, $3, $4, 2, repeat('e', 64), $5, 'import') RETURNING id",
    [rows[0].id, docId, d.head.id, JSON.stringify(content), rows[0].owner_id],
  );
  await h.pool.query('UPDATE documents SET head_revision_id = $2 WHERE id = $1', [docId, ins.rows[0].id]);
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(page.getByRole('alert')).toContainText('읽기 전용');
  await expect(page.getByTestId('editor')).toContainText('Version two text.');
  await expect(page.getByRole('button', { name: '저장' })).toHaveCount(0);
});

test('minor 5: after another session saved the story first, the newer version can be loaded explicitly', async ({ page, browser }) => {
  await login(page);
  await newPaper(page, 'Conflict paper');
  await page.getByLabel('핵심 메시지').fill('v1');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('DRAFT');
  // another browser saves v2 on top
  const other = await browser.newPage();
  await login(other);
  await other.getByRole('link', { name: 'Conflict paper' }).click();
  await expect(other.getByLabel('핵심 메시지')).toHaveValue('v1'); // loaded (typing-before-load has its own test)
  await other.getByLabel('핵심 메시지').fill('v2 from elsewhere');
  await other.getByRole('button', { name: '스토리 저장' }).click();
  await expect(other.getByLabel('핵심 메시지')).toHaveValue('v2 from elsewhere');
  await other.close();
  await page.getByLabel('핵심 메시지').fill('my v2');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '최신 스토리 불러오기' }).click();
  await expect(page.getByLabel('핵심 메시지')).toHaveValue('v2 from elsewhere');
});

test('minor 6: unsent evidence/fact form text counts as unsaved', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Evidence form paper');
  await page.getByRole('tab', { name: '자료' }).click();
  await page.getByLabel('근거 메모').fill('half-written note');
  const dialogs: string[] = [];
  page.once('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.getByRole('link', { name: 'Paper Workspace' }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toMatch(/근거/);
});

test('final check MAJOR-1: typing at the start of a paragraph keeps its id', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Type start paper');
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const pm = page.getByTestId('editor').locator('.ProseMirror');
  await pm.click();
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('beta');
  const idOf = (text: string) => pm.locator('p', { hasText: text }).getAttribute('data-block-id');
  const before = await idOf('beta');
  await page.keyboard.press('Home');
  await page.keyboard.type('X');
  await expect(pm.locator('p', { hasText: 'Xbeta' })).toHaveCount(1);
  expect(await idOf('Xbeta')).toBe(before);
});

test('final check minor 1: cancelling Forward keeps the browser history as it was', async ({ page }) => {
  await login(page);
  for (const t of ['Hist one', 'Hist two']) {
    await page.getByLabel('새 논문 제목').fill(t);
    await page.getByRole('button', { name: '새 논문' }).click();
  }
  await page.getByRole('link', { name: 'Hist one' }).click();
  const one = page.url();
  await page.getByRole('link', { name: 'Paper Workspace' }).click();
  await page.getByRole('link', { name: 'Hist two' }).click();
  const two = page.url();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(one);
  await page.getByLabel('핵심 메시지').fill('unsaved in one');
  page.once('dialog', (d) => d.dismiss());
  await page.goForward();
  await expect(page).toHaveURL(one);
  await expect(page.getByLabel('핵심 메시지')).toHaveValue('unsaved in one');
  // history is unchanged: after discarding, Forward twice still reaches paper two
  await page.getByLabel('핵심 메시지').fill('');
  await page.goForward();
  await page.goForward();
  await expect(page).toHaveURL(two);
});

test('final check minor 2: an outline conflict offers to reload the outline only, keeping unsaved story text', async ({ page, browser }) => {
  await login(page);
  await newPaper(page, 'Outline conflict paper');
  await page.getByLabel('연구 목적').fill('p');
  await page.getByLabel('핵심 질문').fill('q');
  await page.getByLabel('핵심 메시지').fill('m');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await page.getByRole('button', { name: '이 스토리 버전 승인' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('APPROVED');
  await page.getByLabel('섹션').fill('Results');
  await page.getByLabel('문단 목표').fill('mine v1');
  await page.getByRole('button', { name: '개요 저장' }).click();
  await expect(page.getByTestId('outline-status')).toHaveText('DRAFT');
  const other = await browser.newPage();
  await login(other);
  await other.getByRole('link', { name: 'Outline conflict paper' }).click();
  await expect(other.getByLabel('문단 목표')).toHaveValue('mine v1');
  await other.getByLabel('문단 목표').fill('theirs v2');
  await other.getByRole('button', { name: '개요 저장' }).click();
  await expect(other.getByTestId('outline-status')).toHaveText('DRAFT');
  await other.close();
  await page.getByLabel('새로운 점').fill('unsaved story text');
  await page.getByLabel('문단 목표').fill('mine v2');
  await page.getByRole('button', { name: '개요 저장' }).click();
  await expect(page.getByRole('button', { name: '최신 개요 불러오기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '최신 스토리 불러오기' })).toHaveCount(0);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '최신 개요 불러오기' }).click();
  await expect(page.getByLabel('문단 목표')).toHaveValue('theirs v2');
  await expect(page.getByLabel('새로운 점')).toHaveValue('unsaved story text');
});

test('verification minor 1: undo/redo of a multi-paragraph paste at a paragraph start keeps that paragraph id', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Undo paste paper');
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const pm = page.getByTestId('editor').locator('.ProseMirror');
  await pm.click();
  for (const [i, t] of ['first', 'second', 'third'].entries()) {
    if (i) await page.keyboard.press('Enter');
    await page.keyboard.type(t);
  }
  const idOf = (text: string) => pm.locator('p', { hasText: new RegExp(`^${text}$`) }).getAttribute('data-block-id');
  const B = await idOf('second');
  await pm.locator('p', { hasText: 'second' }).click();
  await page.keyboard.press('Home');
  await pm.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<p>P1</p><p>P2</p>');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  expect(await idOf('P2second')).toBe(B);
  await page.keyboard.press('Control+z');
  await expect(pm.locator('p', { hasText: /^second$/ })).toHaveCount(1);
  expect(await idOf('second')).toBe(B);
  await page.keyboard.press('Control+Shift+z');
  await expect(pm.locator('p', { hasText: 'P2second' })).toHaveCount(1);
  expect(await idOf('P2second')).toBe(B);
});

test('verification minor 2: a #fragment change on the same page neither prompts nor breaks Back', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Hash paper');
  const paperUrl = page.url();
  await page.getByLabel('핵심 메시지').fill('unsaved');
  const dialogs: string[] = [];
  page.on('dialog', async (d) => { dialogs.push(d.type()); await d.dismiss(); });
  await page.evaluate(() => { location.hash = 'section-2'; });
  await page.waitForTimeout(300);
  expect(dialogs).toEqual([]);
  await expect(page.getByLabel('핵심 메시지')).toHaveValue('unsaved');
  await page.goBack(); // back to the same page without the fragment
  await page.waitForTimeout(300);
  expect(dialogs).toEqual([]);
  await page.goBack(); // leaving the paper still asks
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(page).toHaveURL(new RegExp(paperUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await expect(page.getByLabel('핵심 메시지')).toHaveValue('unsaved');
});

test('verification minor 3: text typed before the story has loaded still asks before leaving', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Early type paper');
  await page.getByRole('link', { name: 'Paper Workspace' }).click();
  // hold the story request open so the form is typed into before the first load arrives
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/papers/*/story', async (route) => { await gate; await route.continue(); });
  await page.getByRole('link', { name: 'Early type paper' }).click();
  await page.getByLabel('핵심 메시지').fill('early text');
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
  await page.getByRole('link', { name: 'Paper Workspace' }).click();
  await expect.poll(() => asked).toContain('스토리');
  await expect(page.getByLabel('핵심 메시지')).toHaveValue('early text');
  release();
  await expect(page.getByTestId('story-status')).toHaveText('없음');
  await expect(page.getByLabel('핵심 메시지')).toHaveValue('early text');
});

test('verification minor 4: a title typed while the previous paper is being created is kept', async ({ page }) => {
  await login(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/papers', async (route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().working_title === 'Slow one') await gate;
    await route.continue();
  });
  await page.getByLabel('새 논문 제목').fill('Slow one');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByLabel('새 논문 제목').fill('Typed meanwhile');
  release();
  await expect(page.getByRole('link', { name: 'Slow one' })).toBeVisible();
  await expect(page.getByLabel('새 논문 제목')).toHaveValue('Typed meanwhile');
});
