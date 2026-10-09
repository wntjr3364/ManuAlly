// PW-033 — TST-033A/B in a real browser: the literature tab asks for a curation run (MOCK assessor),
// shows each candidate's use, fit, read depth, reasons, warnings and exclusion reason, keeps the
// "highly cited" style claim at "알 수 없음", never offers a retracted work as scientific support, and
// adopts only on the owner's click with the chosen use.
import { test, expect } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';
import { createStoryRevision } from '../../../packages/domain/src/outlines/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: { chunkDelayMs: 10 } }); });
test.afterAll(async () => { await h?.stop(); });

const brief = { purpose: 'Test whether ABC1 responds to drought in roots', audience: 'plant stress biologists', known_facts: ['ABC1 induced 2.4-fold'], missing_material: [], avoid_claims: [] };
const story = { question: 'Does ABC1 respond to drought?', main_message: 'ABC1 is drought-induced', novelty: 'none yet', evidence_links: [], competing_explanations: [], presentation_order: ['induction'], limitations: ['single genotype'] };

test('TST-033A/B: suggestions are shown with use, fit, depth and warnings; nothing is adopted until the owner decides', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Literature paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Literature paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  const owner = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  await createStoryRevision(h.pool, { paperId, ownerId: owner, parent: null, brief, story });
  // a stored search with synthetic candidates (the search adapters are tested in PW-031)
  const s = (await h.pool.query("INSERT INTO literature_searches (paper_id, created_by, source, query, params, cache_key, endpoint, status) VALUES ($1, $2, 'crossref', 'ABC1 drought', '{}', repeat('c', 64), 'https://api.crossref.org/works', 'ok') RETURNING id", [paperId, owner])).rows[0].id;
  const cands = [
    ['10.5555/e2e.1', 'ABC1 induction under drought in roots', null],
    ['10.5555/e2e.2', 'A highly cited review of drought signalling', null],
    ['10.5555/e2e.3', 'ABC2 drought responsiveness', { type: 'retracted_publication' }],
    ['10.5555/e2e.4', 'Leaf colour in tulips', null],
  ] as const;
  for (const [i, [doi, title, notice]] of cands.entries()) {
    await h.pool.query(
      `INSERT INTO literature_candidates (search_id, paper_id, source, rank, source_record_id, doi, title, authors, year, container, work_type, is_preprint, relations, update_notice)
       VALUES ($1, $2, 'crossref', $3, $4, $4, $5, '[{"family":"Kim"}]', 2021, 'Synthetic Journal', 'journal-article', false, '{}', $6)`, [s, paperId, i + 1, doi, title, notice ? JSON.stringify(notice) : null]);
  }

  await page.getByRole('tab', { name: '문헌' }).click();
  await expect(page.getByText('검색 1건 · 후보 4개')).toBeVisible();
  await page.getByRole('button', { name: '후보 평가 요청' }).click();
  await expect(page.getByRole('status')).toContainText('평가를 요청했습니다');
  await expect.poll(async () => { await page.getByRole('button', { name: '새로 고침' }).click(); return page.getByTestId('assessment').count(); }, { timeout: 10_000 }).toBe(4);
  await expect(page.getByTestId('curation-run')).toContainText('MOCK');

  const item = (title: string) => page.getByTestId('assessment').filter({ hasText: title });
  await expect(item('ABC1 induction').getByTestId('assessment-role')).toHaveText('과학 근거 후보');
  await expect(item('ABC1 induction').getByTestId('assessment-depth')).toHaveText('서지 정보만 확인');
  // "highly cited" is not evidence of good writing
  await expect(item('highly cited').getByTestId('assessment-style')).toHaveText('알 수 없음');
  await expect(item('highly cited').getByTestId('assessment-warning')).toContainText('문체는 본문을 읽어야');
  // retracted: excluded, said why, cannot be adopted
  await expect(item('ABC2').getByTestId('assessment-role')).toHaveText('제외 제안');
  await expect(item('ABC2').getByTestId('assessment-exclusion')).toContainText('철회');
  await expect(item('ABC2').getByLabel('용도')).toHaveValue('writing');
  await expect(item('ABC2').locator('option[value="scientific"]')).toHaveAttribute('disabled', '');
  await expect(item('ABC2').locator('option[value="both"]')).toHaveAttribute('disabled', '');
  await expect(item('tulips').getByTestId('assessment-exclusion')).toContainText('관련이 낮음');
  expect((await h.pool.query('SELECT count(*)::int AS n FROM project_references WHERE paper_id = $1', [paperId])).rows[0].n).toBe(0);
  if (process.env.PW_SAVE_EVIDENCE === '1') await page.screenshot({ path: 'reports/tasks/PW-033/curation-tab.png', fullPage: true });

  // the owner adopts one as a writing reference and declines another
  await item('ABC1 induction').getByLabel('용도').selectOption('writing');
  await item('ABC1 induction').getByRole('button', { name: '채택', exact: true }).click();
  await expect(item('ABC1 induction').getByTestId('assessment-decision')).toHaveText('채택함 · 문체 참고 후보');
  await item('tulips').getByRole('button', { name: '채택 안 함' }).click();
  await expect(item('tulips').getByTestId('assessment-decision')).toHaveText('채택 안 함');
  const refs = (await h.pool.query('SELECT use_role FROM project_references WHERE paper_id = $1', [paperId])).rows;
  expect(refs).toEqual([{ use_role: 'writing' }]);
});
