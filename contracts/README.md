# Contracts — starter subset, not a full implementation
JSON Schema는 **플랫폼 내부 계약의 시작 부분**이다. 공급자 SDK의 전체 원본 schema나 완성 OpenAPI가 아니다. P01/P02에서 실제 앱 계약을 확장하고 version migration과 테스트를 붙인다.

edit_proposal은 서버가 선택 handle을 검증·확장한 normalized object다. 모델에 임의 offset을 계산시키지 않는다. `from/to`는 공유 editor-core가 정의하는 해당 block content 기준 ProseMirror 위치이며 plain text 예제에 한해서 문자열 길이와 같을 수 있다. citation atom·marks·Unicode에서 일반 문자열 인덱스로 대체하면 안 된다. expected_block_hash의 실제 canonical 계산법은 P00/P01에서 확정한다. 예제 hash는 plain-text synthetic fixture용이며 운영 document JSON canonicalization을 대신하지 않는다.

JSON Schema 검증만으로 권한·DB reference·revision·scientific accuracy·from<=to·범위 보존이 보장되지 않는다. 별도의 semantic validators와 authorization이 필수다. schema가 제공하는 승인/verification flag를 AI가 채워 최종 확정하는 방식은 금지한다.

checkpoint는 서버가 작성하며 summary_note는 비신뢰 참고자료다. quota_unknown은 정상적 표현이다. null을 0이나 reset 시각으로 자동 변환하지 않는다. provider capability의 documented_not_verified는 실사용 지원 확인이 아니다.

P01 이후 추가할 주요 계약: PaperSnapshot, OutlineApprovalRequest, FactRecord, EvidenceLocator, AssetPolicy, ContextManifest, AIJob, normalized RunEvent, BudgetReservation, ApplyProposalRequest, ExportManifest. 생성된 OpenAPI와 실제 라우트의 contract test를 함께 추가한다.

## edit_proposal v2 and ai_replacement v1 (RFC-005, PW-012)
- **Position rule** (`packages/editor-core` owns it; browser and server run the same code, checked in Chromium and Node by TST-012A)
  - `from`/`to` are ProseMirror positions relative to the start of the addressed top-level textblock's content.
  - Text counts its UTF-16 length. Each inline atom (citation, inline math, figure/table reference) counts 1.
  - A position may not split a surrogate pair or an extended grapheme cluster (emoji ZWJ sequences, flags, combining marks, decomposed Hangul).
  - Blocks are addressed only by their stable UUID. Text search is never used to place an edit.
- **Hashes**
  - `expected_block_hash` = sha256(canonical JSON of `block.toJSON()`), with keys sorted and undefined dropped.
  - `selected_slice_hash` = sha256(canonical JSON of `{block_id, from, to, content}`).
- **Model output (`ai_replacement`)** names only the selection handle it was given plus the replacement or `needs_evidence`/`no_change`.
  - The server copies block, range and hashes from the stored handle into `edit_proposal` v2.
  - Model output carrying positions, ids, hashes or approval fields is refused.
- **`preserve_atom`** keeps an atom of the original selection by its index, the only way to keep inline math or figure references through an AI edit.
- **Document JSON** is validated by `validateDocument(json, schema_version)`.
  - Refused: unknown nodes or marks, raw HTML, unknown fields/attributes, missing or duplicate block ids.
  - A different `schema_version` is not read. It needs an explicit `migrateDocument` (none exist yet for version 1).
- UUIDs in these contracts are lowercase canonical (`pattern` alongside `format: uuid`), exactly as editor-core requires.
- An empty `replacement` deletes the selected range, in both `ai_replacement` and `edit_proposal`.
- `missing` appears only with `needs_evidence`, and must name at least one thing.
