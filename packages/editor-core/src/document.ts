// Validation of stored/submitted document JSON against the shared schema (REQ-012-B).
// Refused: anything that is not a JSON document (e.g. an HTML string), unknown node/mark types
// (including HTML-ish ones), unknown fields or attributes, missing/invalid/duplicate block ids,
// invalid atom attributes, and a schema version other than the current one. A different version
// is reported as MIGRATION_REQUIRED and only an explicit migrateDocument() call converts it.
import { Node as PMNode } from 'prosemirror-model';
import { ATOM_TYPES, BLOCK_TYPES, EDITOR_SCHEMA_VERSION, schema } from './schema.ts';

export type DocumentErrorCode =
  | 'RAW_HTML' | 'NOT_A_DOCUMENT' | 'UNKNOWN_NODE' | 'UNKNOWN_MARK' | 'UNKNOWN_FIELD' | 'UNKNOWN_ATTR' | 'INVALID_ATTR'
  | 'BLOCK_ID_MISSING' | 'BLOCK_ID_INVALID' | 'BLOCK_ID_DUPLICATE' | 'INVALID_TEXT' | 'INVALID_STRUCTURE' | 'TOO_DEEP'
  | 'MIGRATION_REQUIRED' | 'MIGRATION_NOT_AVAILABLE';

export interface DocumentError { code: DocumentErrorCode; path: string; message: string }
export type ValidationResult = { ok: true; doc: PMNode } | { ok: false; errors: DocumentError[] };

