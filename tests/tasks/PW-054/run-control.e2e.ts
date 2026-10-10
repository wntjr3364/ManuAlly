// PW-054 — in a real browser (Chromium, real API, temporary PostgreSQL): while an AI run waits for its quota,
// the owner edits the manuscript and reads the material; the run's panel shows what the database stores
// (status, reason, unknown reset and context said as unknown, auto-resume as proposal-only), and its
// resume, auto-resume and stop are the owner's acts that the database then holds.
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { processDelivery, type JobHandler } from '../../../apps/worker/src/queue/index.ts';
import { withQuotaWaits } from '../../../apps/worker/src/quota-scheduler/index.ts';
import { withErrorHandling } from '../../../apps/worker/src/errors/index.ts';

let h: Harness;
// no worker: the test delivers the job itself, so it stays waiting
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const dbStatus = async (jobId: string) => (await h.pool.query('SELECT status FROM jobs WHERE id = $1', [jobId])).rows[0].status as string;

test('TST-054A/B: manual work goes on while a run waits; the panel shows the database\'s state; resume and stop are the owner\'s', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Waiting paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Waiting paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;

  // an AI run that hit the provider's usage limit, with no reset time known
  const { job } = await enqueueJob(h.pool, { paperId, ownerId, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'x' } });
  const handlers = withQuotaWaits(h.pool, withErrorHandling(h.pool, { review: (async () => { throw Object.assign(new Error('Claude AI usage limit reached'), { status: 429 }); }) as JobHandler }, { provider: 'claude_agent', authProfileId: 'e2e-054' }), { jitterMs: () => 0 });
  await processDelivery(h.pool, { job_id: job.id, paper_id: paperId, intent: 'review' }, { workerId: 'e2e', leaseMs: 60_000, handlers });
  expect(await dbStatus(job.id)).toBe('WAITING_QUOTA');

  // the panel: the database's status and reason; unknown reset and context said as unknown; auto-resume only proposes
  await page.getByRole('tab', { name: 'AI 실행' }).click();
  const row = page.locator(`[data-run-id="${job.id}"]`);
  await row.getByTestId('run-details').click();
  const panel = row.getByTestId('run-control');
  await expect(panel).toHaveAttribute('data-status', 'WAITING_QUOTA');
  await expect(panel.getByTestId('ctl-status')).toContainText('사용량 한도');
  await expect(panel.getByTestId('ctl-reason')).toContainText('usage limit');
  await expect(panel.getByTestId('ctl-next')).toContainText('한도가 초기화되기를 기다림');
  await expect(panel.getByTestId('ctl-waits')).toContainText('초기화 시각 확인 불가');
  await expect(panel.getByTestId('ctl-context')).toHaveText('알 수 없음');
  await expect(panel.getByTestId('ctl-auto-resume')).toContainText('원고 적용은 언제나 직접');
  await page.screenshot({ path: 'reports/tasks/PW-054/1-waiting-run.png', fullPage: true });

  // meanwhile the manuscript is edited and saved by hand, and the material is open
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');
  await editor(page).click();
  await page.keyboard.type('Written by hand while the AI waits.');
  await expect(page.getByTestId('save-status')).toHaveText('저장됨', { timeout: 15_000 });
  const headText = (await h.pool.query("SELECT r.content_json::text AS t FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1 AND d.kind = 'manuscript'", [paperId])).rows[0].t as string;
  expect(headText).toContain('Written by hand while the AI waits.');
  await page.getByRole('tab', { name: '자료' }).click();
  await expect(page.getByRole('tabpanel')).toBeVisible();
  expect(await dbStatus(job.id)).toBe('WAITING_QUOTA');

  // the owner allows auto-resume for 6 hours: stored, and still said to stop at a proposal
  await page.getByRole('tab', { name: 'AI 실행' }).click();
  // the tab keeps its state while hidden: the panel is still open
  await expect(row.getByTestId('run-details')).toHaveAttribute('aria-expanded', 'true');
  await panel.getByTestId('ctl-hours').selectOption('6');
  await panel.getByTestId('ctl-allow').click();
  await expect(panel.getByTestId('ctl-auto-resume')).toContainText('허용됨');
  await expect(panel.getByTestId('ctl-auto-resume')).toContainText('원고 적용은 언제나 직접');
  expect((await h.pool.query('SELECT kind, hours FROM auto_resume_grants WHERE job_id = $1', [job.id])).rows).toEqual([{ kind: 'allow', hours: 6 }]);

  // the owner resumes it now: the database holds QUEUED, and the page shows it
  await panel.getByTestId('ctl-resume').click();
  await expect(panel).toHaveAttribute('data-status', 'QUEUED');
  await expect(row).toHaveAttribute('data-status', 'QUEUED');
  expect(await dbStatus(job.id)).toBe('QUEUED');
  await expect(panel.getByTestId('ctl-resume')).toHaveCount(0);
  await expect(panel.getByTestId('ctl-waits')).toContainText('끝난 대기');
  // the old waiting reason is not shown for a queued job
  await expect(panel.getByTestId('ctl-reason')).toHaveCount(0);
  await expect(panel.getByTestId('ctl-next')).toHaveCount(0);
  await page.screenshot({ path: 'reports/tasks/PW-054/2-resumed.png', fullPage: true });

  // and stops it
  await panel.getByTestId('ctl-cancel').click();
  await expect(row).toHaveAttribute('data-status', 'CANCELLED');
  expect(await dbStatus(job.id)).toBe('CANCELLED');
  await expect(panel.getByTestId('ctl-cancel')).toHaveCount(0);
  // a reload reads the same stored state
  await page.reload();
  await page.getByRole('tab', { name: 'AI 실행' }).click();
  await expect(page.locator(`[data-run-id="${job.id}"]`)).toHaveAttribute('data-status', 'CANCELLED');
});
