// PW-046 — the researcher's path in a real browser, for two article types (MOCK writer):
// new paper of a type → section suggestions for that type (not enforced) → approved story and outline
// with the paper's own sections (plans backed by a fact and by a library reference's excerpt) →
// "개요로 원고 골격 만들기" → a paragraph from a plan lands in its section (the excerpt, which may not be
// sent, is not cited) → a correction request on it → the story's novelty is what the user approved.
// TST-046A: the outline's sections become the manuscript's headings, in outline order; the paragraph
//   goes under its plan's heading.
// TST-046B: a software paper gets its own sections, no Introduction/Methods/Results/Discussion is
//   added; nothing in the path changes the novelty.
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../manual-paper/harness.ts';
import { approveClaim, createClaim, createEvidence, createFactCandidates, linkClaimEvidence, reviewEvidence, reviewFact } from '../../../packages/domain/src/evidence/index.ts';
import { createReference } from '../../../packages/domain/src/references/index.ts';
import { approveOutlineRevision, approveStoryRevision, createOutlineRevision, createStoryRevision } from '../../../packages/domain/src/outlines/index.ts';

let h: Harness;
test.beforeAll(async () => { h = await startHarness({ worker: {} }); });
test.afterAll(async () => { await h?.stop(); });

const NOVELTY = 'The first marker that separates root drought response from leaf response';

async function login(page: Page) {
  await page.goto(h.webUrl);
  await page.getByLabel('사용자 이름').fill('alice');
  await page.getByLabel('비밀번호').fill('correct horse battery');
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.getByRole('heading', { name: '내 논문' })).toBeVisible();
}

