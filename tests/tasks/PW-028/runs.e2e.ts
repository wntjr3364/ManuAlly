// PW-028 — TST-028A in a real browser: a reload or a dropped network never cancels a run; "중지" stores
// the cancel; after every reconnect the runs tab shows exactly the state the database holds.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: { chunkDelayMs: 700 } }); });
test.afterAll(async () => { await h?.stop(); });

const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const selectText = (page: Page, text: string) => page.evaluate((t) => (window as unknown as { __pwManuscript: { selectText(t: string): unknown } }).__pwManuscript.selectText(t), text);
const dbStatus = async (paperId: string) => (await h.pool.query("SELECT id, status FROM jobs WHERE paper_id = $1 AND intent IN ('ask_selection', 'revise_selection') ORDER BY created_at DESC LIMIT 1", [paperId])).rows[0] as { id: string; status: string };

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
  await expect(page.getByTestId('save-status')).toHaveText('저장됨', { timeout: 10_000 });
  return new URL(page.url()).pathname.split('/')[2]!;
}
async function ask(page: Page) {
  await selectText(page, 'very very clear');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '질문' }).click();
  const box = page.getByTestId('selection-popup').getByRole('textbox');
  await box.fill('Is this too strong?');
  await box.press('Enter');
  await expect(page.locator('[data-request]').last()).toHaveAttribute('data-state', /서버 확인됨/);
}
const runsTab = async (page: Page) => { await page.getByRole('tab', { name: 'AI 실행' }).click(); return page.getByTestId('run').first(); };

test('TST-028A: reload keeps the run; 중지 stores the cancel; every reconnect shows the stored state', async ({ page }) => {
  const paperId = await prepare(page, 'Runs paper');
  await ask(page);
  await expect.poll(async () => (await dbStatus(paperId))?.status, { timeout: 10_000 }).toBe('RUNNING');
  // reload while it runs: nothing is cancelled, the tab shows the running run
  await page.reload();
  let run = await runsTab(page);
  await expect(run).toHaveAttribute('data-status', 'RUNNING');
  await expect(run.getByTestId('run-status')).toHaveText('실행 중');
  expect((await dbStatus(paperId)).status).toBe('RUNNING');
  // stop
  await run.getByRole('button', { name: '중지' }).click();
  await expect(run).toHaveAttribute('data-status', 'CANCELLED');
  await expect(run.getByTestId('run-status')).toHaveText('취소됨 — 취소 뒤 결과는 반영되지 않음');
  expect((await dbStatus(paperId)).status).toBe('CANCELLED');
  // the worker's late answer cannot finish it: still cancelled a moment later, no answer stored
  await page.waitForTimeout(1500);
  const job = await dbStatus(paperId);
  expect(job.status).toBe('CANCELLED');
  expect((await h.pool.query("SELECT count(*)::int AS n FROM job_events WHERE job_id = $1 AND kind = 'answer_done'", [job.id])).rows[0].n).toBe(0);
  // reconnect after a reload: the stored state
  await page.reload();
  run = await runsTab(page);
  await expect(run).toHaveAttribute('data-status', 'CANCELLED');
  await expect(run.getByRole('button', { name: '중지' })).toHaveCount(0);
  if (process.env.PW_SAVE_EVIDENCE === '1') await page.screenshot({ path: 'reports/tasks/PW-028/runs-after-reconnect.png' });
});

test('TST-028A: while offline the tab says so; when the network returns it shows what the database holds', async ({ page, context }) => {
  const paperId = await prepare(page, 'Offline paper');
  await ask(page);
  const run = await runsTab(page);
  await expect(run).toHaveAttribute('data-status', /QUEUED|RUNNING/);
  await context.setOffline(true);
  // meanwhile the run is cancelled elsewhere (another tab)
  const job = await dbStatus(paperId);
  await h.pool.query("UPDATE jobs SET status = 'CANCELLED', finished_at = clock_timestamp(), lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [job.id]);
  await expect(page.getByTestId('runs-offline')).toBeVisible({ timeout: 10_000 });
  if (process.env.PW_SAVE_EVIDENCE === '1') await page.screenshot({ path: 'reports/tasks/PW-028/runs-offline.png' });
  await expect(run.getByRole('button', { name: '중지' })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByTestId('runs-offline')).toHaveCount(0, { timeout: 10_000 });
  await expect(run).toHaveAttribute('data-status', 'CANCELLED');
  await expect(run.getByTestId('run-status')).toHaveText('취소됨 — 취소 뒤 결과는 반영되지 않음');
});
