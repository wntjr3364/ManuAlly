// PW-017 — TST-017A / TST-017B in a real browser: a selection becomes a server handle; a proposal is
// shown as a diff and applied once; stale, check-failed and lost-answer cases never overwrite.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { createProposal } from '../../../packages/domain/src/proposals/index.ts';

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
const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const status = (page: Page) => page.getByTestId('save-status');
const selectText = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __pwManuscript: { selectText(t: string): unknown } }).__pwManuscript.selectText(t), text);

// a manuscript with two paragraphs, a stored selection handle on `quote`, and its ids
async function prepare(page: Page, title: string, quote: string) {
  await login(page);
  await page.getByLabel('새 논문 제목').fill(title);
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: title }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await editor(page).click();
  await page.keyboard.type('It was very very clear at 2.4-fold.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second paragraph stays.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await selectText(page, quote);
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '간결화' }).click();
  await page.getByTestId('selection-popup').getByRole('textbox').press('Enter');
  await expect(page.locator('[data-request]')).toHaveAttribute('data-state', /서버 확인됨/);
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const { rows } = await h.pool.query('SELECT id, document_id FROM selection_handles WHERE paper_id = $1 ORDER BY created_at DESC LIMIT 1', [paperId]);
  return { paperId, documentId: rows[0].document_id as string, handleId: rows[0].id as string };
}
const propose = (s: { paperId: string; handleId: string }, text: string, intent = 'concise') =>
  createProposal(h.pool, { paperId: s.paperId, handleId: s.handleId, intent, replacement: [{ type: 'text', text }], explanation: 'shorter', origin: 'worker:test' });
const revCount = async (documentId: string) => (await h.pool.query('SELECT count(*)::int AS n FROM document_revisions WHERE document_id = $1', [documentId])).rows[0].n as number;
const headRow = async (documentId: string) => (await h.pool.query('SELECT r.id, r.reason, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.id = $1', [documentId])).rows[0];
const panel = (page: Page) => page.getByTestId('proposals');

test('TST-017A: one apply changes only the selected range, and no extra autosave follows', async ({ page }) => {
  const s = await prepare(page, 'Apply paper', 'very very clear');
  await propose(s, 'clear');
  await panel(page).getByRole('button', { name: '새로고침' }).click();
  const item = panel(page).getByTestId('proposal');
  await expect(item.locator('del')).toHaveText('very very ');
  await expect(item).toContainText('개요 승인 전 교정');
  const before = await revCount(s.documentId);
  await item.getByRole('button', { name: '적용' }).click();
  await expect(editor(page).locator('p').first()).toHaveText('It was clear at 2.4-fold.');
  await expect(editor(page).locator('p').nth(1)).toHaveText('Second paragraph stays.');
  await expect(status(page)).toHaveText('저장됨');
  await expect(panel(page).getByTestId('proposal')).toHaveCount(0);
  const head = await headRow(s.documentId);
  expect(head.reason).toBe('ai_apply');
  await page.waitForTimeout(2500); // longer than the autosave pause
  expect(await revCount(s.documentId)).toBe(before + 1);
  // typing afterwards saves on top of the applied revision (no conflict)
  await editor(page).locator('p').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  expect((await headRow(s.documentId)).content_json.content[0].content[0].text).toBe('It was clear at 2.4-fold.');
});

test('TST-017B: a proposal made before the manuscript changed cannot be applied', async ({ page }) => {
  const s = await prepare(page, 'Stale paper', 'very very clear');
  await propose(s, 'clear');
  await editor(page).locator('p').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  await panel(page).getByRole('button', { name: '새로고침' }).click();
  const item = panel(page).getByTestId('proposal');
  await expect(item.getByRole('button', { name: '적용' })).toBeDisabled();
  await expect(item).toContainText('원고가 이 제안 뒤에 바뀌어 적용할 수 없습니다');
  expect((await headRow(s.documentId)).reason).toBe('autosave');
});

