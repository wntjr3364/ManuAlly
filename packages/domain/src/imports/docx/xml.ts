// A small XML reader for WordprocessingML parts (PW-055): elements, attributes, text, CDATA and the five
// predefined entities plus character references. A DOCTYPE (where external or expanding entities live) is
// refused, as is any other entity; nothing is fetched or expanded. Names keep their prefix (w:p, m:t).
export class XmlError extends Error {}
export interface XEl { name: string; attrs: Record<string, string>; children: XNode[] }
export type XNode = XEl | string;

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&([^;&\s]{1,10});/g, (_m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n < 1 || n > 0x10ffff) throw new XmlError(`a bad character reference &${e};`);
      return String.fromCodePoint(n);
    }
    const v = NAMED[e];
    if (v === undefined) throw new XmlError(`an undefined entity &${e};`);
    return v;
  });
}

export function parseXml(src: string): XEl {
  const root: XEl = { name: '#root', attrs: {}, children: [] };
  const stack: XEl[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { if (src.slice(i).trim()) stack.at(-1)!.children.push(decode(src.slice(i))); break; }
    if (lt > i) stack.at(-1)!.children.push(decode(src.slice(i, lt)));
    if (src.startsWith('<?', lt)) { i = src.indexOf('?>', lt); if (i < 0) throw new XmlError('an unclosed declaration'); i += 2; continue; }
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt); if (i < 0) throw new XmlError('an unclosed comment'); i += 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end < 0) throw new XmlError('an unclosed CDATA section');
      stack.at(-1)!.children.push(src.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) throw new XmlError('a DOCTYPE or other declaration is not allowed');
    const gt = src.indexOf('>', lt);
    if (gt < 0) throw new XmlError('an unclosed tag');
    const tag = src.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name || stack.length === 0) throw new XmlError(`a mismatched closing tag </${name}>`);
      continue;
    }
    const self = tag.endsWith('/');
    const body = self ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new XmlError('a tag without a name');
    const el: XEl = { name: m[1]!, attrs: {}, children: [] };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(m[1]!.length);
    while ((a = attrRe.exec(rest))) el.attrs[a[1]!] = decode(a[3] ?? a[4] ?? '');
    stack.at(-1)!.children.push(el);
    if (!self) stack.push(el);
  }
  if (stack.length !== 1) throw new XmlError(`an unclosed element <${stack.at(-1)!.name}>`);
  const top = root.children.find((c): c is XEl => typeof c !== 'string');
  if (!top) throw new XmlError('no root element');
  return top;
}

export const elements = (e: XEl, name?: string) => e.children.filter((c): c is XEl => typeof c !== 'string' && (!name || c.name === name));
export const child = (e: XEl, name: string) => elements(e, name)[0];
// every descendant element with this name, in document order
export function descendants(e: XEl, name: string, out: XEl[] = []): XEl[] {
  for (const c of e.children) if (typeof c !== 'string') { if (c.name === name) out.push(c); descendants(c, name, out); }
  return out;
}
export function textOf(e: XEl, names = ['w:t', 'm:t']): string {
  let s = '';
  for (const c of e.children) if (typeof c !== 'string') s += names.includes(c.name) ? c.children.filter((x): x is string => typeof x === 'string').join('') : textOf(c, names);
  return s;
}
