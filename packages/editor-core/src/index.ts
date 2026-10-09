// @pw/editor-core — the manuscript schema, document validation, position contract and typed
// replacement content shared by the browser editor and the server. No Node-only APIs.
export { schema, EDITOR_SCHEMA_VERSION, BLOCK_TYPES, ATOM_TYPES, MARK_TYPES } from './schema.ts';
export { canonicalJson, sha256Hex, hashJson } from './hash.ts';
export { validateDocument, parseDocument, migrateDocument, DocumentValidationError, type DocumentError, type DocumentErrorCode, type ValidationResult } from './document.ts';
export { findBlock, blockText, graphemeBoundaries, validateRange, blockHash, sliceHash, atomsIn, snapshotSelection, SelectionError, type SelectionSnapshot, type SelectionAtom, type SelectionErrorCode } from './position.ts';
export { buildReplacement, atomNodesIn, ReplacementError, type ReplacementItem } from './replacement.ts';
export { CITATION_STYLES, STYLE_VERSION, bibliography, citationLabels, figureLabels, referenceOccurrences, type CitationStyle, type CitationOccurrence, type FigureMeta, type RefMeta } from './references/index.ts';
