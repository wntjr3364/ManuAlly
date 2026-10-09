// A selection request (spec 04 "AI proposal 경로" step 1): the browser freezes the selection and the
// stored revision it belongs to at the moment an action is chosen. Later typing, focus moves or
// other changes never alter the request; the server re-derives the same snapshot from the stored
// revision (editor-core snapshotSelection) and refuses it when they differ.
import { EDITOR_SCHEMA_VERSION, parseDocument, snapshotSelection, type SelectionSnapshot } from '@pw/editor-core';
import type { SelectionTarget } from './target.ts';

// edits: may change the manuscript (as a proposal shown as a diff); preApproval: allowed before the
// outline is approved (RFC-003: only questions and conservative corrections of the user's own text)
export const INTENTS = {
  ask: { label: '질문', edits: false, preApproval: true },
  grammar: { label: '문법', edits: true, preApproval: true },
  concise: { label: '간결화', edits: true, preApproval: true },
  rewrite: { label: '학술적 재작성', edits: true, preApproval: false },
} as const;
export type Intent = keyof typeof INTENTS;
export const MAX_INSTRUCTION = 2000;

export const intentAllowed = (intent: Intent, outlineApproved: boolean) => outlineApproved || INTENTS[intent].preApproval;

export interface SelectionRequest {
  document_id: string;
  base_revision_id: string;
  intent: Intent;
  instruction: string;
  selection: SelectionSnapshot;
}

// The snapshot of a target in the stored document JSON (the editor shows exactly that revision when
// requests are enabled). Throws SelectionError (e.g. a range splitting a character).
export function freezeSelection(storedJson: unknown, target: Extract<SelectionTarget, { kind: 'block' }>): Promise<SelectionSnapshot> {
  const doc = parseDocument(storedJson, EDITOR_SCHEMA_VERSION);
  return snapshotSelection(doc, { blockId: target.blockId, from: target.from, to: target.to });
}

export function buildSelectionRequest(
  frozen: { documentId: string; baseRevisionId: string; selection: SelectionSnapshot },
  intent: Intent,
  instruction: string,
): { ok: true; request: SelectionRequest } | { ok: false; error: string } {
  if (!Object.hasOwn(INTENTS, intent)) return { ok: false, error: '알 수 없는 요청 종류입니다' };
  const text = instruction.trim();
  if (text.length > MAX_INSTRUCTION) return { ok: false, error: `지시는 ${MAX_INSTRUCTION}자 이하로 써 주세요` };
  if (intent === 'ask' && !text) return { ok: false, error: '질문 내용을 입력하세요' };
  return {
    ok: true,
    request: { document_id: frozen.documentId, base_revision_id: frozen.baseRevisionId, intent, instruction: text, selection: frozen.selection },
  };
}
