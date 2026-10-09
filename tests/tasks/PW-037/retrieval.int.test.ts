// PW-037 — only the evidence a selected paragraph needs (spec 05, 08).
// TST-037A: only the source excerpts/locators related to the selected paragraph enter the context.
// TST-037B: other projects, removed material, sources that may not be sent, and outdated approved state
//   never leak through the cache.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createPaper } from '../../../packages/domain/src/papers/index.ts';
import { createReference, createFigure } from '../../../packages/domain/src/references/index.ts';
import { recordSourceAsset, decideAssetPolicy } from '../../../packages/domain/src/asset-policy/index.ts';
import { ingestCandidate } from '../../../packages/domain/src/literature/index.ts';
import { approveClaim, createClaim, createEvidence, createFactCandidates, linkClaimEvidence, reviewEvidence, reviewFact } from '../../../packages/domain/src/evidence/index.ts';
import { addFigureVersion, linkFigureEvidence, recordFigureFile } from '../../../packages/domain/src/figures/index.ts';
import { createDocument, saveRevision } from '../../../packages/domain/src/revisions/index.ts';
import { rankLexical, retrieveContext, terms } from '../../../packages/search/src/retrieval/index.ts';

let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
const ids: Record<string, string> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  for (const u of ['alice', 'bob']) ids[u] = (await createOwner(pool, { username: u, password: 'correct horse battery' })).id;
});
afterAll(async () => {
  await pool?.end();
  await db?.drop();
});

const hex = () => randomUUID().replace(/-/g, '').repeat(2);
// a verified literature excerpt of `ref`, tied to a confirmed PDF location whose document has `send` rights
async function excerpt(paperId: string, owner: string, refId: string, quote: string, send: 'allowed' | 'denied' | 'unknown') {
  const { asset } = await recordSourceAsset(pool, { paperId, ownerId: owner, sha256: hex(), byteSize: 100, pages: 1, originalName: 'src.pdf', source: 'user_upload', sourceUrl: null, referenceId: refId, policy: { license: 'cc-by', keep_right: 'user_supplied', external_send: send } });
  const x = (await pool.query("INSERT INTO pdf_extractions (paper_id, asset_revision_id, sha256, extractor, status, page_count) VALUES ($1, $2, $3, 'pdfjs-dist@6.4.299/pw-pdf-1', 'ok', 1) RETURNING id", [paperId, asset.id, asset.sha256])).rows[0].id;
  await pool.query("INSERT INTO pdf_pages (extraction_id, page_index, view_box, rotate, text, runs) VALUES ($1, 0, '{0,0,612,792}', 0, $2, '[]')", [x, quote]);
  const an = (await pool.query("INSERT INTO pdf_anchors (paper_id, asset_revision_id, sha256, extraction_id, extractor, page_index, start_offset, end_offset, exact, quadpoints, precision, created_by) VALUES ($1, $2, $3, $4, 'pdfjs-dist@6.4.299/pw-pdf-1', 0, 0, $5, $6, '[]', 'run_interpolated', $7) RETURNING id",
    [paperId, asset.id, asset.sha256, x, quote.length, quote, owner])).rows[0].id;
  const ev = await createEvidence(pool, { paperId, ownerId: owner, body: { kind: 'literature_excerpt', reference_id: refId, locator: { quote, anchor_id: an } } });
  await reviewEvidence(pool, { paperId, ownerId: owner, id: ev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: ev.content_hash } });
  return { evidence: ev, asset };
}

