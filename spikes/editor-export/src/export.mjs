// PW-003 spike: ProseMirror JSON → Pandoc AST → DOCX / HTML preview, with a loss report
// computed by reading the produced DOCX back. Citation text and bibliography come from
// citeproc (deterministic), never from a model.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NULL_ATTR = ['', [], []];

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

export function pandocInfo() {
  const version = run('pandoc', ['--version']).split('\n')[0].trim();
  const apiVersion = JSON.parse(run('pandoc', ['-f', 'markdown', '-t', 'json'], 'x'))['pandoc-api-version'];
  return { version, apiVersion };
}

// Splits text into Str/Space inlines the way the Pandoc readers do.
function textInlines(text) {
  const out = [];
  for (const part of text.split(/( +)/)) {
    if (!part) continue;
    out.push(part.trim() === '' ? { t: 'Space' } : { t: 'Str', c: part });
  }
  return out;
}

const MARK_WRAP = { bold: 'Strong', italic: 'Emph', subscript: 'Subscript', superscript: 'Superscript' };

function inlineToPandoc(node) {
  if (node.type === 'text') {
    let inl = textInlines(node.text);
    for (const mark of node.marks || []) inl = [{ t: MARK_WRAP[mark.type], c: inl }];
    return inl;
  }
  if (node.type === 'citation') {
    const suffix = node.attrs.locator ? [{ t: 'Str', c: ',' }, { t: 'Space' }, ...textInlines(node.attrs.locator)] : [];
    return [{
      t: 'Cite',
      c: [[{ citationId: node.attrs.referenceId, citationPrefix: [], citationSuffix: suffix, citationMode: { t: 'NormalCitation' }, citationNoteNum: 0, citationHash: 0 }], [{ t: 'Str', c: `[@${node.attrs.referenceId}]` }]],
    }];
  }
  if (node.type === 'math_inline') return [{ t: 'Math', c: [{ t: 'InlineMath' }, node.attrs.latex] }];
  if (node.type === 'figure_ref') return [{ t: 'Link', c: [NULL_ATTR, [{ t: 'Str', c: 'Figure' }], [`#${node.attrs.targetId}`, '']] }];
  throw new Error(`unsupported inline ${node.type}`);
}

const inlines = (content = []) => content.flatMap(inlineToPandoc);

function cell(c) {
  return [NULL_ATTR, { t: 'AlignDefault' }, 1, 1, [{ t: 'Plain', c: inlines(c.content) }]];
}

function blockToPandoc(node) {
  switch (node.type) {
    case 'paragraph':
      return { t: 'Para', c: inlines(node.content) };
    case 'heading':
      return { t: 'Header', c: [node.attrs.level, [node.attrs.id || '', [], []], inlines(node.content)] };
    case 'table': {
      const [head, ...body] = node.content;
      const cols = head.content.length;
      const row = (r) => [NULL_ATTR, r.content.map(cell)];
      return {
        t: 'Table',
        c: [[node.attrs.id || '', [], []], [null, []], Array.from({ length: cols }, () => [{ t: 'AlignDefault' }, { t: 'ColWidthDefault' }]), [NULL_ATTR, [row(head)]], [[NULL_ATTR, 0, [], body.map(row)]], [NULL_ATTR, []]],
      };
    }
    default:
      throw new Error(`unsupported block ${node.type}`);
  }
}

export function toPandocAst(doc, apiVersion) {
  const json = doc.toJSON();
  return { 'pandoc-api-version': apiVersion, meta: {}, blocks: json.content.map(blockToPandoc) };
}

function walk(value, visit) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') {
    visit(value);
    Object.values(value).forEach((v) => walk(v, visit));
  }
}

function astStrings(ast) {
  let s = '';
  walk(ast, (n) => { if (n.t === 'Str') s += n.c + ' '; });
  return s;
}

function countTags(ast) {
  const counts = {};
  walk(ast, (n) => { if (typeof n.t === 'string') counts[n.t] = (counts[n.t] || 0) + 1; });
  return counts;
}

function docFeatures(doc) {
  const f = { text: '', marks: new Set(), citations: 0, math: 0, tables: 0, ids: 0 };
  doc.descendants((n) => {
    if (n.isText) { f.text += n.text; n.marks.forEach((m) => f.marks.add(m.type.name)); }
    if (n.type.name === 'citation') f.citations++;
    if (n.type.name === 'math_inline') f.math++;
    if (n.type.name === 'table') f.tables++;
    if (n.attrs?.id) f.ids++;
  });
  return f;
}