test('TST-017B: a proposal that changes a number shows why and has no apply button', async ({ page }) => {
  const s = await prepare(page, 'Number paper', 'at 2.4-fold');
  await propose(s, 'at 2.5-fold', 'grammar');
  await panel(page).getByRole('button', { name: '새로고침' }).click();
  const item = panel(page).getByTestId('proposal');
  await expect(item).toContainText('검사 실패');
  await expect(item.getByTestId('proposal-checks')).toContainText('numbers');
  await expect(item.getByRole('button', { name: '적용' })).toHaveCount(0);
});

test('TST-017B: an apply whose answer was lost is retried with the same key and applied once', async ({ page }) => {
  const s = await prepare(page, 'Lost apply paper', 'very very clear');
  await propose(s, 'clear');
  await panel(page).getByRole('button', { name: '새로고침' }).click();
  let dropped = false;
  await page.route('**/apply', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch(); // applied on the server ...
    await route.abort('failed'); // ... but the answer is lost
  });
  const before = await revCount(s.documentId);
  await panel(page).getByRole('button', { name: '적용' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('한 번만 적용됩니다');
  // the outcome is unknown: no typing until it is known (review MINOR-2)
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
  await panel(page).getByRole('button', { name: '다시 시도' }).click();
  await expect(editor(page).locator('p').first()).toHaveText('It was clear at 2.4-fold.');
  await expect(status(page)).toHaveText('저장됨');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  expect(await revCount(s.documentId)).toBe(before + 1);
});

test('review MINOR-2: a 5xx answer after the server applied is treated as unknown, then resolved by the same key', async ({ page }) => {
  const s = await prepare(page, 'Proxy error paper', 'very very clear');
  await propose(s, 'clear');
  await panel(page).getByRole('button', { name: '새로고침' }).click();
  let failed = false;
  await page.route('**/apply', async (route) => {
    if (failed) return route.continue();
    failed = true;
    await route.fetch(); // applied on the server ...
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"bad_gateway"}' }); // ... a proxy answers 502
  });
  await panel(page).getByRole('button', { name: '적용' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('적용되었는지 알 수 없습니다');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'false');
  await expect(panel(page).getByTestId('proposal')).toHaveCount(1); // still there to retry
  await panel(page).getByRole('button', { name: '다시 시도' }).click();
  await expect(editor(page).locator('p').first()).toHaveText('It was clear at 2.4-fold.');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await editor(page).locator('p').nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' After.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 }); // no conflict afterwards
});

test('rejecting a proposal keeps the text and removes it from the list', async ({ page }) => {
  const s = await prepare(page, 'Reject paper', 'very very clear');
  const p = await propose(s, 'clear');
  await panel(page).getByRole('button', { name: '새로고침' }).click();
  await panel(page).getByRole('button', { name: '거절' }).click();
  await expect(panel(page).getByTestId('proposal')).toHaveCount(0);
  await expect(editor(page).locator('p').first()).toHaveText('It was very very clear at 2.4-fold.');
  expect((await h.pool.query('SELECT status FROM edit_proposals WHERE id = $1', [p.id])).rows[0].status).toBe('REJECTED');
});

test('re-review MINOR: a retry refused with 401 after a lost answer still finds out that it was applied', async ({ page }) => {
  const s = await prepare(page, 'Expired retry paper', 'very very clear');
  await propose(s, 'clear');
  await panel(page).getByRole('button', { name: '새로고침' }).click();
  let calls = 0;
  await page.route('**/apply', async (route) => {
    calls += 1;
    if (calls === 1) { await route.fetch(); await route.abort('failed'); return; } // applied, answer lost
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' }); // the retry is refused
  });
  await panel(page).getByRole('button', { name: '적용' }).click();
  await expect(status(page)).toHaveText('수정 제안 적용 확인 중 — 편집 잠김');
  await panel(page).getByRole('button', { name: '다시 시도' }).click();
  // the proposal is read: it was applied and is the head, so its result is put on screen
  await expect(editor(page).locator('p').first()).toHaveText('It was clear at 2.4-fold.');
  await expect(status(page)).toHaveText('저장됨');
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
});