async function world(owner: string, opts: { title?: string } = {}) {
  const paperId = (await createPaper(pool, owner, { working_title: opts.title ?? 'retrieval paper', article_type: 'research_article' })).id;
  await pool.query("UPDATE paper_projects SET allowed_providers = '{claude_agent}' WHERE id = $1", [paperId]);
  const r1 = await createReference(pool, { paperId, ownerId: owner, body: { title: 'Drought signalling in roots', authors: [{ family: 'Kim' }] } });
  const r2 = await createReference(pool, { paperId, ownerId: owner, body: { title: 'Root transcriptome under drought', authors: [{ family: 'Lee' }] } });
  const r3 = await createReference(pool, { paperId, ownerId: owner, body: { title: 'Closed-access source', authors: [{ family: 'Park' }] } });
  const r4 = await createReference(pool, { paperId, ownerId: owner, body: { title: 'Leaf colour', authors: [{ family: 'Cho' }] } });
  const e1 = await excerpt(paperId, owner, r1.id, 'ABC1 transcripts accumulate in drought-stressed roots within six hours.', 'allowed');
  const e3 = await excerpt(paperId, owner, r3.id, 'ABC1 is a membrane transporter (closed source text).', 'denied');
  // not cited by the paragraph, but about the same thing: may come in as "lexical"
  const e2 = await excerpt(paperId, owner, r2.id, 'Drought-stressed roots show ABC1 transcripts accumulating strongly.', 'allowed');
  // unrelated, not cited
  const e4 = await excerpt(paperId, owner, r4.id, 'Tulip petals change colour in spring.', 'allowed');
  // figure 1 panel A with a verified fact, and an approved claim relying on it
  const fig = await createFigure(pool, { paperId, ownerId: owner, kind: 'figure', title: 'ABC1 induction' });
  const file = await recordFigureFile(pool, { paperId, ownerId: owner, sha256: hex(), byteSize: 10, media: 'image/png', name: 'f.png' });
  const v1 = await addFigureVersion(pool, { paperId, ownerId: owner, figureId: fig.id, body: { caption: 'ABC1.', panels: [{ panel: 'A', unit: 'fold', groups: ['WT', 'abc1'] }], asset_id: file.id } });
  const fev = await createEvidence(pool, { paperId, ownerId: owner, body: { kind: 'figure_panel', source_asset_revision_id: file.id, locator: { panel: 'A' }, label: 'Fig 1A' } });
  await reviewEvidence(pool, { paperId, ownerId: owner, id: fev.id, to: 'VERIFIED', body: { intent: 'verify_evidence', content_hash: fev.content_hash } });
  await linkFigureEvidence(pool, { paperId, ownerId: owner, evidenceId: fev.id, body: { figure_version_id: v1.version.id, panel: 'A' } });
  const [fact] = await createFactCandidates(pool, { paperId, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: fev.id, entity: 'ABC1', metric: 'fold change', value_text: '2.4', unit: 'fold', group: 'abc1 vs WT', comparison: 'WT', n: 3, extraction_method: 'figure_reading' }] });
  await reviewFact(pool, { paperId, ownerId: owner, id: fact!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: fact!.content_hash } });
  const claim = await createClaim(pool, { paperId, ownerId: owner, body: { kind: 'observation', text: 'ABC1 is induced 2.4-fold by drought.' } });
  await linkClaimEvidence(pool, { paperId, ownerId: owner, claimId: claim.id, body: { evidence_id: fev.id, relation: 'supports' } });
  await approveClaim(pool, { paperId, ownerId: owner, id: claim.id, body: { intent: 'approve_claim', content_hash: claim.content_hash } });
  // an unverified fact on the same panel never enters
  await createFactCandidates(pool, { paperId, ownerId: owner, origin: 'user', single: true, facts: [{ evidence_id: fev.id, entity: 'ABC1', metric: 'fold change', value_text: '9.9', unit: 'fold', group: 'abc1 vs WT', comparison: 'WT', n: 3, extraction_method: 'figure_reading' }] });
  // the manuscript: P1 cites r1 and r3 and mentions Figure 1; P2 is about something else
  const { document, head } = await createDocument(pool, paperId, owner, 'manuscript');
  const documentId = (document as unknown as { id: string }).id;
  const [p1, p2] = [randomUUID(), randomUUID()];
  await saveRevision(pool, { paperId, documentId, ownerId: owner, expectedHead: head.id, schemaVersion: 1, reason: 'manual', content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: p1 }, content: [{ type: 'text', text: 'In drought-stressed roots ABC1 transcripts accumulate ' }, { type: 'citation', attrs: { referenceId: r1.id, locator: null } }, { type: 'text', text: ' and the transporter ' }, { type: 'citation', attrs: { referenceId: r3.id, locator: null } }, { type: 'text', text: ' is induced (' }, { type: 'figure_ref', attrs: { targetId: fig.id } }, { type: 'text', text: ').' }] },
    { type: 'paragraph', attrs: { id: p2 }, content: [{ type: 'text', text: 'Methods were standard.' }] },
  ] } });
  return { paperId, owner, documentId, p1, p2, r1, r2, r3, r4, e1, e2, e3, e4, fig, file, v1, fev, fact: fact!, claim };
}
const ctx = (w: { paperId: string; documentId: string }, blockId: string, provider = 'claude_agent', extra: Partial<Parameters<typeof retrieveContext>[1]> = {}) =>
  retrieveContext(pool, { paperId: w.paperId, documentId: w.documentId, blockId, provider, ...extra });