// True when every grapheme that carries a combining mark in the source is present in the output.
function countNfc(back, srcText) {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const marked = [...seg.segment(srcText)].map((g) => g.segment).filter((g) => /\p{M}/u.test(g)).map((g) => g.normalize('NFC'));
  const occurrences = (hay, needle) => hay.split(needle).length - 1;
  return marked.every((g) => occurrences(back, g) >= occurrences(srcText.normalize('NFC'), g));
}

// Compares what the source document contains with what the DOCX actually holds when read back.
export function buildLossReport({ doc, docxXml, roundTrip, bibliography, info }) {
  const src = docFeatures(doc);
  const tags = countTags(roundTrip);
  const back = astStrings(roundTrip).normalize('NFC');
  const has = (re) => re.test(src.text);
  const feature = (name, present, preserved, note) => (present ? { feature: name, status: preserved ? 'preserved' : 'lost', note } : { feature: name, status: 'not_present' });
  const families = bibliography.map((b) => b.author?.[0]?.family).filter(Boolean);
  const features = [
    feature('korean_text', has(/[가-힣]/), /[가-힣]/.test(back)),
    feature('emoji', has(/\p{Extended_Pictographic}/u), /\p{Extended_Pictographic}/u.test(back)),
    feature('greek', has(/[Ͱ-Ͽ]/), /[Ͱ-Ͽ]/.test(back)),
    feature('combining_marks', has(/\p{M}/u), countNfc(back, src.text), 'every base+combining sequence survives (compared after NFC normalisation)'),
    feature('italic', src.marks.has('italic'), (tags.Emph || 0) > 0),
    feature('bold', src.marks.has('bold'), (tags.Strong || 0) > 0),
    feature('subscript', src.marks.has('subscript'), (tags.Subscript || 0) > 0),
    feature('superscript', src.marks.has('superscript'), (tags.Superscript || 0) > 0),
    feature('table', src.tables > 0, (tags.Table || 0) >= src.tables),
    feature('inline_math', src.math > 0, docxXml.includes('<m:oMath') && (tags.Math || 0) >= src.math, 'written as Office Math (OMML)'),
    feature('citation_rendered_text', src.citations > 0, families.some((fam) => back.includes(fam)), 'citeproc author-date text in the body'),
    feature('citation_live_field', src.citations > 0, /ADDIN ZOTERO|ADDIN CSL_CITATION|w:fldSimple[^>]*CITATION/.test(docxXml), 'no Word/Zotero citation field; citations cannot be re-linked inside Word'),
    feature('bibliography', src.citations > 0, families.every((fam) => back.includes(fam)) && docxXml.includes('Bibliography'), 'generated by citeproc'),
    feature('block_ids', src.ids > 0, false, 'stable block ids are not represented in DOCX; re-import cannot map blocks back'),
    { feature: 'comments_highlights', status: 'not_exported', note: 'v1 clean DOCX does not carry platform comments' },
    { feature: 'track_changes', status: 'not_supported', note: 'Word native tracked changes round-trip is out of v1 scope' },
  ];
  return { scope: 'PW-003 spike export check', pandoc_version: info.version, pandoc_api_version: info.apiVersion, generated_at: new Date().toISOString(), features };
}

export function exportDocument(doc, { bibliography, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const info = pandocInfo();
  const ast = toPandocAst(doc, info.apiVersion);
  const inputPath = path.join(outDir, 'pandoc-input.json');
  const bibPath = path.join(outDir, 'references.json');
  const docxPath = path.join(outDir, 'manuscript.docx');
  const htmlPath = path.join(outDir, 'preview.html');
  fs.writeFileSync(inputPath, JSON.stringify(ast, null, 1));
  fs.writeFileSync(bibPath, JSON.stringify(bibliography, null, 1));
  const common = ['-f', 'json', '--citeproc', '--bibliography', bibPath, '--metadata', 'reference-section-title=Bibliography', '--metadata', 'link-citations=false'];
  run('pandoc', [...common, '-t', 'docx', '-o', docxPath, inputPath]);
  run('pandoc', [...common, '-t', 'html5', '--standalone', '--metadata', 'title=Export preview', '--mathml', '-o', htmlPath, inputPath]);
  const docxXml = run('unzip', ['-p', docxPath, 'word/document.xml']);
  const roundTrip = JSON.parse(run('pandoc', ['-f', 'docx', '-t', 'json', docxPath]));
  const report = buildLossReport({ doc, docxXml, roundTrip, bibliography, info });
  fs.writeFileSync(path.join(outDir, 'loss-report.json'), JSON.stringify(report, null, 2) + '\n');
  return { docxPath, htmlPath, report };
}
