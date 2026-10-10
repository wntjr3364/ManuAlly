// PW-052 — in a real browser, the runs tab says why a job waits or stopped and what the owner does next:
// a login error waits for a new login (not a quota wait), a usage limit waits for the reset.
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { enqueueJob } from '../../../packages/domain/src/jobs/index.ts';
import { processDelivery, type JobHandler } from '../../../apps/worker/src/queue/index.ts';
import { withQuotaWaits } from '../../../apps/worker/src/quota-scheduler/index.ts';
import { withErrorHandling } from '../../../apps/worker/src/errors/index.ts';

let h: Harness;
// no worker: the test delivers the jobs itself
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('TST-052A: a waiting job shows its reason and the owner\'s next step', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Error paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Error paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  const run = async (err: () => unknown) => {
    const { job } = await enqueueJob(h.pool, { paperId, ownerId, intent: 'review', idempotencyKey: randomUUID(), payload: { note: 'x' } });
    const handlers = withQuotaWaits(h.pool, withErrorHandling(h.pool, { review: (async () => { throw err(); }) as JobHandler }, { provider: 'claude_agent', authProfileId: `e2e-${randomUUID().slice(0, 6)}` }), { jitterMs: () => 0 });
    await processDelivery(h.pool, { job_id: job.id, paper_id: paperId, intent: 'review' }, { workerId: 'e2e', leaseMs: 60_000, handlers });
    return job.id;
  };
  const auth = await run(() => Object.assign(new Error('expired'), { status: 401, error: { type: 'authentication_error' } }));
  const quota = await run(() => Object.assign(new Error('Claude AI usage limit reached'), { status: 429 }));
  await page.getByRole('tab', { name: 'AI 실행' }).click();
  const authRow = page.locator(`[data-run-id="${auth}"]`);
  await expect(authRow).toHaveAttribute('data-status', 'WAITING_AUTH');
  await expect(authRow.getByTestId('run-reason')).toContainText('Log in again');
  const quotaRow = page.locator(`[data-run-id="${quota}"]`);
  await expect(quotaRow).toHaveAttribute('data-status', 'WAITING_QUOTA');
  await expect(quotaRow.getByTestId('run-reason')).toContainText('usage limit');
});