describe('TST-037A: only what the selected paragraph relates to enters the context', () => {
  test('cited excerpts (with locator), facts of mentioned figures and the claims on them; related-by-words marked; nothing unrelated', async () => {
    const w = await world(ids.alice!);
    const c = await ctx(w, w.p1);
    expect(c.paragraph.text).toContain('In drought-stressed roots');
    const byId = new Map(c.items.map((i) => [i.id, i]));
    expect(byId.get(w.e1.evidence.id)).toMatchObject({ kind: 'excerpt', via: 'citation', text: 'ABC1 transcripts accumulate in drought-stressed roots within six hours.', locator: { reference_id: w.r1.id, page_index: 0, sha256: w.e1.asset.sha256 } });
    expect(byId.get(w.fact.id)).toMatchObject({ kind: 'fact', via: 'figure_ref', text: 'ABC1 · fold change = 2.4 fold; group: abc1 vs WT; compared with: WT; n=3', locator: { figure_id: w.fig.id, panel: 'A', version_no: 1 } });
    expect(byId.get(w.claim.id)).toMatchObject({ kind: 'claim', via: 'claim' });
    expect(byId.get(w.e2.evidence.id)).toMatchObject({ via: 'lexical' });
    expect(byId.has(w.e4.evidence.id)).toBe(false);
    expect(c.items.some((i) => i.text.includes('9.9'))).toBe(false);
    // a paragraph without links or shared words gets nothing
    const other = await ctx(w, w.p2);
    expect(other.items).toEqual([]);
    expect(other.withheld).toEqual([]);
  });

  test('lexical ranking: distinctive shared words, at least two, same pool only', () => {
    expect([...terms('The ABC1 transcripts were induced in roots.')]).toEqual(['abc1', 'transcripts', 'induced', 'roots']);
    const r = rankLexical('ABC1 transcripts in roots', [{ id: 'a', text: 'ABC1 transcripts accumulate in roots' }, { id: 'b', text: 'ABC1 only' }, { id: 'c', text: 'tulips' }]);
    expect(r.map((x) => x.id)).toEqual(['a']);
  });

  test('an unverified excerpt of a cited reference does not enter', async () => {
    const w = await world(ids.alice!);
    const ev = await createEvidence(pool, { paperId: w.paperId, ownerId: w.owner, body: { kind: 'literature_excerpt', reference_id: w.r1.id, locator: { quote: 'Unchecked ABC1 transcripts drought roots claim.' } } });
    const c = await ctx(w, w.p1);
    expect([...c.items, ...c.withheld].some((i) => i.id === ev.id)).toBe(false);
  });

  test('limits keep whole items in a fixed order and say when something was left out', async () => {
    const w = await world(ids.alice!);
    const c = await ctx(w, w.p1, 'claude_agent', { maxItems: 1 });
    expect(c.items).toHaveLength(1);
    expect(c.items[0]!.via).toBe('citation');
    expect(c.truncated).toBe(true);
  });
});

