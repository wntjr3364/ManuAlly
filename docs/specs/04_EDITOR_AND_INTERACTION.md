# 04. Editor, selection chat and safe changes

## 화면 구성 — Scivo와 독립
Paper dashboard: 논문 카드, 상태, 최근 snapshot, 진행중 작업. Paper 내부는 `구상/개요`, `원고`, `자료`, `검토/내보내기` 네 영역을 기본으로 한다. version·AI run·설정은 utility로 둔다. 원고 화면 중앙은 문서, 왼쪽은 접을 수 있는 outline, 오른쪽은 chat/comment/evidence inspector. UI를 터미널 콘솔처럼 만들지 않는다.

선택 → 작은 toolbar: 질문 / 문법 / 간결화 / 학술적 재작성 / comment. 짧은 지시는 선택 팝업에서, 여러 문단·전체 논리 변경은 sidebar에서 처리. 현재 대상(문장/문단/개요/전체)과 허용 범위를 항상 보여준다. 채팅 답변과 실제 수정 제안을 시각적으로 구분한다.

## 정본 표현
Tiptap/ProseMirror JSON + 자체 검증 schema. bold/italic/subscript/superscript, Greek/Unicode, citation node, figure/table crossref, inline math와 기본 표 지원. raw HTML 저장·실행 금지. HTML·Markdown·DOCX는 import/export 포맷이지 정본 아님. shared packages/editor-core가 server와 browser의 schema·position projection·transaction validation을 함께 소유한다 [S09].

## AI proposal 경로
1. 브라우저가 선택범위와 base revision을 고정한다. 사용자가 계속 입력해도 선택 요청의 snapshot은 변경하지 않는다.
2. 서버가 승인된 outline·scope·provider policy를 확인하고 job을 만든다.
3. 모델에는 immutable selection handle, 선택 문장, 필요한 전후 문맥·규칙을 준다. offset을 추측하게 하지 않는다.
4. 모델은 해당 handle의 replacement 또는 명시된 block operation을 제안한다.
5. 서버가 canonical EditProposal로 변환하고 schema·근거·보호 span·현재 revision을 검증한다.
6. diff 확인 후 사용자가 accept/reject/refine. 승인 요청은 proposal_id, proposal_hash, expected_revision, idempotency_key를 포함한다.
7. 단일 트랜잭션에서 revision·anchor mapping·audit·proposal applied를 함께 기록. 응답 유실 후 재요청해도 중복 적용하지 않는다.

## revision / 위치 계약
선택범위는 base_revision_id, block_id, expected_block_hash, ProseMirror block-relative positions, selected_slice_hash로 표현한다. position은 **JS 문자열 인덱스나 Python codepoint가 아닌 공유 editor schema의 ProseMirror position**이다. 노드 경계·인용 atom·emoji·결합문자·한글 IME를 포함한 golden fixtures로 정의한다. P00 spike에서 계약을 검증하기 전 실제 원고에 적용하지 않는다.

v1 안전 기본값: base revision이 바뀌면 자동 rebase하지 않고 STALE → 최신 원문 기준 재생성. 나중에 비중첩 자동 rebase를 추가하려면 별도 ADR과 property tests가 필요하다. 같은 문장이 두 곳 있어도 text search로 replacement 위치를 선택하지 않는다.

## 허용 operation
replace_selection, replace_block, insert_block_after, delete_block, move_block, update_citation, update_cross_reference. 첫 usable slice는 replace_selection만. citation과 수치·단위가 선택에 포함되면 보존 규칙을 먼저 적용한다. 기본 문법 모드는 citation atom 변경 금지. 다중 블록 계획은 한 번에 검증·commit하며 일부만 적용된 상태를 숨기지 않는다.

## Comment / Highlight
Comment anchor는 document_revision + block lineage + position + quote/prefix/suffix로 보조한다. 편집 transaction으로 확실히 추적 가능한 경우 이동, 텍스트 삭제/애매한 재배치는 ORPHANED 표시. 임의의 비슷한 문장에 붙이지 않는다. resolve는 수정 적용과 별개로 사용자가 확정하며 reopen 가능. AI suggestion을 reject해도 comment는 보존한다. PDF highlight는 별도 좌표 schema를 사용한다.

## 즉시 적용과 통제
기본은 diff 후 1회 apply. 사용자가 프로젝트 설정에서 켠 경우에만 좁은 문법 편집을 즉시 적용할 수 있다. 그래도 version/guard/undo를 생략하지 않는다. 숫자·claim·citation·outline 변경은 이 빠른 모드로 처리하지 않는다. 서버 재개 작업은 proposal 생성까지만 자동이며 manuscript 적용 승인은 재사용하지 않는다.

## 저장·접근성
autosave ack 전에는 ‘저장됨’ 표시 금지. 전송 실패·충돌·오프라인 표시. 브라우저 임시복구 저장은 계정·논문별 격리와 보존기간·명시 설정을 둔다. 로그아웃 시 shared device 데이터를 남기지 않는다. selection은 popup focus 시 유지. IME composition 중 patch 적용 금지. 키보드 전체 작업/ESC/스크린리더 labels, 1366×768과 1920×1080 테스트. 기본 단축키는 editor focus 안에서만 작동하며 변경 가능.
