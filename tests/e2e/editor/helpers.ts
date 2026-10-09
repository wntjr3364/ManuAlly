// Shared steps for the P02 selection-editing browser gate (PW-022): a logged-in page with a fresh paper
// and manuscript, keyboard selection from the end of the paragraph, and readers of the stored head.
import { expect, type Page } from '@playwright/test';
import type { Harness } from '../manual-paper/harness.ts';

export const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
export const status = (page: Page) => page.getByTestId('save-status');
export const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click();

export async function login(page: Page, h: Harness) {
  await page.addInitScript(() => { (window as unknown as { __PW_TEST_HOOKS__: boolean }).__PW_TEST_HOOKS__ = true; });
  await page.goto(h.webUrl);
  const papers = page.getByRole('heading', { name: '내 논문' });
  await expect(page.getByLabel('사용자 이름').or(papers)).toBeVisible();
  if (!(await papers.isVisible())) {
    await page.getByLabel('사용자 이름').fill('alice');
    await page.getByLabel('비밀번호').fill('correct horse battery');
    await page.getByRole('button', { name: '로그인' }).click();
  }
  await expect(page.getByRole('heading', { name: '내 논문' })).toBeVisible();
}

export async function newManuscript(page: Page, h: Harness, title: string) {
  await login(page, h);
  await page.getByLabel('새 논문 제목').fill(title);
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: title }).click();
  await tab(page, '원고');
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  return new URL(page.url()).pathname.split('/')[2]!;
}

// selects `length` characters ending `fromEnd` characters before the end of the first paragraph,
// with the keyboard only (an emoji or an atom is one step, as for a user)
export async function selectFromEnd(page: Page, fromEnd: number, length: number, expected?: string) {
  // the editor takes keys once it is editable (shortly after load, when this tab's id is claimed)
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await editor(page).locator('p').first().click();
  // keys at OS key-repeat speed (30 ms, i.e. holding Shift+Arrow down). Bursts well below that (~1 ms
  // apart, automation only) can lose steps right after load: ProseMirror applies a selection change it
  // read earlier and writes that older caret back (see PW-022 REPORT)
  const key = async (k: string) => { await page.keyboard.press(k); await page.waitForTimeout(30); };
  await key('End');
  for (let i = 0; i < fromEnd; i++) await key('ArrowLeft');
  for (let i = 0; i < length; i++) await key('Shift+ArrowLeft');
  // what the browser has selected, as the user sees it (atoms show their label text)
  if (expected !== undefined) await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(expected);
}

// asks for a concise correction of the current selection and waits for the job's outcome (newest first)
export async function requestConcise(page: Page, outcome = 'proposal_ready') {
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '간결화' }).click();
  await page.getByTestId('selection-popup').getByRole('textbox').press('Enter');
  await expect(page.locator('[data-request]').last()).toHaveAttribute('data-state', /서버 확인됨/);
  await expect(page.getByTestId('ai-job').first()).toHaveAttribute('data-phase', outcome, { timeout: 15_000 });
}

// the quote of the last selection request (what the server received)
export const lastQuote = async (page: Page) => JSON.parse((await page.locator('[data-request]').last().getAttribute('data-request'))!).selection.quote as string;

export const head = async (h: Harness, paperId: string) => (await h.pool.query(
  "SELECT r.id, r.reason, r.content_json FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1 AND d.kind = 'manuscript'", [paperId])).rows[0] as { id: string; reason: string; content_json: { content: { content?: Record<string, unknown>[] }[] } };

// every AI apply of the paper, with the paragraph before and after (to audit that each changed only
// what it was meant to)
export const aiApplies = async (h: Harness, paperId: string) => (await h.pool.query(
  `SELECT p.id, b.content_json AS before, a.content_json AS after FROM edit_proposals p
   JOIN document_revisions b ON b.id = p.base_revision_id JOIN document_revisions a ON a.id = p.applied_revision_id
   WHERE p.paper_id = $1 AND p.status = 'APPLIED'`, [paperId])).rows as { id: string; before: unknown; after: unknown }[];

export const paragraphText = (content: { content: { content?: Record<string, unknown>[] }[] }, i = 0) =>
  (content.content[i]!.content ?? []).map((n) => (n.type === 'text' ? String(n.text) : `[${String(n.type)}]`)).join('');