export class DocumentValidationError extends Error {
  constructor(public readonly errors: DocumentError[]) {
    super(errors.map((e) => `${e.code} at ${e.path}: ${e.message}`).join('; '));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTML_TYPES = /^(html|html_block|html_inline|raw_html|iframe|script|style|object|embed)$/i;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_DEPTH = 50;
const NODE_FIELDS = ['type', 'attrs', 'content', 'text', 'marks'];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const goodText = (s: unknown, max: number) => typeof s === 'string' && s.length > 0 && s.length <= max && !s.includes('\u0000') && !LONE_SURROGATE.test(s);

function checkAttrs(type: string, attrs: unknown, path: string, errors: DocumentError[]) {
  if (attrs === undefined) return;
  if (!isObj(attrs)) {
    errors.push({ code: 'INVALID_ATTR', path: `${path}.attrs`, message: 'attrs must be an object' });
    return;
  }
  const declared = Object.keys(schema.nodes[type]!.spec.attrs ?? {});
  for (const k of Object.keys(attrs)) if (!declared.includes(k)) errors.push({ code: 'UNKNOWN_ATTR', path: `${path}.attrs.${k}`, message: `${type} has no attribute ${k}` });
  const bad = (k: string, message: string) => errors.push({ code: 'INVALID_ATTR', path: `${path}.attrs.${k}`, message });
  if (type === 'heading' && attrs.level !== undefined && !(Number.isInteger(attrs.level) && (attrs.level as number) >= 1 && (attrs.level as number) <= 6)) bad('level', 'heading level must be 1–6');
  if (type === 'citation') {
    if (typeof attrs.referenceId !== 'string' || !UUID.test(attrs.referenceId)) bad('referenceId', 'citation needs the referenceId (UUID) of a reference');
    if (attrs.locator !== undefined && attrs.locator !== null && !goodText(attrs.locator, 200)) bad('locator', 'locator must be short text or null');
  }
  if (type === 'math_inline' && !goodText(attrs.latex, 2000)) bad('latex', 'inline math needs its LaTeX source');
  if (type === 'figure_ref' && (typeof attrs.targetId !== 'string' || !UUID.test(attrs.targetId))) bad('targetId', 'figure/table reference needs the targetId (UUID) of the figure or table');
}

function walk(v: unknown, path: string, depth: number, errors: DocumentError[], ids: Map<string, string>, topLevel: boolean) {
  if (depth > MAX_DEPTH) {
    errors.push({ code: 'TOO_DEEP', path, message: `nested deeper than ${MAX_DEPTH}` });
    return;
  }
  if (!isObj(v)) {
    errors.push({ code: 'NOT_A_DOCUMENT', path, message: 'node must be an object' });
    return;
  }
  const type = v.type;
  if (typeof type !== 'string' || !schema.nodes[type]) {
    const html = typeof type === 'string' && HTML_TYPES.test(type);
    errors.push({ code: html ? 'RAW_HTML' : 'UNKNOWN_NODE', path, message: html ? `raw HTML (${type}) is never stored or rendered` : `unknown node type ${JSON.stringify(type)}` });
    return;
  }
  for (const k of Object.keys(v)) if (!NODE_FIELDS.includes(k)) errors.push({ code: 'UNKNOWN_FIELD', path: `${path}.${k}`, message: `unknown field ${k}` });
  if (type !== 'text') checkAttrs(type, v.attrs, path, errors);
  if (type === 'text') {
    if (v.attrs !== undefined) errors.push({ code: 'UNKNOWN_FIELD', path: `${path}.attrs`, message: 'text nodes have no attributes' });
    if (!goodText(v.text, 1_000_000)) errors.push({ code: 'INVALID_TEXT', path: `${path}.text`, message: 'text must be non-empty and free of NUL and unpaired surrogates' });
  } else if (v.text !== undefined) {
    errors.push({ code: 'UNKNOWN_FIELD', path: `${path}.text`, message: `${type} has no text field` });
  }
  if (v.marks !== undefined) {
    if (!Array.isArray(v.marks)) errors.push({ code: 'UNKNOWN_MARK', path: `${path}.marks`, message: 'marks must be a list' });
    else v.marks.forEach((m, i) => {
      if (!isObj(m) || typeof m.type !== 'string' || !schema.marks[m.type]) errors.push({ code: 'UNKNOWN_MARK', path: `${path}.marks[${i}]`, message: `unknown mark ${JSON.stringify(isObj(m) ? m.type : m)}` });
      else for (const k of Object.keys(m)) if (k !== 'type') errors.push({ code: 'UNKNOWN_FIELD', path: `${path}.marks[${i}].${k}`, message: 'marks carry no attributes' });
    });
  }
  if ((BLOCK_TYPES as readonly string[]).includes(type) && topLevel) {
    const id = isObj(v.attrs) ? v.attrs.id : undefined;
    if (id === undefined || id === null) errors.push({ code: 'BLOCK_ID_MISSING', path: `${path}.attrs.id`, message: `${type} needs a stable block id` });
    else if (typeof id !== 'string' || !UUID.test(id)) errors.push({ code: 'BLOCK_ID_INVALID', path: `${path}.attrs.id`, message: 'block id must be a lowercase UUID' });
    else if (ids.has(id)) errors.push({ code: 'BLOCK_ID_DUPLICATE', path: `${path}.attrs.id`, message: `block id ${id} is also used at ${ids.get(id)}` });
    else ids.set(id, path);
  }
  if (v.content !== undefined) {
    if (!Array.isArray(v.content)) errors.push({ code: 'NOT_A_DOCUMENT', path: `${path}.content`, message: 'content must be a list' });
    else v.content.forEach((c, i) => walk(c, `${path}.content[${i}]`, depth + 1, errors, ids, type === 'doc'));
  }
  if ((ATOM_TYPES as readonly string[]).includes(type) && v.content !== undefined) errors.push({ code: 'INVALID_STRUCTURE', path: `${path}.content`, message: `${type} is an atom and has no content` });
}

export function validateDocument(json: unknown, schemaVersion: unknown): ValidationResult {
  if (schemaVersion !== EDITOR_SCHEMA_VERSION) {
    const available = Number.isInteger(schemaVersion) && hasMigration(schemaVersion as number, EDITOR_SCHEMA_VERSION);
    return { ok: false, errors: [{ code: available ? 'MIGRATION_REQUIRED' : 'MIGRATION_NOT_AVAILABLE', path: 'schema_version', message: `document schema version ${String(schemaVersion)} is not the current version ${EDITOR_SCHEMA_VERSION}; ${available ? 'run the explicit migration first' : 'no migration path exists'}` }] };
  }
  if (typeof json === 'string') {
    return { ok: false, errors: [{ code: /<\s*[a-z!/]/i.test(json) ? 'RAW_HTML' : 'NOT_A_DOCUMENT', path: '$', message: 'content must be document JSON, not a string (HTML/Markdown are import formats only)' }] };
  }
  if (!isObj(json) || json.type !== 'doc') return { ok: false, errors: [{ code: 'NOT_A_DOCUMENT', path: '$', message: 'content must be an object with type "doc"' }] };
  const errors: DocumentError[] = [];
  walk(json, '$', 0, errors, new Map(), false);
  if (errors.length) return { ok: false, errors };
  try {
    const doc = PMNode.fromJSON(schema, json);
    doc.check();
    return { ok: true, doc };
  } catch (e) {
    return { ok: false, errors: [{ code: 'INVALID_STRUCTURE', path: '$', message: e instanceof Error ? e.message : String(e) }] };
  }
}

export function parseDocument(json: unknown, schemaVersion: unknown): PMNode {
  const r = validateDocument(json, schemaVersion);
  if (!r.ok) throw new DocumentValidationError(r.errors);
  return r.doc;
}

// Explicit, versioned migrations: from -> from+1. None exist yet (version 1 is the first).
// A reader never upgrades silently; callers show a preview and store the migrated revision as new.
type Migration = (json: Json) => Json;
const MIGRATIONS: Record<number, Migration> = {};

function hasMigration(from: number, to: number): boolean {
  if (from >= to) return false;
  for (let v = from; v < to; v++) if (!MIGRATIONS[v]) return false;
  return true;
}

export function migrateDocument(json: unknown, from: number, to: number = EDITOR_SCHEMA_VERSION): { json: Json; schema_version: number } {
  if (from === to && isObj(json)) return { json, schema_version: to };
  if (!hasMigration(from, to)) {
    throw new DocumentValidationError([{ code: 'MIGRATION_NOT_AVAILABLE', path: 'schema_version', message: `no migration from document schema ${from} to ${to}` }]);
  }
  let out = json as Json;
  for (let v = from; v < to; v++) out = MIGRATIONS[v]!(out);
  return { json: out, schema_version: to };
}
