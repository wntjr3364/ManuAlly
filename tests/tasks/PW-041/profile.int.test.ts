// PW-041 — WritingProfile from sections actually read (spec 06 "WritingProfile").
// TST-041A: a proposed profile carries, for every rule, the reference and section it was drawn from,
//   with counterexamples; it stays a DRAFT until the owner approves the exact version; an approved
//   profile is superseded only by another approval.
// TST-041B: no section style is drawn from text that was not read (an abstract-only source gives no
//   Discussion rules), and no rule or example that copies a run of words from a source is stored.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createTempDatabase } from '../../../packages/config/src/test-db.ts';
import { migrate } from '../../../apps/api/src/db/migrate.ts';
import { buildServer } from '../../../apps/api/src/server.ts';
import { createOwner } from '../../../apps/api/src/auth/owners.ts';
import { createReference } from '../../../packages/domain/src/references/index.ts';
import { processDelivery } from '../../../apps/worker/src/queue/index.ts';
import { profileHandlers, createMockProfileGenerator, type ProfileGenerator, type ProfileInput } from '../../../apps/worker/src/writing-profile/index.ts';

const ORIGIN = 'http://127.0.0.1:5173';
let db: { url: string; drop: () => Promise<void> };
let pool: pg.Pool;
let app: FastifyInstance;
const H: Record<string, Record<string, string>> = {};
const ids: Record<string, string> = {};
beforeAll(async () => {
  db = await createTempDatabase();
  pool = new pg.Pool({ connectionString: db.url, max: 8 });
  const c = await pool.connect();
  await migrate(c, path.resolve('db/migrations'));
  c.release();
  app = buildServer({ pool, allowedOrigins: [ORIGIN] });
  await app.ready();
  for (const u of ['alice', 'bob']) {
    ids[u] = (await createOwner(pool, { username: u, password: 'correct horse battery' })).id;
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: 'correct horse battery' } });
    H[u] = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-pw-csrf': r.json().csrfToken, origin: ORIGIN };
  }
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await db?.drop();
});

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, headers: H[who], payload: payload as object | undefined });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DISCUSSION = 'Discussion\nOur results extend earlier reports by showing that the response is confined to roots. We first restate the main finding, then compare it with prior work, then name the limits of a single genotype.';
const INTRO = 'Introduction\nDrought limits crop yield worldwide. Root signalling is poorly understood. Here we ask whether ABC1 responds to drought.';

