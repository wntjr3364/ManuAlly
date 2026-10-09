// PW-029 — TST-029A in the browser: app usage, context and account quota are shown apart; unknown
// stays unknown and a missing reset time is not guessed (Asia/Seoul for the known one).
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { recordQuota, recordUsage } from '../../../packages/domain/src/usage/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('TST-029A: the runs tab shows app usage, context and account quota separately', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Usage paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Usage paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const sid = randomUUID();
  const at = (m: number) => new Date(Date.UTC(2026, 9, 9, 1, m)).toISOString();
  await recordUsage(h.pool, { paperId, provider: 'claude_agent', nativeSessionId: sid, eventKey: `${sid}:t1`, observedAt: at(0), data: { scope: 'turn', input_tokens: 1000, output_tokens: 100, cost_usd_estimate: 0.01, context_window: 200_000 } });
  await recordUsage(h.pool, { paperId, provider: 'claude_agent', nativeSessionId: sid, eventKey: `${sid}:s1`, observedAt: at(1), data: { scope: 'session', input_tokens: 1000, output_tokens: 100, cost_usd_estimate: 0.01, context_window: null } });
  await recordUsage(h.pool, { paperId, provider: 'claude_agent', nativeSessionId: sid, eventKey: `${sid}:m2`, observedAt: at(3), data: { scope: 'message', input_tokens: 1300, output_tokens: 80, cost_usd_estimate: null, context_window: 200_000 } });
  await recordUsage(h.pool, { paperId, provider: 'claude_agent', nativeSessionId: sid, eventKey: `${sid}:m3`, observedAt: at(4), data: { scope: 'message', input_tokens: 1700, output_tokens: 120, cost_usd_estimate: null, context_window: 200_000 } });
  await recordUsage(h.pool, { paperId, provider: 'claude_agent', nativeSessionId: sid, eventKey: `${sid}:t2`, observedAt: at(5), data: { scope: 'turn', input_tokens: 3000, output_tokens: 200, cost_usd_estimate: 0.02, context_window: 200_000 } });
  await recordUsage(h.pool, { paperId, provider: 'claude_agent', nativeSessionId: sid, eventKey: `${sid}:s2`, observedAt: at(6), data: { scope: 'session', input_tokens: 4000, output_tokens: 300, cost_usd_estimate: 0.03, context_window: null } });
  await recordQuota(h.pool, { provider: 'claude_agent', authProfileId: 'claude-main', bucket: 'five_hour', eventKey: `${sid}:q1`, observedAt: at(6), data: { status: 'warning', used_percent: 82.5, resets_at: '2026-10-09T05:00:00Z', raw_resets_at: null, unknown_reason: null } });
  await recordQuota(h.pool, { provider: 'claude_agent', authProfileId: 'claude-main', bucket: 'seven_day', eventKey: `${sid}:q2`, observedAt: at(6), data: { status: 'unknown', used_percent: null, resets_at: null, raw_resets_at: null, unknown_reason: null } });
  await page.getByRole('tab', { name: 'AI 실행' }).click();
  const panel = page.getByTestId('usage');
  await expect(panel.getByTestId('usage-input')).toHaveText('4,000'); // the session total, not 8,000
  await expect(panel.getByTestId('usage-output')).toHaveText('300');
  await expect(panel.getByTestId('usage-cost')).toHaveText('$0.0300 (추정)');
  await expect(panel.getByTestId('usage-context')).toContainText('1,700 / 200,000 토큰 · 0.9%'); // one request, not the turn total
  const five = panel.getByTestId('quota').filter({ hasText: 'five_hour' });
  await expect(five.getByTestId('quota-used')).toHaveText('82.5%');
  await expect(five.getByTestId('quota-reset')).toContainText('오후 2:00');
  await expect(five.getByTestId('quota-reset')).toContainText('(서울)');
  const seven = panel.getByTestId('quota').filter({ hasText: 'seven_day' });
  await expect(seven.getByTestId('quota-used')).toHaveText('알 수 없음');
  await expect(seven.getByTestId('quota-reset')).toHaveText('초기화 시각 확인 불가');
  if (process.env.PW_SAVE_EVIDENCE === '1') await page.screenshot({ path: 'reports/tasks/PW-029/usage-panel.png', fullPage: true });
});