// the story, one verified fact with an approved claim, a library reference with a verified excerpt,
// and the approved outline (one plan per section, each with the claim, the fact and the excerpt)
async function seed(paperId: string, sections: string[]) {
  const ownerId = (await h.pool.query('SELECT owner_id FROM paper_projects WHERE id = $1', [paperId])).rows[0].owner_id as string;
  const s = await createStoryRevision(h.pool, { paperId, ownerId, parent: null, brief: { purpose: 'Report the result' }, story: { question: 'Does ABC1 respond?', main_message: 'ABC1 is drought-induced', novelty: NOVELTY } });
  await approveStoryRevision(h.pool, { paperId, ownerId, revisionId: s.id, body: { intent: 'approve_story', content_hash: s.content_hash } });
  const ev = await createEvidence(h.pool, { paperId, ownerId, body: { kind: 'experiment', locator: { note: 'run 1' }, label: 'Exp 1' } });
  await reviewEvidence(h.pool, { paperId, ownerId, id: ev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: ev.content_hash } });
  const [f] = await createFactCandidates(h.pool, { paperId, ownerId, origin: 'user', single: true, facts: [{ evidence_id: ev.id, entity: 'ABC1 roots', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(h.pool, { paperId, ownerId, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(h.pool, { paperId, ownerId, body: { kind: 'observation', text: 'ABC1 rises in roots.' } });
  await linkClaimEvidence(h.pool, { paperId, ownerId, claimId: c.id, body: { evidence_id: ev.id, relation: 'supports' } });
  await approveClaim(h.pool, { paperId, ownerId, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  const ref = await createReference(h.pool, { paperId, ownerId, body: { title: 'Earlier root drought study', authors: [{ family: 'Kim' }], year: 2019 } });
  // an excerpt typed in without a confirmed PDF location: it is evidence for the plan, but it may not
  // be sent to a writer (PW-037 no_confirmed_source_document; MOCK is never a provider a paper allows)
  const quote = 'ABC1 transcripts rose in drought-stressed roots.';
  const lit = await createEvidence(h.pool, { paperId, ownerId, body: { kind: 'literature_excerpt', reference_id: ref.id, locator: { quote } } });
  await reviewEvidence(h.pool, { paperId, ownerId, id: lit.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: lit.content_hash } });
  const base = { parent_node_id: null, role: 'result', claim_ids: [c.id], evidence_ids: [ev.id, lit.id], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null };
  const o = await createOutlineRevision(h.pool, { paperId, ownerId, parent: null, storyRevisionId: s.id, nodes: sections.map((section) => ({ ...base, node_id: randomUUID(), section, paragraph_goal: `${section} plan` })) });
  await approveOutlineRevision(h.pool, { paperId, ownerId, revisionId: o.id, body: { intent: 'approve_outline', content_hash: o.content_hash } });
}

// the editor's top-level blocks as "#Heading" / "p"
const shape = (page: Page) => page.locator('.ProseMirror > *').evaluateAll((els) => els.map((e) => (/^H\d$/.test(e.tagName) ? `#${e.textContent}` : 'p')));

async function workflow(page: Page, a: { title: string; typeLabel: string; suggested: string[]; notSuggested: string[]; sections: string[]; target: number }) {
  await login(page);
  await page.getByLabel('새 논문 제목').fill(a.title);
  await page.getByLabel('논문 유형').selectOption({ label: a.typeLabel });
  await page.getByRole('button', { name: '새 논문' }).click();
  await page.getByRole('link', { name: a.title }).click();
  const paperId = new URL(page.url()).pathname.split('/')[2]!;

  // suggestions for this type, shown as suggestions (any section is accepted)
  await page.getByRole('tab', { name: '구상·개요' }).click();
  const hint = page.getByTestId('section-suggestions');
  for (const s of a.suggested) await expect(hint).toContainText(s);
  for (const s of a.notSuggested) await expect(hint).not.toContainText(s);
  await expect(hint).toContainText('필수 아님');

  await seed(paperId, a.sections);
  await page.reload();
  await page.getByRole('tab', { name: '원고' }).click();
  await page.getByRole('button', { name: '원고 만들기' }).click();
  const scaffold = page.getByTestId('scaffold');
  await expect(scaffold).toContainText(a.sections.join(' · '));
  await scaffold.getByRole('button', { name: '개요로 원고 골격 만들기' }).click();
  await expect(scaffold.getByRole('status')).toContainText(a.sections.join(', '));
  await expect.poll(() => shape(page)).toEqual(a.sections.map((s) => `#${s}`));

  // a paragraph from the target section's plan: placed automatically at the end of that section
  const panel = page.getByTestId('writer');
  const target = a.sections[a.target]!;
  await panel.getByLabel('문단 계획').selectOption({ label: `${target} · ${target} plan` });
  await panel.getByRole('button', { name: '제안 요청' }).click();
  const proposal = panel.getByTestId('writer-proposal').first();
  await expect(proposal.getByTestId('writer-status')).toHaveText('적용 가능');
  await proposal.getByRole('button', { name: '적용' }).click();
  await expect(proposal.getByTestId('writer-status')).toHaveText('적용됨');
  const expected = a.sections.flatMap((s, i) => (i === a.target ? [`#${s}`, 'p'] : [`#${s}`]));
  await expect.poll(() => shape(page)).toEqual(expected);
  await expect(page.locator('.ProseMirror > p')).toContainText('ABC1 rises in roots');
  // the plan's literature: its excerpt was withheld from the writer, so the paragraph cites nothing
  // (a citation comes only from material the writer could see; the owner adds one by hand)
  await expect(page.locator('.ProseMirror > p [data-pw-citation]')).toHaveCount(0);

  // a correction request on that paragraph: still a proposal, the paragraph stays in its section
  await panel.getByLabel('할 일').selectOption({ label: '보수적 교정' });
  await panel.getByLabel('고칠 문단').selectOption({ index: 1 });
  await panel.getByRole('button', { name: '제안 요청' }).click();
  await expect(panel.getByTestId('writer-proposal').first().getByTestId('writer-status')).toHaveText(/바꿀 것 없음|적용 가능/);
  await expect.poll(() => shape(page)).toEqual(expected);

  // scaffolding again adds nothing
  await scaffold.getByRole('button', { name: '개요로 원고 골격 만들기' }).click();
  await expect(scaffold.getByRole('status')).toContainText('모두 원고에 있습니다');

  // the story is the one the user approved: one revision, the same novelty
  const story = await h.pool.query('SELECT story FROM story_revisions WHERE paper_id = $1', [paperId]);
  expect(story.rows).toHaveLength(1);
  expect(story.rows[0].story.novelty).toBe(NOVELTY);
  return shape(page);
}

test('TST-046A/B: a biology research article — its outline\'s sections and a Results paragraph under Results', async ({ page }) => {
  await workflow(page, { title: 'Root drought paper', typeLabel: '연구 논문', suggested: ['Introduction', 'Results', 'Discussion', 'Methods'], notSuggested: ['Implementation'], sections: ['Introduction', 'Results', 'Discussion', 'Methods'], target: 1 });
});

test('TST-046A/B: a software paper — its own sections, no IMRaD added, the paragraph under Implementation', async ({ page }) => {
  const final = await workflow(page, { title: 'Drought marker toolkit', typeLabel: '소프트웨어·리소스', suggested: ['Implementation', 'Availability'], notSuggested: ['Methods', 'Results', 'Discussion'], sections: ['Background', 'Implementation', 'Use cases', 'Availability'], target: 1 });
  for (const imrad of ['#Introduction', '#Methods', '#Results', '#Discussion']) expect(final).not.toContain(imrad);
});
