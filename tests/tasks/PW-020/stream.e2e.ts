// PW-020 — TST-020A / TST-020B in a real browser with the in-process mock worker: the page tells
// "answering", "answer done", "proposal ready (not applied)" and "applied" apart; mock output is always
// badged MOCK; leaving or reloading the page does not cancel a job, the "취소" button does.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: { chunkDelayMs: 250 } }); });
test.afterAll(async () => { await h?.stop(); });

const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const status = (page: Page) => page.getByTestId('save-status');
const job = (page: Page) => page.getByTestId('ai-job').first();
const selectText = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __pwManuscript: { selectText(t: string): unknown } }).__pwManuscript.selectText(t), text);

async function prepare(page: Page, title: string) {
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
  await page.keyboard.type('It was very very clear at 2.4-fold.');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  return new URL(page.url()).pathname.split('/')[2]!;
}
async function requestAi(page: Page, quote: string, action: string, text = '') {
  await selectText(page, quote);
  await page.getByTestId('selection-toolbar').getByRole('button', { name: action }).click();
  const box = page.getByTestId('selection-popup').getByRole('textbox');
  if (text) await box.fill(text);
  await box.press('Enter');
  await expect(page.locator('[data-request]').last()).toHaveAttribute('data-state', /서버 확인됨/);
}
const jobRow = async (paperId: string) => (await h.pool.query("SELECT id, status FROM jobs WHERE paper_id = $1 AND intent IN ('ask_selection', 'revise_selection') ORDER BY created_at DESC LIMIT 1", [paperId])).rows[0];

test('TST-020A: a question streams an answer, labelled MOCK, and leaves the manuscript alone', async ({ page }) => {
  const paperId = await prepare(page, 'Ask paper');
  const before = (await h.pool.query('SELECT head_revision_id FROM documents WHERE paper_id = $1', [paperId])).rows[0].head_revision_id;
  await requestAi(page, 'very very clear', '질문', 'Is this too strong?');
  await expect(job(page)).toHaveAttribute('data-phase', 'answering', { timeout: 10_000 });
  await expect(page.getByTestId('ai-job-phase').first()).toHaveText('답변 작성 중…');
  await expect(job(page).getByTestId('mock-badge')).toHaveText('MOCK · 실제 AI 아님');
  await expect(job(page)).toHaveAttribute('data-phase', 'answered', { timeout: 15_000 });
  await expect(page.getByTestId('ai-job-phase').first()).toHaveText('답변 완료 — 원고는 바뀌지 않음');
  await expect(job(page).getByTestId('ai-answer')).toContainText('[MOCK]');
  await expect(job(page).getByTestId('ai-answer')).toContainText('원고는 바뀌지 않았습니다.');
  await expect(editor(page)).toHaveText('It was very very clear at 2.4-fold.');
  expect((await h.pool.query('SELECT head_revision_id FROM documents WHERE paper_id = $1', [paperId])).rows[0].head_revision_id).toBe(before);
});

test('TST-020A: a correction is "ready, not applied" until the owner applies it, then "applied"', async ({ page }) => {
  await prepare(page, 'Concise paper');
  await requestAi(page, 'very very clear', '간결화');
  await expect(job(page)).toHaveAttribute('data-phase', 'proposal_ready', { timeout: 15_000 });
  await expect(page.getByTestId('ai-job-phase').first()).toHaveText('수정 제안 준비됨 — 아직 원고에 적용되지 않음');
  await expect(editor(page)).toHaveText('It was very very clear at 2.4-fold.');
  const item = page.getByTestId('proposals').getByTestId('proposal');
  await expect(item.getByTestId('mock-badge')).toBeVisible();
  await expect(item.locator('del')).toHaveText('very very ');
  await expect(item).toContainText('설명(MOCK)');
  await item.getByRole('button', { name: '적용' }).click();
  await expect(editor(page)).toHaveText('It was clear at 2.4-fold.');
  await expect(job(page)).toHaveAttribute('data-phase', 'applied');
  await expect(page.getByTestId('ai-job-phase').first()).toHaveText('수정 제안 적용됨 — 원고에 반영');
  await expect(status(page)).toHaveText('저장됨');
});

test('TST-020B: reloading mid-answer does not cancel; the answer is complete after the reload', async ({ page }) => {
  const paperId = await prepare(page, 'Reload paper');
  await requestAi(page, 'very very clear', '질문', 'Why?');
  await expect(job(page)).toHaveAttribute('data-phase', 'answering', { timeout: 10_000 });
  await page.reload();
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(job(page)).toHaveAttribute('data-phase', 'answered', { timeout: 15_000 });
  await expect(job(page).getByTestId('ai-answer')).toContainText('[MOCK] 선택한 부분');
  await expect(job(page).getByTestId('ai-answer')).toContainText('원고는 바뀌지 않았습니다.');
  expect((await jobRow(paperId)).status).toBe('SUCCEEDED');
});

test('TST-020B: "취소" stops the job; no answer is completed and nothing is proposed', async ({ page }) => {
  const paperId = await prepare(page, 'Cancel paper');
  await requestAi(page, 'very very clear', '질문', 'Stop me');
  await expect(job(page)).toHaveAttribute('data-phase', 'answering', { timeout: 10_000 });
  await job(page).getByRole('button', { name: '취소' }).click();
  await expect(job(page)).toHaveAttribute('data-phase', 'cancelled');
  await expect(page.getByTestId('ai-job-phase').first()).toHaveText('취소됨 — 결과 없음');
  await expect(job(page).getByRole('button', { name: '취소' })).toHaveCount(0);
  const j = await jobRow(paperId);
  expect(j.status).toBe('CANCELLED');
  await page.waitForTimeout(800); // the run notices at its next piece and stops
  const kinds = (await h.pool.query('SELECT kind FROM job_events WHERE job_id = $1', [j.id])).rows.map((r) => r.kind);
  expect(kinds).not.toContain('answer_done');
});
