// PW-032 re-review — in a real browser: typing a DOI the library already has, with other details, does
// not change the library's work; the owner sees the library's details and adds that work as it is.
import { test, expect } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

test('a known DOI with other details: the library work is offered, never overwritten', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  for (const title of ['Paper one', 'Paper two']) {
    await page.getByLabel('새 논문 제목').fill(title);
    await page.getByRole('button', { name: '새 논문' }).click();
    await expect(page.getByRole('link', { name: title })).toBeVisible();
  }
  const add = async (paper: string, r: { title: string; authors: string; year: string; doi: string }) => {
    await page.goto(h.webUrl);
    await page.getByRole('link', { name: paper }).click();
    await page.getByRole('tab', { name: '원고' }).click();
    await page.getByRole('button', { name: '원고 만들기' }).or(page.getByTestId('editor')).first().click();
    const form = page.getByTestId('references').getByRole('form', { name: '문헌 추가' });
    await form.getByLabel('제목').fill(r.title);
    await form.getByLabel('저자').fill(r.authors);
    await form.getByLabel('연도').fill(r.year);
    await form.getByLabel('DOI').fill(r.doi);
    await form.getByRole('button', { name: '문헌 추가' }).click();
  };
  await add('Paper one', { title: 'Correct title', authors: 'Kim, Ji', year: '2021', doi: '10.5555/known.1' });
  await expect(page.getByTestId('reference-list')).toContainText('Correct title');
  await add('Paper two', { title: 'Typo title', authors: 'Nobody', year: '1999', doi: '10.5555/KNOWN.1' });
  const known = page.getByTestId('known-doi');
  await expect(known).toContainText('Correct title');
  await expect(known).toContainText('2021');
  await expect(page.getByTestId('reference-list')).not.toContainText('Typo title');
  if (process.env.PW_SAVE_EVIDENCE === '1') await page.screenshot({ path: 'reports/tasks/PW-032/known-doi.png' });
  await known.getByRole('button', { name: '서재 정보로 추가' }).click();
  await expect(page.getByTestId('reference-list')).toContainText('Correct title');
  await expect(page.getByTestId('known-doi')).toHaveCount(0);
  // paper one still shows its details
  await page.goto(h.webUrl);
  await page.getByRole('link', { name: 'Paper one' }).click();
  await page.getByRole('tab', { name: '원고' }).click();
  await expect(page.getByTestId('reference-list')).toContainText('Kim (2021). Correct title');
  expect((await h.pool.query("SELECT count(*)::int AS n FROM bibliographic_revisions b JOIN reference_identifiers i ON i.reference_id = b.reference_id WHERE i.value = '10.5555/known.1'")).rows[0].n).toBe(1);
});
