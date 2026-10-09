// WritingProfile (PW-041, spec 06 "WritingProfile"): how this paper should be written — audience,
// English variant, terminology, the role of each section with its principles and counterexamples,
// rhetoric patterns, examples — drawn from the writing references whose sections were actually read.
// - "Read" means the section's text was given to the generator: the source PDF of the reference was
//   parsed, its text may be used (the basis for keeping it is known) and, for an external AI, the
//   original may be sent and the paper allows that provider. Anything else is METADATA_ONLY.
// - Every proposed rule names the reference and section it was drawn from. A rule from a section that
//   was not read, from a section other than the one it describes, or with no source is removed and the
//   removal kept with its reason; a rule or example that copies a run of words from a source is removed
//   (copied_from_source). The generator cannot set the journal rule snapshot — that is the owner's
//   statement (with source and date) and carries over to new proposals.
// - Every version is immutable. Approving one (the owner's act, on the exact content hash) makes it the
//   paper's profile and supersedes the previous one. The owner's feedback is a candidate for the next
//   proposal; it never changes a profile by itself.
import { DomainError, UUID_RE, inTransaction, type Queryable, type TxPool } from '../shared/db.ts';
import { enqueueJob } from '../jobs/index.ts';
import { contentHash } from '../revisions/index.ts';
import { externalSendDecision, getSourceAsset } from '../asset-policy/index.ts';

