# PW-021 — 버전 비교·Undo·기본 가져오기 — REPORT
상태: in_review (2026-10-09)

## 변경 파일
- `db/migrations/pw_021_0001_versions_imports.sql`
  - revision 사유에 `undo`를 더한다.
  - 불변 테이블 3개
    - `proposal_undos`: 제안 하나당 한 번의 되돌리기
    - `import_sources`: 받은 원문 그대로, sha256, 크기, parser 버전, 미리 보기, 손실 보고
    - `import_applications`: 가져오기 하나당 한 번의 적용
- `packages/domain/src/imports/text/`(새 폴더)
  - `parse.ts`: 텍스트·Markdown parser(`pw-text-import-1`)
    - 새 block id를 붙이고, editor-core schema로 검증한다.
    - 옮기지 못한 요소는 손실 보고에 종류·개수·줄 번호로 남긴다.
      - 글자를 남기는 것: 링크, 목록, 인용 블록, 코드, 표, 수식, HTML, 각주
      - 빼는 것: 그림, 구분선, 각주 정의, 제어 문자
    - HTML은 해석하지 않고 글자로만 남긴다.
  - `index.ts`
    - `createImport`: 원문을 저장하고 미리 보기를 만든다. 현재 원고는 건드리지 않는다.
    - `getImport`, `listImports`
    - `applyImport`
      - `new_manuscript`: 원고가 없을 때만
      - `replace_manuscript`: `confirm_replace`와 expected head가 필요하고, 새 revision(`import`)을 만든다.
      - 한 번만 적용된다.
- `apps/web/src/features/versions/`(새 폴더)
  - `compare.ts`: block id 기준으로 두 revision을 비교한다.
    - 같음 / 바뀜(단어 diff) / 위치 이동(LCS) / 추가 / 삭제
    - 삭제된 문단은 원래 자리에 표시한다.
    - 표식·atom·제목 수준이 달라도 바뀜으로 친다.
  - `VersionsTab.tsx`: 버전 탭
    - 버전 기록, 임의의 두 버전 비교
    - 복원(확인 후 새 버전)
    - 적용된 AI 수정 목록·diff·되돌리기(MOCK 배지)
    - 가져오기: 파일 또는 붙여넣기 → 미리 보기·손실 보고 → "현재 원고를 이 내용으로 바꿉니다" 확인 → 적용
    - 스냅샷
- 범위 밖(RFC-007 부록)
  - `packages/domain/src/proposals/index.ts`
    - `undoProposal`
      - 문서 head 잠금, expected head
      - APPLIED만, 한 번만
      - 그 문단이 적용 직후 그대로일 때만 적용 전 문단으로 바꾼 새 revision(`undo`)을 만든다. 다른 문단의 이후 편집은 유지한다.
    - `listAppliedEdits`
  - `packages/domain/src/revisions/index.ts`: `lockDocumentHead`, `appendRevisionIn`(검증 포함), `createDocumentIn` export(같은 트랜잭션에서 head 변경)
  - `apps/api/src/imports/**`(새 route 폴더)
  - `apps/api/src/proposals/index.ts`: `GET …/applied-edits`, `POST …/proposals/:id/undo`
  - `apps/api/src/server.ts`
  - `apps/web/src/editor/ManuscriptEditor.tsx`: `onState`(저장된 head, 화면=저장본 여부)
  - `apps/web/src/features/paper/ManuscriptTab.tsx`: `reloadKey`. head가 바뀌면 편집기를 새 head로 다시 연다.
  - `apps/web/src/features/paper/PaperPage.tsx`: 버전 탭과 원고 탭을 연결한다.
- 시험(`tests/tasks/PW-021/`)
  - `import-parse.test.ts` 7
  - `compare.test.ts` 4
  - `versions.int.test.ts` 8
  - `versions.e2e.ts` 3

