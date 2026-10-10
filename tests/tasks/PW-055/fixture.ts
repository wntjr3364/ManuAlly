// PW-055 — synthetic .docx files for the import tests: a small ZIP writer (stored or deflated entries, CRC-32
// from node:zlib) and a WordprocessingML document builder. All text is synthetic.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipOpts { store?: boolean; encrypted?: boolean; declaredSize?: number }

export function makeZip(entries: Record<string, string | Buffer>, o: ZipOpts = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const body = o.store ? data : deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const size = o.declaredSize ?? data.length;
    const flags = (o.encrypted ? 1 : 0) | 0x0800;
    const method = o.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(flags, 8); cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(size, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
export const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

// Korean Word names its built-in styles by number ids; the name in styles.xml is the canonical English one
export const STYLES = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${NS}>
<w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="a3"><w:name w:val="Title"/></w:style>
<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;

export const r = (text: string, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const p = (inner: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${inner}</w:p>`;

export function makeDocx(body: string, parts: { styles?: string | null; comments?: string; footnotes?: string; extra?: Record<string, string | Buffer> } = {}, zip: ZipOpts = {}): Buffer {
  const entries: Record<string, string | Buffer> = {
    '[Content_Types].xml': CONTENT_TYPES,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  };
  if (parts.styles !== null) entries['word/styles.xml'] = parts.styles ?? STYLES;
  if (parts.comments) entries['word/comments.xml'] = `<?xml version="1.0" encoding="UTF-8"?><w:comments ${NS}>${parts.comments}</w:comments>`;
  if (parts.footnotes) entries['word/footnotes.xml'] = `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${NS}>${parts.footnotes}</w:footnotes>`;
  Object.assign(entries, parts.extra ?? {});
  return makeZip(entries, zip);
}

// a paper with every kind the report names: tracked changes, a Zotero citation and bibliography field, a
// comment, an equation, a table with a merged cell, an image, a footnote and a link
export function richDocx(): Buffer {
  const body = [
    p(r('Drought marker paper'), 'a3'),
    p(r('Introduction'), '1'),
    p(`${r('In ')}${r('Arabidopsis thaliana', '<w:i/>')}${r(', H')}${r('2', '<w:vertAlign w:val="subscript"/>')}${r('O loss rises by 10')}${r('3', '<w:vertAlign w:val="superscript"/>')}${r(' fold ')}${r('(strong)', '<w:b/>')}${r('.')}`),
    p(`${r('The marker was ')}<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">${r('clearly ')}</w:ins><w:del w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">barely </w:delText></w:r></w:del>${r('induced.')}`),
    p(`${r('As shown before ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"x1"} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('(Kim et al., 2020)')}<w:r><w:fldChar w:fldCharType="end"/></w:r>${r('.')}`),
    p(`<w:commentRangeStart w:id="5"/>${r('This sentence has a comment.')}<w:commentRangeEnd w:id="5"/><w:r><w:commentReference w:id="5"/></w:r>`),
    p(`${r('The rate is ')}<m:oMath><m:r><m:t>k=2.4</m:t></m:r></m:oMath>${r(' per day.')}`),
    `<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p(r('Group'))}</w:tc></w:tr><w:tr><w:tc>${p(r('drought'))}</w:tc><w:tc>${p(r('2.4'))}</w:tc></w:tr></w:tbl>`,
    p(`<w:r><w:drawing><wp:inline><wp:docPr w:id="9" name="Figure 1"/></wp:inline></w:drawing></w:r>${r('Figure caption text.')}`),
    p(`${r('Footnoted sentence')}<w:r><w:footnoteReference w:id="2"/></w:r>${r('.')}`),
    p(`<w:hyperlink r:id="rId9">${r('a linked word')}</w:hyperlink>`),
    p(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_BIBL {"uncited":[]} CSL_BIBLIOGRAPHY </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r('Kim J. 2020. A study. J Plant 1:1.')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`),
  ].join('');
  return makeDocx(body, {
    comments: `<w:comment w:id="5" w:author="Reviewer"><w:p><w:r><w:t>Please cite the source.</w:t></w:r></w:p></w:comment>`,
    footnotes: `<w:footnote w:id="0"><w:p/></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Measured in 2025.</w:t></w:r></w:p></w:footnote>`,
  });
}
