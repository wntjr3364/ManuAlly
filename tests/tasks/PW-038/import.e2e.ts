// PW-038 — TST-038A/B in a real browser: a BibTeX paste and an RIS file are imported with a per-entry
// outcome, the imported references are cited by their stable ids and appear in the bibliography,
// importing again links the same references, a DOI the library does not know is not filled in, and the
// Zotero part says it only reads (no writing, no sync), sends only GET, and does not keep the key.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { startHarness, type Harness } from '../../e2e/manual-paper/harness.ts';

let h: Harness;
let zot: http.Server;
const zotSeen: { method: string; url: string; key?: string }[] = [];
const KEY = 'zoteroKey0123456789';
const zItems = [
  { id: 'Z1', type: 'article-journal', title: 'Root drought signalling from Zotero', author: [{ family: 'Park', given: 'J' }], issued: { 'date-parts': [[2019]] }, 'container-title': 'Synthetic Plant Journal' },
];
test.beforeAll(async () => {
  zot = http.createServer((req, res) => {
    zotSeen.push({ method: req.method!, url: req.url!, key: req.headers['zotero-api-key'] as string | undefined });
    if (req.url!.startsWith('/users/999/')) { res.writeHead(403); res.end('Forbidden'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'total-results': String(zItems.length) });
    res.end(JSON.stringify({ items: zItems }));
  });
  await new Promise<void>((r) => zot.listen(0, '127.0.0.1', r));
  h = await startHarness({ zotero: { baseUrl: `http://127.0.0.1:${(zot.address() as AddressInfo).port}`, allowLoopbackForTests: true } });
});
test.afterAll(async () => { await h?.stop(); await new Promise((r) => zot?.close(r)); });

const editor = (page: Page) => page.getByTestId('editor').locator('.ProseMirror');
const panel = (page: Page) => page.getByTestId('references');
const imp = (page: Page) => page.getByTestId('reference-import');

const BIB = `@article{kim2020,
  title = {ABC1 induction in drought-stressed roots},
  author = {Kim, Minji and Lee, Ho},
  journal = {Synthetic Journal},
  year = {2020},
  doi = {10.5555/pw038.e2e.1}
}
@article{lee2018,
  title = {Root hydraulics without a DOI},
  author = {Lee, Ho},
  year = {2018}
}
@article{kim2020,
  title = {A repeated key},
  year = {2021}
}`;
const RIS = `TY  - JOUR
TI  - Aquaporin regulation in roots
AU  - Choi, Ara
PY  - 2017
JO  - Synthetic Root Biology
ER  - 
`;