// a reference whose source PDF was parsed into pages (synthetic text); the text decides which sections were read
async function sourceWithText(paperId: string, owner: string, title: string, pages: string[], policy: { keep: string; send: string } = { keep: 'user_supplied', send: 'allowed' }) {
  const ref = await createReference(pool, { paperId, ownerId: owner, body: { title, authors: [{ family: 'Kim' }], year: 2020 } });
  const asset = (await pool.query("INSERT INTO asset_revisions (paper_id, asset_key, sha256, byte_size, media_type, original_name, created_by) VALUES ($1, $2, $3, 100, 'application/pdf', 'x.pdf', $4) RETURNING id",
    [paperId, `source-${randomUUID()}`, sha(title), owner])).rows[0].id;
  await pool.query("INSERT INTO asset_sources (asset_revision_id, paper_id, owner_id, kind, source, reference_id, page_count, inspected_with) VALUES ($1, $2, $3, 'source_pdf', 'user_upload', $4, $5, 'test')", [asset, paperId, owner, ref.id, pages.length]);
  await pool.query("INSERT INTO asset_policy_revisions (asset_revision_id, paper_id, license, keep_right, external_send, decided_by) VALUES ($1, $2, 'unknown', $3, $4, $5)", [asset, paperId, policy.keep, policy.send, owner]);
  const ex = (await pool.query("INSERT INTO pdf_extractions (paper_id, asset_revision_id, sha256, extractor, status, page_count) VALUES ($1, $2, $3, 'pdfjs-test', 'ok', $4) RETURNING id", [paperId, asset, sha(title), pages.length])).rows[0].id;
  for (const [i, t] of pages.entries()) await pool.query("INSERT INTO pdf_pages (extraction_id, page_index, view_box, rotate, text, runs) VALUES ($1, $2, '{0,0,612,792}', 0, $3, '[]')", [ex, i, t]);
  return ref;
}
async function world(who = 'alice') {
  const owner = ids[who]!;
  const paperId = (await call(who, 'POST', '/api/papers', { working_title: 'profile paper', article_type: 'research_article' })).json().id as string;
  const full = await sourceWithText(paperId, owner, 'Fully read paper', [INTRO, DISCUSSION]);
  const abstractOnly = await sourceWithText(paperId, owner, 'Abstract only paper', ['Abstract\nWe show that ABC1 responds to drought in roots.']);
  const unread = await createReference(pool, { paperId, ownerId: owner, body: { title: 'Metadata only', authors: [{ family: 'Lee' }], year: 2021 } });
  return { paperId, owner, full, abstractOnly, unread };
}
type W = Awaited<ReturnType<typeof world>>;
const spy = (answer: (input: ProfileInput) => unknown): ProfileGenerator & { seen: ProfileInput[] } => {
  const seen: ProfileInput[] = [];
  return { id: 'mock', label: 'MOCK', seen, async propose(input) { seen.push(input); return answer(input); } };
};
async function run(w: W, gen: ProfileGenerator = createMockProfileGenerator(), refs = [w.full.id, w.abstractOnly.id, w.unread.id]) {
  const r = await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/runs`, { reference_ids: refs, idempotency_key: randomUUID() });
  expect(r.statusCode).toBe(201);
  return deliver(w, r.json().job.id as string, gen);
}
async function deliver(w: W, jobId: string, gen: ProfileGenerator) {
  await processDelivery(pool, { job_id: jobId, paper_id: w.paperId, intent: 'propose_profile' }, { workerId: 'w1', leaseMs: 60_000, handlers: profileHandlers(pool, gen) });
  return { jobId, view: (await call('alice', 'GET', `/api/papers/${w.paperId}/writing-profile`)).json() };
}
const base = (o: Record<string, unknown> = {}) => ({
  article_type: 'research_article', target_audience: 'plant biologists', preferred_english_variant: 'US', concision_preference: 'concise',
  claim_strength_policy: 'State observations plainly; mark interpretation as such.', terminology: [], section_roles: [], rhetoric_patterns: [], anti_examples: [], accepted_examples: [], ...o,
});

describe('TST-041A: rules with their sources, counterexamples and an approval state', () => {
  test('the generator sees which sections of each source were read; a run gives a DRAFT whose every rule names its reference and section', async () => {
    const w = await world();
    const g = spy((input) => ({ profile: base({ section_roles: [{ section: 'Discussion', role: 'compare and bound the finding', principles: [{ text: 'Open with the main finding before comparing with earlier work', sources: [{ reference_id: input.sources.find((s) => s.title === 'Fully read paper')!.reference_id, section: 'Discussion' }] }], counterexamples: [{ text: 'Repeating every result in order before any interpretation', sources: [{ reference_id: input.sources.find((s) => s.title === 'Fully read paper')!.reference_id, section: 'Discussion' }] }] }] }) }));
    const { view } = await run(w, g);
    expect(g.seen[0]!.sources.map((s) => [s.title, s.read_depth, s.sections_read])).toEqual([
      ['Fully read paper', 'FULLTEXT_PARSED', ['Introduction', 'Discussion']],
      ['Abstract only paper', 'ABSTRACT_ONLY', ['Abstract']],
      ['Metadata only', 'METADATA_ONLY', []],
    ]);
    const rev = view.latest;
    expect(rev).toMatchObject({ status: 'DRAFT' });
    const role = rev.content.section_roles[0];
    expect(role.principles[0].sources).toEqual([{ reference_id: w.full.id, section: 'Discussion' }]);
    expect(role.counterexamples).toHaveLength(1);
    expect(rev.sources.map((s: { reference_id: string }) => s.reference_id).sort()).toEqual([w.full.id, w.abstractOnly.id, w.unread.id].sort());
    expect(view.active).toBeNull();
  });

  test('approving needs the intent and the exact version; a later approval supersedes the earlier one; the user can add a journal rule snapshot', async () => {
    const w = await world();
    const { view } = await run(w);
    const rev = view.latest;
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/revisions/${rev.id}/approve`, { content_hash: rev.content_hash })).statusCode).toBe(422);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/revisions/${rev.id}/approve`, { intent: 'approve_profile', content_hash: 'f'.repeat(64) })).statusCode).toBe(409);
    expect((await call('bob', 'POST', `/api/papers/${w.paperId}/writing-profile/revisions/${rev.id}/approve`, { intent: 'approve_profile', content_hash: rev.content_hash })).statusCode).toBe(404);
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/revisions/${rev.id}/approve`, { intent: 'approve_profile', content_hash: rev.content_hash })).json()).toMatchObject({ status: 'APPROVED' });
    // the user edits: a new DRAFT based on the approved one, with a journal rule snapshot (source and date)
    const edited = await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/revisions`, { parent_revision_id: rev.id, content: { ...rev.content, journal_rule_snapshot: { text: 'Abstract at most 200 words.', source: 'https://journal.example/guide', checked_at: '2026-10-01', article_types: ['research_article'] } } });
    expect(edited.statusCode).toBe(201);
    const v = (await call('alice', 'GET', `/api/papers/${w.paperId}/writing-profile`)).json();
    expect(v.active.id).toBe(rev.id); // the draft does not replace the approved profile
    await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/revisions/${edited.json().id}/approve`, { intent: 'approve_profile', content_hash: edited.json().content_hash });
    const v2 = (await call('alice', 'GET', `/api/papers/${w.paperId}/writing-profile`)).json();
    expect(v2.active.id).toBe(edited.json().id);
    expect(v2.revisions.find((r: { id: string }) => r.id === rev.id).status).toBe('SUPERSEDED');
    await expect(pool.query("UPDATE writing_profile_revisions SET content = '{}' WHERE id = $1", [rev.id])).rejects.toThrow(/immutable/);
    // a new proposal keeps the owner's journal rule as it was; the generator never saw it
    const g = spy(() => ({ profile: base() }));
    const next = (await run(w, g)).view.latest;
    expect(next.content.journal_rule_snapshot).toEqual({ text: 'Abstract at most 200 words.', source: 'https://journal.example/guide', checked_at: '2026-10-01', article_types: ['research_article'] });
    expect(JSON.stringify(g.seen[0])).not.toContain('Abstract at most 200 words.');
    expect(next.parent_revision_id).toBe(edited.json().id);
  });

  test('a user\'s feedback is kept as a candidate for the next proposal; it never changes the profile by itself', async () => {
    const w = await world();
    const { view } = await run(w);
    await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/revisions/${view.latest.id}/approve`, { intent: 'approve_profile', content_hash: view.latest.content_hash });
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/feedback`, { text: 'Prefer shorter Results paragraphs.' })).statusCode).toBe(201);
    const v = (await call('alice', 'GET', `/api/papers/${w.paperId}/writing-profile`)).json();
    expect(v.active.content_hash).toBe(view.latest.content_hash);
    expect(v.feedback).toEqual([expect.objectContaining({ text: 'Prefer shorter Results paragraphs.', status: 'candidate' })]);
    const g = spy(() => ({ profile: base() }));
    await run(w, g);
    expect(g.seen[0]!.feedback).toEqual(['Prefer shorter Results paragraphs.']);
  });
});

