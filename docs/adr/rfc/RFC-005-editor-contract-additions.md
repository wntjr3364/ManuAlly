# RFC-005 — edit_proposal 계약 보완: selected_slice_hash, 보호 atom, 위치 규칙
Status: accepted
Trigger task: PW-003
Affected requirements/specs/contracts: REQ-012, REQ-017; contracts/edit_proposal.schema.json; docs/specs/04_EDITOR_AND_INTERACTION.md
Problem and evidence:
PW-003 spike 결과:
1. starter 계약에 `selected_slice_hash`가 없다. 선택 내용이 바뀐 것을 블록 hash만으로 구분하면 진단이 약하다.
2. replacement가 text/citation만 표현하므로, 수식·그림참조 atom이 포함된 선택은 안전하게 수정할 수 없다(spike는 PROTECTED_ATOM으로 거부).
3. 위치 단위(UTF-16 + atom=1)와 grapheme 경계 규칙이 계약 문서에 명시돼 있지 않다.
Proposed change:
- (리뷰 M1) AI proposal은 **범위를 직접 담지 않는다**. 서버가 저장한 `selection_handle_id`만 참조한다.
  - 범위·블록·hash는 handle에서 가져오며, proposal에 다른 범위가 있으면 거부한다.
  - `proposal_id`로 1회만 적용한다(재생 거부). 적용된 handle은 소비된다.
  - AI 경로는 항상 conservative guard를 거친다. mode는 서버 route가 정하며 proposal이 고를 수 없다.
- `operation.selected_slice_hash`(sha256 hex)를 필수로 추가한다. hash에는 block_id·from·to를 포함한다.
- replacement 항목에 `{type:"preserve_atom", atom_index}`를 추가해, 선택 안의 기존 atom(수식·그림참조·인용)을 순서대로 보존해 재배치할 수 있게 한다.
- 계약 README에 위치 규칙을 명시한다: block-content-relative ProseMirror position, text는 UTF-16 길이, inline atom은 1, surrogate/grapheme 분할 금지, 블록은 id로만 지정.
- `expected_block_hash` = sha256(키 정렬 canonical JSON(block.toJSON())).
Alternatives considered: 수식 포함 선택을 영구 거부 — 논문에서 흔한 경우라 사용성이 크게 떨어진다.
Security/privacy/budget/provider terms impact: 없음.
Data migration / backward compatibility: schema_version 1 → 2. 구현 전이므로 이전 데이터는 없다.
Tests and acceptance criteria: PW-003 테스트 재사용 + preserve_atom 왕복 테스트 + 공유 editor-core에서 browser/server 동일 hash 테스트(PW-012).
Write scope: contracts/**(P01 PW-012에서 반영).
User decision / reviewer:
- spike 구현: `spikes/editor-export/src/selection.mjs` (bf76f80)
- P00 gate에서 승인 필요