test('TST-038A/B: import shows each outcome, cites by stable id, re-import links, Zotero only reads', async ({ page }) => {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await page.getByLabel('새 논문 제목').fill('Import paper');
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: 'Import paper' }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  await expect(editor(page)).toHaveAttribute('contenteditable', 'true');

  // BibTeX, pasted: two added, the repeated key is refused (not guessed)
  const fileForm = imp(page).getByRole('form', { name: '참고문헌 파일에서 가져오기' });
  await fileForm.getByLabel('참고문헌 파일 형식').selectOption('bibtex');
  await fileForm.getByLabel('참고문헌 붙여넣기').fill(BIB);
  await fileForm.getByRole('button', { name: '가져오기' }).click();
  const results = imp(page).getByTestId('import-results');
  await expect(results).toContainText('파일에서 읽음 · 3개 항목');
  await expect(results.locator('[data-status="created"]')).toHaveCount(2);
  await expect(results.locator('[data-status="invalid"]')).toContainText('파일 안에서 같은 키가 반복됨');
  const list = panel(page).getByTestId('reference-list');
  await expect(list).toContainText('ABC1 induction in drought-stressed roots');
  await expect(list).toContainText('Root hydraulics without a DOI');
  await expect(list).not.toContainText('A repeated key');

  // cited by its stable id; the bibliography shows the imported metadata
  await editor(page).click();
  await page.keyboard.type('Drought induces ABC1 ');
  await list.locator('li', { hasText: 'ABC1 induction' }).getByRole('button', { name: '인용 넣기' }).click();
  await expect(editor(page).locator('[data-type="citation"], .citation, [data-label]').first()).toHaveAttribute('data-label', '[1]');
  await expect(panel(page).getByTestId('bibliography')).toContainText('ABC1 induction in drought-stressed roots');
  const refId = (await h.pool.query("SELECT r.reference_id FROM project_references r JOIN reference_identifiers i ON i.reference_id = r.reference_id WHERE r.paper_id = $1 AND i.value = '10.5555/pw038.e2e.1'", [paperId])).rows[0].reference_id as string;

  // the same file again: the same references, nothing duplicated
  await fileForm.getByRole('button', { name: '가져오기' }).click();
  await expect(results.locator('[data-status="already_in_paper"]')).toHaveCount(2);
  await expect(results.locator('[data-status="already_in_paper"]').first()).toContainText('이미 이 논문에 있음');
  await expect(results).toContainText('이미 이 논문에 있음 2');
  expect((await h.pool.query('SELECT count(*)::int AS n FROM project_references WHERE paper_id = $1', [paperId])).rows[0].n).toBe(2);
  expect((await h.pool.query("SELECT reference_id FROM reference_identifiers WHERE value = '10.5555/pw038.e2e.1'")).rows).toEqual([{ reference_id: refId }]);

  // the same DOI with other details: the paper gets the library's work, and the screen says which
  await fileForm.getByLabel('참고문헌 파일 형식').selectOption('csl-json');
  await fileForm.getByLabel('참고문헌 붙여넣기').fill(JSON.stringify([{ id: 'typo', title: 'ABC1 inductoin (typo)', DOI: '10.5555/PW038.E2E.1' }]));
  await fileForm.getByRole('button', { name: '가져오기' }).click();
  await expect(results.locator('[data-status="already_in_paper"]').getByTestId('import-library-title')).toHaveText('ABC1 induction in drought-stressed roots');
  await expect(imp(page).getByTestId('import-identity-note')).toContainText('키와 내용이 모두 같을 때만');
  // a citekey reused for another work: a new work, with the reason shown
  await fileForm.getByLabel('참고문헌 파일 형식').selectOption('bibtex');
  await fileForm.getByLabel('참고문헌 붙여넣기').fill('@article{lee2018, title = {An unrelated work under a reused key}, year = {2019}}');
  await fileForm.getByRole('button', { name: '가져오기' }).click();
  await expect(results.locator('[data-status="created"]')).toContainText('같은 키가 전에 다른 문헌에 쓰였음');
  await expect(list).toContainText('An unrelated work under a reused key');
  await expect(list).toContainText('Root hydraulics without a DOI');
  // an RIS file: the format follows the file name
  await fileForm.getByLabel('참고문헌 파일', { exact: true }).setInputFiles({ name: 'refs.ris', mimeType: 'application/x-research-info-systems', buffer: Buffer.from(RIS) });
  await expect(fileForm.getByLabel('참고문헌 파일 형식')).toHaveValue('ris');
  await fileForm.getByRole('button', { name: '가져오기' }).click();
  await expect(results.locator('[data-status="created"]')).toContainText('Aquaporin regulation in roots');
  await expect(list).toContainText('Aquaporin regulation in roots');

  // a DOI the library does not know: not looked up, not filled in, not added
  await fileForm.getByLabel('참고문헌 파일 형식').selectOption('doi-list');
  await fileForm.getByLabel('참고문헌 붙여넣기').fill('10.5555/pw038.unknown');
  await fileForm.getByRole('button', { name: '가져오기' }).click();
  await expect(results.locator('[data-status="unknown_doi"]')).toHaveCount(1);
  await expect(list.locator('li')).toHaveCount(4);

  // Zotero: says read-only, no writing, no sync; there is no control that claims otherwise
  await imp(page).getByText('Zotero에서 읽기(읽기 전용)').click();
  const z = imp(page).getByTestId('zotero');
  await expect(z.getByTestId('zotero-capabilities')).toContainText('읽기 전용');
  await expect(z).toContainText('Zotero에 쓰기: 하지 않음');
  await expect(z).toContainText('동기화: 없음');
  await expect(page.getByRole('button', { name: /동기화|Zotero에 저장|내보내기.*Zotero|Zotero.*보내기/ })).toHaveCount(0);
  const zf = z.getByRole('form', { name: 'Zotero에서 가져오기' });
  // a private library: fails clearly, nothing imported
  await zf.getByLabel('Zotero 라이브러리 번호').fill('999');
  await zf.getByRole('button', { name: 'Zotero에서 가져오기' }).click();
  await expect(imp(page).getByRole('alert')).toBeVisible();
  await expect(list.locator('li')).toHaveCount(4);
  // a readable one, with a key
  await zf.getByLabel('Zotero 라이브러리 번호').fill('12345');
  await zf.getByLabel('Zotero API 키(선택, 저장하지 않음)').fill(KEY);
  await zf.getByRole('button', { name: 'Zotero에서 가져오기' }).click();
  await expect(results).toContainText('Zotero에서 읽음 · 1개 항목');
  await expect(list).toContainText('Root drought signalling from Zotero');
  await expect(zf.getByLabel('Zotero API 키(선택, 저장하지 않음)')).toHaveValue('');
  expect(zotSeen.length).toBeGreaterThan(0);
  expect(zotSeen.every((s) => s.method === 'GET')).toBe(true);
  expect(zotSeen.at(-1)!.key).toBe(KEY);
  // the key is nowhere in the database
  const dump = JSON.stringify((await h.pool.query('SELECT * FROM reference_imports')).rows) + JSON.stringify((await h.pool.query('SELECT * FROM reference_import_items')).rows)
    + JSON.stringify((await h.pool.query('SELECT * FROM bibliographic_revisions')).rows);
  expect(dump).not.toContain(KEY);
  expect((await h.pool.query("SELECT source FROM bibliographic_revisions b JOIN project_references p ON p.reference_id = b.reference_id WHERE p.paper_id = $1 AND b.csl_json->>'title' LIKE 'Root drought%'", [paperId])).rows).toEqual([{ source: 'zotero' }]);
});