describe('TST-037B: nothing leaks through scope, permissions or the cache', () => {
  test('a source that may not be sent is withheld with the reason (its text is not in the context)', async () => {
    const w = await world(ids.alice!);
    const c = await ctx(w, w.p1);
    expect(c.withheld).toEqual(expect.arrayContaining([{ kind: 'excerpt', id: w.e3.evidence.id, via: 'citation', reason: 'asset_send_denied' }]));
    expect(JSON.stringify(c.items)).not.toContain('closed source text');
  });

  test('a provider the paper does not allow gets nothing; another paper\'s document or paragraph is not found', async () => {
    const w = await world(ids.alice!);
    await expect(ctx(w, w.p1, 'codex')).rejects.toThrow(/does not allow/);
    const b = await world(ids.bob!, { title: 'bob paper' });
    await expect(retrieveContext(pool, { paperId: w.paperId, documentId: b.documentId, blockId: b.p1, provider: 'claude_agent' })).rejects.toThrow(/not found/);
    await expect(ctx(w, b.p1)).rejects.toThrow(/not found/);
    // bob's matching material never appears in alice's context
    const c = await ctx(w, w.p1);
    const bobIds = [b.e1.evidence.id, b.e2.evidence.id, b.fact.id, b.claim.id];
    expect(c.items.some((i) => bobIds.includes(i.id))).toBe(false);
  });

  test('records: an identical context is recognised while every input is unchanged: a withdrawn permission, a removed reference, a retracted record or a new figure version are never served from it', async () => {
    const w = await world(ids.alice!);
    const first = await ctx(w, w.p1);
    expect(first.recorded_before).toBe(false);
    const again = await ctx(w, w.p1);
    expect(again).toMatchObject({ recorded_before: true, fingerprint: first.fingerprint });
    expect(again.items).toEqual(first.items);
    // the source's send permission is withdrawn
    await decideAssetPolicy(pool, { paperId: w.paperId, ownerId: w.owner, assetId: w.e1.asset.id, body: { external_send: 'denied' } });
    const afterPolicy = await ctx(w, w.p1);
    expect(afterPolicy.recorded_before).toBe(false);
    expect(afterPolicy.items.some((i) => i.id === w.e1.evidence.id)).toBe(false);
    expect(afterPolicy.withheld.some((x) => x.id === w.e1.evidence.id)).toBe(true);
    // a reference is removed from the paper
    await pool.query('UPDATE project_references SET removed_at = clock_timestamp() WHERE paper_id = $1 AND reference_id = $2', [w.paperId, w.r2.id]);
    const afterRemove = await ctx(w, w.p1);
    expect(afterRemove.recorded_before).toBe(false);
    expect([...afterRemove.items, ...afterRemove.withheld].some((i) => i.id === w.e2.evidence.id)).toBe(false);
    // the approved claim is retracted
    await pool.query("UPDATE claims SET approval_state = 'RETRACTED', closed_at = clock_timestamp() WHERE id = $1", [w.claim.id]);
    const afterRetract = await ctx(w, w.p1);
    expect(afterRetract.recorded_before).toBe(false);
    expect(afterRetract.items.some((i) => i.id === w.claim.id)).toBe(false);
    // a new figure version: the fact read from the older version is withheld, not served from the cache
    await addFigureVersion(pool, { paperId: w.paperId, ownerId: w.owner, figureId: w.fig.id, body: { caption: 'ABC1.', panels: [{ panel: 'A', unit: 'log2 fold', groups: ['WT', 'abc1'] }], asset_id: w.file.id } });
    const afterVersion = await ctx(w, w.p1);
    expect(afterVersion.recorded_before).toBe(false);
    expect(afterVersion.withheld).toEqual(expect.arrayContaining([expect.objectContaining({ id: w.fact.id, reason: 'read_from_older_figure_version' })]));
    // cached rows are immutable records
    await expect(pool.query("UPDATE retrieval_cache SET context = '{}'")).rejects.toThrow(/immutable/);
  });

  test('a changed paragraph (new document revision) is a new context', async () => {
    const w = await world(ids.alice!);
    const a = await ctx(w, w.p1);
    const head = (await pool.query('SELECT head_revision_id FROM documents WHERE id = $1', [w.documentId])).rows[0].head_revision_id;
    await saveRevision(pool, { paperId: w.paperId, documentId: w.documentId, ownerId: w.owner, expectedHead: head, schemaVersion: 1, reason: 'manual', content: { type: 'doc', content: [
      { type: 'paragraph', attrs: { id: w.p1 }, content: [{ type: 'text', text: 'Rewritten without citations.' }] },
    ] } });
    const b = await ctx(w, w.p1);
    expect(b.recorded_before).toBe(false);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(b.items.filter((i) => i.via !== 'lexical')).toEqual([]);
  });
});

