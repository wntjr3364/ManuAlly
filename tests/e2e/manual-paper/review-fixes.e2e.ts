// PW-014 review fixes (M1–M3, minor 2/5) in a real browser.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from './harness.ts';
import { createDocument, saveRevision } from '../../../packages/domain/src/revisions/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

const P1 = '00000000-0000-4000-8000-0000000000a1';
const T1 = '00000000-0000-4000-8000-0000000000a2';
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

test('M1: a manuscript with content the editor cannot edit opens read-only, shows it, and cannot be overwritten', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Table paper');
  const { rows } = await h.pool.query("SELECT id, owner_id FROM paper_projects WHERE working_title = 'Table paper'");
  const d = await createDocument(h.pool, rows[0].id, rows[0].owner_id, 'manuscript');
  const docId = (d.document as unknown as { id: string }).id;
  const content = { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: P1 }, content: [{ type: 'text', text: 'Paragraph before the table.' }] },
    { type: 'table', attrs: { id: T1 }, content: [{ type: 'table_row', content: [{ type: 'table_cell', content: [{ type: 'text', text: 'n = 3' }] }] }] },
  ] };
  const stored = await saveRevision(h.pool, { paperId: rows[0].id, documentId: docId, ownerId: rows[0].owner_id, expectedHead: d.head.id, content, schemaVersion: 1, reason: 'import' });
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(page.getByRole('alert')).toContainText('읽기 전용');
  await expect(page.getByTestId('editor')).toContainText('Paragraph before the table.');
  await expect(page.getByTestId('editor')).toContainText('n = 3');
  await expect(page.getByRole('button', { name: '저장' })).toHaveCount(0);
  await page.keyboard.press('Control+s');
  const head = await h.pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [docId]);
  expect(head.rows[0].head_revision_id).toBe(stored.id);
});

test('M2: unsaved text survives tab switches; leaving the paper or logging out asks first', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Tab paper');
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await page.getByTestId('editor').locator('.ProseMirror').click();
  await page.keyboard.type('Unsaved words.');
  await page.getByRole('tab', { name: '버전' }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(page.getByTestId('editor')).toContainText('Unsaved words.');
  await expect(page.getByTestId('save-status')).not.toHaveText('저장됨');
  const dialogs: string[] = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.getByRole('link', { name: 'Paper Workspace' }).click();
  await page.getByRole('button', { name: '로그아웃' }).click();
  expect(dialogs).toHaveLength(2);
  expect(dialogs[0]).toMatch(/저장되지 않은/);
  await expect(page.getByTestId('editor')).toContainText('Unsaved words.'); // still here after "cancel"
});