// ---- sections of a parsed source ------------------------------------------------------------------
export const SECTIONS = ['Abstract', 'Introduction', 'Methods', 'Results', 'Results and Discussion', 'Discussion', 'Conclusion'] as const;
export type SectionName = (typeof SECTIONS)[number];
const HEADINGS: [RegExp, SectionName][] = [
  [/^(abstract|summary)$/, 'Abstract'],
  [/^(introduction|background)$/, 'Introduction'],
  [/^(materials? (and|&) methods|methods|experimental procedures|methods and materials)$/, 'Methods'],
  [/^(results (and|&) discussion)$/, 'Results and Discussion'],
  [/^results$/, 'Results'],
  [/^discussion$/, 'Discussion'],
  [/^(conclusions?|concluding remarks)$/, 'Conclusion'],
];
// A heading is a line of its own, optionally numbered ("2.", "2.1", "IV."), optionally ending in ":".
export function sectionsOf(text: string): { section: SectionName; text: string }[] {
  const out: { section: SectionName; text: string }[] = [];
  let current: { section: SectionName; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const label = line.trim().replace(/^(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+/, '').replace(/\s*:$/, '').replace(/\s+/g, ' ').toLowerCase();
    const hit = label.length <= 40 ? HEADINGS.find(([re]) => re.test(label)) : undefined;
    if (hit) {
      if (current) out.push({ section: current.section, text: current.lines.join('\n').trim() });
      current = { section: hit[1], lines: [] };
    } else if (current) current.lines.push(line);
  }
  if (current) out.push({ section: current.section, text: current.lines.join('\n').trim() });
  // one entry per section, in order of first appearance
  const merged: { section: SectionName; text: string }[] = [];
  for (const s of out.filter((x) => x.text)) {
    const prev = merged.find((m) => m.section === s.section);
    if (prev) prev.text += `\n${s.text}`;
    else merged.push({ ...s });
  }
  return merged;
}
// a rule about section X may come from section X; a combined "Results and Discussion" serves both
export const sectionServes = (source: string, role: string) => source === role || (source === 'Results and Discussion' && (role === 'Results' || role === 'Discussion'));

export type ReadDepth = 'FULLTEXT_PARSED' | 'ABSTRACT_ONLY' | 'UNSECTIONED' | 'METADATA_ONLY';
export interface ReadSource {
  reference_id: string; title: string; read_depth: ReadDepth; sections_read: SectionName[]; withheld: string | null;
  asset_revision_id: string | null; sha256: string | null; extractor: string | null; sections: { section: SectionName; text: string }[];
}
// What the generator (provider) may read of each reference. The references must be this paper's.
export async function readWritingSources(db: Queryable, paperId: string, referenceIds: string[], provider: string): Promise<ReadSource[]> {
  const out: ReadSource[] = [];
  for (const refId of referenceIds) {
    const ref = (await db.query<{ title: string | null }>(
      `SELECT (SELECT b.csl_json->>'title' FROM bibliographic_revisions b WHERE b.reference_id = pr.reference_id ORDER BY b.created_at DESC, b.id DESC LIMIT 1) AS title
       FROM project_references pr WHERE pr.paper_id = $1 AND pr.reference_id = $2 AND pr.removed_at IS NULL`, [paperId, refId])).rows[0];
    if (!ref) throw new DomainError('NOT_FOUND', 'reference not found in this paper', 'reference_ids');
    const none = (withheld: string | null): ReadSource => ({ reference_id: refId, title: ref.title ?? '', read_depth: 'METADATA_ONLY', sections_read: [], withheld, asset_revision_id: null, sha256: null, extractor: null, sections: [] });
    // the newest parsed original of this reference
    const x = (await db.query<{ id: string; asset_revision_id: string; sha256: string; extractor: string }>(
      `SELECT x.id, x.asset_revision_id, x.sha256, x.extractor FROM pdf_extractions x JOIN asset_sources s ON s.asset_revision_id = x.asset_revision_id
       WHERE x.paper_id = $1 AND s.paper_id = $1 AND s.reference_id = $2 AND s.kind = 'source_pdf' AND x.status = 'ok'
       ORDER BY x.created_at DESC, x.id DESC LIMIT 1`, [paperId, refId])).rows[0];
    if (!x) { out.push(none(null)); continue; }
    const asset = await getSourceAsset(db, paperId, x.asset_revision_id);
    if (!asset || asset.policy.keep_right === 'unknown') { out.push(none('asset_keep_right_unknown')); continue; }
    if (provider !== 'mock') {
      const send = await externalSendDecision(db, { paperId, assetId: x.asset_revision_id, provider });
      if (!send.allowed) { out.push(none(send.reasons.join(','))); continue; }
    }
    const pages = (await db.query<{ text: string }>('SELECT text FROM pdf_pages WHERE extraction_id = $1 ORDER BY page_index', [x.id])).rows;
    const sections = sectionsOf(pages.map((p) => p.text).join('\n'));
    const names = sections.map((s) => s.section);
    out.push({
      reference_id: refId, title: ref.title ?? '', withheld: null, asset_revision_id: x.asset_revision_id, sha256: x.sha256, extractor: x.extractor, sections, sections_read: names,
      read_depth: names.some((n) => n !== 'Abstract') ? 'FULLTEXT_PARSED' : names.length ? 'ABSTRACT_ONLY' : 'UNSECTIONED',
    });
  }
  return out;
}
// what a revision records about its sources (never the text)
export const sourceRecord = ({ sections: _text, ...s }: ReadSource) => s;
export type SourceRecord = ReturnType<typeof sourceRecord>;

// ---- content ---------------------------------------------------------------------------------------
export interface RuleSource { reference_id: string; section: SectionName }
export interface Rule { text: string; sources: RuleSource[] }
export interface ProfileContent {
  article_type: string; target_audience: string; preferred_english_variant: 'US' | 'UK' | 'unspecified'; concision_preference: 'concise' | 'balanced' | 'detailed';
  claim_strength_policy: string;
  terminology: { term: string; preferred: string; avoid: string[]; note: string }[];
  section_roles: { section: SectionName; role: string; principles: Rule[]; counterexamples: Rule[] }[];
  rhetoric_patterns: Rule[]; anti_examples: Rule[];
  accepted_examples: { text: string; source: RuleSource | null }[];
  journal_rule_snapshot?: { text: string; source: string; checked_at: string; article_types: string[] };
}
export interface Removed { where: string; text: string; reason: 'section_not_read' | 'source_section_is_not_the_role_section' | 'no_source' | 'copied_from_source'; source?: RuleSource }

export class ProfileRejected extends Error {}
const KEYS = ['article_type', 'target_audience', 'preferred_english_variant', 'concision_preference', 'claim_strength_policy', 'terminology', 'section_roles', 'rhetoric_patterns', 'anti_examples', 'accepted_examples', 'journal_rule_snapshot'];
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProfileRejected(`${what} must be an object`);
  return v as Record<string, unknown>;
};
const only = (o: Record<string, unknown>, keys: string[], what: string) => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new ProfileRejected(`${what} has unknown fields: ${extra.join(', ')}`);
};
const str = (v: unknown, what: string, min: number, max: number): string => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new ProfileRejected(`${what} must be text of ${min}–${max} characters`);
  return v.trim();
};
const arr = (v: unknown, what: string, max: number): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) throw new ProfileRejected(`${what} must be a list of at most ${max} items`);
  return v;
};
const oneOf = <T extends string>(v: unknown, what: string, values: readonly T[]): T => {
  if (!values.includes(v as T)) throw new ProfileRejected(`${what} must be one of ${values.join(', ')}`);
  return v as T;
};
const source = (v: unknown, what: string): RuleSource => {
  const o = obj(v, what);
  only(o, ['reference_id', 'section'], what);
  if (typeof o.reference_id !== 'string' || !UUID_RE.test(o.reference_id)) throw new ProfileRejected(`${what}.reference_id must be a reference id`);
  return { reference_id: o.reference_id.toLowerCase(), section: oneOf(o.section, `${what}.section`, SECTIONS) };
};
const rule = (v: unknown, what: string): Rule => {
  const o = obj(v, what);
  only(o, ['text', 'sources'], what);
  return { text: str(o.text, `${what}.text`, 1, 500), sources: arr(o.sources, `${what}.sources`, 10).map((s, i) => source(s, `${what}.sources[${i}]`)) };
};
// Strict shape. `journalRule`: whether the content may carry the journal rule snapshot (the owner's
// statement; a generator may not set it).
export function parseProfileContent(raw: unknown, journalRule: boolean): ProfileContent {
  const o = obj(raw, 'profile');
  only(o, KEYS, 'profile');
  if (o.journal_rule_snapshot !== undefined && !journalRule) throw new ProfileRejected('the journal rule snapshot is the owner\'s statement; a proposal cannot set it');
  const c: ProfileContent = {
    article_type: str(o.article_type, 'article_type', 1, 60),
    target_audience: str(o.target_audience ?? '', 'target_audience', 0, 300),
    preferred_english_variant: oneOf(o.preferred_english_variant, 'preferred_english_variant', ['US', 'UK', 'unspecified'] as const),
    concision_preference: oneOf(o.concision_preference, 'concision_preference', ['concise', 'balanced', 'detailed'] as const),
    claim_strength_policy: str(o.claim_strength_policy ?? '', 'claim_strength_policy', 0, 1000),
    terminology: arr(o.terminology, 'terminology', 100).map((v, i) => {
      const t = obj(v, `terminology[${i}]`);
      only(t, ['term', 'preferred', 'avoid', 'note'], `terminology[${i}]`);
      return { term: str(t.term, `terminology[${i}].term`, 1, 100), preferred: str(t.preferred, `terminology[${i}].preferred`, 1, 100), avoid: arr(t.avoid, `terminology[${i}].avoid`, 10).map((a, j) => str(a, `terminology[${i}].avoid[${j}]`, 1, 100)), note: str(t.note ?? '', `terminology[${i}].note`, 0, 300) };
    }),
    section_roles: arr(o.section_roles, 'section_roles', 12).map((v, i) => {
      const r = obj(v, `section_roles[${i}]`);
      only(r, ['section', 'role', 'principles', 'counterexamples'], `section_roles[${i}]`);
      return {
        section: oneOf(r.section, `section_roles[${i}].section`, SECTIONS), role: str(r.role, `section_roles[${i}].role`, 1, 300),
        principles: arr(r.principles, `section_roles[${i}].principles`, 20).map((p, j) => rule(p, `section_roles[${i}].principles[${j}]`)),
        counterexamples: arr(r.counterexamples, `section_roles[${i}].counterexamples`, 20).map((p, j) => rule(p, `section_roles[${i}].counterexamples[${j}]`)),
      };
    }),
    rhetoric_patterns: arr(o.rhetoric_patterns, 'rhetoric_patterns', 30).map((p, i) => rule(p, `rhetoric_patterns[${i}]`)),
    anti_examples: arr(o.anti_examples, 'anti_examples', 30).map((p, i) => rule(p, `anti_examples[${i}]`)),
    accepted_examples: arr(o.accepted_examples, 'accepted_examples', 20).map((v, i) => {
      const e = obj(v, `accepted_examples[${i}]`);
      only(e, ['text', 'source'], `accepted_examples[${i}]`);
      return { text: str(e.text, `accepted_examples[${i}].text`, 1, 1500), source: e.source === null || e.source === undefined ? null : source(e.source, `accepted_examples[${i}].source`) };
    }),
  };
  if (o.journal_rule_snapshot !== undefined) {
    const j = obj(o.journal_rule_snapshot, 'journal_rule_snapshot');
    only(j, ['text', 'source', 'checked_at', 'article_types'], 'journal_rule_snapshot');
    const checked = str(j.checked_at, 'journal_rule_snapshot.checked_at', 10, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checked) || Number.isNaN(Date.parse(checked))) throw new ProfileRejected('journal_rule_snapshot.checked_at must be a date (YYYY-MM-DD)');
    c.journal_rule_snapshot = {
      text: str(j.text, 'journal_rule_snapshot.text', 1, 5000), source: str(j.source, 'journal_rule_snapshot.source', 1, 500), checked_at: checked,
      article_types: arr(j.article_types, 'journal_rule_snapshot.article_types', 10).map((a, i) => str(a, `journal_rule_snapshot.article_types[${i}]`, 1, 60)),
    };
  }
  return c;
}

