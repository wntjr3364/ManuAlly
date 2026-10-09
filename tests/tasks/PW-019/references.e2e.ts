// PW-019 — TST-019A / TST-019B in a real browser: citations and figure references are inserted as id
// atoms; their labels follow the style and the figure order; unknown targets are flagged, not numbered.
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness(); });
test.afterAll(async () => { await h?.stop(); });

const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const status = (page: Page) => page.getByTestId('save-status');
const panel = (page: Page) => page.getByTestId('references');
const labels = (page: Page, sel: string) => editor(page).locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('data-label')));

async function start(page: Page, title: string) {
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
  return new URL(page.url()).pathname.split('/')[2]!;
}
async function addReference(page: Page, r: { title: string; authors: string; year: string; container?: string; doi?: string }) {
  const form = panel(page).getByRole('form', { name: '문헌 추가' });
  await form.getByLabel('제목').fill(r.title);
  await form.getByLabel('저자').fill(r.authors);
  await form.getByLabel('연도').fill(r.year);
  if (r.container) await form.getByLabel('학술지').fill(r.container);
  if (r.doi) await form.getByLabel('DOI').fill(r.doi);
  await form.getByRole('button', { name: '문헌 추가' }).click();
  await expect(panel(page).getByTestId('reference-list')).toContainText(r.title);
}
async function addFigure(page: Page, title: string) {
  const form = panel(page).getByRole('form', { name: '그림·표 추가' });
  await form.getByLabel('그림·표 제목').fill(title);
  await form.getByRole('button', { name: '그림·표 추가' }).click();
  await expect(panel(page).getByTestId('figure-list')).toContainText(title);
}
const insertCitation = (page: Page, title: string) => panel(page).getByTestId('reference-list').locator('li', { hasText: title }).getByRole('button', { name: '인용 넣기' }).click();
const insertFigure = (page: Page, title: string) => panel(page).getByTestId('figure-list').locator('li', { hasText: title }).getByRole('button', { name: '참조 넣기' }).click();

test('TST-019A: labels and the bibliography follow the document, the style and the figure order', async ({ page }) => {
  const paperId = await start(page, 'Citation paper');
  await addReference(page, { title: 'Drought induces ABC1', authors: 'Kim, Ji', year: '2020', container: 'Plant J', doi: '10.1234/abc' });
  await addReference(page, { title: 'Root growth', authors: 'Lee, Su; Park', year: '2019' });
  await addFigure(page, 'Induction');
  await addFigure(page, 'Survival');
  await editor(page).click();
  await page.keyboard.type('As shown ');
  await insertCitation(page, 'Root growth');
  await page.keyboard.type(' and ');
  await insertCitation(page, 'Drought induces ABC1');
  await page.keyboard.type(' (');
  await insertFigure(page, 'Survival');
  await page.keyboard.type(').');
  await expect(status(page)).toHaveText('저장됨', { timeout: 10_000 });
  expect(await labels(page, 'span[data-pw-citation]')).toEqual(['[1]', '[2]']);
  expect(await labels(page, 'span[data-pw-figure_ref]')).toEqual(['Figure 2']);
  await expect(panel(page).getByTestId('bibliography').locator('li')).toHaveText(['[1] Lee, S., & Park (2019). Root growth.', '[2] Kim, J. (2020). Drought induces ABC1. Plant J. https://doi.org/10.1234/abc']);
  // style change: every label and the bibliography order change together
  await panel(page).getByLabel('인용 형식').selectOption('author_year');
  await expect.poll(() => labels(page, 'span[data-pw-citation]')).toEqual(['(Lee & Park 2019)', '(Kim 2020)']);
  await expect(panel(page).getByTestId('bibliography').locator('li').first()).toContainText('(Kim 2020) Kim, J.');
  // figure order change: the reference renumbers
  await panel(page).getByRole('button', { name: 'Survival 위로' }).click();
  await expect.poll(() => labels(page, 'span[data-pw-figure_ref]')).toEqual(['Figure 1']);
  // the stored document holds ids only, never label or bibliography text
  const { rows } = await h.pool.query("SELECT r.content_json::text AS j FROM documents d JOIN document_revisions r ON r.id = d.head_revision_id WHERE d.paper_id = $1 AND d.kind = 'manuscript'", [paperId]);
  expect(rows[0].j).toContain('"referenceId"');
  expect(rows[0].j).not.toMatch(/\[1\]|Kim 2020|Figure [12]|doi\.org/);
});

test('TST-019B: a citation to a reference this paper does not have is flagged and left out of the bibliography', async ({ page }) => {
  await start(page, 'Unknown citation paper');
  await addReference(page, { title: 'Known work', authors: 'Kim, Ji', year: '2020' });
  await editor(page).click();
  await page.keyboard.type('Claim ');
  await insertCitation(page, 'Known work');
  await page.keyboard.type(' and ');
  // a citation pasted from elsewhere (its reference is not in this paper)
  await editor(page).evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<span data-pw-citation="" data-reference-id="00000000-0000-4000-8000-0000000000ee">[인용]</span>');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => labels(page, 'span[data-pw-citation]')).toEqual(['[1]', '[?]']);
  await expect(editor(page).locator('span[data-pw-citation].unresolved')).toHaveCount(1);
  await expect(panel(page).getByTestId('unresolved')).toContainText('이 논문에 없는 인용 1개');
  await expect(panel(page).getByTestId('bibliography').locator('li')).toHaveText(['[1] Kim, J. (2020). Known work.']);
  // free bibliography text cannot be entered as a reference
  const r = await page.evaluate(async () => {
    const s = await (await fetch('/api/auth/session')).json();
    const paper = location.pathname.split('/')[2];
    const res = await fetch(`/api/papers/${paper}/references`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pw-csrf': s.csrfToken }, body: JSON.stringify({ bibliography: 'Kim J (2020) Known work.' }) });
    return res.status;
  });
  expect(r).toBe(422);
});