test('M3: approval is only offered for what is saved; unsaved form edits block it and are kept', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Approve paper');
  await page.getByLabel('연구 목적').fill('purpose');
  await page.getByLabel('핵심 질문').fill('question');
  await page.getByLabel('핵심 메시지').fill('MESSAGE STORED');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await expect(page.getByRole('button', { name: '이 스토리 버전 승인' })).toBeEnabled();
  await page.getByLabel('핵심 메시지').fill('MESSAGE ON SCREEN (unsaved)');
  await expect(page.getByRole('button', { name: '이 스토리 버전 승인' })).toBeDisabled();
  await expect(page.getByText('저장한 뒤 승인')).toBeVisible();
  await page.getByRole('tab', { name: '자료' }).click();
  await page.getByRole('tab', { name: '구상·개요' }).click();
  await expect(page.getByLabel('핵심 메시지')).toHaveValue('MESSAGE ON SCREEN (unsaved)');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await page.getByRole('button', { name: '이 스토리 버전 승인' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('APPROVED');
  const { rows } = await h.pool.query("SELECT s.story->>'main_message' AS m FROM story_revisions s JOIN paper_projects p ON p.active_story_revision_id = s.id WHERE p.working_title = 'Approve paper'");
  expect(rows[0].m).toBe('MESSAGE ON SCREEN (unsaved)');
});

test('minor 5: a replicate count that is not a whole number is refused, not silently dropped', async ({ page }) => {
  await login(page);
  await newPaper(page, 'N paper');
  await page.getByRole('tab', { name: '자료' }).click();
  await page.getByLabel('근거 메모').fill('note');
  await page.getByRole('button', { name: '근거 추가' }).click();
  for (const [label, v] of [['대상', 'x'], ['지표', 'm'], ['값(원문 그대로)', '1'], ['단위', 'u'], ['반복 수(n)', 'three']] as const) await page.getByLabel(label, { exact: true }).fill(v);
  await page.getByRole('button', { name: '사실 추가' }).click();
  await expect(page.getByRole('alert')).toContainText('반복 수');
  await expect(page.getByTestId('fact-state')).toHaveCount(0);
});

test('an outline loaded from the server can be edited, saved again and approved', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Outline resave');
  await page.getByLabel('연구 목적').fill('p');
  await page.getByLabel('핵심 질문').fill('q');
  await page.getByLabel('핵심 메시지').fill('m');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await page.getByRole('button', { name: '이 스토리 버전 승인' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('APPROVED');
  await page.getByLabel('섹션').fill('Results');
  await page.getByLabel('문단 목표').fill('first goal');
  await page.getByRole('button', { name: '개요 저장' }).click();
  await expect(page.getByTestId('outline-status')).toHaveText('DRAFT');
  await page.getByLabel('문단 목표').fill('second goal');
  await expect(page.getByRole('button', { name: '이 개요 버전 승인' })).toBeDisabled();
  await page.getByRole('button', { name: '개요 저장' }).click(); // nodes now come from the server
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '이 개요 버전 승인' }).click();
  await expect(page.getByTestId('outline-status')).toHaveText('APPROVED');
  const { rows } = await h.pool.query("SELECT n.paragraph_goal FROM outline_nodes n JOIN paper_projects p ON p.active_outline_revision_id = n.outline_revision_id WHERE p.working_title = 'Outline resave'");
  expect(rows.map((r) => r.paragraph_goal)).toEqual(['second goal']);
});

test('minor 1: a pasted citation keeps its reference and locator', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Paste paper');
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await page.getByTestId('editor').locator('.ProseMirror').click();
  await page.keyboard.type('Induced ');
  const ref = '11111111-2222-4333-8444-555555555555';
  await page.getByTestId('editor').locator('.ProseMirror').evaluate((el, r) => {
    const dt = new DataTransfer();
    dt.setData('text/html', `<span data-pw-citation="" data-reference-id="${r}" data-locator="p. 4">[인용, p. 4]</span>`);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, ref);
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('저장됨');
  const { rows } = await h.pool.query("SELECT r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id JOIN paper_projects p ON p.id = d.paper_id WHERE p.working_title = 'Paste paper'");
  const cite = JSON.stringify(rows[0].content_json);
  expect(cite).toContain(`"referenceId":"${ref}"`);
  expect(cite).toContain('"locator":"p. 4"');
});

test('typing before the story finishes loading is kept, not overwritten by the load', async ({ page }) => {
  await login(page);
  await newPaper(page, 'Slow load paper');
  await page.getByLabel('핵심 메시지').fill('stored message');
  await page.getByRole('button', { name: '스토리 저장' }).click();
  await expect(page.getByTestId('story-status')).toHaveText('DRAFT');
  // reopen the paper with the story request held until the user has typed
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/story', async (route) => { await held; await route.continue(); });
  await page.reload();
  await page.getByLabel('핵심 메시지').fill('typed while loading');
  release();
  await page.waitForResponse((r) => r.url().endsWith('/story'));
  await expect(page.getByTestId('story-status')).toHaveText('DRAFT');
  await expect(page.getByLabel('핵심 메시지')).toHaveValue('typed while loading');
  await expect(page.getByRole('button', { name: '이 스토리 버전 승인' })).toBeDisabled();
});

test('minor 7: the dev server does not serve repository files outside the web app', async ({ request }) => {
  const repo = process.cwd();
  for (const f of ['CLAUDE.md', 'PROGRESS.md', 'apps/api/src/server.ts', '.env.example']) {
    const r = await request.get(`${h.webUrl}/@fs${repo}/${f}`);
    expect(r.status(), f).toBe(403);
  }
  expect((await request.get(`${h.webUrl}/src/main.tsx`)).status()).toBe(200);
});