// Copied wording: a run of COPY_RUN or more words that also occurs in a read source text (case and
// punctuation ignored). A warning-level similarity, not a plagiarism verdict; it keeps a profile from
// storing sources' sentences.
export const COPY_RUN = 8;
const wordsOf = (s: string) => s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
export function copyIndex(texts: string[]): Set<string> {
  const runs = new Set<string>();
  for (const t of texts) {
    const w = wordsOf(t);
    for (let i = 0; i + COPY_RUN <= w.length; i++) runs.add(w.slice(i, i + COPY_RUN).join(' '));
  }
  return runs;
}
export function copies(text: string, index: Set<string>): boolean {
  const w = wordsOf(text);
  for (let i = 0; i + COPY_RUN <= w.length; i++) if (index.has(w.slice(i, i + COPY_RUN).join(' '))) return true;
  return false;
}

// Checks every rule and example against what was read. A proposal (`requireSource`): what fails is
// removed and listed. The owner's edit: the owner may state a preference without a source, but a
// source must be a section that was read, and copied wording is refused (the caller turns the list
// into an error).
export function checkAgainstSources(c: ProfileContent, sources: ReadSource[], a: { requireSource: boolean }): { content: ProfileContent; removed: Removed[] } {
  const removed: Removed[] = [];
  const read = new Map(sources.map((s) => [s.reference_id, new Set<string>(s.sections_read)]));
  const index = copyIndex(sources.flatMap((s) => s.sections.map((x) => x.text)));
  const sourceProblem = (s: RuleSource, role: string | null): Removed['reason'] | null => {
    if (!read.has(s.reference_id)) throw new ProfileRejected('a source names a reference that was not part of this request');
    if (!read.get(s.reference_id)!.has(s.section)) return 'section_not_read';
    if (role && !sectionServes(s.section, role)) return 'source_section_is_not_the_role_section';
    return null;
  };
  const keepRule = (r: Rule, where: string, role: string | null): Rule | null => {
    const failed = r.sources.map((s) => ({ s, p: sourceProblem(s, role) }));
    const ok = failed.filter((f) => !f.p).map((f) => f.s);
    if (r.sources.length && !ok.length) { removed.push({ where, text: r.text, reason: failed[0]!.p! }); return null; }
    if (!r.sources.length && a.requireSource) { removed.push({ where, text: r.text, reason: 'no_source' }); return null; }
    if (copies(r.text, index)) { removed.push({ where, text: r.text, reason: 'copied_from_source' }); return null; }
    // a rule that keeps a valid source loses only the others, each listed
    for (const f of failed) if (f.p) removed.push({ where, text: r.text, reason: f.p, source: f.s });
    return { text: r.text, sources: ok };
  };
  const rules = (list: Rule[], where: string, role: string | null) => list.flatMap((r, i) => keepRule(r, `${where}[${i}]`, role) ?? []);
  const content: ProfileContent = {
    ...c,
    section_roles: c.section_roles.map((r, i) => ({ ...r, principles: rules(r.principles, `section_roles[${i}].principles`, r.section), counterexamples: rules(r.counterexamples, `section_roles[${i}].counterexamples`, r.section) })),
    rhetoric_patterns: rules(c.rhetoric_patterns, 'rhetoric_patterns', null),
    anti_examples: rules(c.anti_examples, 'anti_examples', null),
    accepted_examples: c.accepted_examples.flatMap((e, i) => {
      const where = `accepted_examples[${i}]`;
      if (e.source) {
        const p = sourceProblem(e.source, null);
        if (p) { removed.push({ where, text: e.text, reason: p, source: e.source }); return []; }
      }
      if (copies(e.text, index)) { removed.push({ where, text: e.text, reason: 'copied_from_source' }); return []; }
      return [e];
    }),
  };
  return { content, removed };
}

