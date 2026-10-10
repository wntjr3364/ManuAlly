// PW-059 audit fixture: an owner's paper with as many kinds of record as the API makes — story and outline
// (approved), evidence, fact, claim, a drafted paragraph (mock writer job), references, a figure with its file
// and version, a source PDF, the manuscript, a comment thread, an edit proposal, a snapshot, an export, a
// reviewer comment and answer, a scientific check, a review run with a finding, a writing-profile note, a text
// import and a draft submission. Every text an owner writes carries the owner's canary, so a leak of any of
// it into another owner's response is found by searching for the canary. All text is synthetic.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { approveClaim, createClaim, createEvidence, createFactCandidates, linkClaimEvidence, reviewEvidence, reviewFact } from '../../packages/domain/src/evidence/index.ts';
import { createProposal } from '../../packages/domain/src/proposals/index.ts';
import { parseDocument, snapshotSelection } from '../../packages/editor-core/src/index.ts';
import { processDelivery } from '../../apps/worker/src/queue/index.ts';
import { writerHandlers, createMockWriter } from '../../apps/worker/src/writer/index.ts';
import { pdfHandlers } from '../../apps/worker/src/pdf/index.ts';
import { storyHandlers, createMockStoryGenerator } from '../../apps/worker/src/story/index.ts';
import { PAPER_V1 } from '../tasks/PW-035/fixtures.ts';

export interface World { paperId: string; ownerId: string; documentId: string; canary: string; made: string[] }
type Call = (method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ statusCode: number; body: string; json(): any }>; // eslint-disable-line @typescript-eslint/no-explicit-any

const node = (o: Record<string, unknown>) => ({ node_id: randomUUID(), parent_node_id: null, role: 'result', paragraph_goal: 'goal', claim_ids: [], evidence_ids: [], requires_evidence: false, allowed_interpretation: '', exclusions: [], transition: '', word_budget_min: null, word_budget_max: null, ...o });