describe('TST-041B: no style from unread text; no copied wording', () => {
  test('rules for a section that was not read are removed with the reason (abstract-only gives no Discussion style)', async () => {
    const w = await world();
    const { view } = await run(w, spy((input) => {
      const ref = (t: string) => input.sources.find((s) => s.title === t)!.reference_id;
      return { profile: base({
        section_roles: [
          { section: 'Discussion', role: 'interpret', principles: [
            { text: 'Name the limits of the evidence before suggesting mechanisms', sources: [{ reference_id: ref('Abstract only paper'), section: 'Discussion' }] },
            { text: 'Compare with prior work after stating the finding', sources: [{ reference_id: ref('Fully read paper'), section: 'Discussion' }] },
            { text: 'Keep Discussion short', sources: [{ reference_id: ref('Metadata only'), section: 'Discussion' }] },
            { text: 'Discussion rule claimed from the abstract', sources: [{ reference_id: ref('Abstract only paper'), section: 'Abstract' }] },
            { text: 'A rule with no source at all', sources: [] },
          ], counterexamples: [] },
        ],
      }) };
    }));
    const kept = view.latest.content.section_roles[0].principles.map((p: { text: string }) => p.text);
    expect(kept).toEqual(['Compare with prior work after stating the finding']);
    expect(view.latest.removed.map((r: { text: string; reason: string }) => [r.text, r.reason])).toEqual([
      ['Name the limits of the evidence before suggesting mechanisms', 'section_not_read'],
      ['Keep Discussion short', 'section_not_read'],
      ['Discussion rule claimed from the abstract', 'source_section_is_not_the_role_section'],
      ['A rule with no source at all', 'no_source'],
    ]);
  });

  test('a rule, pattern or example that copies a run of words from a source is not stored', async () => {
    const w = await world();
    const { view } = await run(w, spy((input) => {
      const src = [{ reference_id: input.sources.find((s) => s.title === 'Fully read paper')!.reference_id, section: 'Discussion' }];
      return { profile: base({
        section_roles: [{ section: 'Discussion', role: 'interpret', principles: [
          { text: 'We first restate the main finding, then compare it with prior work, then name the limits', sources: src },
          { text: 'State the finding, then compare, then bound it', sources: src },
        ], counterexamples: [] }],
        rhetoric_patterns: [{ text: 'Our results extend earlier reports by showing that the response is confined to roots', sources: src }],
        accepted_examples: [{ text: 'Our results extend earlier reports by showing that the response is confined to roots.', source: src[0] }],
      }) };
    }));
    const c = view.latest.content;
    expect(c.section_roles[0].principles.map((p: { text: string }) => p.text)).toEqual(['State the finding, then compare, then bound it']);
    expect(c.rhetoric_patterns).toEqual([]);
    expect(c.accepted_examples).toEqual([]);
    expect(view.latest.removed.filter((r: { reason: string }) => r.reason === 'copied_from_source')).toHaveLength(3);
  });

  test('the answer cannot set the journal rule, extra fields or sources outside the request; references must be this paper\'s', async () => {
    const w = await world();
    for (const bad of [
      { profile: base({ journal_rule_snapshot: { text: 'x', source: 'y', checked_at: '2026-01-01', article_types: [] } }) },
      { profile: base(), approved: true },
      { profile: { ...base(), extra: 1 } },
      { profile: base({ section_roles: [{ section: 'Discussion', role: 'r', principles: [{ text: 'x y z', sources: [{ reference_id: randomUUID(), section: 'Discussion' }] }], counterexamples: [] }] }) },
    ]) {
      const { view, jobId } = await run(w, spy(() => bad));
      expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [jobId])).rows[0].status).toBe('FAILED');
      expect(view.latest).toBeNull();
    }
    const other = await world('bob');
    expect((await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/runs`, { reference_ids: [other.full.id], idempotency_key: randomUUID() })).statusCode).toBe(404);
  });
  test('only text the system may use is read: an original kept on an unknown basis, or one a real provider may not receive, gives no sections', async () => {
    const w = await world();
    const unknownKeep = await sourceWithText(w.paperId, w.owner, 'Kept on unknown basis', [DISCUSSION], { keep: 'unknown', send: 'allowed' });
    const noSend = await sourceWithText(w.paperId, w.owner, 'Not for external AI', ['Discussion\nThe withheld mutant phenotype was strictly temperature dependent in every line we tested.'], { keep: 'user_supplied', send: 'denied' });
    const g = spy(() => ({ profile: base() }));
    await run(w, g, [w.full.id, unknownKeep.id, noSend.id]);
    expect(g.seen[0]!.sources.map((s) => [s.title, s.read_depth, s.sections_read, s.withheld])).toEqual([
      ['Fully read paper', 'FULLTEXT_PARSED', ['Introduction', 'Discussion'], null],
      ['Kept on unknown basis', 'METADATA_ONLY', [], 'asset_keep_right_unknown'],
      // the MOCK generator runs here; it may read what the owner keeps even if it may not be sent out
      ['Not for external AI', 'FULLTEXT_PARSED', ['Discussion'], null],
    ]);
    expect(g.seen[0]!.sources[0]!.sections.map((x) => x.section)).toEqual(['Introduction', 'Discussion']);
    // a real provider: the paper must allow it, and each original must be sendable; otherwise it is not read
    const real = (answer: () => unknown) => ({ ...spy(answer), id: 'claude_agent' as const, label: 'Claude' });
    const blocked = real(() => ({ profile: base() }));
    const r1 = await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/runs`, { reference_ids: [w.full.id, noSend.id], idempotency_key: randomUUID() });
    await deliver(w, r1.json().job.id, blocked);
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [r1.json().job.id])).rows[0].status).toBe('WAITING_USER');
    expect(blocked.seen).toHaveLength(0);
    await pool.query("UPDATE paper_projects SET allowed_providers = '{claude_agent}' WHERE id = $1", [w.paperId]);
    const allowed = real(() => ({ profile: base() }));
    const r2 = await call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/runs`, { reference_ids: [w.full.id, noSend.id], idempotency_key: randomUUID() });
    await deliver(w, r2.json().job.id, allowed);
    expect(allowed.seen[0]!.sources.map((s) => [s.title, s.read_depth, s.withheld])).toEqual([
      ['Fully read paper', 'FULLTEXT_PARSED', null],
      ['Not for external AI', 'METADATA_ONLY', 'asset_send_denied'],
    ]);
    expect(JSON.stringify(allowed.seen[0])).not.toContain('temperature dependent');
    expect(JSON.stringify(allowed.seen[0])).toContain('confined to roots');
  });

  test('the owner\'s own edit: based on the latest version, sources only from sections that were read, and no copied wording', async () => {
    const w = await world();
    const { view } = await run(w);
    const rev = view.latest;
    const post = (content: unknown, parent: unknown = rev.id) => call('alice', 'POST', `/api/papers/${w.paperId}/writing-profile/revisions`, { parent_revision_id: parent, content });
    const role = (principle: unknown) => ({ ...rev.content, section_roles: [{ section: 'Discussion', role: 'interpret', principles: [principle], counterexamples: [] }] });
    // the owner's preference needs no source
    expect((await post(role({ text: 'Lead with what the result means for the field', sources: [] }))).statusCode).toBe(201);
    const latest = (await call('alice', 'GET', `/api/papers/${w.paperId}/writing-profile`)).json().latest;
    expect((await post(role({ text: 'Another rule', sources: [] }), rev.id)).statusCode).toBe(409); // not the latest version
    expect((await post(role({ text: 'A rule', sources: [{ reference_id: w.abstractOnly.id, section: 'Discussion' }] }), latest.id)).json()).toMatchObject({ field: 'content' });
    expect((await post(role({ text: 'A rule', sources: [{ reference_id: w.abstractOnly.id, section: 'Discussion' }] }), latest.id)).statusCode).toBe(422);
    expect((await post({ ...rev.content, accepted_examples: [{ text: 'Our results extend earlier reports by showing that the response is confined to roots.', source: null }] }, latest.id)).statusCode).toBe(422);
    expect((await post({ ...rev.content, journal_rule_snapshot: { text: 'x' } }, latest.id)).statusCode).toBe(422);
    expect((await post({ ...rev.content, extra: 1 }, latest.id)).statusCode).toBe(422);
  });
});