// ---- revisions ---------------------------------------------------------------------------------------
export interface ProfileRevision {
  id: string; parent_revision_id: string | null; run_id: string | null; content: ProfileContent; content_hash: string; sources: SourceRecord[]; removed: Removed[];
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED'; created_at: string; approved_at: string | null; superseded_at: string | null; generator: string | null; generator_label: string | null;
}
const REV_COLUMNS = `r.id, r.parent_revision_id, r.run_id, r.content, r.content_hash, r.sources, r.removed, r.status, r.created_at, r.approved_at, r.superseded_at, u.generator, u.generator_label
  FROM writing_profile_revisions r LEFT JOIN writing_profile_runs u ON u.id = r.run_id`;
const latestId = async (db: Queryable, paperId: string) => (await db.query<{ id: string }>('SELECT id FROM writing_profile_revisions WHERE paper_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [paperId])).rows[0]?.id ?? null;
export const activeProfile = async (db: Queryable, paperId: string): Promise<ProfileRevision | null> =>
  (await db.query<ProfileRevision>(`SELECT ${REV_COLUMNS} WHERE r.paper_id = $1 AND r.status = 'APPROVED'`, [paperId])).rows[0] ?? null;

export async function insertProfileRevision(tx: Queryable, a: { paperId: string; ownerId: string; parentId: string | null; runId: string | null; content: ProfileContent; sources: SourceRecord[]; removed: Removed[] }) {
  return (await tx.query<{ id: string; content_hash: string; status: string }>(
    'INSERT INTO writing_profile_revisions (paper_id, parent_revision_id, run_id, content, content_hash, sources, removed, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, content_hash, status',
    [a.paperId, a.parentId, a.runId, JSON.stringify(a.content), contentHash(a.content), JSON.stringify(a.sources), JSON.stringify(a.removed), a.ownerId])).rows[0]!;
}

export async function profileView(db: Queryable, paperId: string) {
  const revisions = (await db.query<ProfileRevision>(`SELECT ${REV_COLUMNS} WHERE r.paper_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 50`, [paperId])).rows;
  const feedback = (await db.query<{ id: string; text: string; status: string; created_at: string }>(
    'SELECT id, text, status, created_at FROM writing_profile_feedback WHERE paper_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50', [paperId])).rows;
  return {
    active: revisions.find((r) => r.status === 'APPROVED') ?? (await activeProfile(db, paperId)),
    latest: revisions[0] ?? null,
    revisions: revisions.map(({ content: _c, sources: _s, removed: _r, ...r }) => r),
    feedback,
  };
}

const referenceIdsOf = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20 || v.some((x) => typeof x !== 'string' || !UUID_RE.test(x))) {
    throw new DomainError('INVALID', 'reference_ids must list 1–20 references of this paper', 'reference_ids');
  }
  return [...new Set(v.map((x: string) => x.toLowerCase()))];
};
export async function requestProfileRun(pool: TxPool, a: { paperId: string; ownerId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['reference_ids', 'idempotency_key'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  const refs = referenceIdsOf(b.reference_ids);
  // the references must be this paper's (checked now; the worker reads them again)
  const found = (await pool.query<{ reference_id: string }>('SELECT reference_id FROM project_references WHERE paper_id = $1 AND reference_id = ANY($2::uuid[]) AND removed_at IS NULL', [a.paperId, refs])).rows;
  if (found.length !== refs.length) throw new DomainError('NOT_FOUND', 'reference not found in this paper', 'reference_ids');
  return enqueueJob(pool, { paperId: a.paperId, ownerId: a.ownerId, intent: 'propose_profile', idempotencyKey: b.idempotency_key, payload: { reference_ids: refs } });
}

// The owner's own version: based on the latest one (an older base is a conflict, not an overwrite).
export async function createOwnRevision(pool: TxPool, a: { paperId: string; ownerId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['parent_revision_id', 'content'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  let content: ProfileContent;
  try {
    content = parseProfileContent(b.content, true);
  } catch (e) {
    if (e instanceof ProfileRejected) throw new DomainError('INVALID', e.message, 'content');
    throw e;
  }
  return inTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`writing-profile:${a.paperId}`]);
    const latest = await latestId(tx, a.paperId);
    const parent = typeof b.parent_revision_id === 'string' ? b.parent_revision_id.toLowerCase() : b.parent_revision_id ?? null;
    if (parent !== latest) throw new DomainError('CONFLICT', latest ? 'the profile changed since you opened it; start from the latest version' : 'there is no profile version yet', 'parent_revision_id');
    // the sources stay those the parent recorded; the owner's rules may cite only sections read there
    const parentSources = latest ? (await tx.query<{ sources: SourceRecord[] }>('SELECT sources FROM writing_profile_revisions WHERE id = $1', [latest])).rows[0]!.sources : [];
    const read: ReadSource[] = [];
    for (const s of parentSources) {
      const now = (await readWritingSources(tx, a.paperId, [s.reference_id], 'mock').catch((e) => {
        if (e instanceof DomainError && e.code === 'NOT_FOUND') return []; // removed from the paper since
        throw e;
      }))[0];
      // the same parsed text as recorded: compare against it; otherwise only what was recorded as read
      read.push(now && now.sha256 === s.sha256 ? { ...now, sections_read: s.sections_read.filter((x) => now.sections_read.includes(x)) } : { ...s, sections: [] });
    }
    let checked: ReturnType<typeof checkAgainstSources>;
    try {
      checked = checkAgainstSources(content, read, { requireSource: false });
    } catch (e) {
      if (e instanceof ProfileRejected) throw new DomainError('INVALID', `${e.message}`, 'content');
      throw e;
    }
    if (checked.removed.length) {
      throw new DomainError('INVALID', `not saved: ${checked.removed.map((r) => `${r.where} (${r.reason})`).join('; ')}`, 'content', { details: { problems: checked.removed } });
    }
    return insertProfileRevision(tx, { paperId: a.paperId, ownerId: a.ownerId, parentId: latest, runId: null, content, sources: parentSources, removed: [] });
  });
}