// review (PW-037)
describe('review fixes', () => {
  test('MAJOR: a fact read from a source that may not be sent, or whose reference was removed, does not enter (not even by words)', async () => {
    const w = await world(ids.alice!);
    // a verified fact recorded on the excerpt of the send-denied source r3
    const [f3] = await createFactCandidates(pool, { paperId: w.paperId, ownerId: w.owner, origin: 'user', single: true, facts: [{ evidence_id: w.e3.evidence.id, entity: 'ABC1 transcripts drought roots transporter', metric: 'density', value_text: '7.7', unit: 'per um2', group: 'roots', comparison: 'leaves', n: 4, extraction_method: 'manual_entry' }] });
    await reviewFact(pool, { paperId: w.paperId, ownerId: w.owner, id: f3!.id, to: 'VERIFIED', body: { intent: 'verify_fact', content_hash: f3!.content_hash } });
    let c = await ctx(w, w.p1);
    expect(c.items.some((i) => i.id === f3!.id)).toBe(false);
    expect(c.withheld).toEqual(expect.arrayContaining([expect.objectContaining({ id: f3!.id, reason: 'asset_send_denied' })]));
    // the reference is removed: the fact is gone entirely
    await pool.query('UPDATE project_references SET removed_at = clock_timestamp() WHERE paper_id = $1 AND reference_id = $2', [w.paperId, w.r3.id]);
    c = await ctx(w, w.p1);
    expect([...c.items, ...c.withheld].some((i) => i.id === f3!.id)).toBe(false);
    expect(JSON.stringify(c.items)).not.toContain('7.7');
  });

  test('MINOR 1: a sensitive paper sends nothing', async () => {
    const w = await world(ids.alice!);
    await pool.query("UPDATE paper_projects SET data_classification = 'sensitive' WHERE id = $1", [w.paperId]);
    await expect(ctx(w, w.p1)).rejects.toThrow(/sensitive/);
  });

  test('MINOR 2: an excerpt (and a claim on it) from a work the library knows as retracted is withheld', async () => {
    const w = await world(ids.alice!);
    // r1 gets a DOI and a retraction notice about that DOI enters the owner's library
    await pool.query("INSERT INTO reference_identifiers (owner_id, reference_id, kind, value) VALUES ($1, $2, 'doi', '10.5555/r1.retracted')", [w.owner, w.r1.id]);
    const s = (await pool.query("INSERT INTO literature_searches (paper_id, created_by, source, query, params, cache_key, endpoint, status) VALUES ($1, $2, 'crossref', 'q', '{}', repeat('c', 64), 'https://x', 'ok') RETURNING id", [w.paperId, w.owner])).rows[0].id;
    const cand = (await pool.query(`INSERT INTO literature_candidates (search_id, paper_id, source, rank, source_record_id, doi, title, authors, year, container, work_type, is_preprint, relations, update_notice)
      VALUES ($1, $2, 'crossref', 1, '10.5555/notice.r1', '10.5555/notice.r1', 'Retraction: r1', '[]', 2024, 'J', 'journal-article', false, '{}', '{"type":"retraction","target_doi":"10.5555/r1.retracted"}') RETURNING id`, [s, w.paperId])).rows[0].id;
    await ingestCandidate(pool, { ownerId: w.owner, candidateId: cand });
    const claim = await createClaim(pool, { paperId: w.paperId, ownerId: w.owner, body: { kind: 'background', text: 'ABC1 transcripts accumulate in drought-stressed roots.' } });
    await linkClaimEvidence(pool, { paperId: w.paperId, ownerId: w.owner, claimId: claim.id, body: { evidence_id: w.e1.evidence.id, relation: 'supports' } });
    await approveClaim(pool, { paperId: w.paperId, ownerId: w.owner, id: claim.id, body: { intent: 'approve_claim', content_hash: claim.content_hash } });
    const c = await ctx(w, w.p1);
    expect(c.withheld).toEqual(expect.arrayContaining([expect.objectContaining({ id: w.e1.evidence.id, reason: 'source_retracted' })]));
    expect(c.items.some((i) => i.id === w.e1.evidence.id || i.id === claim.id)).toBe(false);
  });

  test('MINOR 3: the context is always computed now — a stored record is never served instead; records are pruned', async () => {
    const w = await world(ids.alice!);
    const a = await ctx(w, w.p1);
    // tamper with the stored record (as if an older rule had produced it): the next call is still fresh
    await pool.query('DELETE FROM retrieval_cache WHERE fingerprint = $1', [a.fingerprint]);
    await pool.query("INSERT INTO retrieval_cache (paper_id, document_id, block_id, provider, fingerprint, context) VALUES ($1, $2, $3, 'claude_agent', $4, $5)",
      [w.paperId, w.documentId, w.p1, a.fingerprint, JSON.stringify({ paragraph: { block_id: w.p1, text: 'stale' }, items: [{ kind: 'fact', id: 'x', text: 'LEAKED 99', via: 'lexical', locator: {} }], withheld: [], truncated: false })]);
    const b = await ctx(w, w.p1);
    expect(b.recorded_before).toBe(true);
    expect(JSON.stringify(b)).not.toContain('LEAKED');
    expect(b.items).toEqual(a.items);
    await expect(pool.query("UPDATE retrieval_cache SET context = '{}'")).rejects.toThrow(/immutable/);
    // pruning: at most 20 records per paragraph and provider
    for (let i = 0; i < 22; i++) await ctx(w, w.p1, 'claude_agent', { maxItems: 100 + i });
    expect((await pool.query('SELECT count(*)::int AS n FROM retrieval_cache WHERE paper_id = $1 AND block_id = $2', [w.paperId, w.p1])).rows[0].n).toBe(20);
  });
});