// `inject`: untrusted text (e.g. an injected instruction) put into the long fields: outline goals, the
// manuscript, a reference title
export async function buildWorld(app: FastifyInstance, pool: pg.Pool, headers: Record<string, string>, canary: string, inject = '', assetDir?: string): Promise<World> {
  const made: string[] = [];
  const call: Call = (method, url, payload) => app.inject({ method, url, headers, payload: payload as object | undefined });
  const ok = async (what: string, r: Promise<{ statusCode: number; body: string; json(): any }>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const x = await r;
    if (x.statusCode >= 300) throw new Error(`${what}: ${x.statusCode} ${x.body}`);
    made.push(what);
    return x.json();
  };
  const p = await ok('paper', call('POST', '/api/papers', { working_title: `${canary} paper`, article_type: 'research_article' }));
  const P = `/api/papers/${p.id}`;
  const owner = p.owner_id as string;
  const s = await ok('story', call('POST', `${P}/story/revisions`, { parent_revision_id: null, brief: { purpose: `${canary} purpose`, audience: 'x', known_facts: [], missing_material: [], avoid_claims: [] }, story: { question: `Does ABC1 respond to drought (${canary})?`, main_message: `${canary} ABC1 is induced by drought`, novelty: 'First root-specific drought marker in this species', evidence_links: [], competing_explanations: [], presentation_order: [], limitations: [] } }));
  await ok('story approval', call('POST', `${P}/story/revisions/${s.id}/approve`, { intent: 'approve_story', content_hash: s.content_hash }));
  const e = await createEvidence(pool, { paperId: p.id, ownerId: owner, body: { kind: 'experiment', locator: { note: `${canary} run` }, label: `${canary} evidence` } });
  await reviewEvidence(pool, { paperId: p.id, ownerId: owner, id: e.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: e.content_hash } });
  const [f] = await createFactCandidates(pool, { paperId: p.id, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: e.id, entity: `${canary} entity`, metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'drought', comparison: 'control', n: 3, extraction_method: 'manual_entry' }] });
  await reviewFact(pool, { paperId: p.id, ownerId: owner, id: f!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f!.content_hash } });
  const c = await createClaim(pool, { paperId: p.id, ownerId: owner, body: { kind: 'observation', text: `${canary} claim text.` } });
  await linkClaimEvidence(pool, { paperId: p.id, ownerId: owner, claimId: c.id, body: { evidence_id: e.id, relation: 'supports' } });
  await approveClaim(pool, { paperId: p.id, ownerId: owner, id: c.id, body: { intent: 'approve_claim', content_hash: c.content_hash } });
  made.push('evidence', 'fact', 'claim');
  const nodes = ['Introduction', 'Results'].map((section) => node({ section, paragraph_goal: `${canary} ${section} ${inject}`.trim(), claim_ids: [c.id], evidence_ids: [e.id] }));
  const o = await ok('outline', call('POST', `${P}/outline/revisions`, { parent_revision_id: null, story_revision_id: s.id, nodes }));
  await ok('outline approval', call('POST', `${P}/outline/revisions/${o.id}/approve`, { intent: 'approve_outline', content_hash: o.content_hash }));
  const d = await ok('manuscript', call('POST', `${P}/documents`, { kind: 'manuscript' }));
  const documentId = d.document.id as string;
  // a drafted paragraph through the mock writer (a job, a paragraph proposal, an applied revision)
  const wr = await ok('writer request', call('POST', `${P}/writer/requests`, { mode: 'draft', outline_revision_id: o.id, node_id: nodes[1]!.node_id, document_id: documentId, base_revision_id: d.head.id, idempotency_key: randomUUID() }));
  await processDelivery(pool, { job_id: wr.job.id, paper_id: p.id, intent: 'draft_paragraph' }, { workerId: 'audit', leaseMs: 60_000, handlers: writerHandlers(pool, createMockWriter()) });
  const wp = (await call('GET', `${P}/writer/proposals?document_id=${documentId}`)).json()[0];
  const applied = await ok('writer apply', call('POST', `${P}/writer/proposals/${wp.id}/apply`, { intent: 'apply_paragraph', proposal_hash: wp.proposal_hash, expected_revision_id: wp.base_revision_id }));
  const ref = await ok('reference', call('POST', `${P}/references`, { title: `${canary} reference title ${inject}`.trim().slice(0, 500), authors: [{ family: 'Kim', given: 'J' }], year: 2020 }));
  const fig = await ok('figure', call('POST', `${P}/figures`, { kind: 'figure', title: `${canary} figure` }));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`${canary} image ${randomUUID()}`)]);
  const file = await ok('figure file', app.inject({ method: 'POST', url: `${P}/figures/${fig.id}/files?name=fig.png`, headers: { ...headers, 'content-type': 'image/png' }, payload: png }));
  const v1 = await ok('figure version', call('POST', `${P}/figures/${fig.id}/versions`, { caption: `${canary} caption.`, panels: [{ panel: 'A', unit: 'fold', groups: ['WT', 'abc1'] }], asset_id: file.asset_id }));
  const pdf = await ok('source pdf', app.inject({ method: 'POST', url: `${P}/assets?license=cc-by`, headers: { ...headers, 'content-type': 'application/pdf' }, payload: PAPER_V1() }));
  // a PDF anchor: the source extracted by the PDF worker, then a quote anchored on its page
  if (assetDir) {
    const ex = await ok('pdf extraction', call('POST', `${P}/assets/${pdf.id}/extract`, { idempotency_key: randomUUID() }));
    await processDelivery(pool, { job_id: ex.job.id, paper_id: p.id, intent: 'parse_source' }, { workerId: 'audit', leaseMs: 60_000, handlers: pdfHandlers(pool, { assetDir }) });
    await ok('pdf anchor', call('POST', `${P}/assets/${pdf.id}/anchors`, { page_index: 0, exact: 'induced 2.4-fold' }));
  }
  // a figure-panel evidence linked to the figure version; a unit change then raises review flags
  const fev = await ok('figure evidence', call('POST', `${P}/evidence`, { kind: 'figure_panel', source_asset_revision_id: file.asset_id, locator: { panel: 'A', figure: fig.id }, label: `${canary} panel` }));
  await ok('figure link', call('POST', `${P}/evidence/${fev.id}/figure-link`, { figure_version_id: v1.version.id, panel: 'A' }));
  await ok('claim figure link', call('POST', `${P}/claims/${c.id}/evidence-links`, { evidence_id: fev.id, relation: 'supports' }));
  await ok('figure unit change', call('POST', `${P}/figures/${fig.id}/versions`, { caption: `${canary} caption.`, panels: [{ panel: 'A', unit: 'log2 fold', groups: ['WT', 'abc1'] }], asset_id: file.asset_id }));
  // story alternatives through the mock story worker
  const sa = await ok('story alternatives run', call('POST', `${P}/story-alternatives/runs`, { base_story_revision_id: s.id, idempotency_key: randomUUID() }));
  await processDelivery(pool, { job_id: sa.job.id, paper_id: p.id, intent: 'propose_story' }, { workerId: 'audit', leaseMs: 60_000, handlers: storyHandlers(pool, createMockStoryGenerator()) });
  if (!(await pool.query('SELECT 1 FROM story_alternatives WHERE paper_id = $1', [p.id])).rowCount) {
    const j = (await pool.query('SELECT status, last_error, result FROM jobs WHERE id = $1', [sa.job.id])).rows[0];
    throw new Error(`story alternatives: none made (${JSON.stringify(j)})`);
  }
  made.push('story alternatives');
  // a curation assessment (made directly: a curation run needs a literature search against a real source)
  const search = (await pool.query(`INSERT INTO literature_searches (paper_id, created_by, source, query, params, cache_key, endpoint, status, total_results) VALUES ($1, $2, 'crossref', $3, '{}', $4, 'synthetic', 'ok', 1) RETURNING id`, [p.id, owner, `${canary} query`, 'c'.repeat(64)])).rows[0].id;
  const cand = (await pool.query(`INSERT INTO literature_candidates (search_id, paper_id, source, rank, source_record_id, title, authors) VALUES ($1, $2, 'crossref', 1, $3, $4, '[]') RETURNING id`, [search, p.id, `rec-${randomUUID()}`, `${canary} candidate`])).rows[0].id;
  const crun = (await pool.query(`INSERT INTO curation_runs (paper_id, assessor, search_ids, brief_hash) VALUES ($1, 'mock', $2, $3) RETURNING id`, [p.id, [search], 'd'.repeat(64)])).rows[0].id;
  await pool.query(`INSERT INTO curation_assessments (run_id, paper_id, candidate_id, role, topic_fit, article_type_fit, style_fit, read_depth, reasons) VALUES ($1, $2, $3, 'scientific', 'high', 'high', 'good', 'METADATA_ONLY', $4)`, [crun, p.id, cand, `${canary} reasons`]);
  made.push('curation assessment');
  // the manuscript with the owner's text, a citation and a figure reference
  const head = (await call('GET', `${P}/documents/${documentId}`)).json().head;
  const content = head.content_json as { type: string; content: unknown[] };
  const B = randomUUID();
  const text = `${canary} manuscript sentence ${inject} that is quite clear.`.replace(/\s+/g, ' ');
  content.content.push({ type: 'paragraph', attrs: { id: B }, content: [{ type: 'text', text }, { type: 'citation', attrs: { referenceId: ref.id, locator: null } }, { type: 'text', text: ' (' }, { type: 'figure_ref', attrs: { targetId: fig.id } }, { type: 'text', text: ').' }] });
  const saved = await ok('manuscript save', call('POST', `${P}/documents/${documentId}/saves`, { schema_version: 1, reason: 'manual', expected_head_revision_id: applied.revision_id, content_json: content }));
  const sel = async (quote: string) => {
    const doc = parseDocument(content, 1);
    let from = -1;
    doc.forEach((n) => { if (n.attrs.id === B) from = n.textBetween(0, n.content.size, '\n', '￼').indexOf(quote); });
    return snapshotSelection(doc, { blockId: B, from, to: from + quote.length });
  };
  await ok('comment thread', call('POST', `${P}/documents/${documentId}/comments`, { base_revision_id: saved.id, selection: await sel('quite clear'), body: `${canary} thread comment` }));
  const h = await ok('selection handle', call('POST', `${P}/documents/${documentId}/selection-handles`, { base_revision_id: saved.id, selection: await sel('quite clear') }));
  await createProposal(pool, { paperId: p.id, handleId: h.id, intent: 'concise', replacement: [{ type: 'text', text: `${canary} clear` }], explanation: `${canary} explanation`, origin: 'worker:audit' });
  made.push('edit proposal');
  await ok('scientific check', call('POST', `${P}/documents/${documentId}/scientific-checks`, { revision_id: saved.id, block_id: B }));
  const rc = await ok('review comment', call('POST', `${P}/review-comments`, { document_id: documentId, round: 'R1', reviewer: 'Reviewer 1', text: `${canary} reviewer comment` }));
  await ok('review response', call('POST', `${P}/review-comments/${rc.id}/responses`, { status: 'disagree', text: `${canary} response`, links: [] }));
  await ok('writing profile note', call('POST', `${P}/writing-profile/feedback`, { text: `${canary} profile note` }));
  await ok('text import', call('POST', `${P}/imports`, { format: 'markdown', filename: 'draft.md', text: `# ${canary}\n\nImported ${canary} text.` }));
  await ok('snapshot', call('POST', `${P}/snapshots`, { label: `${canary} snapshot` }));
  await ok('export', call('POST', `${P}/exports`, { document_id: documentId, format: 'docx' }));
  await ok('draft submission', call('POST', `${P}/submissions`, { intent: 'freeze_submission', document_id: documentId, expected_revision_id: saved.id, status: 'draft', label: `${canary} submission` }));
  // a review run with an open finding (made directly: a review job needs an AI provider)
  const job = (await pool.query(`INSERT INTO jobs (paper_id, owner_id, intent, idempotency_key, payload, payload_hash) VALUES ($1, $2, 'review', $3, '{}', $4) RETURNING id`, [p.id, owner, randomUUID(), 'a'.repeat(64)])).rows[0].id;
  const run = (await pool.query(`INSERT INTO review_runs (paper_id, job_id, document_id, revision_id, block_id, block_hash, generator, independence, input_hash) VALUES ($1, $2, $3, $4, $5, $6, 'mock', 'different_model', $6) RETURNING id`, [p.id, job, documentId, saved.id, B, 'b'.repeat(64)])).rows[0].id;
  await pool.query(`INSERT INTO review_findings (paper_id, run_id, position, kind, category, quote, span_start, span_end, reason, confidence) VALUES ($1, $2, 1, 'scientific', 'overclaim', $3, 0, 5, $4, 'high')`, [p.id, run, `${canary} quote`, `${canary} reason`]);
  made.push('review run');
  return { paperId: p.id, ownerId: owner, documentId, canary, made };
}
