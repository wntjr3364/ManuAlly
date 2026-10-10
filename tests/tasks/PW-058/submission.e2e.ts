// PW-058 — in a real browser: a pasted reviewer comment blocks a submission-ready freeze until it is
// answered; "수정함" can only point to a paragraph changed after the comment; the frozen submission is listed
// with its DOCX hash and response table.
import { test, expect } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('TST-058A/B: comment → blocked freeze → edit → answer tied to the edit → submission-ready', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Submission paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Submission paper' }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const editor = page.getByTestId('editor').locator('.ProseMirror');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await editor.click();
  await page.keyboard.type('Roots respond quickly.');
  await expect(page.getByTestId('save-status')).toHaveText('저장됨', { timeout: 15_000 });

  await page.getByRole('tab', { name: '버전' }).click();
  const panel = page.getByTestId('submission');
  await panel.getByTestId('comment-text').fill('Please state how fast the roots respond.');
  await panel.getByRole('button', { name: '의견 추가' }).click();
  await expect(panel.getByTestId('review-comment')).toHaveAttribute('data-status', 'none');
  // freezing as submission-ready is refused and the reason listed
  await panel.getByTestId('submission-label').fill('Journal submission 1');
  await panel.getByRole('button', { name: '제출용으로 확정' }).click();
  await expect(panel.locator('[data-testid="blocking"] [data-kind="comment_without_response"]')).toBeVisible();
  await expect(panel.getByTestId('frozen-submission')).toHaveCount(0);
  // "수정함" with nothing changed yet offers no paragraph to point to
  await panel.getByRole('button', { name: '답하기' }).click();
  await expect(panel.getByTestId('no-changes')).toBeVisible();
  await expect(panel.getByRole('button', { name: '답 저장' })).toBeDisabled();
  await page.screenshot({ path: 'reports/tasks/PW-058/1-blocked.png', fullPage: true });

  // the edit, then the answer pointing to it
  await page.getByRole('tab', { name: '원고' }).click();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(' within two hours.');
  await expect(page.getByTestId('save-status')).toHaveText('저장됨', { timeout: 15_000 });
  await page.getByRole('tab', { name: '버전' }).click();
  // the answer form stayed open and now offers the changed paragraph
  await expect(panel.getByTestId('change')).toHaveCount(1);
  await expect(panel.getByTestId('change')).toContainText('within two hours');
  await panel.getByTestId('change').first().locator('input').check();
  await panel.getByTestId('answer-text').fill('We now state that roots respond within two hours.');
  await panel.getByRole('button', { name: '답 저장' }).click();
  await expect(panel.getByTestId('review-comment')).toHaveAttribute('data-status', 'addressed');
  await expect(panel.getByTestId('response')).toContainText('수정함');

  await panel.getByRole('button', { name: '제출 전 검사' }).click();
  // nothing blocks; what the app did not check is shown and must be confirmed
  await expect(panel.getByTestId('blocking')).toHaveCount(0);
  await expect(panel.locator('[data-testid="warnings"] [data-kind="scientific_check_not_run"]')).toBeVisible();
  await expect(panel.locator('[data-testid="warnings"] [data-kind="consistency_not_checked"]')).toBeVisible();
  await panel.getByTestId('confirm-warnings').check();
  await panel.getByRole('button', { name: '제출용으로 확정' }).click();
  const frozen = panel.getByTestId('frozen-submission');
  await expect(frozen).toHaveAttribute('data-status', 'submission_ready', { timeout: 30_000 });
  await expect(frozen).toContainText('Journal submission 1');
  const table = await page.request.get(new URL((await frozen.getByTestId('response-table').getAttribute('href'))!, h.webUrl).toString());
  expect(table.status()).toBe(200);
  expect(await table.text()).toContain('We now state that roots respond within two hours.');
  const stored = (await h.pool.query('SELECT status, docx_sha256 FROM submissions')).rows;
  expect(stored).toEqual([{ status: 'submission_ready', docx_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  await expect(frozen).toContainText(stored[0].docx_sha256.slice(0, 12));
  await page.screenshot({ path: 'reports/tasks/PW-058/2-frozen.png', fullPage: true });
});