export async function approveProfileRevision(pool: TxPool, a: { paperId: string; ownerId: string; revisionId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (b.intent !== 'approve_profile') throw new DomainError('INVALID', 'approving needs the explicit intent "approve_profile"', 'intent');
  if (Object.keys(b).some((k) => !['intent', 'content_hash'].includes(k))) throw new DomainError('INVALID', 'unknown fields', 'body');
  if (typeof b.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(b.content_hash)) throw new DomainError('INVALID', 'content_hash must name the exact version you read', 'content_hash');
  if (!UUID_RE.test(a.revisionId)) throw new DomainError('NOT_FOUND', 'profile version not found');
  return inTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`writing-profile:${a.paperId}`]);
    const rev = (await tx.query<{ id: string; status: string; content_hash: string }>('SELECT id, status, content_hash FROM writing_profile_revisions WHERE id = $1 AND paper_id = $2', [a.revisionId.toLowerCase(), a.paperId])).rows[0];
    if (!rev) throw new DomainError('NOT_FOUND', 'profile version not found');
    if (rev.content_hash !== b.content_hash) throw new DomainError('CONFLICT', 'this is not the version you read', 'content_hash');
    if (rev.status !== 'DRAFT') throw new DomainError('CONFLICT', `this version is already ${rev.status.toLowerCase()}`);
    await tx.query("UPDATE writing_profile_revisions SET status = 'SUPERSEDED', superseded_at = clock_timestamp() WHERE paper_id = $1 AND status = 'APPROVED'", [a.paperId]);
    await tx.query("UPDATE writing_profile_revisions SET status = 'APPROVED', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1", [rev.id, a.ownerId]);
    return (await tx.query<ProfileRevision>(`SELECT ${REV_COLUMNS} WHERE r.id = $1`, [rev.id])).rows[0]!;
  });
}

export async function addProfileFeedback(db: Queryable, a: { paperId: string; ownerId: string; body: unknown }) {
  const b = (a.body ?? {}) as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== 'text')) throw new DomainError('INVALID', 'unknown fields', 'body');
  if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 2000) throw new DomainError('INVALID', 'feedback must be 1–2000 characters', 'text');
  return (await db.query<{ id: string; text: string; status: string; created_at: string }>(
    'INSERT INTO writing_profile_feedback (paper_id, text, created_by) VALUES ($1, $2, $3) RETURNING id, text, status, created_at', [a.paperId, b.text.trim(), a.ownerId])).rows[0]!;
}
