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

## 독립 리뷰 후속 (bf76f80)
| 리뷰 | 조치 |
|---|---|
| M1 수정안이 사용자 선택에 묶이지 않음, 재생 가능 | `HandleStore` + `applyAiProposal`: 범위·블록·hash는 서버에 저장된 handle에서만 가져옴. proposal의 다른 범위는 `HANDLE_RANGE_MISMATCH`. `proposal_id` 재사용은 `ALREADY_APPLIED`, 적용된 handle은 `HANDLE_CONSUMED`. slice hash에 block_id·from·to 포함 |
| M2 guard가 약함, `mode` 우회 | 수치는 run별·순서 비교(비교기호·단위 포함), 부정어·방향어 순서, 서식 run(위첨자 등), 인용 locator, 인용 앞 단어(위치)를 검사. AI 경로는 mode를 무시하고 항상 guard. 사용자 입력은 `applyUserEdit` 별도 경로. 리뷰어 재현 9개를 모두 테스트로 만들었고 각각 기대 코드로 거부됨 |
| M3 손실 보고서가 본문 누락을 못 봄, figure_ref 행 없음 | 블록별 순서 텍스트 비교(`block_text`), 블록별 서식 run 비교, `figure_ref: degraded` 행 추가. 블록 2개를 지운 round-trip, Subscript를 지운 round-trip에서 `lost`가 나오는 테스트 추가 |
| RFC-005 | `preserve_atom`으로 수식·그림참조 atom을 순서대로 보존해 수정 가능 |

남은 한계:
- guard는 영어 중심 휴리스틱이다. 동의어 반전("rose"→"fell"이 목록 밖 단어인 경우), 다국어 표현은 놓칠 수 있다. 의미 검사는 PW-043/044 담당이다.
- base_revision_id / idempotency key의 DB 저장은 PW-017 범위다.

테스트: 14/14 (`green.log`). 증거 재생성: `node spikes/editor-export/run-spike.mjs reports/tasks/PW-003`.

## 2차 리뷰 후속 (5de9421)
- 손실 보고서가 각 블록을 citeproc 렌더링한 원문과 **정확히 같은지** 비교한다. 인용 제거, 다른 문헌으로 교체, locator 변경, 단어 삽입을 탐지하며 테스트로 확인했다.
- guard에 방향 동사(rose/fell 등), 철자 숫자(two-fold), 천 단위 구분(1,000=1000 허용), 길이·질량·시간 단위(µm/mm, kDa, mg/kg, days), 비교 단어(below/above)를 추가했다. "under stress" 같은 오탐을 피하려고 under/over는 제외했다.
- `preserve_atom`의 잘못된 index는 `INVALID_REPLACEMENT`로 거부한다.
- 남은 우회 목록은 RFC-003에 있다. 테스트: 17/17.