## 요구사항-시험 매핑
| REQ / TST | 시험 |
|---|---|
| REQ-021-A / TST-021A 적용된 AI 수정의 undo와 과거 버전 비교가 새로고침 뒤에도 동작 | 통합: undo는 새 revision(`undo`)이다. 그 문단만 되돌리고 다른 문단의 이후 편집은 유지한다. 한 번만 된다 |
| | 통합: 문단이 바뀌면 CHANGED_SINCE_APPLY, head가 다르면 409. revision을 만들지 않는다 |
| | 통합: PENDING은 NOT_APPLIED. 다른 owner는 404 |
| | unit: 비교(바뀜·추가·삭제·이동·제목 수준) |
| | 브라우저: mock AI 간결화 적용 → **새로고침** → 버전 탭에서 되돌리기 → 원고가 원래대로. AI 버전과 현재 버전을 비교하면 "very very "가 보인다. 기록은 늘기만 한다 |
| REQ-021-B / TST-021B restore가 audit·과거 revision을 지우지 않고, import가 현재 원고를 예고 없이 덮지 않음 | 통합: restore는 새 head(`restored_from`)다. revision 수는 +1, audit는 줄지 않는다. 옛 revision을 모두 읽을 수 있다 |
| | 통합: revision·undo 기록 삭제는 DB가 거부한다 |
| | 통합: 가져오기 업로드는 원문 그대로(불변) 저장된다. head는 그대로다 |
| | 통합: 확인 없음은 422 CONFIRM_REQUIRED, 다른 head는 409, 원고가 있는데 new_manuscript면 409 |
| | 통합: 적용 뒤 이전 원고를 복원할 수 있다. 두 번째 적용은 ALREADY_APPLIED |
| | 통합: 잘못된 형식·빈 파일·긴 파일명·큰 파일은 거부하고 저장도 하지 않는다 |
| | 브라우저: 미리 보기·손실 보고를 보는 동안 원고는 그대로다. 확인란 없이는 버튼이 비활성이다. 적용 뒤 이전 초안을 복원할 수 있다 |
| | 브라우저: 원고에 저장되지 않은 입력이 있으면 버전 탭이 head를 바꾸지 않는다 |

## RED → GREEN
- RED: 구현 전에 모듈·API가 없어 unit 2파일과 통합 7건이 실패했다(`red.log`).
- 개발 중 브라우저 시험에서 찾은 결함 1건(고침)
  - 되돌린 뒤에도 "이후 버전" 선택이 옛 head에 머물렀다. 그래서 비교 결과가 "같음"이었다.
  - 원인: React state updater가 나중에 실행되는데, 그 사이 이전 head 값이 이미 바뀌어 있었다.
  - 이전 head를 미리 캡처하도록 고쳤다. "이후 버전"은 head를 보고 있었을 때만 새 head를 따라간다.
- mutation(`mutation.log`): 10종 모두 탐지했다. CONTROL 1건은 동등한 변경이라 살아남는 것이 정상이다.
  - 바뀐 문단 위로 되돌리기
  - 전체 base로 되돌리기
  - 두 번 되돌리기
  - 확인 없는 교체
  - 두 번째 원고 생성
  - 두 번 적용
  - 링크 무보고
  - 이동을 같음으로
  - 미저장 상태에서 head 변경
  - 확인란 없는 교체 버튼
- GREEN: unit 11, 통합 8, 브라우저 3.
- 회귀: `pnpm test` exit 0(`pnpm-test.log`).
  - unit 172, integration 194, contracts 15, e2e 68, spikes 70
  - typecheck·lint, evals/pack PASS

## 보안·과학적 실패 경로
- 정본 이력은 지워지지 않는다. 복원·되돌리기·가져오기는 모두 새 head revision을 만들고, 이전 revision과 감사 기록은 불변이다.
- 가져오기는 원문을 먼저 불변 저장한다(spec 10).
  - 미리 보기와 손실 보고가 확정 전에 보인다.
  - 교체에는 명시적 확인과 사용자가 본 head가 필요하다. 다른 곳에서 원고가 바뀌었으면 409다.
- 되돌리기는 사용자 행위다(AI가 부를 수 없는 owner API).
  - 적용 뒤 바뀐 문단은 자동으로 되돌리지 않는다. 나중의 사람 편집을 몰래 덮지 않기 위해서다.
- 가져온 내용은 editor-core schema 검증을 통과해야 저장된다. HTML·링크 주소는 실행·저장되지 않는다.
- 숫자·단위는 parser가 바꾸지 않는다. 표식만 해석하고 본문 글자는 그대로 둔다.

## 미실행 / 남은 위험
- DOCX 가져오기(변경 내용 추적·댓글·수식)는 P05/P07의 가져오기·내보내기 Task에서 한다.
- 표는 아직 편집기에서 열 수 없다. 그래서 Markdown 표는 글자 줄로 남기고 보고한다.
- 문단을 나누거나 합친 뒤에는 같은 block id가 없다. 그런 문단은 비교에서 삭제+추가로 보인다(lineage는 spec 02의 후속).
- 되돌리기는 제안이 바꾼 문단 하나에 대해서만 한다. 여러 문단을 한 번에 되돌리는 기능은 없다(PW-017 제안이 한 문단 범위이므로 충분하다).
- 원고를 교체하는 가져오기를 하면 기존 코멘트 anchor는 ORPHANED가 된다(block id가 새로 붙기 때문). 의도된 동작이다.
- 버전 탭은 원고 탭이 "저장됨"일 때만 head를 바꾼다. 다른 브라우저 탭에서 열린 편집기는 다음 저장 때 409 충돌로 멈춘다(PW-015 동작).

## 다음
PW-022: P02 브라우저 호환·접근성·성능 점검과 P02 gate
