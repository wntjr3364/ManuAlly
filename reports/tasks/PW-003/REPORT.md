# PW-003 — 문서 선택·포맷 왕복 spike — 보고서

상태: **in_review**
일자: 2026-10-08

## 변경 파일
- `spikes/editor-export/package.json` — `prosemirror-model@1.25.12`, `prosemirror-transform@1.12.2` (MIT), `.gitignore`(node_modules, out)
- `spikes/editor-export/src/schema.mjs` — spike schema: paragraph/heading/table, bold/italic/sub/sup, inline atoms `citation`·`math_inline`·`figure_ref`
- `spikes/editor-export/src/selection.mjs` — selection handle + guarded `replace_selection`
- `spikes/editor-export/src/export.mjs` — PM JSON → Pandoc AST → DOCX/HTML, 출력 DOCX를 다시 읽어 손실 보고서 생성
- `spikes/editor-export/run-spike.mjs` — 증거 artifact 생성
- `tests/tasks/PW-003/{fixture.mjs,selection-export.test.mjs}` — 11개 테스트
- `reports/tasks/PW-003/{red.log,green.log,impossible-cases.json,export-sample/*}`

## 제안하는 위치 계약 (packages/editor-core 후보)
- `from/to` = **top-level textblock 내용 기준 ProseMirror position**. 텍스트는 UTF-16 길이, inline atom은 1.
  예: 🌱은 2, `é`(e+U+0301)는 2, 인용 atom은 1.
- surrogate pair나 grapheme cluster(결합문자, 분해형 한글 자모)를 가르는 위치는 **거부**한다.
- 블록은 stable id로만 찾는다. id가 없거나 중복이면 거부하고, 텍스트 검색으로 위치를 고르지 않는다.
- `expected_block_hash` = sha256(정렬된 canonical JSON(block node)), `selected_slice_hash`도 같은 방식.
  블록이 바뀌었으면 **STALE**(자동 rebase 없음).
- conservative 모드(AI 제안의 기본값) 보호 규칙:
  - 선택 안의 인용 집합 변경 → `CITATION_CHANGED`
  - 숫자 multiset 변경 → `NUMBERS_CHANGED`
  - 수식·그림 참조 atom 포함 → `PROTECTED_ATOM`
- `manual` 모드(사용자 직접 입력)는 위치/버전 계약만 적용한다.

## 요구사항-시험 매핑
| AC | Test | 결과 |
|---|---|---|
| REQ-003-A 선택 전후·citation atom 보존, export preview·손실 보고서 | TST-003A ×4 (선택 밖 불변·원본 불변, 인용 포함 선택, 숫자 보호, DOCX+HTML+loss report) | pass |
| REQ-003-B 모호한 위치는 자동 치환하지 않고 불가 사례 기록 | TST-003B ×7 (동일 문장 두 곳, 중복 id, emoji/결합문자/자모 분할, 범위 오류, STALE, slice hash 위조, 수식 atom) | pass |

- RED: `ERR_MODULE_NOT_FOUND` (`red.log`)
- 첫 GREEN 시도에서 5개 실패:
  - 구현 버그 1개: ProseMirror는 text leaf도 `isAtom`이라 인용 외 atom 판정이 틀렸음 → 수정.
  - 테스트 버그 1개: 수식 테스트가 문장의 첫 `' and '`를 집음 → atom 위치 기준으로 수정.
- 최종: 11/11 pass (`green.log`). combining 검사는 "Café가 하나라도 있으면 통과"에서 "결합문자를 가진 모든 grapheme이 출력에 존재"로 강화함.

## Export 결과 (pandoc 3.1.3, API 1.23.1, 이 컨테이너)
`export-sample/manuscript.docx`를 pandoc으로 다시 읽어 확인:

| 기능 | 결과 |
|---|---|
| 한국어, emoji, 그리스문자, 결합문자, italic, 아래/위첨자, 표 | preserved |
| inline math | preserved (Word 수식 OMML `<m:oMath>`) |
| 인용 표시 | preserved — citeproc 저자-연도 텍스트 `(Kimura 2021)`. locator `p. 4`는 Chicago 스타일 규칙에 따라 `4`로 표기 |
| 참고문헌 | preserved (citeproc 생성) |
| **Word/Zotero 인용 field** | **lost** — Word 안에서 인용을 다시 연결할 수 없음 (공동저자 교환 시 고지 필요) |
| **block id** | **lost** — DOCX 재가져오기 시 블록 매핑 불가 (PW-055 import에서 diff 기반 처리 필요) |
| comment/highlight | 내보내지 않음 (v1 clean DOCX) |
| Track changes | 지원 안 함 (v1 범위 밖) |

`impossible-cases.json`: 7개 모호 위치 모두 REFUSED(코드 기록).

## 계약에 반영할 발견 (P01 RFC 후보)
1. `contracts/edit_proposal.schema.json`의 replacement는 text/citation만 표현한다. **수식·그림참조를 포함한 선택은 현재 계약으로 안전하게 수정할 수 없음** → 이 spike에서는 거부(PROTECTED_ATOM). P01에서 `math_inline`/`figure_ref` "보존 참조" 항목을 추가할지 결정.
2. `selected_slice_hash`가 starter contract에 없다 → editor-core 계약에 추가 제안.
3. 숫자 보호는 문자열 기반 휴리스틱이다(단위·p/q 구분 없음). FactRecord 기반 검사는 PW-043.

## 미실행 / 잔여 위험
- 브라우저 실제 selection(Tiptap, IME 조합 중 입력)과의 일치: **not_run** — PW-015/016/022 Playwright에서 같은 fixture로 검증해야 함.
- 사용자 머신의 pandoc 버전이 다르면 AST 버전이 다를 수 있음 → `pandocInfo()`로 런타임에 확인하고 pin 후보로 3.1.x 이상 기록(PW-006).
- PDF 출력(PW-057), DOCX import(PW-055)는 이 spike 범위 밖.

## 다음 Task
PW-004 실행 세션·권한 격리 spike.
